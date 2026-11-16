import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll, afterAll } from "vitest";
import pg from "pg";

import { loadRootEnvFile } from "../cli/env.ts";

loadRootEnvFile();

const nodeRequire = createRequire(import.meta.url);
const pgPackagePath = nodeRequire.resolve("pg");
const pgConnectionStringPath = nodeRequire.resolve("pg-connection-string", {
  paths: [pgPackagePath],
});
const { parse: parsePgConnectionString } = nodeRequire(pgConnectionStringPath) as {
  parse: (str: string) => Record<string, unknown>;
};

const migration0025Path = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0025_security_definer_hardening.sql",
);

const AUTH_FUNCTIONS = [
  "public.fluxora_store_oauth_login_state(text, text, timestamptz)",
  "public.fluxora_consume_oauth_login_state(text)",
  "public.fluxora_insert_refresh_session(uuid, uuid, uuid, text, timestamptz)",
  "public.fluxora_rotate_refresh_session(text, text, timestamptz)",
  "public.fluxora_revoke_refresh_family(text)",
  "public.fluxora_revoke_user_refresh_sessions(uuid)",
] as const;

const TENANT_HELPER_FUNCTIONS = [
  "public.fluxora_snapshot_in_current_tenant(uuid)",
  "public.fluxora_analysis_run_in_current_tenant(uuid)",
  "public.fluxora_pull_request_in_current_tenant(uuid)",
  "public.fluxora_impact_analysis_in_current_tenant(uuid)",
  "public.fluxora_scenario_in_current_tenant(uuid)",
  "public.fluxora_simulation_in_current_tenant(uuid)",
] as const;

const ALL_HARDENED_0025_FUNCTIONS = [
  ...AUTH_FUNCTIONS,
  ...TENANT_HELPER_FUNCTIONS,
] as const;

const ALL_SYSTEM_SECURITY_DEFINER_FUNCTIONS = [
  // Bootstrap (Fix 1)
  "public.fluxora_create_organization(text, public.plan_tier, bigint)",
  "public.fluxora_create_user(uuid, text, public.user_role, bigint)",
  "public.fluxora_provision_github_user(bigint, text, text)",
  // Job Queue (Fix 2)
  "public.fluxora_claim_next_job(text, integer)",
  "public.fluxora_complete_job(uuid, text)",
  "public.fluxora_fail_job(uuid, text, text)",
  "public.fluxora_retry_failed_job(uuid, text, integer, text)",
  "public.fluxora_jobs_retry_limits_guard()",
  // Auth & Sessions (Fix 3)
  ...AUTH_FUNCTIONS,
  // Tenant RLS Helpers (Fix 3)
  ...TENANT_HELPER_FUNCTIONS,
] as const;

const TRIGGER_SECURITY_DEFINER_FUNCTION =
  "public.fluxora_jobs_retry_limits_guard()" as const;

const CALLABLE_SECURITY_DEFINER_FUNCTIONS =
  ALL_SYSTEM_SECURITY_DEFINER_FUNCTIONS.filter(
    (fn) => fn !== TRIGGER_SECURITY_DEFINER_FUNCTION,
  );

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface MembershipSnapshot {
  role_name: string;
  member_name: string;
  grantor_name: string;
  admin_option: boolean;
  inherit_option: boolean | null;
  set_option: boolean | null;
}

function sortMembershipSnapshots(
  memberships: readonly MembershipSnapshot[],
): MembershipSnapshot[] {
  return [...memberships].sort((a, b) => {
    const keyA = `${a.role_name}\0${a.member_name}\0${a.grantor_name}\0${a.admin_option}\0${a.inherit_option}\0${a.set_option}`;
    const keyB = `${b.role_name}\0${b.member_name}\0${b.grantor_name}\0${b.admin_option}\0${b.inherit_option}\0${b.set_option}`;
    return keyA.localeCompare(keyB);
  });
}

async function captureMembershipSnapshots(
  client: pg.Client,
  trackedRoles: readonly string[],
): Promise<MembershipSnapshot[]> {
  const verRes = await client.query<{ ver: string }>(
    "SELECT pg_catalog.current_setting('server_version_num') AS ver;",
  );
  const serverVersion = parseInt(verRes.rows[0]?.ver ?? "0", 10);

  if (serverVersion >= 160000) {
    // In PostgreSQL 16+, pg_auth_members has admin_option, inherit_option, set_option.
    const res = await client.query<{
      role_name: string;
      member_name: string;
      grantor_name: string | null;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(`
      SELECT
        gr.rolname AS role_name,
        mr.rolname AS member_name,
        COALESCE(grantor_r.rolname, m.grantor::text) AS grantor_name,
        m.admin_option,
        m.inherit_option,
        m.set_option
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
      JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
      LEFT JOIN pg_catalog.pg_roles grantor_r ON grantor_r.oid = m.grantor
      WHERE gr.rolname = ANY($1::text[]) OR mr.rolname = ANY($1::text[])
    `, [[...trackedRoles]]);

    return res.rows.map((row) => ({
      role_name: row.role_name,
      member_name: row.member_name,
      grantor_name: row.grantor_name ?? "unknown",
      admin_option: Boolean(row.admin_option),
      inherit_option: Boolean(row.inherit_option),
      set_option: Boolean(row.set_option),
    }));
  } else {
    // In PostgreSQL < 16, inherit_option and set_option columns do not exist.
    // Query only available catalog columns without making unsupported column references.
    const res = await client.query<{
      role_name: string;
      member_name: string;
      grantor_name: string | null;
      admin_option: boolean;
    }>(`
      SELECT
        gr.rolname AS role_name,
        mr.rolname AS member_name,
        COALESCE(grantor_r.rolname, m.grantor::text) AS grantor_name,
        m.admin_option
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
      JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
      LEFT JOIN pg_catalog.pg_roles grantor_r ON grantor_r.oid = m.grantor
      WHERE gr.rolname = ANY($1::text[]) OR mr.rolname = ANY($1::text[])
    `, [[...trackedRoles]]);

    return res.rows.map((row) => ({
      role_name: row.role_name,
      member_name: row.member_name,
      grantor_name: row.grantor_name ?? "unknown",
      admin_option: Boolean(row.admin_option),
      inherit_option: null,
      set_option: null,
    }));
  }
}

describe("0025 migration file static security analysis", () => {
  it("enforces dedicated least-privilege roles, pinned search_path, revoked public execute, and forced RLS", async () => {
    const rawSql = await readFile(migration0025Path, "utf8");
    const sql = executableSql(rawSql);

    // 0. Verify function list sizes
    assert.equal(AUTH_FUNCTIONS.length, 6);
    assert.equal(TENANT_HELPER_FUNCTIONS.length, 6);
    assert.equal(ALL_HARDENED_0025_FUNCTIONS.length, 12);
    assert.equal(CALLABLE_SECURITY_DEFINER_FUNCTIONS.length, 19);
    assert.equal(ALL_SYSTEM_SECURITY_DEFINER_FUNCTIONS.length, 20);

    // 1. Role pre-provisioning requirement and attribute validations
    assert.ok(sql.includes("CREATE ROLE fluxora_auth"));
    assert.ok(sql.includes("CREATE ROLE fluxora_tenant_guard"));
    assert.match(sql, /Privileged service role "fluxora_auth" does not exist\. It must be pre-provisioned/);
    assert.match(sql, /Privileged service role "fluxora_tenant_guard" does not exist\. It must be pre-provisioned/);
    assert.match(sql, /Existing fluxora_auth role has unsafe attributes/);
    assert.match(sql, /Existing fluxora_tenant_guard role has unsafe attributes/);

    // 2. Schema public creation revoked from PUBLIC (CVE-2018-1058 defense)
    assert.ok(sql.includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC;"));

    // 3. Narrowed table grants
    assert.ok(sql.includes("GRANT SELECT, INSERT, DELETE ON TABLE public.oauth_login_states TO fluxora_auth"));
    assert.ok(sql.includes("GRANT SELECT, INSERT, UPDATE ON TABLE public.refresh_sessions TO fluxora_auth"));
    assert.ok(sql.includes("GRANT SELECT ON TABLE public.users TO fluxora_auth"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.fluxora_current_org_id() TO fluxora_tenant_guard"));

    // 4. Dedicated RLS policies for service roles
    assert.ok(sql.includes("CREATE POLICY oauth_login_states_auth_all ON public.oauth_login_states FOR ALL TO fluxora_auth"));
    assert.ok(sql.includes("CREATE POLICY refresh_sessions_auth_all ON public.refresh_sessions FOR ALL TO fluxora_auth"));
    assert.ok(sql.includes("CREATE POLICY users_auth_select ON public.users FOR SELECT TO fluxora_auth"));
    assert.ok(sql.includes("CREATE POLICY repositories_tenant_guard_select ON public.repositories FOR SELECT TO fluxora_tenant_guard"));
    assert.ok(sql.includes("CREATE POLICY repository_snapshots_tenant_guard_select ON public.repository_snapshots FOR SELECT TO fluxora_tenant_guard"));
    assert.ok(sql.includes("CREATE POLICY analysis_runs_tenant_guard_select ON public.analysis_runs FOR SELECT TO fluxora_tenant_guard"));
    assert.ok(sql.includes("CREATE POLICY pull_requests_tenant_guard_select ON public.pull_requests FOR SELECT TO fluxora_tenant_guard"));
    assert.ok(sql.includes("CREATE POLICY impact_analyses_tenant_guard_select ON public.impact_analyses FOR SELECT TO fluxora_tenant_guard"));
    assert.ok(sql.includes("CREATE POLICY scenarios_tenant_guard_select ON public.scenarios FOR SELECT TO fluxora_tenant_guard"));
    assert.ok(sql.includes("CREATE POLICY simulations_tenant_guard_select ON public.simulations FOR SELECT TO fluxora_tenant_guard"));

    // 5. All 12 functions have pinned search_path = pg_catalog, public, pg_temp
    const searchPathMatches = [
      ...sql.matchAll(/SET search_path = pg_catalog, public, pg_temp/g),
    ];
    assert.equal(
      searchPathMatches.length,
      12,
      "Exactly 12 functions in 0025 must pin search_path = pg_catalog, public, pg_temp",
    );

    // 6. Ownership transfers and PUBLIC execution revocations
    for (const authFn of AUTH_FUNCTIONS) {
      assert.ok(sql.includes(`ALTER FUNCTION ${authFn} OWNER TO fluxora_auth;`));
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${authFn} FROM PUBLIC;`));
      // Fix 3A: Migration runner must NOT receive persistent EXECUTE on auth functions
      assert.equal(
        sql.includes(`GRANT EXECUTE ON FUNCTION ${authFn} TO CURRENT_USER`),
        false,
        `0025 must not grant execute on auth function ${authFn} to CURRENT_USER`,
      );
    }

    for (const tenantFn of TENANT_HELPER_FUNCTIONS) {
      assert.ok(sql.includes(`ALTER FUNCTION ${tenantFn} OWNER TO fluxora_tenant_guard;`));
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${tenantFn} FROM PUBLIC;`));
    }

    // Fix 3A: Migration runner must NOT grant/revoke service roles to/from itself
    assert.equal(sql.includes("GRANT fluxora_auth TO CURRENT_USER"), false);
    assert.equal(sql.includes("REVOKE fluxora_auth FROM CURRENT_USER"), false);
    assert.equal(sql.includes("GRANT fluxora_tenant_guard TO CURRENT_USER"), false);
    assert.equal(sql.includes("REVOKE fluxora_tenant_guard FROM CURRENT_USER"), false);

    // Fix 3A: Production migration must NOT grant privileges to test-only roles
    assert.equal(
      sql.includes("fluxora_rls_test"),
      false,
      "Production migration 0025 must not contain grants to fluxora_rls_test",
    );

    // 7. Temporary schema CREATE for ownership transfer
    assert.ok(sql.includes("GRANT CREATE ON SCHEMA public TO fluxora_auth;"));
    assert.ok(sql.includes("REVOKE CREATE ON SCHEMA public FROM fluxora_auth;"));
    assert.ok(sql.includes("GRANT CREATE ON SCHEMA public TO fluxora_tenant_guard;"));
    assert.ok(sql.includes("REVOKE CREATE ON SCHEMA public FROM fluxora_tenant_guard;"));

    // 8. Runtime roles receive proper grants
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.fluxora_store_oauth_login_state(text, text, timestamptz) TO fluxora_app;"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.fluxora_snapshot_in_current_tenant(uuid) TO fluxora_app;"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.fluxora_snapshot_in_current_tenant(uuid) TO fluxora_worker;"));

    // 9. FORCE ROW LEVEL SECURITY reaffirmed
    assert.ok(sql.includes("ALTER TABLE public.oauth_login_states FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.refresh_sessions FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.users FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.repositories FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.repository_snapshots FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.analysis_runs FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.pull_requests FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.impact_analyses FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.scenarios FORCE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE public.simulations FORCE ROW LEVEL SECURITY;"));

    // 10. Post-migration verification DO block
    assert.match(sql, /expected fluxora_auth/);
    assert.match(sql, /expected fluxora_tenant_guard/);
    assert.match(sql, /PUBLIC retains EXECUTE/);
    assert.match(sql, /retains unauthorized administrative \(ADMIN OPTION\) or inheriting membership in service roles/);
    assert.match(sql, /m\.admin_option/);
  });

  it("membership snapshot comparator detects changes to membership options even when role and member remain unchanged", () => {
    const baseline: MembershipSnapshot[] = [
      {
        role_name: "fluxora_auth",
        member_name: "fluxora_app",
        grantor_name: "postgres",
        admin_option: false,
        inherit_option: false,
        set_option: true,
      },
    ];

    const changedAdmin: MembershipSnapshot[] = [
      {
        ...baseline[0]!,
        admin_option: true,
      },
    ];

    const changedInherit: MembershipSnapshot[] = [
      {
        ...baseline[0]!,
        inherit_option: true,
      },
    ];

    const changedSet: MembershipSnapshot[] = [
      {
        ...baseline[0]!,
        set_option: false,
      },
    ];

    const changedGrantor: MembershipSnapshot[] = [
      {
        ...baseline[0]!,
        grantor_name: "other_admin",
      },
    ];

    assert.deepEqual(sortMembershipSnapshots(baseline), sortMembershipSnapshots(baseline));
    assert.throws(() => {
      assert.deepEqual(sortMembershipSnapshots(changedAdmin), sortMembershipSnapshots(baseline));
    });
    assert.throws(() => {
      assert.deepEqual(sortMembershipSnapshots(changedInherit), sortMembershipSnapshots(baseline));
    });
    assert.throws(() => {
      assert.deepEqual(sortMembershipSnapshots(changedSet), sortMembershipSnapshots(baseline));
    });
    assert.throws(() => {
      assert.deepEqual(sortMembershipSnapshots(changedGrantor), sortMembershipSnapshots(baseline));
    });
  });
});

const APPROVED_DESTRUCTIVE_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
] as const;

export function isApprovedHost(hostname: string): boolean {
  const norm = hostname.replace(/^\[|\]$/g, "").toLowerCase().trim();
  return (APPROVED_DESTRUCTIVE_HOSTS as readonly string[]).includes(norm);
}

export function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().trim();
}

export function isDisposableDatabaseName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("fluxora_secdef_") ||
    lower.startsWith("fluxora_inc_") ||
    lower.startsWith("fluxora_clean_") ||
    lower.startsWith("fluxora_historical_") ||
    lower.startsWith("fluxora_queue_") ||
    lower.includes("_upg_") ||
    lower.includes("_clean_")
  );
}

export const VALIDATED_CONFIG_BRAND: unique symbol = Symbol("fluxora.validated_postgres_config");

export interface ValidatedPostgresConfig {
  readonly [VALIDATED_CONFIG_BRAND]: true;
  /** Effective validated host (normalized, lowercased, brackets stripped) */
  host: string;
  /** Effective validated port (normalized to 5432 when omitted) */
  port: number;
  /** Effective validated database name (decoded, trimmed) */
  database: string;
  /** Credential-redacted display endpoint */
  displayEndpoint: string;
  /** Direct Client configuration object guaranteed to match the validated endpoint */
  clientConfig: Readonly<pg.ClientConfig>;
  /** Clean URL object without sensitive parameter overrides or credentials */
  url: URL;
  /** URL compatibility property: hostname */
  hostname: string;
  /** URL compatibility property: pathname */
  pathname: string;
  /** Protocol (postgres: or postgresql:) */
  protocol: string;
  /** String representation matching the clean URL */
  toString(): string;
}

