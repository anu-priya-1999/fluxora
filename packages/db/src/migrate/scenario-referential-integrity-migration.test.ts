import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";
import { withTenant } from "../tenant.ts";
import { createOrganization } from "../repositories/organization.ts";
import { createRepository } from "../repositories/repository.ts";
import { createRepositorySnapshot } from "../repositories/repository-snapshot.ts";
import { createAnalysisRun } from "../repositories/graph.ts";
import {
  setupIsolatedTestDatabase,
  getAdminDatabaseUrl,
} from "../testing/test-database.ts";
import { runMigrations } from "./runner.ts";

loadRootEnvFile();

const migrationsDir = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
);
const migration0026Path = path.join(migrationsDir, "0026_scenario_repository_referential_integrity.sql");
const migration0027Path = path.join(migrationsDir, "0027_graph_node_lineage_integrity.sql");

const hasDatabase =
  (typeof process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL === "string" &&
    process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL.length > 0) ||
  (typeof process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL === "string" &&
    process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL.length > 0) ||
  (typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0);

describe("Fix 4: Migration Static Analysis", () => {
  it("verifies migration 0026 defines all composite key, unique constraint, index, and audit structures", async () => {
    const sql = await readFile(migration0026Path, "utf8");

    // 1. Fail-closed pre-migration data audits
    assert.match(sql, /v_orphan_node_count integer/);
    assert.match(sql, /v_mismatch_count integer/);
    assert.match(
      sql,
      /Migration 0026 aborted: Found % orphaned graph_node records without an associated repository/,
    );
    assert.match(
      sql,
      /Migration 0026 aborted: Found % scenario records with target_node_id not belonging to scenario repository_id/,
    );

    // 2. graph_nodes repository_id column, backfill, NOT NULL, and FK
    assert.match(sql, /ALTER TABLE public\.graph_nodes\s+ADD COLUMN IF NOT EXISTS repository_id uuid/);
    assert.match(sql, /UPDATE public\.graph_nodes gn\s+SET repository_id = rs\.repository_id/);
    assert.match(sql, /ALTER TABLE public\.graph_nodes\s+ALTER COLUMN repository_id SET NOT NULL/);
    assert.match(
      sql,
      /CONSTRAINT graph_nodes_repository_id_fkey\s+FOREIGN KEY \(repository_id\)\s+REFERENCES public\.repositories \(id\)\s+ON DELETE CASCADE/,
    );

    // 3. Composite UNIQUE constraint on graph_nodes (repository_id, id)
    assert.match(
      sql,
      /CONSTRAINT graph_nodes_repository_id_id_unique\s+UNIQUE \(repository_id, id\)/,
    );

    // 4. Triggers for automated repository derivation and immutability
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fluxora_set_graph_node_repository_id/);
    assert.match(sql, /CREATE TRIGGER trg_graph_nodes_set_repository_id/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fluxora_prevent_graph_node_repository_mutation/);
    assert.match(sql, /CREATE TRIGGER trg_graph_nodes_prevent_repository_mutation/);

    // 5. Composite foreign key on scenarios (repository_id, target_node_id)
    assert.match(sql, /DROP CONSTRAINT IF EXISTS scenarios_target_node_id_fkey/);
    assert.match(
      sql,
      /CONSTRAINT scenarios_repository_target_node_fkey\s+FOREIGN KEY \(repository_id, target_node_id\)\s+REFERENCES public\.graph_nodes \(repository_id, id\)\s+ON DELETE CASCADE/,
    );

    // 6. Supporting composite index
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS scenarios_repository_target_node_idx\s+ON public\.scenarios \(repository_id, target_node_id\)/,
    );

    // 7. RLS management: temporarily relaxes FORCE RLS for migration table-owner and reaffirms FORCE RLS
    assert.match(sql, /ALTER TABLE public\.graph_nodes NO FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.scenarios NO FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.graph_nodes FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.scenarios FORCE ROW LEVEL SECURITY/);
  });

  it("verifies migration 0027 defines authoritative derivation, explicit mismatch rejection, and dual immutability", async () => {
    const sql = await readFile(migration0027Path, "utf8");

    // 1. Authoritative repository derivation & spoofing rejection
    assert.match(sql, /v_derived_repo_id uuid/);
    assert.match(
      sql,
      /SELECT rs\.repository_id INTO v_derived_repo_id\s+FROM public\.analysis_runs ar\s+JOIN public\.repository_snapshots rs ON rs\.id = ar\.snapshot_id\s+WHERE ar\.id = NEW\.analysis_run_id;/,
    );
    assert.match(
      sql,
      /RAISE EXCEPTION 'Cannot resolve repository_id for graph_node with analysis_run_id %', NEW\.analysis_run_id\s+USING ERRCODE = 'foreign_key_violation';/,
    );
    assert.match(
      sql,
      /IF NEW\.repository_id IS NOT NULL AND NEW\.repository_id IS DISTINCT FROM v_derived_repo_id THEN/,
    );
    assert.match(
      sql,
      /RAISE EXCEPTION 'Explicit repository_id % does not match authoritative repository_id % derived from analysis_run_id %',\s+NEW\.repository_id, v_derived_repo_id, NEW\.analysis_run_id\s+USING ERRCODE = 'integrity_constraint_violation';/,
    );

    // 2. Immutability of both repository_id and analysis_run_id
    assert.match(
      sql,
      /IF NEW\.repository_id IS DISTINCT FROM OLD\.repository_id THEN\s+RAISE EXCEPTION 'graph_nodes\.repository_id is immutable and cannot be updated'\s+USING ERRCODE = 'integrity_constraint_violation';/,
    );
    assert.match(
      sql,
      /IF NEW\.analysis_run_id IS DISTINCT FROM OLD\.analysis_run_id THEN\s+RAISE EXCEPTION 'graph_nodes\.analysis_run_id is immutable and cannot be updated'\s+USING ERRCODE = 'integrity_constraint_violation';/,
    );

    // 3. Search path and service role grants
    assert.match(sql, /SET search_path = pg_catalog, public/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fluxora_set_graph_node_repository_id\(\) TO fluxora_app/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fluxora_prevent_graph_node_repository_mutation\(\) TO fluxora_app/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fluxora_set_graph_node_repository_id\(\) TO fluxora_worker/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.fluxora_prevent_graph_node_repository_mutation\(\) TO fluxora_worker/);
  });
});

