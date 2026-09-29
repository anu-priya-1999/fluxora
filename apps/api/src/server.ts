import { shutdownTelemetry } from "./telemetry.ts";
import { closePool, getPool } from "@fluxora/db";
import { loadAuthConfig } from "./config.ts";
import { loadRootEnv } from "./env.ts";
import { createApiServer } from "./http/server.ts";

loadRootEnv();

const config = loadAuthConfig();
const server = createApiServer(config);

await getPool().query("SELECT 1");

server.listen(config.port, () => {
  console.log(`Fluxora API listening on port ${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    void closePool()
      .then(() => shutdownTelemetry())
      .catch((error: unknown) => {
        console.error("[observability] shutdown failed:", error);
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
