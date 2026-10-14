import React from "react";

// --- Connection Status Types ---

export type ExplorerConnectionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * Maps the WebSocket client status to a simplified explorer connection status.
 */
export function mapWsStatusToConnectionStatus(
  wsStatus: "idle" | "connecting" | "connected" | "disconnected" | "closed",
): ExplorerConnectionStatus {
  switch (wsStatus) {
    case "connected":
      return "connected";
    case "connecting":
      return "reconnecting";
    case "idle":
    case "disconnected":
    case "closed":
    default:
      return "disconnected";
  }
}

// --- Presentational Components ---

export interface ExplorerLoadingStateProps {
  readonly message?: string;
}

/**
 * Initial loading state before first graph data arrives.
 */
export function ExplorerLoadingState({ message }: ExplorerLoadingStateProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-loading-state",
      role: "status",
      "aria-live": "polite",
      style: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center" as const,
        color: "#475569",
        minHeight: "400px",
      },
    },
    React.createElement(
      "div",
      {
        "aria-hidden": "true",
        style: {
          width: "40px",
          height: "40px",
          border: "3px solid #e2e8f0",
          borderTopColor: "#3b82f6",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
          marginBottom: "16px",
        },
      },
    ),
    React.createElement(
      "h2",
      {
        style: {
          fontSize: "18px",
          fontWeight: 600,
          color: "#1e293b",
          marginBottom: "8px",
        },
      },
      "Loading Architecture Graph",
    ),
    React.createElement(
      "p",
      {
        style: { fontSize: "14px", color: "#64748b", maxWidth: "400px" },
      },
      message ?? "Fetching the architecture graph from the Fluxora API…",
    ),
    // Inline keyframes for the spinner
    React.createElement("style", null, "@keyframes spin { to { transform: rotate(360deg) } }"),
  );
}

export interface ExplorerEmptyStateProps {
  readonly message?: string;
}

/**
 * Empty state: query succeeded but returned zero renderable nodes.
 */
export function ExplorerEmptyState({ message }: ExplorerEmptyStateProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-empty-state",
      role: "status",
      "aria-live": "polite",
      style: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center" as const,
        color: "#475569",
        minHeight: "400px",
      },
    },
    React.createElement(
      "div",
      {
        "aria-hidden": "true",
        style: {
          fontSize: "36px",
          marginBottom: "16px",
        },
      },
      "📭",
    ),
    React.createElement(
      "h2",
      {
        style: {
          fontSize: "18px",
          fontWeight: 600,
          color: "#1e293b",
          marginBottom: "8px",
        },
      },
      "No Graph Nodes Found",
    ),
    React.createElement(
      "p",
      {
        style: { fontSize: "14px", color: "#64748b", maxWidth: "420px", marginBottom: "16px" },
      },
      message ?? "The graph query returned successfully but contained no renderable nodes.",
    ),
    React.createElement(
      "ul",
      {
        style: {
          listStyleType: "disc",
          textAlign: "left" as const,
          fontSize: "13px",
          color: "#64748b",
          paddingLeft: "20px",
          maxWidth: "360px",
        },
      },
      React.createElement("li", { style: { marginBottom: "4px" } }, "Try adjusting the active filters to broaden your query."),
      React.createElement("li", { style: { marginBottom: "4px" } }, "Verify that the analysis run has completed processing."),
      React.createElement("li", null, "Select a different start node or analysis context."),
    ),
  );
}

export interface ExplorerAnalysisNotReadyProps {
  readonly message?: string;
}

/**
 * Analysis-not-ready state: server-side determination that analysis data is unavailable.
 * Visually and semantically distinct from empty graph and query error.
 */
export function ExplorerAnalysisNotReady({ message }: ExplorerAnalysisNotReadyProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-analysis-not-ready",
      role: "status",
      "aria-live": "polite",
      style: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center" as const,
        color: "#475569",
        minHeight: "400px",
      },
    },
    React.createElement(
      "div",
      {
        "aria-hidden": "true",
        style: { fontSize: "36px", marginBottom: "16px" },
      },
      "⏳",
    ),
    React.createElement(
      "h2",
      {
        style: {
          fontSize: "18px",
          fontWeight: 600,
          color: "#1e293b",
          marginBottom: "8px",
        },
      },
      "Analysis Not Ready",
    ),
    React.createElement(
      "p",
      {
        style: { fontSize: "14px", color: "#64748b", maxWidth: "420px" },
      },
      message ?? "The architecture analysis for this repository has not completed yet. The graph will be available once indexing and analysis finish.",
    ),
  );
}

export interface ExplorerErrorStateProps {
  readonly message?: string;
  readonly onRetry?: (() => void) | undefined;
}

/**
 * Error state for failed graph queries. Provides retry action.
 */
