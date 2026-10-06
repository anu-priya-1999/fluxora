import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  Job,
  Repository,
  RepositorySnapshot,
} from "@fluxora/shared-types";
import {
  parseRepositoryIngestJobPayload,
  REPOSITORY_INDEXED_EVENT_TYPE,
  REPOSITORY_INGEST_JOB_TYPE,
  repositoryIndexedIdempotencyKey,
  repositoryIngestIdempotencyKey,
} from "@fluxora/shared-types";
import type { ObjectStorageClient } from "@fluxora/infrastructure";
import { snapshotObjectKey } from "@fluxora/infrastructure";
import type { CreateRepositorySnapshotInput } from "@fluxora/db";
import { RepositorySnapshotImmutableError } from "@fluxora/db";

import type { GithubIngestClient } from "../github/client.ts";
import { createDefaultJobHandlers } from "../handlers.ts";
import { createRepositoryIngestHandler } from "./handler.ts";
import { IngestionError } from "./errors.ts";
import {
  ingestRepositoryJob,
  type EventPublisher,
  type RepositoryIngestDependencies,
  type RepositoryLookup,
} from "./ingest.ts";
import { SNAPSHOT_OBJECT_NAME } from "./persist-snapshot.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { gzipTar } from "./tar-fixture.ts";
import { createIngestWorkDir, removeIngestWorkDir } from "./workdir.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SNAPSHOT_ID = "55555555-5555-4555-8555-555555555555";

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

