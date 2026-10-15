import assert from "node:assert/strict";
import { test } from "vitest";
import { GRAPH_UPDATED_EVENT_TYPE } from "@fluxora/shared-types";
import {
  createExplorerWebSocketClient,
  resolveWebSocketUrl,
  type WebSocketLike,
} from "./explorer-ws-client.ts";
import type { GraphUpdatedUiNotification } from "./graph-events.ts";

class MockWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  public closed = false;
  public closeCode: number | undefined;
  public closeReason: string | undefined;
  public readonly url: string;
  public readonly protocols?: string | string[] | undefined;

  constructor(url: string, protocols?: string | string[] | undefined) {
    this.url = url;
    this.protocols = protocols;
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.call(this, new Event("open"));
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.call(this, new MessageEvent("message", { data }));
  }

  simulateClose(code = 1000, reason = "Normal Closure"): void {
    this.readyState = 3; // CLOSED
    this.closed = true;
    this.onclose?.call(this, new CloseEvent("close", { code, reason }));
  }

  simulateError(): void {
    this.onerror?.call(this, new Event("error"));
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    const init: CloseEventInit = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.onclose?.call(this, new CloseEvent("close", init));
  }
}

test("resolveWebSocketUrl derives ws and wss endpoints correctly", () => {
  assert.equal(resolveWebSocketUrl("http://127.0.0.1:4000"), "ws://127.0.0.1:4000/api/v1/ws");
  assert.equal(resolveWebSocketUrl("https://api.fluxora.io"), "wss://api.fluxora.io/api/v1/ws");
  assert.equal(resolveWebSocketUrl("https://api.fluxora.io/some/path"), "wss://api.fluxora.io/api/v1/ws");
});

test("createExplorerWebSocketClient connects with subprotocol bearer.<token>", async () => {
  let createdSocket: MockWebSocket | null = null;

  const client = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "session-clerk-jwt",
    webSocketFactory: (url, protocols) => {
      createdSocket = new MockWebSocket(url, protocols);
      return createdSocket;
    },
    onGraphUpdated: () => {},
  });

  await client.connect();

  assert.ok(createdSocket !== null);
  const socket1 = createdSocket as MockWebSocket;
  assert.equal(socket1.url, "ws://127.0.0.1:4000/api/v1/ws");
  assert.deepEqual(socket1.protocols, ["bearer.session-clerk-jwt"]);

  assert.equal(client.status, "connecting");
  socket1.simulateOpen();
  assert.equal(client.status, "connected");

  client.close();
  assert.equal(client.status, "closed");
  assert.equal(socket1.closed, true);
});

test("createExplorerWebSocketClient delivers parsed graph.updated notifications", async () => {
  let createdSocket: MockWebSocket | null = null;
  const received: GraphUpdatedUiNotification[] = [];

  const client = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "jwt-123",
    webSocketFactory: (url, protocols) => {
      createdSocket = new MockWebSocket(url, protocols);
      return createdSocket;
    },
    onGraphUpdated: (n) => received.push(n),
  });

  await client.connect();
  assert.ok(createdSocket !== null);
  const socket2 = createdSocket as MockWebSocket;
  socket2.simulateOpen();

  const validEnvelope = {
    event_id: "44444444-4444-4444-8444-444444444444",
    event_type: GRAPH_UPDATED_EVENT_TYPE,
    organization_id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "key-1",
    payload: {
      organization_id: "11111111-1111-4111-8111-111111111111",
      analysis_run_id: "33333333-3333-4333-8333-333333333333",
      repository_id: "22222222-2222-4222-8222-222222222222",
      summary: {
        nodes_added: 1,
        nodes_removed: 0,
        nodes_changed: 0,
        nodes_unchanged: 5,
        edges_added: 0,
        edges_removed: 0,
        edges_changed: 0,
        edges_unchanged: 3,
        total_nodes_before: 5,
        total_nodes_after: 6,
        total_edges_before: 3,
        total_edges_after: 3,
        node_delta: 1,
        edge_delta: 0,
      },
      diff: {
        addedNodes: [],
        removedNodes: [],
        changedNodes: [],
        addedEdges: [],
        removedEdges: [],
        changedEdges: [],
      },
    },
  };

  socket2.simulateMessage(JSON.stringify(validEnvelope));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.eventId, "44444444-4444-4444-8444-444444444444");

  // Malformed or unrelated messages are ignored
  socket2.simulateMessage("malformed-raw-string");
  socket2.simulateMessage(JSON.stringify({ event_type: "unrelated.event" }));
  assert.equal(received.length, 1);

  client.close();
});

test("createExplorerWebSocketClient enforces bounded reconnect backoff", async () => {
  const sockets: MockWebSocket[] = [];

  const client = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token-1",
    maxReconnectAttempts: 2,
    baseDelayMs: 10,
    maxDelayMs: 20,
    webSocketFactory: (url, protocols) => {
      const s = new MockWebSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    onGraphUpdated: () => {},
  });

  await client.connect();
  assert.equal(sockets.length, 1);

  // First unexpected disconnect
  sockets[0]?.simulateClose(1006, "Connection dropped");
  assert.equal(client.status, "disconnected");

  // Wait for first reconnect
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(sockets.length, 2);

  // Second unexpected disconnect
  sockets[1]?.simulateClose(1006, "Connection dropped again");

  // Wait for second reconnect
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(sockets.length, 3);

  // Third unexpected disconnect - should reach maxReconnectAttempts (2 reconnects after initial attempt)
  sockets[2]?.simulateClose(1006, "Dropped third time");

  await new Promise((r) => setTimeout(r, 50));
  // No further reconnect attempts should happen
  assert.equal(sockets.length, 3);

  client.close();
});

test("createExplorerWebSocketClient cleanup cancels pending reconnects", async () => {
  const sockets: MockWebSocket[] = [];

  const client = createExplorerWebSocketClient({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token-1",
    baseDelayMs: 50,
    webSocketFactory: (url, protocols) => {
      const s = new MockWebSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    onGraphUpdated: () => {},
  });

  await client.connect();
  assert.equal(sockets.length, 1);

  // Socket closes unexpectedly
  sockets[0]?.simulateClose(1006, "Dropped");

  // Immediate close before reconnect timer fires
  client.close();
  assert.equal(client.status, "closed");

  await new Promise((r) => setTimeout(r, 80));
  // Reconnect should NOT have fired
  assert.equal(sockets.length, 1);
});
