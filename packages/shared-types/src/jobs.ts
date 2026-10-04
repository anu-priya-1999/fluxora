export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter";

export type JobPayload = Record<string, unknown>;

export interface Job {
  id: string;
  organizationId: string;
  type: string;
  payload: JobPayload;
  status: JobStatus;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
}

export interface EnqueueJobInput {
  organizationId: string;
  type: string;
  payload?: JobPayload;
  idempotencyKey: string;
  maxAttempts?: number;
  availableAt?: Date;
}

/** Existing PostgreSQL job type handled by the ingestion worker. */
export const REPOSITORY_INGEST_JOB_TYPE = "repository.ingest" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * `repository.ingest` payload.
 * `commitSha` is optional: when omitted, the worker resolves it from `ref`.
 * When present, it must match the commit GitHub returns for `ref`.
 */
export interface RepositoryIngestJobPayload {
  repositoryId: string;
  ref: string;
  commitSha?: string;
}

/** Stable idempotency key for one repository commit. Used by enqueue (Step 13+). */
export function repositoryIngestIdempotencyKey(
  repositoryId: string,
  commitSha: string,
): string {
  return `${REPOSITORY_INGEST_JOB_TYPE}:${repositoryId}:${commitSha}`;
}

export function parseRepositoryIngestJobPayload(
  payload: JobPayload,
): RepositoryIngestJobPayload | null {
  const repositoryId = payload["repositoryId"];
  const ref = payload["ref"];
  const commitSha = payload["commitSha"];

  if (typeof repositoryId !== "string" || !UUID_PATTERN.test(repositoryId)) {
    return null;
  }

  if (typeof ref !== "string" || !isGitRef(ref)) {
    return null;
  }

  if (commitSha === undefined) {
    return { repositoryId, ref };
  }

  if (typeof commitSha !== "string" || !COMMIT_SHA_PATTERN.test(commitSha)) {
    return null;
  }

  return { repositoryId, ref, commitSha };
}

function isGitRef(value: string): boolean {
  if (value.length === 0 || value.length > 255) {
    return false;
  }

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32) {
      return false;
    }
  }

  return true;
}
