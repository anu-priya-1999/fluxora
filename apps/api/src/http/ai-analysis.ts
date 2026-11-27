/**
 * @file ai-analysis.ts
 * Authenticated HTTP handler for retrieving AIAnalysis records (Phase 9 Step 62).
 *
 * Implements GET /api/v1/ai-analyses/:id with strict tenant isolation,
 * verified session authentication, and safe DTO serialization.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import {
  getAIAnalysisById,
  getPool,
  getUserById,
  provisionGithubUser,
  UserNotFoundError,
} from "@fluxora/db";
import {
  isCanonicalGithubId,
  type AIAnalysis,
  type AIAnalysisResponse,
  type User,
} from "@fluxora/shared-types";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
  type ClerkGithubIdentity,
} from "../auth/clerk.ts";
import { isUuid } from "./impact-analysis-request.ts";

export interface AIAnalysisHandlerDependencies {
  authenticateClerkToken?: (authorization: string | undefined) => Promise<string>;
  getClerkGithubIdentity?: (clerkUserId: string) => Promise<ClerkGithubIdentity>;
  provisionGithubUser?: typeof provisionGithubUser;
  getUserById?: typeof getUserById;
  getAIAnalysisById?: typeof getAIAnalysisById;
  pool?: pg.Pool;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function formatAIAnalysisResponse(analysis: AIAnalysis): AIAnalysisResponse {
  const isPassed =
    analysis.status === "completed" && analysis.validationStatus === "passed";

  return {
    id: analysis.id,
    subject_type: analysis.subjectType,
    subject_id: analysis.subjectId,
    status: analysis.status,
    model_used: analysis.modelUsed,
    prompt_version: analysis.promptVersion,
    input_evidence_ids: analysis.inputEvidenceIds,
    output_text: isPassed ? analysis.outputText : null,
    output_structured: isPassed ? analysis.outputStructured : null,
    validation_status: analysis.validationStatus,
    token_count: analysis.tokenCount,
    cost_usd: analysis.costUsd,
    latency_ms: analysis.latencyMs,
    schema_version:
      (analysis.metadata?.schemaVersion as string | undefined) ??
      (isPassed ? "impact-explanation-output-v1" : null),
    error_message: analysis.status === "failed" ? analysis.errorMessage : null,
    ...(analysis.metadata?.toolActivity !== undefined
      ? { metadata: { toolActivity: analysis.metadata.toolActivity } }
      : {}),
    created_at:
      analysis.createdAt instanceof Date
        ? analysis.createdAt.toISOString()
        : String(analysis.createdAt),
    updated_at:
      analysis.updatedAt instanceof Date
        ? analysis.updatedAt.toISOString()
        : String(analysis.updatedAt),
  };
}

export async function handleGetAIAnalysis(
  req: IncomingMessage,
  res: ServerResponse,
  aiAnalysisId: string,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: AIAnalysisHandlerDependencies,
): Promise<void> {
  // 1. Validate aiAnalysisId format
  if (!isUuid(aiAnalysisId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Invalid AI analysis ID format. Must be a valid UUID.",
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
  const getAnalysis = deps?.getAIAnalysisById ?? getAIAnalysisById;

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
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 5. Look up persisted AIAnalysis (tenant-scoped)
  try {
    const analysis = await getAnalysis(pool, user.organizationId, aiAnalysisId);

    if (analysis === null) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "AI analysis not found.",
        },
      });
      return;
    }

    sendJson(res, 200, formatAIAnalysisResponse(analysis));
  } catch {
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}
