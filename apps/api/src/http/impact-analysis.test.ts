import assert from "node:assert/strict";
import http from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  AnalysisSnapshotUnavailableError,
  PullRequestNotFoundError,
} from "@fluxora/db";
import {
  PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
  type EnqueueJobInput,
  type ImpactAnalysis,
  type ImpactAnalysisResponse,
  type ImpactFinding,
  type Job,
  type PullRequestAnalyzeImpactQueuedResponse,
  type User,
} from "@fluxora/shared-types";

import { createApiServer } from "./server.ts";
import type { ImpactAnalysisHandlerDependencies } from "./impact-analysis.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PR_A = "33333333-3333-4333-8333-333333333333";
const PR_B = "44444444-4444-4444-8444-444444444444";
const RUN_A = "55555555-5555-4555-8555-555555555555";
const RUN_A2 = "55555555-5555-4555-8555-999999999999";
const REPO_A = "66666666-6666-4666-8666-666666666666";

const ANALYSIS_A = "77777777-7777-4777-8777-777777777777";
const ANALYSIS_B = "88888888-8888-4888-8888-888888888888";

type ErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

type TestResponseBody =
  | PullRequestAnalyzeImpactQueuedResponse
  | ImpactAnalysisResponse
  | ErrorResponse
  | { readonly raw: string };

function expectError(body: TestResponseBody): ErrorResponse {
  if (!("error" in body)) {
    throw new Error(`Expected an error response, got ${JSON.stringify(body)}`);
  }
  return body as ErrorResponse;
}

function expectQueuedSuccess(
  body: TestResponseBody,
): PullRequestAnalyzeImpactQueuedResponse {
  if (!("job_id" in body) || body.status !== "queued") {
    throw new Error(`Expected 202 queued response, got ${JSON.stringify(body)}`);
  }
  return body as PullRequestAnalyzeImpactQueuedResponse;
}

function expectAnalysisSuccess(body: TestResponseBody): ImpactAnalysisResponse {
  if (!("pull_request_id" in body) || !("direct_impact" in body)) {
    throw new Error(`Expected ImpactAnalysisResponse, got ${JSON.stringify(body)}`);
  }
  return body as ImpactAnalysisResponse;
}

