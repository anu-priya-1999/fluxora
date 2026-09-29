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
export async function withTenant<T>(
  pool: pg.Pool,
  organizationId: string,
  fn: TenantScopedCallback<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
