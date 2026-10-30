import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";
import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJobById,
  retryFailedJob,
} from "./job.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";

export const APPROVED_QUEUE_TEST_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
] as const;

export function isApprovedQueueTestHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase().trim();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "postgres"
  );
}

export function assertApprovedQueueTestHost(rawUrl: string | URL): URL {
  let parsed: URL;
  try {
    parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch (err) {
    throw new Error(
      `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL is not a valid URL: ${(err as Error).message}`,
    );
  }

  if (!isApprovedQueueTestHost(parsed.hostname)) {
    throw new Error(
      `Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host "${parsed.hostname}". ` +
        `Queue integration tests are restricted to approved disposable local/CI hosts: ${APPROVED_QUEUE_TEST_HOSTS.join(", ")}. ` +
        "Refusing to connect or execute migrations.",
    );
  }
  return parsed;
}

const rawQueueTestUrl = process.env.FLUXORA_QUEUE_TEST_DATABASE_URL;
// Require FLUXORA_QUEUE_TEST_DATABASE_URL; only accept generic QUEUE_TEST_DATABASE_URL if explicitly set
const queueTestDatabaseUrl = rawQueueTestUrl ?? process.env.QUEUE_TEST_DATABASE_URL;

const hasQueueDatabase =
  typeof queueTestDatabaseUrl === "string" && queueTestDatabaseUrl.trim().length > 0;

if (!hasQueueDatabase) {
  console.info(
    "[job-queue-rls.test] Skipping queue RLS integration test: FLUXORA_QUEUE_TEST_DATABASE_URL is not set. " +
      "A dedicated isolated disposable test database is required to prevent cross-tenant job claiming interference with the developer database.",
  );
}

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDatabaseRole = process.env.FLUXORA_DATABASE_ROLE;
let createdRoleByTest = false;

export interface DatabaseIdentity {
  name: string;
  oid: string;
}

export async function fetchDatabaseIdentity(connectionString: string): Promise<DatabaseIdentity> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ db_name: string; db_oid: string }>(
      `SELECT current_database() AS db_name, (SELECT oid FROM pg_database WHERE datname = current_database())::text AS db_oid`,
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error(`Failed to query database identity from ${connectionString}`);
    }
    return { name: row.db_name, oid: row.db_oid };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function verifyDatabaseIsolation(
  defaultUrl: string | undefined,
  testUrl: string,
): Promise<DatabaseIdentity> {
  assertApprovedQueueTestHost(testUrl);

  const testIdentity = await fetchDatabaseIdentity(testUrl);
  const normalizedTestName = testIdentity.name.toLowerCase();

  if (normalizedTestName === "fluxora_dev" || normalizedTestName.endsWith("_dev")) {
    throw new Error(
      `FATAL: FLUXORA_QUEUE_TEST_DATABASE_URL targets a development database ("${testIdentity.name}"). ` +
        "Queue RLS integration tests perform global job claiming and require a separate disposable test database.",
    );
  }

  if (defaultUrl && defaultUrl.trim().length > 0) {
    const defaultIdentity = await fetchDatabaseIdentity(defaultUrl);
    if (defaultIdentity.oid === testIdentity.oid || defaultIdentity.name === testIdentity.name) {
      throw new Error(
        `FATAL: FLUXORA_QUEUE_TEST_DATABASE_URL targets the same server database as DATABASE_URL ` +
          `(database name: "${testIdentity.name}", oid: ${testIdentity.oid}). ` +
          "Queue integration tests must not share a database with application development.",
      );
    }
  }

  return testIdentity;
}