function lookupMock(options?: {
  repository?: Repository | null;
  installationId?: string | null;
  statuses?: string[];
}): RepositoryLookup {
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

class MemoryObjectStorage implements ObjectStorageClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  failPut = false;

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
    if (this.failPut) {
      throw new Error("upload failed");
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (value === undefined) {
      throw new Error(`missing object ${key}`);
    }
    return value;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.objects.delete(key);
    if (existed) {
      this.deleted.push(key);
    }
    return existed;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function snapshotStoreMock(
  seed?: RepositorySnapshot[],
): SnapshotStore & { rows: RepositorySnapshot[] } {
  const rows = [...(seed ?? [])];
  return {
    rows,
    async create(
      input: CreateRepositorySnapshotInput,
    ): Promise<RepositorySnapshot> {
      const existing = rows.find(
        (row) =>
          row.repositoryId === input.repositoryId &&
          row.commitSha === input.commitSha,
      );
      if (existing !== undefined) {
        if (
          existing.ref !== input.ref.trim() ||
          existing.sha256 !== input.sha256 ||
          existing.fileCount !== input.fileCount ||
          existing.sizeBytes !== input.sizeBytes
        ) {
          throw new RepositorySnapshotImmutableError();
        }
        return existing;
      }

      const created: RepositorySnapshot = {
        id: input.id ?? "99999999-9999-4999-8999-999999999999",
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        ref: input.ref.trim(),
        storageUri: input.storageUri.trim(),
        sha256: input.sha256,
        fileCount: input.fileCount,
        sizeBytes: input.sizeBytes,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      rows.push(created);
      return created;
    },
  };
}

function githubMock(options?: {
  token?: string;
  commitSha?: string;
  archive?: Buffer;
  failures?: Partial<Record<keyof GithubIngestClient, () => never>>;
  seenAuth?: string[];
}): GithubIngestClient {
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
  maxArchiveBytes?: number;
  storage?: MemoryObjectStorage;
  snapshots?: SnapshotStore;
  events?: EventPublisher;
  createSnapshotId?: () => string;
}): RepositoryIngestDependencies {
  const storage = input?.storage ?? new MemoryObjectStorage();
  return {
    lookup: input?.lookup ?? lookupMock(),
    github: input?.github ?? githubMock(),
    limits: {
      maxFileCount: 50,
      maxTotalBytes: input?.maxTotalBytes ?? 10_000,
      maxArchiveBytes: input?.maxArchiveBytes ?? 20_000,
      timeoutMs: 5_000,
    },
    storage,
    objectStorageUri: (key) => `filesystem://${key}`,
    snapshots: input?.snapshots ?? snapshotStoreMock(),
    ...(input?.events !== undefined ? { events: input.events } : {}),
    createSnapshotId: input?.createSnapshotId ?? (() => SNAPSHOT_ID),
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
    parseRepositoryIngestJobPayload({
      repositoryId: "not-a-uuid",
      ref: "main",
    }),
    null,
  );
});

test("successful ingestion mints an installation token, persists an immutable snapshot, and marks the repository active", async () => {
  const seenAuth: string[] = [];
  const statuses: string[] = [];
  const storage = new MemoryObjectStorage();
  const snapshots = snapshotStoreMock();
  const result = await ingestRepositoryJob(
    ingestJob({ repositoryId: REPO, ref: "main" }),
    deps({
      lookup: lookupMock({ statuses }),
      github: githubMock({ seenAuth, token: "ghs_live" }),
      storage,
      snapshots,
    }),
  );

  try {
    assert.equal(result.commitSha, SHA);
    assert.equal(result.fileCount, 1);
    assert.equal(result.snapshotId, SNAPSHOT_ID);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      result.storageUri,
      `filesystem://${snapshotObjectKey(ORG, REPO, SNAPSHOT_ID, SNAPSHOT_OBJECT_NAME)}`,
    );
    assert.equal(
      await readFile(path.join(result.workDir, "README.md"), "utf8"),
      "# demo",
    );
    assert.deepEqual(statuses, ["active"]);
    assert.ok(seenAuth.includes("ghs_live"));
    assert.equal(snapshots.rows.length, 1);
    assert.equal(snapshots.rows[0]?.sha256, result.sha256);
    assert.equal(snapshots.rows[0]?.storageUri, result.storageUri);
    assert.equal(snapshots.rows[0]?.fileCount, 1);
    assert.equal(snapshots.rows[0]?.sizeBytes, String(result.sizeBytes));
    assert.equal(storage.objects.size, 1);
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

test("re-running successful ingestion is idempotent and does not replace the snapshot object", async () => {
  const statuses: string[] = [];
  const storage = new MemoryObjectStorage();
  const snapshots = snapshotStoreMock();
  const shared = deps({
    lookup: lookupMock({ statuses }),
    storage,
    snapshots,
    createSnapshotId: () => crypto.randomUUID(),
  });
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
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.sha256, second.sha256);
  assert.equal(snapshots.rows.length, 1);
  assert.equal(storage.objects.size, 1);
});

test("successful ingestion emits repository.indexed event after snapshot persistence and repository activation", async () => {
  const statuses: string[] = [];
  const publishedEvents: Array<{
    organizationId: string;
    type: string;
    idempotencyKey: string;
    payload: unknown;
  }> = [];

  const mockEvents: EventPublisher = {
    async publish(input) {
      publishedEvents.push(input);
      return {
        id: "77777777-7777-4777-8777-777777777777",
        organizationId: input.organizationId,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        schemaVersion: 1,
        occurredAt: new Date(),
        createdAt: new Date(),
      };
    },
  };

  const shared = deps({
    lookup: lookupMock({ statuses }),
    events: mockEvents,
  });

  const result = await ingestRepositoryJob(
    ingestJob({ repositoryId: REPO, ref: "main", commitSha: SHA }),
    shared,
  );

  await rm(result.workDir, { recursive: true, force: true });

  assert.deepEqual(statuses, ["active"]);
  assert.equal(publishedEvents.length, 1);
  const emitted = publishedEvents[0];
  assert.ok(emitted !== undefined);
  assert.equal(emitted.organizationId, ORG);
  assert.equal(emitted.type, REPOSITORY_INDEXED_EVENT_TYPE);
  assert.equal(emitted.type, REPOSITORY_INDEXED_EVENT_TYPE);
  assert.equal(
    emitted.idempotencyKey,
    repositoryIndexedIdempotencyKey(REPO, SHA),
  );
  assert.deepEqual(emitted.payload, {
    repositoryId: REPO,
    repository_id: REPO,
    snapshotId: SNAPSHOT_ID,
    snapshot_id: SNAPSHOT_ID,
    commitSha: SHA,
    commit_sha: SHA,
    ref: "main",
  });
  assert.ok(result.event !== undefined);
  assert.equal(result.event.id, "77777777-7777-4777-8777-777777777777");
});
