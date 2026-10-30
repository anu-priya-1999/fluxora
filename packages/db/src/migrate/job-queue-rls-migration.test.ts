import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll, afterAll, test } from "vitest";
import pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";
import {
  HISTORICAL_0023_CANDIDATE_PROVENANCE,
  loadHistorical0023CandidateSql,
} from "./fixtures/historical-0023-candidate.ts";

loadRootEnvFile();

const migration0020Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0020_job_queue_least_privilege_rls.sql",
);

const migration0021Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0021_job_queue_hardening.sql",
);

const migration0022Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0022_job_queue_crash_recovery_retry_limit.sql",
);

const migration0023Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0023_job_queue_attempt_count_invariant.sql",
);

const migration0024Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0024_job_queue_configured_retry_limit.sql",
);

const QUEUE_FUNCTIONS_0020 = [
  "public.fluxora_claim_next_job(text, integer)",
  "public.fluxora_complete_job(uuid, text)",
  "public.fluxora_fail_job(uuid, text, text)",
  "public.fluxora_retry_failed_job(uuid, integer)",
] as const;

const QUEUE_FUNCTIONS_0021 = [
  "public.fluxora_claim_next_job(text, integer)",
  "public.fluxora_complete_job(uuid, text)",
  "public.fluxora_fail_job(uuid, text, text)",
  "public.fluxora_retry_failed_job(uuid, text, integer, text)",
] as const;

const QUEUE_FUNCTIONS_0024 = [
  ...QUEUE_FUNCTIONS_0021,
  "public.fluxora_jobs_retry_limits_guard()",
] as const;

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("0020 migration file enforces least privilege and transfers queue function ownership", async () => {
  const sql = executableSql(await readFile(migration0020Path, "utf8"));

  // 1. Role creation and constraints
  assert.ok(sql.includes("CREATE ROLE fluxora_queue"));
  assert.ok(sql.includes("NOLOGIN"));
  assert.ok(sql.includes("NOSUPERUSER"));
  assert.ok(sql.includes("NOBYPASSRLS"));
  assert.ok(sql.includes("NOCREATEROLE"));
  assert.ok(sql.includes("NOCREATEDB"));
  assert.ok(sql.includes("NOINHERIT"));

  // 2. Minimal permissions for fluxora_queue
  assert.ok(sql.includes("GRANT USAGE ON SCHEMA public TO fluxora_queue"));
  assert.ok(sql.includes("GRANT SELECT, UPDATE ON TABLE public.jobs TO fluxora_queue"));
  assert.equal(sql.includes("GRANT ALL ON TABLE public.jobs TO fluxora_queue"), false);
  assert.equal(sql.includes("GRANT INSERT ON TABLE public.jobs TO fluxora_queue"), false);
  assert.equal(sql.includes("GRANT DELETE ON TABLE public.jobs TO fluxora_queue"), false);

  // 3. Queue policies on public.jobs
  assert.ok(sql.includes("CREATE POLICY jobs_queue_select ON public.jobs FOR SELECT TO fluxora_queue USING (true)"));
  assert.ok(sql.includes("CREATE POLICY jobs_queue_update ON public.jobs FOR UPDATE TO fluxora_queue USING (true) WITH CHECK (true)"));

  // 4. Function definitions pin search_path safely with pg_temp last
  for (const fn of [
    "fluxora_claim_next_job",
    "fluxora_complete_job",
    "fluxora_fail_job",
    "fluxora_retry_failed_job",
  ]) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}`));
  }
  const searchPathOccurrences = [
    ...sql.matchAll(/SET search_path = pg_catalog, public, pg_temp/g),
  ];
  assert.equal(searchPathOccurrences.length, 4);

  // 5. Ownership transfer sequence
  const membershipGrant = sql.indexOf("GRANT fluxora_queue TO CURRENT_USER");
  const membershipRevoke = sql.indexOf("REVOKE fluxora_queue FROM CURRENT_USER");
  assert.ok(membershipGrant >= 0);
  assert.ok(membershipRevoke > membershipGrant);

  for (const signature of QUEUE_FUNCTIONS_0020) {
    const ownerIndex = sql.indexOf(`ALTER FUNCTION ${signature} OWNER TO fluxora_queue`);
    assert.ok(ownerIndex > membershipGrant);
    assert.ok(ownerIndex < membershipRevoke);

    const revokePublic = sql.indexOf(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    assert.ok(revokePublic > ownerIndex);

    const grantUser = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${signature} TO CURRENT_USER`);
    assert.ok(grantUser > revokePublic);
    assert.ok(grantUser < membershipRevoke);
  }

  // 6. FORCE ROW LEVEL SECURITY remains enabled
  assert.ok(sql.includes("ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY"));
  assert.ok(sql.includes("ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY"));

  // 7. Validation block
  assert.match(sql, /expected fluxora_queue/);
  assert.match(sql, /PUBLIC retains EXECUTE/);
  assert.match(sql, /has no EXECUTE grant/);
  assert.match(sql, /must not inherit fluxora_queue/);
});

test("0021 migration file hardens fluxora_queue role attributes, narrows table grants, and enforces atomic retry authorization", async () => {
  const sql = executableSql(await readFile(migration0021Path, "utf8"));

  // 1. Strict validation of all promised role attributes on fluxora_queue
  assert.ok(sql.includes("r.rolcanlogin"));
  assert.ok(sql.includes("r.rolsuper"));
  assert.ok(sql.includes("r.rolcreaterole"));
  assert.ok(sql.includes("r.rolcreatedb"));
  assert.ok(sql.includes("r.rolbypassrls"));
  assert.ok(sql.includes("r.rolinherit"));
  assert.ok(sql.includes("r.rolreplication"));
  assert.match(sql, /Existing fluxora_queue role has unsafe attributes/);

  // 2. Table grant narrowing: column-specific UPDATE
  assert.ok(sql.includes("REVOKE ALL ON TABLE public.jobs FROM fluxora_queue"));
  assert.ok(sql.includes("GRANT SELECT ON TABLE public.jobs TO fluxora_queue"));
  assert.ok(
    sql.includes(
      "GRANT UPDATE ( status, attempt_count, locked_at, locked_by, lease_expires_at, started_at, completed_at, failed_at, last_error, available_at ) ON TABLE public.jobs TO fluxora_queue",
    ),
  );
  assert.equal(sql.includes("GRANT INSERT ON TABLE public.jobs TO fluxora_queue"), false);
  assert.equal(sql.includes("GRANT DELETE ON TABLE public.jobs TO fluxora_queue"), false);

  // 3. Temporary authority, drop old signature, create new signature, alter owner, restore role, then grant execute
  const membershipGrant = sql.indexOf("GRANT fluxora_queue TO CURRENT_USER");
  const membershipRevoke = sql.indexOf("REVOKE fluxora_queue FROM CURRENT_USER");
  assert.ok(membershipGrant >= 0, "0021 must grant temporary fluxora_queue membership");
  assert.ok(membershipRevoke > membershipGrant, "0021 must revoke temporary fluxora_queue membership");

  const dropSignature = "DROP FUNCTION IF EXISTS public.fluxora_retry_failed_job(uuid, integer)";
  const dropIndex = sql.indexOf(dropSignature);
  assert.ok(dropIndex > membershipGrant, "DROP FUNCTION must occur after obtaining fluxora_queue authority");
  assert.ok(dropIndex < membershipRevoke, "DROP FUNCTION must occur before revoking fluxora_queue authority");

  // 4. Create atomic 4-parameter retry function
  assert.ok(
    sql.includes(
      "CREATE OR REPLACE FUNCTION public.fluxora_retry_failed_job( p_job_id uuid, p_worker_id text, p_retry_delay_seconds integer DEFAULT 0, p_error text DEFAULT NULL )",
    ),
  );
  assert.ok(sql.includes("SET search_path = pg_catalog, public, pg_temp"));
  assert.ok(sql.includes("j.locked_by = p_worker_id"));
  assert.ok(sql.includes("j.lease_expires_at > pg_catalog.now()"));
  assert.ok(sql.includes("j.status = 'running'"));

  // 5. Function ownership and execution grant lifecycle
  const retrySig = "public.fluxora_retry_failed_job(uuid, text, integer, text)";
  const ownerIndex = sql.indexOf(`ALTER FUNCTION ${retrySig} OWNER TO fluxora_queue`);
  assert.ok(ownerIndex > dropIndex, "ALTER OWNER must occur after dropping old function");
  assert.ok(ownerIndex < membershipRevoke, "ALTER OWNER must occur while holding fluxora_queue authority");

  const revokePublic = sql.indexOf(`REVOKE ALL ON FUNCTION ${retrySig} FROM PUBLIC`);
  assert.ok(revokePublic > ownerIndex, "REVOKE from PUBLIC must occur after ownership transfer");
  assert.ok(revokePublic < membershipRevoke, "REVOKE from PUBLIC must occur while holding owner authority");

  const grantUser = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${retrySig} TO CURRENT_USER`);
  assert.ok(grantUser > revokePublic, "GRANT EXECUTE to CURRENT_USER must occur after revoking from PUBLIC");
  assert.ok(grantUser < membershipRevoke, "GRANT EXECUTE to CURRENT_USER must occur while holding owner authority");

  // 6. FORCE ROW LEVEL SECURITY remains enabled
  assert.ok(sql.includes("ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY"));
  assert.ok(sql.includes("ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY"));

  // 7. Verification block verifies all 4 hardened functions
  for (const signature of QUEUE_FUNCTIONS_0021) {
    assert.ok(sql.includes(signature), `0021 verification block must check ${signature}`);
  }
  assert.match(sql, /expected fluxora_queue/);
  assert.match(sql, /PUBLIC retains EXECUTE/);
  assert.match(sql, /has no EXECUTE grant/);
  assert.match(sql, /must not inherit fluxora_queue/);
});

test("0022 migration file enforces worker crash recovery, attempt-count invariant, and dead-letter cleanup", async () => {
  const sql = executableSql(await readFile(migration0022Path, "utf8"));

  // 1. Function definition uses plpgsql and safe search_path
  assert.ok(
    sql.includes(
      "CREATE OR REPLACE FUNCTION public.fluxora_claim_next_job( p_worker_id text, p_lease_seconds integer DEFAULT 60 )",
    ),
  );
  assert.ok(sql.includes("LANGUAGE plpgsql"));
  assert.ok(sql.includes("SECURITY DEFINER"));
  assert.ok(sql.includes("SET search_path = pg_catalog, public, pg_temp"));

  // 2. Dead-letter cleanup for exhausted expired running jobs and exhausted pending jobs
  assert.ok(sql.includes("status = 'dead_letter'"));
  assert.ok(sql.includes("e.attempt_count >= e.max_attempts"));
  assert.ok(sql.includes("e.lease_expires_at <= pg_catalog.now()"));
  assert.ok(sql.includes("LIMIT 25"));
  assert.ok(sql.includes("FOR UPDATE SKIP LOCKED"));

  // 3. Candidate query strictly enforces attempt_count < max_attempts
  assert.ok(sql.includes("j.attempt_count < j.max_attempts"));
  assert.ok(sql.includes("attempt_count = j.attempt_count + 1"));

  // 4. Temporary authority grant & revoke sequence
  const membershipGrant = sql.indexOf("GRANT fluxora_queue TO CURRENT_USER");
  const membershipRevoke = sql.indexOf("REVOKE fluxora_queue FROM CURRENT_USER");
  assert.ok(membershipGrant >= 0, "0022 must grant temporary fluxora_queue membership");
  assert.ok(membershipRevoke > membershipGrant, "0022 must revoke temporary fluxora_queue membership");

  // 5. Ownership and ACL configuration
  const claimSig = "public.fluxora_claim_next_job(text, integer)";
  const ownerIndex = sql.indexOf(`ALTER FUNCTION ${claimSig} OWNER TO fluxora_queue`);
  assert.ok(ownerIndex > membershipGrant);
  assert.ok(ownerIndex < membershipRevoke);

  const revokePublic = sql.indexOf(`REVOKE ALL ON FUNCTION ${claimSig} FROM PUBLIC`);
  assert.ok(revokePublic > ownerIndex);

  const grantUser = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${claimSig} TO CURRENT_USER`);
  assert.ok(grantUser > revokePublic);
  assert.ok(grantUser < membershipRevoke);

  // 6. FORCE ROW LEVEL SECURITY remains enabled
  assert.ok(sql.includes("ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY"));
  assert.ok(sql.includes("ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY"));

  // 7. Validation block
  assert.match(sql, /expected fluxora_queue/);
  assert.match(sql, /PUBLIC retains EXECUTE/);
  assert.match(sql, /has no EXECUTE grant/);
  assert.match(sql, /must not inherit fluxora_queue/);
});

