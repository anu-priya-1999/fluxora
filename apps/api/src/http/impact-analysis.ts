import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import {
  AnalysisSnapshotUnavailableError,
  enqueueJob,
  EvidenceWriter,
  getImpactAnalysisById,
  getPool,
  getUserById,
  provisionGithubUser,
  PullRequestNotFoundError,
  resolveAnalysisRunForPullRequest,
  UserNotFoundError,
} from "@fluxora/db";
import {
  isCanonicalGithubId,
  PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
  pullRequestImpactAnalysisIdempotencyKey,
  type EnqueueJobInput,
  type Job,
  type PullRequestAnalyzeImpactQueuedResponse,
  type User,
} from "@fluxora/shared-types";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
  type ClerkGithubIdentity,
} from "../auth/clerk.ts";
import { redactForLog } from "../github/redact.ts";
import {
  ImpactRequestValidationError,
  isUuid,
  parseAnalyzeImpactBody,
  type ParsedAnalyzeImpactInput,
} from "./impact-analysis-request.ts";
import { formatImpactAnalysisResponse } from "./impact-analysis-response.ts";

const MAX_BODY_BYTES = 16384; // 16KB

export interface ImpactAnalysisHandlerDependencies {
  authenticateClerkToken?: (authorization: string | undefined) => Promise<string>;
  getClerkGithubIdentity?: (clerkUserId: string) => Promise<ClerkGithubIdentity>;
  provisionGithubUser?: typeof provisionGithubUser;
  getUserById?: typeof getUserById;
  resolveAnalysisRun?: typeof resolveAnalysisRunForPullRequest;
  enqueueJob?: (input: EnqueueJobInput) => Promise<Job>;
  getImpactAnalysisById?: typeof getImpactAnalysisById;
  pool?: pg.Pool;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "PayloadTooLargeError";
  }
}

export async function handleAnalyzePullRequestImpact(
  req: IncomingMessage,
  res: ServerResponse,
  pullRequestId: string,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: ImpactAnalysisHandlerDependencies,
): Promise<void> {
  // 1. Content-Type check (if body is present)
  const contentType = headerValue(req.headers["content-type"]);
  const hasContentType = contentType !== undefined && contentType.trim().length > 0;
  if (
    hasContentType &&
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    sendJson(res, 415, {
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
    });
    return;
  }

  // 2. Validate pullRequestId format
  if (!isUuid(pullRequestId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Invalid pull request ID format. Must be a valid UUID.",
      },
    });
    return;
  }

  // 3. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();
  const resolveRun = deps?.resolveAnalysisRun ?? resolveAnalysisRunForPullRequest;
  const enqueue = deps?.enqueueJob ?? enqueueJob;

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 4. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 5. Read and parse JSON request body (if provided)
  let parsedInput: ParsedAnalyzeImpactInput = {};
  try {
    const rawBody = await readOptionalJsonBody(req);
    parsedInput = parseAnalyzeImpactBody(rawBody);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, {
        error: {
          code: "payload_too_large",
          message: "Request body is too large.",
        },
      });
      return;
    }

    if (error instanceof ImpactRequestValidationError) {
      sendJson(res, error.statusCode, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    sendJson(res, 400, {
      error: {
        code: "invalid_json",
        message:
          error instanceof Error ? error.message : "Request body must be JSON.",
      },
    });
    return;
  }

  // 6. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      sendJson(res, 403, {
        error: {
          code: "tenant_session_rejected",
          message: "The account could not be loaded for this organization.",
        },
      });
      return;
    }
    logUnexpectedImpactError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 7. Tenant-scoped PR and AnalysisRun resolution
  let resolved: { pullRequest: { id: string; repositoryId: string }; analysisRunId: string };
  try {
    resolved = await resolveRun(
      pool,
      user.organizationId,
      pullRequestId,
      parsedInput.analysisRunId,
    );
  } catch (error) {
    if (error instanceof PullRequestNotFoundError) {
      sendJson(res, 404, {
        error: {
          code: "pull_request_not_found",
          message: "Pull request not found or inaccessible.",
        },
      });
      return;
    }

    if (error instanceof AnalysisSnapshotUnavailableError) {
      sendJson(res, 404, {
        error: {
          code: "analysis_snapshot_unavailable",
          message: error.message,
        },
      });
      return;
    }

    logUnexpectedImpactError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 8. Idempotency handling
  const rawIdempotencyKey = headerValue(req.headers["idempotency-key"]);
  const clientKey =
    rawIdempotencyKey && rawIdempotencyKey.trim().length > 0
      ? rawIdempotencyKey.trim()
      : crypto.randomUUID();

  const jobIdempotencyKey = pullRequestImpactAnalysisIdempotencyKey(
    pullRequestId,
    resolved.analysisRunId,
    clientKey,
  );

  const impactAnalysisId = EvidenceWriter.generateDeterministicUuid(
    `${user.organizationId}:${jobIdempotencyKey}`,
  );

  // 9. Enqueue background analysis job
  try {
    const job = await enqueue({
      organizationId: user.organizationId,
      type: PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
      idempotencyKey: jobIdempotencyKey,
      payload: {
        pullRequestId,
        analysisRunId: resolved.analysisRunId,
        impactAnalysisId,
        ...(parsedInput.maxDepth !== undefined
          ? { maxDepth: parsedInput.maxDepth }
          : {}),
        ...(parsedInput.internalDirection
          ? { direction: parsedInput.internalDirection }
          : {}),
        ...(parsedInput.edgeTypes ? { edgeTypes: parsedInput.edgeTypes } : {}),
        ...(parsedInput.nodeTypes ? { nodeTypes: parsedInput.nodeTypes } : {}),
        ...(parsedInput.decayFactor !== undefined
          ? { decayFactor: parsedInput.decayFactor }
          : {}),
        ...(parsedInput.includeEvidence !== undefined
          ? { includeEvidence: parsedInput.includeEvidence }
          : {}),
      },
    });

    const responseBody: PullRequestAnalyzeImpactQueuedResponse = {
      status: "queued",
      job_id: job.id,
      pull_request_id: pullRequestId,
      idempotency_key: clientKey,
    };

    sendJson(res, 202, responseBody);
  } catch (error) {
    logUnexpectedImpactError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

export async function handleGetImpactAnalysis(
  req: IncomingMessage,
  res: ServerResponse,
  impactAnalysisId: string,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: ImpactAnalysisHandlerDependencies,
): Promise<void> {
  // 1. Validate impactAnalysisId format
  if (!isUuid(impactAnalysisId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Invalid impact analysis ID format. Must be a valid UUID.",
      },
    });
    return;
  }

  // 2. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();
  const getAnalysis = deps?.getImpactAnalysisById ?? getImpactAnalysisById;

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 3. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 4. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      sendJson(res, 403, {
        error: {
          code: "tenant_session_rejected",
          message: "The account could not be loaded for this organization.",
        },
      });
      return;
    }
    logUnexpectedImpactError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 5. Look up persisted ImpactAnalysis (tenant-scoped)
  try {
    const analysis = await getAnalysis(pool, user.organizationId, impactAnalysisId);

    if (analysis === null) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Impact analysis not found.",
        },
      });
      return;
    }

    sendJson(res, 200, formatImpactAnalysisResponse(analysis));
  } catch (error) {
    logUnexpectedImpactError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ImpactRequestValidationError(
      "Request body must be valid JSON.",
      "invalid_json",
      400,
    );
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function logUnexpectedImpactError(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("impact analysis api error");
    return;
  }

  const message = redactForLog(error.message);
  console.error(message.length === 0 ? error.name : message);
}
