import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { Job, Repository } from "@fluxora/shared-types";
import {
  parseRepositoryIngestJobPayload,
  REPOSITORY_INGEST_JOB_TYPE,
  repositoryIngestIdempotencyKey,
} from "@fluxora/shared-types";

import type { GithubIngestClient } from "../github/client.ts";
import { createDefaultJobHandlers } from "../handlers.ts";
import { createRepositoryIngestHandler } from "./handler.ts";
import { IngestionError } from "./errors.ts";
import {
  ingestRepositoryJob,
  type RepositoryIngestDependencies,
  type RepositoryLookup,
} from "./ingest.ts";
import { gzipTar } from "./tar-fixture.ts";
import { createIngestWorkDir, removeIngestWorkDir } from "./workdir.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const repository: Repository = {
  id: REPO,
  organizationId: ORG,
  githubRepoId: "4242",
  name: "demo",
  defaultBranch: "main",
  connectionStatus: "pending",
  lastIndexedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function ingestJob(payload: Job["payload"], organizationId = ORG): Job {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId,
    type: REPOSITORY_INGEST_JOB_TYPE,
    payload,
    status: "running",
    idempotencyKey: repositoryIngestIdempotencyKey(REPO, SHA),
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: new Date(),
    lockedAt: new Date(),
    lockedBy: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    failedAt: null,
  };
}

function lookupMock(
  options?: {
    repository?: Repository | null;
    installationId?: string | null;
    statuses?: string[];
  },
): RepositoryLookup {
  const statuses = options?.statuses ?? [];
  return {
    async getRepositoryById(organizationId, repositoryId) {
      if (options?.repository === null) {
        return null;
      }
      const row = options?.repository ?? repository;
      if (row.organizationId !== organizationId || row.id !== repositoryId) {
        return null;
      }
      return row;
    },
    async getGithubInstallationId() {
      return options?.installationId === undefined
        ? "9001"
        : options.installationId;
    },
    async updateConnectionStatus(_organizationId, _repositoryId, status) {
      statuses.push(status);
    },
  };
}

function githubMock(
  options?: {
    token?: string;
    commitSha?: string;
    archive?: Buffer;
    failures?: Partial<Record<keyof GithubIngestClient, () => never>>;
    seenAuth?: string[];
  },
): GithubIngestClient {
  const archive =
    options?.archive ??
    gzipTar([
      {
        name: `demo-${SHA}/README.md`,
        body: Buffer.from("# demo", "utf8"),
      },
    ]);

  return {
    async mintInstallationToken() {
      options?.failures?.mintInstallationToken?.();
      const token = options?.token ?? "ghs_testtoken";
      options?.seenAuth?.push(token);
      return token;
    },
    async getRepository(token) {
      options?.failures?.getRepository?.();
      options?.seenAuth?.push(token);
      return { fullName: "octocat/demo", defaultBranch: "main" };
    },
    async resolveCommit(token) {
      options?.failures?.resolveCommit?.();
      options?.seenAuth?.push(token);
      return {
        sha: options?.commitSha ?? SHA,
        author: "Ada",
        message: "init",
        committedAt: new Date("2026-01-01T00:00:00.000Z"),
        parentShas: [],
      };
    },
    async downloadTarball(token) {
      options?.failures?.downloadTarball?.();
      options?.seenAuth?.push(token);
      return Readable.from(archive);
    },
  };
}

function deps(input?: {
  lookup?: RepositoryLookup;
  github?: GithubIngestClient;
  maxTotalBytes?: number;
}): RepositoryIngestDependencies {
  return {
    lookup: input?.lookup ?? lookupMock(),
    github: input?.github ?? githubMock(),
    limits: {
      maxFileCount: 50,
      maxTotalBytes: input?.maxTotalBytes ?? 10_000,
      maxArchiveBytes: 20_000,
      timeoutMs: 5_000,
    },
  };
}

test("parseRepositoryIngestJobPayload requires repositoryId and ref and accepts optional commitSha", () => {
  assert.deepEqual(
    parseRepositoryIngestJobPayload({ repositoryId: REPO, ref: "main" }),
    { repositoryId: REPO, ref: "main" },
  );
  assert.deepEqual(
    parseRepositoryIngestJobPayload({
      repositoryId: REPO,
      ref: "main",
      commitSha: SHA,
    }),
    { repositoryId: REPO, ref: "main", commitSha: SHA },
  );
  assert.equal(
    parseRepositoryIngestJobPayload({ repositoryId: "not-a-uuid", ref: "main" }),
    null,
  );
});

test("successful ingestion mints an installation token, resolves the ref, and marks the repository active", async () => {
  const seenAuth: string[] = [];
  const statuses: string[] = [];
  const result = await ingestRepositoryJob(
    ingestJob({ repositoryId: REPO, ref: "main" }),
    deps({
      lookup: lookupMock({ statuses }),
      github: githubMock({ seenAuth, token: "ghs_live" }),
    }),
  );

  try {
    assert.equal(result.commitSha, SHA);
    assert.equal(result.fileCount, 1);
    assert.equal(await readFile(path.join(result.workDir, "README.md"), "utf8"), "# demo");
    assert.deepEqual(statuses, ["active"]);
    assert.ok(seenAuth.includes("ghs_live"));
    assert.equal(
      repositoryIngestIdempotencyKey(REPO, SHA),
      `${REPOSITORY_INGEST_JOB_TYPE}:${REPO}:${SHA}`,
    );
  } finally {
    await rm(result.workDir, { recursive: true, force: true });
  }
});

