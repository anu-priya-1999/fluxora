import assert from "node:assert/strict";
import test from "node:test";

import { closePool, getPool } from "../pool.ts";
import { loadRootEnvFile } from "../cli/env.ts";
import { createOrganization } from "./organization.ts";
import {
  RepositoryConflictError,
  createRepository,
  getRepositoryById,
  listRepositories,
  updateRepository,
} from "./repository.ts";
import {
  RepositorySnapshotImmutableError,
  createRepositorySnapshot,
  getRepositorySnapshotById,
  listRepositorySnapshots,
  tryOverwriteRepositorySnapshot,
} from "./repository-snapshot.ts";
import { createCommit, getCommitById, listCommits } from "./commit.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";

const hasDatabase = typeof process.env.DATABASE_URL === "string"
  && process.env.DATABASE_URL.length > 0;

async function ensureRlsTestRole(pool: ReturnType<typeof getPool>): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE fluxora_rls_test
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOINHERIT
        NOLOGIN
        NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await pool.query(`GRANT fluxora_rls_test TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO fluxora_rls_test`);
  await pool.query(
    `GRANT USAGE ON TYPE repository_connection_status TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT SELECT ON TABLE organizations TO fluxora_rls_test`,
  );
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";

test("repository snapshot commit data model", { skip: !hasDatabase }, async (t) => {
  const pool = getPool();
  await ensureRlsTestRole(pool);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const orgA = await createOrganization(pool, {
    name: `fluxora-step11-a-${suffix}`,
  });
  const orgB = await createOrganization(pool, {
    name: `fluxora-step11-b-${suffix}`,
  });

  t.after(async () => {
    delete process.env.FLUXORA_DATABASE_ROLE;
    await pool.query(
      `DELETE FROM organizations WHERE name LIKE $1`,
      [`fluxora-step11-%-${suffix}`],
    );
    await closePool();
  });

  await t.test("creates reads and updates a repository including connection_status", async () => {
    const created = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: "1001",
      name: "fluxora",
      defaultBranch: "main",
    });

    assert.equal(created.organizationId, orgA.id);
    assert.equal(created.githubRepoId, "1001");
    assert.equal(created.connectionStatus, "pending");
    assert.equal(created.lastIndexedAt, null);

    const read = await getRepositoryById(pool, orgA.id, created.id);
    assert.deepEqual(read, created);

    const active = await updateRepository(pool, orgA.id, created.id, {
      connectionStatus: "active",
      lastIndexedAt: new Date("2026-10-03T12:00:00.000Z"),
    });

    assert.ok(active);
    assert.equal(active.connectionStatus, "active");
    assert.ok(active.lastIndexedAt instanceof Date);

    const reauth = await updateRepository(pool, orgA.id, created.id, {
      connectionStatus: "needs_reauth",
    });
    assert.equal(reauth?.connectionStatus, "needs_reauth");

    const errored = await updateRepository(pool, orgA.id, created.id, {
      connectionStatus: "error",
    });
    assert.equal(errored?.connectionStatus, "error");

    await assert.rejects(
      () =>
        createRepository(pool, {
          organizationId: orgA.id,
          githubRepoId: "1001",
          name: "fluxora-again",
          defaultBranch: "main",
        }),
      RepositoryConflictError,
    );
  });

  await t.test("creates snapshots as immutable and linked to the repository", async () => {
    const [repository] = await listRepositories(pool, orgA.id);
    assert.ok(repository);

    const snapshot = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repository.id,
      commitSha: SHA_A,
      ref: "refs/heads/main",
      storageUri: `s3://fluxora-snapshots/${orgA.id}/${repository.id}/${SHA_A}`,
      fileCount: 12,
      sizeBytes: "4096",
    });

    const replay = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repository.id,
      commitSha: SHA_A,
      ref: "refs/heads/main",
      storageUri: `s3://fluxora-snapshots/${orgA.id}/${repository.id}/${SHA_A}`,
      fileCount: 12,
      sizeBytes: "4096",
    });

    assert.equal(replay.id, snapshot.id);

    await assert.rejects(
      () =>
        createRepositorySnapshot(pool, {
          organizationId: orgA.id,
          repositoryId: repository.id,
          commitSha: SHA_A,
          ref: "refs/heads/main",
          storageUri: `s3://fluxora-snapshots/${orgA.id}/${repository.id}/${SHA_A}`,
          fileCount: 99,
          sizeBytes: "4096",
        }),
      RepositorySnapshotImmutableError,
    );

    const overwritten = await tryOverwriteRepositorySnapshot(
      pool,
      orgA.id,
      snapshot.id,
      0,
    );
    assert.equal(overwritten, 0);

    const unchanged = await getRepositorySnapshotById(pool, orgA.id, snapshot.id);
    assert.equal(unchanged?.fileCount, 12);

    const listed = await listRepositorySnapshots(pool, orgA.id, repository.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, snapshot.id);
  });

  await t.test("creates and reads commits linked to the repository", async () => {
    const [repository] = await listRepositories(pool, orgA.id);
    assert.ok(repository);

    const root = await createCommit(pool, {
      organizationId: orgA.id,
      repositoryId: repository.id,
      sha: SHA_B,
      author: "Ada <ada@example.com>",
      message: "initial import",
      committedAt: new Date("2026-10-01T00:00:00.000Z"),
      parentShas: [],
    });

    const child = await createCommit(pool, {
      organizationId: orgA.id,
      repositoryId: repository.id,
      sha: SHA_C,
      author: "Ada <ada@example.com>",
      message: "add api",
      committedAt: new Date("2026-10-02T00:00:00.000Z"),
      parentShas: [SHA_B],
    });

    const replay = await createCommit(pool, {
      organizationId: orgA.id,
      repositoryId: repository.id,
      sha: SHA_B,
      author: "Ada <ada@example.com>",
      message: "initial import",
      committedAt: new Date("2026-10-01T00:00:00.000Z"),
      parentShas: [],
    });

    assert.equal(replay.id, root.id);

    const read = await getCommitById(pool, orgA.id, child.id);
    assert.deepEqual(read?.parentShas, [SHA_B]);

    const listed = await listCommits(pool, orgA.id, repository.id);
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, child.id);
    assert.equal(listed[1]?.id, root.id);
  });

  await t.test("denies cross-tenant repository snapshot and commit access", async () => {
    const [repository] = await listRepositories(pool, orgA.id);
    assert.ok(repository);
    const [snapshot] = await listRepositorySnapshots(pool, orgA.id, repository.id);
    const [commit] = await listCommits(pool, orgA.id, repository.id);
    assert.ok(snapshot);
    assert.ok(commit);

    assert.equal(await getRepositoryById(pool, orgB.id, repository.id), null);
    assert.equal(await getRepositorySnapshotById(pool, orgB.id, snapshot.id), null);
    assert.equal(await getCommitById(pool, orgB.id, commit.id), null);
    assert.deepEqual(await listRepositories(pool, orgB.id), []);
    assert.deepEqual(await listRepositorySnapshots(pool, orgB.id, repository.id), []);
    assert.deepEqual(await listCommits(pool, orgB.id, repository.id), []);

    await assert.rejects(() =>
      createRepositorySnapshot(pool, {
        organizationId: orgB.id,
        repositoryId: repository.id,
        commitSha: "dddddddddddddddddddddddddddddddddddddddd",
        ref: "refs/heads/main",
        storageUri: "s3://fluxora-snapshots/other",
        fileCount: 1,
        sizeBytes: "1",
      }),
    );

    await assert.rejects(() =>
      createCommit(pool, {
        organizationId: orgB.id,
        repositoryId: repository.id,
        sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        author: "Eve <eve@example.com>",
        message: "intrusion",
        committedAt: new Date("2026-10-03T00:00:00.000Z"),
      }),
    );

    const otherRepo = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: "1001",
      name: "also-fluxora",
      defaultBranch: "main",
    });
    assert.equal(otherRepo.githubRepoId, "1001");
    assert.notEqual(otherRepo.id, repository.id);
  });
});
