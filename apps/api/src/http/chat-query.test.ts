import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { handleChatQuery } from "./chat-query.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "12121212-1212-4121-8121-121212121212";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const AI_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";

function makeReq(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  stream.headers = {
    authorization: "Bearer test-token",
    ...headers,
  };
  return stream;
}

function captureRes() {
  let statusCode = 0;
  let body: unknown = null;
  const sendJson = (_res: ServerResponse, status: number, payload: unknown) => {
    statusCode = status;
    body = payload;
  };
  return {
    res: {} as ServerResponse,
    sendJson,
    getStatus: () => statusCode,
    getBody: () => body as Record<string, unknown>,
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    pool: {} as pg.Pool,
    authenticateClerkToken: vi.fn().mockResolvedValue("clerk_user_1"),
    getClerkGithubIdentity: vi.fn().mockResolvedValue({
      ok: true,
      githubUserId: "12345",
      email: "dev@fluxora.dev",
      organizationName: "Fluxora",
    }),
    provisionGithubUser: vi.fn().mockResolvedValue({
      id: USER_ID,
      organizationId: ORG_ID,
    }),
    getUserById: vi.fn().mockResolvedValue({
      id: USER_ID,
      organizationId: ORG_ID,
      email: "dev@fluxora.dev",
      role: "member",
      createdAt: new Date(),
    }),
    getRepositoryById: vi.fn().mockResolvedValue({ id: REPO_ID }),
    getAnalysisRunById: vi.fn().mockResolvedValue({ id: RUN_ID }),
    getAIAnalysisBySubject: vi.fn().mockResolvedValue(null),
    saveAIAnalysis: vi.fn().mockResolvedValue({
      id: AI_ID,
      status: "pending",
    }),
    enqueueJob: vi.fn().mockResolvedValue({ id: JOB_ID }),
    ...overrides,
  };
}

describe("POST /api/v1/chat/query handler", () => {
  it("returns 401 when unauthenticated", async () => {
    const cap = captureRes();
    const deps = baseDeps({
      authenticateClerkToken: vi.fn().mockRejectedValue(new Error("invalid token")),
    });

    await handleChatQuery(
      makeReq({ repository_id: REPO_ID, analysis_run_id: RUN_ID, question: "Hi" }),
      cap.res,
      cap.sendJson,
      deps,
    );
    expect(cap.getStatus()).toBe(401);
  });

  it("returns 404 on cross-tenant or missing repository/analysis run", async () => {
    const cap = captureRes();
    const deps = baseDeps({
      getRepositoryById: vi.fn().mockResolvedValue(null),
    });

    await handleChatQuery(
      makeReq({
        repository_id: REPO_ID,
        analysis_run_id: RUN_ID,
        question: "What breaks if Redis goes down?",
      }),
      cap.res,
      cap.sendJson,
      deps,
    );
    expect(cap.getStatus()).toBe(404);
  });

  it("accepts valid chat query, derives org from session, and enqueues chat.query job", async () => {
    const cap = captureRes();
    const deps = baseDeps();

    await handleChatQuery(
      makeReq(
        {
          repository_id: REPO_ID,
          analysis_run_id: RUN_ID,
          question: "What calls PaymentService?",
          organization_id: "99999999-9999-4999-8999-999999999999", // Must be ignored
        },
        { "idempotency-key": "idem-123" },
      ),
      cap.res,
      cap.sendJson,
      deps,
    );

    expect(cap.getStatus()).toBe(202);
    const body = cap.getBody();
    expect(body["ai_analysis_id"]).toBe(AI_ID);
    expect(body["job_id"]).toBe(JOB_ID);
    expect(body["status"]).toBe("pending");
    expect(typeof body["chat_query_id"]).toBe("string");

    // Verify organizationId came from authenticated user, not request body
    expect(deps.saveAIAnalysis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        subjectType: "chat_query",
      }),
    );

    // Deterministic idempotency key produces identical chat_query_id
    const cap2 = captureRes();
    await handleChatQuery(
      makeReq(
        {
          repository_id: REPO_ID,
          analysis_run_id: RUN_ID,
          question: "What calls PaymentService?",
        },
        { "idempotency-key": "idem-123" },
      ),
      cap2.res,
      cap2.sendJson,
      deps,
    );
    expect(cap2.getBody()["chat_query_id"]).toBe(body["chat_query_id"]);
  });

  it("rejects invalid question or malformed history with 400", async () => {
    const cap = captureRes();
    const deps = baseDeps();

    await handleChatQuery(
      makeReq({
        repository_id: REPO_ID,
        analysis_run_id: RUN_ID,
        question: "   ",
      }),
      cap.res,
      cap.sendJson,
      deps,
    );
    expect(cap.getStatus()).toBe(400);
  });
});
