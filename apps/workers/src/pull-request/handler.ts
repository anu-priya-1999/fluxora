import {
  getPool,
  getRepositoryByGithubRepoId,
  savePullRequestWithFiles,
} from "@fluxora/db";
import {
  PULL_REQUEST_WEBHOOK_JOB_TYPE,
  type Job,
} from "@fluxora/shared-types";

import type { JobHandler } from "../handlers.ts";
import {
  createGithubIngestClient,
  type GithubPullRequestClient,
} from "../github/client.ts";
import { loadGithubAppConfig } from "../github/config.ts";
import {
  permanentIngestionError,
  retryableIngestionError,
} from "../ingest/errors.ts";
import { loadPullRequestLimits } from "./limits.ts";
import {
  processPullRequestJob,
  type PullRequestProcessorDependencies,
} from "./processor.ts";

export function createProductionPullRequestDependencies(
  env: NodeJS.ProcessEnv = process.env,
): PullRequestProcessorDependencies {
  const config = loadGithubAppConfig(env);

  return {
    lookup: {
      async getRepositoryByGithubRepoId(organizationId, githubRepoId) {
        return getRepositoryByGithubRepoId(getPool(), organizationId, githubRepoId);
      },
    },
    github:
      config === null
        ? missingGithubConfigClient()
        : createGithubIngestClient({ config }),
    storage: {
      async savePullRequestWithFiles(input) {
        return savePullRequestWithFiles(getPool(), input);
      },
    },
    limits: loadPullRequestLimits(env),
  };
}

export function createPullRequestWebhookHandler(
  deps: PullRequestProcessorDependencies,
): JobHandler {
  return async (job: Job): Promise<void> => {
    if (job.type !== PULL_REQUEST_WEBHOOK_JOB_TYPE) {
      throw permanentIngestionError(
        "invalid_payload",
        `handler received unexpected job type ${job.type}`,
      );
    }

    await processPullRequestJob(job, deps);
  };
}

function missingGithubConfigClient(): GithubPullRequestClient {
  const missing = (): never => {
    throw retryableIngestionError(
      "misconfigured",
      "GitHub App credentials are not configured on the worker",
    );
  };

  return {
    mintInstallationToken: missing,
    getPullRequest: missing,
    getPullRequestFiles: missing,
  };
}
