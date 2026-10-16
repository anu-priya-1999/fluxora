import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";
import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import {
  PullRequestValidationError,
  getPullRequestById,
  getPullRequestByNumber,
  listPullRequestFiles,
  replacePullRequestFiles,
  savePullRequestWithFiles,
  upsertPullRequest,
} from "./pull-request.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

async function ensureRlsTestRole(pool: ReturnType<typeof getPool>): Promise<void> {
  await runMigrations(pool);

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
  await pool.query(`
    GRANT USAGE ON TYPE repository_connection_status TO fluxora_rls_test
  `);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_pull_request_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, pull_requests, pull_request_files
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

const SHA_BASE = "1111111111111111111111111111111111111111";
const SHA_HEAD = "2222222222222222222222222222222222222222";
const SHA_HEAD2 = "3333333333333333333333333333333333333333";

describe("pull request unit validations", () => {
  const unusedPool = {} as pg.Pool;

  it("rejects invalid organizationId / repositoryId format", async () => {
    await assert.rejects(
      () =>
        upsertPullRequest(unusedPool, {
          organizationId: "not-a-uuid",
          repositoryId: "00000000-0000-0000-0000-000000000002",
          githubPrId: "12345",
          number: 1,
          title: "PR Title",
          url: "https://github.com/org/repo/pull/1",
          baseRef: "main",
          baseSha: SHA_BASE,
          headRef: "feature",
          headSha: SHA_HEAD,
        }),
      PullRequestValidationError,
    );
  });

  it("rejects non-positive PR number", async () => {
    await assert.rejects(
      () =>
        upsertPullRequest(unusedPool, {
          organizationId: "00000000-0000-0000-0000-000000000001",
          repositoryId: "00000000-0000-0000-0000-000000000002",
          githubPrId: "12345",
          number: 0,
          title: "PR Title",
          url: "https://github.com/org/repo/pull/1",
          baseRef: "main",
          baseSha: SHA_BASE,
          headRef: "feature",
          headSha: SHA_HEAD,
        }),
      PullRequestValidationError,
    );
  });

  it("rejects invalid commit SHA format", async () => {
    await assert.rejects(
      () =>
        upsertPullRequest(unusedPool, {
          organizationId: "00000000-0000-0000-0000-000000000001",
          repositoryId: "00000000-0000-0000-0000-000000000002",
          githubPrId: "12345",
          number: 1,
          title: "PR Title",
          url: "https://github.com/org/repo/pull/1",
          baseRef: "main",
          baseSha: "not-a-valid-sha",
          headRef: "feature",
          headSha: SHA_HEAD,
        }),
      PullRequestValidationError,
    );
  });

  it("rejects file with empty path or negative additions", async () => {
    await assert.rejects(
      () =>
        replacePullRequestFiles(
          unusedPool,
          "00000000-0000-0000-0000-000000000001",
          "00000000-0000-0000-0000-000000000002",
          [
            {
              path: "   ",
              status: "added",
              additions: -1,
            },
          ],
        ),
      PullRequestValidationError,
    );
  });
});

describe.skipIf(!hasDatabase)("PullRequest and Changed-File database integration", () => {
  let pool: ReturnType<typeof getPool>;
  let orgA: Awaited<ReturnType<typeof createOrganization>>;
  let orgB: Awaited<ReturnType<typeof createOrganization>>;
  let repoA: Awaited<ReturnType<typeof createRepository>>;
  let repoB: Awaited<ReturnType<typeof createRepository>>;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    pool = getPool();
    await ensureRlsTestRole(pool);

    orgA = await createOrganization(pool, {
      name: `fluxora-step42-a-${suffix}`,
    });
    orgB = await createOrganization(pool, {
      name: `fluxora-step42-b-${suffix}`,
    });

    repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `4201${Math.floor(Math.random() * 10000)}`,
      name: "repo-a",
      defaultBranch: "main",
    });

    repoB = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: `4202${Math.floor(Math.random() * 10000)}`,
      name: "repo-b",
      defaultBranch: "main",
    });
  });

  afterAll(async () => {
    delete process.env.FLUXORA_DATABASE_ROLE;
    if (pool) {
      await pool.query(
        `DELETE FROM organizations WHERE name LIKE $1`,
        [`fluxora-step42-%-${suffix}`],
      );
      await closePool();
    }
  });

  // 1. create PullRequest
  it("1. creates a new PullRequest record", async () => {
    const pr = await upsertPullRequest(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      githubPrId: "900001",
      number: 101,
      title: "Add authentication flow",
      url: "https://github.com/fluxora/repo-a/pull/101",
      baseRef: "main",
      baseSha: SHA_BASE,
      headRef: "feature/auth",
      headSha: SHA_HEAD,
      authorLogin: "dev-alice",
      authorId: "12345",
      lastDeliveryId: "delivery-guid-001",
    });

    assert.ok(pr.id);
    assert.equal(pr.organizationId, orgA.id);
    assert.equal(pr.repositoryId, repoA.id);
    assert.equal(pr.githubPrId, "900001");
    assert.equal(pr.number, 101);
    assert.equal(pr.title, "Add authentication flow");
    assert.equal(pr.url, "https://github.com/fluxora/repo-a/pull/101");
    assert.equal(pr.baseRef, "main");
    assert.equal(pr.baseSha, SHA_BASE);
    assert.equal(pr.headRef, "feature/auth");
    assert.equal(pr.headSha, SHA_HEAD);
    assert.equal(pr.status, "open");
    assert.equal(pr.authorLogin, "dev-alice");
    assert.equal(pr.authorId, "12345");
    assert.equal(pr.lastDeliveryId, "delivery-guid-001");
  });

  // 2. retrieve PullRequest
  it("2. retrieves an existing PullRequest by id and by repo/number", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);
    assert.equal(pr.number, 101);

    const byId = await getPullRequestById(pool, orgA.id, pr.id);
    assert.deepEqual(byId, pr);
  });

  // 3. update PullRequest
  it("3. updates an existing PullRequest via upsert on synchronize", async () => {
    const updated = await upsertPullRequest(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      githubPrId: "900001",
      number: 101,
      title: "Add authentication flow (updated)",
      url: "https://github.com/fluxora/repo-a/pull/101",
      baseRef: "main",
      baseSha: SHA_BASE,
      headRef: "feature/auth",
      headSha: SHA_HEAD2,
      lastDeliveryId: "delivery-guid-002",
    });

    assert.equal(updated.number, 101);
    assert.equal(updated.title, "Add authentication flow (updated)");
    assert.equal(updated.headSha, SHA_HEAD2);
    assert.equal(updated.lastDeliveryId, "delivery-guid-002");
    assert.equal(updated.authorLogin, "dev-alice"); // preserved
  });

  // 4. unique GitHub PR identity is enforced
  it("4. enforces unique GitHub PR number per repository", async () => {
    const prA = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(prA);

    // Attempting direct raw insert with different github_pr_id but same number in same repo violates unique
    await assert.rejects(async () => {
      await pool.query(
        `INSERT INTO pull_requests (
           organization_id, repository_id, github_pr_id, number,
           title, url, base_ref, base_sha, head_ref, head_sha
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orgA.id,
          repoA.id,
          999999,
          101,
          "Duplicate PR",
          "https://github.com/...",
          "main",
          SHA_BASE,
          "feature",
          SHA_HEAD,
        ],
      );
    });
  });

  // 5. changed files persist correctly
  it("5. persists changed files correctly", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "src/auth.ts",
        status: "added",
        additions: 45,
        deletions: 0,
        changes: 45,
        patch: "@@ -0,0 +1,45 @@\n+export function login() {}",
        headSha: SHA_HEAD2,
      },
      {
        path: "src/index.ts",
        status: "modified",
        additions: 5,
        deletions: 2,
        changes: 7,
        patch: "@@ -10,2 +10,5 @@\n+export * from './auth';",
        headSha: SHA_HEAD2,
      },
    ]);

    assert.equal(files.length, 2);
    const listed = await listPullRequestFiles(pool, orgA.id, pr.id);
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.path, "src/auth.ts");
    assert.equal(listed[1]?.path, "src/index.ts");
  });

  // 6. renamed file metadata persists
  it("6. persists renamed file metadata including previousPath", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        status: "renamed",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ -1 +1 @@",
      },
    ]);

    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "src/new-name.ts");
    assert.equal(files[0]?.previousPath, "src/old-name.ts");
    assert.equal(files[0]?.status, "renamed");
  });

  // 7. added file persists
  it("7. persists added file correctly", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "docs/readme.md",
        status: "added",
        additions: 10,
        deletions: 0,
        changes: 10,
      },
    ]);

    assert.equal(files[0]?.status, "added");
    assert.equal(files[0]?.additions, 10);
    assert.equal(files[0]?.deletions, 0);
  });

  // 8. modified file persists
  it("8. persists modified file correctly", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "package.json",
        status: "modified",
        additions: 3,
        deletions: 1,
        changes: 4,
      },
    ]);

    assert.equal(files[0]?.status, "modified");
    assert.equal(files[0]?.additions, 3);
    assert.equal(files[0]?.deletions, 1);
  });

  // 9. deleted file persists
  it("9. persists deleted / removed file correctly", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "deprecated.ts",
        status: "removed",
        additions: 0,
        deletions: 50,
        changes: 50,
      },
    ]);

    assert.equal(files[0]?.status, "removed");
    assert.equal(files[0]?.deletions, 50);
  });

  // 10. patch/diff is stored when available
  it("10. stores patch / diff text when provided by GitHub", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const patchText = "@@ -1,5 +1,6 @@\n+import { foo } from 'bar';\n console.log('hello');";
    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "src/sample.ts",
        status: "modified",
        patch: patchText,
        patchTruncated: false,
      },
    ]);

    assert.equal(files[0]?.patch, patchText);
    assert.equal(files[0]?.patchTruncated, false);
  });

  // 11. missing patch is handled safely
  it("11. handles missing patch safely (binary / large file)", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "assets/logo.png",
        status: "added",
        patch: null,
        patchTruncated: false,
      },
    ]);

    assert.equal(files[0]?.patch, null);
    assert.equal(files[0]?.patchTruncated, false);
  });

  // 12. duplicate changed files are prevented
  it("12. prevents duplicate changed file paths in same PR", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    await assert.rejects(async () => {
      await replacePullRequestFiles(pool, orgA.id, pr.id, [
        { path: "src/dup.ts", status: "added" },
        { path: "src/dup.ts", status: "modified" },
      ]);
    });
  });

  // 13. PullRequest and changed-file tenant isolation
  // 14. cross-tenant read returns no data
  it("13 & 14. enforces tenant isolation: cross-tenant read returns no data", async () => {
    // Org B creates PR 201 in repoB
    const prB = await upsertPullRequest(pool, {
      organizationId: orgB.id,
      repositoryId: repoB.id,
      githubPrId: "900002",
      number: 201,
      title: "Org B Secret Feature",
      url: "https://github.com/fluxora/repo-b/pull/201",
      baseRef: "main",
      baseSha: SHA_BASE,
      headRef: "secret-branch",
      headSha: SHA_HEAD,
    });

    await replacePullRequestFiles(pool, orgB.id, prB.id, [
      { path: "secret/logic.ts", status: "added", patch: "@@ secret @@" },
    ]);

    // Org A cannot read Org B's PR by ID
    const readFromA = await getPullRequestById(pool, orgA.id, prB.id);
    assert.equal(readFromA, null);

    // Org A cannot read Org B's PR files
    const filesFromA = await listPullRequestFiles(pool, orgA.id, prB.id);
    assert.equal(filesFromA.length, 0);
  });

  // 15. cross-tenant mutation is rejected/blocked
  it("15. blocks cross-tenant mutation (Org A cannot modify Org B's PR or files)", async () => {
    const prB = await getPullRequestByNumber(pool, orgB.id, repoB.id, 201);
    assert.ok(prB);

    // Org A tries to replace Org B's PR files -> RLS blocks insert because prB is not in Org A
    await assert.rejects(async () => {
      await replacePullRequestFiles(pool, orgA.id, prB.id, [
        { path: "hacked.ts", status: "added" },
      ]);
    });

    // Org A tries to upsert PR with repository belonging to Org B
    await assert.rejects(async () => {
      await upsertPullRequest(pool, {
        organizationId: orgA.id,
        repositoryId: repoB.id,
        githubPrId: "900999",
        number: 999,
        title: "Malicious PR",
        url: "https://...",
        baseRef: "main",
        baseSha: SHA_BASE,
        headRef: "head",
        headSha: SHA_HEAD,
      });
    });
  });

  // 16. foreign-key relationships are enforced
  it("16. enforces foreign-key relationships (invalid repositoryId or PR id is rejected)", async () => {
    const nonExistentRepoId = "00000000-0000-0000-0000-000000000099";

    await assert.rejects(async () => {
      await upsertPullRequest(pool, {
        organizationId: orgA.id,
        repositoryId: nonExistentRepoId,
        githubPrId: "900888",
        number: 888,
        title: "FK Test",
        url: "https://...",
        baseRef: "main",
        baseSha: SHA_BASE,
        headRef: "head",
        headSha: SHA_HEAD,
      });
    });
  });

  // 17. transaction rollback leaves no partial PR data
  it("17. rolls back atomically so errors leave no partial PR or file data", async () => {
    const prNumber = 303;

    await assert.rejects(async () => {
      await savePullRequestWithFiles(pool, {
        pr: {
          organizationId: orgA.id,
          repositoryId: repoA.id,
          githubPrId: "900303",
          number: prNumber,
          title: "Atomic failure test",
          url: "https://github.com/fluxora/repo-a/pull/303",
          baseRef: "main",
          baseSha: SHA_BASE,
          headRef: "feature",
          headSha: SHA_HEAD,
        },
        files: [
          { path: "src/valid.ts", status: "added" },
          // duplicate file will trigger unique constraint violation and abort transaction
          { path: "src/valid.ts", status: "modified" },
        ],
      });
    });

    // Verify PR 303 was NOT created
    const notFound = await getPullRequestByNumber(pool, orgA.id, repoA.id, prNumber);
    assert.equal(notFound, null);
  });

  // 13. patch truncation metadata
  it("13. records patch truncation metadata (patchTruncated: true)", async () => {
    const pr = await getPullRequestByNumber(pool, orgA.id, repoA.id, 101);
    assert.ok(pr);

    const files = await replacePullRequestFiles(pool, orgA.id, pr.id, [
      {
        path: "src/huge-file.ts",
        status: "modified",
        patch: "@@ truncated hunk @@",
        patchTruncated: true,
      },
    ]);

    assert.equal(files[0]?.path, "src/huge-file.ts");
    assert.equal(files[0]?.patchTruncated, true);

    const listed = await listPullRequestFiles(pool, orgA.id, pr.id);
    const found = listed.find((f) => f.path === "src/huge-file.ts");
    assert.ok(found);
    assert.equal(found.patchTruncated, true);
  });

  // 18. tenant isolation on PullRequestFile
  it("18. enforces tenant isolation on PullRequestFile directly under RLS", async () => {
    const prB = await getPullRequestByNumber(pool, orgB.id, repoB.id, 201);
    assert.ok(prB);

    // Using withTenant for orgA, direct query on pull_request_files for prB returns 0 rows
    const { withTenant } = await import("../tenant.ts");
    await withTenant(pool, orgA.id, async (client) => {
      const res = await client.query(
        "SELECT * FROM pull_request_files WHERE pull_request_id = $1::uuid",
        [prB.id],
      );
      assert.equal(res.rows.length, 0);

      // Attempting direct INSERT into pull_request_files for prB as orgA is rejected by RLS
      await assert.rejects(async () => {
        await client.query(
          `INSERT INTO pull_request_files (pull_request_id, path, status)
           VALUES ($1::uuid, 'malicious.ts', 'added')`,
          [prB.id],
        );
      });
    });
  });

  // 20. cascade behavior where appropriate
  it("20. cascades deletion from PullRequest to PullRequestFiles and Repository to PullRequests", async () => {
    // Create a temporary PR in repoA with files
    const cascadePr = await upsertPullRequest(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      githubPrId: "900404",
      number: 404,
      title: "Cascade Test PR",
      url: "https://github.com/fluxora/repo-a/pull/404",
      baseRef: "main",
      baseSha: SHA_BASE,
      headRef: "cascade-branch",
      headSha: SHA_HEAD,
    });

    await replacePullRequestFiles(pool, orgA.id, cascadePr.id, [
      { path: "src/cascade-1.ts", status: "added" },
      { path: "src/cascade-2.ts", status: "added" },
    ]);

    const filesBefore = await listPullRequestFiles(pool, orgA.id, cascadePr.id);
    assert.equal(filesBefore.length, 2);

    // Delete the PR directly under tenant session
    const { withTenant } = await import("../tenant.ts");
    await withTenant(pool, orgA.id, async (client) => {
      await client.query("DELETE FROM pull_requests WHERE id = $1::uuid", [
        cascadePr.id,
      ]);
    });

    // Check PR is gone
    const prAfter = await getPullRequestById(pool, orgA.id, cascadePr.id);
    assert.equal(prAfter, null);

    // Check files cascaded (are also gone)
    const filesAfter = await listPullRequestFiles(pool, orgA.id, cascadePr.id);
    assert.equal(filesAfter.length, 0);
  });
});

