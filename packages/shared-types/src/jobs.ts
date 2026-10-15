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

/** PostgreSQL job type handled for pull request webhooks (Step 41). */
export const PULL_REQUEST_WEBHOOK_JOB_TYPE = "pull_request.webhook" as const;

export type SupportedPullRequestAction = "opened" | "synchronize";

export interface NormalizedPullRequestWebhookPayload {
  readonly eventType: "pull_request";
  readonly action: SupportedPullRequestAction;
  readonly deliveryId?: string;
  readonly installationId: string;
  readonly organizationId: string;
  readonly repository: {
    readonly githubRepoId: string;
    readonly name: string;
    readonly owner: string;
    readonly fullName: string;
  };
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly title?: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly headRef: string;
    readonly headSha: string;
  };
  readonly sender?: {
    readonly githubUserId: string;
    readonly login: string;
  };
}

/** Stable idempotency key for GitHub pull request webhook processing. */
export function pullRequestWebhookIdempotencyKey(deliveryId: string): string {
  return `${PULL_REQUEST_WEBHOOK_JOB_TYPE}:${deliveryId}`;
}

export function parsePullRequestWebhookPayload(
  payload: JobPayload,
): NormalizedPullRequestWebhookPayload | null {
  if (
    payload["eventType"] !== "pull_request" ||
    (payload["action"] !== "opened" && payload["action"] !== "synchronize")
  ) {
    return null;
  }

  const installationId = payload["installationId"];
  const organizationId = payload["organizationId"];
  const deliveryId = payload["deliveryId"];
  const repo = payload["repository"] as Record<string, unknown> | undefined;
  const pr = payload["pullRequest"] as Record<string, unknown> | undefined;
  const sender = payload["sender"] as Record<string, unknown> | undefined;

  if (typeof installationId !== "string" || installationId.length === 0) {
    return null;
  }

  if (typeof organizationId !== "string" || !UUID_PATTERN.test(organizationId)) {
    return null;
  }

  if (deliveryId !== undefined && typeof deliveryId !== "string") {
    return null;
  }

  if (
    typeof repo !== "object" ||
    repo === null ||
    typeof repo["githubRepoId"] !== "string" ||
    typeof repo["name"] !== "string" ||
    typeof repo["owner"] !== "string" ||
    typeof repo["fullName"] !== "string"
  ) {
    return null;
  }

  if (
    typeof pr !== "object" ||
    pr === null ||
    typeof pr["number"] !== "number" ||
    !Number.isSafeInteger(pr["number"]) ||
    pr["number"] <= 0 ||
    typeof pr["url"] !== "string" ||
    typeof pr["baseRef"] !== "string" ||
    typeof pr["baseSha"] !== "string" ||
    typeof pr["headRef"] !== "string" ||
    typeof pr["headSha"] !== "string"
  ) {
    return null;
  }

  const senderObj =
    typeof sender === "object" &&
    sender !== null &&
    typeof sender["githubUserId"] === "string" &&
    typeof sender["login"] === "string"
      ? {
          githubUserId: sender["githubUserId"],
          login: sender["login"],
        }
      : undefined;

  return {
    eventType: "pull_request",
    action: payload["action"],
    ...(typeof deliveryId === "string" ? { deliveryId } : {}),
    installationId,
    organizationId,
    repository: {
      githubRepoId: repo["githubRepoId"],
      name: repo["name"],
      owner: repo["owner"],
      fullName: repo["fullName"],
    },
    pullRequest: {
      number: pr["number"],
      url: pr["url"],
      ...(typeof pr["title"] === "string" ? { title: pr["title"] } : {}),
      baseRef: pr["baseRef"],
      baseSha: pr["baseSha"],
      headRef: pr["headRef"],
      headSha: pr["headSha"],
    },
    ...(senderObj !== undefined ? { sender: senderObj } : {}),
  };
}
