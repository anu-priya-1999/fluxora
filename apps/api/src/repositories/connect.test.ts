import assert from "node:assert/strict";
import test from "node:test";

import type {
  EnqueueJobInput,
  GithubInstallation,
  Job,
  Repository,
} from "@fluxora/shared-types";
import { RepositoryConflictError } from "@fluxora/db";

import {
  connectRepository,
  GithubInstallationMismatchError,
  GithubInstallationNotConnectedError,
  type ConnectRepositoryStore,
} from "./connect.ts";
import type { GithubRepositoryClient } from "../github/repository-client.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";
const INSTALLATION = "123456";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const installation: GithubInstallation = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: ORG,
  githubInstallationId: INSTALLATION,
  githubAccountId: "999",
  githubAccountLogin: "octocat",
  githubAccountType: "User",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const baseRepository: Repository = {
  id: REPO,
  organizationId: ORG,
  githubRepoId: "42",
  name: "demo",
  defaultBranch: "main",
  connectionStatus: "pending",
  lastIndexedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const baseJob: Job = {
  id: "44444444-4444-4444-8444-444444444444",
  organizationId: ORG,
  type: "repository.ingest",
  payload: {},
  status: "pending",
  idempotencyKey: "",
  attemptCount: 0,
  maxAttempts: 3,
  availableAt: new Date("2026-01-01T00:00:00.000Z"),
  lockedAt: null,
  lockedBy: null,
  leaseExpiresAt: null,
  lastError: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  failedAt: null,
};

function githubMock(): GithubRepositoryClient {
  return {
    async getRepositoryAndCommit() {
      return {
        repository: {
          githubRepoId: "42",
          fullName: "octocat/demo",
          defaultBranch: "main",
        },
        commit: { sha: SHA },
      };
    },
  };
}

function storeMock(overrides?: Partial<ConnectRepositoryStore>): ConnectRepositoryStore & {
  enqueued: EnqueueJobInput[];
  updated: Array<{ repositoryId: string; patch: Record<string, unknown> }>;
} {
  const state = {
    repository: null as Repository | null,
    enqueued: [] as EnqueueJobInput[],
    updated: [] as Array<{ repositoryId: string; patch: Record<string, unknown> }>,
  };

  const store: ConnectRepositoryStore = {
    async getInstallation() {
      return installation;
    },
    async getRepositoryByGithubRepoId() {
      return state.repository;
    },
    async createRepository(input) {
      state.repository = {
        ...baseRepository,
        githubRepoId: input.githubRepoId,
        name: input.name,
        defaultBranch: input.defaultBranch,
        connectionStatus: "pending",
      };
      return state.repository;
    },
    async updateRepository(_organizationId, repositoryId, patch) {
      state.updated.push({ repositoryId, patch });
      state.repository = {
        ...(state.repository ?? baseRepository),
        ...patch,
        id: repositoryId,
      };
      return state.repository;
    },
    async enqueueJob(input) {
      state.enqueued.push(input);
      return {
        ...baseJob,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload ?? {},
      };
    },
    ...overrides,
  };

  return Object.assign(store, state);
}

const config = {
  appId: "123456",
  privateKeyPem: "unused in injected GitHub client",
  apiBaseUrl: "https://api.github.com",
};

test("rejects a missing GitHub installation before calling GitHub", async () => {
  const store = storeMock({
    getInstallation: async () => null,
  });

  await assert.rejects(
    () =>
      connectRepository({
        organizationId: ORG,
        githubInstallationId: INSTALLATION,
        repoFullName: "octocat/demo",
        ref: "main",
        config,
        github: githubMock(),
        store,
      }),
    GithubInstallationNotConnectedError,
  );
});

test("rejects an installation id that is not the tenant's stored installation", async () => {
  const store = storeMock();

  await assert.rejects(
    () =>
      connectRepository({
        organizationId: ORG,
        githubInstallationId: "777",
        repoFullName: "octocat/demo",
        ref: "main",
        config,
        github: githubMock(),
        store,
      }),
    GithubInstallationMismatchError,
  );
});

test("finds or creates the repository and enqueues repository.ingest with commit idempotency", async () => {
  const store = storeMock();

  const result = await connectRepository({
    organizationId: ORG,
    githubInstallationId: INSTALLATION,
    repoFullName: "octocat/demo",
    ref: "main",
    config,
    github: githubMock(),
    store,
  });

  assert.equal(result.repository.id, REPO);
  assert.equal(result.repository.connectionStatus, "pending");
  assert.equal(result.commitSha, SHA);
  assert.equal(store.enqueued.length, 1);
  assert.deepEqual(store.enqueued[0]?.payload, {
    repositoryId: REPO,
    ref: "main",
    commitSha: SHA,
  });
  assert.equal(
    store.enqueued[0]?.idempotencyKey,
    `repository.ingest:${REPO}:${SHA}`,
  );
});

test("reconnects an existing active repository by resetting it to pending before enqueue", async () => {
  const store = storeMock({
    async getRepositoryByGithubRepoId() {
      return {
        ...baseRepository,
        connectionStatus: "active",
      };
    },
  });

  const result = await connectRepository({
    organizationId: ORG,
    githubInstallationId: INSTALLATION,
    repoFullName: "octocat/demo",
    ref: "main",
    config,
    github: githubMock(),
    store,
  });

  assert.equal(result.repository.connectionStatus, "pending");
  assert.equal(store.updated.length, 1);
  assert.equal(store.updated[0]?.patch.connectionStatus, "pending");
});

test("handles a repository-create race by re-reading the tenant repository", async () => {
  let createCalls = 0;
  const racedRepository = { ...baseRepository, connectionStatus: "pending" as const };
  const store = storeMock({
    async getRepositoryByGithubRepoId() {
      return createCalls === 0 ? null : racedRepository;
    },
    async createRepository() {
      createCalls += 1;
      throw new RepositoryConflictError();
    },
  });

  const result = await connectRepository({
    organizationId: ORG,
    githubInstallationId: INSTALLATION,
    repoFullName: "octocat/demo",
    ref: "main",
    config,
    github: githubMock(),
    store,
  });

  assert.equal(result.repository.id, REPO);
  assert.equal(createCalls, 1);
});
