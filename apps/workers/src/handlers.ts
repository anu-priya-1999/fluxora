import type { Job } from "@fluxora/shared-types";
import {
  PULL_REQUEST_WEBHOOK_JOB_TYPE,
  REPOSITORY_INGEST_JOB_TYPE,
} from "@fluxora/shared-types";

import { testEchoHandler } from "./handlers/test-echo.ts";
import {
  createProductionIngestDependencies,
  createRepositoryIngestHandler,
} from "./ingest/handler.ts";

export type JobHandler = (job: Job) => Promise<void>;

export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;

export const pullRequestWebhookJobHandler: JobHandler = async (
  job: Job,
): Promise<void> => {
  // Global Step 41: Minimal handoff/acceptance boundary.
  // Step 42+ will implement PR persistence, diff fetching, and impact analysis.
  if (job.type !== PULL_REQUEST_WEBHOOK_JOB_TYPE) {
    throw new Error(`Unexpected job type: ${job.type}`);
  }
};

export function createDefaultJobHandlers(options?: {
  ingestHandler?: JobHandler;
  pullRequestWebhookHandler?: JobHandler;
}): JobHandlerRegistry {
  return {
    "test.echo": testEchoHandler,
    [REPOSITORY_INGEST_JOB_TYPE]:
      options?.ingestHandler ??
      createRepositoryIngestHandler(createProductionIngestDependencies()),
    [PULL_REQUEST_WEBHOOK_JOB_TYPE]:
      options?.pullRequestWebhookHandler ?? pullRequestWebhookJobHandler,
  };
}
