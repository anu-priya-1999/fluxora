import assert from "node:assert/strict";
import test from "node:test";

import { CommitValidationError, createCommit } from "./commit.ts";
import {
  RepositoryValidationError,
  createRepository,
} from "./repository.ts";
import {
  RepositorySnapshotValidationError,
  createRepositorySnapshot,
} from "./repository-snapshot.ts";
import type pg from "pg";

const unusedPool = {} as pg.Pool;

test("repository create rejects an invalid GitHub repo id", async () => {
  await assert.rejects(
    () =>
      createRepository(unusedPool, {
        organizationId: "00000000-0000-0000-0000-000000000001",
        githubRepoId: "0123",
        name: "fluxora",
        defaultBranch: "main",
      }),
    RepositoryValidationError,
  );
});

test("snapshot create rejects a non-sha commit", async () => {
  await assert.rejects(
    () =>
      createRepositorySnapshot(unusedPool, {
        organizationId: "00000000-0000-0000-0000-000000000001",
        repositoryId: "00000000-0000-0000-0000-000000000002",
        commitSha: "not-a-sha",
        ref: "main",
        storageUri: "s3://bucket/key",
        fileCount: 1,
        sizeBytes: "1",
      }),
    RepositorySnapshotValidationError,
  );
});

test("commit create rejects a parent that is not a full sha", async () => {
  await assert.rejects(
    () =>
      createCommit(unusedPool, {
        organizationId: "00000000-0000-0000-0000-000000000001",
        repositoryId: "00000000-0000-0000-0000-000000000002",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        author: "Ada",
        message: "x",
        committedAt: new Date(),
        parentShas: ["abc"],
      }),
    CommitValidationError,
  );
});
