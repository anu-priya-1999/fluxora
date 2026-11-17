import pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";
import { runMigrations } from "../migrate/runner.ts";
import { closePool, getPool } from "../pool.ts";

loadRootEnvFile();

export const APPROVED_TEST_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
] as const;

export function isApprovedTestHost(hostname: string): boolean {
  const norm = hostname.replace(/^\[|\]$/g, "").toLowerCase().trim();
  return (APPROVED_TEST_HOSTS as readonly string[]).includes(norm);
}

export function assertApprovedTestHost(rawUrl: string | URL): URL {
  let parsed: URL;
  try {
    parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch (err) {
    throw new Error(
      `Safety violation: Test database URL is not a valid URL: ${(err as Error).message}`,
    );
  }

  if (!isApprovedTestHost(parsed.hostname)) {
    throw new Error(
      `Safety violation: Test database URL targets unapproved remote host "${parsed.hostname}". ` +
        `Destructive and integration tests are restricted to approved local/CI hosts: ${APPROVED_TEST_HOSTS.join(", ")}.`,
    );
  }
  return parsed;
}

export function isApprovedTestDatabaseName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (lower === "fluxora_dev" || lower.endsWith("_dev") || lower.includes("prod")) {
    return false;
  }
  return (
    lower.startsWith("fluxora_fix4_test") ||
    lower.startsWith("fluxora_scenario_") ||
    lower.startsWith("fluxora_clean_") ||
    lower.startsWith("fluxora_test_") ||
    lower.startsWith("fluxora_secdef_") ||
    lower.startsWith("fluxora_queue_") ||
    lower.includes("_test_") ||
    lower.endsWith("_test")
  );
}

export function verifyTestDatabaseSafety(
  testUrl: string,
  developmentUrl?: string,
): { dbName: string; host: string } {
  const parsed = assertApprovedTestHost(testUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (!isApprovedTestDatabaseName(dbName)) {
    throw new Error(
      `Safety violation: Database name "${dbName}" is not an approved disposable test database. ` +
        `Refusing destructive test operations against non-test or development database.`,
    );
  }

  if (developmentUrl && developmentUrl.trim().length > 0) {
    try {
      const parsedDev = new URL(developmentUrl);
      const devDbName = decodeURIComponent(parsedDev.pathname.replace(/^\//, ""));
      if (
        devDbName.toLowerCase() === dbName.toLowerCase() &&
        parsedDev.hostname.toLowerCase() === parsed.hostname.toLowerCase()
      ) {
        throw new Error(
          `Safety violation: Test database URL targets the same database as development DATABASE_URL ("${dbName}"). ` +
            `Destructive tests must never target development databases.`,
        );
      }
    } catch (err) {
      if ((err as Error).message.includes("Safety violation")) {
        throw err;
      }
    }
  }

  return { dbName, host: parsed.hostname };
}

export function getScenarioTestDatabaseUrl(desiredDbName = "fluxora_fix4_test"): string {
  const explicit =
    process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL ??
    process.env.FLUXORA_TEST_DATABASE_URL;

  if (explicit && explicit.trim().length > 0) {
    verifyTestDatabaseSafety(explicit, process.env.DATABASE_URL);
    return explicit.trim();
  }

  // Derive from admin or queue database URL
  const baseAdminUrl =
    process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL ??
    process.env.FLUXORA_QUEUE_TEST_DATABASE_URL ??
    process.env.DATABASE_URL;

  if (!baseAdminUrl || baseAdminUrl.trim().length === 0) {
    throw new Error(
      "Test database isolation error: Neither FLUXORA_SCENARIO_TEST_DATABASE_URL nor a base database URL is configured.",
    );
  }

  const parsed = assertApprovedTestHost(baseAdminUrl);
  parsed.pathname = `/${desiredDbName}`;
  const derivedUrl = parsed.toString();
  verifyTestDatabaseSafety(derivedUrl, process.env.DATABASE_URL);
  return derivedUrl;
}

export function getAdminDatabaseUrl(): string {
  const baseAdminUrl =
    process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL ??
    process.env.FLUXORA_QUEUE_TEST_DATABASE_URL ??
    process.env.DATABASE_URL;

  if (!baseAdminUrl || baseAdminUrl.trim().length === 0) {
    throw new Error("Admin database error: No database URL available to connect for administration.");
  }

  const parsed = assertApprovedTestHost(baseAdminUrl);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

export interface IsolatedTestDatabaseResult {
  pool: pg.Pool;
  testUrl: string;
  dbName: string;
  teardown: () => Promise<void>;
}

export async function setupIsolatedTestDatabase(options?: {
  dbName?: string;
  cleanMigrations?: boolean;
}): Promise<IsolatedTestDatabaseResult> {
  const dbName = options?.dbName ?? `fluxora_fix4_test`;
  const testUrl = getScenarioTestDatabaseUrl(dbName);
  verifyTestDatabaseSafety(testUrl, process.env.DATABASE_URL);

  const adminUrl = getAdminDatabaseUrl();
  const adminClient = new pg.Client({ connectionString: adminUrl });
  await adminClient.connect();

  try {
    // Recreate clean disposable test database
    await adminClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    await adminClient.query(`CREATE DATABASE ${dbName};`);
  } finally {
    await adminClient.end().catch(() => {});
  }

  // Point DATABASE_URL and pool to the isolated test database
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl;
  await closePool();

  const pool = getPool();

  if (options?.cleanMigrations !== false) {
    await runMigrations(pool);
  }

  const teardown = async (): Promise<void> => {
    await closePool();
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    const cleanupClient = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanupClient.connect();
      await cleanupClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    } catch {
      // Best-effort cleanup
    } finally {
      await cleanupClient.end().catch(() => {});
    }
  };

  return { pool, testUrl, dbName, teardown };
}

/**
 * Deterministically verifies that a target backend PID is actively waiting
 * on a PostgreSQL lock, eliminating timing assumptions in concurrency tests.
 */
export async function waitForLockWait(
  client: pg.Client | pg.Pool,
  blockedPid: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_locks WHERE pid = $1 AND NOT granted;`,
      [blockedPid],
    );
    if (parseInt(res.rows[0]?.count ?? "0", 10) > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
