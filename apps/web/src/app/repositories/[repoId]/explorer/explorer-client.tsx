"use client";

import { useAuth } from "@clerk/nextjs";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { GraphCanvas } from "../../../../components/graph/GraphCanvas";
import { NodeInspectorPanel } from "../../../../components/graph/NodeInspectorPanel";
import {
  GraphFilters,
  DEFAULT_GRAPH_FILTERS,
  type GraphFilterState,
} from "../../../../components/graph/GraphFilters";
import {
  ExplorerLoadingState,
  ExplorerEmptyState,
  ExplorerAnalysisNotReady,
  ExplorerErrorState,
  ExplorerConnectionBadge,
  ExplorerUpdatingIndicator,
  ExplorerRefreshErrorBanner,
  mapWsStatusToConnectionStatus,
  type ExplorerConnectionStatus,
} from "../../../../components/graph/ExplorerStatus";
import {
  createExplorerWebSocketClient,
  type ExplorerWsStatus,
  type WebSocketFactory,
} from "../../../../events/explorer-ws-client";
import { isGraphUpdatedEventRelevant } from "../../../../events/graph-events";
import {
  buildGraphQueryRequest,
  fetchGraphQuery,
  transformGraphResponseToFlow,
  type ExplorerState,
  type ResolvedAnalysisContext,
} from "./explorer-data";

export interface ArchitectureExplorerClientProps {
  readonly apiUrl: string;
  readonly context: ResolvedAnalysisContext;
  readonly webSocketFactory?: WebSocketFactory | undefined;
}

