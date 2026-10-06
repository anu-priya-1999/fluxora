import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket from "ws";

import type { FluxoraEventEnvelope, RepositoryIndexedPayload } from "@fluxora/shared-types";
import { REPOSITORY_INDEXED_EVENT_TYPE } from "@fluxora/shared-types";

import { setupWebSocketServer } from "./server.ts";
import { WebSocketHub } from "./hub.ts";
import { extractWsToken } from "./auth.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createMockAuthDeps() {
  return {
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
      throw new Error("Invalid Clerk session.");
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
    pool: {} as unknown as import("pg").Pool,
  };
}

test("extractWsToken extracts tokens from headers and rejects query parameters", () => {
  const reqWithHeader = {
    headers: { authorization: "Bearer my-secret-token" },
    url: "/api/v1/ws",
  } as unknown as http.IncomingMessage;
  assert.equal(extractWsToken(reqWithHeader), "my-secret-token");

  // Query parameter token must NOT be accepted for security
  const reqWithQuery = {
    headers: {},
    url: "/api/v1/ws?token=query-token-value",
  } as unknown as http.IncomingMessage;
  assert.equal(extractWsToken(reqWithQuery), null);

  const reqWithQueryAuth = {
    headers: {},
    url: "/api/v1/ws?authorization=Bearer%20encoded-token",
  } as unknown as http.IncomingMessage;
  assert.equal(extractWsToken(reqWithQueryAuth), null);

  const reqWithProtocol = {
    headers: { "sec-websocket-protocol": "bearer.protocol-token, something-else" },
    url: "/api/v1/ws",
  } as unknown as http.IncomingMessage;
  assert.equal(extractWsToken(reqWithProtocol), "protocol-token");

  const reqWithTokenProtocol = {
    headers: { "sec-websocket-protocol": "token.protocol-token, something-else" },
    url: "/api/v1/ws",
  } as unknown as http.IncomingMessage;
  assert.equal(extractWsToken(reqWithTokenProtocol), "protocol-token");

  const reqNone = {
    headers: {},
    url: "/api/v1/ws",
  } as unknown as http.IncomingMessage;
  assert.equal(extractWsToken(reqNone), null);
});

test("WebSocketHub isolates event broadcasts strictly by organization", () => {
  const hub = new WebSocketHub();

  const messagesA: string[] = [];
  const messagesB: string[] = [];

  const mockWsA = {
    readyState: 1, // OPEN
    send: (msg: string) => messagesA.push(msg),
  } as unknown as WebSocket;

  const mockWsB = {
    readyState: 1, // OPEN
    send: (msg: string) => messagesB.push(msg),
  } as unknown as WebSocket;

  const unregisterA = hub.register({
    ws: mockWsA,
    userId: USER_A,
    organizationId: ORG_A,
  });

  const unregisterB = hub.register({
    ws: mockWsB,
    userId: USER_B,
    organizationId: ORG_B,
  });

  assert.equal(hub.getClientCount(), 2);
  assert.equal(hub.getClientCount(ORG_A), 1);
  assert.equal(hub.getClientCount(ORG_B), 1);

  const envelopeOrgA: FluxoraEventEnvelope<RepositoryIndexedPayload> = {
    event_id: "99999999-9999-4999-8999-999999999999",
    event_type: REPOSITORY_INDEXED_EVENT_TYPE,
    organization_id: ORG_A,
    occurred_at: new Date().toISOString(),
    idempotency_key: "repository.indexed:repo:commit",
    payload: {
      repositoryId: "repo-1",
      repository_id: "repo-1",
      snapshotId: "snap-1",
      snapshot_id: "snap-1",
      commitSha: "sha-1",
      commit_sha: "sha-1",
      ref: "main",
    },
    schema_version: 1,
  };

  // Broadcast event belonging to Org A
  const sent = hub.broadcast(envelopeOrgA);
  assert.equal(sent, 1);
  assert.equal(messagesA.length, 1);
  assert.equal(messagesB.length, 0);

  const rawMessageA = messagesA[0];
  assert.ok(rawMessageA !== undefined);
  const parsed = JSON.parse(rawMessageA);
  assert.equal(parsed.event_id, envelopeOrgA.event_id);
  assert.equal(parsed.organization_id, ORG_A);
  assert.equal(parsed.event_type, REPOSITORY_INDEXED_EVENT_TYPE);

  // Unregister A and broadcast again
  unregisterA();
  assert.equal(hub.getClientCount(ORG_A), 0);
  assert.equal(hub.broadcast(envelopeOrgA), 0);

  unregisterB();
  assert.equal(hub.getClientCount(), 0);
});