async function setupTestRole(pool: pg.Pool): Promise<void> {
  const roleCheck = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists`,
    [RLS_TEST_ROLE],
  );
  createdRoleByTest = !roleCheck.rows[0]?.exists;

  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE ${RLS_TEST_ROLE}
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

  await pool.query(`GRANT ${RLS_TEST_ROLE} TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${RLS_TEST_ROLE}`);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO ${RLS_TEST_ROLE}`,
  );
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE organizations TO ${RLS_TEST_ROLE}`,
  );
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE jobs TO ${RLS_TEST_ROLE}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_claim_next_job(text, integer) TO ${RLS_TEST_ROLE}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_complete_job(uuid, text) TO ${RLS_TEST_ROLE}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_fail_job(uuid, text, text) TO ${RLS_TEST_ROLE}`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) TO ${RLS_TEST_ROLE}`,
  );

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

describe("queue test database safety guards", () => {
  it("approves supported disposable local and CI hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]) {
      assert.equal(
        isApprovedQueueTestHost(host),
        true,
        `Host "${host}" should be approved`,
      );
      const urlHost = host === "::1" ? "[::1]" : host;
      const url = `postgresql://postgres:postgres@${urlHost}:5432/fluxora_queue_ci`;
      const parsed = assertApprovedQueueTestHost(url);
      assert.equal(parsed instanceof URL, true);
    }

    assert.equal(isApprovedQueueTestHost("LOCALHOST"), true);
    assert.equal(isApprovedQueueTestHost("Postgres"), true);
  });

  it("rejects unapproved remote hosts, unapproved IP addresses, and custom hostnames with a clear safety error", () => {
    const unapprovedHosts = [
      "db.prod.fluxora.io",
      "postgres.render.com",
      "ep-cold-pond-12345.us-east-2.aws.neon.tech",
      "my-prod-cluster.rds.amazonaws.com",
      "db.supabase.co",
      "192.168.1.100",
      "10.0.0.1",
      "172.16.0.1",
      "127.0.0.2",
      "0.0.0.0",
      "8.8.8.8",
      "::2",
      "[::2]",
      "remote-host.internal",
      "staging-db",
      "my-custom-postgres",
    ];

    for (const host of unapprovedHosts) {
      assert.equal(
        isApprovedQueueTestHost(host),
        false,
        `Host "${host}" must not be approved`,
      );

      const urlHost =
        host.startsWith(":") || (host.includes(":") && !host.startsWith("["))
          ? `[${host}]`
          : host;
      const dangerousUrl = `postgresql://postgres:postgres@${urlHost}:5432/fluxora_queue_ci`;
      assert.throws(
        () => assertApprovedQueueTestHost(dangerousUrl),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host/,
          );
          const rawHost = host.replace(/^\[|\]$/g, "");
          assert.match(err.message, new RegExp(rawHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.match(err.message, /Refusing to connect or execute migrations/);
          return true;
        },
      );
    }
  });

  it("rejects malformed database URLs with a safety error", () => {
    assert.throws(
      () => assertApprovedQueueTestHost("not-a-valid-url"),
      /Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL is not a valid URL/,
    );
  });

  it("rejects unapproved remote host in verifyDatabaseIsolation before creating database client or issuing SQL", async () => {
    const connectSpy = vi.spyOn(pg.Client.prototype, "connect");
    try {
      const dangerousUrls = [
        "postgresql://postgres:postgres@db.prod.fluxora.io:5432/fluxora_queue_test",
        "postgresql://postgres:postgres@192.168.1.100:5432/fluxora_queue_test",
        "postgresql://postgres:postgres@custom-cloud-db.internal:5432/fluxora_queue_test",
      ];

      for (const dangerousUrl of dangerousUrls) {
        await assert.rejects(
          () => verifyDatabaseIsolation(originalDatabaseUrl, dangerousUrl),
          (err: Error) => {
            assert.match(
              err.message,
              /Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host/,
            );
            return true;
          },
        );
      }

      assert.equal(
        connectSpy.mock.calls.length,
        0,
        "No database client connection must ever be attempted for unapproved hosts",
      );
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("rejects unapproved remote host before migration execution", async () => {
    let migrationsRun = false;
    const fakeRunMigrations = async () => {
      migrationsRun = true;
    };

    const dangerousUrl = "postgresql://postgres:postgres@rds.amazonaws.com:5432/fluxora_queue_ci";

    await assert.rejects(
      async () => {
        assertApprovedQueueTestHost(dangerousUrl);
        await fakeRunMigrations();
      },
      /Safety violation: FLUXORA_QUEUE_TEST_DATABASE_URL targets unapproved remote host/,
    );

    assert.equal(migrationsRun, false, "runMigrations must never be called when host validation fails");
  });
});

describe.skipIf(!hasQueueDatabase)("job queue least-privilege RLS and cross-tenant dispatch", () => {
  let pool: pg.Pool;
  let orgA: Awaited<ReturnType<typeof createOrganization>>;
  let orgB: Awaited<ReturnType<typeof createOrganization>>;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    // 1. Verify strict server-side database isolation before running migrations or touching data
    assertApprovedQueueTestHost(queueTestDatabaseUrl!);
    const testIdentity = await verifyDatabaseIsolation(originalDatabaseUrl, queueTestDatabaseUrl!);

    process.env.DATABASE_URL = queueTestDatabaseUrl;
    await closePool();
    pool = getPool();

    // In dedicated disposable test database: ensure clean public schema so migrations run freshly
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

    await runMigrations(pool);

    // 2. Detect unrelated active/pending queue jobs in the global queue before creating test fixtures
    const existingJobsRes = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.jobs WHERE status IN ('pending', 'running')`,
    );
    const existingCount = existingJobsRes.rows[0]?.count ?? 0;
    if (existingCount > 0) {
      throw new Error(
        `Dedicated queue test database "${testIdentity.name}" contains ${existingCount} unexpected active/pending queue job(s). ` +
          "Queue integration tests require a clean, isolated test database. " +
          `Please recreate the disposable test database "${testIdentity.name}" before running queue tests.`,
      );
    }

    await setupTestRole(pool);

    orgA = await createOrganization(pool, {
      name: `fluxora-queue-test-a-${suffix}`,
    });
    orgB = await createOrganization(pool, {
      name: `fluxora-queue-test-b-${suffix}`,
    });
  });

  beforeEach(async () => {
    if (pool) {
      await pool.query("DELETE FROM public.jobs");
    }
  });

  afterAll(async () => {
    const cleanupErrors: Error[] = [];

    // 1. Always attempt to remove test organization fixtures independently
    if (pool && orgA) {
      try {
        await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgA.id]);
      } catch (err) {
        cleanupErrors.push(
          new Error(`Failed to remove test organization A (${orgA.id}): ${(err as Error).message}`),
        );
      }
    }

    if (pool && orgB) {
      try {
        await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgB.id]);
      } catch (err) {
        cleanupErrors.push(
          new Error(`Failed to remove test organization B (${orgB.id}): ${(err as Error).message}`),
        );
      }
    }

    // 2. Revoke temporary role membership and all grants created by the test
    if (pool) {
      try {
        await pool.query(`REVOKE ${RLS_TEST_ROLE} FROM CURRENT_USER`);
      } catch (err) {
        cleanupErrors.push(new Error(`Failed to revoke ${RLS_TEST_ROLE} from CURRENT_USER: ${(err as Error).message}`));
      }

      try {
        await pool.query(`
          REVOKE ALL ON TABLE public.jobs FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON TABLE public.organizations FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON FUNCTION public.fluxora_current_org_id() FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON FUNCTION public.fluxora_claim_next_job(text, integer) FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON FUNCTION public.fluxora_complete_job(uuid, text) FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON FUNCTION public.fluxora_fail_job(uuid, text, text) FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON FUNCTION public.fluxora_retry_failed_job(uuid, text, integer, text) FROM ${RLS_TEST_ROLE};
          REVOKE ALL ON SCHEMA public FROM ${RLS_TEST_ROLE};
        `);
      } catch (err) {
        cleanupErrors.push(new Error(`Failed to revoke grants from ${RLS_TEST_ROLE}: ${(err as Error).message}`));
      }

      // 3. Drop fluxora_rls_test only if this test created it
      if (createdRoleByTest) {
        try {
          await pool.query(`DROP ROLE IF EXISTS ${RLS_TEST_ROLE}`);
        } catch (err) {
          cleanupErrors.push(new Error(`Failed to drop test role ${RLS_TEST_ROLE}: ${(err as Error).message}`));
        }
      }

      // 4. Verify no temporary memberships remain
      try {
        const remainingCheck = await pool.query<{ count: number }>(
          `
            SELECT count(*)::int AS count
            FROM pg_catalog.pg_auth_members m
            JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
            WHERE r.rolname = $1
          `,
          [RLS_TEST_ROLE],
        );
        const remaining = remainingCheck.rows[0]?.count ?? 0;
        if (remaining > 0) {
          cleanupErrors.push(new Error(`${remaining} active membership(s) still remain for ${RLS_TEST_ROLE}`));
        }
      } catch (err) {
        cleanupErrors.push(new Error(`Failed to verify ${RLS_TEST_ROLE} memberships: ${(err as Error).message}`));
      }

      try {
        await closePool();
      } catch (err) {
        cleanupErrors.push(new Error(`Failed to close database pool: ${(err as Error).message}`));
      }
    }

    // 5. Restore previous DATABASE_URL and FLUXORA_DATABASE_ROLE values
    if (originalDatabaseRole !== undefined) {
      process.env.FLUXORA_DATABASE_ROLE = originalDatabaseRole;
    } else {
      delete process.env.FLUXORA_DATABASE_ROLE;
    }

    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }

    // 6. Treat cleanup failures as test failures (do not swallow)
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Queue RLS test cleanup failed with ${cleanupErrors.length} error(s):\n` +
          cleanupErrors.map((e) => ` - ${e.message}`).join("\n"),
      );
    }
  });

  it("verifies the function owner fluxora_queue has all promised least-privilege attributes", async () => {
    const res = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
    }>(
      `
        SELECT
          rolcanlogin,
          rolsuper,
          rolcreaterole,
          rolcreatedb,
          rolbypassrls,
          rolinherit,
          rolreplication
        FROM pg_roles
        WHERE rolname = 'fluxora_queue'
      `,
    );

    assert.equal(res.rows.length, 1);
    const role = res.rows[0];
    assert.ok(role !== undefined, "fluxora_queue role row must exist");
    assert.equal(role.rolcanlogin, false, "fluxora_queue must be NOLOGIN");
    assert.equal(role.rolsuper, false, "fluxora_queue must be NOSUPERUSER");
    assert.equal(role.rolbypassrls, false, "fluxora_queue must be NOBYPASSRLS");
    assert.equal(role.rolcreaterole, false, "fluxora_queue must be NOCREATEROLE");
    assert.equal(role.rolcreatedb, false, "fluxora_queue must be NOCREATEDB");
    assert.equal(role.rolinherit, false, "fluxora_queue must be NOINHERIT");
    assert.equal(role.rolreplication, false, "fluxora_queue must be NOREPLICATION");
  });

  it("verifies queue function ownership, security definer mode, search_path, and lack of PUBLIC grants", async () => {
    const signatures = [
      "public.fluxora_claim_next_job(text, integer)",
      "public.fluxora_complete_job(uuid, text)",
      "public.fluxora_fail_job(uuid, text, text)",
      "public.fluxora_retry_failed_job(uuid, text, integer, text)",
    ];

    for (const signature of signatures) {
      const res = await pool.query<{
        owner_name: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        public_execute: boolean;
      }>(
        `
          SELECT
            r.rolname AS owner_name,
            p.prosecdef,
            p.proconfig,
            COALESCE((
              SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
              FROM pg_catalog.aclexplode(p.proacl) AS acl
            ), false) AS public_execute
          FROM pg_proc AS p
          JOIN pg_roles AS r ON r.oid = p.proowner
          WHERE p.oid = $1::regprocedure
        `,
        [signature],
      );

      assert.equal(res.rows.length, 1, `Function ${signature} must exist`);
      const row = res.rows[0];
      assert.ok(row !== undefined, `Function ${signature} row must exist`);
      assert.equal(
        row.owner_name,
        "fluxora_queue",
        `Function ${signature} must be owned by fluxora_queue`,
      );
      assert.equal(row.prosecdef, true, `Function ${signature} must be SECURITY DEFINER`);
      assert.ok(
        row.proconfig?.some((cfg) => cfg === "search_path=pg_catalog, public, pg_temp"),
        `Function ${signature} must have pinned search_path with pg_temp last`,
      );
      assert.equal(
        row.public_execute,
        false,
        `PUBLIC must not have EXECUTE on ${signature}`,
      );
    }
  });

  it("claims queued jobs across different organizations when no tenant GUC is set on worker connection", async () => {
    const jobA = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `claim-test-a-${suffix}`,
        payload: { repo: "repo-a" },
      },
      pool,
    );

    const jobB = await enqueueJob(
      {
        organizationId: orgB.id,
        type: "repository.ingest",
        idempotencyKey: `claim-test-b-${suffix}`,
        payload: { repo: "repo-b" },
      },
      pool,
    );

    assert.equal(jobA.organizationId, orgA.id);
    assert.equal(jobB.organizationId, orgB.id);

    // Claim next job as worker-1 with NO tenant GUC set under non-superuser fluxora_rls_test
    const claimed1 = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed1 !== null, "Worker should claim first pending job");
    assert.equal(claimed1.id, jobA.id);
    assert.equal(claimed1.organizationId, orgA.id);
    assert.equal(claimed1.status, "running");
    assert.equal(claimed1.lockedBy, "worker-1");
    assert.ok(claimed1.leaseExpiresAt !== null);

    // Claim second job across org boundary
    const claimed2 = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed2 !== null, "Worker should claim second job from different org");
    assert.equal(claimed2.id, jobB.id);
    assert.equal(claimed2.organizationId, orgB.id);
    assert.equal(claimed2.status, "running");
    assert.equal(claimed2.lockedBy, "worker-1");

    await completeJob(jobA.id, "worker-1", pool);
    await completeJob(jobB.id, "worker-1", pool);
  });

  it("enforces worker ownership and unexpired lease on completion and failure", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `complete-lease-test-${suffix}`,
        payload: { test: true },
      },
      pool,
    );

    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.id, job.id);

    // Complete with wrong worker ID -> rejected
    await assert.rejects(
      () => completeJob(job.id, "worker-wrong", pool),
      /Job completion rejected/,
    );

    // Fail with wrong worker ID -> rejected
    await assert.rejects(
      () => failJob(job.id, "worker-wrong", "some error", pool),
      /Job failure rejected/,
    );

    // Correct worker completes successfully
    const completed = await completeJob(job.id, "worker-1", pool);
    assert.equal(completed.status, "completed");
    assert.equal(completed.lockedBy, null);
  });

  it("rejects completion and failure when the job lease has expired", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `expired-lease-test-${suffix}`,
        payload: { test: true },
      },
      pool,
    );

    const claimed = await claimNextJob("worker-1", 1, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.id, job.id);

    // Artificially expire the lease in the past
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1`,
      [job.id],
    );

    // Completion after lease expiration must be rejected
    await assert.rejects(
      () => completeJob(job.id, "worker-1", pool),
      /Job completion rejected/,
    );

    // Failure after lease expiration must be rejected
    await assert.rejects(
      () => failJob(job.id, "worker-1", "expired fail", pool),
      /Job failure rejected/,
    );

    // A different worker can re-claim the expired running job
    const reclaimed = await claimNextJob("worker-2", 60, pool);
    assert.ok(reclaimed !== null);
    assert.equal(reclaimed.id, job.id);
    assert.equal(reclaimed.lockedBy, "worker-2");
    assert.equal(reclaimed.attemptCount, 2);

    await completeJob(job.id, "worker-2", pool);
  });

  it("enforces worker identity on retry: a different worker cannot retry a job", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `retry-wrong-worker-${suffix}`,
      },
      pool,
    );

    const claimed = await claimNextJob("worker-owner", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.id, job.id);

    // Different worker tries to retry the running job -> rejected
    await assert.rejects(
      () => retryFailedJob(job.id, "worker-impostor", 5, "retry error", pool),
      /Job retry rejected/,
    );

    // Job remains running and leased to original worker
    const verifyRunning = await pool.query<{ status: string; locked_by: string }>(
      `SELECT status, locked_by FROM jobs WHERE id = $1`,
      [job.id],
    );
    assert.equal(verifyRunning.rows[0]?.status, "running");
    assert.equal(verifyRunning.rows[0]?.locked_by, "worker-owner");

    await completeJob(job.id, "worker-owner", pool);
  });

  it("rejects retry when the lease has expired", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `retry-expired-lease-${suffix}`,
      },
      pool,
    );

    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed !== null);

    // Artificially expire lease
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [job.id],
    );

    // Retry rejected because lease is expired
    await assert.rejects(
      () => retryFailedJob(job.id, "worker-1", 5, "error", pool),
      /Job retry rejected/,
    );

    // Re-claimed by another worker after lease expiration
    const reclaimed = await claimNextJob("worker-2", 60, pool);
    assert.ok(reclaimed !== null);
    assert.equal(reclaimed.id, job.id);
    await completeJob(job.id, "worker-2", pool);
  });

  it("non-retryable failures remain failed/dead-lettered and cannot be retried", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `non-retryable-${suffix}`,
      },
      pool,
    );

    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed !== null);

    // Worker records non-retryable failure via failJob
    const failed = await failJob(job.id, "worker-1", "permanent schema violation", pool);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "permanent schema violation");
    assert.equal(failed.lockedBy, null);
    assert.equal(failed.leaseExpiresAt, null);

    // Attempting to retry a job in failed status via worker retry is rejected
    await assert.rejects(
      () => retryFailedJob(job.id, "worker-1", 5, "retry attempt", pool),
      /Job retry rejected/,
    );
  });

  it("reschedules retryable failure exactly once with future available_at and clears lease", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `atomic-retry-success-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );

    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.attemptCount, 1);

    // Atomic retry transition
    const retried = await retryFailedJob(
      job.id,
      "worker-1",
      30,
      "temporary network glitch",
      pool,
    );

    assert.equal(retried.status, "pending");
    assert.equal(retried.lockedBy, null);
    assert.equal(retried.lockedAt, null);
    assert.equal(retried.leaseExpiresAt, null);
    assert.equal(retried.lastError, "temporary network glitch");
    assert.ok(
      retried.availableAt.getTime() > Date.now() + 20_000,
      "availableAt should be in the future (~30s)",
    );

    // Cannot retry again immediately because status is now 'pending' (not running/leased)
    await assert.rejects(
      () => retryFailedJob(job.id, "worker-1", 10, "second retry", pool),
      /Job retry rejected/,
    );
  });

  it("transitions to dead_letter when retry attempt count reaches max_attempts", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `dead-letter-test-${suffix}`,
        maxAttempts: 1,
      },
      pool,
    );

    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.attemptCount, 1);
    assert.equal(claimed.maxAttempts, 1);

    // Worker attempts retry on exhausted job -> transitions to dead_letter
    const deadLettered = await retryFailedJob(
      job.id,
      "worker-1",
      5,
      "final failure error",
      pool,
    );

    assert.equal(deadLettered.status, "dead_letter");
    assert.equal(deadLettered.lastError, "final failure error");
    assert.ok(deadLettered.failedAt !== null);
    assert.equal(deadLettered.lockedBy, null);
  });

  it("cannot transition invalid job states via retry", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `invalid-state-${suffix}`,
      },
      pool,
    );

    // Job is pending: cannot retry
    await assert.rejects(
      () => retryFailedJob(job.id, "worker-1", 0, undefined, pool),
      /Job retry rejected/,
    );

    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.ok(claimed !== null);
    await completeJob(job.id, "worker-1", pool);

    // Job is completed: cannot retry
    await assert.rejects(
      () => retryFailedJob(job.id, "worker-1", 0, undefined, pool),
      /Job retry rejected/,
    );
  });

  it("prevents the ordinary application role from directly reading or modifying arbitrary jobs without tenant context", async () => {
    const jobA = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `direct-isolation-a-${suffix}`,
      },
      pool,
    );

    const jobB = await enqueueJob(
      {
        organizationId: orgB.id,
        type: "repository.ingest",
        idempotencyKey: `direct-isolation-b-${suffix}`,
      },
      pool,
    );

    const client = await pool.connect();
    try {
      // 1. With NO tenant GUC set (using transaction with SET LOCAL ROLE):
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);

      // Direct SELECT on jobs returns 0 rows due to RLS
      const noTenantSelect = await client.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM jobs`);
      const firstNoTenant = noTenantSelect.rows[0];
      assert.ok(firstNoTenant !== undefined);
      assert.equal(
        firstNoTenant.cnt,
        0,
        "Ordinary role must see 0 jobs without tenant context",
      );

      // Direct UPDATE on jobs updates 0 rows
      const noTenantUpdate = await client.query(
        `UPDATE jobs SET status = 'completed' WHERE id = $1`,
        [jobA.id],
      );
      assert.equal(
        noTenantUpdate.rowCount,
        0,
        "Ordinary role must not update jobs without tenant context",
      );
      await client.query("ROLLBACK");

      // 2. With tenant GUC set to Org A:
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA.id]);

      // Can see Org A's job
      const orgASelect = await client.query<{ id: string }>(
        `SELECT id FROM jobs WHERE id = $1`,
        [jobA.id],
      );
      assert.equal(orgASelect.rows.length, 1);
      const firstOrgA = orgASelect.rows[0];
      assert.ok(firstOrgA !== undefined);
      assert.equal(firstOrgA.id, jobA.id);

      // CANNOT see Org B's job
      const crossOrgSelect = await client.query(
        `SELECT id FROM jobs WHERE id = $1`,
        [jobB.id],
      );
      assert.equal(crossOrgSelect.rows.length, 0, "Org B job must be invisible to Org A");

      // CANNOT update Org B's job
      const crossOrgUpdate = await client.query(
        `UPDATE jobs SET status = 'completed' WHERE id = $1`,
        [jobB.id],
      );
      assert.equal(crossOrgUpdate.rowCount, 0, "Org A cannot update Org B job");

      // CANNOT insert job for Org B while in Org A context
      await assert.rejects(
        () =>
          client.query(
            `
              INSERT INTO jobs (organization_id, type, idempotency_key)
              VALUES ($1, 'repository.ingest', $2)
            `,
            [orgB.id, `cross-insert-${suffix}`],
          ),
        /violates row-level security policy/,
      );

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("preserves tenant isolation across existing repository reads and writes", async () => {
    const jobA = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `repo-iso-a-${suffix}`,
        payload: { repo: "a" },
      },
      pool,
    );

    const jobB = await enqueueJob(
      {
        organizationId: orgB.id,
        type: "repository.ingest",
        idempotencyKey: `repo-iso-b-${suffix}`,
        payload: { repo: "b" },
      },
      pool,
    );

    // Org A can read its own job
    const readA = await getJobById(orgA.id, jobA.id, pool);
    assert.ok(readA !== null);
    assert.equal(readA.id, jobA.id);

    // Org B CANNOT read Org A's job
    const crossReadA = await getJobById(orgB.id, jobA.id, pool);
    assert.equal(crossReadA, null, "Org B must not read Org A's job");

    // Org A CANNOT read Org B's job
    const crossReadB = await getJobById(orgA.id, jobB.id, pool);
    assert.equal(crossReadB, null, "Org A must not read Org B's job");
  });

  it("crash recovery (single allowed attempt): expired job with max_attempts=1 is dead-lettered and not reclaimed", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `crash-rec-1-${suffix}`,
        maxAttempts: 1,
      },
      pool,
    );

    // Initial claim
    const claimed = await claimNextJob("worker-crashed", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.attemptCount, 1);
    assert.equal(claimed.status, "running");

    // Simulate worker crash: expire lease in the past without calling failJob or retryFailedJob
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [job.id],
    );

    // Claim attempt by next worker: must not reclaim the expired job because attempt limit is exhausted
    const nextClaim = await claimNextJob("worker-recovering", 60, pool);
    assert.equal(nextClaim, null, "Exhausted expired job must not be claimed");

    // Verify terminal dead_letter status and metadata cleanup in the database
    const rowRes = await pool.query<{
      status: string;
      attempt_count: number;
      max_attempts: number;
      locked_by: string | null;
      locked_at: Date | null;
      lease_expires_at: Date | null;
      failed_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT status, attempt_count, max_attempts, locked_by, locked_at, lease_expires_at, failed_at, last_error FROM jobs WHERE id = $1`,
      [job.id],
    );
    const row = rowRes.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.status, "dead_letter");
    assert.equal(row.attempt_count, 1, "attempt_count must not exceed max_attempts");
    assert.equal(row.locked_by, null, "locked_by must be cleared");
    assert.equal(row.locked_at, null, "locked_at must be cleared");
    assert.equal(row.lease_expires_at, null, "lease_expires_at must be cleared");
    assert.ok(row.failed_at !== null, "failed_at must be recorded");
    assert.match(row.last_error ?? "", /lease expired after retry limit/i);
  });

  it("crash recovery (two allowed attempts): reclaims once on first crash, then dead-letters on second crash without exceeding max_attempts", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `crash-rec-2-${suffix}`,
        maxAttempts: 2,
      },
      pool,
    );

    // Attempt 1: First claim
    const claim1 = await claimNextJob("worker-1", 60, pool);
    assert.ok(claim1 !== null);
    assert.equal(claim1.id, job.id);
    assert.equal(claim1.attemptCount, 1);

    // Simulate first worker crash: expire lease in the past
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [job.id],
    );

    // Attempt 2: Second claim should succeed with attempt_count = 2
    const claim2 = await claimNextJob("worker-2", 60, pool);
    assert.ok(claim2 !== null, "Second worker should reclaim the expired job");
    assert.equal(claim2.id, job.id);
    assert.equal(claim2.attemptCount, 2);
    assert.equal(claim2.lockedBy, "worker-2");
    assert.equal(claim2.status, "running");

    // Simulate second worker crash: expire lease in the past
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [job.id],
    );

    // Attempt 3: Third claim must return null and dead-letter the job without incrementing attempt_count
    const claim3 = await claimNextJob("worker-3", 60, pool);
    assert.equal(claim3, null, "Exhausted job must not be claimed on third attempt");

    const rowRes = await pool.query<{
      status: string;
      attempt_count: number;
      locked_by: string | null;
      lease_expires_at: Date | null;
      failed_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT status, attempt_count, locked_by, lease_expires_at, failed_at, last_error FROM jobs WHERE id = $1`,
      [job.id],
    );
    const row = rowRes.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.status, "dead_letter");
    assert.equal(row.attempt_count, 2, "attempt_count must remain exactly 2 (never 3)");
    assert.equal(row.locked_by, null);
    assert.equal(row.lease_expires_at, null);
    assert.ok(row.failed_at !== null);
    assert.match(row.last_error ?? "", /lease expired after retry limit/i);
  });

  it("crash recovery (attempts remaining): an expired job below its limit is reclaimed exactly once", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `crash-rem-3-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );

    // Initial claim: attempt 1
    const claim1 = await claimNextJob("worker-1", 60, pool);
    assert.ok(claim1 !== null);
    assert.equal(claim1.attemptCount, 1);

    // Expire lease
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [job.id],
    );

    // Claim next: attempt 2 reclaimed
    const claim2 = await claimNextJob("worker-2", 60, pool);
    assert.ok(claim2 !== null);
    assert.equal(claim2.id, job.id);
    assert.equal(claim2.attemptCount, 2);
    assert.equal(claim2.lockedBy, "worker-2");

    // Clean completion
    await completeJob(job.id, "worker-2", pool);
  });

  it("crash recovery (exhausted pending row): a pending row already at or above max_attempts is not claimed and safely dead-lettered", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `exhausted-pending-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );

    // Artificially simulate inconsistent legacy or manually modified pending row at max_attempts
    await pool.query(
      `UPDATE jobs SET attempt_count = 3, status = 'pending' WHERE id = $1`,
      [job.id],
    );

    // Claim: must not claim this row and must dead-letter it
    const claimed = await claimNextJob("worker-1", 60, pool);
    assert.equal(claimed, null, "Exhausted pending row must never be returned to worker");

    const rowRes = await pool.query<{
      status: string;
      attempt_count: number;
      failed_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT status, attempt_count, failed_at, last_error FROM jobs WHERE id = $1`,
      [job.id],
    );
    const row = rowRes.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.status, "dead_letter");
    assert.equal(row.attempt_count, 3, "attempt_count must not be incremented past limit");
    assert.ok(row.failed_at !== null);
    assert.match(row.last_error ?? "", /exceeded retry limit while pending/i);
  });

  it("crash recovery (active lease): a running job with an unexpired lease and exhausted attempts is not recovered or stolen", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `active-lease-exhausted-${suffix}`,
        maxAttempts: 1,
      },
      pool,
    );

    // Worker claims initial attempt (lease expires in 60 seconds)
    const claimed = await claimNextJob("worker-owner", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.attemptCount, 1);

    // Another worker calls claim while the lease is still active
    const otherClaim = await claimNextJob("worker-intruder", 60, pool);
    assert.equal(otherClaim, null, "Job with active lease must not be claimed or dead-lettered");

    // Verify job is still running and owned by worker-owner
    const rowRes = await pool.query<{ status: string; locked_by: string; attempt_count: number }>(
      `SELECT status, locked_by, attempt_count FROM jobs WHERE id = $1`,
      [job.id],
    );
    const row = rowRes.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.status, "running");
    assert.equal(row.locked_by, "worker-owner");
    assert.equal(row.attempt_count, 1);

    // Original owner can complete normally
    await completeJob(job.id, "worker-owner", pool);
  });

  it("crash recovery (metadata cleanup): dead-lettered crashed jobs have all lock and lease fields cleared with terminal timestamps", async () => {
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `meta-cleanup-${suffix}`,
        maxAttempts: 1,
      },
      pool,
    );

    await claimNextJob("worker-crash-cleanup", 60, pool);

    // Expire lease
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '15 seconds' WHERE id = $1`,
      [job.id],
    );

    // Trigger cleanup via claimNextJob
    await claimNextJob("worker-sweeper", 60, pool);

    const rowRes = await pool.query<{
      status: string;
      locked_at: Date | null;
      locked_by: string | null;
      lease_expires_at: Date | null;
      failed_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT status, locked_at, locked_by, lease_expires_at, failed_at, last_error FROM jobs WHERE id = $1`,
      [job.id],
    );
    const row = rowRes.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.status, "dead_letter");
    assert.equal(row.locked_at, null);
    assert.equal(row.locked_by, null);
    assert.equal(row.lease_expires_at, null);
    assert.ok(row.failed_at instanceof Date);
    assert.ok(typeof row.last_error === "string" && row.last_error.length > 0);
  });

  it("crash recovery (retry path regression): standard failure, retry, and completion remain operational", async () => {
    // 1. Permanent failure
    const failJobItem = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `regression-fail-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );
    await claimNextJob("worker-std", 60, pool);
    const failed = await failJob(failJobItem.id, "worker-std", "explicit failure", pool);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "explicit failure");

    // 2. Normal retryable failure
    const retryJobItem = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `regression-retry-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );
    await claimNextJob("worker-std", 60, pool);
    const retried = await retryFailedJob(retryJobItem.id, "worker-std", 0, "transient error", pool);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attemptCount, 1);

    // 3. Complete retried job on next claim
    const reclaimed = await claimNextJob("worker-std-2", 60, pool);
    assert.ok(reclaimed !== null);
    assert.equal(reclaimed.id, retryJobItem.id);
    assert.equal(reclaimed.attemptCount, 2);
    const completed = await completeJob(retryJobItem.id, "worker-std-2", pool);
    assert.equal(completed.status, "completed");
  });

  it("crash recovery (concurrency): concurrent claimers never both receive the same valid claim or an exhausted job", async () => {
    // Job 1: exhausted expired job
    const jobExhausted = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `concur-exhausted-${suffix}`,
        maxAttempts: 1,
      },
      pool,
    );
    await claimNextJob("worker-init-1", 60, pool);
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [jobExhausted.id],
    );

    // Job 2: valid pending job
    const jobValid = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `concur-valid-${suffix}`,
        maxAttempts: 2,
      },
      pool,
    );

    // Run 3 concurrent claim operations
    const results = await Promise.all([
      claimNextJob("concurrent-w1", 60, pool),
      claimNextJob("concurrent-w2", 60, pool),
      claimNextJob("concurrent-w3", 60, pool),
    ]);

    const nonNullClaims = results.filter((j) => j !== null);
    assert.equal(nonNullClaims.length, 1, "Exactly one worker must claim the valid job");
    const claimedValid = nonNullClaims[0];
    assert.ok(claimedValid !== undefined && claimedValid.lockedBy !== null);
    assert.equal(claimedValid.id, jobValid.id);
    assert.equal(claimedValid.attemptCount, 1);

    // Verify exhausted job was dead-lettered and never returned to any worker
    const deadLetterRes = await pool.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM jobs WHERE id = $1`,
      [jobExhausted.id],
    );
    assert.equal(deadLetterRes.rows[0]?.status, "dead_letter");
    assert.equal(deadLetterRes.rows[0]?.attempt_count, 1);

    await completeJob(jobValid.id, claimedValid.lockedBy, pool);
  });

  it("crash recovery (tenant and role security): cross-tenant queue claims work under non-superuser role while tenant boundaries are enforced", async () => {
    const jobA = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `cross-tenant-crash-a-${suffix}`,
        maxAttempts: 1,
      },
      pool,
    );

    // Claim under non-superuser RLS_TEST_ROLE without tenant context
    const claimedA = await claimNextJob("worker-cross-1", 60, pool);
    assert.ok(claimedA !== null);
    assert.equal(claimedA.organizationId, orgA.id);

    // Expire lease
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [jobA.id],
    );

    // Next worker claims under non-superuser role -> dead-letters expired job across tenant boundary safely
    const claimNothing = await claimNextJob("worker-cross-2", 60, pool);
    assert.equal(claimNothing, null);

    const rowRes = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1`,
      [jobA.id],
    );
    assert.equal(rowRes.rows[0]?.status, "dead_letter");
  });

  it("crash recovery (invariant enforcement): attempt_count never exceeds max_attempts across any crash and recovery cycle", async () => {
    for (const maxAttempts of [1, 2, 3]) {
      const job = await enqueueJob(
        {
          organizationId: orgA.id,
          type: "repository.ingest",
          idempotencyKey: `overflow-check-${maxAttempts}-${suffix}`,
          maxAttempts,
        },
        pool,
      );

      // Perform maxAttempts claims with simulated crashes
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const claimed = await claimNextJob(`worker-inv-${maxAttempts}-${attempt}`, 60, pool);
        assert.ok(claimed !== null, `Claim at attempt ${attempt} of ${maxAttempts} must succeed`);
        assert.equal(claimed.attemptCount, attempt, `attemptCount must equal ${attempt}`);
        assert.ok(
          claimed.attemptCount <= claimed.maxAttempts,
          `attemptCount (${claimed.attemptCount}) must not exceed maxAttempts (${claimed.maxAttempts})`,
        );

        // Expire lease
        await pool.query(
          `UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1`,
          [job.id],
        );
      }

      // Next claim after all attempts exhausted: MUST return null and dead-letter
      const overflowClaim = await claimNextJob(`worker-inv-${maxAttempts}-overflow`, 60, pool);
      assert.equal(overflowClaim, null, "Exhausted job must not be claimed after limit reached");

      // Check database row
      const rowRes = await pool.query<{ status: string; attempt_count: number; max_attempts: number }>(
        `SELECT status, attempt_count, max_attempts FROM jobs WHERE id = $1`,
        [job.id],
      );
      const row = rowRes.rows[0];
      assert.ok(row !== undefined);
      assert.equal(row.status, "dead_letter");
      assert.equal(
        row.attempt_count,
        maxAttempts,
        `Final attempt_count must be exactly ${maxAttempts}`,
      );
      assert.ok(
        row.attempt_count <= row.max_attempts,
        `Invariant 0 <= attempt_count <= max_attempts violated! attempt_count=${row.attempt_count}, max_attempts=${row.max_attempts}`,
      );
    }
  });

  it("claim parameter validation: rejects invalid worker_id and lease_seconds in PostgreSQL without mutating any rows or attempt counts", async () => {
    // 1. Create and claim running job, then expire its lease
    const runningJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `param-running-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );
    const claimedRunning = await claimNextJob("worker-initial", 60, pool);
    assert.ok(claimedRunning !== null);
    assert.equal(claimedRunning.id, runningJob.id);
    assert.equal(claimedRunning.attemptCount, 1);

    // Expire the lease on runningJob so that a claim call without parameter validation would attempt cleanup
    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1`,
      [runningJob.id],
    );

    // 2. Create a valid pending job
    const pendingJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `param-pending-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );

    // Helper to verify both jobs are completely unchanged
    const assertNoMutations = async () => {
      const pRes = await pool.query<{ status: string; attempt_count: number; locked_by: string | null }>(
        `SELECT status, attempt_count, locked_by FROM jobs WHERE id = $1`,
        [pendingJob.id],
      );
      assert.equal(pRes.rows[0]?.status, "pending");
      assert.equal(pRes.rows[0]?.attempt_count, 0);
      assert.equal(pRes.rows[0]?.locked_by, null);

      const rRes = await pool.query<{ status: string; attempt_count: number; locked_by: string | null }>(
        `SELECT status, attempt_count, locked_by FROM jobs WHERE id = $1`,
        [runningJob.id],
      );
      assert.equal(rRes.rows[0]?.status, "running");
      assert.equal(rRes.rows[0]?.attempt_count, 1);
      assert.equal(rRes.rows[0]?.locked_by, "worker-initial");
    };

    // Test rejection for invalid worker_id
    const invalidWorkers = ["", "   ", "\t  \n"];
    for (const invalidWorker of invalidWorkers) {
      await assert.rejects(
        () => pool.query(`SELECT * FROM public.fluxora_claim_next_job($1, 60)`, [invalidWorker]),
        (err: Error) => {
          assert.match(err.message, /p_worker_id must be a non-empty, non-whitespace string/);
          return true;
        },
      );
      await assertNoMutations();
    }

    await assert.rejects(
      () => pool.query(`SELECT * FROM public.fluxora_claim_next_job(NULL, 60)`),
      (err: Error) => {
        assert.match(err.message, /p_worker_id must be a non-empty, non-whitespace string/);
        return true;
      },
    );
    await assertNoMutations();

    // Test rejection for invalid lease_seconds
    const invalidLeases = [0, -1, -60];
    for (const invalidLease of invalidLeases) {
      await assert.rejects(
        () => pool.query(`SELECT * FROM public.fluxora_claim_next_job('valid-worker', $1)`, [invalidLease]),
        (err: Error) => {
          assert.match(err.message, /p_lease_seconds must be a positive integer/);
          return true;
        },
      );
      await assertNoMutations();
    }

    await assert.rejects(
      () => pool.query(`SELECT * FROM public.fluxora_claim_next_job('valid-worker', NULL)`),
      (err: Error) => {
        assert.match(err.message, /p_lease_seconds must be a positive integer/);
        return true;
      },
    );
    await assertNoMutations();
  });

  it("attempt-count upper-bound invariant: CHECK constraint prevents writing or updating rows where attempt_count > max_attempts", async () => {
    // 1. Direct INSERT with attempt_count > max_attempts must fail with CHECK constraint violation
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO jobs (organization_id, type, idempotency_key, attempt_count, max_attempts)
           VALUES ($1, 'repository.ingest', 'over-limit-insert-${suffix}', 4, 3)`,
          [orgA.id],
        ),
      (err: Error) => {
        assert.match(err.message, /jobs_attempt_count_le_max_attempts/);
        return true;
      },
    );

    // 2. Normal enqueue succeeds
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `over-limit-update-${suffix}`,
        maxAttempts: 3,
      },
      pool,
    );

    // 3. Direct UPDATE attempting to exceed max_attempts must fail
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE jobs SET attempt_count = 5 WHERE id = $1`,
          [job.id],
        ),
      (err: Error) => {
        assert.match(err.message, /jobs_attempt_count_le_max_attempts/);
        return true;
      },
    );

    // 4. Updating attempt_count within limits succeeds
    await pool.query(
      `UPDATE jobs SET attempt_count = 3 WHERE id = $1`,
      [job.id],
    );
    const updated = await pool.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM jobs WHERE id = $1`,
      [job.id],
    );
    assert.equal(updated.rows[0]?.attempt_count, 3);
  });

  it("attempt-count bounds: existing non-negative and positive-limit constraints remain intact", async () => {
    // Non-negative constraint: attempt_count < 0 must fail
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO jobs (organization_id, type, idempotency_key, attempt_count, max_attempts)
           VALUES ($1, 'repository.ingest', 'negative-attempt-${suffix}', -1, 3)`,
          [orgA.id],
        ),
      (err: Error) => {
        assert.match(err.message, /jobs_attempt_count_check/);
        return true;
      },
    );

    // Positive-limit constraint: max_attempts <= 0 must fail
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO jobs (organization_id, type, idempotency_key, attempt_count, max_attempts)
           VALUES ($1, 'repository.ingest', 'zero-max-attempts-${suffix}', 0, 0)`,
          [orgA.id],
        ),
      (err: Error) => {
        assert.match(err.message, /jobs_max_attempts_check/);
        return true;
      },
    );
  });

  it("queue lifecycle operations under invariant: claim, retry, completion, and crash-recovery preserve 0 <= attempt_count <= max_attempts", async () => {
    // 1. Enqueue job with maxAttempts = 2
    const job = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `lifecycle-inv-${suffix}`,
        maxAttempts: 2,
      },
      pool,
    );
    assert.equal(job.attemptCount, 0);
    assert.ok(job.attemptCount <= job.maxAttempts);

    // 2. Claim attempt 1
    const claimed1 = await claimNextJob("worker-life-1", 60, pool);
    assert.ok(claimed1 !== null && claimed1.id === job.id);
    assert.equal(claimed1.attemptCount, 1);
    assert.ok(claimed1.attemptCount <= claimed1.maxAttempts);

    // 3. Fail and retry
    const retried = await retryFailedJob(job.id, "worker-life-1", 0, "Transient error", pool);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attemptCount, 1);
    assert.ok(retried.attemptCount <= retried.maxAttempts);

    // 4. Claim attempt 2 (final attempt)
    const claimed2 = await claimNextJob("worker-life-2", 60, pool);
    assert.ok(claimed2 !== null && claimed2.id === job.id);
    assert.equal(claimed2.attemptCount, 2);
    assert.ok(claimed2.attemptCount <= claimed2.maxAttempts);

    // 5. Complete job
    const completed = await completeJob(job.id, "worker-life-2", pool);
    assert.equal(completed.status, "completed");
    assert.equal(completed.attemptCount, 2);
    assert.ok(completed.attemptCount <= completed.maxAttempts);
  });
  it("configured-max-attempts: normal enqueue stores requested configured limit and maps correctly", async () => {
    // 1. Default limits
    const defaultJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `cfg-default-${suffix}`,
      },
      pool,
    );
    assert.equal(defaultJob.maxAttempts, 3);
    assert.equal(defaultJob.configuredMaxAttempts, 3);

    const defaultRow = (
      await pool.query<{ max_attempts: number; configured_max_attempts: number }>(
        "SELECT max_attempts, configured_max_attempts FROM jobs WHERE id = $1",
        [defaultJob.id],
      )
    ).rows[0];
    assert.equal(defaultRow?.max_attempts, 3);
    assert.equal(defaultRow?.configured_max_attempts, 3);

    // 2. Explicit maxAttempts
    const customJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `cfg-custom-${suffix}`,
        maxAttempts: 5,
      },
      pool,
    );
    assert.equal(customJob.maxAttempts, 5);
    assert.equal(customJob.configuredMaxAttempts, 5);

    // 3. Explicit configuredMaxAttempts
    const explicitCfgJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `cfg-explicit-${suffix}`,
        configuredMaxAttempts: 4,
      },
      pool,
    );
    assert.equal(explicitCfgJob.maxAttempts, 4);
    assert.equal(explicitCfgJob.configuredMaxAttempts, 4);

    // 4. getJobById maps configuredMaxAttempts
    const fetched = await getJobById(orgA.id, explicitCfgJob.id, pool);
    assert.ok(fetched !== null);
    assert.equal(fetched.maxAttempts, 4);
    assert.equal(fetched.configuredMaxAttempts, 4);

    // 5. claimNextJob returns configuredMaxAttempts
    const claimed = await claimNextJob("worker-cfg-test", 60, pool);
    assert.ok(claimed !== null);
    assert.equal(claimed.configuredMaxAttempts, claimed.maxAttempts);

    // 6. CHECK constraint rejects configured_max_attempts <= 0
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO jobs (organization_id, type, idempotency_key, attempt_count, max_attempts, configured_max_attempts)
           VALUES ($1, 'repository.ingest', 'zero-cfg-attempts-${suffix}', 0, 3, 0)`,
          [orgA.id],
        ),
      (err: Error) => {
        assert.match(err.message, /jobs_configured_max_attempts_check/);
        return true;
      },
    );
  });
  it("configured-max-attempts: input validation handles matching, conflicting, invalid, and backward-compatible parameters", async () => {
    const testSuffix = `val-${Date.now()}`;

    // 1. Matching values are accepted
    const matchingJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `match-${testSuffix}`,
        maxAttempts: 4,
        configuredMaxAttempts: 4,
      },
      pool,
    );
    assert.equal(matchingJob.maxAttempts, 4);
    assert.equal(matchingJob.configuredMaxAttempts, 4);

    // 2. Conflicting values are rejected
    await assert.rejects(
      () =>
        enqueueJob(
          {
            organizationId: orgA.id,
            type: "repository.ingest",
            idempotencyKey: `conflict-${testSuffix}`,
            maxAttempts: 5,
            configuredMaxAttempts: 2,
          },
          pool,
        ),
      (err: Error) => {
        assert.match(err.message, /job maxAttempts and configuredMaxAttempts must match when both are provided/);
        return true;
      },
    );

    // 3. Invalid maxAttempts rejected
    for (const invalidVal of [0, -1, 1.5]) {
      await assert.rejects(
        () =>
          enqueueJob(
            {
              organizationId: orgA.id,
              type: "repository.ingest",
              idempotencyKey: `inv-max-${invalidVal}-${testSuffix}`,
              maxAttempts: invalidVal,
            },
            pool,
          ),
        (err: Error) => {
          assert.match(err.message, /job maxAttempts must be a positive integer/);
          return true;
        },
      );
    }

    // 4. Invalid configuredMaxAttempts rejected
    for (const invalidVal of [0, -2, 2.5]) {
      await assert.rejects(
        () =>
          enqueueJob(
            {
              organizationId: orgA.id,
              type: "repository.ingest",
              idempotencyKey: `inv-cfg-${invalidVal}-${testSuffix}`,
              configuredMaxAttempts: invalidVal,
            },
            pool,
          ),
        (err: Error) => {
          assert.match(err.message, /job configuredMaxAttempts must be a positive integer/);
          return true;
        },
      );
    }

    // 5. Backward compatibility: caller provides only maxAttempts
    const onlyMaxJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `only-max-${testSuffix}`,
        maxAttempts: 6,
      },
      pool,
    );
    assert.equal(onlyMaxJob.maxAttempts, 6);
    assert.equal(onlyMaxJob.configuredMaxAttempts, 6);

    // 6. Caller provides only configuredMaxAttempts
    const onlyCfgJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `only-cfg-${testSuffix}`,
        configuredMaxAttempts: 6,
      },
      pool,
    );
    assert.equal(onlyCfgJob.maxAttempts, 6);
    assert.equal(onlyCfgJob.configuredMaxAttempts, 6);

    // 7. Default behavior: neither provided
    const defaultJob = await enqueueJob(
      {
        organizationId: orgA.id,
        type: "repository.ingest",
        idempotencyKey: `neither-${testSuffix}`,
      },
      pool,
    );
    assert.equal(defaultJob.maxAttempts, 3);
    assert.equal(defaultJob.configuredMaxAttempts, 3);
  });

  it("configured-max-attempts: direct SQL inserts and immutability guard trigger", async () => {
    const testSuffix = `trig-${Date.now()}`;

    // 1. Direct SQL insert with only max_attempts sets configured_max_attempts to same value (not silent 3)
    const singleMaxRes = await pool.query<{ max_attempts: number; configured_max_attempts: number }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, max_attempts)
       VALUES ($1, 'repository.ingest', 'direct-only-max-${testSuffix}', 5)
       RETURNING max_attempts, configured_max_attempts`,
      [orgA.id],
    );
    assert.equal(singleMaxRes.rows[0]?.max_attempts, 5);
    assert.equal(singleMaxRes.rows[0]?.configured_max_attempts, 5);

    // 2. Direct SQL insert with only configured_max_attempts sets max_attempts to same value (not silent 3)
    const singleCfgRes = await pool.query<{ max_attempts: number; configured_max_attempts: number }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, configured_max_attempts)
       VALUES ($1, 'repository.ingest', 'direct-only-cfg-${testSuffix}', 4)
       RETURNING max_attempts, configured_max_attempts`,
      [orgA.id],
    );
    assert.equal(singleCfgRes.rows[0]?.max_attempts, 4);
    assert.equal(singleCfgRes.rows[0]?.configured_max_attempts, 4);

    // 3. Direct SQL insert with neither sets both to 3
    const neitherRes = await pool.query<{ max_attempts: number; configured_max_attempts: number }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key)
       VALUES ($1, 'repository.ingest', 'direct-neither-${testSuffix}')
       RETURNING max_attempts, configured_max_attempts`,
      [orgA.id],
    );
    assert.equal(neitherRes.rows[0]?.max_attempts, 3);
    assert.equal(neitherRes.rows[0]?.configured_max_attempts, 3);

    // 4. Direct SQL insert with conflicting limits is rejected by trigger
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
           VALUES ($1, 'repository.ingest', 'direct-conflict-${testSuffix}', 5, 2)`,
          [orgA.id],
        ),
      (err: Error) => {
        assert.match(err.message, /must match on new jobs/);
        return true;
      },
    );

    // 5. Direct SQL update trying to mutate configured_max_attempts is rejected
    const updateTargetRes = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
       VALUES ($1, 'repository.ingest', 'direct-immutable-${testSuffix}', 3, 3)
       RETURNING id`,
      [orgA.id],
    );
    const targetId = updateTargetRes.rows[0]?.id;

    await assert.rejects(
      () =>
        pool.query(
          `UPDATE jobs SET configured_max_attempts = 10 WHERE id = $1`,
          [targetId],
        ),
      (err: Error) => {
        assert.match(err.message, /configured_max_attempts is immutable/);
        return true;
      },
    );
  });

  it("configured-max-attempts: reconciled legacy fixtures preserve configured limit across complete, fail, and retry", async () => {
    const testSuffix = `rec-${Date.now()}`;

    // Fixture 1: Active running job with elevated operational limit (configured_max_attempts = 2, max_attempts = 5, attempt_count = 5)
    // Created via standard insert, then operational max_attempts elevated (simulating migration 0023 legacy reconciliation)
    const fix1Res = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-complete-${testSuffix}', 'running', 2, 2, 2, 'worker-rec-1', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    const fix1Id = fix1Res.rows[0]?.id;
    await pool.query(
      `UPDATE jobs SET attempt_count = 5, max_attempts = 5 WHERE id = $1`,
      [fix1Id],
    );

    // Complete job returns original configured limit
    const completedJob = await completeJob(fix1Id!, "worker-rec-1", pool);
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.attemptCount, 5);
    assert.equal(completedJob.maxAttempts, 5);
    assert.equal(completedJob.configuredMaxAttempts, 2, "completeJob must return original configured_max_attempts");

    // Fixture 2: Running job with elevated operational limit failing past limit -> dead_letter
    const fix2Res = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-fail-dl-${testSuffix}', 'running', 2, 2, 2, 'worker-rec-2', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    const fix2Id = fix2Res.rows[0]?.id;
    await pool.query(
      `UPDATE jobs SET attempt_count = 4, max_attempts = 4 WHERE id = $1`,
      [fix2Id],
    );

    const deadLetterJob = await failJob(fix2Id!, "worker-rec-2", "terminal crash", pool);
    assert.equal(deadLetterJob.status, "dead_letter");
    assert.equal(deadLetterJob.attemptCount, 4);
    assert.equal(deadLetterJob.maxAttempts, 4);
    assert.equal(deadLetterJob.configuredMaxAttempts, 2, "failJob must return original configured_max_attempts on dead-letter transition");

    // Fixture 3: Running job with elevated operational limit failing with attempts remaining -> failed
    const fix3Res = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-fail-transient-${testSuffix}', 'running', 1, 1, 1, 'worker-rec-3', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    const fix3Id = fix3Res.rows[0]?.id;
    await pool.query(
      `UPDATE jobs SET attempt_count = 2, max_attempts = 4 WHERE id = $1`,
      [fix3Id],
    );

    const failedJob = await failJob(fix3Id!, "worker-rec-3", "transient failure", pool);
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.attemptCount, 2);
    assert.equal(failedJob.maxAttempts, 4);
    assert.equal(failedJob.configuredMaxAttempts, 1, "failJob must return original configured_max_attempts on failed transition");

    // Fixture 4: Running job with elevated operational limit that is retried -> pending
    const fix4Res = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-retry-pending-${testSuffix}', 'running', 1, 1, 1, 'worker-rec-4', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    const fix4Id = fix4Res.rows[0]?.id;
    await pool.query(
      `UPDATE jobs SET attempt_count = 2, max_attempts = 4 WHERE id = $1`,
      [fix4Id],
    );

    const retriedJob = await retryFailedJob(fix4Id!, "worker-rec-4", 15, "retry reason", pool);
    assert.equal(retriedJob.status, "pending");
    assert.equal(retriedJob.attemptCount, 2);
    assert.equal(retriedJob.maxAttempts, 4);
    assert.equal(retriedJob.configuredMaxAttempts, 1, "retryFailedJob must return original configured_max_attempts on pending transition");

    // Fixture 5: Running job with elevated operational limit that is retried at or above limit -> dead_letter
    const fix5Res = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-retry-dl-${testSuffix}', 'running', 2, 2, 2, 'worker-rec-5', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    const fix5Id = fix5Res.rows[0]?.id;
    await pool.query(
      `UPDATE jobs SET attempt_count = 5, max_attempts = 5 WHERE id = $1`,
      [fix5Id],
    );

    const retriedDlJob = await retryFailedJob(fix5Id!, "worker-rec-5", 15, "retry at limit", pool);
    assert.equal(retriedDlJob.status, "dead_letter");
    assert.equal(retriedDlJob.attemptCount, 5);
    assert.equal(retriedDlJob.maxAttempts, 5);
    assert.equal(retriedDlJob.configuredMaxAttempts, 2, "retryFailedJob must return original configured_max_attempts on dead-letter transition");

    // Fixture 6: Legacy historical job with unknown configured limit (configured_max_attempts IS NULL)
    // Simulates legacy row backfilled with NULL by migration 0024
    await pool.query("ALTER TABLE jobs DISABLE TRIGGER jobs_retry_limits_guard_trigger");
    const fixNullRes = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-null-${testSuffix}', 'running', 3, 3, NULL, 'worker-rec-null', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    await pool.query("ALTER TABLE jobs ENABLE TRIGGER jobs_retry_limits_guard_trigger");
    const fixNullId = fixNullRes.rows[0]?.id;

    // 1. getJobById preserves configuredMaxAttempts = null (does not silently substitute operational limit)
    const fetchedNull = await getJobById(orgA.id, fixNullId!, pool);
    assert.equal(fetchedNull?.configuredMaxAttempts, null, "getJobById must preserve null configuredMaxAttempts");
    assert.equal(fetchedNull?.maxAttempts, 3, "operational maxAttempts must remain intact");

    // 2. completeJob preserves configuredMaxAttempts = null
    const completedNull = await completeJob(fixNullId!, "worker-rec-null", pool);
    assert.equal(completedNull.configuredMaxAttempts, null, "completeJob must preserve null configuredMaxAttempts");
    assert.equal(completedNull.maxAttempts, 3);

    // 3. Normal update cannot replace an unknown historical value (NULL) with a non-null limit
    await assert.rejects(
      () => pool.query(`UPDATE jobs SET configured_max_attempts = 5 WHERE id = $1`, [fixNullId]),
      (err: Error) => {
        assert.match(err.message, /configured_max_attempts is immutable/);
        return true;
      },
    );

    // Fixture 7: Legacy historical job with configured_max_attempts IS NULL failing and retried
    await pool.query("ALTER TABLE jobs DISABLE TRIGGER jobs_retry_limits_guard_trigger");
    const fixFailNullRes = await pool.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempt_count, max_attempts, configured_max_attempts, locked_by, lease_expires_at)
       VALUES ($1, 'repository.ingest', 'rec-fail-null-${testSuffix}', 'running', 1, 3, NULL, 'worker-rec-fail-null', now() + interval '300 seconds')
       RETURNING id`,
      [orgA.id],
    );
    await pool.query("ALTER TABLE jobs ENABLE TRIGGER jobs_retry_limits_guard_trigger");
    const fixFailNullId = fixFailNullRes.rows[0]?.id;

    // 4. failJob preserves configuredMaxAttempts = null
    const failedNull = await failJob(fixFailNullId!, "worker-rec-fail-null", "test error", pool);
    assert.equal(failedNull.configuredMaxAttempts, null, "failJob must preserve null configuredMaxAttempts");
    assert.equal(failedNull.maxAttempts, 3);

    // 5. retryFailedJob preserves configuredMaxAttempts = null
    // Reset to running to test retryFailedJob
    await pool.query(
      `UPDATE jobs SET status = 'running', locked_by = 'worker-rec-fail-null', lease_expires_at = now() + interval '300 seconds' WHERE id = $1`,
      [fixFailNullId],
    );
    const retriedNull = await retryFailedJob(fixFailNullId!, "worker-rec-fail-null", 10, "transient error", pool);
    assert.equal(retriedNull.configuredMaxAttempts, null, "retryFailedJob must preserve null configuredMaxAttempts");
    assert.equal(retriedNull.maxAttempts, 3);
  });
});
