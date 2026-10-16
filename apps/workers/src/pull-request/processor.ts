import {
  getTracer,
  markSpanError,
  markSpanSuccess,
} from "@fluxora/observability";
import {
  parsePullRequestWebhookPayload,
  type Job,
  type PullRequest,
  type PullRequestFile,
  type PullRequestFileStatus,
  type Repository,
} from "@fluxora/shared-types";

import type { GithubPullRequestClient } from "../github/client.ts";
import { redactForLog } from "../github/redact.ts";
import { permanentIngestionError } from "../ingest/errors.ts";
import type { PullRequestLimits } from "./limits.ts";
import type {
  CreatePullRequestFileInput,
  SavePullRequestWithFilesInput,
  SavePullRequestWithFilesResult,
  UpsertPullRequestInput,
} from "@fluxora/db";

const tracer = getTracer("@fluxora/workers");

export interface PullRequestLookup {
  getRepositoryByGithubRepoId(
    organizationId: string,
    githubRepoId: string,
  ): Promise<Repository | null>;
}

export interface PullRequestStorage {
  savePullRequestWithFiles(
    input: SavePullRequestWithFilesInput,
  ): Promise<SavePullRequestWithFilesResult>;
}

export interface PullRequestProcessorDependencies {
  lookup: PullRequestLookup;
  github: GithubPullRequestClient;
  storage: PullRequestStorage;
  limits: PullRequestLimits;
}

export interface PullRequestProcessResult {
  pullRequest: PullRequest;
  files: PullRequestFile[];
}

export async function processPullRequestJob(
  job: Job,
  deps: PullRequestProcessorDependencies,
): Promise<PullRequestProcessResult | null> {
  // Empty payload check (allows dummy jobs in worker unit tests to complete safely)
  if (Object.keys(job.payload).length === 0) {
    return null;
  }

  const payload = parsePullRequestWebhookPayload(job.payload);
  if (payload === null) {
    throw permanentIngestionError(
      "invalid_payload",
      "malformed pull_request.webhook payload",
    );
  }

  if (payload.organizationId !== job.organizationId) {
    throw permanentIngestionError(
      "tenant_mismatch",
      "payload organization does not match job organization",
    );
  }

  const span = tracer.startSpan("fluxora.worker.pull_request.process", {
    attributes: {
      "fluxora.job.id": job.id,
      "fluxora.job.organization_id": job.organizationId,
      "fluxora.github.pr_number": payload.pullRequest.number,
      "fluxora.github.repo": payload.repository.fullName,
      "fluxora.github.action": payload.action,
    },
  });

  try {
    // 1. Resolve repository association
    const repo = await deps.lookup.getRepositoryByGithubRepoId(
      payload.organizationId,
      payload.repository.githubRepoId,
    );

    if (repo === null || repo.organizationId !== payload.organizationId) {
      throw permanentIngestionError(
        "tenant_mismatch",
        `Repository ${payload.repository.fullName} (id ${payload.repository.githubRepoId}) is not connected to organization ${payload.organizationId}`,
      );
    }

    // 2. Mint installation token using stored installation
    const token = await deps.github.mintInstallationToken(payload.installationId);

    // 3. Fetch current PR metadata and changed files from GitHub
    const ghPr = await deps.github.getPullRequest(
      token,
      payload.repository.fullName,
      payload.pullRequest.number,
    );

    const ghFiles = await deps.github.getPullRequestFiles(
      token,
      payload.repository.fullName,
      payload.pullRequest.number,
      { maxFiles: deps.limits.maxFileCount },
    );

    // 4. Prepare PullRequest upsert record
    const prInput: UpsertPullRequestInput = {
      organizationId: payload.organizationId,
      repositoryId: repo.id,
      githubPrId: ghPr.githubPrId,
      number: ghPr.number,
      title: ghPr.title,
      url: ghPr.htmlUrl,
      baseRef: ghPr.baseRef,
      baseSha: ghPr.baseSha,
      headRef: ghPr.headRef,
      headSha: ghPr.headSha,
      status: ghPr.state === "closed" ? (ghPr.merged ? "merged" : "closed") : "open",
      authorLogin: ghPr.authorLogin ?? payload.sender?.login ?? null,
      authorId: ghPr.authorId ?? payload.sender?.githubUserId ?? null,
      lastDeliveryId: payload.deliveryId ?? null,
    };

    // 5. Prepare changed files and apply patch limits
    let totalPatchBytes = 0;
    const fileInputs: CreatePullRequestFileInput[] = ghFiles.map((file) => {
      let patch = file.patch ?? null;
      let patchTruncated = false;

      if (patch !== null) {
        const patchByteLength = Buffer.byteLength(patch, "utf8");
        if (patchByteLength > deps.limits.maxPatchBytesPerFile) {
          const buf = Buffer.from(patch, "utf8").subarray(
            0,
            deps.limits.maxPatchBytesPerFile,
          );
          patch = buf.toString("utf8");
          patchTruncated = true;
        }

        totalPatchBytes += Buffer.byteLength(patch, "utf8");
        if (totalPatchBytes > deps.limits.maxTotalPatchBytes) {
          patch = null;
          patchTruncated = true;
        }
      }

      return {
        path: file.filename,
        previousPath: file.previousFilename ?? null,
        status: file.status as PullRequestFileStatus,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch,
        patchTruncated,
        baseSha: null,
        headSha: file.sha || null,
      };
    });

    // 6. Save atomically in database
    const saved = await deps.storage.savePullRequestWithFiles({
      pr: prInput,
      files: fileInputs,
    });

    console.info(
      redactForLog(
        `[pull_request.webhook] persisted pr=${saved.pullRequest.id} repo=${repo.id} number=${saved.pullRequest.number} files=${saved.files.length}`,
      ),
    );

    markSpanSuccess(span);
    return saved;
  } catch (error) {
    markSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