export function isValidatedPostgresConfig(val: unknown): val is ValidatedPostgresConfig {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as Record<symbol, unknown>)[VALIDATED_CONFIG_BRAND] === true
  );
}

export interface ClientConfigOverrides {
  database?: string;
  user?: string;
  username?: string;
  password?: string;
}

/**
 * Creates a new pg.ClientConfig based on a validated base configuration.
 *
 * Overrides only database, user, and password as requested.
 * Preserves SSL settings and all other supported connection properties.
 * Guarantees the shared base configuration is never mutated.
 */
export function deriveClientConfig(
  baseConfig: ValidatedPostgresConfig,
  overrides?: ClientConfigOverrides,
): pg.ClientConfig {
  if (!isValidatedPostgresConfig(baseConfig)) {
    throw new Error(
      "Safety violation: Base configuration must be an authentic, validated ValidatedPostgresConfig object.",
    );
  }

  const derived: pg.ClientConfig = {
    ...baseConfig.clientConfig,
  };

  if (overrides?.database !== undefined) {
    derived.database = overrides.database;
  }
  if (overrides?.user !== undefined) {
    derived.user = overrides.user;
  } else if (overrides?.username !== undefined) {
    derived.user = overrides.username;
  }
  if (overrides?.password !== undefined) {
    derived.password = overrides.password;
  }

  return derived;
}

export function getEffectivePort(url: URL | ValidatedPostgresConfig | string): number {
  if (isValidatedPostgresConfig(url)) {
    return url.port;
  }
  if (url instanceof URL) {
    if (url.port && url.port.trim().length > 0) {
      const portStr = url.port.trim();
      if (!/^\d+$/.test(portStr)) {
        throw new Error(`Endpoint validation error: Invalid port "${url.port}" in URL. Port must contain decimal digits only.`);
      }
      const portNum = Number(portStr);
      if (portNum <= 0 || portNum > 65535) {
        throw new Error(`Endpoint validation error: Invalid port "${url.port}" in URL. Port must be between 1 and 65535.`);
      }
      return portNum;
    }
    return 5432;
  }
  const str = String(url);
  try {
    const parsed = new URL(str);
    return getEffectivePort(parsed);
  } catch {
    return 5432;
  }
}

export type ConnectionStringPurpose = "cluster_lock" | "destructive_admin";

export function validatePostgresConnectionString(
  rawUrl: string | URL | ValidatedPostgresConfig | undefined,
  purpose: ConnectionStringPurpose,
): ValidatedPostgresConfig {
  if (isValidatedPostgresConfig(rawUrl)) {
    return rawUrl;
  }

  const isLock = purpose === "cluster_lock";
  const envName = isLock ? "FLUXORA_CLUSTER_LOCK_DATABASE_URL" : "FLUXORA_QUEUE_TEST_DATABASE_URL";
  const purposeDesc = isLock ? "cluster lock database" : "destructive queue test database";

  if (rawUrl === undefined || rawUrl === null) {
    if (isLock) {
      throw new Error(
        "Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured. " +
        "PostgreSQL advisory locks are database-local; all test executions against the same cluster must share an explicit, stable canonical lock database to serialize cluster-role access. " +
        "Fallback to disposable databases or FLUXORA_QUEUE_TEST_DATABASE_URL is forbidden.",
      );
    } else {
      throw new Error(
        "Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL must be explicitly configured.",
      );
    }
  }

  const urlString = rawUrl instanceof URL ? rawUrl.toString() : String(rawUrl).trim();
  if (urlString.length === 0) {
    if (isLock) {
      throw new Error(
        "Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured. " +
        "PostgreSQL advisory locks are database-local; all test executions against the same cluster must share an explicit, stable canonical lock database to serialize cluster-role access. " +
        "Fallback to disposable databases or FLUXORA_QUEUE_TEST_DATABASE_URL is forbidden.",
      );
    } else {
      throw new Error(
        "Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL must be explicitly configured.",
      );
    }
  }

  // 1. Check for malformed percent-encoding
  if (/%(?![0-9a-fA-F]{2})/i.test(urlString)) {
    throw new Error(
      `Configuration error: ${envName} contains malformed percent-encoding.`,
    );
  }
  try {
    decodeURI(urlString);
  } catch (err: unknown) {
    throw new Error(
      `Configuration error: ${envName} contains malformed percent-encoding: ${(err as Error).message}`,
    );
  }

  // 2. Validate URL structure and protocol
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch (err: unknown) {
    throw new Error(
      `Configuration error: ${envName} is not a valid URL: ${(err as Error).message}`,
    );
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(
      `Safety violation: Invalid protocol "${parsedUrl.protocol}" for ${purposeDesc}. Only "postgres:" and "postgresql:" protocols are supported.`,
    );
  }

  // 3. Driver-level parsing with installed pg dependency's parser
  let driverParsed: Record<string, unknown>;
  try {
    driverParsed = parsePgConnectionString(urlString);
  } catch (err: unknown) {
    throw new Error(
      `Configuration error: Failed to parse ${envName} with pg-connection-string: ${(err as Error).message}`,
    );
  }

  // 4. Effective parsed host (query parameter host or URL hostname)
  if (parsedUrl.searchParams.getAll("host").length > 1) {
    throw new Error(
      `Safety violation: Multiple or ambiguous host parameters are not supported for ${purposeDesc}.`,
    );
  }

  if (Array.isArray(driverParsed.host)) {
    throw new Error(
      `Safety violation: Multiple or ambiguous effective hosts (array) are not supported for ${purposeDesc}.`,
    );
  }

  if (
    driverParsed.host !== undefined &&
    driverParsed.host !== null &&
    typeof driverParsed.host !== "string"
  ) {
    throw new Error(
      `Safety violation: Unsupported host type (${typeof driverParsed.host}) from connection string parser for ${purposeDesc}.`,
    );
  }

  let rawHost = "";
  if (typeof driverParsed.host === "string" && driverParsed.host.trim().length > 0) {
    rawHost = driverParsed.host.trim();
  } else if (parsedUrl.hostname && parsedUrl.hostname.trim().length > 0) {
    rawHost = parsedUrl.hostname.trim();
  }

  if (!rawHost || rawHost.length === 0) {
    throw new Error(
      `Safety violation: Host must be specified in connection string for ${purposeDesc}.`,
    );
  }

  if (rawHost.includes(",")) {
    throw new Error(
      `Safety violation: Multiple or ambiguous effective hosts ("${rawHost}") are not supported for ${purposeDesc}.`,
    );
  }

  const effectiveHost = normalizeHost(rawHost);
  if (!isApprovedHost(effectiveHost)) {
    throw new Error(
      `Safety violation: Host "${effectiveHost}" for ${purposeDesc} is not approved for destructive testing.`,
    );
  }

  // 5. Effective parsed port (normalized to 5432 strictly when genuinely absent)
  if (parsedUrl.searchParams.getAll("port").length > 1) {
    throw new Error(
      `Safety violation: Multiple or ambiguous port parameters are not supported for ${purposeDesc}.`,
    );
  }

  if (Array.isArray(driverParsed.port)) {
    throw new Error(
      `Safety violation: Multiple or ambiguous effective ports (array) are not supported for ${purposeDesc}.`,
    );
  }

  if (
    driverParsed.port !== undefined &&
    driverParsed.port !== null &&
    typeof driverParsed.port !== "string" &&
    typeof driverParsed.port !== "number"
  ) {
    throw new Error(
      `Safety violation: Unsupported port type (${typeof driverParsed.port}) from connection string parser for ${purposeDesc}.`,
    );
  }

  let explicitPortCandidate: string | number | undefined;
  let portExplicitlySupplied = false;

  if (typeof driverParsed.port === "number") {
    explicitPortCandidate = driverParsed.port;
    portExplicitlySupplied = true;
  } else if (typeof driverParsed.port === "string" && driverParsed.port.trim().length > 0) {
    explicitPortCandidate = driverParsed.port.trim();
    portExplicitlySupplied = true;
  } else if (parsedUrl.searchParams.has("port")) {
    portExplicitlySupplied = true;
    explicitPortCandidate = parsedUrl.searchParams.get("port") ?? "";
  } else if (parsedUrl.port && parsedUrl.port.trim().length > 0) {
    portExplicitlySupplied = true;
    explicitPortCandidate = parsedUrl.port.trim();
  }

  let effectivePort: number;
  if (!portExplicitlySupplied || explicitPortCandidate === undefined) {
    effectivePort = 5432;
  } else {
    const portStr = String(explicitPortCandidate).trim();

    if (portStr.includes(",")) {
      throw new Error(
        `Safety violation: Multiple or ambiguous effective ports ("${portStr}") are not supported for ${purposeDesc}.`,
      );
    }

    if (portStr.length === 0 || !/^\d+$/.test(portStr)) {
      throw new Error(
        `Endpoint validation error: Invalid port "${explicitPortCandidate}" in connection string. Port must contain decimal digits only.`,
      );
    }

    const portNum = Number(portStr);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      throw new Error(
        `Endpoint validation error: Invalid port "${explicitPortCandidate}" in connection string. Port must be between 1 and 65535.`,
      );
    }

    effectivePort = portNum;
  }

  // 6. Effective decoded database name (handles %5F, query parameter overrides, etc.)
  const queryDb =
    (typeof driverParsed.dbname === "string" && driverParsed.dbname.trim().length > 0
      ? driverParsed.dbname.trim()
      : (parsedUrl.searchParams.get("dbname")?.trim() ||
         parsedUrl.searchParams.get("database")?.trim()));

  let effectiveDatabase: string;
  if (queryDb && queryDb.length > 0) {
    effectiveDatabase = queryDb;
  } else if (typeof driverParsed.database === "string" && driverParsed.database.trim().length > 0) {
    effectiveDatabase = driverParsed.database.trim();
  } else {
    effectiveDatabase = parsedUrl.pathname.replace(/^\//, "").trim();
  }

  try {
    effectiveDatabase = decodeURIComponent(effectiveDatabase);
  } catch {
    // Keep as-is if already decoded or decode fails
  }

  if (effectiveDatabase.length === 0) {
    const noun = isLock ? "Lock" : "Destructive-test";
    throw new Error(`Safety violation: ${noun} database URL must specify a database name.`);
  }

  // Dev database protection: refuse fluxora_dev and any *_dev database
  if (
    effectiveDatabase.toLowerCase() === "fluxora_dev" ||
    effectiveDatabase.toLowerCase().endsWith("_dev")
  ) {
    if (isLock) {
      throw new Error(
        `Safety violation: refusing to target dev database "${effectiveDatabase}" for cluster lock.`,
      );
    } else {
      throw new Error(
        `Safety violation: refusing to target dev database "${effectiveDatabase}".`,
      );
    }
  }

  // 7. Assemble explicit pg.ClientConfig
  const clientConfig: pg.ClientConfig = {
    host: effectiveHost,
    port: effectivePort,
    database: effectiveDatabase,
  };
  if (driverParsed.user) clientConfig.user = String(driverParsed.user);
  if (driverParsed.password) clientConfig.password = String(driverParsed.password);
  if (driverParsed.ssl !== undefined) clientConfig.ssl = driverParsed.ssl as pg.ClientConfig["ssl"];
  if (driverParsed.client_encoding) clientConfig.client_encoding = String(driverParsed.client_encoding);
  if (driverParsed.application_name) clientConfig.application_name = String(driverParsed.application_name);

  // Freeze clientConfig to prevent mutation of the base configuration
  Object.freeze(clientConfig);

  // 8. Sanitized URL representation (display-only; credentials stripped)
  const hostPart = effectiveHost.includes(":") ? `[${effectiveHost}]` : effectiveHost;
  const sanitizedUrl = new URL(
    `${protocol}//${hostPart}:${effectivePort}/${encodeURIComponent(effectiveDatabase)}`,
  );

  const displayEndpoint = `${effectiveHost}:${effectivePort}/${effectiveDatabase}`;

  return {
    [VALIDATED_CONFIG_BRAND]: true,
    host: effectiveHost,
    port: effectivePort,
    database: effectiveDatabase,
    displayEndpoint,
    clientConfig,
    url: sanitizedUrl,
    hostname: effectiveHost,
    pathname: `/${effectiveDatabase}`,
    protocol,
    toString(): string {
      return sanitizedUrl.toString();
    },
  };
}

export function assertClusterLockDatabaseConfigured(
  rawLockUrl: string | undefined,
): ValidatedPostgresConfig {
  return validatePostgresConnectionString(rawLockUrl, "cluster_lock");
}

export function assertCanonicalLockDatabaseNotDisposable(
  lockTarget: ValidatedPostgresConfig | URL | string,
  queueTarget?: ValidatedPostgresConfig | URL | string,
): void {
  const lockConfig = isValidatedPostgresConfig(lockTarget)
    ? lockTarget
    : validatePostgresConnectionString(lockTarget, "cluster_lock");

  const lockDbName = lockConfig.database.toLowerCase();

  // 1. Refuse dev databases
  if (lockDbName === "fluxora_dev" || lockDbName.endsWith("_dev")) {
    throw new Error(
      `Safety violation: refusing to target dev database "${lockConfig.database}" for cluster lock.`,
    );
  }

  // 2. Refuse matching the disposable queue test database
  if (queueTarget) {
    const queueConfig = isValidatedPostgresConfig(queueTarget)
      ? queueTarget
      : validatePostgresConnectionString(queueTarget, "destructive_admin");

    const queueDbName = queueConfig.database.toLowerCase();
    if (
      normalizeHost(lockConfig.host) === normalizeHost(queueConfig.host) &&
      lockConfig.port === queueConfig.port &&
      lockDbName === queueDbName
    ) {
      throw new Error(
        `Safety violation: FLUXORA_CLUSTER_LOCK_DATABASE_URL cannot target the same database as FLUXORA_QUEUE_TEST_DATABASE_URL ("${lockConfig.database}"). ` +
        `The lock database must be a stable, existing database (such as "postgres") to serialize concurrent executions across distinct disposable queue databases.`,
      );
    }
  }

  // 3. Refuse known disposable test database patterns
  if (isDisposableDatabaseName(lockDbName)) {
    throw new Error(
      `Safety violation: refusing to target disposable test database "${lockConfig.database}" for cluster lock.`,
    );
  }
}

export function assertLockAndAdminEndpointsCompatible(
  lockTarget: ValidatedPostgresConfig | URL | string,
  adminTarget: ValidatedPostgresConfig | URL | string,
): void {
  const lockConfig = isValidatedPostgresConfig(lockTarget)
    ? lockTarget
    : validatePostgresConnectionString(lockTarget, "cluster_lock");

  const adminConfig = isValidatedPostgresConfig(adminTarget)
    ? adminTarget
    : validatePostgresConnectionString(adminTarget, "destructive_admin");

  if (lockConfig.host !== adminConfig.host) {
    throw new Error(
      `Safety violation: Lock database host ("${lockConfig.host}") and destructive-test database host ("${adminConfig.host}") do not match. ` +
      `The lock and destructive-test URLs must target the same PostgreSQL server endpoint so that PostgreSQL advisory locks effectively serialize cluster-level operations.`,
    );
  }

  if (lockConfig.port !== adminConfig.port) {
    throw new Error(
      `Safety violation: Lock database port (${lockConfig.port}) and destructive-test database port (${adminConfig.port}) do not match. ` +
      `The lock and destructive-test URLs must target the same PostgreSQL server endpoint so that PostgreSQL advisory locks effectively serialize cluster-level operations.`,
    );
  }

  if (lockConfig.database.toLowerCase() === adminConfig.database.toLowerCase()) {
    throw new Error(
      `Safety violation: FLUXORA_CLUSTER_LOCK_DATABASE_URL cannot target the same database as FLUXORA_QUEUE_TEST_DATABASE_URL ("${lockConfig.database}"). ` +
      `The lock database must be a stable, existing database (such as "postgres") to serialize concurrent executions across distinct disposable queue databases.`,
    );
  }

  assertCanonicalLockDatabaseNotDisposable(lockConfig, adminConfig);
}

