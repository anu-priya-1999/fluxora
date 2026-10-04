import { closePool, getPool } from "@fluxora/db";

import { loadRootEnv } from "./env.ts";
import { createDefaultJobHandlers } from "./handlers.ts";
import { JobWorker } from "./worker.ts";

loadRootEnv();

const workerId =
  process.env.FLUXORA_WORKER_ID?.trim() ||
  `fluxora-worker-${process.pid}`;

const worker = new JobWorker({
  workerId,
  handlers: createDefaultJobHandlers(),
});

await getPool().query("SELECT 1");

const shutdown = new AbortController();

void worker.run(shutdown.signal).catch((error: unknown) => {
  console.error("[worker] stopped:", error);
  process.exitCode = 1;
});

function stop(): void {
  shutdown.abort();
  void closePool().finally(() => {
    process.exit(0);
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
