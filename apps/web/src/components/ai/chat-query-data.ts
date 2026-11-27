/**
 * @file chat-query-data.ts
 * Frontend API helper for submitting tool-calling architecture chat queries (Phase 9 Step 64).
 */

import {
  CHAT_QUERY_PATH,
  type ChatHistoryMessageDto,
  type ChatQueryAcceptedResponse,
  type ChatQueryRequest,
} from "@fluxora/shared-types";

export type SubmitChatQueryResult =
  | { readonly ok: true; readonly data: ChatQueryAcceptedResponse }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code?: string | undefined;
    };

export interface SubmitChatQueryParams {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly repositoryId: string;
  readonly analysisRunId: string;
  readonly question: string;
  readonly history?: readonly ChatHistoryMessageDto[] | undefined;
  readonly sessionId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export async function submitChatQuery({
  apiUrl,
  getToken,
  repositoryId,
  analysisRunId,
  question,
  history,
  sessionId,
  idempotencyKey,
}: SubmitChatQueryParams): Promise<SubmitChatQueryResult> {
  if (!repositoryId || !analysisRunId || !question.trim()) {
    return {
      ok: false,
      message: "Repository, analysis run, and question are required.",
      code: "invalid_request",
    };
  }

  try {
    const token = await getToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
    const url = `${base}${CHAT_QUERY_PATH}`;

    const payload: ChatQueryRequest = {
      repository_id: repositoryId,
      analysis_run_id: analysisRunId,
      question: question.trim(),
      ...(history && history.length > 0 ? { history } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let code = "http_error";
      let message = `Request failed with status ${res.status}`;
      try {
        const body = (await res.json()) as {
          error?: { code?: string; message?: string };
        };
        if (body.error?.message) {
          message = body.error.message;
        }
        if (body.error?.code) {
          code = body.error.code;
        }
      } catch {
        // Fallback to HTTP status
      }
      return { ok: false, message, code };
    }

    const data = (await res.json()) as ChatQueryAcceptedResponse;
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Network error submitting chat query.",
      code: "network_error",
    };
  }
}
