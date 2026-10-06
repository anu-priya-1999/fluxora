import {
  createEvent,
  createRepositorySnapshot,
  getGithubInstallationByOrganizationId,
  getPool,
  getRepositoryById,
  updateRepository,
} from "@fluxora/db";
import type { ObjectStorageClient } from "@fluxora/infrastructure";
import {
  REPOSITORY_INGEST_JOB_TYPE,
  type Job,
} from "@fluxora/shared-types";

import type { JobHandler } from "../handlers.ts";
import { createGithubIngestClient } from "../github/client.ts";
import { loadGithubAppConfig } from "../github/config.ts";
import { redactForLog } from "../github/redact.ts";
import { retryableIngestionError, permanentIngestionError } from "./errors.ts";
import { ingestRepositoryJob } from "./ingest.ts";
import type { RepositoryIngestDependencies } from "./ingest.ts";
import { loadIngestLimits } from "./limits.ts";
import {
  createObjectStorageClient,
  loadObjectStorageConfig,
  objectStorageUri,
} from "./storage-config.ts";
import { removeIngestWorkDir } from "./workdir.ts";

export function createProductionIngestDependencies(
  env: NodeJS.ProcessEnv = process.env,
): RepositoryIngestDependencies {
  const config = loadGithubAppConfig(env);
  const storageConfig = loadObjectStorageConfig(env);
  const pool = getPool();
  const storage =
    storageConfig === null
      ? missingObjectStorageClient()
      : createObjectStorageClient(storageConfig);

  return {
    lookup: {
      async getRepositoryById(organizationId, repositoryId) {
        return getRepositoryById(pool, organizationId, repositoryId);
      },
      async getGithubInstallationId(organizationId) {
        const installation = await getGithubInstallationByOrganizationId(
          pool,
          organizationId,
        );
        return installation === null ? null : installation.githubInstallationId;
      },
      async updateConnectionStatus(organizationId, repositoryId, status) {
        await updateRepository(pool, organizationId, repositoryId, {
          connectionStatus: status,
        });
      },
    },
    github:
      config === null
        ? missingGithubConfigClient()
        : createGithubIngestClient({ config }),
    limits: loadIngestLimits(env),
    storage,
    objectStorageUri: (key) => {
      if (storageConfig === null) {
        throw retryableIngestionError(
          "misconfigured",
          "object storage is not configured on the worker",
        );
      }

      return objectStorageUri(storageConfig, key);
    },
    snapshots: {
      create(input) {
        return createRepositorySnapshot(pool, input);
      },
    },
    events: {
      async publish(input) {
        return createEvent(pool, input);
      },
    },
  };
}

export function createRepositoryIngestHandler(
  deps: RepositoryIngestDependencies,
): JobHandler {
  const removeWorkDir = deps.removeWorkDir ?? removeIngestWorkDir;

  return async (job: Job): Promise<void> => {
    if (job.type !== REPOSITORY_INGEST_JOB_TYPE) {
      throw permanentIngestionError(
        "invalid_payload",
        `handler received unexpected job type ${job.type}`,
      );
    }

    const result = await ingestRepositoryJob(job, deps);
    try {
      console.info(
        redactForLog(
          `[repository.ingest] completed job=${result.jobId} org=${result.organizationId} repo=${result.repositoryId} ref=${result.ref} commit=${result.commitSha} snapshot=${result.snapshotId} files=${result.fileCount} bytes=${result.sizeBytes}${result.event !== undefined ? ` event=${result.event.id}` : ""}`,
        ),
      );
    } finally {
      await removeWorkDir(result.workDir);
    }
  };
}

function missingGithubConfigClient(): RepositoryIngestDependencies["github"] {
  const missing = (): never => {
    throw retryableIngestionError(
      "misconfigured",
      "GitHub App credentials are not configured on the worker",
    );
  };

  return {
    mintInstallationToken: missing,
    getRepository: missing,
    resolveCommit: missing,
    downloadTarball: missing,
  };
}

function missingObjectStorageClient(): ObjectStorageClient {
  const missing = async (): Promise<never> => {
    throw retryableIngestionError(
      "misconfigured",
      "object storage is not configured on the worker",
    );
  };

  return {
    put: missing,
    get: missing,
    exists: missing,
    delete: missing,
    close: async () => undefined,
  };
}