export function assertEndpointsTargetSamePostgresServer(
  rawLockUrl: string | URL | ValidatedPostgresConfig | undefined,
  rawAdminUrl: string | URL | ValidatedPostgresConfig | undefined,
): {
  lockConfig: ValidatedPostgresConfig;
  adminConfig: ValidatedPostgresConfig;
  lockUrl: URL;
  adminUrl: URL;
} {
  const lockConfig = isValidatedPostgresConfig(rawLockUrl)
    ? rawLockUrl
    : validatePostgresConnectionString(rawLockUrl, "cluster_lock");
  const adminConfig = isValidatedPostgresConfig(rawAdminUrl)
    ? rawAdminUrl
    : validatePostgresConnectionString(rawAdminUrl, "destructive_admin");

  assertLockAndAdminEndpointsCompatible(lockConfig, adminConfig);

  return {
    lockConfig,
    adminConfig,
    lockUrl: lockConfig.url,
    adminUrl: adminConfig.url,
  };
}

describe("cluster lock configuration and serialization guards", () => {
  it("fails immediately with a clear actionable error when FLUXORA_CLUSTER_LOCK_DATABASE_URL is omitted or empty", () => {
    for (const emptyVal of [undefined, "", "   "]) {
      assert.throws(
        () => assertClusterLockDatabaseConfigured(emptyVal),
        (err: Error) => {
          assert.match(
            err.message,
            /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured/,
          );
          assert.match(
            err.message,
            /Fallback to disposable databases or FLUXORA_QUEUE_TEST_DATABASE_URL is forbidden/,
          );
          return true;
        },
      );
    }
  });

  it("fails before destructive operations if FLUXORA_CLUSTER_LOCK_DATABASE_URL is not a valid URL", () => {
    assert.throws(
      () => assertClusterLockDatabaseConfigured("not-a-valid-url"),
      (err: Error) => {
        assert.match(
          err.message,
          /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL is not a valid URL/,
        );
        return true;
      },
    );
  });

  it("fails before destructive operations if FLUXORA_CLUSTER_LOCK_DATABASE_URL targets unapproved remote host", () => {
    const remoteUrl = "postgresql://postgres:postgres@db.production.example.com:5432/postgres";
    assert.throws(
      () => assertClusterLockDatabaseConfigured(remoteUrl),
      (err: Error) => {
        assert.match(
          err.message,
          /Safety violation: Host "db\.production\.example\.com" for cluster lock database is not approved for destructive testing/,
        );
        return true;
      },
    );
  });

  it("fails before destructive operations if FLUXORA_CLUSTER_LOCK_DATABASE_URL targets dev database", () => {
    const devUrl = "postgresql://postgres:postgres@localhost:5432/fluxora_dev";
    assert.throws(
      () => assertClusterLockDatabaseConfigured(devUrl),
      (err: Error) => {
        assert.match(
          err.message,
          /Safety violation: refusing to target dev database "fluxora_dev" for cluster lock/,
        );
        return true;
      },
    );
  });

  it("fails before destructive operations if FLUXORA_CLUSTER_LOCK_DATABASE_URL targets disposable database or matches queue test database", () => {
    const queueUrl = new URL("postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci");
    const sameUrlAsQueue = new URL("postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci");

    assert.throws(
      () => assertCanonicalLockDatabaseNotDisposable(sameUrlAsQueue, queueUrl),
      (err: Error) => {
        assert.match(
          err.message,
          /Safety violation: FLUXORA_CLUSTER_LOCK_DATABASE_URL cannot target the same database as FLUXORA_QUEUE_TEST_DATABASE_URL \("fluxora_queue_ci"\)/,
        );
        return true;
      },
    );

    const disposableTestDb = new URL("postgresql://postgres:postgres@localhost:5432/fluxora_secdef_upg_a1b2c3d4");
    assert.throws(
      () => assertCanonicalLockDatabaseNotDisposable(disposableTestDb, queueUrl),
      (err: Error) => {
        assert.match(
          err.message,
          /Safety violation: refusing to target disposable test database "fluxora_secdef_upg_a1b2c3d4" for cluster lock/,
        );
        return true;
      },
    );
  });

  it("verifies omitting FLUXORA_CLUSTER_LOCK_DATABASE_URL fails before client connection or destructive operations", () => {
    let clientCreated = false;
    let databaseMutated = false;

    try {
      assertClusterLockDatabaseConfigured(undefined);
      clientCreated = true;
      databaseMutated = true;
    } catch (err: unknown) {
      assert.match(
        (err as Error).message,
        /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured/,
      );
    }

    assert.equal(clientCreated, false, "Client must not be created when lock database URL is omitted");
    assert.equal(databaseMutated, false, "Database must not be mutated when lock database URL is omitted");
  });

  it("approves valid canonical lock database URL on approved host", () => {
    const validLockUrl = "postgresql://postgres:postgres@localhost:5432/postgres";
    const parsed = assertClusterLockDatabaseConfigured(validLockUrl);
    assert.equal(parsed.pathname, "/postgres");
    assert.doesNotThrow(() => {
      assertCanonicalLockDatabaseNotDisposable(
        parsed,
        new URL("postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci"),
      );
    });
  });

  describe("PostgreSQL endpoint preflight validation", () => {
    it("1. accepts matching hostname and port with different database names (including default port 5432 omission)", () => {
      // Both explicit port 5432
      const res1 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
      );
      assert.equal(res1.lockUrl.hostname, "localhost");
      assert.equal(res1.adminUrl.hostname, "localhost");
      assert.equal(getEffectivePort(res1.lockUrl), 5432);
      assert.equal(getEffectivePort(res1.adminUrl), 5432);
      assert.equal(res1.lockUrl.pathname, "/postgres");
      assert.equal(res1.adminUrl.pathname, "/fluxora_queue_ci");

      // Lock URL omits port (defaults to 5432)
      const res2 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost/postgres",
        "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
      );
      assert.equal(getEffectivePort(res2.lockUrl), 5432);
      assert.equal(getEffectivePort(res2.adminUrl), 5432);

      // Admin URL omits port (defaults to 5432)
      const res3 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres:postgres@localhost/fluxora_queue_ci",
      );
      assert.equal(getEffectivePort(res3.lockUrl), 5432);
      assert.equal(getEffectivePort(res3.adminUrl), 5432);

      // Both omit port (both default to 5432)
      const res4 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost/postgres",
        "postgresql://postgres:postgres@localhost/fluxora_queue_ci",
      );
      assert.equal(getEffectivePort(res4.lockUrl), 5432);
      assert.equal(getEffectivePort(res4.adminUrl), 5432);

      // IPv6 bracket normalization
      const res5 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@[::1]:5432/postgres",
        "postgresql://postgres:postgres@[::1]:5432/fluxora_queue_ci",
      );
      assert.equal(normalizeHost(res5.lockUrl.hostname), "::1");
      assert.equal(normalizeHost(res5.adminUrl.hostname), "::1");
    });

    it("2. rejects matching hostname with different ports with a clear actionable error", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5433/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Lock database port \(5432\) and destructive-test database port \(5433\) do not match\./,
          );
          assert.match(
            err.message,
            /The lock and destructive-test URLs must target the same PostgreSQL server endpoint so that PostgreSQL advisory locks effectively serialize cluster-level operations\./,
          );
          return true;
        },
      );

      // Port 5432 vs non-standard port with omitted port
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost/postgres",
            "postgresql://postgres:postgres@localhost:6543/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Lock database port \(5432\) and destructive-test database port \(6543\) do not match\./,
          );
          return true;
        },
      );
    });

    it("3. rejects different approved hostnames and does not assume approved hosts represent the same server", () => {
      // localhost vs 127.0.0.1 (both approved, but different hostnames)
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@127.0.0.1:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Lock database host \("localhost"\) and destructive-test database host \("127\.0\.0\.1"\) do not match\./,
          );
          assert.match(
            err.message,
            /The lock and destructive-test URLs must target the same PostgreSQL server endpoint so that PostgreSQL advisory locks effectively serialize cluster-level operations\./,
          );
          return true;
        },
      );

      // localhost vs postgres service container hostname
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@postgres:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Lock database host \("postgres"\) and destructive-test database host \("localhost"\) do not match\./,
          );
          return true;
        },
      );

      // 127.0.0.1 vs ::1
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            "postgresql://postgres:postgres@[::1]:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Lock database host \("127\.0\.0\.1"\) and destructive-test database host \("::1"\) do not match\./,
          );
          return true;
        },
      );
    });

    it("4. rejects invalid or missing URLs", () => {
      // Missing lock URL
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            undefined,
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured/,
      );

      // Empty lock URL
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "   ",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured/,
      );

      // Invalid lock URL
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "not-a-valid-url",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL is not a valid URL/,
      );

      // Missing admin URL
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            undefined,
          ),
        /Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL must be explicitly configured/,
      );

      // Empty admin URL
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "",
          ),
        /Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL must be explicitly configured/,
      );

      // Invalid admin URL
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "bad-admin-url",
          ),
        /Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL is not a valid URL/,
      );
    });

    it("5. ensures no client connection or mutation occurs when endpoint validation fails", () => {
      let lockClientCreated = false;
      let adminClientCreated = false;
      let mutationOccurred = false;

      const attemptIntegrationSetup = (lockUrlStr?: string, adminUrlStr?: string) => {
        // Preflight endpoint validation
        const { lockUrl, adminUrl } = assertEndpointsTargetSamePostgresServer(
          lockUrlStr,
          adminUrlStr,
        );

        // Client creation and connection must ONLY happen AFTER validation passes
        lockClientCreated = true;
        adminClientCreated = true;

        // Mutation must ONLY happen AFTER connections succeed
        mutationOccurred = true;
        return { lockUrl, adminUrl };
      };

      // Scenario A: Mismatched ports
      assert.throws(
        () =>
          attemptIntegrationSetup(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5433/fluxora_queue_ci",
          ),
        /Safety violation: Lock database port/,
      );
      assert.equal(lockClientCreated, false, "lockClient must not be created on port mismatch");
      assert.equal(adminClientCreated, false, "adminClient must not be created on port mismatch");
      assert.equal(mutationOccurred, false, "database mutation must not occur on port mismatch");

      // Scenario B: Mismatched approved hosts
      assert.throws(
        () =>
          attemptIntegrationSetup(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@127.0.0.1:5432/fluxora_queue_ci",
          ),
        /Safety violation: Lock database host/,
      );
      assert.equal(lockClientCreated, false, "lockClient must not be created on host mismatch");
      assert.equal(adminClientCreated, false, "adminClient must not be created on host mismatch");
      assert.equal(mutationOccurred, false, "database mutation must not occur on host mismatch");

      // Scenario C: Target dev database
      assert.throws(
        () =>
          attemptIntegrationSetup(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_dev",
          ),
        /Safety violation: refusing to target dev database "fluxora_dev"/,
      );
      assert.equal(lockClientCreated, false, "lockClient must not be created on dev database target");
      assert.equal(adminClientCreated, false, "adminClient must not be created on dev database target");
      assert.equal(mutationOccurred, false, "database mutation must not occur on dev database target");

      // Scenario D: Missing lock database URL
      assert.throws(
        () =>
          attemptIntegrationSetup(
            undefined,
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL must be explicitly configured/,
      );
      assert.equal(lockClientCreated, false, "lockClient must not be created on missing lock URL");
      assert.equal(adminClientCreated, false, "adminClient must not be created on missing lock URL");
      assert.equal(mutationOccurred, false, "database mutation must not occur on missing lock URL");
    });
  });

  describe("Fix 3C: pg-connection-string driver parser and effective endpoint safety regression suite", () => {
    it("rejects encoded fluxora_dev in the lock database path before connection", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/fluxora%5Fdev",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target dev database "fluxora_dev" for cluster lock\./,
          );
          return true;
        },
      );
    });

    it("rejects encoded development database in the admin URL before connection", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora%5Fdev",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target dev database "fluxora_dev"\./,
          );
          return true;
        },
      );

      // Custom dev database name with percent encoding
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/custom%5Ftest%5Fdev",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target dev database "custom_test_dev"\./,
          );
          return true;
        },
      );
    });

    it("rejects encoded disposable database name in the lock URL before connection", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/fluxora%5Fsecdef%5Fupg%5Fa1b2c3d4",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target disposable test database "fluxora_secdef_upg_a1b2c3d4" for cluster lock\./,
          );
          return true;
        },
      );
    });

    it("rejects URL query host override to an unapproved host before connection", () => {
      // Lock URL query host override
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres?host=unapproved.remote.com",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Host "unapproved\.remote\.com" for cluster lock database is not approved for destructive testing\./,
          );
          return true;
        },
      );

      // Admin URL query host override
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci?host=unapproved.remote.com",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Host "unapproved\.remote\.com" for destructive queue test database is not approved for destructive testing\./,
          );
          return true;
        },
      );
    });

    it("rejects URL query port override to a different port before connection", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci?port=5433",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Lock database port \(5432\) and destructive-test database port \(5433\) do not match\./,
          );
          return true;
        },
      );
    });

    it("rejects URL query dbname override to fluxora_dev before connection", () => {
      // Lock URL dbname override
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora_dev",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target dev database "fluxora_dev" for cluster lock\./,
          );
          return true;
        },
      );

      // Admin URL dbname override
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci?dbname=fluxora_dev",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target dev database "fluxora_dev"\./,
          );
          return true;
        },
      );

      // Encoded dbname parameter
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora%5Fdev",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target dev database "fluxora_dev" for cluster lock\./,
          );
          return true;
        },
      );
    });

    it("rejects URL query dbname override to a disposable database before connection", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora_secdef_upg_a1b2c3d4",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: refusing to target disposable test database "fluxora_secdef_upg_a1b2c3d4" for cluster lock\./,
          );
          return true;
        },
      );
    });

    it("rejects URL query dbname that makes lock and admin target the same effective database before connection", () => {
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora_queue_ci",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: FLUXORA_CLUSTER_LOCK_DATABASE_URL cannot target the same database as FLUXORA_QUEUE_TEST_DATABASE_URL \("fluxora_queue_ci"\)\./,
          );
          return true;
        },
      );
    });

    it("accepts matching effective host, port and distinct database names", () => {
      // 1. Explicit port matching
      const res1 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
      );
      assert.equal(res1.lockConfig.host, "localhost");
      assert.equal(res1.lockConfig.port, 5432);
      assert.equal(res1.lockConfig.database, "postgres");
      assert.equal(res1.adminConfig.host, "localhost");
      assert.equal(res1.adminConfig.port, 5432);
      assert.equal(res1.adminConfig.database, "fluxora_queue_ci");
      assert.equal(res1.lockConfig.clientConfig.host, "localhost");
      assert.equal(res1.lockConfig.clientConfig.port, 5432);
      assert.equal(res1.lockConfig.clientConfig.database, "postgres");
      assert.equal(res1.adminConfig.clientConfig.host, "localhost");
      assert.equal(res1.adminConfig.clientConfig.port, 5432);
      assert.equal(res1.adminConfig.clientConfig.database, "fluxora_queue_ci");

      // 2. Default port 5432 normalization when omitted
      const res2 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost/postgres",
        "postgresql://postgres:postgres@localhost/fluxora_queue_ci",
      );
      assert.equal(res2.lockConfig.port, 5432);
      assert.equal(res2.adminConfig.port, 5432);

      // 3. IPv6 brackets normalization
      const res3 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@[::1]:5432/postgres",
        "postgresql://postgres:postgres@[::1]:5432/fluxora_queue_ci",
      );
      assert.equal(res3.lockConfig.host, "::1");
      assert.equal(res3.adminConfig.host, "::1");

      // 4. Decoded non-dev / non-disposable valid database name
      const res4 = assertEndpointsTargetSamePostgresServer(
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres:postgres@localhost:5432/valid%2Dtest%2Ddb",
      );
      assert.equal(res4.adminConfig.database, "valid-test-db");
    });

    it("rejects malformed percent encoding before connection", () => {
      // Malformed sequence %zz
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres%zz",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL contains malformed percent-encoding\./,
          );
          return true;
        },
      );

      // Incomplete sequence %2
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci%2",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL contains malformed percent-encoding\./,
          );
          return true;
        },
      );

      // Malformed in query parameter
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres?dbname=db%zz",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL contains malformed percent-encoding\./,
          );
          return true;
        },
      );
    });

    it("rejects invalid protocol before connection", () => {
      // http protocol
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "http://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Invalid protocol "http:" for cluster lock database\. Only "postgres:" and "postgresql:" protocols are supported\./,
          );
          return true;
        },
      );

      // mysql protocol
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "postgresql://postgres:postgres@localhost:5432/postgres",
            "mysql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Invalid protocol "mysql:" for destructive queue test database\. Only "postgres:" and "postgresql:" protocols are supported\./,
          );
          return true;
        },
      );

      // socket protocol
      assert.throws(
        () =>
          assertEndpointsTargetSamePostgresServer(
            "socket://postgres:postgres@localhost:5432/postgres",
            "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          ),
        (err: Error) => {
          assert.match(
            err.message,
            /Safety violation: Invalid protocol "socket:" for cluster lock database\. Only "postgres:" and "postgresql:" protocols are supported\./,
          );
          return true;
        },
      );
    });

    it("verifies every rejection happens before either PostgreSQL client connects and before database or cluster-role mutations", () => {
      const invalidScenarios: Array<{
        name: string;
        lockUrl?: string;
        adminUrl?: string;
        expectedPattern: RegExp;
      }> = [
        {
          name: "Encoded fluxora_dev in lock path",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/fluxora%5Fdev",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /refusing to target dev database "fluxora_dev" for cluster lock/,
        },
        {
          name: "Encoded development database in admin path",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora%5Fdev",
          expectedPattern: /refusing to target dev database "fluxora_dev"/,
        },
        {
          name: "Encoded disposable database in lock path",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/fluxora%5Fsecdef%5Fupg%5F1234",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /refusing to target disposable test database "fluxora_secdef_upg_1234" for cluster lock/,
        },
        {
          name: "URL query host override to unapproved host in lock",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres?host=remote.evil.com",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /Safety violation: Host "remote\.evil\.com"/,
        },
        {
          name: "URL query host override to unapproved host in admin",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci?host=remote.evil.com",
          expectedPattern: /Safety violation: Host "remote\.evil\.com"/,
        },
        {
          name: "URL query port override to mismatched port",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci?port=5433",
          expectedPattern: /Lock database port \(5432\) and destructive-test database port \(5433\) do not match/,
        },
        {
          name: "URL query dbname override to fluxora_dev in lock",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora_dev",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /refusing to target dev database "fluxora_dev" for cluster lock/,
        },
        {
          name: "URL query dbname override to fluxora_dev in admin",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci?dbname=fluxora_dev",
          expectedPattern: /refusing to target dev database "fluxora_dev"/,
        },
        {
          name: "URL query dbname override to disposable database in lock",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora_secdef_upg_1234",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /refusing to target disposable test database "fluxora_secdef_upg_1234" for cluster lock/,
        },
        {
          name: "URL query dbname targeting same effective database",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres?dbname=fluxora_queue_ci",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /cannot target the same database/,
        },
        {
          name: "Malformed percent encoding",
          lockUrl: "postgresql://postgres:postgres@localhost:5432/postgres%zz",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /malformed percent-encoding/,
        },
        {
          name: "Invalid protocol",
          lockUrl: "http://postgres:postgres@localhost:5432/postgres",
          adminUrl: "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
          expectedPattern: /Invalid protocol "http:"/,
        },
      ];

      for (const scenario of invalidScenarios) {
        let lockClientCreated = false;
        let adminClientCreated = false;
        let mutationOccurred = false;

        const attemptSetup = () => {
          // Preflight validation must be the first operation executed
          const endpoints = assertEndpointsTargetSamePostgresServer(
            scenario.lockUrl,
            scenario.adminUrl,
          );

          // Client creation happens ONLY if validation succeeds
          lockClientCreated = true;
          adminClientCreated = true;

          // Database or role mutations happen ONLY after connections succeed
          mutationOccurred = true;
          return endpoints;
        };

        assert.throws(
          () => attemptSetup(),
          (err: Error) => {
            assert.match(
              err.message,
              scenario.expectedPattern,
              `Scenario "${scenario.name}" threw unexpected error message: ${err.message}`,
            );
            return true;
          },
          `Scenario "${scenario.name}" was expected to throw`,
        );

        assert.equal(
          lockClientCreated,
          false,
          `lockClient must NOT be created for invalid scenario "${scenario.name}"`,
        );
        assert.equal(
          adminClientCreated,
          false,
          `adminClient must NOT be created for invalid scenario "${scenario.name}"`,
        );
        assert.equal(
          mutationOccurred,
          false,
          `database/role mutation must NOT occur for invalid scenario "${scenario.name}"`,
        );
      }
    });

    it("preserves validated SSL configuration across all secondary client configurations", () => {
      // 1. SSL with object options
      const sslObjectConfig = validatePostgresConnectionString(
        "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
        "destructive_admin",
      );
      const baseWithSslObj: ValidatedPostgresConfig = {
        ...sslObjectConfig,
        [VALIDATED_CONFIG_BRAND]: true,
        clientConfig: Object.freeze({
          ...sslObjectConfig.clientConfig,
          ssl: { rejectUnauthorized: true, ca: "test-ca-cert" },
        }),
      };

      const secondaryDbAdmin = deriveClientConfig(baseWithSslObj, { database: "fluxora_secdef_upg_test" });
      const secondaryMigrator = deriveClientConfig(baseWithSslObj, {
        database: "fluxora_secdef_upg_test",
        user: "fluxora_mig_test",
        password: "test_migrator_password",
      });
      const secondaryPre0025 = deriveClientConfig(baseWithSslObj, { database: "fluxora_secdef_upg_test" });
      const secondaryCleanup = deriveClientConfig(baseWithSslObj, { database: "fluxora_secdef_clean_test" });
      const secondaryTestAdmin = deriveClientConfig(baseWithSslObj, { database: "fluxora_secdef_upg_test" });

      assert.deepEqual(secondaryDbAdmin.ssl, { rejectUnauthorized: true, ca: "test-ca-cert" });
      assert.deepEqual(secondaryMigrator.ssl, { rejectUnauthorized: true, ca: "test-ca-cert" });
      assert.deepEqual(secondaryPre0025.ssl, { rejectUnauthorized: true, ca: "test-ca-cert" });
      assert.deepEqual(secondaryCleanup.ssl, { rejectUnauthorized: true, ca: "test-ca-cert" });
      assert.deepEqual(secondaryTestAdmin.ssl, { rejectUnauthorized: true, ca: "test-ca-cert" });

      // 2. SSL with boolean true
      const baseWithSslBool: ValidatedPostgresConfig = {
        ...sslObjectConfig,
        [VALIDATED_CONFIG_BRAND]: true,
        clientConfig: Object.freeze({
          ...sslObjectConfig.clientConfig,
          ssl: true,
        }),
      };
      const migratorBoolSsl = deriveClientConfig(baseWithSslBool, {
        database: "fluxora_secdef_upg_test",
        user: "fluxora_mig_test",
        password: "test_migrator_password",
      });
      assert.equal(migratorBoolSsl.ssl, true);

      // 3. SSL undefined remains undefined
      const baseWithoutSsl = validatePostgresConnectionString(
        "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
        "destructive_admin",
      );
      const migratorNoSsl = deriveClientConfig(baseWithoutSsl, {
        database: "fluxora_secdef_upg_test",
        user: "fluxora_mig_test",
        password: "test_migrator_password",
      });
      assert.equal(migratorNoSsl.ssl, undefined);
    });

    it("changes only the intended database, user, and password fields for migrator clients without mutating base", () => {
      const baseConfig = validatePostgresConnectionString(
        "postgresql://base_admin_user:base_admin_pw@localhost:5432/fluxora_queue_ci?application_name=fluxora_test&client_encoding=UTF8",
        "destructive_admin",
      );

      const targetDb = "fluxora_secdef_upg_target";
      const targetUser = "fluxora_mig_target";
      const targetPw = "secret_migrator_credentials";

      const migratorConfig = deriveClientConfig(baseConfig, {
        database: targetDb,
        user: targetUser,
        password: targetPw,
      });

      // Verify intended changes
      assert.equal(migratorConfig.database, targetDb);
      assert.equal(migratorConfig.user, targetUser);
      // Verify password matches without exposing the password in error messages
      assert.ok(
        migratorConfig.password === targetPw,
        "Migrator password must match target password",
      );

      // Verify all other connection properties are strictly preserved
      assert.equal(migratorConfig.host, baseConfig.clientConfig.host);
      assert.equal(migratorConfig.port, baseConfig.clientConfig.port);
      assert.equal(migratorConfig.ssl, baseConfig.clientConfig.ssl);
      assert.equal(migratorConfig.client_encoding, baseConfig.clientConfig.client_encoding);
      assert.equal(migratorConfig.application_name, baseConfig.clientConfig.application_name);

      // Verify no unexpected extra fields
      const baseKeys = new Set(Object.keys(baseConfig.clientConfig));
      const migratorKeys = Object.keys(migratorConfig);
      for (const k of migratorKeys) {
        assert.ok(
          baseKeys.has(k) || k === "database" || k === "user" || k === "password",
          `Unexpected property "${k}" in derived configuration`,
        );
      }

      // Verify base configuration was NOT mutated
      assert.equal(baseConfig.clientConfig.database, "fluxora_queue_ci");
      assert.equal(baseConfig.clientConfig.user, "base_admin_user");
    });

    it("ensures no secondary client uses a raw connectionString in configuration or source code", async () => {
      const baseConfig = validatePostgresConnectionString(
        "postgresql://postgres:postgres@localhost:5432/fluxora_queue_ci",
        "destructive_admin",
      );

      const dbAdminConfig = deriveClientConfig(baseConfig, { database: "fluxora_secdef_upg_test" });
      const migratorConfig = deriveClientConfig(baseConfig, {
        database: "fluxora_secdef_upg_test",
        user: "fluxora_mig_test",
        password: "secret_password",
      });

      assert.equal("connectionString" in dbAdminConfig, false);
      assert.equal((dbAdminConfig as Record<string, unknown>).connectionString, undefined);
      assert.equal("connectionString" in migratorConfig, false);
      assert.equal((migratorConfig as Record<string, unknown>).connectionString, undefined);

      // Verify static source invariant: no raw connectionString client construction in this file
      const currentFilePath = fileURLToPath(import.meta.url);
      const fileContent = await readFile(currentFilePath, "utf8");
      const targetPattern = new RegExp(["new", "\\s+pg\\.Client\\(", "\\s*\\{\\s*connectionString"].join(""), "g");
      const rawClientMatches = fileContent.match(targetPattern);
      assert.equal(
        rawClientMatches,
        null,
        "security-definer-hardening.test.ts must not contain raw client connection string constructions",
      );
    });

    it("prevents arbitrary structural objects with clientConfig from bypassing validation", () => {
      const arbitraryObjects = [
        { clientConfig: { host: "localhost", port: 5432, database: "fluxora_dev" } },
        { clientConfig: { host: "evil.attacker.com", port: 5432, database: "fluxora_secdef_upg_test" } },
        { clientConfig: {} },
        { clientConfig: null },
      ];

      for (const obj of arbitraryObjects) {
        // Must NOT be recognized as validated
        assert.equal(isValidatedPostgresConfig(obj), false);

        // Must NOT bypass validatePostgresConnectionString
        assert.throws(
          () => validatePostgresConnectionString(obj as unknown as ValidatedPostgresConfig, "destructive_admin"),
          /Configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL is not a valid URL/,
        );

        assert.throws(
          () => validatePostgresConnectionString(obj as unknown as ValidatedPostgresConfig, "cluster_lock"),
          /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL is not a valid URL/,
        );

        // Must NOT bypass deriveClientConfig
        assert.throws(
          () => deriveClientConfig(obj as unknown as ValidatedPostgresConfig),
          /Safety violation: Base configuration must be an authentic, validated ValidatedPostgresConfig object\./,
        );

        // Must NOT bypass assertCanonicalLockDatabaseNotDisposable
        assert.throws(
          () => assertCanonicalLockDatabaseNotDisposable(obj as unknown as ValidatedPostgresConfig),
          /Configuration error: FLUXORA_CLUSTER_LOCK_DATABASE_URL is not a valid URL/,
        );
      }
    });

    it("rejects non-decimal, partial, negative, and ambiguous port values while keeping 5432 only when genuinely absent", () => {
      // 1. Non-decimal / junk suffixes
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=5432junk", "destructive_admin"),
        /Endpoint validation error: Invalid port "5432junk" in connection string\. Port must contain decimal digits only\./,
      );

      // 2. Embedded letters / partial
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=54x2", "destructive_admin"),
        /Endpoint validation error: Invalid port "54x2" in connection string\. Port must contain decimal digits only\./,
      );

      // 3. Comma-separated ports
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=5432,5433", "destructive_admin"),
        /Safety violation: Multiple or ambiguous effective ports \("5432,5433"\) are not supported/,
      );

      // 4. Multiple port query parameters
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=5432&port=5433", "destructive_admin"),
        /Safety violation: Multiple or ambiguous port parameters are not supported/,
      );

      // 5. Negative port
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=-5432", "destructive_admin"),
        /Endpoint validation error: Invalid port "-5432" in connection string\. Port must contain decimal digits only\./,
      );

      // 6. Decimal point
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=5432.0", "destructive_admin"),
        /Endpoint validation error: Invalid port "5432\.0" in connection string\. Port must contain decimal digits only\./,
      );

      // 7. Hexadecimal port
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=0x1538", "destructive_admin"),
        /Endpoint validation error: Invalid port "0x1538" in connection string\. Port must contain decimal digits only\./,
      );

      // 8. Empty port query parameter
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=", "destructive_admin"),
        /Endpoint validation error: Invalid port "" in connection string\. Port must contain decimal digits only\./,
      );

      // 9. Out of range ports
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=0", "destructive_admin"),
        /Endpoint validation error: Invalid port "0" in connection string\. Port must be between 1 and 65535\./,
      );

      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost/db?port=65536", "destructive_admin"),
        /Endpoint validation error: Invalid port "65536" in connection string\. Port must be between 1 and 65535\./,
      );

      // 10. Genuinely absent port: kept as 5432
      const absentPortConfig = validatePostgresConnectionString("postgresql://localhost/test_db", "destructive_admin");
      assert.equal(absentPortConfig.port, 5432);
      assert.equal(absentPortConfig.clientConfig.port, 5432);

      // Explicit valid port: preserved
      const explicitPortConfig = validatePostgresConnectionString("postgresql://localhost:5433/test_db", "destructive_admin");
      assert.equal(explicitPortConfig.port, 5433);
      assert.equal(explicitPortConfig.clientConfig.port, 5433);
    });

    it("rejects array and multiple host configurations without silently falling back to URL.hostname", () => {
      // 1. Multiple host query parameters
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost:5432/test_db?host=h1&host=h2", "destructive_admin"),
        /Safety violation: Multiple or ambiguous host parameters are not supported/,
      );

      // 2. Comma-separated host query parameter
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost:5432/test_db?host=localhost,127.0.0.1", "destructive_admin"),
        /Safety violation: Multiple or ambiguous effective hosts \("localhost,127\.0\.0\.1"\) are not supported/,
      );

      // 3. Comma-separated hosts in URL authority
      assert.throws(
        () => validatePostgresConnectionString("postgresql://localhost,127.0.0.1:5432/test_db", "destructive_admin"),
        /Safety violation: Multiple or ambiguous effective hosts/,
      );
    });
  });
});

