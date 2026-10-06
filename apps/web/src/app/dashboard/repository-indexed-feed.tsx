"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  handleRepositoryIndexedMessage,
  type RepositoryIndexedUiNotification,
} from "../../events/repository-events";

export function RepositoryIndexedLiveFeed() {
  const { getToken, orgId } = useAuth();
  const [notifications, setNotifications] = useState<RepositoryIndexedUiNotification[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");

  useEffect(() => {
    let ws: WebSocket | null = null;
    let isCancelled = false;

    async function connect() {
      try {
        const token = await getToken();
        if (isCancelled || !token) {
          return;
        }

        setConnectionStatus("connecting");
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsHost = process.env.NEXT_PUBLIC_WS_URL || `${protocol}//${window.location.host}`;
        const wsUrl = `${wsHost}/api/v1/ws?token=${encodeURIComponent(token)}`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          if (!isCancelled) {
            setConnectionStatus("connected");
          }
        };

        ws.onmessage = (event) => {
          const notification = handleRepositoryIndexedMessage(event.data);
          if (notification) {
            setNotifications((prev) => [notification, ...prev]);
          }
        };

        ws.onclose = () => {
          if (!isCancelled) {
            setConnectionStatus("disconnected");
          }
        };

        ws.onerror = () => {
          if (!isCancelled) {
            setConnectionStatus("disconnected");
          }
        };
      } catch {
        if (!isCancelled) {
          setConnectionStatus("disconnected");
        }
      }
    }

    connect();

    return () => {
      isCancelled = true;
      if (ws) {
        ws.close();
      }
    };
  }, [getToken, orgId]);

  if (notifications.length === 0 && connectionStatus !== "connected") {
    return null;
  }

  return (
    <section aria-label="Repository Activity Feed" style={{ marginTop: "1.5rem" }}>
      <h3>Live Ingestion Activity</h3>
      <p style={{ fontSize: "0.875rem", color: "#666" }}>
        Status: {connectionStatus}
      </p>
      {notifications.length === 0 ? (
        <p style={{ fontSize: "0.875rem", color: "#888" }}>
          Waiting for repository indexing events...
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {notifications.map((n) => (
            <li
              key={n.eventId}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: "4px",
                padding: "0.75rem",
                marginBottom: "0.5rem",
              }}
            >
              <strong>Repository Indexed</strong>: <code>{n.repositoryId}</code>
              <br />
              <small>
                Snapshot: <code>{n.snapshotId}</code> | Commit: <code>{n.commitSha.slice(0, 7)}</code>
                {n.ref ? ` (${n.ref})` : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

