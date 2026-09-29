import pg from "pg";

import { getDatabaseUrl } from "./config.ts";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool === undefined) {
    pool = new pg.Pool({
      connectionString: getDatabaseUrl(),
      max: 10,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