const queueTestDatabaseUrl =
  process.env.FLUXORA_QUEUE_TEST_DATABASE_URL ??
  process.env.QUEUE_TEST_DATABASE_URL;

// PostgreSQL advisory locks are database-local, not cluster-global.
// To serialize concurrent test runs executing against the same PostgreSQL cluster and avoid race
// conditions over shared cluster-level roles (fluxora_auth, fluxora_tenant_guard, etc.), all test
// executions against that cluster must share a single canonical lock database.
// FLUXORA_CLUSTER_LOCK_DATABASE_URL provides the dedicated canonical database connection for locking.
// It must be explicitly configured; falling back to disposable databases or FLUXORA_QUEUE_TEST_DATABASE_URL is forbidden.
const clusterLockDatabaseUrl = process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL;

const hasQueueDatabase =
  typeof queueTestDatabaseUrl === "string" && queueTestDatabaseUrl.trim().length > 0;

const hasClusterLockDatabase =
  typeof clusterLockDatabaseUrl === "string" && clusterLockDatabaseUrl.trim().length > 0;

const allowDestructive =
  process.env.FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS === "true";

const isCI = process.env.CI === "true";

const shouldSkip = !isCI && (!hasQueueDatabase || !allowDestructive);

if (!isCI && shouldSkip) {
  const missing: string[] = [];
  if (!hasQueueDatabase) {
    missing.push("FLUXORA_QUEUE_TEST_DATABASE_URL");
  }
  if (!hasClusterLockDatabase) {
    missing.push("FLUXORA_CLUSTER_LOCK_DATABASE_URL");
  }
  if (!allowDestructive) {
    missing.push("FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true");
  }
  console.info(
    `[security-definer-hardening.test] Skipping destructive integration test: missing required configuration (${missing.join(", ")}).`,
  );
}

