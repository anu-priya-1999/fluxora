import type pg from "pg";

/** Session variable read by Postgres RLS policies (`06-database-schema.md` §6.5). */
export const TENANT_SESSION_VARIABLE = "app.current_org_id";

export async function setTenantOnClient(
  client: pg.PoolClient,
  organizationId: string,
): Promise<void> {
  await client.query(`SELECT set_config($1, $2, true)`, [
    TENANT_SESSION_VARIABLE,
    organizationId,
  ]);
}

export type TenantScopedCallback<T> = (client: pg.PoolClient) => Promise<T>;

/**
 * Runs `fn` inside a transaction with `app.current_org_id` set for RLS.
 * Callers must use the supplied client for all queries in `fn`.
 */
const DATABASE_ROLE_ENV = "FLUXORA_DATABASE_ROLE";

function localDatabaseRole(): string | null {
  const role = process.env[DATABASE_ROLE_ENV];
  if (role === undefined || role.length === 0) {
    return null;
  }

  if (!/^[a-z][a-z0-9_]*$/.test(role)) {
    throw new Error(`${DATABASE_ROLE_ENV} is not a safe SQL identifier`);
  }

  return role;
}

export async function withTenant<T>(
  pool: pg.Pool,
  organizationId: string,
  fn: TenantScopedCallback<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const role = localDatabaseRole();
    if (role !== null) {
      // Superusers bypass FORCE RLS. Tests (and any non-bypass app role)
      // set FLUXORA_DATABASE_ROLE so policies are actually evaluated.
      await client.query(`SET LOCAL ROLE ${role}`);
    }
    await setTenantOnClient(client, organizationId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