test("WebSocket server: authenticated /api/v1/ws connection and live repository.indexed delivery", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const hub = new WebSocketHub();
  const authDeps = createMockAuthDeps();

  const wsServer = setupWebSocketServer(server, {
    hub,
    authDeps,
    autoStartListener: false,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as { port: number };
  const port = address.port;

  t.after(async () => {
    await wsServer.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // 1. Connection without token rejected with 401
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => {
      assert.equal(res.statusCode, 401);
      ws.terminate();
      resolve();
    });
    ws.on("open", () => {
      reject(new Error("unauthenticated connection unexpectedly opened"));
    });
  });

  // 2. Connection with URL query token rejected with 401 (URL tokens disallowed for security)
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=valid-token-org-a`);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => {
      assert.equal(res.statusCode, 401);
      ws.terminate();
      resolve();
    });
    ws.on("open", () => {
      reject(new Error("query token connection unexpectedly opened"));
    });
  });

  // 3. Connection with invalid protocol token rejected with 401
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, ["bearer.bad-token"]);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => {
      assert.equal(res.statusCode, 401);
      ws.terminate();
      resolve();
    });
    ws.on("open", () => {
      reject(new Error("invalid token connection unexpectedly opened"));
    });
  });

  const clientA = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, ["bearer.valid-token-org-a"]);
  const clientB = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, ["bearer.valid-token-org-b"]);
  clientA.on("error", () => {});
  clientB.on("error", () => {});

  const clientAMessages: string[] = [];
  const clientBMessages: string[] = [];

  clientA.on("message", (data) => {
    clientAMessages.push(String(data));
  });

  clientB.on("message", (data) => {
    clientBMessages.push(String(data));
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      clientA.on("open", () => {
        resolve();
      });
      clientA.on("error", (err) => reject(err));
    }),
    new Promise<void>((resolve, reject) => {
      clientB.on("open", () => {
        resolve();
      });
      clientB.on("error", (err) => reject(err));
    }),
  ]);

  // Wait briefly for connection.ready to be delivered and recorded
  for (let i = 0; i < 20 && (clientAMessages.length === 0 || clientBMessages.length === 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.ok(clientAMessages.length >= 1);
  const rawReadyA = clientAMessages[0];
  assert.ok(rawReadyA !== undefined);
  const readyA = JSON.parse(rawReadyA);
  assert.equal(readyA.type, "connection.ready");
  assert.equal(readyA.organization_id, ORG_A);

  assert.ok(clientBMessages.length >= 1);
  const rawReadyB = clientBMessages[0];
  assert.ok(rawReadyB !== undefined);
  const readyB = JSON.parse(rawReadyB);
  assert.equal(readyB.type, "connection.ready");
  assert.equal(readyB.organization_id, ORG_B);

  // 4. Test Ping / Pong
  const pongPromise = new Promise<string>((resolve) => {
    clientA.on("message", (data) => {
      if (String(data) === "pong") {
        resolve("pong");
      }
    });
  });
  clientA.send("ping");
  const pongResult = await pongPromise;
  assert.equal(pongResult, "pong");

  // 5. Broadcast repository.indexed event for Org A
  const indexedEventA: FluxoraEventEnvelope<RepositoryIndexedPayload> = {
    event_id: "88888888-8888-4888-8888-888888888888",
    event_type: REPOSITORY_INDEXED_EVENT_TYPE,
    organization_id: ORG_A,
    occurred_at: new Date().toISOString(),
    idempotency_key: "repository.indexed:repo-1:sha-1",
    payload: {
      repositoryId: "repo-1",
      repository_id: "repo-1",
      snapshotId: "snap-1",
      snapshot_id: "snap-1",
      commitSha: "sha-1",
      commit_sha: "sha-1",
      ref: "main",
    },
    schema_version: 1,
  };

  const beforeACount = clientAMessages.length;
  const beforeBCount = clientBMessages.length;

  hub.broadcast(indexedEventA);

  await new Promise((resolve) => setTimeout(resolve, 50));

  // Client A (in Org A) must have received the event
  assert.equal(clientAMessages.length, beforeACount + 1);
  const rawReceivedEvent = clientAMessages[clientAMessages.length - 1];
  assert.ok(rawReceivedEvent !== undefined);
  const receivedEvent = JSON.parse(rawReceivedEvent);
  assert.equal(receivedEvent.event_id, indexedEventA.event_id);
  assert.equal(receivedEvent.event_type, REPOSITORY_INDEXED_EVENT_TYPE);
  assert.equal(receivedEvent.payload.repository_id, "repo-1");

  // Client B (in Org B) must NOT have received Org A's event!
  assert.equal(clientBMessages.length, beforeBCount);

  clientA.close();
  clientB.close();
});