// Stable, session-level PostgreSQL advisory lock key.
// Dedicated lockClient connects to the canonical lock database (FLUXORA_CLUSTER_LOCK_DATABASE_URL)
// and holds this advisory lock for the entire duration of the test run and cleanup.
const CLUSTER_ROLE_SERIALIZATION_LOCK_KEY = "748920173849102837";

interface RoleSnapshot {
  exists: boolean;
  hasAuthIdAccess: boolean;
  rolpassword: string | null;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolbypassrls: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolconnlimit: number;
  rolvaliduntil: string | null;
  rolconfig: string[] | null;
}

describe.skipIf(shouldSkip)("Fix 3: PostgreSQL ADMIN OPTION, service-role isolation, and SECURITY DEFINER hardening", () => {
  const testRunSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const UPGRADE_TEST_DB = `fluxora_secdef_upg_${testRunSuffix}`;
  const CLEAN_TEST_DB = `fluxora_secdef_clean_${testRunSuffix}`;
  const TEST_MIGRATOR_ROLE = `fluxora_mig_${testRunSuffix}`;
  const TEST_MIGRATOR_PW = `fluxora_pw_${testRunSuffix}`;
  const UNAUTH_TEST_ROLE = `fluxora_unauth_${testRunSuffix}`;
  const APP_ROLE = "fluxora_app";
  const WORKER_ROLE = "fluxora_worker";
  const RLS_TEST_ROLE = "fluxora_rls_test";

  let lockClient: pg.Client;
  let adminClient: pg.Client;
  let adminBaseConfig: ValidatedPostgresConfig;
  let lockBaseConfig: ValidatedPostgresConfig;

  const initialRoleSnapshots = new Map<string, RoleSnapshot>();
  let initialMemberships: MembershipSnapshot[] = [];
  const createdExecutionRoles = new Set<string>();
  const createdServiceRoles = new Set<string>();
  const createdRuntimeRoles = new Set<string>();

  const TRACKED_CLUSTER_ROLES = [
    "fluxora_app",
    "fluxora_worker",
    "fluxora_rls_test",
    "fluxora_auth",
    "fluxora_tenant_guard",
    "fluxora_queue",
    "fluxora_bootstrap",
  ] as const;

  async function captureRoleSnapshot(client: pg.Client, rolname: string): Promise<RoleSnapshot | null> {
    try {
      const res = await client.query<{
        rolpassword: string | null;
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolconnlimit: number;
        rolvaliduntil: string | null;
        rolconfig: string[] | null;
      }>(`
        SELECT
          a.rolpassword,
          r.rolcanlogin,
          r.rolsuper,
          r.rolcreaterole,
          r.rolcreatedb,
          r.rolbypassrls,
          r.rolinherit,
          r.rolreplication,
          r.rolconnlimit,
          r.rolvaliduntil::text,
          r.rolconfig
        FROM pg_catalog.pg_roles r
        JOIN pg_catalog.pg_authid a ON a.rolname = r.rolname
        WHERE r.rolname = $1
      `, [rolname]);

      if (res.rows.length === 0) return null;
      const row = res.rows[0]!;
      return {
        exists: true,
        hasAuthIdAccess: true,
        rolpassword: row.rolpassword,
        rolcanlogin: row.rolcanlogin,
        rolsuper: row.rolsuper,
        rolcreaterole: row.rolcreaterole,
        rolcreatedb: row.rolcreatedb,
        rolbypassrls: row.rolbypassrls,
        rolinherit: row.rolinherit,
        rolreplication: row.rolreplication,
        rolconnlimit: row.rolconnlimit,
        rolvaliduntil: row.rolvaliduntil,
        rolconfig: row.rolconfig,
      };
    } catch {
      // Fallback if pg_authid is inaccessible to the current database role
      const res = await client.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolconnlimit: number;
        rolvaliduntil: string | null;
        rolconfig: string[] | null;
      }>(`
        SELECT
          rolcanlogin,
          rolsuper,
          rolcreaterole,
          rolcreatedb,
          rolbypassrls,
          rolinherit,
          rolreplication,
          rolconnlimit,
          rolvaliduntil::text,
          rolconfig
        FROM pg_catalog.pg_roles
        WHERE rolname = $1
      `, [rolname]);

      if (res.rows.length === 0) return null;
      const row = res.rows[0]!;
      return {
        exists: true,
        hasAuthIdAccess: false,
        rolpassword: null,
        rolcanlogin: row.rolcanlogin,
        rolsuper: row.rolsuper,
        rolcreaterole: row.rolcreaterole,
        rolcreatedb: row.rolcreatedb,
        rolbypassrls: row.rolbypassrls,
        rolinherit: row.rolinherit,
        rolreplication: row.rolreplication,
        rolconnlimit: row.rolconnlimit,
        rolvaliduntil: row.rolvaliduntil,
        rolconfig: row.rolconfig,
      };
    }
  }

  async function withRole<T>(
    client: pg.Client,
    role: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await client.query(`SET ROLE ${role}`);
    try {
      return await action();
    } finally {
      await client.query("RESET ROLE");
    }
  }

  beforeAll(async () => {
    if (!hasQueueDatabase) {
      throw new Error(
        "CI configuration error: FLUXORA_QUEUE_TEST_DATABASE_URL must be configured.",
      );
    }
    if (!allowDestructive) {
      throw new Error(
        "Destructive test safety violation: FLUXORA_ALLOW_DESTRUCTIVE_QUEUE_MIGRATION_TESTS=true required.",
      );
    }

    // Endpoint preflight validation: both URLs must target the same PostgreSQL server endpoint,
    // be on approved hosts, have matching normalized hostname and effective port,
    // have different database names, and lock database must not be dev or disposable.
    // This MUST be performed BEFORE connecting either client and BEFORE any database or cluster-role mutation.
    const validatedEndpoints = assertEndpointsTargetSamePostgresServer(
      clusterLockDatabaseUrl,
      queueTestDatabaseUrl,
    );
    lockBaseConfig = validatedEndpoints.lockConfig;
    adminBaseConfig = validatedEndpoints.adminConfig;

    // 1. Connect dedicated lockClient to canonical lock database.
    // In PostgreSQL, advisory locks are database-local, NOT cluster-global.
    // To serialize concurrent test runs executing against the same PostgreSQL cluster and avoid race
    // conditions over shared cluster-level roles (fluxora_auth, fluxora_tenant_guard, etc.), all test
    // executions against that cluster must share a single canonical lock database (FLUXORA_CLUSTER_LOCK_DATABASE_URL).
    // The client configuration uses exactly the effective validated configuration.
    lockClient = new pg.Client(lockBaseConfig.clientConfig);
    await lockClient.connect();
    await lockClient.query(`SELECT pg_advisory_lock(${CLUSTER_ROLE_SERIALIZATION_LOCK_KEY});`);

    // 2. Connect adminClient for disposable database and cluster-role operations.
    // The client configuration uses exactly the effective validated configuration.
    adminClient = new pg.Client(adminBaseConfig.clientConfig);
    await adminClient.connect();

    // Clean up stale disposable test databases
    await adminClient.query(`DROP DATABASE IF EXISTS ${UPGRADE_TEST_DB} WITH (FORCE);`);
    await adminClient.query(`DROP DATABASE IF EXISTS ${CLEAN_TEST_DB} WITH (FORCE);`);

    // 3. Capture initial snapshots of all cluster runtime and service roles
    // that existed BEFORE this test suite execution began.
    // Invariant:
    // a) Distinguish pre-existing roles from test-created roles.
    // b) Verify after test cleanup that pre-existing roles are NEVER dropped,
    //    and that their passwords and mutable attributes are byte-for-byte identical.
    for (const rname of TRACKED_CLUSTER_ROLES) {
      const snap = await captureRoleSnapshot(adminClient, rname);
      if (snap) {
        initialRoleSnapshots.set(rname, snap);
      }
    }

    // 4. Capture complete initial memberships involving tracked cluster roles
    // including role_name, member_name, grantor_name, admin_option, inherit_option, set_option.
    initialMemberships = await captureMembershipSnapshots(adminClient, TRACKED_CLUSTER_ROLES);

    // 3. Validate or pre-provision cluster service roles with strict attributes.
    // If a service role does not exist prior to this test run, create it as unprivileged NOLOGIN role
    // and track it in createdServiceRoles so it will be cleanly dropped in afterAll.
    // Note: Newly created roles are NOT added to initialRoleSnapshots!
    const serviceRoles = [
      "fluxora_auth",
      "fluxora_tenant_guard",
      "fluxora_queue",
      "fluxora_bootstrap",
    ];
    for (const rname of serviceRoles) {
      const snap = initialRoleSnapshots.get(rname);
      if (!snap) {
        await adminClient.query(`
          CREATE ROLE ${rname}
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        `);
        createdServiceRoles.add(rname);
      } else {
        // Validate existing role attributes without mutating them!
        assert.equal(snap.rolcanlogin, false, `${rname} must be NOLOGIN`);
        assert.equal(snap.rolsuper, false, `${rname} must not be superuser`);
        assert.equal(snap.rolcreaterole, false, `${rname} must not have CREATEROLE`);
        assert.equal(snap.rolcreatedb, false, `${rname} must not have CREATEDB`);
        assert.equal(snap.rolbypassrls, false, `${rname} must not have BYPASSRLS`);
        assert.equal(snap.rolinherit, false, `${rname} must have NOINHERIT`);
        assert.equal(snap.rolreplication, false, `${rname} must have NOREPLICATION`);
      }
    }

    // 4. Runtime roles: fluxora_app, fluxora_worker, fluxora_rls_test.
    // CRITICAL: NEVER ALTER existing roles, NEVER reset their passwords, and NEVER change
    // their attributes! If they exist, they are preserved untouched.
    // Only if they do not exist on a fresh test cluster, create them as unprivileged NOLOGIN roles
    // and track them in createdRuntimeRoles so they will be cleanly dropped in afterAll.
    const runtimeRoles = [APP_ROLE, WORKER_ROLE, RLS_TEST_ROLE];
    for (const rname of runtimeRoles) {
      const snap = initialRoleSnapshots.get(rname);
      if (!snap) {
        await adminClient.query(`
          CREATE ROLE ${rname}
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        `);
        createdRuntimeRoles.add(rname);
      }
    }

    // 5. Test-specific disposable service and runtime roles to explicitly exercise
    // test-created role cleanup and ensure createdServiceRoles / createdRuntimeRoles
    // cleanup is ALWAYS executed and asserted in afterAll, even if standard roles already exist.
    const TEST_SCOPED_SVC_ROLE = `fluxora_test_svc_${testRunSuffix}`;
    const TEST_SCOPED_RT_ROLE = `fluxora_test_rt_${testRunSuffix}`;

    await adminClient.query(`
      CREATE ROLE ${TEST_SCOPED_SVC_ROLE}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    `);
    createdServiceRoles.add(TEST_SCOPED_SVC_ROLE);

    await adminClient.query(`
      CREATE ROLE ${TEST_SCOPED_RT_ROLE}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    `);
    createdRuntimeRoles.add(TEST_SCOPED_RT_ROLE);

    // 6. Test-only role for unauthorized rejection testing:
    // Positively track in createdExecutionRoles only after successful creation.
    await adminClient.query(`
      CREATE ROLE ${UNAUTH_TEST_ROLE}
        NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    `);
    createdExecutionRoles.add(UNAUTH_TEST_ROLE);

    // 7. Test-only constrained migration role:
    // Positively track in createdExecutionRoles only after successful creation.
    await adminClient.query(`
      CREATE ROLE ${TEST_MIGRATOR_ROLE}
        LOGIN PASSWORD '${TEST_MIGRATOR_PW}'
        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    `);
    createdExecutionRoles.add(TEST_MIGRATOR_ROLE);
  });

  afterAll(async () => {
    let adminCleanupError: unknown;
    try {
      if (adminClient) {
        try {
          // 1. Drop test databases safely
          try {
            await adminClient.query(`DROP DATABASE IF EXISTS ${UPGRADE_TEST_DB} WITH (FORCE);`);
          } catch (err) {
            console.error(`Failed to drop ${UPGRADE_TEST_DB}:`, err);
          }
          try {
            await adminClient.query(`DROP DATABASE IF EXISTS ${CLEAN_TEST_DB} WITH (FORCE);`);
          } catch (err) {
            console.error(`Failed to drop ${CLEAN_TEST_DB}:`, err);
          }

          // 2. Revoke any lingering memberships from test migrator before dropping
          try {
            await adminClient.query(`
              DO $$
              BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_MIGRATOR_ROLE}') THEN
                  IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
                    REVOKE ADMIN OPTION FOR fluxora_bootstrap, fluxora_queue FROM ${TEST_MIGRATOR_ROLE};
                  END IF;
                  REVOKE fluxora_auth, fluxora_tenant_guard, fluxora_queue, fluxora_bootstrap FROM ${TEST_MIGRATOR_ROLE};
                END IF;
              END $$;
            `);
          } catch (err) {
            console.error(`Failed to revoke test migrator memberships:`, err);
          }

          // 3. Drop ONLY service/runtime roles that THIS SPECIFIC TEST EXECUTION created.
          // Invariant:
          // - Include both createdServiceRoles and createdRuntimeRoles.
          // - Never use DROP ROLE CASCADE.
          // - Never drop a role that existed before the test.
          const rolesToDrop = [...createdServiceRoles, ...createdRuntimeRoles].filter(
            (rname) => !initialRoleSnapshots.has(rname),
          );

          for (const rname of rolesToDrop) {
            try {
              await adminClient.query(`DROP ROLE IF EXISTS ${rname};`);
            } catch (err) {
              console.error(`Failed to drop test-created service/runtime role ${rname}:`, err);
            }
          }

          // 4. Drop ONLY execution roles positively identified as created by this execution
          // Never use DROP ROLE CASCADE.
          for (const rname of createdExecutionRoles) {
            try {
              await adminClient.query(`DROP ROLE IF EXISTS ${rname};`);
            } catch (err) {
              console.error(`Failed to drop test-created execution role ${rname}:`, err);
            }
          }

          // 5. Explicit assertions on absence after cleanup:
          // a. Current execution's migrator role is absent
          const migratorSnap = await captureRoleSnapshot(adminClient, TEST_MIGRATOR_ROLE);
          assert.equal(
            migratorSnap,
            null,
            `The current execution's migrator role "${TEST_MIGRATOR_ROLE}" must be absent after cleanup`,
          );

          // b. Current execution's unauthorized role is absent
          const unauthSnap = await captureRoleSnapshot(adminClient, UNAUTH_TEST_ROLE);
          assert.equal(
            unauthSnap,
            null,
            `The current execution's unauthorized role "${UNAUTH_TEST_ROLE}" must be absent after cleanup`,
          );

          // c. Every test-created service/runtime role is absent
          for (const rname of rolesToDrop) {
            const currentSnap = await captureRoleSnapshot(adminClient, rname);
            assert.equal(
              currentSnap,
              null,
              `Test-created service/runtime role "${rname}" must be absent from cluster after cleanup`,
            );
          }

          // d. No test-created memberships remain involving any created roles
          const allCreatedRoles = [...createdExecutionRoles, ...rolesToDrop];
          if (allCreatedRoles.length > 0) {
            const lingeringMem = await adminClient.query<{ role_name: string; member_name: string }>(`
              SELECT gr.rolname AS role_name, mr.rolname AS member_name
              FROM pg_catalog.pg_auth_members m
              JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
              JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
              WHERE mr.rolname = ANY($1::text[]) OR gr.rolname = ANY($1::text[])
            `, [allCreatedRoles]);
            assert.equal(
              lingeringMem.rows.length,
              0,
              "No memberships involving any test-created roles may linger after cleanup",
            );
          }

          // e. Pre-existing tracked cluster roles retain identical memberships and complete options
          const currentMemberships = await captureMembershipSnapshots(adminClient, TRACKED_CLUSTER_ROLES);
          assert.deepEqual(
            sortMembershipSnapshots(currentMemberships),
            sortMembershipSnapshots(initialMemberships),
            "Pre-existing role memberships and their complete options (admin_option, inherit_option, set_option, grantor) must remain unchanged after cleanup",
          );

          // 6. Verify that pre-existing roles remain present with unchanged passwords and attributes
          for (const [rname, preSnap] of initialRoleSnapshots.entries()) {
            const currentSnap = await captureRoleSnapshot(adminClient, rname);
            assert.ok(
              currentSnap,
              `Pre-existing role "${rname}" must remain present in cluster after cleanup`,
            );
            if (preSnap.hasAuthIdAccess && currentSnap.hasAuthIdAccess) {
              const passwordMatches = currentSnap.rolpassword === preSnap.rolpassword;
              assert.ok(
                passwordMatches,
                `Password of pre-existing role "${rname}" was altered during testing! (Password hash redacted)`,
              );
            } else {
              console.warn(
                `[ROLE_SNAPSHOT_WARNING] Password hash for role "${rname}" could not be inspected in afterAll cleanup verification due to lack of pg_authid access.`,
              );
            }
            assert.equal(currentSnap.rolcanlogin, preSnap.rolcanlogin, `rolcanlogin of "${rname}" changed!`);
            assert.equal(currentSnap.rolsuper, preSnap.rolsuper, `rolsuper of "${rname}" changed!`);
            assert.equal(currentSnap.rolbypassrls, preSnap.rolbypassrls, `rolbypassrls of "${rname}" changed!`);
            assert.equal(currentSnap.rolinherit, preSnap.rolinherit, `rolinherit of "${rname}" changed!`);
            assert.equal(currentSnap.rolcreaterole, preSnap.rolcreaterole, `rolcreaterole of "${rname}" changed!`);
            assert.equal(currentSnap.rolcreatedb, preSnap.rolcreatedb, `rolcreatedb of "${rname}" changed!`);
            assert.equal(currentSnap.rolreplication, preSnap.rolreplication, `rolreplication of "${rname}" changed!`);
            assert.equal(currentSnap.rolconnlimit, preSnap.rolconnlimit, `rolconnlimit of "${rname}" changed!`);
            assert.equal(currentSnap.rolvaliduntil, preSnap.rolvaliduntil, `rolvaliduntil of "${rname}" changed!`);
            assert.deepEqual(currentSnap.rolconfig, preSnap.rolconfig, `rolconfig of "${rname}" changed!`);
          }
        } finally {
          // Ensure adminClient closure cannot prevent lockClient closure
          try {
            await adminClient.end();
          } catch (err) {
            console.error("Failed to close adminClient:", err);
          }
        }
      }
    } catch (err) {
      adminCleanupError = err;
    } finally {
      // Unconditional outer finally: lock cleanup is completely independent of adminClient
      if (lockClient) {
        // Attempt explicit advisory unlock when lockClient exists.
        // Always close lockClient even if explicit unlock fails.
        // In PostgreSQL, closing the session automatically releases session-level advisory locks.
        try {
          await lockClient.query(
            `SELECT pg_advisory_unlock(${CLUSTER_ROLE_SERIALIZATION_LOCK_KEY});`,
          );
        } catch (err) {
          console.error("Failed to release cluster advisory lock:", err);
        } finally {
          try {
            await lockClient.end();
          } catch (err) {
            console.error("Failed to close lockClient:", err);
          }
        }
      }
    }

    if (adminCleanupError) {
      throw adminCleanupError;
    }
  });

  it("serializes a second lock contender with a distinct validated queue database configuration sharing the canonical lock database", async () => {
    // Session 1 (the test suite execution) holds the session-level advisory lock
    // (CLUSTER_ROLE_SERIALIZATION_LOCK_KEY) on the canonical lock database (FLUXORA_CLUSTER_LOCK_DATABASE_URL).
    //
    // Session 2 represents a second lock contender connecting to the same PostgreSQL cluster
    // with a distinct validated queue database configuration (FLUXORA_QUEUE_TEST_DATABASE_URL):
    const worker2QueueBaseUrl = new URL(queueTestDatabaseUrl!);
    worker2QueueBaseUrl.pathname = "/fluxora_queue_ci_worker2";
    assert.notEqual(
      worker2QueueBaseUrl.pathname,
      adminBaseConfig.pathname,
      "Simulated concurrent lock contender must have a distinct FLUXORA_QUEUE_TEST_DATABASE_URL",
    );

    // Both contenders targeting the same cluster share the canonical lock database:
    const worker2LockBaseUrl = clusterLockDatabaseUrl!;

    // Preflight endpoint validation for the second contender:
    const worker2Endpoints = assertEndpointsTargetSamePostgresServer(
      worker2LockBaseUrl,
      worker2QueueBaseUrl,
    );

    // Contender 2 opens an independent PostgreSQL session to the shared canonical lock database
    // using the exact validated client configuration:
    const worker2LockClient = new pg.Client(worker2Endpoints.lockConfig.clientConfig);
    await worker2LockClient.connect();
    try {
      // Contender 2 attempts non-blocking acquisition of the session-level advisory lock:
      const tryLockRes = await worker2LockClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${CLUSTER_ROLE_SERIALIZATION_LOCK_KEY}) AS acquired;`,
      );
      assert.equal(
        tryLockRes.rows[0]?.acquired,
        false,
        "A second lock contender connecting with a different FLUXORA_QUEUE_TEST_DATABASE_URL but the same FLUXORA_CLUSTER_LOCK_DATABASE_URL must NOT be able to acquire the session-level advisory lock held by Session 1",
      );
    } finally {
      await worker2LockClient.end();
    }
  });

  it("applies migration 0025 without ADMIN OPTION and verifies strict service-role isolation", async () => {
    // 1. Admin creates disposable upgrade database
    await adminClient.query(`CREATE DATABASE ${UPGRADE_TEST_DB};`);

    const dbAdminConfig = deriveClientConfig(adminBaseConfig, { database: UPGRADE_TEST_DB });
    const dbAdminClient = new pg.Client(dbAdminConfig);
    await dbAdminClient.connect();

    try {
      await dbAdminClient.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

      // Ensure constrained non-superuser migration role exists (NO CREATEROLE!)
      await dbAdminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${TEST_MIGRATOR_ROLE}') THEN
            CREATE ROLE ${TEST_MIGRATOR_ROLE}
              LOGIN PASSWORD '${TEST_MIGRATOR_PW}'
              NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
          END IF;
        END $$;
      `);

      // For historical migrations 0009 and 0020, grant temporary ADMIN OPTION on bootstrap and queue
      // so their historical GRANT statements can execute without error.
      await dbAdminClient.query(`
        DO $$
        BEGIN
          IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
            GRANT fluxora_bootstrap, fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
          ELSE
            GRANT fluxora_bootstrap, fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN OPTION;
          END IF;
        END $$;

        -- Prerequisite: PostgreSQL requires new schema owner to hold CREATE on the database
        -- when transferring schema ownership. Grant minimal required database privileges:
        GRANT CONNECT, CREATE ON DATABASE ${UPGRADE_TEST_DB} TO ${TEST_MIGRATOR_ROLE};
        ALTER SCHEMA public OWNER TO ${TEST_MIGRATOR_ROLE};
        -- Revoke temporary database CREATE grant immediately after schema ownership transfer:
        REVOKE CREATE ON DATABASE ${UPGRADE_TEST_DB} FROM ${TEST_MIGRATOR_ROLE};
      `);
    } finally {
      await dbAdminClient.end();
    }

    // 2. Connect as constrained non-superuser migration role
    const migratorConfig = deriveClientConfig(adminBaseConfig, {
      database: UPGRADE_TEST_DB,
      user: TEST_MIGRATOR_ROLE,
      password: TEST_MIGRATOR_PW,
    });
    const migratorClient = new pg.Client(migratorConfig);
    await migratorClient.connect();

    try {
      // 3. Apply historical migrations 0001 through 0024
      const migrationsDir = path.join(
        fileURLToPath(new URL("../../migrations/", import.meta.url)),
      );
      const files = (await readdir(migrationsDir))
        .filter((f) => f.endsWith(".sql"))
        .sort();

      const pre0025Files = files.filter((f) => f < "0025");
      for (const file of pre0025Files) {
        const sql = await readFile(path.join(migrationsDir, file), "utf8");
        await migratorClient.query(sql);
      }

      // Verify vulnerable baseline before 0025
      const baselineAuth = await migratorClient.query<{ public_exec: boolean; config: string[] }>(`
        SELECT
          COALESCE((
            SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
            FROM pg_catalog.aclexplode(p.proacl) acl
          ), p.proacl IS NULL) AS public_exec,
          p.proconfig AS config
        FROM pg_catalog.pg_proc p
        WHERE p.oid = 'public.fluxora_store_oauth_login_state(text, text, timestamptz)'::regprocedure;
      `);
      assert.equal(baselineAuth.rows[0]?.public_exec, true, "Pre-0025: store_oauth_login_state had PUBLIC execute");
      assert.deepEqual(baselineAuth.rows[0]?.config, ["search_path=pg_catalog, public"]);

      const baselineHelper = await migratorClient.query<{ public_exec: boolean; owner: string }>(`
        SELECT
          COALESCE((
            SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
            FROM pg_catalog.aclexplode(p.proacl) acl
          ), p.proacl IS NULL) AS public_exec,
          r.rolname AS owner
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'public.fluxora_snapshot_in_current_tenant(uuid)'::regprocedure;
      `);
      assert.equal(baselineHelper.rows[0]?.public_exec, true, "Pre-0025: snapshot helper had PUBLIC execute");
      assert.equal(baselineHelper.rows[0]?.owner, TEST_MIGRATOR_ROLE);
    } finally {
      await migratorClient.end();
    }

    // 4. Administrator setup for Fix 3:
    // - Revoke all ADMIN OPTION and memberships from historical bootstrap/queue roles.
    // - Pre-grant temporary ownership transfer on fluxora_auth and fluxora_tenant_guard:
    //   WITH SET TRUE, INHERIT FALSE, ADMIN FALSE (PostgreSQL 16+)
    const pre0025AdminConfig = deriveClientConfig(adminBaseConfig, { database: UPGRADE_TEST_DB });
    const pre0025AdminClient = new pg.Client(pre0025AdminConfig);
    await pre0025AdminClient.connect();
    try {
      await pre0025AdminClient.query(`
        DO $$
        BEGIN
          IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
            REVOKE ADMIN OPTION FOR fluxora_bootstrap, fluxora_queue FROM ${TEST_MIGRATOR_ROLE};
            REVOKE fluxora_bootstrap, fluxora_queue FROM ${TEST_MIGRATOR_ROLE};
            GRANT fluxora_auth, fluxora_tenant_guard TO ${TEST_MIGRATOR_ROLE} WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;
          ELSE
            REVOKE ADMIN OPTION FOR fluxora_bootstrap, fluxora_queue FROM ${TEST_MIGRATOR_ROLE};
            REVOKE fluxora_bootstrap, fluxora_queue FROM ${TEST_MIGRATOR_ROLE};
            GRANT fluxora_auth, fluxora_tenant_guard TO ${TEST_MIGRATOR_ROLE};
          END IF;
        END $$;
      `);
    } finally {
      await pre0025AdminClient.end();
    }

    // 5. Connect as constrained non-superuser migration role to apply migration 0025
    const migratorConfig2 = deriveClientConfig(adminBaseConfig, {
      database: UPGRADE_TEST_DB,
      user: TEST_MIGRATOR_ROLE,
      password: TEST_MIGRATOR_PW,
    });
    const migratorClient2 = new pg.Client(migratorConfig2);
    await migratorClient2.connect();

    try {
      const migrationsDir = path.join(
        fileURLToPath(new URL("../../migrations/", import.meta.url)),
      );
      const sql0025 = await readFile(path.join(migrationsDir, "0025_security_definer_hardening.sql"), "utf8");
      await migratorClient2.query(sql0025);

      // 6. Post-migration audit: verify every SECURITY DEFINER function in the database
      const secdefFunctions = await migratorClient2.query<{
        name: string;
        signature: string;
        owner: string;
        owner_superuser: boolean;
        owner_canlogin: boolean;
        search_path: string[];
        public_exec: boolean;
      }>(`
        SELECT
          p.proname AS name,
          pg_get_function_identity_arguments(p.oid) AS signature,
          r.rolname AS owner,
          r.rolsuper AS owner_superuser,
          r.rolcanlogin AS owner_canlogin,
          p.proconfig AS search_path,
          COALESCE((
            SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
            FROM pg_catalog.aclexplode(p.proacl) acl
          ), p.proacl IS NULL) AS public_exec
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'public' AND p.prosecdef = true
        ORDER BY p.proname;
      `);

      // Exactly 20 SECURITY DEFINER functions exist
      assert.equal(
        secdefFunctions.rows.length,
        20,
        "Exactly 20 SECURITY DEFINER functions must exist across the entire database",
      );

      for (const row of secdefFunctions.rows) {
        // a. Pinned search_path
        assert.deepEqual(
          row.search_path,
          ["search_path=pg_catalog, public, pg_temp"],
          `Function ${row.name}(${row.signature}) must have search_path = pg_catalog, public, pg_temp`,
        );

        // b. Revoked PUBLIC execute
        assert.equal(
          row.public_exec,
          false,
          `Function ${row.name}(${row.signature}) must not have PUBLIC execute`,
        );

        // c. Least-privilege dedicated owner
        assert.equal(
          row.owner_superuser,
          false,
          `Function ${row.name}(${row.signature}) owner ${row.owner} must not be superuser`,
        );
        assert.equal(
          row.owner_canlogin,
          false,
          `Function ${row.name}(${row.signature}) owner ${row.owner} must be NOLOGIN`,
        );

        const validOwners = ["fluxora_bootstrap", "fluxora_queue", "fluxora_auth", "fluxora_tenant_guard"];
        assert.ok(
          validOwners.includes(row.owner),
          `Function ${row.name}(${row.signature}) owner ${row.owner} must be one of ${validOwners.join(", ")}`,
        );
      }

      // 7. Direct PostgreSQL membership assertions on TEST_MIGRATOR_ROLE
      const isPg16PlusRes = await migratorClient2.query<{ is_16_plus: boolean }>(
        "SELECT current_setting('server_version_num')::int >= 160000 AS is_16_plus",
      );
      const isPg16Plus = isPg16PlusRes.rows[0]!.is_16_plus;

      if (isPg16Plus) {
        const memDetailRes = await migratorClient2.query<{
          role_name: string;
          admin_option: boolean;
          inherit_option: boolean;
          set_option: boolean;
        }>(`
          SELECT gr.rolname AS role_name, m.admin_option, m.inherit_option, m.set_option
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
          JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
          WHERE mr.rolname = $1
          ORDER BY gr.rolname;
        `, [TEST_MIGRATOR_ROLE]);

        for (const row of memDetailRes.rows) {
          assert.equal(
            row.admin_option,
            false,
            `Migration role must have admin_option = false on ${row.role_name}`,
          );
          assert.equal(
            row.inherit_option,
            false,
            `Migration role must have inherit_option = false on ${row.role_name}`,
          );
          assert.equal(
            row.set_option,
            true,
            `Migration role held set_option = true for temporary ownership transfer on ${row.role_name}`,
          );
        }
      }

      // 8. Verify migration role CANNOT grant service-role membership to any other role
      await migratorClient2.query(`
        GRANT USAGE ON SCHEMA public TO ${UNAUTH_TEST_ROLE};
      `);

      for (const serviceRole of ["fluxora_auth", "fluxora_tenant_guard", "fluxora_queue", "fluxora_bootstrap"]) {
        await assert.rejects(
          () => migratorClient2.query(`GRANT ${serviceRole} TO ${UNAUTH_TEST_ROLE}`),
          (err: Error) => {
            assert.match(
              err.message,
              /permission denied to grant role/,
              `Migration runner must NOT be able to grant ${serviceRole} to any role`,
            );
            return true;
          },
        );
      }

      // Establish test admin client for SET ROLE execution checks
      let org1 = "";
      const testAdminConfig = deriveClientConfig(adminBaseConfig, { database: UPGRADE_TEST_DB });
      const testAdminClient = new pg.Client(testAdminConfig);
      await testAdminClient.connect();

      try {
        // 9. Test Unauthorized Role Execution Rejection across ALL sensitive functions
        // We test all 19 directly callable SECURITY DEFINER functions in the audit inventory.
        // (The 20th function, public.fluxora_jobs_retry_limits_guard(), is a trigger-only function).
        const unauthorizedInvocations = [
          // Bootstrap (Fix 1) - 3 functions
          "SELECT public.fluxora_create_organization('test-org')",
          "SELECT public.fluxora_create_user('00000000-0000-0000-0000-000000000001'::uuid, 'user@test.com', 'member'::user_role)",
          "SELECT * FROM public.fluxora_provision_github_user(12345, 'user@test.com', 'test-org')",
          // Job Queue (Fix 2) - 4 directly callable functions
          "SELECT * FROM public.fluxora_claim_next_job('worker-1', 60)",
          "SELECT * FROM public.fluxora_complete_job('00000000-0000-0000-0000-000000000001'::uuid, 'worker-1')",
          "SELECT * FROM public.fluxora_fail_job('00000000-0000-0000-0000-000000000001'::uuid, 'worker-1', 'err')",
          "SELECT * FROM public.fluxora_retry_failed_job('00000000-0000-0000-0000-000000000001'::uuid, 'worker-1', 1, 'retry')",
          // Auth & Sessions (Fix 3) - 6 functions
          "SELECT public.fluxora_store_oauth_login_state('1111111111111111111111111111111111111111111111111111111111111111', 'code_verifier_1234567890123456789012345678901234567890', now() + interval '1 hour')",
          "SELECT public.fluxora_consume_oauth_login_state('1111111111111111111111111111111111111111111111111111111111111111')",
          "SELECT public.fluxora_insert_refresh_session('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000000003'::uuid, '1111111111111111111111111111111111111111111111111111111111111111', now() + interval '1 hour')",
          "SELECT * FROM public.fluxora_rotate_refresh_session('1111111111111111111111111111111111111111111111111111111111111111', '2222222222222222222222222222222222222222222222222222222222222222', now() + interval '1 hour')",
          "SELECT public.fluxora_revoke_refresh_family('1111111111111111111111111111111111111111111111111111111111111111')",
          "SELECT public.fluxora_revoke_user_refresh_sessions('00000000-0000-0000-0000-000000000002'::uuid)",
          // Tenant RLS Helpers (Fix 3) - 6 functions
          "SELECT public.fluxora_snapshot_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid)",
          "SELECT public.fluxora_analysis_run_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid)",
          "SELECT public.fluxora_pull_request_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid)",
          "SELECT public.fluxora_impact_analysis_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid)",
          "SELECT public.fluxora_scenario_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid)",
          "SELECT public.fluxora_simulation_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid)",
        ];

        assert.equal(
          unauthorizedInvocations.length,
          19,
          "Must test exactly 19 directly callable SECURITY DEFINER functions for unauthorized execution rejection",
        );

        for (const query of unauthorizedInvocations) {
          await assert.rejects(
            () => withRole(testAdminClient, UNAUTH_TEST_ROLE, () => testAdminClient.query(query)),
            (err: Error) => {
              assert.match(err.message, /permission denied for function/);
              return true;
            },
            `Unauthorized role must be rejected with permission denied when executing: ${query}`,
          );
        }

        // Separately verify the 20th SECURITY DEFINER function: trigger-only function fluxora_jobs_retry_limits_guard()
        const triggerProc = await testAdminClient.query<{ prorettype_name: string }>(`
          SELECT t.typname AS prorettype_name
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_type t ON t.oid = p.prorettype
          WHERE p.oid = 'public.fluxora_jobs_retry_limits_guard()'::regprocedure;
        `);
        assert.equal(
          triggerProc.rows[0]?.prorettype_name,
          "trigger",
          "fluxora_jobs_retry_limits_guard must be a trigger function returning type trigger",
        );

        await assert.rejects(
          () => withRole(testAdminClient, UNAUTH_TEST_ROLE, () =>
            testAdminClient.query("SELECT public.fluxora_jobs_retry_limits_guard()"),
          ),
          (err: Error) => {
            assert.match(err.message, /(permission denied for function|trigger function|cannot call)/i);
            return true;
          },
          "Direct invocation of trigger function must fail for unauthorized role",
        );

        // 10. Verify fluxora_rls_test receives NO authentication privileges from migration 0025
        const authInvocations = [
          "SELECT public.fluxora_store_oauth_login_state('2222222222222222222222222222222222222222222222222222222222222222', 'code_verifier_1234567890123456789012345678901234567890', now() + interval '1 hour')",
          "SELECT public.fluxora_consume_oauth_login_state('2222222222222222222222222222222222222222222222222222222222222222')",
          "SELECT public.fluxora_insert_refresh_session('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000000003'::uuid, '2222222222222222222222222222222222222222222222222222222222222222', now() + interval '1 hour')",
          "SELECT * FROM public.fluxora_rotate_refresh_session('2222222222222222222222222222222222222222222222222222222222222222', '3333333333333333333333333333333333333333333333333333333333333333', now() + interval '1 hour')",
          "SELECT public.fluxora_revoke_refresh_family('2222222222222222222222222222222222222222222222222222222222222222')",
          "SELECT public.fluxora_revoke_user_refresh_sessions('00000000-0000-0000-0000-000000000002'::uuid)",
        ];

        for (const query of authInvocations) {
          await assert.rejects(
            () => withRole(testAdminClient, RLS_TEST_ROLE, () => testAdminClient.query(query)),
            (err: Error) => {
              assert.match(err.message, /permission denied for function/);
              return true;
            },
            `fluxora_rls_test must not receive auth function execution privileges from migration 0025: ${query}`,
          );
        }

        // 11. Verify fluxora_worker receives ONLY tenant-helper permissions, NOT auth permissions
        const workerSnapRes = await withRole(testAdminClient, WORKER_ROLE, () =>
          testAdminClient.query<{ in_tenant: boolean }>(
            "SELECT public.fluxora_snapshot_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid) AS in_tenant",
          ),
        );
        assert.equal(workerSnapRes.rows[0]?.in_tenant, false);

        // Denied calling auth functions
        await assert.rejects(
          () => withRole(testAdminClient, WORKER_ROLE, () =>
            testAdminClient.query("SELECT public.fluxora_store_oauth_login_state('3333333333333333333333333333333333333333333333333333333333333333', 'code_verifier_1234567890123456789012345678901234567890', now() + interval '1 hour')"),
          ),
          (err: Error) => {
            assert.match(err.message, /permission denied for function/);
            return true;
          },
          "fluxora_worker must be denied execution on auth functions",
        );

        // 12. Verify fluxora_app application role CAN call all auth and tenant helper functions
        const orgRes = await migratorClient2.query<{ id: string }>(
          "SELECT public.fluxora_create_organization('App Org') AS id",
        );
        const appOrgId = orgRes.rows[0]!.id;

        const userRes = await migratorClient2.query<{ id: string }>(
          "SELECT public.fluxora_create_user($1::uuid, 'app-user@test.com', 'member'::user_role) AS id",
          [appOrgId],
        );
        const appUserId = userRes.rows[0]!.id;

        await withRole(testAdminClient, APP_ROLE, async () => {
          // Auth 1 & 2: Store and consume OAuth login state
          const validHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
          const validVerifier = "real_verifier_1234567890123456789012345678901234567890";
          await testAdminClient.query(
            "SELECT public.fluxora_store_oauth_login_state($1, $2, now() + interval '10 minutes')",
            [validHash, validVerifier],
          );
          const consumed = await testAdminClient.query<{ verifier: string }>(
            "SELECT public.fluxora_consume_oauth_login_state($1) AS verifier",
            [validHash],
          );
          assert.equal(consumed.rows[0]?.verifier, validVerifier);

          // Auth 3: Insert refresh session
          const familyId = "00000000-0000-0000-0000-000000000020";
          const tokenHash1 = "1111111111111111111111111111111111111111111111111111111111111111";
          const sessionRes = await testAdminClient.query<{ id: string }>(
            "SELECT public.fluxora_insert_refresh_session($1::uuid, $2::uuid, $3::uuid, $4, now() + interval '1 hour') AS id",
            [familyId, appUserId, appOrgId, tokenHash1],
          );
          assert.ok(sessionRes.rows[0]?.id);

          // Auth 4: Rotate refresh session
          const tokenHash2 = "2222222222222222222222222222222222222222222222222222222222222222";
          const rotateRes = await testAdminClient.query<{ result_status: string; result_user_id: string }>(
            "SELECT result_status, result_user_id FROM public.fluxora_rotate_refresh_session($1, $2, now() + interval '1 hour')",
            [tokenHash1, tokenHash2],
          );
          assert.equal(rotateRes.rows[0]?.result_status, "rotated");
          assert.equal(rotateRes.rows[0]?.result_user_id, appUserId);

          // Auth 5: Revoke refresh family
          await testAdminClient.query("SELECT public.fluxora_revoke_refresh_family($1)", [tokenHash2]);

          // Auth 6: Revoke user refresh sessions
          const revokeCountRes = await testAdminClient.query<{ count: number }>(
            "SELECT public.fluxora_revoke_user_refresh_sessions($1::uuid) AS count",
            [appUserId],
          );
          assert.equal(revokeCountRes.rows[0]?.count, 0);

          // Tenant helpers under fluxora_app
          const tenantRes = await testAdminClient.query<{ in_tenant: boolean }>(
            "SELECT public.fluxora_snapshot_in_current_tenant('00000000-0000-0000-0000-000000000001'::uuid) AS in_tenant",
          );
          assert.equal(tenantRes.rows[0]?.in_tenant, false);
        });

        // 13. Test Search-Path Shadowing Defense
        await migratorClient2.query(`
          CREATE TEMP TABLE oauth_login_states (
            state_hash text,
            code_verifier text,
            expires_at timestamptz
          );
          INSERT INTO pg_temp.oauth_login_states VALUES (
            '4444444444444444444444444444444444444444444444444444444444444444',
            'MALICIOUS_SHADOWED_VERIFIER',
            now() + interval '1 hour'
          );
        `);

        // Execute under fluxora_app using withRole
        const shadowHash = "5555555555555555555555555555555555555555555555555555555555555555";
        const shadowVerifier = "real_app_verifier_1234567890123456789012345678901234567890";
        await withRole(testAdminClient, APP_ROLE, async () => {
          await testAdminClient.query(
            "SELECT public.fluxora_store_oauth_login_state($1, $2, now() + interval '10 minutes')",
            [shadowHash, shadowVerifier],
          );

          const consumed = await testAdminClient.query<{ verifier: string }>(
            "SELECT public.fluxora_consume_oauth_login_state($1) AS verifier",
            [shadowHash],
          );
          assert.equal(consumed.rows[0]?.verifier, shadowVerifier);
        });

        // Verify pg_temp in migrator was untouched
        const tempRow = await migratorClient2.query("SELECT * FROM pg_temp.oauth_login_states");
        assert.equal(tempRow.rows.length, 1);
        assert.equal(tempRow.rows[0]?.code_verifier, "MALICIOUS_SHADOWED_VERIFIER");

        // 14. Test Tenant RLS Helper Isolation
        const org1Res = await migratorClient2.query<{ id: string }>(
          "SELECT public.fluxora_create_organization('Org 1') AS id",
        );
        org1 = org1Res.rows[0]!.id;

        const org2Res = await migratorClient2.query<{ id: string }>(
          "SELECT public.fluxora_create_organization('Org 2') AS id",
        );
        const org2 = org2Res.rows[0]!.id;

        await migratorClient2.query(`SET app.current_org_id = '${org1}'`);
        const repoRes = await migratorClient2.query<{ id: string }>(
          "INSERT INTO public.repositories (organization_id, github_repo_id, name, default_branch) VALUES ($1, 20001, 'repo-1', 'main') RETURNING id",
          [org1],
        );
        const repoId = repoRes.rows[0]!.id;

        const snapRes = await migratorClient2.query<{ id: string }>(
          "INSERT INTO public.repository_snapshots (repository_id, commit_sha, ref, storage_uri, file_count, size_bytes, sha256) VALUES ($1, '1111111111111111111111111111111111111111', 'refs/heads/main', 's3://bucket/test', 1, 100, '0000000000000000000000000000000000000000000000000000000000000000') RETURNING id",
          [repoId],
        );
        const snapId = snapRes.rows[0]!.id;

        // Check tenant helpers under tenant contexts using withRole
        await withRole(testAdminClient, WORKER_ROLE, async () => {
          try {
            await testAdminClient.query(`SET app.current_org_id = '${org1}'`);
            const check1 = await testAdminClient.query<{ in_tenant: boolean }>(
              "SELECT public.fluxora_snapshot_in_current_tenant($1) AS in_tenant",
              [snapId],
            );
            assert.equal(check1.rows[0]?.in_tenant, true, "Under Org 1: must be true");

            await testAdminClient.query(`SET app.current_org_id = '${org2}'`);
            const check2 = await testAdminClient.query<{ in_tenant: boolean }>(
              "SELECT public.fluxora_snapshot_in_current_tenant($1) AS in_tenant",
              [snapId],
            );
            assert.equal(check2.rows[0]?.in_tenant, false, "Under Org 2: must be false");

            await testAdminClient.query("RESET app.current_org_id");
            const check3 = await testAdminClient.query<{ in_tenant: boolean }>(
              "SELECT public.fluxora_snapshot_in_current_tenant($1) AS in_tenant",
              [snapId],
            );
            assert.equal(check3.rows[0]?.in_tenant, false, "Under NULL org: must be false");
          } finally {
            await testAdminClient.query("RESET app.current_org_id");
          }
        });
      } finally {
        await testAdminClient.end();
      }

      await migratorClient2.query("RESET app.current_org_id");

      // 15. Verify worker queue functionality remains intact
      await migratorClient2.query(`SET app.current_org_id = '${org1}'`);
      const enqueueRes = await migratorClient2.query<{ id: string }>(
        `INSERT INTO public.jobs (organization_id, type, idempotency_key, max_attempts, configured_max_attempts)
         VALUES ($1, 'test.secdef.queue', 'secdef-queue-key', 3, 3)
         RETURNING id`,
        [org1],
      );
      const enqueuedJobId = enqueueRes.rows[0]!.id;

      // Claim job as worker
      const claimed = await migratorClient2.query<{ id: string; status: string; configured_max_attempts: number }>(
        "SELECT id, status, configured_max_attempts FROM public.fluxora_claim_next_job('secdef-worker', 30)",
      );
      assert.equal(claimed.rows[0]?.id, enqueuedJobId);
      assert.equal(claimed.rows[0]?.status, "running");
      assert.equal(claimed.rows[0]?.configured_max_attempts, 3);

      // Complete job
      const completed = await migratorClient2.query<{ id: string; status: string }>(
        "SELECT id, status FROM public.fluxora_complete_job($1, 'secdef-worker')",
        [enqueuedJobId],
      );
      assert.equal(completed.rows[0]?.id, enqueuedJobId);
      assert.equal(completed.rows[0]?.status, "completed");

      await migratorClient2.query("RESET app.current_org_id");
    } finally {
      await migratorClient2.end();
    }

    // 16. Post-migration administrator cleanup: Revoke temporary memberships from TEST_MIGRATOR_ROLE
    const cleanupAdminConfig = deriveClientConfig(adminBaseConfig, { database: UPGRADE_TEST_DB });
    const cleanupAdminClient = new pg.Client(cleanupAdminConfig);
    await cleanupAdminClient.connect();
    try {
      await cleanupAdminClient.query(`
        REVOKE fluxora_auth, fluxora_tenant_guard FROM ${TEST_MIGRATOR_ROLE};
      `);

      // Verify REAL membership cleanup: zero rows in pg_auth_members
      const finalMemRows = await cleanupAdminClient.query<{ role_name: string }>(`
        SELECT gr.rolname AS role_name
        FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
        JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
        WHERE gr.rolname IN ('fluxora_auth', 'fluxora_tenant_guard', 'fluxora_queue', 'fluxora_bootstrap')
          AND mr.rolname = $1;
      `, [TEST_MIGRATOR_ROLE]);

      assert.equal(
        finalMemRows.rows.length,
        0,
        "Migration role must have ZERO membership records across all service roles after administrator cleanup",
      );
    } finally {
      await cleanupAdminClient.end();
    }
  });

  it("performs clean installation from 0001 through 0025 using a constrained non-superuser role", async () => {
    // 1. Admin creates disposable clean install database
    await adminClient.query(`CREATE DATABASE ${CLEAN_TEST_DB};`);

    const dbAdminConfig = deriveClientConfig(adminBaseConfig, { database: CLEAN_TEST_DB });
    const dbAdminClient = new pg.Client(dbAdminConfig);
    await dbAdminClient.connect();

    try {
      await dbAdminClient.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

      await dbAdminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${TEST_MIGRATOR_ROLE}') THEN
            CREATE ROLE ${TEST_MIGRATOR_ROLE}
              LOGIN PASSWORD '${TEST_MIGRATOR_PW}'
              NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
          END IF;
        END $$;
      `);

      // Pre-grant temporary ownership-transfer membership:
      // For historical 0009 and 0020: temporary ADMIN TRUE on bootstrap and queue
      // For 0025: temporary SET TRUE, INHERIT FALSE, ADMIN FALSE on auth and tenant_guard
      await dbAdminClient.query(`
        DO $$
        BEGIN
          IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
            GRANT fluxora_bootstrap, fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
            GRANT fluxora_auth, fluxora_tenant_guard TO ${TEST_MIGRATOR_ROLE} WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;
          ELSE
            GRANT fluxora_bootstrap, fluxora_queue TO ${TEST_MIGRATOR_ROLE} WITH ADMIN OPTION;
            GRANT fluxora_auth, fluxora_tenant_guard TO ${TEST_MIGRATOR_ROLE};
          END IF;
        END $$;

        -- Prerequisite: PostgreSQL requires new schema owner to hold CREATE on the database
        -- when transferring schema ownership. Grant minimal required database privileges:
        GRANT CONNECT, CREATE ON DATABASE ${CLEAN_TEST_DB} TO ${TEST_MIGRATOR_ROLE};
        ALTER SCHEMA public OWNER TO ${TEST_MIGRATOR_ROLE};
        -- Revoke temporary database CREATE grant immediately after schema ownership transfer:
        REVOKE CREATE ON DATABASE ${CLEAN_TEST_DB} FROM ${TEST_MIGRATOR_ROLE};
      `);
    } finally {
      await dbAdminClient.end();
    }

    // 2. Connect as constrained non-superuser migration role
    const migratorConfig = deriveClientConfig(adminBaseConfig, {
      database: CLEAN_TEST_DB,
      user: TEST_MIGRATOR_ROLE,
      password: TEST_MIGRATOR_PW,
    });
    const migratorClient = new pg.Client(migratorConfig);
    await migratorClient.connect();

    try {
      // 3. Apply ALL migrations 0001 through 0025 in sequence
      const migrationsDir = path.join(
        fileURLToPath(new URL("../../migrations/", import.meta.url)),
      );
      const files = (await readdir(migrationsDir))
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const sql = await readFile(path.join(migrationsDir, file), "utf8");
        await migratorClient.query(sql);
      }

      // 4. Verify all 20 SECURITY DEFINER functions in fresh database
      const secdefFunctions = await migratorClient.query<{
        name: string;
        signature: string;
        owner: string;
        owner_superuser: boolean;
        owner_canlogin: boolean;
        search_path: string[];
        public_exec: boolean;
      }>(`
        SELECT
          p.proname AS name,
          pg_get_function_identity_arguments(p.oid) AS signature,
          r.rolname AS owner,
          r.rolsuper AS owner_superuser,
          r.rolcanlogin AS owner_canlogin,
          p.proconfig AS search_path,
          COALESCE((
            SELECT bool_or(acl.privilege_type = 'EXECUTE' AND acl.grantee = 0)
            FROM pg_catalog.aclexplode(p.proacl) acl
          ), p.proacl IS NULL) AS public_exec
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'public' AND p.prosecdef = true
        ORDER BY p.proname;
      `);

      assert.equal(
        secdefFunctions.rows.length,
        20,
        "Clean install: exactly 20 SECURITY DEFINER functions must exist",
      );

      for (const row of secdefFunctions.rows) {
        assert.deepEqual(
          row.search_path,
          ["search_path=pg_catalog, public, pg_temp"],
          `Clean install: function ${row.name} must have pinned search_path`,
        );
        assert.equal(
          row.public_exec,
          false,
          `Clean install: function ${row.name} must have PUBLIC execute revoked`,
        );
        assert.equal(row.owner_superuser, false);
        assert.equal(row.owner_canlogin, false);
      }

      // 5. Verify schema public create privilege is revoked from PUBLIC
      const schemaPublicAcl = await migratorClient.query<{ has_create: boolean }>(`
        SELECT bool_or(acl.privilege_type = 'CREATE' AND acl.grantee = 0) AS has_create
        FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) acl
        WHERE n.nspname = 'public';
      `);
      assert.equal(
        schemaPublicAcl.rows[0]?.has_create ?? false,
        false,
        "Clean install: PUBLIC must not have CREATE on schema public",
      );

    } finally {
      await migratorClient.end();
    }

    // 6. Admin post-migration cleanup: explicitly revoke ADMIN OPTION and memberships
    const cleanupAdminConfig = deriveClientConfig(adminBaseConfig, { database: CLEAN_TEST_DB });
    const cleanupAdminClient = new pg.Client(cleanupAdminConfig);
    await cleanupAdminClient.connect();
    try {
      await cleanupAdminClient.query(`
        DO $$
        BEGIN
          IF pg_catalog.current_setting('server_version_num')::int >= 160000 THEN
            REVOKE ADMIN OPTION FOR fluxora_bootstrap, fluxora_queue FROM ${TEST_MIGRATOR_ROLE};
          END IF;
          REVOKE fluxora_bootstrap, fluxora_queue, fluxora_auth, fluxora_tenant_guard
          FROM ${TEST_MIGRATOR_ROLE};
        END $$;
      `);

      const finalMemRows = await cleanupAdminClient.query<{ role_name: string }>(`
        SELECT gr.rolname AS role_name
        FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
        JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
        WHERE gr.rolname IN ('fluxora_auth', 'fluxora_tenant_guard', 'fluxora_queue', 'fluxora_bootstrap')
          AND mr.rolname = $1;
      `, [TEST_MIGRATOR_ROLE]);

      assert.equal(
        finalMemRows.rows.length,
        0,
        "Clean install: migration role must have zero service-role memberships after admin cleanup",
      );
    } finally {
      await cleanupAdminClient.end();
    }
  });

  it("leaves existing cluster runtime and service role passwords and attributes unchanged", async () => {
    for (const rname of TRACKED_CLUSTER_ROLES) {
      const preSnap = initialRoleSnapshots.get(rname);
      if (preSnap) {
        const currentSnap = await captureRoleSnapshot(adminClient, rname);
        assert.ok(currentSnap, `Role ${rname} must still exist`);
        if (preSnap.hasAuthIdAccess && currentSnap.hasAuthIdAccess) {
          const passwordMatches = currentSnap.rolpassword === preSnap.rolpassword;
          assert.ok(
            passwordMatches,
            `Password for role "${rname}" was modified during testing! Passwords must never be altered. (Password hash redacted)`,
          );
        } else {
          console.warn(
            `[ROLE_SNAPSHOT_NOTICE] Password hash for role "${rname}" was not verified because pg_authid access is unavailable in this environment.`,
          );
        }
        assert.equal(
          currentSnap.rolcanlogin,
          preSnap.rolcanlogin,
          `rolcanlogin for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolsuper,
          preSnap.rolsuper,
          `rolsuper for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolbypassrls,
          preSnap.rolbypassrls,
          `rolbypassrls for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolinherit,
          preSnap.rolinherit,
          `rolinherit for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolcreaterole,
          preSnap.rolcreaterole,
          `rolcreaterole for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolcreatedb,
          preSnap.rolcreatedb,
          `rolcreatedb for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolreplication,
          preSnap.rolreplication,
          `rolreplication for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolconnlimit,
          preSnap.rolconnlimit,
          `rolconnlimit for "${rname}" was modified during testing!`,
        );
        assert.equal(
          currentSnap.rolvaliduntil,
          preSnap.rolvaliduntil,
          `rolvaliduntil for "${rname}" was modified during testing!`,
        );
        assert.deepEqual(
          currentSnap.rolconfig,
          preSnap.rolconfig,
          `rolconfig for "${rname}" was modified during testing!`,
        );
      }
    }
  });

  it("proves the constrained migration role possesses exact required schema privileges without superuser or BYPASSRLS", async () => {
    const testAdminConfig = deriveClientConfig(adminBaseConfig, { database: UPGRADE_TEST_DB });
    const testAdminClient = new pg.Client(testAdminConfig);
    await testAdminClient.connect();

    try {
      // 1. Assert constrained role attributes: NOT superuser, NO BYPASSRLS, NO CREATEROLE, NO CREATEDB
      const roleAttrs = await testAdminClient.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolcanlogin: boolean;
      }>(`
        SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
        FROM pg_catalog.pg_roles
        WHERE rolname = $1
      `, [TEST_MIGRATOR_ROLE]);

      assert.equal(roleAttrs.rows.length, 1);
      const migRole = roleAttrs.rows[0]!;
      assert.equal(migRole.rolsuper, false, "Migration role must NOT be superuser");
      assert.equal(migRole.rolbypassrls, false, "Migration role must NOT have BYPASSRLS");
      assert.equal(migRole.rolcreaterole, false, "Migration role must NOT have CREATEROLE");
      assert.equal(migRole.rolcreatedb, false, "Migration role must NOT have CREATEDB");
      assert.equal(migRole.rolcanlogin, true, "Migration role must have LOGIN");

      // 2. Assert schema public ownership: owned by TEST_MIGRATOR_ROLE
      const schemaOwnerRes = await testAdminClient.query<{
        schema_owner: string;
        is_owner: boolean;
      }>(`
        SELECT
          r.rolname AS schema_owner,
          (r.rolname = $1) AS is_owner
        FROM pg_catalog.pg_namespace n
        JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
        WHERE n.nspname = 'public';
      `, [TEST_MIGRATOR_ROLE]);

      assert.equal(schemaOwnerRes.rows.length, 1);
      assert.equal(
        schemaOwnerRes.rows[0]?.schema_owner,
        TEST_MIGRATOR_ROLE,
        "Schema public must be owned by the constrained migration role",
      );
      assert.equal(schemaOwnerRes.rows[0]?.is_owner, true);

      // 3. Assert that membership in fluxora_auth or fluxora_tenant_guard does NOT confer schema ownership
      const serviceRoleSchemaOwners = await testAdminClient.query<{ nspname: string }>(`
        SELECT n.nspname
        FROM pg_catalog.pg_namespace n
        JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
        WHERE r.rolname IN ('fluxora_auth', 'fluxora_tenant_guard')
          AND n.nspname = 'public';
      `);
      assert.equal(
        serviceRoleSchemaOwners.rows.length,
        0,
        "Neither fluxora_auth nor fluxora_tenant_guard may own schema public",
      );

      // 4. Assert explicit privilege capabilities required by migration 0025:
      // a. Database privileges: Possesses CONNECT on the database, but does NOT retain CREATE on the database
      const dbPrivRes = await testAdminClient.query<{
        has_connect: boolean;
        has_db_create: boolean;
      }>(`
        SELECT
          pg_catalog.has_database_privilege($1, current_database(), 'CONNECT') AS has_connect,
          pg_catalog.has_database_privilege($1, current_database(), 'CREATE') AS has_db_create
      `, [TEST_MIGRATOR_ROLE]);
      assert.equal(dbPrivRes.rows[0]?.has_connect, true, "Migration role must have CONNECT on database");
      assert.equal(dbPrivRes.rows[0]?.has_db_create, false, "Migration role must NOT have CREATE on database");

      // b. Has CREATE and USAGE on schema public
      const privRes = await testAdminClient.query<{
        has_create: boolean;
        has_usage: boolean;
      }>(`
        SELECT
          pg_catalog.has_schema_privilege($1, 'public', 'CREATE') AS has_create,
          pg_catalog.has_schema_privilege($1, 'public', 'USAGE') AS has_usage
      `, [TEST_MIGRATOR_ROLE]);
      assert.equal(privRes.rows[0]?.has_create, true, "Migration role must have CREATE on schema public");
      assert.equal(privRes.rows[0]?.has_usage, true, "Migration role must have USAGE on schema public");

      // b. Revoking CREATE from PUBLIC: PUBLIC must not retain CREATE on schema public
      const publicCreateRes = await testAdminClient.query<{ public_has_create: boolean }>(`
        SELECT COALESCE(
          bool_or(acl.privilege_type = 'CREATE' AND acl.grantee = 0),
          false
        ) AS public_has_create
        FROM pg_catalog.pg_namespace n
        CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) acl
        WHERE n.nspname = 'public';
      `);
      assert.equal(
        publicCreateRes.rows[0]?.public_has_create,
        false,
        "PUBLIC must not possess CREATE on schema public after migration 0025",
      );

      // c. Service roles must NOT retain lingering CREATE on schema public
      const serviceRoleCreateRes = await testAdminClient.query<{
        auth_has_create: boolean;
        tg_has_create: boolean;
      }>(`
        SELECT
          pg_catalog.has_schema_privilege('fluxora_auth', 'public', 'CREATE') AS auth_has_create,
          pg_catalog.has_schema_privilege('fluxora_tenant_guard', 'public', 'CREATE') AS tg_has_create
      `);
      assert.equal(
        serviceRoleCreateRes.rows[0]?.auth_has_create,
        false,
        "fluxora_auth must not retain CREATE on schema public after migration 0025",
      );
      assert.equal(
        serviceRoleCreateRes.rows[0]?.tg_has_create,
        false,
        "fluxora_tenant_guard must not retain CREATE on schema public after migration 0025",
      );

      // d. Functions were successfully transferred to dedicated least-privilege owners
      const transferredOwners = await testAdminClient.query<{ proname: string; owner: string }>(`
        SELECT p.proname, r.rolname AS owner
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'public'
          AND p.proname IN ('fluxora_store_oauth_login_state', 'fluxora_snapshot_in_current_tenant');
      `);
      for (const row of transferredOwners.rows) {
        if (row.proname === "fluxora_store_oauth_login_state") {
          assert.equal(row.owner, "fluxora_auth", "Function must be owned by fluxora_auth");
        }
        if (row.proname === "fluxora_snapshot_in_current_tenant") {
          assert.equal(row.owner, "fluxora_tenant_guard", "Function must be owned by fluxora_tenant_guard");
        }
      }

      // e. RLS settings and policies: Tables have FORCE ROW LEVEL SECURITY enabled
      const rlsRes = await testAdminClient.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('oauth_login_states', 'refresh_sessions', 'repositories');
      `);
      for (const row of rlsRes.rows) {
        assert.equal(row.relrowsecurity, true, `Table ${row.relname} must have RLS enabled`);
        assert.equal(row.relforcerowsecurity, true, `Table ${row.relname} must have FORCE RLS enabled`);
      }
    } finally {
      await testAdminClient.end();
    }
  });
});
