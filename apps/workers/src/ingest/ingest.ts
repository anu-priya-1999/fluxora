import type { Job, RepositoryIngestJobPayload } from "@fluxora/shared-types";
import { parseRepositoryIngestJobPayload } from "@fluxora/shared-types";
import type { Repository } from "@fluxora/shared-types";

import { getTracer, markSpanError, markSpanSuccess } from "@fluxora/observability";

import type { GithubIngestClient } from "../github/client.ts";
import { redactForLog } from "../github/redact.ts";
import { extractTarGz } from "./archive.ts";
import { IngestionError, permanentIngestionError } from "./errors.ts";
import type { IngestLimits } from "./limits.ts";
import { createIngestWorkDir, removeIngestWorkDir } from "./workdir.ts";

const tracer = getTracer("@fluxora/workers");

export interface RepositoryIngestResult {
  repositoryId: string;
  organizationId: string;
  jobId: string;
  ref: string;
  commitSha: string;
  workDir: string;
  fileCount: number;
  sizeBytes: number;
  fullName: string;
}

export interface RepositoryLookup {
  getRepositoryById(
    organizationId: string,
    repositoryId: string,
  ): Promise<Repository | null>;
  getGithubInstallationId(organizationId: string): Promise<string | null>;
  updateConnectionStatus(
    organizationId: string,
    repositoryId: string,
    status: Repository["connectionStatus"],
  ): Promise<void>;
}

export interface RepositoryIngestDependencies {
  lookup: RepositoryLookup;
  github: GithubIngestClient;
  limits: IngestLimits;
  createWorkDir?: () => Promise<string>;
  removeWorkDir?: (directory: string) => Promise<void>;
}

export async function ingestRepository(input: {
  organizationId: string;
  jobId: string;
  payload: RepositoryIngestJobPayload;
  deps: RepositoryIngestDependencies;
}): Promise<RepositoryIngestResult> {
  const { organizationId, jobId, payload, deps } = input;
  const span = tracer.startSpan("fluxora.ingest.repository", {
    attributes: {
      "fluxora.repository.id": payload.repositoryId,
      "fluxora.job.organization_id": organizationId,
      "fluxora.job.id": jobId,
      "fluxora.ingest.ref": payload.ref,
    },
  });
  const started = Date.now();
  let workDir: string | undefined;
  const createWorkDir = deps.createWorkDir ?? createIngestWorkDir;
  const removeWorkDir = deps.removeWorkDir ?? removeIngestWorkDir;

  try {
    const repository = await deps.lookup.getRepositoryById(
      organizationId,
      payload.repositoryId,
    );

    if (repository === null || repository.organizationId !== organizationId) {
      throw permanentIngestionError(
        "tenant_mismatch",
        "repository does not belong to the job organization",
      );
    }

    const installationId = await deps.lookup.getGithubInstallationId(
      organizationId,
    );
    if (installationId === null) {
      throw permanentIngestionError(
        "github_auth",
        "organization has no GitHub App installation",
        { repositoryStatus: "needs_reauth" },
      );
    }

    const token = await deps.github.mintInstallationToken(installationId);
    const repoInfo = await deps.github.getRepository(
      token,
      repository.githubRepoId,
    );
    const commit = await deps.github.resolveCommit(
      token,
      repoInfo.fullName,
      payload.ref,
    );

    if (payload.commitSha !== undefined && payload.commitSha !== commit.sha) {
      throw permanentIngestionError(
        "invalid_ref",
        "payload commitSha does not match the resolved GitHub ref",
        { repositoryStatus: "error" },
      );
    }

    workDir = await createWorkDir();
    const signal = AbortSignal.timeout(deps.limits.timeoutMs);
    const archive = await deps.github.downloadTarball(
      token,
      repoInfo.fullName,
      commit.sha,
      deps.limits,
      signal,
    );
    const extracted = await extractTarGz(
      archive,
      workDir,
      deps.limits,
      signal,
    );

    await deps.lookup.updateConnectionStatus(
      organizationId,
      repository.id,
      "active",
    );

    span.setAttributes({
      "fluxora.ingest.commit_sha": commit.sha,
      "fluxora.ingest.file_count": extracted.fileCount,
      "fluxora.ingest.size_bytes": extracted.totalBytes,
      "fluxora.ingest.duration_ms": Date.now() - started,
    });
    markSpanSuccess(span);

    return {
      repositoryId: repository.id,
      organizationId,
      jobId,
      ref: payload.ref,
      commitSha: commit.sha,
      workDir,
      fileCount: extracted.fileCount,
      sizeBytes: extracted.totalBytes,
      fullName: repoInfo.fullName,
    };
  } catch (error) {
    if (workDir !== undefined) {
      await removeWorkDir(workDir).catch(() => undefined);
    }

    if (error instanceof IngestionError) {
      await applyFailureStatus(
        deps.lookup,
        organizationId,
        payload.repositoryId,
        error,
      );
      logIngestFailure({
        organizationId,
        jobId,
        repositoryId: payload.repositoryId,
        ref: payload.ref,
        error,
        durationMs: Date.now() - started,
      });
      markSpanError(span, error);
      throw error;
    }

    markSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

export async function ingestRepositoryJob(
  job: Job,
  deps: RepositoryIngestDependencies,
): Promise<RepositoryIngestResult> {
  const payload = parseRepositoryIngestJobPayload(job.payload);
  if (payload === null) {
    throw permanentIngestionError(
      "invalid_payload",
      "repository.ingest payload is invalid",
    );
  }

  return ingestRepository({
    organizationId: job.organizationId,
    jobId: job.id,
    payload,
    deps,
  });
}

async function applyFailureStatus(
  lookup: RepositoryLookup,
  organizationId: string,
  repositoryId: string,
  error: IngestionError,
): Promise<void> {
  if (error.repositoryStatus === null) {
    return;
  }

  await lookup
    .updateConnectionStatus(organizationId, repositoryId, error.repositoryStatus)
    .catch(() => undefined);
}

function logIngestFailure(input: {
  organizationId: string;
  jobId: string;
  repositoryId: string;
  ref: string;
  error: IngestionError;
  durationMs: number;
}): void {
  console.error(
    redactForLog(
      `[repository.ingest] failed job=${input.jobId} org=${input.organizationId} repo=${input.repositoryId} ref=${input.ref} code=${input.error.code} duration_ms=${input.durationMs}`,
    ),
  );
}
