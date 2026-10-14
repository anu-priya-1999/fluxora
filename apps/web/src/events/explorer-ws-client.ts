import {
  handleGraphUpdatedMessage,
  type GraphUpdatedUiNotification,
} from "./graph-events.ts";

export type ExplorerWsStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "closed";

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(code?: number, reason?: string): void;
  send?(data: string): void;
}

export type WebSocketFactory = (
  url: string,
  protocols?: string | string[] | undefined,
) => WebSocketLike;

export interface ExplorerWsClientOptions {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly onGraphUpdated: (notification: GraphUpdatedUiNotification) => void;
  readonly onStatusChange?: ((status: ExplorerWsStatus) => void) | undefined;
  readonly webSocketFactory?: WebSocketFactory | undefined;
  readonly maxReconnectAttempts?: number | undefined;
  readonly baseDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
}

export interface ExplorerWsClient {
  readonly status: ExplorerWsStatus;
  connect(): Promise<void>;
  close(): void;
}

/**
 * Resolves the WebSocket URL for the Fluxora API.
 * Uses NEXT_PUBLIC_WS_URL when defined, or derives from the configured API URL.
 */
export function resolveWebSocketUrl(apiUrl: string): string {
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_WS_URL &&
    process.env.NEXT_PUBLIC_WS_URL.trim().length > 0
  ) {
    const custom = process.env.NEXT_PUBLIC_WS_URL.trim();
    return custom.endsWith("/api/v1/ws")
      ? custom
      : `${custom.replace(/\/+$/, "")}/api/v1/ws`;
  }

  try {
    const parsed = new URL(apiUrl);
    const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${parsed.host}/api/v1/ws`;
  } catch {
    const protocol =
      typeof window !== "undefined" && window.location?.protocol === "https:"
        ? "wss:"
        : "ws:";
    const host =
      typeof window !== "undefined" && window.location?.host
        ? window.location.host
        : "127.0.0.1:4000";
    return `${protocol}//${host}/api/v1/ws`;
  }
}

/**
 * Creates a bounded, testable WebSocket client for live explorer graph updates.
 */
export function createExplorerWebSocketClient(
  options: ExplorerWsClientOptions,
): ExplorerWsClient {
  const maxAttempts = options.maxReconnectAttempts ?? 5;
  const baseDelay = options.baseDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 10000;
  const wsFactory: WebSocketFactory =
    options.webSocketFactory ??
    ((url, protocols) => new WebSocket(url, protocols));

  let status: ExplorerWsStatus = "idle";
  let isClosed = false;
  let activeSocket: WebSocketLike | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function updateStatus(newStatus: ExplorerWsStatus): void {
    status = newStatus;
    options.onStatusChange?.(newStatus);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function connect(): Promise<void> {
    if (isClosed) {
      return;
    }

    clearReconnectTimer();
    updateStatus("connecting");

    let token: string | null = null;
    try {
      token = await options.getToken();
    } catch {
      token = null;
    }

    if (isClosed) {
      return;
    }

    if (!token) {
      updateStatus("disconnected");
      scheduleReconnect();
      return;
    }

    const wsUrl = resolveWebSocketUrl(options.apiUrl);
    const subprotocol = `bearer.${token}`;

    try {
      const socket = wsFactory(wsUrl, [subprotocol]);
      activeSocket = socket;

      socket.onopen = () => {
        if (isClosed || socket !== activeSocket) {
          socket.close();
          return;
        }
        reconnectAttempts = 0;
        updateStatus("connected");
      };

      socket.onmessage = (event) => {
        if (isClosed || socket !== activeSocket) {
          return;
        }
        const notification = handleGraphUpdatedMessage(event.data);
        if (notification) {
          options.onGraphUpdated(notification);
        }
      };

      socket.onclose = () => {
        if (socket === activeSocket) {
          activeSocket = null;
        }
        if (!isClosed) {
          updateStatus("disconnected");
          scheduleReconnect();
        }
      };

      socket.onerror = () => {
        // Will be followed by onclose
      };
    } catch {
      if (!isClosed) {
        updateStatus("disconnected");
        scheduleReconnect();
      }
    }
  }

  function scheduleReconnect(): void {
    if (isClosed || reconnectAttempts >= maxAttempts) {
      return;
    }

    clearReconnectTimer();
    const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), maxDelay);
    reconnectAttempts += 1;

    reconnectTimer = setTimeout(() => {
      void connect();
    }, delay);
  }

  function close(): void {
    isClosed = true;
    clearReconnectTimer();

    if (activeSocket !== null) {
      const sock = activeSocket;
      activeSocket = null;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {
        // Ignore close errors
      }
    }

    updateStatus("closed");
  }

  return {
    get status() {
      return status;
    },
    connect,
    close,
  };
}
