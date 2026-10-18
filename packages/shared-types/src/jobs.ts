import type {
  GraphEdgeType,
  GraphNodeType,
  TraversalDirection,
} from "./graph.ts";

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

/** PostgreSQL job type handled for pull request impact analysis (Step 45). */
export const PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE =
  "pull_request.impact_analysis" as const;

export interface PullRequestImpactAnalysisJobPayload {
  readonly pullRequestId: string;
  readonly analysisRunId?: string | undefined;
  readonly impactAnalysisId?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly direction?: TraversalDirection | undefined;
  readonly edgeTypes?: readonly GraphEdgeType[] | undefined;
  readonly nodeTypes?: readonly GraphNodeType[] | undefined;
  readonly decayFactor?: number | undefined;
  readonly includeEvidence?: boolean | undefined;
}

/** Stable idempotency key for PR impact analysis job enqueueing. */
export function pullRequestImpactAnalysisIdempotencyKey(
  pullRequestId: string,
  analysisRunId: string,
  key: string,
): string {
  return `${PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE}:${pullRequestId}:${analysisRunId}:${key}`;
}

export function parsePullRequestImpactAnalysisJobPayload(
  payload: JobPayload,
): PullRequestImpactAnalysisJobPayload | null {
  const pullRequestId = payload["pullRequestId"];
  if (typeof pullRequestId !== "string" || !UUID_PATTERN.test(pullRequestId)) {
    return null;
  }

  const analysisRunId = payload["analysisRunId"];
  if (
    analysisRunId !== undefined &&
    (typeof analysisRunId !== "string" || !UUID_PATTERN.test(analysisRunId))
  ) {
    return null;
  }

  const impactAnalysisId = payload["impactAnalysisId"];
  if (
    impactAnalysisId !== undefined &&
    (typeof impactAnalysisId !== "string" || !UUID_PATTERN.test(impactAnalysisId))
  ) {
    return null;
  }

  const maxDepth = payload["maxDepth"];
  if (
    maxDepth !== undefined &&
    (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 0)
  ) {
    return null;
  }

  const direction = payload["direction"];
  if (
    direction !== undefined &&
    direction !== "outgoing" &&
    direction !== "incoming" &&
    direction !== "both"
  ) {
    return null;
  }

  const edgeTypes = payload["edgeTypes"];
  if (edgeTypes !== undefined && !Array.isArray(edgeTypes)) {
    return null;
  }

  const nodeTypes = payload["nodeTypes"];
  if (nodeTypes !== undefined && !Array.isArray(nodeTypes)) {
    return null;
  }

  const decayFactor = payload["decayFactor"];
  if (
    decayFactor !== undefined &&
    (typeof decayFactor !== "number" || decayFactor < 0 || decayFactor > 1)
  ) {
    return null;
  }

  const includeEvidence = payload["includeEvidence"];
  if (includeEvidence !== undefined && typeof includeEvidence !== "boolean") {
    return null;
  }

  return {
    pullRequestId,
    ...(typeof analysisRunId === "string" ? { analysisRunId } : {}),
    ...(typeof impactAnalysisId === "string" ? { impactAnalysisId } : {}),
    ...(typeof maxDepth === "number" ? { maxDepth } : {}),
    ...(typeof direction === "string" ? { direction } : {}),
    ...(Array.isArray(edgeTypes) ? { edgeTypes: edgeTypes as GraphEdgeType[] } : {}),
    ...(Array.isArray(nodeTypes) ? { nodeTypes: nodeTypes as GraphNodeType[] } : {}),
    ...(typeof decayFactor === "number" ? { decayFactor } : {}),
    ...(typeof includeEvidence === "boolean" ? { includeEvidence } : {}),
  };
}
