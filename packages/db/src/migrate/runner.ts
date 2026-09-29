import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

const MIGRATIONS_TABLE = "schema_migrations";

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listPendingMigrations(
  client: pg.PoolClient,
  migrationsDir: string,
): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();

  const applied = await client.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  const appliedNames = new Set(applied.rows.map((row) => row.name));

  return sqlFiles.filter((name) => !appliedNames.has(name));
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: number;
}

export async function runMigrations(pool: pg.Pool): Promise<RunMigrationsResult> {
  const migrationsDir = path.join(
    fileURLToPath(new URL("../../", import.meta.url)),
    "migrations",
  );

  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);

    const pending = await listPendingMigrations(client, migrationsDir);

    for (const fileName of pending) {
      const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
      await client.query(sql);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [
        fileName,
      ]);
      applied.push(fileName);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const allFiles = (await readdir(migrationsDir)).filter((name) =>
    name.endsWith(".sql"),
  ).length;

  return {
    applied,
    skipped: allFiles - applied.length,
  };
}
