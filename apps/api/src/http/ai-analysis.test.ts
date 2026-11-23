import assert from "node:assert/strict";
import http from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";

import type {
  AIAnalysis,
  AIAnalysisResponse,
} from "@fluxora/shared-types";

import { createApiServer } from "./server.ts";
import type { AIAnalysisHandlerDependencies } from "./ai-analysis.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AI_A = "77777777-7777-4777-8777-777777777777";
const SUBJECT_A = "88888888-8888-4888-8888-888888888888";

type ErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

type TestResponseBody = AIAnalysisResponse | ErrorResponse | { readonly raw: string };

function makeRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: TestResponseBody }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let body: TestResponseBody;
          try {
            body = JSON.parse(raw);
          } catch {
            body = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/v1/ai-analyses/:id API (Step 62)", () => {
  let server: http.Server;
  let port: number;

  const mockStore = new Map<string, AIAnalysis>();

  const testDeps: AIAnalysisHandlerDependencies = {
    async authenticateClerkToken(auth) {
      if (!auth || !auth.startsWith("Bearer valid_token_")) {
        throw new Error("Invalid token");
      }
      return auth.replace("Bearer ", "");
    },
    async getClerkGithubIdentity(clerkId) {
      if (clerkId === "valid_token_user_a") {
        return {
          ok: true,
          githubUserId: "1001",
          email: "user_a@example.com",
          organizationName: "Org A",
        };
      }
      if (clerkId === "valid_token_user_b") {
        return {
          ok: true,
          githubUserId: "1002",
          email: "user_b@example.com",
          organizationName: "Org B",
        };
      }
      return {
        ok: false,
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      };
    },
    // @ts-expect-error Mock user provisioning
    async provisionGithubUser(_pool, input) {
      if (input.githubUserId === 1001) {
        return { id: USER_A, organizationId: ORG_A };
      }
      return { id: "user_b", organizationId: ORG_B };
    },
    // @ts-expect-error Mock user lookup
    async getUserById(_pool, orgId, userId) {
      return {
        id: userId,
        organizationId: orgId,
        email: "test@example.com",
        role: "member",
        createdAt: new Date(),
      };
    },
    async getAIAnalysisById(_pool, orgId, id) {
      const record = mockStore.get(id);
      if (record && record.organizationId === orgId) {
        return record;
      }
      return null;
    },
    pool: {} as unknown as import("pg").Pool,
  };

  beforeAll(async () => {
    server = createApiServer({
      wsOptions: { autoStartListener: false },
      aiAnalysisDeps: testDeps,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 400 when AI analysis ID is not a valid UUID", async () => {
    const res = await makeRequest(port, "/api/v1/ai-analyses/invalid-uuid", {
      headers: { Authorization: "Bearer valid_token_user_a" },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as ErrorResponse).error.code, "invalid_request");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await makeRequest(port, `/api/v1/ai-analyses/${AI_A}`);
    assert.equal(res.status, 401);
    assert.equal((res.body as ErrorResponse).error.code, "invalid_session");
  });

  it("returns 404 when AI analysis is not found", async () => {
    const nonExistentId = "99999999-9999-4999-8999-999999999999";
    const res = await makeRequest(port, `/api/v1/ai-analyses/${nonExistentId}`, {
      headers: { Authorization: "Bearer valid_token_user_a" },
    });
    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorResponse).error.code, "not_found");
  });

  it("returns 200 with completed AI explanation and structured output", async () => {
    const record: AIAnalysis = {
      id: AI_A,
      organizationId: ORG_A,
      subjectType: "impact_analysis",
      subjectId: SUBJECT_A,
      status: "completed",
      modelUsed: "claude-sonnet-5-5",
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: ["ev_1001"],
      outputText: "Validated summary.",
      outputStructured: {
        summary: "Validated summary.",
        claims: [{ text: "Direct change to payment service.", evidence_ids: ["ev_1001"] }],
        confidence: "high",
        caveats: [],
      },
      validationStatus: "passed",
      tokenCount: 250,
      costUsd: 0.002,
      latencyMs: 800,
      metadata: { schemaVersion: "impact-explanation-output-v1", attempts: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockStore.set(AI_A, record);

    const res = await makeRequest(port, `/api/v1/ai-analyses/${AI_A}`, {
      headers: { Authorization: "Bearer valid_token_user_a" },
    });
    assert.equal(res.status, 200);
    const body = res.body as AIAnalysisResponse;
    assert.equal(body.id, AI_A);
    assert.equal(body.status, "completed");
    assert.equal(body.validation_status, "passed");
    assert.equal(body.output_text, "Validated summary.");
    assert.ok(body.output_structured);
    assert.equal(body.output_structured!.summary, "Validated summary.");
    assert.equal(body.token_count, 250);
    assert.equal(body.schema_version, "impact-explanation-output-v1");
  });

  it("returns 200 with pending AI analysis without structured output", async () => {
    const pendingId = "66666666-6666-4666-8666-666666666666";
    const record: AIAnalysis = {
      id: pendingId,
      organizationId: ORG_A,
      subjectType: "impact_analysis",
      subjectId: SUBJECT_A,
      status: "pending",
      modelUsed: null,
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: [],
      outputText: null,
      outputStructured: null,
      validationStatus: null,
      tokenCount: 0,
      costUsd: 0,
      latencyMs: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockStore.set(pendingId, record);

    const res = await makeRequest(port, `/api/v1/ai-analyses/${pendingId}`, {
      headers: { Authorization: "Bearer valid_token_user_a" },
    });
    assert.equal(res.status, 200);
    const body = res.body as AIAnalysisResponse;
    assert.equal(body.id, pendingId);
    assert.equal(body.status, "pending");
    assert.equal(body.output_text, null);
    assert.equal(body.output_structured, null);
  });

  it("returns 200 with rejected AI analysis without raw text or structured output", async () => {
    const rejectedId = "55555555-5555-4555-8555-555555555555";
    const record: AIAnalysis = {
      id: rejectedId,
      organizationId: ORG_A,
      subjectType: "impact_analysis",
      subjectId: SUBJECT_A,
      status: "rejected",
      modelUsed: "claude-sonnet-5-5",
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: ["ev_1001"],
      outputText: null,
      outputStructured: null,
      validationStatus: "rejected",
      tokenCount: 200,
      costUsd: 0.0015,
      latencyMs: 500,
      metadata: { schemaVersion: "impact-explanation-output-v1", attempts: 2 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockStore.set(rejectedId, record);

    const res = await makeRequest(port, `/api/v1/ai-analyses/${rejectedId}`, {
      headers: { Authorization: "Bearer valid_token_user_a" },
    });
    assert.equal(res.status, 200);
    const body = res.body as AIAnalysisResponse;
    assert.equal(body.id, rejectedId);
    assert.equal(body.status, "rejected");
    assert.equal(body.validation_status, "rejected");
    assert.equal(body.output_text, null);
    assert.equal(body.output_structured, null);
  });

  it("returns 200 with failed AI analysis and sanitized error message without structured output", async () => {
    const failedId = "44444444-4444-4444-8444-444444444444";
    const record: AIAnalysis = {
      id: failedId,
      organizationId: ORG_A,
      subjectType: "impact_analysis",
      subjectId: SUBJECT_A,
      status: "failed",
      modelUsed: "claude-sonnet-5-5",
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: ["ev_1001"],
      outputText: null,
      outputStructured: null,
      validationStatus: null,
      tokenCount: 0,
      costUsd: 0,
      latencyMs: 150,
      errorMessage: "Model provider gateway request timed out after 20000ms.",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockStore.set(failedId, record);

    const res = await makeRequest(port, `/api/v1/ai-analyses/${failedId}`, {
      headers: { Authorization: "Bearer valid_token_user_a" },
    });
    assert.equal(res.status, 200);
    const body = res.body as AIAnalysisResponse;
    assert.equal(body.id, failedId);
    assert.equal(body.status, "failed");
    assert.equal(body.output_text, null);
    assert.equal(body.output_structured, null);
    assert.equal(body.error_message, "Model provider gateway request timed out after 20000ms.");
  });

  it("enforces tenant isolation: user from Org B cannot read Org A's record", async () => {
    const res = await makeRequest(port, `/api/v1/ai-analyses/${AI_A}`, {
      headers: { Authorization: "Bearer valid_token_user_b" },
    });
    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorResponse).error.code, "not_found");
  });
});