function createMockFinding(depth: number, nodeId: string, name: string): ImpactFinding {
  return {
    node: {
      id: nodeId,
      analysisRunId: RUN_A,
      canonicalId: `sym:${name}`,
      nodeType: depth === 1 ? "module" : "service",
      name,
      path: `src/${name}.ts`,
      metadata: {},
      confidence: Math.pow(0.9, depth),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    depth,
    confidence: Math.pow(0.9, depth),
    path: depth === 1 ? [nodeId] : ["start-node", nodeId],
    evidenceIds: [`ev-${nodeId}`],
  };
}

function createMockAnalysis(
  id: string,
  pullRequestId: string,
  analysisRunId: string,
  status: ImpactAnalysis["status"] = "completed",
): ImpactAnalysis {
  const direct1 = createMockFinding(1, "node-d1", "DirectService");
  const down1 = createMockFinding(2, "node-w1", "DownstreamService");

  return {
    id,
    pullRequestId,
    analysisRunId,
    status,
    directImpact: [direct1],
    downstreamImpact: [down1],
    affectedApis: [direct1],
    affectedEvents: [down1],
    affectedServices: [down1],
    workflowImpactSummary: ["Checkout Flow", "Payment Flow"],
    unresolvedFiles: [
      {
        path: "README.md",
        reason: "Non-code file not indexed in symbol table",
      },
    ],
    truncated: false,
    truncationReason: null,
    maxDepthReached: 2,
    executionMetrics: {
      totalSeedNodes: 1,
      totalAffectedNodes: 2,
      totalEdgesTraversed: 3,
      durationMs: 45,
    },
    metadata: { testNote: "persisted" },
    createdAt: new Date("2026-02-01T12:00:00Z"),
  };
}

function setupTestEnvironment() {
  const enqueuedJobs: EnqueueJobInput[] = [];
  const storedJobs = new Map<string, Job>();
  let getAnalysisCallsCount = 0;

  const userA: User = {
    id: USER_A,
    organizationId: ORG_A,
    role: "owner",
    githubUserId: 1001,
    email: "userA@example.com",
    createdAt: new Date(),
  };

  const userB: User = {
    id: USER_B,
    organizationId: ORG_B,
    role: "owner",
    githubUserId: 1002,
    email: "userB@example.com",
    createdAt: new Date(),
  };

  const analysesStore = new Map<string, ImpactAnalysis>([
    [`${ORG_A}:${ANALYSIS_A}`, createMockAnalysis(ANALYSIS_A, PR_A, RUN_A, "completed")],
    [`${ORG_B}:${ANALYSIS_B}`, createMockAnalysis(ANALYSIS_B, PR_B, RUN_A, "completed")],
  ]);

  const deps: ImpactAnalysisHandlerDependencies = {
    async authenticateClerkToken(authHeader: string | undefined): Promise<string> {
      if (!authHeader?.startsWith("Bearer ")) {
        throw new Error("Missing bearer token.");
      }
      const token = authHeader.slice("Bearer ".length).trim();
      if (token === "token-org-a") return "clerk-user-a";
      if (token === "token-org-b") return "clerk-user-b";
      if (token === "token-no-github") return "clerk-user-no-github";
      throw new Error("Invalid token.");
    },

    async getClerkGithubIdentity(clerkUserId: string) {
      if (clerkUserId === "clerk-user-a") {
        return {
          ok: true as const,
          githubUserId: "1001",
          email: "userA@example.com",
          organizationName: "Org A",
        };
      }
      if (clerkUserId === "clerk-user-b") {
        return {
          ok: true as const,
          githubUserId: "1002",
          email: "userB@example.com",
          organizationName: "Org B",
        };
      }
      return {
        ok: false as const,
        code: "github_account_required" as const,
        message: "No github account.",
      };
    },

    async provisionGithubUser(_pool, input) {
      if (input.githubUserId === 1001) {
        return userA;
      }
      return userB;
    },

    async getUserById(_pool, orgId, userId) {
      if (orgId === ORG_A && userId === USER_A) return userA;
      if (orgId === ORG_B && userId === USER_B) return userB;
      throw new Error("User not found");
    },

    async resolveAnalysisRun(_pool, organizationId, pullRequestId, requestedAnalysisRunId) {
      // PR_A belongs to ORG_A. PR_B belongs to ORG_B.
      if (organizationId === ORG_A && pullRequestId === PR_A) {
        if (requestedAnalysisRunId === "00000000-0000-4000-8000-000000000000") {
          throw new AnalysisSnapshotUnavailableError(
            `Analysis run ${requestedAnalysisRunId} does not exist or does not belong to repository ${REPO_A}.`,
          );
        }
        return {
          pullRequest: {
            id: PR_A,
            organizationId: ORG_A,
            repositoryId: REPO_A,
            number: 42,
          },
          analysisRunId: requestedAnalysisRunId ?? RUN_A,
        };
      }

      if (organizationId === ORG_B && pullRequestId === PR_B) {
        return {
          pullRequest: {
            id: PR_B,
            organizationId: ORG_B,
            repositoryId: "repo-b",
            number: 99,
          },
          analysisRunId: requestedAnalysisRunId ?? RUN_A,
        };
      }

      throw new PullRequestNotFoundError(
        `Pull request ${pullRequestId} not found or inaccessible for organization ${organizationId}.`,
      );
    },

    async enqueueJob(input: EnqueueJobInput): Promise<Job> {
      enqueuedJobs.push(input);
      const storeKey = `${input.organizationId}:${input.idempotencyKey}`;
      const existing = storedJobs.get(storeKey);
      if (existing) {
        return existing;
      }

      const job: Job = {
        id: `job-${storedJobs.size + 1}`,
        organizationId: input.organizationId,
        type: input.type,
        payload: input.payload ?? {},
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        attemptCount: 0,
        maxAttempts: input.maxAttempts ?? 3,
        availableAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        failedAt: null,
      };
      storedJobs.set(storeKey, job);
      return job;
    },

    async getImpactAnalysisById(_pool, organizationId, impactAnalysisId) {
      getAnalysisCallsCount += 1;
      const key = `${organizationId}:${impactAnalysisId}`;
      return analysesStore.get(key) ?? null;
    },

    async listImpactFindingEvidence(_pool, organizationId, impactAnalysisId) {
      if (organizationId === ORG_A && impactAnalysisId === ANALYSIS_A) {
        return [
          {
            id: "ev-node-d1",
            analysisRunId: RUN_A,
            subjectType: "graph_node",
            subjectId: "node-d1",
            filePath: "src/DirectService.ts",
            symbolId: "sym:DirectService",
            lineStart: 10,
            lineEnd: 25,
            columnStart: 1,
            columnEnd: 40,
            relationshipDescription: "Direct service definition",
            confidence: 0.9,
            metadata: {},
            createdAt: new Date(),
          },
        ];
      }
      return [];
    },

    pool: {} as unknown as import("pg").Pool,
  };

  return {
    deps,
    enqueuedJobs,
    storedJobs,
    analysesStore,
    getCallCount: () => getAnalysisCallsCount,
  };
}

async function request(
  server: http.Server,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: TestResponseBody;
}> {
  const address = server.address() as { port: number };
  const port = address.port;

  return new Promise((resolve, reject) => {
    const serializedBody =
      options.body !== undefined ? JSON.stringify(options.body) : undefined;

    const req = http.request(
      `http://127.0.0.1:${port}${options.path}`,
      {
        method: options.method,
        headers: {
          ...(serializedBody !== undefined
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(serializedBody).toString(),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: TestResponseBody;
          try {
            body = raw.length > 0 ? (JSON.parse(raw) as TestResponseBody) : ({ raw } as TestResponseBody);
          } catch {
            body = { raw };
          }
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body,
          });
        });
      },
    );

    req.on("error", reject);
    if (serializedBody !== undefined) {
      req.write(serializedBody);
    }
    req.end();
  });
}

