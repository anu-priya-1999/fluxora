import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migrationPath = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0012_repository_snapshot_sha256.sql",
);

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("0012 adds immutable snapshot sha256 without introducing UPDATE policies", async () => {
  const sql = executableSql(await readFile(migrationPath, "utf8"));

  assert.match(sql, /ALTER TABLE repository_snapshots ADD COLUMN sha256 text/);
  assert.match(
    sql,
    /CONSTRAINT repository_snapshots_sha256_format CHECK \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/,
  );
  assert.match(sql, /ALTER COLUMN sha256 SET NOT NULL/);
  assert.equal(sql.includes("CREATE POLICY"), false);
  assert.equal(sql.includes("UPDATE"), false);
});
