import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migrationPath = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0011_repositories_snapshots_commits.sql",
);

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("0011 creates tenant-owned repositories and parent-chain child RLS", async () => {
  const sql = executableSql(await readFile(migrationPath, "utf8"));

  assert.match(sql, /CREATE TABLE repositories/);
  assert.match(sql, /CREATE TABLE repository_snapshots/);
  assert.match(sql, /CREATE TABLE commits/);

  assert.match(
    sql,
    /CONSTRAINT repositories_organization_github_repo_id_unique UNIQUE \(organization_id, github_repo_id\)/,
  );
  assert.match(
    sql,
    /CONSTRAINT repository_snapshots_repository_commit_sha_unique UNIQUE \(repository_id, commit_sha\)/,
  );
  assert.match(
    sql,
    /CONSTRAINT commits_repository_sha_unique UNIQUE \(repository_id, sha\)/,
  );

  assert.match(sql, /ALTER TABLE repositories FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE repository_snapshots FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE commits FORCE ROW LEVEL SECURITY/);

  assert.match(
    sql,
    /CREATE POLICY repositories_tenant_select ON repositories FOR SELECT USING \(organization_id = fluxora_current_org_id\(\)\)/,
  );
  assert.match(
    sql,
    /CREATE POLICY repository_snapshots_tenant_select ON repository_snapshots FOR SELECT USING \(fluxora_repository_in_current_tenant\(repository_id\)\)/,
  );
  assert.match(
    sql,
    /CREATE POLICY commits_tenant_select ON commits FOR SELECT USING \(fluxora_repository_in_current_tenant\(repository_id\)\)/,
  );

  assert.equal(sql.includes("CREATE POLICY repository_snapshots_tenant_update"), false);
  assert.equal(sql.includes("CREATE POLICY commits_tenant_update"), false);

  const snapshotStart = sql.indexOf("CREATE TABLE repository_snapshots");
  const commitStart = sql.indexOf("CREATE TABLE commits");
  const functionStart = sql.indexOf("CREATE OR REPLACE FUNCTION");
  const snapshotCreate = sql.slice(snapshotStart, commitStart);
  const commitCreate = sql.slice(commitStart, functionStart);
  assert.equal(snapshotCreate.includes("organization_id"), false);
  assert.equal(commitCreate.includes("organization_id"), false);
});
