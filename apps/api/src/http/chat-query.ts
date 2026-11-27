/**
 * @file chat-query.ts
 * Authenticated HTTP handler for POST /api/v1/chat/query (Phase 9 Step 64).
 *
 * Enforces:
 * - Clerk Bearer JWT authentication and GitHub identity resolution
 * - Organization ID derived strictly from authenticated server context
 * - Strict request body validation (repository_id, analysis_run_id, question, bounded history)
 * - Tenant-scoped repository and analysis-run ownership verification
 * - Durable AIAnalysis pending placeholder + PostgreSQL job enqueue (`chat.query`)
 * - Idempotency via optional `Idempotency-Key` header
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import {
  enqueueJob,
  getAIAnalysisBySubject,
  getAnalysisRunById,
  getPool,
  getRepositoryById,
  getUserById,
  provisionGithubUser,
  saveAIAnalysis,
  UserNotFoundError,
} from "@fluxora/db";
import {
  CHAT_QUERY_JOB_TYPE,
  CHAT_QUERY_PATH,
  chatQueryIdempotencyKey,
  isCanonicalGithubId,
  type ChatHistoryMessageDto,
  type ChatQueryAcceptedResponse,
  type User,
} from "@fluxora/shared-types";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
  type ClerkGithubIdentity,
} from "../auth/clerk.ts";
import { isUuid } from "./impact-analysis-request.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 2_000;
const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_ITEM_CHARS = 1_500;

export function isChatQueryPath(path: string): boolean {
  return path === CHAT_QUERY_PATH;
}

export interface ChatQueryHandlerDependencies {
  authenticateClerkToken?: (authorization: string | undefined) => Promise<string>;
  getClerkGithubIdentity?: (clerkUserId: string) => Promise<ClerkGithubIdentity>;
  provisionGithubUser?: typeof provisionGithubUser;
  getUserById?: typeof getUserById;
  getRepositoryById?: typeof getRepositoryById;
  getAnalysisRunById?: typeof getAnalysisRunById;
  getAIAnalysisBySubject?: typeof getAIAnalysisBySubject;
  saveAIAnalysis?: typeof saveAIAnalysis;
  enqueueJob?: typeof enqueueJob;
  pool?: pg.Pool;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

/**
 * Derives a deterministic UUID from (organizationId, repositoryId, analysisRunId, idempotencyKey)
 * so repeated POSTs with the same Idempotency-Key resolve to the exact same chatQueryId.
 */