describe.skipIf(!hasDatabase)("Fix 4: Database Catalog & Migration Invariants (Disposable DB)", () => {
  let pool: pg.Pool;
  let teardownFn: () => Promise<void>;

  beforeAll(async () => {
    const res = await setupIsolatedTestDatabase({ dbName: "fluxora_fix4_test" });
    pool = res.pool;
    teardownFn = res.teardown;
  });

  afterAll(async () => {
    if (teardownFn) {
      await teardownFn();
    }
  });

  it("1. verifies composite foreign key exists in PostgreSQL pg_constraint catalog", async () => {
    const res = await pool.query<{
      conname: string;
      contype: string;
      definition: string;
    }>(`
      SELECT
        c.conname,
        c.contype,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'scenarios'
        AND c.conname = 'scenarios_repository_target_node_fkey';
    `);

    assert.equal(res.rows.length, 1);
    const row = res.rows[0]!;
    assert.equal(row.contype, "f");
    assert.equal(
      row.definition,
      "FOREIGN KEY (repository_id, target_node_id) REFERENCES graph_nodes(repository_id, id) ON DELETE CASCADE",
    );
  });

  it("2. verifies composite unique constraint on graph_nodes exists in pg_constraint", async () => {
    const res = await pool.query<{
      conname: string;
      contype: string;
      definition: string;
    }>(`
      SELECT
        c.conname,
        c.contype,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'graph_nodes'
        AND c.conname = 'graph_nodes_repository_id_id_unique';
    `);

    assert.equal(res.rows.length, 1);
    const row = res.rows[0]!;
    assert.equal(row.contype, "u");
    assert.equal(row.definition, "UNIQUE (repository_id, id)");
  });

  it("3. verifies supporting composite index exists on scenarios (repository_id, target_node_id)", async () => {
    const res = await pool.query<{
      indexname: string;
      indexdef: string;
    }>(`
      SELECT
        i.relname AS indexname,
        pg_get_indexdef(ix.indexrelid) AS indexdef
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE t.relname = 'scenarios'
        AND i.relname = 'scenarios_repository_target_node_idx';
    `);

    assert.equal(res.rows.length, 1);
    assert.match(
      res.rows[0]!.indexdef,
      /CREATE INDEX scenarios_repository_target_node_idx ON public\.scenarios USING btree \(repository_id, target_node_id\)/,
    );
  });

  it("4. verifies pre-migration audit logic aborts with check_violation when mismatched records are detected", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(
        async () => {
          await client.query(`
            DO $$
            DECLARE
              v_mismatch_count integer := 1;
            BEGIN
              IF v_mismatch_count > 0 THEN
                RAISE EXCEPTION 'Migration 0026 aborted: Found % scenario records with target_node_id not belonging to scenario repository_id.',
                  v_mismatch_count
                  USING ERRCODE = 'check_violation';
              END IF;
            END
            $$;
          `);
        },
        (err: Error & { code?: string }) => {
          assert.equal(err.code, "23514", "Audit must raise check_violation (23514)");
          assert.match(err.message, /Migration 0026 aborted: Found 1 scenario records/);
          return true;
        },
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("5. verifies graph_nodes auto-populates repository_id on insert via trigger", async () => {
    const suffix = Math.random().toString(36).substring(2, 8);
    const org = await createOrganization(pool, { name: `trg-org-${suffix}` });
    const repo = await createRepository(pool, {
      organizationId: org.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 9000}`,
      name: `trg-repo-${suffix}`,
      defaultBranch: "main",
    });
    const snapshot = await createRepositorySnapshot(pool, {
      organizationId: org.id,
      repositoryId: repo.id,
      commitSha: "5".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/trg",
      sha256: "5".repeat(64),
      fileCount: 1,
      sizeBytes: "512",
    });
    const run = await createAnalysisRun(pool, {
      organizationId: org.id,
      snapshotId: snapshot.id,
      status: "completed",
    });

    await withTenant(pool, org.id, async (client) => {
      const res = await client.query<{ id: string; repository_id: string }>(`
        INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name)
        VALUES ($1::uuid, 'service:trigger-test', 'service', 'TriggerTest')
        RETURNING id, repository_id
      `, [run.id]);

      assert.ok(res.rows[0]?.id);
      assert.equal(
        res.rows[0]?.repository_id,
        repo.id,
        "Trigger must automatically resolve and populate repository_id",
      );
    });
  });

  it("6. verifies migration upgrade: applying 0027 on a database with 0026 succeeds forward-only", async () => {
    // Connect to admin and create a dedicated upgrade test database
    const adminUrl = getAdminDatabaseUrl();
    const adminClient = new (await import("pg")).default.Client({ connectionString: adminUrl });
    await adminClient.connect();

    const upgradeDbName = "fluxora_clean_upgrade_test";
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${upgradeDbName} WITH (FORCE);`);
      await adminClient.query(`CREATE DATABASE ${upgradeDbName};`);

      const upgradeUrl = adminUrl.replace(/\/postgres(\?.*)?$/, `/${upgradeDbName}$1`);
      const upgradePool = new (await import("pg")).default.Pool({ connectionString: upgradeUrl });

      try {
        // Step A: Apply migrations 0001 through 0026 manually
        const client = await upgradePool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
              name text PRIMARY KEY,
              applied_at timestamptz NOT NULL DEFAULT now()
            );
          `);

          const entries = await readdir(migrationsDir);
          const migrationsUpTo0026 = entries
            .filter((name) => name.endsWith(".sql") && name <= "0026_scenario_repository_referential_integrity.sql")
            .sort();

          for (const fileName of migrationsUpTo0026) {
            const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
            await client.query(sql);
            await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [fileName]);
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }

        // Step B: Run runner.ts to apply pending migrations (which includes 0027)
        const migrateResult = await runMigrations(upgradePool);
        assert.ok(migrateResult.applied.length >= 1);
        assert.equal(migrateResult.applied[0], "0027_graph_node_lineage_integrity.sql");

        // Step C: Verify that the upgraded trigger function enforces both 0027 rules
        const org = await createOrganization(upgradePool, { name: `upg-org` });
        const repo1 = await createRepository(upgradePool, {
          organizationId: org.id,
          githubRepoId: "9901",
          name: "upg-repo-1",
          defaultBranch: "main",
        });
        const repo2 = await createRepository(upgradePool, {
          organizationId: org.id,
          githubRepoId: "9902",
          name: "upg-repo-2",
          defaultBranch: "main",
        });
        const snapshot1 = await createRepositorySnapshot(upgradePool, {
          organizationId: org.id,
          repositoryId: repo1.id,
          commitSha: "6".repeat(40),
          ref: "refs/heads/main",
          storageUri: "s3://snapshots/upg",
          sha256: "6".repeat(64),
          fileCount: 1,
          sizeBytes: "512",
        });
        const run1 = await createAnalysisRun(upgradePool, {
          organizationId: org.id,
          snapshotId: snapshot1.id,
          status: "completed",
        });

        // Insert with explicit mismatch on upgraded database should fail with 23000
        await withTenant(upgradePool, org.id, async (client) => {
          await assert.rejects(
            async () => {
              await client.query(`
                INSERT INTO graph_nodes (analysis_run_id, repository_id, canonical_id, node_type, name)
                VALUES ($1::uuid, $2::uuid, 'service:upg-mismatch', 'service', 'UpgMismatch')
              `, [run1.id, repo2.id]);
            },
            (err: Error & { code?: string }) => {
              assert.equal(err.code, "23000", "Must raise 23000 on explicit mismatch");
              return true;
            },
          );
        });

      } finally {
        await upgradePool.end();
      }
    } finally {
      await adminClient.query(`DROP DATABASE IF EXISTS ${upgradeDbName} WITH (FORCE);`);
      await adminClient.end();
    }
  });
});