test("payload commitSha must match the GitHub-resolved ref", async () => {
  await assert.rejects(
    () =>
      ingestRepositoryJob(
        ingestJob({
          repositoryId: REPO,
          ref: "main",
          commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
        deps(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "invalid_ref");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("tenant mismatch is a permanent failure and does not fetch GitHub", async () => {
  let minted = false;
  await assert.rejects(
    () =>
      ingestRepositoryJob(
        ingestJob({ repositoryId: REPO, ref: "main" }, OTHER_ORG),
        deps({
          lookup: lookupMock({ repository }),
          github: githubMock({
            failures: {
              mintInstallationToken: () => {
                minted = true;
                throw new Error("should not mint");
              },
            },
          }),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "tenant_mismatch");
      assert.equal(minted, false);
      return true;
    },
  );
});

test("GitHub 401/403 style auth failures mark needs_reauth and are not retryable", async () => {
  const statuses: string[] = [];
  await assert.rejects(
    () =>
      ingestRepositoryJob(
        ingestJob({ repositoryId: REPO, ref: "main" }),
        deps({
          lookup: lookupMock({ statuses, installationId: null }),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "github_auth");
      assert.equal(error.retryable, false);
      assert.equal(error.repositoryStatus, "needs_reauth");
      return true;
    },
  );
  assert.deepEqual(statuses, ["needs_reauth"]);
});

test("rate-limit errors stay retryable and do not change repository status", async () => {
  const statuses: string[] = [];
  const rateLimit = new IngestionError({
    code: "github_rate_limit",
    message: "GitHub rate limit or transient availability error",
    retryable: true,
  });

  await assert.rejects(
    () =>
      ingestRepositoryJob(
        ingestJob({ repositoryId: REPO, ref: "main" }),
        deps({
          lookup: lookupMock({ statuses }),
          github: githubMock({
            failures: {
              mintInstallationToken: () => {
                throw rateLimit;
              },
            },
          }),
        }),
      ),
    (error: unknown) => {
      assert.equal(error, rateLimit);
      return true;
    },
  );
  assert.deepEqual(statuses, []);
});

test("invalid GitHub ref is a permanent repository error", async () => {
  await assert.rejects(
    () =>
      ingestRepositoryJob(
        ingestJob({ repositoryId: REPO, ref: "does-not-exist" }),
        deps({
          github: githubMock({
            failures: {
              resolveCommit: () => {
                throw new IngestionError({
                  code: "invalid_ref",
                  message: "GitHub ref was not found",
                  retryable: false,
                  repositoryStatus: "error",
                });
              },
            },
          }),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "invalid_ref");
      return true;
    },
  );
});

test("temporary working directories are removed after handler success and failure", async () => {
  const successDirs: string[] = [];
  const successHandler = createRepositoryIngestHandler({
    ...deps(),
    createWorkDir: async () => {
      const dir = await createIngestWorkDir();
      successDirs.push(dir);
      return dir;
    },
  });
  await successHandler(ingestJob({ repositoryId: REPO, ref: "main" }));
  assert.equal(successDirs.length, 1);
  assert.equal(existsSync(successDirs[0] ?? ""), false);

  const created: string[] = [];
  const failHandler = createRepositoryIngestHandler({
    ...deps({
      github: githubMock({
        failures: {
          downloadTarball: () => {
            throw new IngestionError({
              code: "invalid_ref",
              message: "missing",
              retryable: false,
              repositoryStatus: "error",
            });
          },
        },
      }),
    }),
    createWorkDir: async () => {
      const dir = await createIngestWorkDir();
      created.push(dir);
      return dir;
    },
  });

  await assert.rejects(() =>
    failHandler(ingestJob({ repositoryId: REPO, ref: "main" })),
  );
  assert.equal(created.length, 1);
  assert.equal(existsSync(created[0] ?? ""), false);

  const dir = await createIngestWorkDir();
  assert.equal(existsSync(dir), true);
  await removeIngestWorkDir(dir);
  assert.equal(existsSync(dir), false);
});

test("handler registry includes repository.ingest", () => {
  const handlers = createDefaultJobHandlers({
    ingestHandler: async () => undefined,
  });
  assert.equal(typeof handlers[REPOSITORY_INGEST_JOB_TYPE], "function");
  assert.equal(typeof handlers["test.echo"], "function");
});

test("re-running successful ingestion only updates status and does not require new durable rows", async () => {
  const statuses: string[] = [];
  const shared = deps({ lookup: lookupMock({ statuses }) });
  const first = await ingestRepositoryJob(
    ingestJob({ repositoryId: REPO, ref: "main", commitSha: SHA }),
    shared,
  );
  await rm(first.workDir, { recursive: true, force: true });
  const second = await ingestRepositoryJob(
    ingestJob({ repositoryId: REPO, ref: "main", commitSha: SHA }),
    shared,
  );
  await rm(second.workDir, { recursive: true, force: true });
  assert.deepEqual(statuses, ["active", "active"]);
});
