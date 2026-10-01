import { closePool, getPool } from "../pool.ts";
import { getDatabaseUrl } from "../config.ts";
import { assertLocalDevelopmentDatabase, loadRootEnvFile } from "./env.ts";
import { seedLocalData } from "./seed.ts";

async function main(): Promise<void> {
  loadRootEnvFile();

  const databaseUrl = getDatabaseUrl();
  assertLocalDevelopmentDatabase(databaseUrl);

  const pool = getPool();

  try {
    console.log("Resetting local Fluxora data...");

    // Keep the schema and migration history intact. CASCADE clears tenant data
    // and any current/future rows that reference organizations.
    await pool.query("TRUNCATE TABLE oauth_login_states");
    await pool.query("TRUNCATE TABLE organizations CASCADE");

    await seedLocalData();
    console.log("Local data reset and reseeded.");
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