test("0023 migration file enforces attempt-count invariant, parameter validation, and legacy reconciliation", async () => {
  const sql = executableSql(await readFile(migration0023Path, "utf8"));

  // 1. Parameter validation rejects invalid arguments before modifying rows
  assert.ok(
    sql.includes(
      "IF p_worker_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_worker_id, E' \\t\\n\\r')) = 0 THEN",
    ),
  );
  assert.ok(sql.includes("p_worker_id must be a non-empty, non-whitespace string"));
  assert.ok(
    sql.includes("IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN"),
  );
  assert.ok(sql.includes("p_lease_seconds must be a positive integer"));

  // 2. Legacy reconciliation accounts for all statuses without decrementing attempt_count
  assert.ok(sql.includes("max_attempts = j.attempt_count"));
  assert.ok(sql.includes("WHERE j.attempt_count > j.max_attempts"));
  assert.ok(sql.includes("WHEN j.status = 'pending' THEN 'dead_letter'"));
  assert.ok(sql.includes("WHEN j.status = 'failed' THEN 'dead_letter'"));

  // 2b. Temporary migration-scoped RLS policy lifecycle (Fix 2B)
  const policyCreateIdx = sql.indexOf(
    "CREATE POLICY jobs_migration_reconcile_0023 ON public.jobs FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)",
  );
  const backfillIdx = sql.indexOf("UPDATE public.jobs AS j");
  const policyDropIdx = sql.indexOf(
    "DROP POLICY jobs_migration_reconcile_0023 ON public.jobs",
  );
  assert.ok(
    policyCreateIdx >= 0,
    "0023 must create temporary migration reconciliation policy scoped to CURRENT_USER",
  );
  assert.ok(
    backfillIdx > policyCreateIdx,
    "Normalization UPDATE must occur while temporary reconciliation policy is active",
  );
  assert.ok(
    policyDropIdx > backfillIdx,
    "Temporary reconciliation policy must be dropped after backfill verification",
  );

  // 3. CHECK constraint definition and validation
  assert.ok(sql.includes("ADD CONSTRAINT jobs_attempt_count_le_max_attempts"));
  assert.ok(sql.includes("CHECK (attempt_count <= max_attempts)"));
  assert.ok(sql.includes("NOT VALID"));
  assert.ok(
    sql.includes("VALIDATE CONSTRAINT jobs_attempt_count_le_max_attempts"),
  );

  // 4. Temporary authority grant & revoke sequence
  const membershipGrant = sql.indexOf("GRANT fluxora_queue TO CURRENT_USER");
  const membershipRevoke = sql.indexOf("REVOKE fluxora_queue FROM CURRENT_USER");
  assert.ok(
    membershipGrant >= 0,
    "0023 must grant temporary fluxora_queue membership",
  );
  assert.ok(
    membershipRevoke > membershipGrant,
    "0023 must revoke temporary fluxora_queue membership",
  );

  // 5. Ownership and ACL configuration for fluxora_claim_next_job
  const claimFn = "public.fluxora_claim_next_job(text, integer)";
  const ownerIndex = sql.indexOf(`ALTER FUNCTION ${claimFn} OWNER TO fluxora_queue`);
  assert.ok(ownerIndex > membershipGrant, `ALTER FUNCTION ${claimFn} OWNER TO fluxora_queue must be between grants`);
  assert.ok(ownerIndex < membershipRevoke);

  const revokePublic = sql.indexOf(`REVOKE ALL ON FUNCTION ${claimFn} FROM PUBLIC`);
  assert.ok(revokePublic > ownerIndex);

  const grantUser = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${claimFn} TO CURRENT_USER`);
  assert.ok(grantUser > revokePublic);
  assert.ok(grantUser < membershipRevoke);

  // 6. FORCE ROW LEVEL SECURITY remains enabled
  assert.ok(sql.includes("ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY"));
  assert.ok(sql.includes("ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY"));

  // 7. Validation block
  assert.match(sql, /expected fluxora_queue/);
  assert.match(sql, /PUBLIC retains EXECUTE/);
  assert.match(sql, /has no EXECUTE grant/);
  assert.match(sql, /must not inherit fluxora_queue/);
  assert.match(sql, /Temporary migration policy jobs_migration_reconcile_0023 was not removed/);
  assert.match(sql, /jobs_attempt_count_le_max_attempts/);
  assert.match(sql, /jobs_attempt_count_check/);
  assert.match(sql, /jobs_max_attempts_check/);
});

test("0024 migration file introduces configured_max_attempts, trigger guard, and safe queue functions", async () => {
  const sql = executableSql(await readFile(migration0024Path, "utf8"));

  // 1. Temporary migration-scoped RLS policy lifecycle (Fix 2E)
  const policyCreateIdx = sql.indexOf(
    "CREATE POLICY jobs_migration_reconcile_0024 ON public.jobs FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)",
  );
  const configuredBackfillIdx = sql.indexOf(
    "UPDATE public.jobs SET configured_max_attempts = CASE",
  );
  const policyDropIdx = sql.indexOf(
    "DROP POLICY jobs_migration_reconcile_0024 ON public.jobs",
  );
  assert.ok(
    policyCreateIdx >= 0,
    "0024 must create temporary migration reconciliation policy scoped to CURRENT_USER",
  );
  assert.ok(
    configuredBackfillIdx > policyCreateIdx,
    "configured_max_attempts backfill must occur after temporary reconciliation policy is active",
  );
  assert.ok(
    policyDropIdx > configuredBackfillIdx,
    "Temporary reconciliation policy must be dropped after backfill verification",
  );

  // 2. configured_max_attempts column addition and constraints
  assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS configured_max_attempts integer"));
  assert.ok(sql.includes("ALTER COLUMN max_attempts DROP DEFAULT"));
  assert.ok(sql.includes("ALTER COLUMN configured_max_attempts DROP DEFAULT"));
  assert.equal(
    sql.includes("ALTER COLUMN configured_max_attempts SET NOT NULL"),
    false,
    "configured_max_attempts must remain nullable to represent historical uncertainty honestly",
  );
  assert.ok(sql.includes("CHECK (configured_max_attempts IS NULL OR configured_max_attempts > 0)"));
  assert.ok(sql.includes("jobs_configured_max_attempts_check"));

  // 3. Temporary authority grant & revoke sequence
  const membershipGrant = sql.indexOf("GRANT fluxora_queue TO CURRENT_USER");
  const membershipRevoke = sql.indexOf("REVOKE fluxora_queue FROM CURRENT_USER");
  assert.ok(
    membershipGrant >= 0,
    "0024 must grant temporary fluxora_queue membership",
  );
  assert.ok(
    membershipRevoke > membershipGrant,
    "0024 must revoke temporary fluxora_queue membership",
  );

  // 4. Ownership and ACL configuration for all 4 queue functions and trigger guard
  const allQueueFuncs = [
    "public.fluxora_claim_next_job(text, integer)",
    "public.fluxora_complete_job(uuid, text)",
    "public.fluxora_fail_job(uuid, text, text)",
    "public.fluxora_retry_failed_job(uuid, text, integer, text)",
  ];

  for (const fn of allQueueFuncs) {
    const dropIdx = sql.indexOf(`DROP FUNCTION IF EXISTS ${fn}`);
    assert.ok(dropIdx >= 0, `0024 must DROP FUNCTION IF EXISTS before altering RETURNS TABLE for ${fn}`);

    const ownerIndex = sql.indexOf(`ALTER FUNCTION ${fn} OWNER TO fluxora_queue`);
    assert.ok(ownerIndex > membershipGrant, `ALTER FUNCTION ${fn} OWNER TO fluxora_queue must be between grants`);
    assert.ok(ownerIndex < membershipRevoke);

    const revokePublic = sql.indexOf(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
    assert.ok(revokePublic > ownerIndex);

    const grantUser = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${fn} TO CURRENT_USER`);
    assert.ok(grantUser > revokePublic);
    assert.ok(grantUser < membershipRevoke);
  }

  // Trigger guard for defaults and immutability
  assert.ok(sql.includes("fluxora_jobs_retry_limits_guard"));
  assert.ok(sql.includes("jobs_retry_limits_guard_trigger"));
  assert.ok(sql.includes("configured_max_attempts is immutable"));
  assert.ok(sql.includes("must match on new jobs"));
  assert.ok(sql.includes("new jobs must receive a valid, non-null configured limit"));
  assert.ok(
    sql.includes("GRANT EXECUTE ON FUNCTION public.fluxora_jobs_retry_limits_guard() TO CURRENT_USER"),
    "0024 must grant EXECUTE on trigger function to CURRENT_USER so trigger creation succeeds without PUBLIC EXECUTE",
  );

  // 5. FORCE ROW LEVEL SECURITY remains enabled
  assert.ok(sql.includes("ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY"));
  assert.ok(sql.includes("ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY"));

  // 6. Validation block
  assert.match(sql, /expected fluxora_queue/);
  assert.match(sql, /PUBLIC retains EXECUTE/);
  assert.match(sql, /has no EXECUTE grant/);
  assert.match(sql, /must not inherit fluxora_queue/);
  assert.match(sql, /Temporary migration policy jobs_migration_reconcile_0024 was not removed/);
  assert.match(sql, /jobs_attempt_count_le_max_attempts/);
  assert.match(sql, /jobs_configured_max_attempts_check/);
  assert.match(sql, /jobs_attempt_count_check/);
  assert.match(sql, /jobs_max_attempts_check/);
  assert.match(sql, /jobs_retry_limits_guard_trigger/);
  assert.ok(
    sql.includes("JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner"),
    "0024 validation SQL must qualify pg_catalog.pg_roles",
  );
});

test("historical 386-line candidate fixture verifies candidate structure and documented provenance", async () => {
  assert.equal(HISTORICAL_0023_CANDIDATE_PROVENANCE.lineCount, 386);
  assert.equal(HISTORICAL_0023_CANDIDATE_PROVENANCE.isProvenProvenance, false);
  assert.equal(HISTORICAL_0023_CANDIDATE_PROVENANCE.status, "historical_candidate");

  const rawSql = await loadHistorical0023CandidateSql();
  const lines = rawSql.split(/\r?\n/);
  assert.equal(
    lines.length,
    386,
    `Historical candidate fixture must have exactly 386 lines, but found ${lines.length}`,
  );

  const sql = executableSql(rawSql);
  assert.ok(sql.includes("GRANT fluxora_queue TO CURRENT_USER"));
  assert.ok(sql.includes("REVOKE fluxora_queue FROM CURRENT_USER"));
  assert.ok(sql.includes("WHERE j.attempt_count > j.max_attempts"));
  assert.ok(sql.includes("ADD CONSTRAINT jobs_attempt_count_le_max_attempts"));
  assert.ok(sql.includes("VALIDATE CONSTRAINT jobs_attempt_count_le_max_attempts"));
  assert.equal(
    sql.includes("configured_max_attempts"),
    false,
    "Historical 0023 candidate must not contain configured_max_attempts",
  );
  assert.equal(
    sql.includes("jobs_migration_reconcile_0023"),
    false,
    "Historical 0023 candidate from Fix 2A does not contain temporary policy jobs_migration_reconcile_0023",
  );
});

// Issue 2: Incremental migration 0021 test on a clean disposable database using a constrained, non-superuser role
export const DESTRUCTIVE_MIGRATION_OPT_IN_ENV =
  "FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS";

export const APPROVED_DESTRUCTIVE_QUEUE_TEST_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
] as const;

export function isApprovedDestructiveQueueTestHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase().trim();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "postgres"
  );
}

export function assertApprovedDestructiveQueueTestHost(
  rawUrl: string | URL,
): URL {
  const parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  if (!isApprovedDestructiveQueueTestHost(parsed.hostname)) {
    throw new Error(
      `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host "${parsed.hostname}". Destructive tests are restricted to approved disposable local/CI hosts: ${APPROVED_DESTRUCTIVE_QUEUE_TEST_HOSTS.join(", ")}. Refusing to connect or execute destructive operations.`,
    );
  }
  return parsed;
}

describe("destructive queue migration safety guards", () => {
  it("approves supported disposable local and CI hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]) {
      assert.equal(
        isApprovedDestructiveQueueTestHost(host),
        true,
        `Host "${host}" should be approved`,
      );
      const urlHost = host === "::1" ? "[::1]" : host;
      const url = `postgresql://postgres:postgres@${urlHost}:5432/test_db`;
      const parsed = assertApprovedDestructiveQueueTestHost(url);
      assert.equal(parsed instanceof URL, true);
    }
  });

  it("rejects unapproved remote hosts with a clear safety violation before any database mutation", () => {
    const unapprovedHosts = [
      "db.prod.fluxora.io",
      "postgres.render.com",
      "ep-cold-pond-12345.us-east-2.aws.neon.tech",
      "my-prod-cluster.rds.amazonaws.com",
      "192.168.1.100",
      "10.0.0.1",
      "remote-host.internal",
    ];

    for (const host of unapprovedHosts) {
      assert.equal(
        isApprovedDestructiveQueueTestHost(host),
        false,
        `Host "${host}" must not be approved`,
      );

      const dangerousUrl = `postgresql://postgres:postgres@${host}:5432/fluxora_queue_ci`;
      assert.throws(
        () => assertApprovedDestructiveQueueTestHost(dangerousUrl),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host/,
          );
          assert.match(err.message, new RegExp(host.replace(/\./g, "\\.")));
          assert.match(
            err.message,
            /Destructive tests are restricted to approved disposable local\/CI hosts/,
          );
          return true;
        },
      );
    }
  });

  it("verifies unapproved remote host throws before client connection or database mutation", () => {
    const dangerousUrl =
      "postgresql://postgres:postgres@prod-database.internal:5432/fluxora_queue_ci";

    let clientCreated = false;
    let queryExecuted = false;

    try {
      assertApprovedDestructiveQueueTestHost(dangerousUrl);
      // The following lines must NEVER be reached:
      clientCreated = true;
      queryExecuted = true;
    } catch (err: unknown) {
      assert.match(
        (err as Error).message,
        /Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host/,
      );
    }

    assert.equal(
      clientCreated,
      false,
      "Client must not be created for unapproved remote host",
    );
    assert.equal(
      queryExecuted,
      false,
      "No SQL query must execute against unapproved remote host",
    );
  });
});

