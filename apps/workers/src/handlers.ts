import type { Job } from "@fluxora/shared-types";
import { REPOSITORY_INGEST_JOB_TYPE } from "@fluxora/shared-types";

import { testEchoHandler } from "./handlers/test-echo.ts";
import {
  createProductionIngestDependencies,
  createRepositoryIngestHandler,
} from "./ingest/handler.ts";

export type JobHandler = (job: Job) => Promise<void>;

export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;

export function createDefaultJobHandlers(options?: {
  ingestHandler?: JobHandler;
}): JobHandlerRegistry {
  return {
    "test.echo": testEchoHandler,
    [REPOSITORY_INGEST_JOB_TYPE]:
      options?.ingestHandler ??
      createRepositoryIngestHandler(createProductionIngestDependencies()),
  };
}
