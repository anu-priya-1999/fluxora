import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { getDatabaseUrl } from "../config.ts";
import { provisionGithubUser } from "../repositories/user.ts";
import { assertLocalDevelopmentDatabase, loadRootEnvFile } from "./env.ts";
import { fileURLToPath } from "node:url";

const LOCAL_SEED = {
  githubUserId: 900000001,
  email: "local.owner@fluxora.dev",
  organizationName: "Fluxora Local",
} as const;

export async function seedLocalData(): Promise<void> {
  const pool = getPool();
  const user = await provisionGithubUser(pool, LOCAL_SEED);

  console.log("Seeded local organization/user:");
  console.log(`  organization: ${user.organizationId}`);
  console.log(`  user:         ${user.id}`);
  console.log(`  email:        ${user.email}`);
}

async function main(): Promise<void> {
  loadRootEnvFile();

  const databaseUrl = getDatabaseUrl();
  assertLocalDevelopmentDatabase(databaseUrl);

  const pool = getPool();

  try {
    const migrations = await runMigrations(pool);

    if (migrations.applied.length > 0) {
      console.log(`Applied ${migrations.applied.length} migration(s).`);
    }

    await seedLocalData();
  } finally {
    await closePool();
  }
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] === currentFile) {
  // Only run main() if this file is executed directly, not imported
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
