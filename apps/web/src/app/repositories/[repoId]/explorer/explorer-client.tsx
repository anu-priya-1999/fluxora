"use client";

import { useAuth } from "@clerk/nextjs";
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { GraphCanvas } from "../../../../components/graph/GraphCanvas";
import { NodeInspectorPanel } from "../../../../components/graph/NodeInspectorPanel";
import {
  GraphFilters,
  DEFAULT_GRAPH_FILTERS,
  type GraphFilterState,
} from "../../../../components/graph/GraphFilters";
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
}

export function ArchitectureExplorerClient({
  apiUrl,
  context,
}: ArchitectureExplorerClientProps): React.JSX.Element {
  const { isLoaded, getToken } = useAuth();
  const [filters, setFilters] = useState<GraphFilterState>(DEFAULT_GRAPH_FILTERS);
  const [state, setState] = useState<ExplorerState>({ status: "loading" });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = useMemo(() => {
    if (state.status !== "ready" || !selectedNodeId) {
      return null;
    }
    return state.graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [state, selectedNodeId]);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let isCancelled = false;

    async function loadGraph() {
      setState((prev) => {
        // If we already have a ready graph, keep the existing data visible or update smoothly
        if (prev.status === "ready") {
          return prev;
        }
        return { status: "loading" };
      });

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
        setState({
          status: "error",
          message: result.message,
        });
        return;
      }

      if (result.data.nodes.length === 0) {
        setState({
          status: "not_ready",
          message: "No graph nodes returned from the server for this query.",
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
  }, [apiUrl, context, filters, isLoaded, getToken]);

  if (state.status === "loading") {
    return (
      <div data-testid="explorer-loading-state" className="p-8 text-center text-slate-600">
        <h2 className="text-xl font-semibold mb-2">Loading Architecture Explorer</h2>
        <p>Fetching graph context from the Fluxora API...</p>
      </div>
    );
  }

  if (state.status === "not_ready") {
    return (
      <div data-testid="explorer-empty-state" className="p-8 text-center text-slate-600">
        <h2 className="text-xl font-semibold mb-2">Graph Not Ready</h2>
        <p className="mb-4">{state.message}</p>
        <Link href="/dashboard" className="text-blue-600 hover:underline">
          Return to Dashboard
        </Link>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div data-testid="explorer-error-state" className="p-8 text-center text-red-600">
        <h2 className="text-xl font-semibold mb-2">Graph API Error</h2>
        <p className="mb-4">{state.message}</p>
        <Link href="/dashboard" className="text-blue-600 hover:underline">
          Return to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="explorer-ready-state" className="w-full h-full flex flex-col flex-1" style={{ minHeight: "80vh" }}>
      <header className="px-4 py-2 border-b border-slate-200 bg-white flex justify-between items-center text-sm">
        <span className="font-semibold text-slate-800">
          Repository: {context.repositoryName ?? context.repositoryId}
        </span>
        <span className="text-slate-500 font-mono text-xs">
          Run: {state.analysisRunId} | Nodes: {state.graph.nodes.length} | Edges: {state.graph.edges.length}
        </span>
      </header>
      <GraphFilters
        filters={filters}
        onChange={(next) => setFilters(next)}
        onReset={() => setFilters(DEFAULT_GRAPH_FILTERS)}
      />
      <div className="flex-1 w-full flex flex-row overflow-hidden relative" style={{ minHeight: "650px", height: "100%" }}>
        <div className="flex-1 h-full relative">
          <GraphCanvas
            nodes={state.graph.nodes}
            edges={state.graph.edges}
            selectedNodeId={selectedNodeId}
            onNodeClick={(id) => setSelectedNodeId(id)}
            onPaneClick={() => setSelectedNodeId(null)}
            showControls={true}
            showMiniMap={false}
            showBackground={true}
          />
        </div>
        <aside
          data-testid="explorer-inspector-aside"
          className="w-80 md:w-96 border-l border-slate-200 bg-white flex flex-col h-full overflow-hidden shrink-0"
        >
          <NodeInspectorPanel
            node={selectedNode}
            evidence={state.graph.evidence}
            onClose={() => setSelectedNodeId(null)}
          />
        </aside>
      </div>
    </div>
  );
}