const queueTestDatabaseUrl =
  process.env.FLUXORA_QUEUE_TEST_DATABASE_URL ??
  process.env.QUEUE_TEST_DATABASE_URL;

const hasQueueDatabase =
  typeof queueTestDatabaseUrl === "string" && queueTestDatabaseUrl.trim().length > 0;

const allowDestructive =
  process.env[DESTRUCTIVE_MIGRATION_OPT_IN_ENV] === "true";

const isCI = process.env.CI === "true" || process.env.CI === "1";

// In CI: never silently skip. The suite must execute and assert that required env vars are present.
// Locally: skip if queue test db or explicit destructive opt-in is absent, logging a clear diagnostic.
const shouldSkip = !isCI && (!hasQueueDatabase || !allowDestructive);

if (!isCI && shouldSkip) {
  const missing: string[] = [];
  if (!hasQueueDatabase) {
    missing.push("FLUXORA_QUEUE_TEST_DATABASE_URL");
  }
  if (!allowDestructive) {
    missing.push(`${DESTRUCTIVE_MIGRATION_OPT_IN_ENV}=true`);
  }
  console.info(
    `[job-queue-rls-migration.test] Skipping destructive incremental migration test: missing required configuration (${missing.join(", ")}).`,
  );
}

describe.skipIf(shouldSkip)("incremental non-superuser migration 0021 execution", () => {
  const INC_TEST_DB = "fluxora_inc_migration_test";
  const HIST_TEST_DB = "fluxora_historical_migration_test";
  const CLEAN_TEST_DB = "fluxora_clean_install_test";
  const TEST_MIGRATOR_ROLE = "fluxora_migrator_test";
  const TEST_MIGRATOR_PW = "fluxora_migrator_pw";

  let adminClient: pg.Client;
  let adminBaseUrl: URL;

  beforeAll(async () => {
    // 1. In CI or when running, verify required opt-in and test database configuration
    if (!hasQueueDatabase) {
      throw new Error(
        "CI configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL must be configured to execute migration 0021 integration test.",
      );
    }
    if (!allowDestructive) {
      throw new Error(
        `Destructive test safety violation: ${DESTRUCTIVE_MIGRATION_OPT_IN_ENV}=true is required to execute incremental migration 0021 verification. Refusing to perform destructive database or role operations without explicit opt-in.`,
      );
    }

    adminBaseUrl = assertApprovedDestructiveQueueTestHost(queueTestDatabaseUrl!);
    const queueDbName = adminBaseUrl.pathname.replace(/^\//, "");

    // 2. Database distinctness and dev safety assertions:
    // a. Keep test database distinct from both DATABASE_URL and FLUXORA_QUEUE_TEST_DATABASE_URL
    if (
      queueDbName === INC_TEST_DB ||
      queueDbName === HIST_TEST_DB ||
      queueDbName === CLEAN_TEST_DB
    ) {
      throw new Error(
        `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets a disposable test database name. The test database must be distinct from both DATABASE_URL and FLUXORA_QUEUE_TEST_DATABASE_URL.`,
      );
    }
    if (queueDbName === "fluxora_dev" || queueDbName.endsWith("_dev")) {
      throw new Error(
        `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets developer database "${queueDbName}". Destructive tests must never target developer databases.`,
      );
    }

    const defaultUrl = process.env.DATABASE_URL;
    if (defaultUrl) {
      const defaultParsed = new URL(defaultUrl);
      const defaultDbName = defaultParsed.pathname.replace(/^\//, "");
      if (
        defaultDbName === INC_TEST_DB ||
        defaultDbName === HIST_TEST_DB ||
        defaultDbName === CLEAN_TEST_DB
      ) {
        throw new Error(
          `Safety violation: DATABASE_URL targets disposable test database name. The test database must be distinct from DATABASE_URL.`,
        );
      }
      if (
        defaultParsed.hostname === adminBaseUrl.hostname &&
        defaultParsed.port === adminBaseUrl.port &&
        defaultDbName === queueDbName
      ) {
        throw new Error(
          `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets the same database as DATABASE_URL ("${queueDbName}"). Aborting.`,
        );
      }
    }

    // Connect to admin 'postgres' database
    const postgresUrl = new URL(adminBaseUrl.toString());
    postgresUrl.pathname = "/postgres";
    adminClient = new pg.Client({ connectionString: postgresUrl.toString() });
    await adminClient.connect();

    // Clean previous test database / role if any
    await adminClient.query(`DROP DATABASE IF EXISTS ${INC_TEST_DB}`);
    await adminClient.query(`DROP DATABASE IF EXISTS ${HIST_TEST_DB}`);
    await adminClient.query(`DROP DATABASE IF EXISTS ${CLEAN_TEST_DB}`);
    await adminClient.query(`DROP ROLE IF EXISTS ${TEST_MIGRATOR_ROLE}`);

    // Create fresh disposable database
    await adminClient.query(`CREATE DATABASE ${INC_TEST_DB}`);

    // Connect to INC_TEST_DB as admin to apply migrations 0001 through 0020
    const incAdminUrl = new URL(adminBaseUrl.toString());
    incAdminUrl.pathname = `/${INC_TEST_DB}`;
    const incAdminPool = new pg.Pool({ connectionString: incAdminUrl.toString() });

    try {
      const migrationsDir = path.join(
        fileURLToPath(new URL("../../migrations/", import.meta.url)),
      );
      const entries = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql") && name <= "0020_job_queue_least_privilege_rls.sql")
        .sort();

      const incClient = await incAdminPool.connect();
      try {
        await incClient.query("BEGIN");
        await incClient.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `);

        for (const fileName of entries) {
          const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
          await incClient.query(sql);
          await incClient.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [fileName]);
        }
        await incClient.query("COMMIT");
      } catch (err) {
        await incClient.query("ROLLBACK");
        throw err;
      } finally {
        incClient.release();
      }

      // Create the constrained, non-superuser migration role configured with
      // the exact permissions of the deployment migration role on Render:
      // - NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, but CREATEROLE
      // - Owner of schema public and application tables (as it created them in prior migrations)
      // - ADMIN OPTION on fluxora_queue (as it created fluxora_queue in migration 0020)
      await incAdminPool.query(`
        CREATE ROLE ${TEST_MIGRATOR_ROLE}
          LOGIN
          PASSWORD '${TEST_MIGRATOR_PW}'
          NOSUPERUSER
          NOBYPASSRLS
          NOCREATEDB
          CREATEROLE;

        ALTER SCHEMA public OWNER TO ${TEST_MIGRATOR_ROLE};
        GRANT ALL ON SCHEMA public TO ${TEST_MIGRATOR_ROLE} WITH GRANT OPTION;
        ALTER TABLE public.organizations OWNER TO ${TEST_MIGRATOR_ROLE};
        ALTER TABLE public.jobs OWNER TO ${TEST_MIGRATOR_ROLE};
        ALTER TABLE public.schema_migrations OWNER TO ${TEST_MIGRATOR_ROLE};
        GRANT fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
        GRANT EXECUTE ON FUNCTION public.fluxora_create_organization(text, plan_tier, bigint) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO ${TEST_MIGRATOR_ROLE};
      `);
    } finally {
      await incAdminPool.end();
    }
  });

  afterAll(async () => {
    if (adminClient) {
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS ${INC_TEST_DB}`);
        await adminClient.query(`DROP DATABASE IF EXISTS ${HIST_TEST_DB}`);
        await adminClient.query(`DROP DATABASE IF EXISTS ${CLEAN_TEST_DB}`);
        await adminClient.query(`DROP ROLE IF EXISTS ${TEST_MIGRATOR_ROLE}`);
      } finally {
        await adminClient.end();
      }
    }
  });

  it("applies migration 0021 as a constrained, non-superuser migration role", async () => {
    const migratorUrl = new URL(adminBaseUrl.toString());
    migratorUrl.pathname = `/${INC_TEST_DB}`;
    migratorUrl.username = TEST_MIGRATOR_ROLE;
    migratorUrl.password = TEST_MIGRATOR_PW;

    const migratorClient = new pg.Client({ connectionString: migratorUrl.toString() });
    await migratorClient.connect();

    try {
      // 1. Verify migrator is non-superuser and non-BYPASSRLS
      const roleCheck = await migratorClient.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(roleCheck.rows[0]?.rolsuper, false, "Migration role must not be superuser");
      assert.equal(roleCheck.rows[0]?.rolbypassrls, false, "Migration role must not bypass RLS");

      // 2. Read and apply migration 0021 as the constrained non-superuser role
      const sql0021 = await readFile(migration0021Path, "utf8");
      await migratorClient.query("BEGIN");
      await migratorClient.query(sql0021);
      await migratorClient.query(
        "INSERT INTO schema_migrations (name) VALUES ('0021_job_queue_hardening.sql')",
      );
      await migratorClient.query("COMMIT");

      // 3. Verify old function signature is dropped
      const oldFuncCheck = await migratorClient.query(
        `SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'fluxora_retry_failed_job' AND pronargs = 2`,
      );
      assert.equal(oldFuncCheck.rows.length, 0, "Old 2-param retry function must be dropped");

      // 4. Verify new function signature exists and is owned by fluxora_queue
      const newFuncCheck = await migratorClient.query<{ owner_name: string; prosecdef: boolean }>(
        `
          SELECT r.rolname AS owner_name, p.prosecdef
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'public.fluxora_retry_failed_job(uuid, text, integer, text)'::regprocedure
        `,
      );
      assert.equal(newFuncCheck.rows.length, 1, "New 4-param retry function must exist");
      assert.equal(newFuncCheck.rows[0]?.owner_name, "fluxora_queue");
      assert.equal(newFuncCheck.rows[0]?.prosecdef, true);

      // 5. Verify PUBLIC does NOT have EXECUTE, and migration role DOES have EXECUTE
      const aclCheck = await migratorClient.query<{ public_exec: boolean; role_exec: boolean }>(
        `
          SELECT
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
              FROM pg_catalog.aclexplode(p.proacl) acl
            ), false) AS public_exec,
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1))
              FROM pg_catalog.aclexplode(p.proacl) acl
            ), false) AS role_exec
          FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.fluxora_retry_failed_job(uuid, text, integer, text)'::regprocedure
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(aclCheck.rows[0]?.public_exec, false, "PUBLIC must not have EXECUTE");
      assert.equal(aclCheck.rows[0]?.role_exec, true, "Migration role must have EXECUTE grant");

      // 6. Verify migration role does NOT retain inheriting membership in fluxora_queue
      const membershipCheck = await migratorClient.query<{ is_member: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_auth_members m
            JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
            JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
            WHERE gr.rolname = 'fluxora_queue'
              AND mr.rolname = $1
              AND (
                CASE
                  WHEN current_setting('server_version_num')::int >= 160000
                    THEN (m.inherit_option OR m.set_option)
                  ELSE true
                END
              )
          ) AS is_member
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(membershipCheck.rows[0]?.is_member, false, "Migration role must not retain inheriting membership in fluxora_queue");

      // 7. Verify column-level privileges on public.jobs
      const statusPrivCheck = await migratorClient.query<{ has_priv: boolean }>(
        `SELECT has_column_privilege('fluxora_queue', 'public.jobs', 'status', 'UPDATE') AS has_priv`,
      );
      assert.equal(statusPrivCheck.rows[0]?.has_priv, true, "fluxora_queue must have UPDATE on status");

      const idPrivCheck = await migratorClient.query<{ has_priv: boolean }>(
        `SELECT has_column_privilege('fluxora_queue', 'public.jobs', 'id', 'UPDATE') AS has_priv`,
      );
      assert.equal(idPrivCheck.rows[0]?.has_priv, false, "fluxora_queue must NOT have UPDATE on id");

      // 8. Read and apply migration 0022 as the constrained non-superuser role
      const sql0022 = await readFile(migration0022Path, "utf8");
      await migratorClient.query("BEGIN");
      await migratorClient.query(sql0022);
      await migratorClient.query(
        "INSERT INTO schema_migrations (name) VALUES ('0022_job_queue_crash_recovery_retry_limit.sql')",
      );
      await migratorClient.query("COMMIT");

      // 9. Verify fluxora_claim_next_job is updated, owned by fluxora_queue, prosecdef, and safe search_path
      const claimFuncCheck = await migratorClient.query<{
        owner_name: string;
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(
        `
          SELECT r.rolname AS owner_name, p.prosecdef, p.proconfig
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'public.fluxora_claim_next_job(text, integer)'::regprocedure
        `,
      );
      assert.equal(claimFuncCheck.rows.length, 1, "fluxora_claim_next_job must exist after 0022");
      assert.equal(claimFuncCheck.rows[0]?.owner_name, "fluxora_queue");
      assert.equal(claimFuncCheck.rows[0]?.prosecdef, true);
      assert.ok(
        claimFuncCheck.rows[0]?.proconfig?.some(
          (cfg) => cfg === "search_path=pg_catalog, public, pg_temp",
        ),
        "fluxora_claim_next_job must have pinned search_path",
      );

      // 10. Verify PUBLIC does NOT have EXECUTE, and migration role DOES have EXECUTE on fluxora_claim_next_job
      const claimAclCheck = await migratorClient.query<{ public_exec: boolean; role_exec: boolean }>(
        `
          SELECT
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
              FROM pg_catalog.aclexplode(p.proacl) acl
            ), false) AS public_exec,
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1))
              FROM pg_catalog.aclexplode(p.proacl) acl
            ), false) AS role_exec
          FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.fluxora_claim_next_job(text, integer)'::regprocedure
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(claimAclCheck.rows[0]?.public_exec, false, "PUBLIC must not have EXECUTE on claim function");
      assert.equal(claimAclCheck.rows[0]?.role_exec, true, "Migration role must have EXECUTE on claim function");

      // 11. Verify migration role still does not retain inheriting membership in fluxora_queue after 0022
      const post0022MembershipCheck = await migratorClient.query<{ is_member: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_auth_members m
            JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
            JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
            WHERE gr.rolname = 'fluxora_queue'
              AND mr.rolname = $1
              AND (
                CASE
                  WHEN current_setting('server_version_num')::int >= 160000
                    THEN (m.inherit_option OR m.set_option)
                  ELSE true
                END
              )
          ) AS is_member
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(post0022MembershipCheck.rows[0]?.is_member, false, "Migration role must not retain inheriting membership in fluxora_queue after 0022");

      // 12. Create test fixtures covering all 5 legacy over-limit cases across two distinct organizations
      const org1Res = await migratorClient.query<{ id: string }>(
        `SELECT fluxora_create_organization('inc-mig-org-1') AS id`,
      );
      const org1Id = org1Res.rows[0]?.id;
      assert.ok(org1Id, "Organization 1 must be created for legacy row tests");

      const org2Res = await migratorClient.query<{ id: string }>(
        `SELECT fluxora_create_organization('inc-mig-org-2') AS id`,
      );
      const org2Id = org2Res.rows[0]?.id;
      assert.ok(org2Id, "Organization 2 must be created for legacy row tests");
      assert.notEqual(org1Id, org2Id, "Test organizations must be distinct");

      // Populate Org 1 fixtures under Org 1 tenant context:
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org1Id],
      );

      // Case 1: Over-limit pending row (Org 1)
      const legacyPendingRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'legacy-pending-1', 'pending', 4, 2)
         RETURNING id`,
        [org1Id],
      );
      const legacyPendingId = legacyPendingRes.rows[0]?.id;

      // Case 2: Over-limit running row with expired lease (Org 1)
      const legacyExpiredRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, locked_by, lease_expires_at)
         VALUES ($1, 'repo.ingest', 'legacy-expired-1', 'running', 5, 3, 'crashed-worker', pg_catalog.now() - interval '10 seconds')
         RETURNING id`,
        [org1Id],
      );
      const legacyExpiredId = legacyExpiredRes.rows[0]?.id;

      // Case 3: Over-limit running row with active (unexpired) lease (Org 1)
      const legacyActiveRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, locked_by, lease_expires_at)
         VALUES ($1, 'repo.ingest', 'legacy-active-1', 'running', 6, 2, 'active-worker-99', pg_catalog.now() + interval '300 seconds')
         RETURNING id`,
        [org1Id],
      );
      const legacyActiveId = legacyActiveRes.rows[0]?.id;

      // Case 6: Legacy row with attempts remaining (attempt_count < max_attempts) (Org 1)
      const legacyUnderLimitRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'legacy-under-limit-1', 'pending', 1, 3)
         RETURNING id`,
        [org1Id],
      );
      const legacyUnderLimitId = legacyUnderLimitRes.rows[0]?.id;

      // Switch to tenant context for Org 2:
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org2Id],
      );

      // Case 4: Over-limit completed record (Org 2)
      const legacyCompletedRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, completed_at)
         VALUES ($1, 'repo.ingest', 'legacy-completed-2', 'completed', 4, 3, pg_catalog.now())
         RETURNING id`,
        [org2Id],
      );
      const legacyCompletedId = legacyCompletedRes.rows[0]?.id;

      // Case 5a: Over-limit failed record (Org 2)
      const legacyFailedRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, failed_at, last_error)
         VALUES ($1, 'repo.ingest', 'legacy-failed-2', 'failed', 5, 2, pg_catalog.now(), 'legacy failure')
         RETURNING id`,
        [org2Id],
      );
      const legacyFailedId = legacyFailedRes.rows[0]?.id;

      // Case 5b: Over-limit dead-letter record (Org 2)
      const legacyDeadLetterRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, failed_at, last_error)
         VALUES ($1, 'repo.ingest', 'legacy-deadletter-2', 'dead_letter', 7, 3, pg_catalog.now(), 'already dead')
         RETURNING id`,
        [org2Id],
      );
      const legacyDeadLetterId = legacyDeadLetterRes.rows[0]?.id;

      // Additional pending over-limit row (Org 2)
      const legacyPendingOrg2Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'legacy-pending-2', 'pending', 3, 1)
         RETURNING id`,
        [org2Id],
      );
      const legacyPendingOrg2Id = legacyPendingOrg2Res.rows[0]?.id;

      // Remove tenant context before executing migration 0023.
      // Reproduce production migration context where the migration runner has no tenant context.
      await migratorClient.query("RESET app.current_org_id");

      const clearedOrgCheck = await migratorClient.query<{ current_org: string | null }>(
        "SELECT fluxora_current_org_id() AS current_org",
      );
      assert.equal(
        clearedOrgCheck.rows[0]?.current_org,
        null,
        "Tenant context must be strictly cleared before running migration 0023",
      );

      // Verify that under FORCE ROW LEVEL SECURITY with no tenant context,
      // the migration role sees 0 rows before migration 0023 runs.
      const preMigVisibleCount = await migratorClient.query<{ count: string }>(
        "SELECT count(*) FROM public.jobs",
      );
      assert.equal(
        Number(preMigVisibleCount.rows[0]?.count),
        0,
        "Migration role must see 0 rows without tenant context prior to migration 0023",
      );

      // 13. Read and apply migration 0023 as the constrained non-superuser role
      const sql0023 = await readFile(migration0023Path, "utf8");
      await migratorClient.query("BEGIN");
      await migratorClient.query(sql0023);
      await migratorClient.query(
        "INSERT INTO schema_migrations (name) VALUES ('0023_job_queue_attempt_count_invariant.sql')",
      );
      await migratorClient.query("COMMIT");

      // 14. Verify migration role cannot retain temporary global RLS policy
      const tempPolicyCheck = await migratorClient.query<{ policyname: string }>(
        `SELECT policyname FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'jobs' AND policyname = 'jobs_migration_reconcile_0023'`,
      );
      assert.equal(
        tempPolicyCheck.rows.length,
        0,
        "Temporary migration policy jobs_migration_reconcile_0023 must not exist after migration commit",
      );

      // Verify migration role without tenant context still sees 0 rows (no bypass retained)
      const postMigVisibleCount = await migratorClient.query<{ count: string }>(
        "SELECT count(*) FROM public.jobs",
      );
      assert.equal(
        Number(postMigVisibleCount.rows[0]?.count),
        0,
        "Migration role must not retain global visibility after migration completes",
      );

      // 15. Verify reconciliation results across both organizations for migration 0023
      // A. Verify Org 1 reconciliation under Org 1 tenant context:
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org1Id],
      );

      // Org 1 Case 1: Pending was transitioned to dead_letter, max_attempts aligned to attempt_count
      const pendingRow = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          locked_by: string | null;
          failed_at: Date | null;
          last_error: string | null;
        }>(`SELECT status, attempt_count, max_attempts, locked_by, failed_at, last_error FROM public.jobs WHERE id = $1`, [legacyPendingId])
      ).rows[0];
      assert.equal(pendingRow?.status, "dead_letter");
      assert.equal(pendingRow?.attempt_count, 4, "attempt_count must not be decremented");
      assert.equal(pendingRow?.max_attempts, 4, "operational max_attempts must align with attempt_count");
      assert.equal(pendingRow?.locked_by, null);
      assert.ok(pendingRow?.failed_at !== null);
      assert.equal(pendingRow?.last_error, "Job exceeded retry limit while pending");

      // Org 1 Case 2: Expired running transitioned to dead_letter, max_attempts aligned
      const expiredRow = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          locked_by: string | null;
          failed_at: Date | null;
          last_error: string | null;
        }>(`SELECT status, attempt_count, max_attempts, locked_by, failed_at, last_error FROM public.jobs WHERE id = $1`, [legacyExpiredId])
      ).rows[0];
      assert.equal(expiredRow?.status, "dead_letter");
      assert.equal(expiredRow?.attempt_count, 5);
      assert.equal(expiredRow?.max_attempts, 5);
      assert.equal(expiredRow?.locked_by, null);
      assert.ok(expiredRow?.failed_at !== null);
      assert.equal(expiredRow?.last_error, "Job lease expired after retry limit reached");

      // Org 1 Case 3: Active running PRESERVED active lease, max_attempts aligned
      const activeRow = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          locked_by: string | null;
          lease_expires_at: Date | null;
        }>(`SELECT status, attempt_count, max_attempts, locked_by, lease_expires_at FROM public.jobs WHERE id = $1`, [legacyActiveId])
      ).rows[0];
      assert.equal(activeRow?.status, "running", "Active lease must NOT be dead-lettered");
      assert.equal(activeRow?.locked_by, "active-worker-99", "Active worker ownership must be preserved");
      assert.equal(activeRow?.attempt_count, 6);
      assert.equal(activeRow?.max_attempts, 6);
      assert.ok(activeRow?.lease_expires_at !== null && new Date(activeRow.lease_expires_at) > new Date());

      // B. Verify Org 2 reconciliation under Org 2 tenant context:
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org2Id],
      );

      // Org 2 Case 4: Completed preserved status and metrics, max_attempts aligned
      const completedRow = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
        }>(`SELECT status, attempt_count, max_attempts FROM public.jobs WHERE id = $1`, [legacyCompletedId])
      ).rows[0];
      assert.equal(completedRow?.status, "completed");
      assert.equal(completedRow?.attempt_count, 4);
      assert.equal(completedRow?.max_attempts, 4);

      // Org 2 Case 5a: Failed transitioned to dead_letter, dead_letter preserved
      const failedRow = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          last_error: string | null;
        }>(`SELECT status, attempt_count, max_attempts, last_error FROM public.jobs WHERE id = $1`, [legacyFailedId])
      ).rows[0];
      assert.equal(failedRow?.status, "dead_letter");
      assert.equal(failedRow?.attempt_count, 5);
      assert.equal(failedRow?.max_attempts, 5);
      assert.equal(failedRow?.last_error, "legacy failure");

      // Org 2 Case 5b: Dead-letter preserved
      const deadLetterRow = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
        }>(`SELECT status, attempt_count, max_attempts FROM public.jobs WHERE id = $1`, [legacyDeadLetterId])
      ).rows[0];
      assert.equal(deadLetterRow?.status, "dead_letter");
      assert.equal(deadLetterRow?.attempt_count, 7);
      assert.equal(deadLetterRow?.max_attempts, 7);

      // Org 2 Pending row: transitioned to dead_letter, max_attempts aligned
      const pendingOrg2Row = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
        }>(`SELECT status, attempt_count, max_attempts FROM public.jobs WHERE id = $1`, [legacyPendingOrg2Id])
      ).rows[0];
      assert.equal(pendingOrg2Row?.status, "dead_letter");
      assert.equal(pendingOrg2Row?.attempt_count, 3);
      assert.equal(pendingOrg2Row?.max_attempts, 3);

      // Reset tenant context before verifying constraints
      await migratorClient.query("RESET app.current_org_id");

      // Verify configured_max_attempts does NOT exist yet in 0023 schema
      const colCheck0023 = await migratorClient.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'configured_max_attempts'`,
      );
      assert.equal(colCheck0023.rows.length, 0, "configured_max_attempts must NOT exist in schema after 0023");

      // 16. Verify CHECK constraint jobs_attempt_count_le_max_attempts exists and is validated in 0023
      const constraintCheck = await migratorClient.query<{
        conname: string;
        contype: string;
        convalidated: boolean;
      }>(
        `SELECT conname, contype, convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_attempt_count_le_max_attempts'`,
      );
      assert.equal(constraintCheck.rows.length, 1, "Constraint jobs_attempt_count_le_max_attempts must exist");
      assert.equal(constraintCheck.rows[0]?.contype, "c", "Must be a CHECK constraint");
      assert.equal(constraintCheck.rows[0]?.convalidated, true, "Must be fully validated");

      const cfgConstraintCheck0023 = await migratorClient.query<{ conname: string }>(
        `SELECT conname FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_configured_max_attempts_check'`,
      );
      assert.equal(cfgConstraintCheck0023.rows.length, 0, "Constraint jobs_configured_max_attempts_check must NOT exist after 0023");

      // 17. Verify constraint prevents future invalid writes under 0023
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org1Id],
      );

      await assert.rejects(
        () =>
          migratorClient.query(
            `INSERT INTO public.jobs (organization_id, type, idempotency_key, attempt_count, max_attempts)
             VALUES ($1, 'test.invalid', 'inv-1', 4, 3)`,
            [org1Id],
          ),
        (err: Error) => {
          assert.match(err.message, /jobs_attempt_count_le_max_attempts/);
          return true;
        },
      );

      await assert.rejects(
        () =>
          migratorClient.query(
            `UPDATE public.jobs SET attempt_count = 10 WHERE id = $1`,
            [legacyActiveId],
          ),
        (err: Error) => {
          assert.match(err.message, /jobs_attempt_count_le_max_attempts/);
          return true;
        },
      );

      await migratorClient.query("RESET app.current_org_id");

      // 18. Verify SQL claim parameter validation inside PostgreSQL after 0023
      for (const invalidWorker of ["", "   ", "\t  \n"]) {
        await assert.rejects(
          () => migratorClient.query(`SELECT * FROM public.fluxora_claim_next_job($1, 60)`, [invalidWorker]),
          (err: Error) => {
            assert.match(err.message, /p_worker_id must be a non-empty, non-whitespace string/);
            return true;
          },
        );
      }
      await assert.rejects(
        () => migratorClient.query(`SELECT * FROM public.fluxora_claim_next_job(NULL, 60)`),
        (err: Error) => {
          assert.match(err.message, /p_worker_id must be a non-empty, non-whitespace string/);
          return true;
        },
      );

      for (const invalidLease of [0, -1, -60]) {
        await assert.rejects(
          () => migratorClient.query(`SELECT * FROM public.fluxora_claim_next_job('valid-worker', $1)`, [invalidLease]),
          (err: Error) => {
            assert.match(err.message, /p_lease_seconds must be a positive integer/);
            return true;
          },
        );
      }
      await assert.rejects(
        () => migratorClient.query(`SELECT * FROM public.fluxora_claim_next_job('valid-worker', NULL)`),
        (err: Error) => {
          assert.match(err.message, /p_lease_seconds must be a positive integer/);
          return true;
        },
      );

      // 19. Verify function ownership, prosecdef, pinned search_path, execute grants, and no inherited membership after 0023
      const claim0023Check = await migratorClient.query<{
        owner_name: string;
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(
        `
          SELECT r.rolname AS owner_name, p.prosecdef, p.proconfig
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'public.fluxora_claim_next_job(text, integer)'::regprocedure
        `,
      );
      assert.equal(claim0023Check.rows[0]?.owner_name, "fluxora_queue");
      assert.equal(claim0023Check.rows[0]?.prosecdef, true);
      assert.ok(
        claim0023Check.rows[0]?.proconfig?.some(
          (cfg) => cfg === "search_path=pg_catalog, public, pg_temp",
        ),
      );

      const claim0023Acl = await migratorClient.query<{ public_exec: boolean; role_exec: boolean }>(
        `
          SELECT
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
              FROM pg_catalog.aclexplode(p.proacl) acl
            ), false) AS public_exec,
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1))
              FROM pg_catalog.aclexplode(p.proacl) acl
            ), false) AS role_exec
          FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.fluxora_claim_next_job(text, integer)'::regprocedure
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(claim0023Acl.rows[0]?.public_exec, false, "PUBLIC must not have EXECUTE");
      assert.equal(claim0023Acl.rows[0]?.role_exec, true, "Migration role must have EXECUTE");

      const post0023MembershipCheck = await migratorClient.query<{ is_member: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_auth_members m
            JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
            JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
            WHERE gr.rolname = 'fluxora_queue'
              AND mr.rolname = $1
              AND (
                CASE
                  WHEN current_setting('server_version_num')::int >= 160000
                    THEN (m.inherit_option OR m.set_option)
                  ELSE true
                END
              )
          ) AS is_member
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(post0023MembershipCheck.rows[0]?.is_member, false, "Migration role must not retain inheriting membership in fluxora_queue after 0023");

      // 20. Read and apply forward-only migration 0024 as the constrained non-superuser role
      // Reproduce production migration context where the migration runner has no tenant context.
      await migratorClient.query("RESET app.current_org_id");

      const clearedOrgCheck0024 = await migratorClient.query<{ current_org: string | null }>(
        "SELECT fluxora_current_org_id() AS current_org",
      );
      assert.equal(
        clearedOrgCheck0024.rows[0]?.current_org,
        null,
        "Tenant context must be strictly cleared before running migration 0024",
      );

      const sql0024 = await readFile(migration0024Path, "utf8");
      await migratorClient.query("BEGIN");
      await migratorClient.query(sql0024);
      await migratorClient.query(
        "INSERT INTO schema_migrations (name) VALUES ('0024_job_queue_configured_retry_limit.sql')",
      );
      await migratorClient.query("COMMIT");

      // 21. Verify temporary migration policy jobs_migration_reconcile_0024 is dropped
      const tempPolicy0024Check = await migratorClient.query<{ policyname: string }>(
        `SELECT policyname FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'jobs' AND policyname = 'jobs_migration_reconcile_0024'`,
      );
      assert.equal(
        tempPolicy0024Check.rows.length,
        0,
        "Temporary migration policy jobs_migration_reconcile_0024 must not exist after migration commit",
      );

      // Verify migration role without tenant context still sees 0 rows (no bypass retained)
      const post0024VisibleCount = await migratorClient.query<{ count: string }>(
        "SELECT count(*) FROM public.jobs",
      );
      assert.equal(
        Number(post0024VisibleCount.rows[0]?.count),
        0,
        "Migration role must not retain global visibility after migration 0024 completes",
      );

      // 22. Verify 0024 reconciliation results across both organizations:
      // Honest legacy handling:
      // - For legacy rows where attempt_count = max_attempts (including those elevated in 0023),
      //   configured_max_attempts is set to NULL (unknown historical limit).
      // - For legacy rows where attempt_count < max_attempts, configured_max_attempts is preserved as max_attempts.
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org1Id],
      );

      const pendingRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyPendingId])
      ).rows[0];
      assert.equal(pendingRow0024?.status, "dead_letter");
      assert.equal(pendingRow0024?.attempt_count, 4);
      assert.equal(pendingRow0024?.max_attempts, 4);
      assert.equal(pendingRow0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for rows where attempt_count = max_attempts");

      const expiredRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyExpiredId])
      ).rows[0];
      assert.equal(expiredRow0024?.status, "dead_letter");
      assert.equal(expiredRow0024?.attempt_count, 5);
      assert.equal(expiredRow0024?.max_attempts, 5);
      assert.equal(expiredRow0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for rows where attempt_count = max_attempts");

      const activeRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
          locked_by: string | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts, locked_by FROM public.jobs WHERE id = $1`, [legacyActiveId])
      ).rows[0];
      assert.equal(activeRow0024?.status, "running", "Active lease must remain running after 0024");
      assert.equal(activeRow0024?.locked_by, "active-worker-99");
      assert.equal(activeRow0024?.attempt_count, 6);
      assert.equal(activeRow0024?.max_attempts, 6);
      assert.equal(activeRow0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for rows where attempt_count = max_attempts");

      const underLimitRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyUnderLimitId])
      ).rows[0];
      assert.equal(underLimitRow0024?.status, "pending");
      assert.equal(underLimitRow0024?.attempt_count, 1);
      assert.equal(underLimitRow0024?.max_attempts, 3);
      assert.equal(underLimitRow0024?.configured_max_attempts, 3, "0024 preserves available limit as configured_max_attempts when attempt_count < max_attempts");

      // Org 2 verification under Org 2 context
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org2Id],
      );

      const completedRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyCompletedId])
      ).rows[0];
      assert.equal(completedRow0024?.status, "completed");
      assert.equal(completedRow0024?.attempt_count, 4);
      assert.equal(completedRow0024?.max_attempts, 4);
      assert.equal(completedRow0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for completed legacy row at limit");

      const failedRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyFailedId])
      ).rows[0];
      assert.equal(failedRow0024?.status, "dead_letter");
      assert.equal(failedRow0024?.attempt_count, 5);
      assert.equal(failedRow0024?.max_attempts, 5);
      assert.equal(failedRow0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for failed legacy row at limit");

      const deadLetterRow0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyDeadLetterId])
      ).rows[0];
      assert.equal(deadLetterRow0024?.status, "dead_letter");
      assert.equal(deadLetterRow0024?.attempt_count, 7);
      assert.equal(deadLetterRow0024?.max_attempts, 7);
      assert.equal(deadLetterRow0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for dead_letter legacy row at limit");

      const pendingOrg2Row0024 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [legacyPendingOrg2Id])
      ).rows[0];
      assert.equal(pendingOrg2Row0024?.status, "dead_letter");
      assert.equal(pendingOrg2Row0024?.attempt_count, 3);
      assert.equal(pendingOrg2Row0024?.max_attempts, 3);
      assert.equal(pendingOrg2Row0024?.configured_max_attempts, null, "0024 sets configured_max_attempts to NULL for pending legacy row at limit");

      await migratorClient.query("RESET app.current_org_id");

      // 23. Verify CHECK constraints jobs_attempt_count_le_max_attempts and jobs_configured_max_attempts_check exist and are validated
      const constraintCheck0024 = await migratorClient.query<{
        conname: string;
        contype: string;
        convalidated: boolean;
      }>(
        `SELECT conname, contype, convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_attempt_count_le_max_attempts'`,
      );
      assert.equal(constraintCheck0024.rows.length, 1);
      assert.equal(constraintCheck0024.rows[0]?.convalidated, true);

      const cfgConstraintCheck0024 = await migratorClient.query<{
        conname: string;
        contype: string;
        convalidated: boolean;
      }>(
        `SELECT conname, contype, convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_configured_max_attempts_check'`,
      );
      assert.equal(cfgConstraintCheck0024.rows.length, 1);
      assert.equal(cfgConstraintCheck0024.rows[0]?.contype, "c");
      assert.equal(cfgConstraintCheck0024.rows[0]?.convalidated, true);

      // Verify trigger jobs_retry_limits_guard_trigger exists
      const trigCheck0024 = await migratorClient.query<{ tgname: string }>(
        `SELECT tgname FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_retry_limits_guard_trigger'`,
      );
      assert.equal(trigCheck0024.rows.length, 1, "jobs_retry_limits_guard_trigger must exist after 0024");

      // 24. Verify active running row completes cleanly via fluxora_complete_job returning configured limit (Fix 2E)
      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [org1Id],
      );

      const completeRes = await migratorClient.query<{
        status: string;
        attempt_count: number;
        max_attempts: number;
        configured_max_attempts: number | null;
      }>(
        `SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.fluxora_complete_job($1, 'active-worker-99')`,
        [legacyActiveId],
      );
      assert.equal(completeRes.rows.length, 1);
      assert.equal(completeRes.rows[0]?.status, "completed");
      assert.equal(completeRes.rows[0]?.attempt_count, 6);
      assert.equal(completeRes.rows[0]?.max_attempts, 6);
      assert.equal(completeRes.rows[0]?.configured_max_attempts, null, "fluxora_complete_job must return null configured_max_attempts for legacy row with unknown limit");
      assert.ok(
        (completeRes.rows[0]?.attempt_count ?? 0) <= (completeRes.rows[0]?.max_attempts ?? 0),
        "Completed job must satisfy 0 <= attempt_count <= max_attempts",
      );

      // 25. Direct SQL insert and immutability trigger guard verification (Fix 2E)
      // Single parameter insert: only max_attempts -> sets configured_max_attempts = 7
      const singleMaxRes = await migratorClient.query<{ max_attempts: number; configured_max_attempts: number }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts)
         VALUES ($1, 'repo.ingest', 'direct-sql-single-max', 7)
         RETURNING max_attempts, configured_max_attempts`,
        [org1Id],
      );
      assert.equal(singleMaxRes.rows[0]?.max_attempts, 7);
      assert.equal(singleMaxRes.rows[0]?.configured_max_attempts, 7);

      // Single parameter insert: only configured_max_attempts -> sets max_attempts = 4
      const singleCfgRes = await migratorClient.query<{ max_attempts: number; configured_max_attempts: number }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, configured_max_attempts)
         VALUES ($1, 'repo.ingest', 'direct-sql-single-cfg', 4)
         RETURNING max_attempts, configured_max_attempts`,
        [org1Id],
      );
      assert.equal(singleCfgRes.rows[0]?.max_attempts, 4);
      assert.equal(singleCfgRes.rows[0]?.configured_max_attempts, 4);

      // Default insert: neither supplied -> sets both to 3
      const defaultInsRes = await migratorClient.query<{ max_attempts: number; configured_max_attempts: number }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key)
         VALUES ($1, 'repo.ingest', 'direct-sql-default')
         RETURNING max_attempts, configured_max_attempts`,
        [org1Id],
      );
      assert.equal(defaultInsRes.rows[0]?.max_attempts, 3);
      assert.equal(defaultInsRes.rows[0]?.configured_max_attempts, 3);

      // Conflicting insert: max_attempts != configured_max_attempts -> rejected by trigger
      await assert.rejects(
        () =>
          migratorClient.query(
            `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
             VALUES ($1, 'repo.ingest', 'direct-sql-conflict', 5, 2)`,
            [org1Id],
          ),
        (err: Error) => {
          assert.match(err.message, /must match on new jobs/);
          return true;
        },
      );

      // Immutability on UPDATE: attempting to mutate configured_max_attempts on unknown historical limit (NULL) -> rejected by trigger
      await assert.rejects(
        () =>
          migratorClient.query(
            `UPDATE public.jobs SET configured_max_attempts = 10 WHERE id = $1`,
            [legacyActiveId],
          ),
        (err: Error) => {
          assert.match(err.message, /configured_max_attempts is immutable/);
          return true;
        },
      );

      // Immutability on UPDATE: attempting to mutate configured_max_attempts on known limit -> rejected by trigger
      await assert.rejects(
        () =>
          migratorClient.query(
            `UPDATE public.jobs SET configured_max_attempts = 10 WHERE id = $1`,
            [legacyUnderLimitId],
          ),
        (err: Error) => {
          assert.match(err.message, /configured_max_attempts is immutable/);
          return true;
        },
      );

      // Check constraint rejects invalid configured_max_attempts <= 0
      await assert.rejects(
        () =>
          migratorClient.query(
            `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
             VALUES ($1, 'repo.ingest', 'invalid-cfg-zero', 3, 0)`,
            [org1Id],
          ),
        (err: Error) => {
          assert.match(err.message, /jobs_configured_max_attempts_check/);
          return true;
        },
      );

      // Normal enqueue operations store requested configured limit correctly
      const normalEnqueueRes = await migratorClient.query<{
        max_attempts: number;
        configured_max_attempts: number;
        attempt_count: number;
      }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
         VALUES ($1, 'repo.ingest', 'normal-cfg-verify-1', 5, 5)
         RETURNING max_attempts, configured_max_attempts, attempt_count`,
        [org1Id],
      );
      assert.equal(normalEnqueueRes.rows[0]?.max_attempts, 5);
      assert.equal(normalEnqueueRes.rows[0]?.configured_max_attempts, 5);
      assert.equal(normalEnqueueRes.rows[0]?.attempt_count, 0);

      await migratorClient.query("RESET app.current_org_id");

      // 26. Verify function ownership, prosecdef, pinned search_path, and execute grants across all 4 functions after 0024
      for (const fn of QUEUE_FUNCTIONS_0024) {
        const fnCheck = await migratorClient.query<{
          owner_name: string;
          prosecdef: boolean;
          proconfig: string[] | null;
        }>(
          `
            SELECT r.rolname AS owner_name, p.prosecdef, p.proconfig
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
            WHERE p.oid = '${fn}'::regprocedure
          `,
        );
        assert.equal(fnCheck.rows.length, 1, `Function ${fn} must exist after 0024`);
        assert.equal(fnCheck.rows[0]?.owner_name, "fluxora_queue");
        assert.equal(fnCheck.rows[0]?.prosecdef, true);
        assert.ok(
          fnCheck.rows[0]?.proconfig?.some(
            (cfg) => cfg === "search_path=pg_catalog, public, pg_temp",
          ),
        );

        const aclCheck = await migratorClient.query<{ public_exec: boolean; role_exec: boolean }>(
          `
            SELECT
              COALESCE((
                SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
                FROM pg_catalog.aclexplode(p.proacl) acl
              ), false) AS public_exec,
              COALESCE((
                SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1))
                FROM pg_catalog.aclexplode(p.proacl) acl
              ), false) AS role_exec
            FROM pg_catalog.pg_proc p
            WHERE p.oid = '${fn}'::regprocedure
          `,
          [TEST_MIGRATOR_ROLE],
        );
        assert.equal(aclCheck.rows[0]?.public_exec, false, `PUBLIC must not have EXECUTE on ${fn}`);
        assert.equal(aclCheck.rows[0]?.role_exec, true, `Migration role must have EXECUTE on ${fn}`);
      }

      const post0024MembershipCheck = await migratorClient.query<{ is_member: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_auth_members m
            JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
            JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
            WHERE gr.rolname = 'fluxora_queue'
              AND mr.rolname = $1
              AND (
                CASE
                  WHEN current_setting('server_version_num')::int >= 160000
                    THEN (m.inherit_option OR m.set_option)
                  ELSE true
                END
              )
          ) AS is_member
        `,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(post0024MembershipCheck.rows[0]?.is_member, false, "Migration role must not retain inheriting membership in fluxora_queue after 0024");
    } finally {
      await migratorClient.end();
    }
  });

  it("performs clean installation through migration 0024 using a constrained non-superuser role", async () => {
    const queueDbName = adminBaseUrl.pathname.replace(/^\//, "");
    if (queueDbName === CLEAN_TEST_DB) {
      throw new Error(
        `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets "${CLEAN_TEST_DB}".`,
      );
    }

    // 1. Administrator provisions the isolated disposable database and genuinely privileged prerequisites:
    await adminClient.query(`DROP DATABASE IF EXISTS ${CLEAN_TEST_DB}`);
    await adminClient.query(`CREATE DATABASE ${CLEAN_TEST_DB}`);

    const cleanAdminUrl = new URL(adminBaseUrl.toString());
    cleanAdminUrl.pathname = `/${CLEAN_TEST_DB}`;
    const cleanAdminClient = new pg.Client({ connectionString: cleanAdminUrl.toString() });
    await cleanAdminClient.connect();

    try {
      // Privileged prerequisite: pgcrypto extension installed in fresh database by administrator
      await cleanAdminClient.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

      // Ensure constrained non-superuser migration role exists with only genuinely required role-management attributes:
      // NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, but CREATEROLE (genuinely required to create fluxora_bootstrap in 0009 and fluxora_queue in 0020)
      await cleanAdminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${TEST_MIGRATOR_ROLE}') THEN
            CREATE ROLE ${TEST_MIGRATOR_ROLE}
              LOGIN
              PASSWORD '${TEST_MIGRATOR_PW}'
              NOSUPERUSER
              NOBYPASSRLS
              NOCREATEDB
              CREATEROLE;
          END IF;

          -- If cluster-level service roles exist from prior test runs, grant admin option so
          -- the constrained migration runner can manage function ownership without superuser privileges:
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_bootstrap') THEN
            GRANT fluxora_bootstrap TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_queue') THEN
            GRANT fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
          END IF;
        END
        $$;

        ALTER SCHEMA public OWNER TO ${TEST_MIGRATOR_ROLE};
        GRANT ALL ON SCHEMA public TO ${TEST_MIGRATOR_ROLE} WITH GRANT OPTION;
      `);
    } finally {
      await cleanAdminClient.end();
    }

    // 2. Connect as the constrained non-superuser migration role:
    const migratorUrl = new URL(adminBaseUrl.toString());
    migratorUrl.pathname = `/${CLEAN_TEST_DB}`;
    migratorUrl.username = TEST_MIGRATOR_ROLE;
    migratorUrl.password = TEST_MIGRATOR_PW;
    const migratorClient = new pg.Client({ connectionString: migratorUrl.toString() });
    await migratorClient.connect();

    try {
      // Verify constrained role attributes before executing migrations
      const roleCheck = await migratorClient.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(
        `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
         FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(roleCheck.rows[0]?.rolsuper, false, "Migration role must be NOSUPERUSER");
      assert.equal(roleCheck.rows[0]?.rolbypassrls, false, "Migration role must be NOBYPASSRLS");
      assert.equal(roleCheck.rows[0]?.rolcreatedb, false, "Migration role must be NOCREATEDB");
      assert.equal(roleCheck.rows[0]?.rolcreaterole, true, "Migration role requires CREATEROLE");

      // 3. Execute migrations 0001 through 0024 using the constrained non-superuser role:
      const migrationsDir = path.join(
        fileURLToPath(new URL("../../migrations/", import.meta.url)),
      );
      const entries = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql") && name <= "0024_job_queue_configured_retry_limit.sql")
        .sort();

      await migratorClient.query("BEGIN");
      await migratorClient.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      for (const fileName of entries) {
        const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
        await migratorClient.query(sql);
        await migratorClient.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [fileName]);
      }
      await migratorClient.query("COMMIT");

      // 4. Verification under constrained migration role:
      // a. Function ownership, SECURITY DEFINER, pinned search_path, and execution grants across all 5 functions:
      const allCleanFuncs = [
        "public.fluxora_claim_next_job(text, integer)",
        "public.fluxora_complete_job(uuid, text)",
        "public.fluxora_fail_job(uuid, text, text)",
        "public.fluxora_retry_failed_job(uuid, text, integer, text)",
        "public.fluxora_jobs_retry_limits_guard()",
      ];

      for (const sig of allCleanFuncs) {
        const fnCheck = await migratorClient.query<{
          owner_name: string;
          prosecdef: boolean;
          proconfig: string[] | null;
        }>(
          `SELECT r.rolname AS owner_name, p.prosecdef, p.proconfig
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
           WHERE p.oid = '${sig}'::regprocedure`,
        );
        assert.equal(fnCheck.rows.length, 1, `Function ${sig} must exist after clean install`);
        assert.equal(fnCheck.rows[0]?.owner_name, "fluxora_queue", `Function ${sig} owner must be fluxora_queue`);
        assert.equal(fnCheck.rows[0]?.prosecdef, true, `Function ${sig} must be SECURITY DEFINER`);
        assert.ok(
          fnCheck.rows[0]?.proconfig?.some(
            (cfg) => cfg === "search_path=pg_catalog, public, pg_temp",
          ),
          `Function ${sig} must have search_path pinned to pg_catalog, public, pg_temp`,
        );

        // Verify PUBLIC does not have EXECUTE, and migration role DOES have EXECUTE
        const aclCheck = await migratorClient.query<{ public_exec: boolean; role_exec: boolean }>(
          `SELECT
             COALESCE((
               SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
               FROM pg_catalog.aclexplode(p.proacl) acl
             ), false) AS public_exec,
             COALESCE((
               SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1))
               FROM pg_catalog.aclexplode(p.proacl) acl
             ), false) AS role_exec
           FROM pg_catalog.pg_proc p
           WHERE p.oid = '${sig}'::regprocedure`,
          [TEST_MIGRATOR_ROLE],
        );
        assert.equal(aclCheck.rows[0]?.public_exec, false, `PUBLIC must NOT have EXECUTE on ${sig}`);
        assert.equal(aclCheck.rows[0]?.role_exec, true, `Migration role must have EXECUTE on ${sig}`);
      }

      // b. Verify validated CHECK constraints
      const constraintCheck = await migratorClient.query<{ conname: string; convalidated: boolean; contype: string }>(
        `SELECT conname, convalidated, contype FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_attempt_count_le_max_attempts'`,
      );
      assert.equal(constraintCheck.rows.length, 1);
      assert.equal(constraintCheck.rows[0]?.contype, "c");
      assert.equal(constraintCheck.rows[0]?.convalidated, true);

      const cfgConstraintCheck = await migratorClient.query<{ conname: string; convalidated: boolean; contype: string }>(
        `SELECT conname, convalidated, contype FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_configured_max_attempts_check'`,
      );
      assert.equal(cfgConstraintCheck.rows.length, 1);
      assert.equal(cfgConstraintCheck.rows[0]?.contype, "c");
      assert.equal(cfgConstraintCheck.rows[0]?.convalidated, true);

      const attemptCheck = await migratorClient.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_attempt_count_check'`,
      );
      assert.equal(attemptCheck.rows.length, 1);
      assert.equal(attemptCheck.rows[0]?.convalidated, true);

      const maxCheck = await migratorClient.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_max_attempts_check'`,
      );
      assert.equal(maxCheck.rows.length, 1);
      assert.equal(maxCheck.rows[0]?.convalidated, true);

      // c. Verify trigger behavior under constrained migration role
      const trigCheck = await migratorClient.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_retry_limits_guard_trigger'`,
      );
      assert.equal(trigCheck.rows.length, 1, "jobs_retry_limits_guard_trigger must exist after clean install");
      assert.equal(trigCheck.rows[0]?.tgenabled, "O", "jobs_retry_limits_guard_trigger must be enabled");

      // Create test organization
      const cleanOrgRes = await migratorClient.query<{ id: string }>(
        `SELECT fluxora_create_organization('clean-install-org') AS id`,
      );
      const cleanOrgId = cleanOrgRes.rows[0]?.id;
      assert.ok(cleanOrgId, "Organization must be created for clean install test");

      await migratorClient.query(
        `SELECT set_config('app.current_org_id', $1, false)`,
        [cleanOrgId],
      );

      // Default insert sets both to 3
      const defaultIns = await migratorClient.query<{ max_attempts: number; configured_max_attempts: number }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key)
         VALUES ($1, 'clean.test', 'clean-def-1')
         RETURNING max_attempts, configured_max_attempts`,
        [cleanOrgId],
      );
      assert.equal(defaultIns.rows[0]?.max_attempts, 3);
      assert.equal(defaultIns.rows[0]?.configured_max_attempts, 3);

      // Single-sided max_attempts sets configured_max_attempts to match
      const maxOnlyIns = await migratorClient.query<{ max_attempts: number; configured_max_attempts: number }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts)
         VALUES ($1, 'clean.test', 'clean-max-1', 6)
         RETURNING max_attempts, configured_max_attempts`,
        [cleanOrgId],
      );
      assert.equal(maxOnlyIns.rows[0]?.max_attempts, 6);
      assert.equal(maxOnlyIns.rows[0]?.configured_max_attempts, 6);

      // Single-sided configured_max_attempts sets max_attempts to match
      const cfgOnlyIns = await migratorClient.query<{ max_attempts: number; configured_max_attempts: number }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, configured_max_attempts)
         VALUES ($1, 'clean.test', 'clean-cfg-1', 4)
         RETURNING max_attempts, configured_max_attempts`,
        [cleanOrgId],
      );
      assert.equal(cfgOnlyIns.rows[0]?.max_attempts, 4);
      assert.equal(cfgOnlyIns.rows[0]?.configured_max_attempts, 4);

      // Conflicting limits rejected
      await assert.rejects(
        () =>
          migratorClient.query(
            `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
             VALUES ($1, 'clean.test', 'clean-conflict', 5, 2)`,
            [cleanOrgId],
          ),
        (err: Error) => {
          assert.match(err.message, /must match on new jobs/);
          return true;
        },
      );

      // Zero or negative limits rejected
      await assert.rejects(
        () =>
          migratorClient.query(
            `INSERT INTO public.jobs (organization_id, type, idempotency_key, configured_max_attempts)
             VALUES ($1, 'clean.test', 'clean-zero', 0)`,
            [cleanOrgId],
          ),
        (err: Error) => {
          assert.match(err.message, /jobs_configured_max_attempts_check/);
          return true;
        },
      );

      // Immutability on UPDATE rejected
      const targetJobRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
         VALUES ($1, 'clean.test', 'clean-immut-target', 4, 4)
         RETURNING id`,
        [cleanOrgId],
      );
      const targetJobId = targetJobRes.rows[0]?.id;

      await assert.rejects(
        () =>
          migratorClient.query(
            `UPDATE public.jobs SET configured_max_attempts = 8 WHERE id = $1`,
            [targetJobId],
          ),
        (err: Error) => {
          assert.match(err.message, /configured_max_attempts is immutable/);
          return true;
        },
      );

      await migratorClient.query("RESET app.current_org_id");

      // d. Verify temporary migration policies and memberships are completely cleaned up
      const policyCheck = await migratorClient.query<{ policyname: string }>(
        `SELECT policyname FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'jobs' AND policyname IN ('jobs_migration_reconcile_0023', 'jobs_migration_reconcile_0024')`,
      );
      assert.equal(policyCheck.rows.length, 0, "Temporary migration policies must not exist after clean install");

      const membershipCheck = await migratorClient.query<{ is_member: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_auth_members m
           JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
           JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
           WHERE gr.rolname = 'fluxora_queue'
             AND mr.rolname = $1
             AND (
               CASE
                 WHEN pg_catalog.current_setting('server_version_num')::int >= 160000
                   THEN (m.inherit_option OR m.set_option)
                 ELSE true
               END
             )
         ) AS is_member`,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(membershipCheck.rows[0]?.is_member, false, "Migration role must not retain inheriting membership in fluxora_queue");

      // e. Verify fluxora_queue role attributes
      const queueRoleCheck = await migratorClient.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolinherit: boolean;
        rolcanlogin: boolean;
      }>(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin
         FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_queue'`,
      );
      assert.equal(queueRoleCheck.rows.length, 1);
      assert.equal(queueRoleCheck.rows[0]?.rolsuper, false);
      assert.equal(queueRoleCheck.rows[0]?.rolbypassrls, false);
      assert.equal(queueRoleCheck.rows[0]?.rolcreaterole, false);
      assert.equal(queueRoleCheck.rows[0]?.rolcreatedb, false);
      assert.equal(queueRoleCheck.rows[0]?.rolinherit, false);
      assert.equal(queueRoleCheck.rows[0]?.rolcanlogin, false);

      // f. Verify FORCE ROW LEVEL SECURITY
      const rlsCheck = await migratorClient.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class WHERE relname = 'jobs' AND relnamespace = 'public'::regnamespace`,
      );
      assert.equal(rlsCheck.rows[0]?.relrowsecurity, true);
      assert.equal(rlsCheck.rows[0]?.relforcerowsecurity, true);
    } finally {
      await migratorClient.end();
      await adminClient.query(`DROP DATABASE IF EXISTS ${CLEAN_TEST_DB}`);
    }
  });

  it("upgrades historical 386-line migration 0023 candidate to migration 0024 under constrained non-superuser role", async () => {
    const queueDbName = adminBaseUrl.pathname.replace(/^\//, "");
    if (queueDbName === HIST_TEST_DB) {
      throw new Error(
        `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets "${HIST_TEST_DB}".`,
      );
    }

    // 1. Administrator provisions the isolated disposable database and pre-0023 schema (0001 through 0022):
    await adminClient.query(`DROP DATABASE IF EXISTS ${HIST_TEST_DB}`);
    await adminClient.query(`CREATE DATABASE ${HIST_TEST_DB}`);

    const histAdminUrl = new URL(adminBaseUrl.toString());
    histAdminUrl.pathname = `/${HIST_TEST_DB}`;
    const histAdminClient = new pg.Client({ connectionString: histAdminUrl.toString() });
    await histAdminClient.connect();

    try {
      await histAdminClient.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
      await histAdminClient.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrationsDir = path.join(
        fileURLToPath(new URL("../../migrations/", import.meta.url)),
      );
      const pre0023Files = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql") && name <= "0022_job_queue_crash_recovery_retry_limit.sql")
        .sort();

      for (const fileName of pre0023Files) {
        const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
        await histAdminClient.query(sql);
        await histAdminClient.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [fileName]);
      }

      // Ensure constrained non-superuser migration role exists with required table and schema ownership
      await histAdminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${TEST_MIGRATOR_ROLE}') THEN
            CREATE ROLE ${TEST_MIGRATOR_ROLE}
              LOGIN
              PASSWORD '${TEST_MIGRATOR_PW}'
              NOSUPERUSER
              NOBYPASSRLS
              NOCREATEDB
              CREATEROLE;
          END IF;

          IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_bootstrap') THEN
            GRANT fluxora_bootstrap TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fluxora_queue') THEN
            GRANT fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
          END IF;
        END
        $$;

        ALTER SCHEMA public OWNER TO ${TEST_MIGRATOR_ROLE};
        GRANT ALL ON SCHEMA public TO ${TEST_MIGRATOR_ROLE} WITH GRANT OPTION;
        ALTER TABLE public.organizations OWNER TO ${TEST_MIGRATOR_ROLE};
        ALTER TABLE public.jobs OWNER TO ${TEST_MIGRATOR_ROLE};
        ALTER TABLE public.schema_migrations OWNER TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_create_organization(text, plan_tier, bigint) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO ${TEST_MIGRATOR_ROLE};
        GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) TO ${TEST_MIGRATOR_ROLE};
      `);
    } finally {
      await histAdminClient.end();
    }

    // 2. Connect as constrained non-superuser migration role:
    const migratorUrl = new URL(adminBaseUrl.toString());
    migratorUrl.pathname = `/${HIST_TEST_DB}`;
    migratorUrl.username = TEST_MIGRATOR_ROLE;
    migratorUrl.password = TEST_MIGRATOR_PW;
    const migratorClient = new pg.Client({ connectionString: migratorUrl.toString() });
    await migratorClient.connect();

    try {
      // Verify constrained non-superuser attributes
      const roleCheck = await migratorClient.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(roleCheck.rows[0]?.rolsuper, false, "Migration role must not be superuser");
      assert.equal(roleCheck.rows[0]?.rolbypassrls, false, "Migration role must not bypass RLS");

      // 3. Create two distinct test organizations:
      const org1Res = await migratorClient.query<{ id: string }>(
        `SELECT fluxora_create_organization('hist-candidate-org-1') AS id`,
      );
      const org1Id = org1Res.rows[0]?.id;
      assert.ok(org1Id);

      const org2Res = await migratorClient.query<{ id: string }>(
        `SELECT fluxora_create_organization('hist-candidate-org-2') AS id`,
      );
      const org2Id = org2Res.rows[0]?.id;
      assert.ok(org2Id);
      assert.notEqual(org1Id, org2Id);

      // 4. Seed representative legacy jobs across both organizations under pre-0023 schema:
      // In Org 1:
      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org1Id]);

      // Legacy over-limit pending job
      const p1Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'hist-pending-1', 'pending', 4, 2)
         RETURNING id`,
        [org1Id],
      );
      const p1Id = p1Res.rows[0]?.id;

      // Legacy over-limit expired running job
      const e1Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, locked_by, lease_expires_at)
         VALUES ($1, 'repo.ingest', 'hist-expired-1', 'running', 5, 3, 'crashed-worker-1', pg_catalog.now() - interval '15 seconds')
         RETURNING id`,
        [org1Id],
      );
      const e1Id = e1Res.rows[0]?.id;

      // Legacy over-limit active running job (unexpired lease)
      const a1Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, locked_by, lease_expires_at)
         VALUES ($1, 'repo.ingest', 'hist-active-1', 'running', 6, 2, 'active-worker-99', pg_catalog.now() + interval '300 seconds')
         RETURNING id`,
        [org1Id],
      );
      const a1Id = a1Res.rows[0]?.id;

      // Legacy under-limit pending job (attempts remaining)
      const u1Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'hist-under-limit-1', 'pending', 1, 3)
         RETURNING id`,
        [org1Id],
      );
      const u1Id = u1Res.rows[0]?.id;

      // In Org 2:
      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org2Id]);

      // Legacy over-limit completed job
      const c2Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, completed_at)
         VALUES ($1, 'repo.ingest', 'hist-completed-2', 'completed', 4, 3, pg_catalog.now())
         RETURNING id`,
        [org2Id],
      );
      const c2Id = c2Res.rows[0]?.id;

      // Legacy over-limit failed job
      const f2Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, failed_at, last_error)
         VALUES ($1, 'repo.ingest', 'hist-failed-2', 'failed', 5, 2, pg_catalog.now(), 'candidate historical failure')
         RETURNING id`,
        [org2Id],
      );
      const f2Id = f2Res.rows[0]?.id;

      // Legacy over-limit dead-letter job
      const d2Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, failed_at, last_error)
         VALUES ($1, 'repo.ingest', 'hist-deadletter-2', 'dead_letter', 7, 3, pg_catalog.now(), 'candidate already dead')
         RETURNING id`,
        [org2Id],
      );
      const d2Id = d2Res.rows[0]?.id;

      // Legacy over-limit pending job (Org 2)
      const p2Res = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'hist-pending-2', 'pending', 3, 1)
         RETURNING id`,
        [org2Id],
      );
      const p2Id = p2Res.rows[0]?.id;

      // 5. Clear tenant context before running migration 0023 candidate:
      await migratorClient.query("RESET app.current_org_id");

      const clearedOrg0023 = await migratorClient.query<{ current_org: string | null }>(
        "SELECT fluxora_current_org_id() AS current_org",
      );
      assert.equal(clearedOrg0023.rows[0]?.current_org, null, "Tenant context must be cleared before applying 0023 candidate");

      // 6. Apply archived 386-line candidate as migration 0023 under constrained non-superuser role:
      const sql386 = await loadHistorical0023CandidateSql();
      await migratorClient.query("BEGIN");
      await migratorClient.query(sql386);
      await migratorClient.query(
        "INSERT INTO schema_migrations (name) VALUES ('0023_job_queue_attempt_count_invariant.sql')",
      );
      await migratorClient.query("COMMIT");

      // Verify post-0023 state:
      // a. configured_max_attempts does NOT exist in 0023 schema
      const colCheckPost0023 = await migratorClient.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'configured_max_attempts'`,
      );
      assert.equal(colCheckPost0023.rows.length, 0, "configured_max_attempts must NOT exist in schema after 0023 candidate");

      // b. Constraint jobs_attempt_count_le_max_attempts is present and validated
      const conCheckPost0023 = await migratorClient.query<{ convalidated: boolean; contype: string }>(
        `SELECT convalidated, contype FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_attempt_count_le_max_attempts'`,
      );
      assert.equal(conCheckPost0023.rows.length, 1);
      assert.equal(conCheckPost0023.rows[0]?.convalidated, true);
      assert.equal(conCheckPost0023.rows[0]?.contype, "c");

      // c. Parameter validation in fluxora_claim_next_job is active
      for (const invalidWorker of ["", "   ", "\t\n"]) {
        await assert.rejects(
          () => migratorClient.query(`SELECT * FROM public.fluxora_claim_next_job($1, 60)`, [invalidWorker]),
          (err: Error) => {
            assert.match(err.message, /p_worker_id must be a non-empty, non-whitespace string/);
            return true;
          },
        );
      }

      // 7. Seed post-0023 jobs under Org 1 and Org 2 (satisfying attempt_count <= max_attempts):
      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org1Id]);
      const post0023PendingRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, attempt_count, max_attempts)
         VALUES ($1, 'repo.ingest', 'post-0023-pending-1', 0, 5)
         RETURNING id`,
        [org1Id],
      );
      const post0023PendingId = post0023PendingRes.rows[0]?.id;

      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org2Id]);
      const post0023ActiveRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, locked_by, lease_expires_at)
         VALUES ($1, 'repo.ingest', 'post-0023-active-2', 'running', 1, 4, 'worker-candidate-post-99', pg_catalog.now() + interval '300 seconds')
         RETURNING id`,
        [org2Id],
      );
      const post0023ActiveId = post0023ActiveRes.rows[0]?.id;

      const post0023DeadRes = await migratorClient.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, failed_at)
         VALUES ($1, 'repo.ingest', 'post-0023-dead-2', 'dead_letter', 2, 2, pg_catalog.now())
         RETURNING id`,
        [org2Id],
      );
      const post0023DeadId = post0023DeadRes.rows[0]?.id;

      // 8. Clear tenant context before running migration 0024:
      await migratorClient.query("RESET app.current_org_id");

      const clearedOrg0024 = await migratorClient.query<{ current_org: string | null }>(
        "SELECT fluxora_current_org_id() AS current_org",
      );
      assert.equal(clearedOrg0024.rows[0]?.current_org, null, "Tenant context must be strictly cleared before running migration 0024");

      // Verify migration role sees 0 rows under RLS without tenant context
      const pre0024VisibleCount = await migratorClient.query<{ count: string }>(
        "SELECT count(*) FROM public.jobs",
      );
      assert.equal(Number(pre0024VisibleCount.rows[0]?.count), 0, "Migration role must see 0 rows without tenant context before 0024");

      // 9. Execute migration 0024 using the constrained non-superuser migration role:
      const sql0024 = await readFile(migration0024Path, "utf8");
      await migratorClient.query("BEGIN");
      await migratorClient.query(sql0024);
      await migratorClient.query(
        "INSERT INTO schema_migrations (name) VALUES ('0024_job_queue_configured_retry_limit.sql')",
      );
      await migratorClient.query("COMMIT");

      // 10. Verify temporary migration policy and privileges are removed:
      const tempPolicyCheck = await migratorClient.query<{ policyname: string }>(
        `SELECT policyname FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'jobs' AND policyname = 'jobs_migration_reconcile_0024'`,
      );
      assert.equal(tempPolicyCheck.rows.length, 0, "Temporary policy jobs_migration_reconcile_0024 must be removed after commit");

      // Verify migration role without tenant context sees 0 rows (no bypass retained):
      const post0024VisibleCount = await migratorClient.query<{ count: string }>(
        "SELECT count(*) FROM public.jobs",
      );
      assert.equal(Number(post0024VisibleCount.rows[0]?.count), 0, "Migration role must see 0 rows without tenant context after 0024");

      // Verify migration role does not retain inheriting membership in fluxora_queue:
      const membershipCheck = await migratorClient.query<{ is_member: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_auth_members m
           JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
           JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
           WHERE gr.rolname = 'fluxora_queue'
             AND mr.rolname = $1
             AND (
               CASE
                 WHEN pg_catalog.current_setting('server_version_num')::int >= 160000
                   THEN (m.inherit_option OR m.set_option)
                 ELSE true
               END
             )
         ) AS is_member`,
        [TEST_MIGRATOR_ROLE],
      );
      assert.equal(membershipCheck.rows[0]?.is_member, false, "Migration role must not retain inheriting membership in fluxora_queue after 0024");

      // 11. Verify reconciliation results across both organizations:
      // Honest legacy handling:
      // - Where attempt_count < max_attempts: original limit is preserved as configured_max_attempts
      // - Where attempt_count >= max_attempts (including those elevated by candidate 0023): configured_max_attempts = NULL
      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org1Id]);

      // p1 was over-limit pending -> dead_letter, attempt_count 4, max_attempts 4, configured_max_attempts NULL
      const p1 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [p1Id])
      ).rows[0];
      assert.equal(p1?.status, "dead_letter");
      assert.equal(p1?.attempt_count, 4);
      assert.equal(p1?.max_attempts, 4);
      assert.equal(p1?.configured_max_attempts, null, "Historical over-limit pending row must have NULL configured_max_attempts");

      // e1 was over-limit expired running -> dead_letter, attempt_count 5, max_attempts 5, configured_max_attempts NULL
      const e1 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [e1Id])
      ).rows[0];
      assert.equal(e1?.status, "dead_letter");
      assert.equal(e1?.attempt_count, 5);
      assert.equal(e1?.max_attempts, 5);
      assert.equal(e1?.configured_max_attempts, null, "Historical over-limit expired running row must have NULL configured_max_attempts");

      // a1 was over-limit active running -> running, attempt_count 6, max_attempts 6, configured_max_attempts NULL, locked_by preserved!
      const a1 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
          locked_by: string | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts, locked_by FROM public.jobs WHERE id = $1`, [a1Id])
      ).rows[0];
      assert.equal(a1?.status, "running", "Active lease must remain running after 0024 upgrade");
      assert.equal(a1?.locked_by, "active-worker-99", "Active worker ownership must be preserved");
      assert.equal(a1?.attempt_count, 6);
      assert.equal(a1?.max_attempts, 6);
      assert.equal(a1?.configured_max_attempts, null, "Historical over-limit active running row must have NULL configured_max_attempts");

      // u1 was under-limit pending -> pending, attempt_count 1, max_attempts 3, configured_max_attempts 3!
      const u1 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [u1Id])
      ).rows[0];
      assert.equal(u1?.status, "pending");
      assert.equal(u1?.attempt_count, 1);
      assert.equal(u1?.max_attempts, 3);
      assert.equal(u1?.configured_max_attempts, 3, "Available limit preserved as configured_max_attempts when attempt_count < max_attempts");

      // post0023Pending -> pending, attempt_count 0, max_attempts 5, configured_max_attempts 5!
      const postP = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [post0023PendingId])
      ).rows[0];
      assert.equal(postP?.status, "pending");
      assert.equal(postP?.attempt_count, 0);
      assert.equal(postP?.max_attempts, 5);
      assert.equal(postP?.configured_max_attempts, 5, "Post-023 under-limit job must have configured_max_attempts preserved");

      // Switch to Org 2 context
      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org2Id]);

      // c2 was completed -> completed, attempt_count 4, max_attempts 4, configured_max_attempts NULL
      const c2 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [c2Id])
      ).rows[0];
      assert.equal(c2?.status, "completed");
      assert.equal(c2?.attempt_count, 4);
      assert.equal(c2?.max_attempts, 4);
      assert.equal(c2?.configured_max_attempts, null);

      // f2 was failed -> dead_letter, attempt_count 5, max_attempts 5, configured_max_attempts NULL
      const f2 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [f2Id])
      ).rows[0];
      assert.equal(f2?.status, "dead_letter");
      assert.equal(f2?.attempt_count, 5);
      assert.equal(f2?.max_attempts, 5);
      assert.equal(f2?.configured_max_attempts, null);

      // d2 was dead_letter -> dead_letter, attempt_count 7, max_attempts 7, configured_max_attempts NULL
      const d2 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [d2Id])
      ).rows[0];
      assert.equal(d2?.status, "dead_letter");
      assert.equal(d2?.attempt_count, 7);
      assert.equal(d2?.max_attempts, 7);
      assert.equal(d2?.configured_max_attempts, null);

      // p2 was pending over-limit -> dead_letter, attempt_count 3, max_attempts 3, configured_max_attempts NULL
      const p2 = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [p2Id])
      ).rows[0];
      assert.equal(p2?.status, "dead_letter");
      assert.equal(p2?.attempt_count, 3);
      assert.equal(p2?.max_attempts, 3);
      assert.equal(p2?.configured_max_attempts, null);

      // post0023Active -> running, locked_by 'worker-candidate-post-99', attempt_count 1, max_attempts 4, configured_max_attempts 4
      const postA = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
          locked_by: string | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts, locked_by FROM public.jobs WHERE id = $1`, [post0023ActiveId])
      ).rows[0];
      assert.equal(postA?.status, "running");
      assert.equal(postA?.locked_by, "worker-candidate-post-99");
      assert.equal(postA?.attempt_count, 1);
      assert.equal(postA?.max_attempts, 4);
      assert.equal(postA?.configured_max_attempts, 4);

      // post0023Dead -> dead_letter, attempt_count 2, max_attempts 2, configured_max_attempts NULL
      const postD = (
        await migratorClient.query<{
          status: string;
          attempt_count: number;
          max_attempts: number;
          configured_max_attempts: number | null;
        }>(`SELECT status, attempt_count, max_attempts, configured_max_attempts FROM public.jobs WHERE id = $1`, [post0023DeadId])
      ).rows[0];
      assert.equal(postD?.status, "dead_letter");
      assert.equal(postD?.attempt_count, 2);
      assert.equal(postD?.max_attempts, 2);
      assert.equal(postD?.configured_max_attempts, null);

      // 12. Complete active running job via fluxora_complete_job returning configured limit
      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org1Id]);
      const compRes = await migratorClient.query<{
        status: string;
        attempt_count: number;
        max_attempts: number;
        configured_max_attempts: number | null;
      }>(
        `SELECT status, attempt_count, max_attempts, configured_max_attempts
         FROM public.fluxora_complete_job($1, 'active-worker-99')`,
        [a1Id],
      );
      assert.equal(compRes.rows[0]?.status, "completed");
      assert.equal(compRes.rows[0]?.attempt_count, 6);
      assert.equal(compRes.rows[0]?.max_attempts, 6);
      assert.equal(compRes.rows[0]?.configured_max_attempts, null, "Completed job with historical limit must return null configured_max_attempts");

      // 13. Verify attempt-count constraints are present and validated:
      await migratorClient.query("RESET app.current_org_id");

      const conNames = [
        "jobs_attempt_count_le_max_attempts",
        "jobs_configured_max_attempts_check",
        "jobs_attempt_count_check",
        "jobs_max_attempts_check",
      ];
      for (const cName of conNames) {
        const conCheck = await migratorClient.query<{ conname: string; convalidated: boolean; contype: string }>(
          `SELECT conname, convalidated, contype FROM pg_catalog.pg_constraint
           WHERE conrelid = 'public.jobs'::regclass AND conname = $1`,
          [cName],
        );
        assert.equal(conCheck.rows.length, 1, `Constraint ${cName} must exist`);
        assert.equal(conCheck.rows[0]?.convalidated, true, `Constraint ${cName} must be validated`);
        assert.equal(conCheck.rows[0]?.contype, "c");
      }

      // 14. Verify trigger guard behavior and immutability:
      const trigCheck = await migratorClient.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_retry_limits_guard_trigger'`,
      );
      assert.equal(trigCheck.rows.length, 1, "Trigger jobs_retry_limits_guard_trigger must exist");
      assert.equal(trigCheck.rows[0]?.tgenabled, "O", "Trigger must be enabled");

      await migratorClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [org1Id]);

      // Immutability on UPDATE: attempting to mutate configured_max_attempts on unknown historical limit (NULL)
      await assert.rejects(
        () => migratorClient.query(`UPDATE public.jobs SET configured_max_attempts = 10 WHERE id = $1`, [a1Id]),
        (err: Error) => {
          assert.match(err.message, /configured_max_attempts is immutable/);
          return true;
        },
      );

      // Immutability on UPDATE: attempting to mutate configured_max_attempts on known limit
      await assert.rejects(
        () => migratorClient.query(`UPDATE public.jobs SET configured_max_attempts = 10 WHERE id = $1`, [u1Id]),
        (err: Error) => {
          assert.match(err.message, /configured_max_attempts is immutable/);
          return true;
        },
      );

      // Trigger rejects conflicting limits on insert
      await assert.rejects(
        () =>
          migratorClient.query(
            `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
             VALUES ($1, 'repo.ingest', 'hist-conflict-test', 5, 2)`,
            [org1Id],
          ),
        (err: Error) => {
          assert.match(err.message, /must match on new jobs/);
          return true;
        },
      );

      // 15. Verify all 5 functions: ownership, SECURITY DEFINER, search_path, execution grants:
      await migratorClient.query("RESET app.current_org_id");

      for (const fn of QUEUE_FUNCTIONS_0024) {
        const fnCheck = await migratorClient.query<{
          owner_name: string;
          prosecdef: boolean;
          proconfig: string[] | null;
        }>(
          `SELECT r.rolname AS owner_name, p.prosecdef, p.proconfig
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
           WHERE p.oid = '${fn}'::regprocedure`,
        );
        assert.equal(fnCheck.rows.length, 1, `Function ${fn} must exist`);
        assert.equal(fnCheck.rows[0]?.owner_name, "fluxora_queue", `Function ${fn} owner must be fluxora_queue`);
        assert.equal(fnCheck.rows[0]?.prosecdef, true, `Function ${fn} must be SECURITY DEFINER`);
        assert.ok(
          fnCheck.rows[0]?.proconfig?.some((cfg) => cfg === "search_path=pg_catalog, public, pg_temp"),
          `Function ${fn} must have search_path pinned`,
        );

        const aclCheck = await migratorClient.query<{ public_exec: boolean; role_exec: boolean }>(
          `SELECT
             COALESCE((
               SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
               FROM pg_catalog.aclexplode(p.proacl) acl
             ), false) AS public_exec,
             COALESCE((
               SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1))
               FROM pg_catalog.aclexplode(p.proacl) acl
             ), false) AS role_exec
           FROM pg_catalog.pg_proc p
           WHERE p.oid = '${fn}'::regprocedure`,
          [TEST_MIGRATOR_ROLE],
        );
        assert.equal(aclCheck.rows[0]?.public_exec, false, `PUBLIC must not have EXECUTE on ${fn}`);
        assert.equal(aclCheck.rows[0]?.role_exec, true, `Migration role must have EXECUTE on ${fn}`);
      }

      // 16. Verify FORCE ROW LEVEL SECURITY remains enabled
      const rlsCheck = await migratorClient.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class WHERE relname = 'jobs' AND relnamespace = 'public'::regnamespace`,
      );
      assert.equal(rlsCheck.rows[0]?.relrowsecurity, true);
      assert.equal(rlsCheck.rows[0]?.relforcerowsecurity, true);
    } finally {
      await migratorClient.end();
      await adminClient.query(`DROP DATABASE IF EXISTS ${HIST_TEST_DB}`);
    }
  });
});
