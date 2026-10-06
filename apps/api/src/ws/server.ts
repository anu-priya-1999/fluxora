import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { authenticateWsRequest, WsAuthError, type WsAuthDependencies } from "./auth.ts";
import { WebSocketHub } from "./hub.ts";
import { PostgresEventListener } from "./listener.ts";

export const WS_PATH = "/api/v1/ws";

export interface FluxoraWsServerOptions {
  hub?: WebSocketHub;
  listener?: PostgresEventListener;
  authDeps?: WsAuthDependencies;
  autoStartListener?: boolean;
}

export interface FluxoraWsServer {
  readonly hub: WebSocketHub;
  readonly listener: PostgresEventListener | null;
  readonly wss: WebSocketServer;
  close(): Promise<void>;
}

export function isWsPath(pathname: string): boolean {
  return pathname === WS_PATH;
}

export function setupWebSocketServer(
  server: http.Server,
  options?: FluxoraWsServerOptions,
): FluxoraWsServer {
  const hub = options?.hub ?? new WebSocketHub();
  const listener =
    options?.listener !== undefined
      ? options.listener
      : options?.autoStartListener === false
        ? null
        : new PostgresEventListener(hub);
  const authDeps = options?.authDeps;

  if (options?.autoStartListener !== false && listener !== null) {
    listener.start().catch((error) => {
      console.error("[ws.server] failed to start postgres event listener:", error);
    });
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head, wss, hub, authDeps);
  });

  return {
    hub,
    listener,
    wss,
    async close() {
      if (listener) {
        await listener.stop().catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  hub: WebSocketHub,
  authDeps?: WsAuthDependencies,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (!isWsPath(url.pathname)) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }

  try {
    const session = await authenticateWsRequest(req, authDeps);

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const unregister = hub.register({
        ws,
        userId: session.userId,
        organizationId: session.organizationId,
      });

      ws.on("close", () => {
        unregister();
      });

      ws.on("error", () => {
        unregister();
      });

      ws.on("message", (data: unknown) => {
        const text = String(data);
        if (text === "ping") {
          ws.send("pong");
        }
      });

      // Acknowledge connection with tenant context
      ws.send(
        JSON.stringify({
          type: "connection.ready",
          organization_id: session.organizationId,
          user_id: session.userId,
        }),
      );
    });
  } catch (error) {
    const statusCode = error instanceof WsAuthError ? error.statusCode : 401;
    const statusText = statusCode === 403 ? "Forbidden" : "Unauthorized";
    const code = error instanceof WsAuthError ? error.code : "invalid_session";
    const message =
      error instanceof Error ? error.message : "Authentication required.";

    const body = JSON.stringify({
      error: {
        code,
        message,
      },
    });

    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body,
    );
  }
}