export function ArchitectureExplorerClient({
  apiUrl,
  context,
  webSocketFactory,
}: ArchitectureExplorerClientProps): React.JSX.Element {
  const { isLoaded, getToken } = useAuth();
  const [filters, setFilters] = useState<GraphFilterState>(DEFAULT_GRAPH_FILTERS);
  const [state, setState] = useState<ExplorerState>({ status: "loading" });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [liveUpdateTrigger, setLiveUpdateTrigger] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ExplorerConnectionStatus>("disconnected");

  const selectedNode = useMemo(() => {
    if (state.status !== "ready" || !selectedNodeId) {
      return null;
    }
    return state.graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [state, selectedNodeId]);

  // Manual retry: increment trigger to re-run the fetch effect
  const handleRetry = useCallback(() => {
    setLiveUpdateTrigger((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let isCancelled = false;
    const hasExistingGraph = state.status === "ready";

    async function loadGraph() {
      if (hasExistingGraph) {
        // Background refresh: keep existing graph visible
        setIsRefreshing(true);
        setRefreshError(null);
      } else {
        setState((prev) => {
          if (prev.status === "ready") {
            return prev;
          }
          return { status: "loading" };
        });
      }

      const request = buildGraphQueryRequest({
        context,
        filters,
        direction: "both",
        includeEvidence: true,
      });

      const result = await fetchGraphQuery({
        apiUrl,
        getToken,
        request,
      });

      if (isCancelled) {
        return;
      }

      if (!result.ok) {
        if (hasExistingGraph) {
          // Background refresh failed: preserve existing graph, show non-blocking error
          setIsRefreshing(false);
          setRefreshError(result.message);
          return;
        }
        setState({
          status: "error",
          message: result.message,
        });
        return;
      }

      if (result.data.nodes.length === 0) {
        if (hasExistingGraph) {
          // Background refresh returned empty: update to empty state
          setIsRefreshing(false);
          setRefreshError(null);
        }
        setState({
          status: "empty",
          message: "The graph query returned successfully but contained no renderable nodes for the current filters.",
        });
        setSelectedNodeId(null);
        return;
      }

      const flow = transformGraphResponseToFlow(result.data);

      setState({
        status: "ready",
        analysisRunId: context.analysisRunId,
        repositoryId: context.repositoryId,
        graph: result.data,
        flowNodes: flow.nodes,
        flowEdges: flow.edges,
      });

      setIsRefreshing(false);
      setRefreshError(null);

      // Synchronize selectedNodeId: preserve if still exists in the returned nodes, otherwise clear safely
      setSelectedNodeId((currentSelectedId) => {
        if (!currentSelectedId) return null;
        const exists = result.data.nodes.some((n) => n.id === currentSelectedId);
        return exists ? currentSelectedId : null;
      });
    }

    void loadGraph();

    return () => {
      isCancelled = true;
    };
    // NOTE: state.status is deliberately excluded from deps to avoid infinite loops.
    // The hasExistingGraph check is captured at effect start time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, context, filters, isLoaded, getToken, liveUpdateTrigger]);

  // Live WebSocket subscription for graph.updated invalidation
  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    const wsClient = createExplorerWebSocketClient({
      apiUrl,
      getToken,
      ...(webSocketFactory !== undefined ? { webSocketFactory } : {}),
      onGraphUpdated: (notification) => {
        if (isGraphUpdatedEventRelevant(notification.payload, context)) {
          setLiveUpdateTrigger((prev) => prev + 1);
        }
      },
      onStatusChange: (wsStatus: ExplorerWsStatus) => {
        setConnectionStatus(mapWsStatusToConnectionStatus(wsStatus));
      },
    });

    void wsClient.connect();

    return () => {
      wsClient.close();
    };
  }, [apiUrl, context, isLoaded, getToken, webSocketFactory]);

  // --- INITIAL LOADING STATE ---
  if (state.status === "loading") {
    return React.createElement(ExplorerLoadingState, null);
  }

  // --- ANALYSIS NOT READY STATE ---
  if (state.status === "not_ready") {
    return React.createElement(
      "div",
      {
        "data-testid": "explorer-not-ready-container",
        style: { display: "flex", flexDirection: "column" as const, height: "100%" },
      },
      React.createElement(ExplorerAnalysisNotReady, { message: state.message }),
      React.createElement(
        "div",
        { style: { textAlign: "center" as const, paddingBottom: "24px" } },
        React.createElement(
          Link,
          { href: "/dashboard", className: "text-blue-600 hover:underline" },
          "Return to Dashboard",
        ),
      ),
    );
  }

  // --- EMPTY GRAPH STATE ---
  if (state.status === "empty") {
    return React.createElement(
      "div",
      {
        "data-testid": "explorer-empty-container",
        style: { display: "flex", flexDirection: "column" as const, height: "100%" },
      },
      React.createElement(ExplorerEmptyState, { message: state.message }),
    );
  }

  // --- INITIAL ERROR STATE (no graph available) ---
  if (state.status === "error") {
    return React.createElement(ExplorerErrorState, {
      message: state.message,
      onRetry: handleRetry,
    });
  }

  // --- READY STATE (graph is loaded and visible) ---
  return React.createElement(
    "div",
    {
      "data-testid": "explorer-ready-state",
      className: "w-full h-full flex flex-col flex-1",
      style: { minHeight: "80vh", position: "relative" as const },
    },
    // Updating indicator (non-blocking progress bar during background refresh)
    React.createElement(ExplorerUpdatingIndicator, { visible: isRefreshing }),
    // Header bar
    React.createElement(
      "header",
      {
        className: "px-4 py-2 border-b border-slate-200 bg-white flex justify-between items-center text-sm",
      },
      React.createElement(
        "span",
        { className: "font-semibold text-slate-800" },
        `Repository: ${context.repositoryName ?? context.repositoryId}`,
      ),
      React.createElement(
        "div",
        {
          style: { display: "flex", alignItems: "center", gap: "12px" },
        },
        React.createElement(
          "span",
          { className: "text-slate-500 font-mono text-xs" },
          `Run: ${state.analysisRunId} | Nodes: ${state.graph.nodes.length} | Edges: ${state.graph.edges.length}`,
        ),
        React.createElement(ExplorerConnectionBadge, { status: connectionStatus }),
      ),
    ),
    // Refresh error banner (non-blocking, shown above the graph)
    refreshError
      ? React.createElement(ExplorerRefreshErrorBanner, {
          message: refreshError,
          onRetry: handleRetry,
          onDismiss: () => setRefreshError(null),
        })
      : null,
    // Filters
    React.createElement(GraphFilters, {
      filters,
      onChange: (next: GraphFilterState) => setFilters(next),
      onReset: () => setFilters(DEFAULT_GRAPH_FILTERS),
    }),
    // Main content area: Graph Canvas + Inspector
    React.createElement(
      "div",
      {
        className: "flex-1 w-full flex flex-row overflow-hidden relative",
        style: { minHeight: "650px", height: "100%" },
      },
      React.createElement(
        "div",
        { className: "flex-1 h-full relative" },
        React.createElement(GraphCanvas, {
          nodes: state.graph.nodes,
          edges: state.graph.edges,
          selectedNodeId,
          onNodeClick: (id: string) => setSelectedNodeId(id),
          onPaneClick: () => setSelectedNodeId(null),
          showControls: true,
          showMiniMap: false,
          showBackground: true,
        }),
      ),
      React.createElement(
        "aside",
        {
          "data-testid": "explorer-inspector-aside",
          className: "w-80 md:w-96 border-l border-slate-200 bg-white flex flex-col h-full overflow-hidden shrink-0",
        },
        React.createElement(NodeInspectorPanel, {
          node: selectedNode,
          evidence: state.graph.evidence,
          onClose: () => setSelectedNodeId(null),
        }),
      ),
    ),
  );
}