describe("Global Step 45: PR Impact Analysis API", () => {
  let server: http.Server;
  let env: ReturnType<typeof setupTestEnvironment>;

  beforeAll(async () => {
    env = setupTestEnvironment();
    server = createApiServer({
      wsOptions: { autoStartListener: false },
      impactAnalysisDeps: env.deps,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("POST /api/v1/pull-requests/:id/analyze-impact", () => {
    it("A. POST route recognition: recognizes valid path and rejects invalid method with 405", async () => {
      // OPTIONS returns CORS
      const optRes = await request(server, {
        method: "OPTIONS",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: { origin: "http://localhost:3000" },
      });
      assert.equal(optRes.statusCode, 204);

      // GET returns 405 Method Not Allowed
      const getRes = await request(server, {
        method: "GET",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
      });
      assert.equal(getRes.statusCode, 405);
      const err = expectError(getRes.body);
      assert.equal(err.error.code, "method_not_allowed");
    });

    it("B. POST request parsing: parses options and forwards to job payload", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "key-options-test",
        },
        body: {
          max_depth: 4,
          direction: "downstream",
          edge_types: ["CALLS"],
          node_types: ["module"],
          decay_factor: 0.8,
          include_evidence: true,
        },
      });

      assert.equal(res.statusCode, 202);
      const enqueued = env.enqueuedJobs[env.enqueuedJobs.length - 1];
      assert.ok(enqueued);
      assert.equal(enqueued.payload?.maxDepth, 4);
      assert.equal(enqueued.payload?.direction, "outgoing");
      assert.deepEqual(enqueued.payload?.edgeTypes, ["CALLS"]);
      assert.deepEqual(enqueued.payload?.nodeTypes, ["module"]);
      assert.equal(enqueued.payload?.decayFactor, 0.8);
      assert.equal(enqueued.payload?.includeEvidence, true);
    });

    it("B. rejects client-supplied organization_id in body with 400", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
        },
        body: {
          organization_id: "forged-org-id",
        },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_request");
    });

    it("C. malformed PR UUID rejection: returns 400 invalid_request", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/not-a-valid-uuid/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
        },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_request");
      assert.match(err.error.message, /valid UUID/i);
    });

    it("D. authentication rejection: rejects missing/invalid token or missing GitHub account", async () => {
      // Missing token
      const noAuth = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
      });
      assert.equal(noAuth.statusCode, 401);
      assert.equal(expectError(noAuth.body).error.code, "invalid_session");

      // Invalid token
      const badAuth = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: { authorization: "Bearer wrong-token" },
      });
      assert.equal(badAuth.statusCode, 401);

      // Missing GitHub account
      const noGithub = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: { authorization: "Bearer token-no-github" },
      });
      assert.equal(noGithub.statusCode, 403);
      assert.equal(expectError(noGithub.body).error.code, "github_account_required");
    });

    it("E. tenant scoping: derives organization from server session, never trusting client", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "tenant-scope-key-1",
        },
      });

      assert.equal(res.statusCode, 202);
      const enqueued = env.enqueuedJobs[env.enqueuedJobs.length - 1];
      assert.equal(enqueued?.organizationId, ORG_A);
    });

    it("F. PR not found / inaccessible behavior: returns 404 pull_request_not_found for cross-tenant PR", async () => {
      // Tenant A attempts to access Tenant B's PR_B
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_B}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
        },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "pull_request_not_found");
    });

    it("G. analysis-run validation: rejects unavailable or foreign analysis run with 404", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
        },
        body: {
          analysis_run_id: "00000000-0000-4000-8000-000000000000",
        },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "analysis_snapshot_unavailable");
    });

    it("H. successful 202 response: returns queued status and identifiers", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "test-key-202",
        },
      });

      assert.equal(res.statusCode, 202);
      const body = expectQueuedSuccess(res.body);
      assert.equal(body.status, "queued");
      assert.ok(body.job_id);
      assert.equal(body.pull_request_id, PR_A);
      assert.equal(body.idempotency_key, "test-key-202");
    });

    it("I & J. correct job payload and tenant identity in queued job", async () => {
      await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "payload-check-key",
        },
      });

      const enqueued = env.enqueuedJobs[env.enqueuedJobs.length - 1];
      assert.ok(enqueued);
      assert.equal(enqueued.type, PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE);
      assert.equal(enqueued.organizationId, ORG_A);
      assert.equal(enqueued.payload?.pullRequestId, PR_A);
      assert.equal(enqueued.payload?.analysisRunId, RUN_A);
      assert.ok(enqueued.payload?.impactAnalysisId);
    });

    it("K & L. Idempotency-Key handling & duplicate trigger behavior", async () => {
      const initialCount = env.storedJobs.size;

      // First request with key K
      const res1 = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "idem-key-k",
        },
      });
      assert.equal(res1.statusCode, 202);
      const body1 = expectQueuedSuccess(res1.body);

      // Repeat identical request with same key K
      const res2 = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "idem-key-k",
        },
      });
      assert.equal(res2.statusCode, 202);
      const body2 = expectQueuedSuccess(res2.body);

      // Same job returned, no duplicate created
      assert.equal(body1.job_id, body2.job_id);
      assert.equal(env.storedJobs.size, initialCount + 1);

      // Different key K2 creates new job
      const res3 = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "idem-key-k2",
        },
      });
      assert.equal(res3.statusCode, 202);
      const body3 = expectQueuedSuccess(res3.body);
      assert.notEqual(body1.job_id, body3.job_id);

      // Same PR with different AnalysisRun remains independent
      const res4 = await request(server, {
        method: "POST",
        path: `/api/v1/pull-requests/${PR_A}/analyze-impact`,
        headers: {
          authorization: "Bearer token-org-a",
          "idempotency-key": "idem-key-k",
        },
        body: {
          analysis_run_id: RUN_A2,
        },
      });
      assert.equal(res4.statusCode, 202);
      const body4 = expectQueuedSuccess(res4.body);
      assert.notEqual(body1.job_id, body4.job_id);
    });
  });

  describe("GET /api/v1/impact-analyses/:id", () => {
    it("M. GET route recognition: recognizes valid path and rejects invalid method with 405", async () => {
      // OPTIONS returns 204
      const optRes = await request(server, {
        method: "OPTIONS",
        path: `/api/v1/impact-analyses/${ANALYSIS_A}`,
        headers: { origin: "http://localhost:3000" },
      });
      assert.equal(optRes.statusCode, 204);

      // POST returns 405 Method Not Allowed
      const postRes = await request(server, {
        method: "POST",
        path: `/api/v1/impact-analyses/${ANALYSIS_A}`,
      });
      assert.equal(postRes.statusCode, 405);
      const err = expectError(postRes.body);
      assert.equal(err.error.code, "method_not_allowed");
    });

    it("N. GET authentication: rejects missing or invalid token", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${ANALYSIS_A}`,
      });
      assert.equal(res.statusCode, 401);
      assert.equal(expectError(res.body).error.code, "invalid_session");
    });

    it("O & R & S. GET successful persisted result: formats response preserving impact findings, taxonomy, and evidence IDs", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${ANALYSIS_A}`,
        headers: {
          authorization: "Bearer token-org-a",
        },
      });

      assert.equal(res.statusCode, 200);
      const body = expectAnalysisSuccess(res.body);

      // Top-level fields
      assert.equal(body.id, ANALYSIS_A);
      assert.equal(body.pull_request_id, PR_A);
      assert.equal(body.analysis_run_id, RUN_A);
      assert.equal(body.status, "completed");
      assert.equal(body.truncated, false);
      assert.equal(body.truncation_reason, null);
      assert.equal(body.max_depth_reached, 2);

      // Execution metrics
      assert.equal(body.execution_metrics.total_seed_nodes, 1);
      assert.equal(body.execution_metrics.total_affected_nodes, 2);
      assert.equal(body.execution_metrics.total_edges_traversed, 3);
      assert.equal(body.execution_metrics.duration_ms, 45);

      // Direct impact findings
      assert.equal(body.direct_impact.length, 1);
      const direct = body.direct_impact[0]!;
      assert.equal(direct.node_id, "node-d1");
      assert.equal(direct.name, "DirectService");
      assert.equal(direct.type, "module");
      assert.equal(direct.depth, 1);
      assert.equal(direct.hop_distance, 1);
      assert.equal(direct.confidence, 0.9);
      assert.deepEqual(direct.evidence_ids, ["ev-node-d1"]);
      assert.equal(direct.evidence_id, "ev-node-d1");

      // Downstream impact findings
      assert.equal(body.downstream_impact.length, 1);
      const down = body.downstream_impact[0]!;
      assert.equal(down.node_id, "node-w1");
      assert.equal(down.depth, 2);
      assert.equal(down.hop_distance, 2);
      assert.deepEqual(down.evidence_ids, ["ev-node-w1"]);
      assert.equal(down.evidence_id, "ev-node-w1");

      // Affected taxonomy
      assert.equal(body.affected_apis.length, 1);
      assert.equal(body.affected_events.length, 1);
      assert.equal(body.affected_services.length, 1);

      // Summary & unresolved
      assert.deepEqual(body.workflow_impact_summary, ["Checkout Flow", "Payment Flow"]);
      assert.deepEqual(body.unresolved_files, [
        {
          path: "README.md",
          reason: "Non-code file not indexed in symbol table",
        },
      ]);
    });

    it("P. GET not found behavior: returns 404 for nonexistent UUID and 400 for malformed UUID", async () => {
      // Malformed UUID
      const malformed = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/not-a-uuid`,
        headers: {
          authorization: "Bearer token-org-a",
        },
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(expectError(malformed.body).error.code, "invalid_request");

      // Nonexistent valid UUID
      const notFound = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/00000000-0000-4000-8000-000000000000`,
        headers: {
          authorization: "Bearer token-org-a",
        },
      });
      assert.equal(notFound.statusCode, 404);
      assert.equal(expectError(notFound.body).error.code, "not_found");
    });

    it("Q. cross-tenant GET isolation: tenant A cannot access tenant B impact analysis (returns 404)", async () => {
      // Tenant A attempts to read Tenant B's ANALYSIS_B
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${ANALYSIS_B}`,
        headers: {
          authorization: "Bearer token-org-a",
        },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "not_found");
    });

    it("T. status mapping: exposes pending, running, failed, and completed states correctly", async () => {
      const pendingAnalysis = createMockAnalysis(
        "99999999-9999-4999-8999-999999999991",
        PR_A,
        RUN_A,
        "pending",
      );
      const runningAnalysis = createMockAnalysis(
        "99999999-9999-4999-8999-999999999992",
        PR_A,
        RUN_A,
        "running",
      );
      const failedAnalysis = createMockAnalysis(
        "99999999-9999-4999-8999-999999999993",
        PR_A,
        RUN_A,
        "failed",
      );

      env.analysesStore.set(`${ORG_A}:${pendingAnalysis.id}`, pendingAnalysis);
      env.analysesStore.set(`${ORG_A}:${runningAnalysis.id}`, runningAnalysis);
      env.analysesStore.set(`${ORG_A}:${failedAnalysis.id}`, failedAnalysis);

      const r1 = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${pendingAnalysis.id}`,
        headers: { authorization: "Bearer token-org-a" },
      });
      assert.equal(expectAnalysisSuccess(r1.body).status, "pending");

      const r2 = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${runningAnalysis.id}`,
        headers: { authorization: "Bearer token-org-a" },
      });
      assert.equal(expectAnalysisSuccess(r2.body).status, "running");

      const r3 = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${failedAnalysis.id}`,
        headers: { authorization: "Bearer token-org-a" },
      });
      assert.equal(expectAnalysisSuccess(r3.body).status, "failed");
    });

    it("U. stable error shape: all error responses return { error: { code, message } }", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/00000000-0000-4000-8000-000000000000`,
        headers: { authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 404);
      assert.ok("error" in res.body);
      assert.ok(typeof res.body.error.code === "string");
      assert.ok(typeof res.body.error.message === "string");
    });

    it("V. no recomputation during GET: only reads persisted state from storage", async () => {
      const initialCount = env.getCallCount();

      const res = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${ANALYSIS_A}`,
        headers: { authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(env.getCallCount(), initialCount + 1);
    });

    it("W. Step 49: GET returns formatted evidence array for impact findings", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/impact-analyses/${ANALYSIS_A}`,
        headers: { authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const analysis = expectAnalysisSuccess(res.body);
      assert.ok(Array.isArray(analysis.evidence));
      assert.equal(analysis.evidence.length, 1);
      assert.equal(analysis.evidence[0]?.id, "ev-node-d1");
      assert.equal(analysis.evidence[0]?.file_path, "src/DirectService.ts");
      assert.equal(analysis.evidence[0]?.line_start, 10);
      assert.equal(analysis.evidence[0]?.line_end, 25);
      assert.equal(analysis.evidence[0]?.relationship_description, "Direct service definition");
    });
  });
});
