import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migrationPath = path.join(
  fileURLToPath(new URL("../../migrations/", import.meta.url)),
  "0010_grant_bootstrap_function_execute.sql",
);

const BOOTSTRAP_FUNCTIONS = [
  "public.fluxora_create_organization(text, public.plan_tier, bigint)",
  "public.fluxora_create_user(uuid, text, public.user_role, bigint)",
  "public.fluxora_provision_github_user(bigint, text, text)",
] as const;

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("0010 grants bootstrap execute to the migration role after ownership stays with fluxora_bootstrap", async () => {
  const sql = executableSql(await readFile(migrationPath, "utf8"));

  const membershipGrant = sql.indexOf("GRANT fluxora_bootstrap TO CURRENT_USER");
  const membershipRevoke = sql.indexOf("REVOKE fluxora_bootstrap FROM CURRENT_USER");
  assert.ok(membershipGrant >= 0);
  assert.ok(membershipRevoke > membershipGrant);

  const executeGrants = [
    ...sql.matchAll(/GRANT EXECUTE ON FUNCTION [^;]+;/g),
  ].map((match) => match[0]);
  assert.deepEqual(
    executeGrants,
    BOOTSTRAP_FUNCTIONS.map(
      (signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO CURRENT_USER;`,
    ),
  );

  for (const grant of executeGrants) {
    const at = sql.indexOf(grant);
    assert.ok(at > membershipGrant);
    assert.ok(at < membershipRevoke);
  }

  assert.equal(sql.includes("TO PUBLIC"), false);
  assert.equal(sql.includes("BYPASSRLS"), false);
  assert.equal(sql.includes("OWNER TO"), false);
  assert.equal(sql.includes("ALTER FUNCTION"), false);
  assert.equal(sql.includes("ROW LEVEL SECURITY"), false);
  assert.equal(sql.includes("CREATE POLICY"), false);
  assert.match(sql, /expected fluxora_bootstrap/);
  assert.match(sql, /grantee = 0/);
  assert.match(sql, /inherit_option/);
  assert.match(sql, /server_version_num/);
  assert.match(sql, /must not inherit fluxora_bootstrap/);
});
