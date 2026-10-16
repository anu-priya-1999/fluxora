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
import {
  createProductionPullRequestDependencies,
  createPullRequestWebhookHandler,
} from "./pull-request/handler.ts";

export type JobHandler = (job: Job) => Promise<void>;

export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;

export const pullRequestWebhookJobHandler: JobHandler =
  createPullRequestWebhookHandler(createProductionPullRequestDependencies());

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
      options?.pullRequestWebhookHandler ??
      createPullRequestWebhookHandler(createProductionPullRequestDependencies()),
  };
}
