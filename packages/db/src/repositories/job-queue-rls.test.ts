import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll, vi } from "vitest";
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
});
