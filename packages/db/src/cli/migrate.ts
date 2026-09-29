import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";

/** Loads repo-root `.env` when `DATABASE_URL` is not already set (local migrate convenience). */
function loadRootEnvFile(): void {
  const envPath = path.resolve(
    fileURLToPath(new URL("../../../../.env", import.meta.url)),
  );
  if (!existsSync(envPath)) {
    return;
  }
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadRootEnvFile();
  const pool = getPool();
  const result = await runMigrations(pool);

  if (result.applied.length === 0) {
    console.log("No pending migrations.");
  } else {
    console.log(`Applied migrations:\n${result.applied.map((name) => `  - ${name}`).join("\n")}`);
  }

  await closePool();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