export function ExplorerErrorState({ message, onRetry }: ExplorerErrorStateProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-error-state",
      role: "alert",
      "aria-live": "assertive",
      style: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center" as const,
        color: "#475569",
        minHeight: "400px",
      },
    },
    React.createElement(
      "div",
      {
        "aria-hidden": "true",
        style: { fontSize: "36px", marginBottom: "16px" },
      },
      "⚠️",
    ),
    React.createElement(
      "h2",
      {
        style: {
          fontSize: "18px",
          fontWeight: 600,
          color: "#dc2626",
          marginBottom: "8px",
        },
      },
      "Graph Query Failed",
    ),
    React.createElement(
      "p",
      {
        style: { fontSize: "14px", color: "#64748b", maxWidth: "420px", marginBottom: "16px" },
      },
      message ?? "An error occurred while loading the architecture graph. Please try again.",
    ),
    onRetry
      ? React.createElement(
          "button",
          {
            "data-testid": "explorer-retry-button",
            type: "button",
            onClick: onRetry,
            "aria-label": "Retry loading the architecture graph",
            style: {
              padding: "8px 20px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#ffffff",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
            },
          },
          "Retry",
        )
      : null,
  );
}

export interface ExplorerConnectionBadgeProps {
  readonly status: ExplorerConnectionStatus;
}

const CONNECTION_CONFIG: Record<ExplorerConnectionStatus, { label: string; color: string; ariaLabel: string }> = {
  connected: { label: "Live", color: "#10b981", ariaLabel: "Live updates connected" },
  reconnecting: { label: "Reconnecting", color: "#f59e0b", ariaLabel: "Reconnecting to live updates" },
  disconnected: { label: "Offline", color: "#94a3b8", ariaLabel: "Live updates unavailable" },
};

/**
 * Small connection status badge shown in the explorer header.
 */
export function ExplorerConnectionBadge({ status }: ExplorerConnectionBadgeProps): React.JSX.Element {
  const config = CONNECTION_CONFIG[status];
  return React.createElement(
    "span",
    {
      "data-testid": "explorer-connection-badge",
      "data-status": status,
      role: "status",
      "aria-label": config.ariaLabel,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        fontSize: "11px",
        fontFamily: "ui-monospace, monospace",
        color: "#64748b",
        padding: "2px 8px",
        borderRadius: "4px",
        backgroundColor: "rgba(241, 245, 249, 0.9)",
        border: "1px solid #e2e8f0",
      },
    },
    React.createElement("span", {
      "aria-hidden": "true",
      style: {
        display: "inline-block",
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        backgroundColor: config.color,
      },
    }),
    React.createElement("span", null, config.label),
  );
}

export interface ExplorerUpdatingIndicatorProps {
  readonly visible: boolean;
}

/**
 * Non-blocking banner shown during background graph refresh.
 */
export function ExplorerUpdatingIndicator({ visible }: ExplorerUpdatingIndicatorProps): React.JSX.Element | null {
  if (!visible) return null;
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-updating-indicator",
      role: "status",
      "aria-live": "polite",
      "aria-label": "Updating graph",
      style: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        backgroundColor: "#3b82f6",
        zIndex: 50,
        animation: "pulse-bar 1.5s ease-in-out infinite",
      },
    },
    React.createElement("style", null, "@keyframes pulse-bar { 0%, 100% { opacity: 0.4 } 50% { opacity: 1 } }"),
  );
}

export interface ExplorerRefreshErrorBannerProps {
  readonly message: string;
  readonly onRetry?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}

/**
 * Non-blocking error banner shown when a background refresh fails.
 * The existing graph remains visible below this banner.
 */
export function ExplorerRefreshErrorBanner({ message, onRetry, onDismiss }: ExplorerRefreshErrorBannerProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-refresh-error",
      role: "alert",
      "aria-live": "assertive",
      style: {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 16px",
        backgroundColor: "#fef2f2",
        borderBottom: "1px solid #fecaca",
        color: "#991b1b",
        fontSize: "13px",
      },
    },
    React.createElement("span", { "aria-hidden": "true" }, "⚠️"),
    React.createElement(
      "span",
      { style: { flex: 1 } },
      "Graph refresh failed: ",
      message,
    ),
    onRetry
      ? React.createElement(
          "button",
          {
            "data-testid": "refresh-error-retry-button",
            type: "button",
            onClick: onRetry,
            "aria-label": "Retry graph refresh",
            style: {
              padding: "4px 12px",
              fontSize: "12px",
              fontWeight: 500,
              color: "#ffffff",
              backgroundColor: "#dc2626",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            },
          },
          "Retry",
        )
      : null,
    onDismiss
      ? React.createElement(
          "button",
          {
            "data-testid": "refresh-error-dismiss-button",
            type: "button",
            onClick: onDismiss,
            "aria-label": "Dismiss error",
            style: {
              padding: "4px 8px",
              fontSize: "14px",
              color: "#991b1b",
              background: "none",
              border: "none",
              cursor: "pointer",
            },
          },
          "✕",
        )
      : null,
  );
}
