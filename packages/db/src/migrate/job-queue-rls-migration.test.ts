import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll, afterAll, test } from "vitest";
import pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";

loadRootEnvFile();

const migration0020Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0020_job_queue_least_privilege_rls.sql",
);

const migration0021Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0021_job_queue_hardening.sql",
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
    if (queueDbName === INC_TEST_DB) {
      throw new Error(
        `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets "${INC_TEST_DB}". The test database must be distinct from both DATABASE_URL and FLUXORA_QUEUE_TEST_DATABASE_URL.`,
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
      if (defaultDbName === INC_TEST_DB) {
        throw new Error(
          `Safety violation: DATABASE_URL targets "${INC_TEST_DB}". The test database must be distinct from DATABASE_URL.`,
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
        ALTER TABLE public.jobs OWNER TO ${TEST_MIGRATOR_ROLE};
        ALTER TABLE public.schema_migrations OWNER TO ${TEST_MIGRATOR_ROLE};
        GRANT fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
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
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1))
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
    } finally {
      await migratorClient.end();
    }
  });
});
