import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import type {
  EvidenceRecord,
  GraphEdge,
  GraphNode,
  GraphTraversalNode,
  GraphTraversalOptions,
  GraphTraversalResult,
} from "@fluxora/shared-types";

import { createApiServer } from "./server.ts";
import type { GraphQueryHandlerDependencies } from "./graph-query.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const RUN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const NODE_1 = "11111111-2222-4222-8222-222222222222";
const NODE_2 = "22222222-3333-4333-8333-333333333333";
const NODE_3 = "33333333-4444-4444-8444-444444444444";
const EDGE_1_2 = "eeeeeeee-1111-4111-8111-111111111111";
const EDGE_2_3 = "eeeeeeee-2222-4222-8222-222222222222";
const EVIDENCE_1 = "ffffffff-1111-4111-8111-111111111111";

function createMockData() {
  const node1: GraphNode = {
    id: NODE_1,
    analysisRunId: RUN_A,
    canonicalId: "mod:src/app.ts",
    nodeType: "module",
    name: "src/app.ts",
    path: "src/app.ts",
    metadata: { lines: 100 },
    confidence: 1.0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const node2: GraphNode = {
    id: NODE_2,
    analysisRunId: RUN_A,
    canonicalId: "mod:src/service.ts",
    nodeType: "service",
    name: "src/service.ts",
    path: "src/service.ts",
    metadata: {},
    confidence: 0.9,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const node3: GraphNode = {
    id: NODE_3,
    analysisRunId: RUN_A,
    canonicalId: "mod:src/db.ts",
    nodeType: "database",
    name: "src/db.ts",
    path: "src/db.ts",
    metadata: {},
    confidence: 0.5, // lower confidence
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const edge1_2: GraphEdge = {
    id: EDGE_1_2,
    analysisRunId: RUN_A,
    sourceNodeId: NODE_1,
    targetNodeId: NODE_2,
    edgeType: "CALLS",
    confidence: 0.95,
    provenance: "static-analysis",
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const edge2_3: GraphEdge = {
    id: EDGE_2_3,
    analysisRunId: RUN_A,
    sourceNodeId: NODE_2,
    targetNodeId: NODE_3,
    edgeType: "QUERIES_DB",
    confidence: 0.5,
    provenance: "inferred",
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const evidence1: EvidenceRecord = {
    id: EVIDENCE_1,
    analysisRunId: RUN_A,
    subjectType: "graph_edge",
    subjectId: EDGE_1_2,
    filePath: "src/app.ts",
    relationshipDescription: "app calls service",
    confidence: 0.95,
    lineStart: 10,
    lineEnd: 12,
    columnStart: 1,
    columnEnd: 20,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  return { node1, node2, node3, edge1_2, edge2_3, evidence1 };
}

function createMockDeps(overrides?: Partial<GraphQueryHandlerDependencies>) {
  const data = createMockData();
  const traversalCalls: GraphTraversalOptions[] = [];

  const mockTraverseGraph = async (
    _pool: unknown,
    options: GraphTraversalOptions,
  ): Promise<GraphTraversalResult> => {
    traversalCalls.push(options);

    // If tenant is Org B, return null startNode (tenant isolation simulation)
    if (options.organizationId !== ORG_A) {
      return {
        startNode: null,
        nodes: [],
        edges: [],
        maxDepthReached: 0,
        evidence: [],
      };
    }

    if (options.startNodeId !== NODE_1) {
      return {
        startNode: null,
        nodes: [],
        edges: [],
        maxDepthReached: 0,
        evidence: [],
      };
    }

    const traversalNodes: GraphTraversalNode[] = [
      { node: data.node1, depth: 0, path: [NODE_1] },
    ];
    const edges: GraphEdge[] = [];

    if (options.maxDepth >= 1) {
      traversalNodes.push({ node: data.node2, depth: 1, path: [NODE_1, NODE_2] });
      edges.push(data.edge1_2);
    }

    if (options.maxDepth >= 2) {
      traversalNodes.push({
        node: data.node3,
        depth: 2,
        path: [NODE_1, NODE_2, NODE_3],
      });
      edges.push(data.edge2_3);
    }

    return {
      startNode: data.node1,
      nodes: traversalNodes,
      edges,
      maxDepthReached: Math.min(options.maxDepth, 2),
      evidence: options.includeEvidence !== false ? [data.evidence1] : undefined,
    };
  };

  const deps: GraphQueryHandlerDependencies = {
    async authenticateClerkToken(authHeader: string | undefined): Promise<string> {
      if (!authHeader?.startsWith("Bearer ")) {
        throw new Error("Missing bearer token.");
      }
      const token = authHeader.slice("Bearer ".length).trim();
      if (token === "valid-token-org-a") {
        return "clerk-user-a";
      }
      if (token === "valid-token-org-b") {
        return "clerk-user-b";
      }
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
    async provisionGithubUser(_pool: unknown, input: { githubUserId: number }) {
      if (input.githubUserId === 1001) {
        return {
          id: USER_A,
          organizationId: ORG_A,
          email: "userA@example.com",
          githubUserId: 1001,
          role: "owner" as const,
          createdAt: new Date(),
        };
      }
      return {
        id: USER_B,
        organizationId: ORG_B,
        email: "userB@example.com",
        githubUserId: 1002,
        role: "owner" as const,
        createdAt: new Date(),
      };
    },
    async getUserById(_pool: unknown, organizationId: string, id: string) {
      return {
        id,
        organizationId,
        email: organizationId === ORG_A ? "userA@example.com" : "userB@example.com",
        githubUserId: organizationId === ORG_A ? 1001 : 1002,
        role: "owner" as const,
        createdAt: new Date(),
      };
    },
    traverseGraph: mockTraverseGraph as typeof import("@fluxora/db").traverseGraph,
    pool: {} as unknown as import("pg").Pool,
    ...overrides,
  };

  return { deps, traversalCalls, data };
}

async function request(
  server: http.Server,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
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
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            parsed = { raw };
          }
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body: parsed,
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

test("Step 31 API: POST /api/v1/graph/query verification suite", async (t) => {
  const { deps, traversalCalls } = createMockDeps();
  const server = createApiServer({
    wsOptions: { autoStartListener: false },
    graphQueryDeps: deps,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  await t.test("1. Valid downstream graph query returns 200 with formatted graph", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        direction: "downstream",
        max_depth: 3,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.truncated, false);
    assert.ok(Array.isArray(res.body.nodes));
    assert.ok(Array.isArray(res.body.edges));
    assert.equal(res.body.nodes.length, 3);
    assert.equal(res.body.edges.length, 2);
    assert.equal(res.body.nodes[0].id, NODE_1);
    assert.equal(res.body.nodes[0].type, "module");
    assert.equal(res.body.nodes[0].depth, 0);
    assert.equal(res.body.edges[0].source, NODE_1);
    assert.equal(res.body.edges[0].target, NODE_2);
    assert.equal(res.body.edges[0].type, "CALLS");
    assert.equal(res.body.edges[0].evidence_id, EVIDENCE_1);

    const lastCall = traversalCalls[traversalCalls.length - 1];
    assert.ok(lastCall);
    assert.equal(lastCall.organizationId, ORG_A);
    assert.equal(lastCall.direction, "outgoing"); // downstream -> outgoing
  });

  await t.test("2. Valid upstream query maps correctly to incoming traversal", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        direction: "upstream",
      },
    });

    assert.equal(res.statusCode, 200);
    const lastCall = traversalCalls[traversalCalls.length - 1];
    assert.ok(lastCall);
    assert.equal(lastCall.direction, "incoming"); // upstream -> incoming
  });

  await t.test("3. Valid both-direction query works", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        direction: "both",
      },
    });

    assert.equal(res.statusCode, 200);
    const lastCall = traversalCalls[traversalCalls.length - 1];
    assert.ok(lastCall);
    assert.equal(lastCall.direction, "both");
  });

  await t.test("4. max_depth is honored and passed to traversal", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        max_depth: 1,
      },
    });

    assert.equal(res.statusCode, 200);
    const lastCall = traversalCalls[traversalCalls.length - 1];
    assert.ok(lastCall);
    assert.equal(lastCall.maxDepth, 1);
    assert.equal(res.body.nodes.length, 2); // depth 0 and depth 1
  });

  await t.test("5. hard traversal depth cap (20) is enforced and rejects > 20", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        max_depth: 21,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "invalid_traversal_options");
    assert.ok(res.body.error.message.includes("20"));
  });

  await t.test("6. edge_types filter is passed to traversal", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        edge_types: ["CALLS"],
      },
    });

    assert.equal(res.statusCode, 200);
    const lastCall = traversalCalls[traversalCalls.length - 1];
    assert.ok(lastCall);
    assert.deepEqual(lastCall.edgeTypes, ["CALLS"]);
  });

  await t.test("7. min_confidence filter is honored deterministically", async () => {
    // node3 and edge2_3 have confidence 0.5; filtering with 0.8 must prune them
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        max_depth: 2,
        min_confidence: 0.8,
      },
    });

    assert.equal(res.statusCode, 200);
    const nodes = res.body["nodes"] as Array<{ id: string }>;
    const edges = res.body["edges"] as Array<{ id: string }>;
    assert.equal(nodes.length, 2);
    assert.ok(!nodes.some((n) => n.id === NODE_3));
    assert.equal(edges.length, 1);
    assert.ok(!edges.some((e) => e.id === EDGE_2_3));
  });

  await t.test("8. malformed request is rejected with the standard error shape", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: "not-a-valid-uuid",
        start_node_id: NODE_1,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "invalid_request");
    assert.ok(res.body.error.message.includes("UUID"));
  });

  await t.test("9. invalid direction is rejected", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        direction: "diagonal",
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "invalid_traversal_options");
  });

  await t.test("10. invalid confidence is rejected", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        min_confidence: 1.5,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "invalid_request");
  });

  await t.test("11. unauthenticated request is rejected with 401", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
      },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, "invalid_session");
  });

  await t.test("12. cross-tenant client organization_id injection is rejected", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        organization_id: ORG_B, // attacker attempts to specify Org B
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "invalid_request");
    assert.ok(res.body.error.message.includes("organization"));
  });

  await t.test("13. inaccessible or cross-tenant start node returns 404 without leaking cross-tenant data", async () => {
    // Org B makes request for start node that only exists in Org A
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-b" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
      },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, "start_node_not_found");
    assert.ok(!res.body.error.message.includes("organization"));
  });

  await t.test("14. evidence is returned correctly and linked to edges", async () => {
    const res = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        max_depth: 1,
        include_evidence: true,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.evidence);
    assert.equal(res.body.evidence.length, 1);
    assert.equal(res.body.evidence[0].id, EVIDENCE_1);
    assert.equal(res.body.evidence[0].file_path, "src/app.ts");
    assert.equal(res.body.evidence[0].relationship_description, "app calls service");
  });

  await t.test("15. unsupported media type is rejected with 415", async () => {
    const address = server.address() as { port: number };
    const port = address.port;

    const res = await new Promise<{ statusCode: number; body: Record<string, unknown> }>((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/v1/graph/query`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer valid-token-org-a",
            "content-type": "text/plain",
          },
        },
        (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(Buffer.from(c)));
          resp.on("end", () => {
            resolve({
              statusCode: resp.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            });
          });
        },
      );
      req.write("plain text");
      req.end();
    });

    assert.equal(res.statusCode, 415);
    const err = res.body["error"] as { code: string };
    assert.equal(err.code, "unsupported_media_type");
  });

  await t.test("16. deterministic response ordering remains stable across repeated identical queries", async () => {
    const res1 = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        max_depth: 2,
      },
    });

    const res2 = await request(server, {
      method: "POST",
      path: "/api/v1/graph/query",
      headers: { authorization: "Bearer valid-token-org-a" },
      body: {
        analysis_run_id: RUN_A,
        start_node_id: NODE_1,
        max_depth: 2,
      },
    });

    assert.deepEqual(res1.body, res2.body);
  });
});