function deterministicChatQueryId(
  organizationId: string,
  repositoryId: string,
  analysisRunId: string,
  idempotencyKey: string,
): string {
  const hash = createHash("sha256")
    .update(`chat_query:${organizationId}:${repositoryId}:${analysisRunId}:${idempotencyKey}`)
    .digest("hex");
  // Format first 32 hex chars as UUID v4-shaped identifier
  const bytes = Buffer.from(hash.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function handleChatQuery(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: ChatQueryHandlerDependencies,
): Promise<void> {
  // 1. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();
  const fetchRepo = deps?.getRepositoryById ?? getRepositoryById;
  const fetchRun = deps?.getAnalysisRunById ?? getAnalysisRunById;
  const getSubject = deps?.getAIAnalysisBySubject ?? getAIAnalysisBySubject;
  const saveAnalysis = deps?.saveAIAnalysis ?? saveAIAnalysis;
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

  // 2. Resolve identity and verify GitHub account
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

  // 3. Derive authenticated tenant / organization (never from request body)
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

  // 4. Parse and validate JSON body
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof Error && err.message === "BODY_TOO_LARGE") {
      sendJson(res, 413, {
        error: {
          code: "payload_too_large",
          message: "Request body exceeds maximum allowed size.",
        },
      });
      return;
    }
    sendJson(res, 400, {
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON.",
      },
    });
    return;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Request body must be a JSON object.",
      },
    });
    return;
  }

  const record = body as Record<string, unknown>;
  const repositoryId = record["repository_id"];
  const analysisRunId = record["analysis_run_id"];
  const question = record["question"];
  const historyRaw = record["history"];
  const sessionId = record["session_id"];

  if (typeof repositoryId !== "string" || !isUuid(repositoryId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "repository_id must be a valid UUID.",
      },
    });
    return;
  }

  if (typeof analysisRunId !== "string" || !isUuid(analysisRunId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "analysis_run_id must be a valid UUID.",
      },
    });
    return;
  }

  if (
    typeof question !== "string" ||
    question.trim().length === 0 ||
    question.length > MAX_QUESTION_CHARS
  ) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: `question must be a non-empty string up to ${MAX_QUESTION_CHARS} characters.`,
      },
    });
    return;
  }

  if (
    sessionId !== undefined &&
    (typeof sessionId !== "string" || !isUuid(sessionId))
  ) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "session_id must be a valid UUID when provided.",
      },
    });
    return;
  }

  let history: ChatHistoryMessageDto[] | undefined;
  if (historyRaw !== undefined) {
    if (!Array.isArray(historyRaw) || historyRaw.length > MAX_HISTORY_ITEMS) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: `history must be an array of at most ${MAX_HISTORY_ITEMS} messages.`,
        },
      });
      return;
    }
    history = [];
    for (const item of historyRaw) {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        ((item as Record<string, unknown>)["role"] !== "user" &&
          (item as Record<string, unknown>)["role"] !== "assistant") ||
        typeof (item as Record<string, unknown>)["content"] !== "string" ||
        ((item as Record<string, unknown>)["content"] as string).length >
          MAX_HISTORY_ITEM_CHARS
      ) {
        sendJson(res, 400, {
          error: {
            code: "invalid_request",
            message: `Each history message must have role ('user' | 'assistant') and content (max ${MAX_HISTORY_ITEM_CHARS} chars).`,
          },
        });
        return;
      }
      history.push({
        role: (item as Record<string, unknown>)["role"] as "user" | "assistant",
        content: (item as Record<string, unknown>)["content"] as string,
      });
    }
  }

  // 5. Verify tenant-scoped repository and analysis run ownership
  const [repo, run] = await Promise.all([
    fetchRepo(pool, user.organizationId, repositoryId),
    fetchRun(pool, user.organizationId, analysisRunId),
  ]);

  if (!repo || !run) {
    sendJson(res, 404, {
      error: {
        code: "not_found",
        message: "Repository or analysis run not found.",
      },
    });
    return;
  }

  // 6. Establish stable chatQueryId (idempotent if Idempotency-Key provided)
  const idempotencyHeader = headerValue(req.headers["idempotency-key"]);
  const chatQueryId =
    idempotencyHeader && idempotencyHeader.trim().length > 0
      ? deterministicChatQueryId(
          user.organizationId,
          repositoryId,
          analysisRunId,
          idempotencyHeader.trim(),
        )
      : randomUUID();

  // 7. Create/reuse AIAnalysis record and enqueue durable chat.query job
  try {
    const existing = await getSubject(
      pool,
      user.organizationId,
      "chat_query",
      chatQueryId,
    );

    const analysis =
      existing ??
      (await saveAnalysis(pool, {
        organizationId: user.organizationId,
        subjectType: "chat_query",
        subjectId: chatQueryId,
        status: "pending",
        promptVersion: "chat-query-v1",
        metadata: {
          repositoryId,
          analysisRunId,
          ...(sessionId ? { sessionId } : {}),
        },
      }));

    const job = await enqueue(
      {
        organizationId: user.organizationId,
        type: CHAT_QUERY_JOB_TYPE,
        idempotencyKey: chatQueryIdempotencyKey(chatQueryId),
        payload: {
          chatQueryId,
          repositoryId,
          analysisRunId,
          question: question.trim(),
          ...(history && history.length > 0 ? { history } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      },
      pool,
    );

    const responseBody: ChatQueryAcceptedResponse = {
      chat_query_id: chatQueryId,
      ai_analysis_id: analysis.id,
      status: analysis.status,
      job_id: job.id,
    };

    sendJson(res, 202, responseBody);
  } catch {
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Failed to enqueue architecture chat query.",
      },
    });
  }
}
