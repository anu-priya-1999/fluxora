"use client";

import React, { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type EdgeTypes,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { CanvasInputEdge, CanvasInputNode, FluxoraFlowNode } from "./graph-mapping.ts";
import { mapDomainGraphToFlow } from "./graph-mapping.ts";
import { NodeRenderer } from "./NodeRenderer.tsx";
import {
  computeLodGraph,
  getLodLevelFromZoom,
  type LodLevel,
} from "./graph-lod.ts";
import {
  computeImpactSliceMetrics,
  type NormalizedChangeModeState,
} from "./change-mode-data.ts";
import {
  computeSimulationSliceMetrics,
  type NormalizedSimulationModeState,
} from "./simulation-mode-data.ts";

const DEFAULT_NODE_TYPES: NodeTypes = {
  fluxoraNode: NodeRenderer,
};

export interface GraphCanvasProps {
  /**
   * Domain or API graph nodes to render.
   */
  readonly nodes: readonly CanvasInputNode[];
  /**
   * Domain or API graph edges to render.
   */
  readonly edges: readonly CanvasInputEdge[];
  /**
   * Optional currently selected node ID.
   */
  readonly selectedNodeId?: string | null;
  /**
   * Optional currently selected edge ID (Step 49).
   */
  readonly selectedEdgeId?: string | null;
  /**
   * Optional callback when a node is clicked.
   */
  readonly onNodeClick?: (nodeId: string) => void;
  /**
   * Optional callback when an edge is clicked (Step 49).
   */
  readonly onEdgeClick?: (edgeId: string) => void;
  /**
   * Optional callback when the canvas background pane is clicked.
   */
  readonly onPaneClick?: () => void;
  /**
   * Optional controls flag (default true).
   */
  readonly showControls?: boolean;
  /**
   * Optional minimap flag (default false).
   */
  readonly showMiniMap?: boolean;
  /**
   * Optional background flag (default true).
   */
  readonly showBackground?: boolean;
  /**
   * Optional custom node types.
   */
  readonly nodeTypes?: NodeTypes;
  /**
   * Optional custom edge types.
   */
  readonly edgeTypes?: EdgeTypes;
  /**
   * Optional nodes change handler for interactive movement.
   */
  readonly onNodesChange?: OnNodesChange<FluxoraFlowNode>;
  /**
   * Optional edges change handler.
   */
  readonly onEdgesChange?: OnEdgesChange;
  /**
   * Optional className for wrapper container.
   */
  readonly className?: string;
  /**
   * Optional inline styles for wrapper container.
   */
  readonly style?: React.CSSProperties;
  /**
   * Optional flag to enable viewport zoom-driven Level-of-Detail (default true).
   */
  readonly enableLod?: boolean;
  /**
   * Optional explicit initial LOD tier (default "module").
   */
  readonly initialLod?: LodLevel;
  /**
   * Optional callback when LOD tier changes due to viewport zoom.
   */
  readonly onLodChange?: (lod: LodLevel) => void;
  /**
   * Optional Change-Mode state to overlay on the graph (Step 46).
   */
  readonly changeMode?: NormalizedChangeModeState | null | undefined;
  /**
   * Optional Simulation-Mode state to overlay on the graph (Step 57).
   */
  readonly simulationMode?: NormalizedSimulationModeState | null | undefined;
}

/**
 * GraphCanvas component for Fluxora (Step 34 & Step 38).
 *
 * Responsibilities:
 * - Client-side wrapper around React Flow.
 * - Accepts typed graph nodes/edges as props.
 * - Deterministically maps domain graph models to React Flow nodes/edges.
 * - Renders per-node-type presentations via NodeRenderer.
 * - Provides pan/zoom viewport controls.
 * - Provides deterministic Level-of-Detail (LOD) based on viewport zoom (Step 38).
 * - Does NOT perform data fetching or backend queries.
 * - Keeps domain logic and state persistence outside the canvas.
 */
export function GraphCanvas({
  nodes: inputNodes,
  edges: inputEdges,
  selectedNodeId,
  selectedEdgeId,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  showControls = true,
  showMiniMap = false,
  showBackground = true,
  nodeTypes = DEFAULT_NODE_TYPES,
  edgeTypes,
  onNodesChange,
  onEdgesChange,
  className,
  style,
  enableLod = true,
  initialLod = "module",
  onLodChange,
  changeMode,
  simulationMode,
}: GraphCanvasProps): React.JSX.Element {
  const [currentLod, setCurrentLod] = React.useState<LodLevel>(initialLod);

  const handleMoveEnd = React.useCallback(
    (_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
      if (!enableLod) return;
      const nextLod = getLodLevelFromZoom(viewport.zoom);
      setCurrentLod((prev) => {
        if (prev !== nextLod) {
          if (onLodChange) {
            onLodChange(nextLod);
          }
          return nextLod;
        }
        return prev;
      });
    },
    [enableLod, onLodChange],
  );

  // Compute LOD filtered nodes and edges if enableLod is active
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!enableLod) {
      return { visibleNodes: inputNodes, visibleEdges: inputEdges };
    }
    return computeLodGraph({
      nodes: inputNodes,
      edges: inputEdges,
      lod: currentLod,
      selectedNodeId,
    });
  }, [inputNodes, inputEdges, enableLod, currentLod, selectedNodeId]);

  // Compute impact slice metrics (how many impacted nodes are visible in the current slice)
  const impactSliceMetrics = useMemo(() => {
    if (!changeMode || !changeMode.enabled || changeMode.status !== "ready") {
      return null;
    }
    return computeImpactSliceMetrics(changeMode, visibleNodes);
  }, [changeMode, visibleNodes]);

  // Compute simulation slice metrics (how many simulation results are visible in the current slice)
  const simulationSliceMetrics = useMemo(() => {
    if (!simulationMode || !simulationMode.enabled || simulationMode.status !== "ready") {
      return null;
    }
    return computeSimulationSliceMetrics(simulationMode, visibleNodes);
  }, [simulationMode, visibleNodes]);

  // Map input nodes and edges deterministically to React Flow format with Simulation-Mode or Change-Mode overlay
  const { nodes, edges } = useMemo(() => {
    const mapped = mapDomainGraphToFlow(visibleNodes, visibleEdges);
    // Simulation Mode and Change Mode are mutually exclusive visual overlays.
    // Active simulation mode suspends change mode visualization.
    const isSimulationModeActive = Boolean(
      simulationMode?.enabled && simulationMode?.status === "ready",
    );
    const isChangeModeActive =
      !isSimulationModeActive && Boolean(changeMode?.enabled && changeMode?.status === "ready");

    const updatedNodes = mapped.nodes.map((n) => {
      const isSelected = n.id === selectedNodeId;

      if (isSimulationModeActive && simulationMode) {
        const simState = simulationMode.resultingStateByNodeId.get(n.id);
        const simRule = simulationMode.ruleByNodeId.get(n.id);
        const simConfidence = simulationMode.confidenceByNodeId.get(n.id);
        const simCapped = simulationMode.hasCappedByNodeId.get(n.id);

        return {
          ...n,
          data: {
            ...n.data,
            isSelected,
            changeModeActive: false,
            simulationModeActive: true,
            simulationState: simState,
            simulationRule: simRule,
            simulationConfidence: simConfidence,
            simulationCapped: simCapped,
          },
        };
      }

      if (isChangeModeActive && changeMode) {
        // Change mode is active: determine impact role and metadata
        const isDirect = changeMode.directNodeIds.has(n.id);
        const isDownstream = !isDirect && changeMode.downstreamNodeIds.has(n.id);
        const impactRole: "direct" | "downstream" | "unaffected" = isDirect
          ? "direct"
          : isDownstream
            ? "downstream"
            : "unaffected";
        const impactHopDistance = changeMode.hopDistanceByNodeId.get(n.id);
        const impactConfidence = changeMode.confidenceByNodeId.get(n.id);
        const isAffectedApi = changeMode.affectedApiNodeIds.has(n.id);
        const isAffectedEvent = changeMode.affectedEventNodeIds.has(n.id);
        const impactEvidenceIds = changeMode.evidenceIdsByNodeId.get(n.id);

        return {
          ...n,
          data: {
            ...n.data,
            isSelected,
            changeModeActive: true,
            simulationModeActive: false,
            impactRole,
            impactHopDistance,
            impactConfidence,
            isAffectedApi,
            isAffectedEvent,
            impactEvidenceIds,
          },
        };
      }

      return {
        ...n,
        data: {
          ...n.data,
          isSelected,
          changeModeActive: false,
          simulationModeActive: false,
        },
      };
    });

    const updatedEdges = mapped.edges.map((e) => {
      const isSelected = e.id === selectedEdgeId;
      if (isSelected) {
        return {
          ...e,
          selected: true,
          style: e.style
            ? { ...e.style, stroke: "#3b82f6", strokeWidth: 3, opacity: 1.0 }
            : { stroke: "#3b82f6", strokeWidth: 3, opacity: 1.0 },
        };
      }

      if (isSimulationModeActive && simulationMode) {
        const isCausalEdge = simulationMode.causalEdgeIds.has(e.id);
        if (isCausalEdge) {
          return {
            ...e,
            style: e.style
              ? { ...e.style, stroke: "#dc2626", strokeWidth: 3, opacity: 1.0 }
              : { stroke: "#dc2626", strokeWidth: 3, opacity: 1.0 },
          };
        }
        return {
          ...e,
          style: e.style ? { ...e.style, opacity: 0.35 } : { opacity: 0.35 },
        };
      }

      return e;
    });

    return { nodes: updatedNodes, edges: updatedEdges };
  }, [
    visibleNodes,
    visibleEdges,
    selectedNodeId,
    selectedEdgeId,
    changeMode,
    simulationMode,
  ]);

  const handleNodeClick = useMemo(() => {
    if (!onNodeClick) return undefined;
    return (_event: React.MouseEvent, node: FluxoraFlowNode) => {
      onNodeClick(node.id);
    };
  }, [onNodeClick]);

  const handleEdgeClick = useMemo(() => {
    if (!onEdgeClick) return undefined;
    return (_event: React.MouseEvent, edge: { id: string }) => {
      onEdgeClick(edge.id);
    };
  }, [onEdgeClick]);

  const handlePaneClick = useMemo(() => {
    if (!onPaneClick) return undefined;
    return () => {
      onPaneClick();
    };
  }, [onPaneClick]);

  return (
    <div
      data-testid="fluxora-graph-canvas"
      className={className}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "400px",
        position: "relative",
        background: "#f8fafc",
        ...style,
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        {...(edgeTypes !== undefined ? { edgeTypes } : {})}
        {...(onNodesChange !== undefined ? { onNodesChange } : {})}
        {...(onEdgesChange !== undefined ? { onEdgesChange } : {})}
        {...(handleNodeClick !== undefined ? { onNodeClick: handleNodeClick } : {})}
        {...(handleEdgeClick !== undefined ? { onEdgeClick: handleEdgeClick } : {})}
        {...(handlePaneClick !== undefined ? { onPaneClick: handlePaneClick } : {})}
        onMoveEnd={handleMoveEnd}
        fitView
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        minZoom={0.2}
        maxZoom={2.5}
      >
        {enableLod && (
          <div
            data-testid="graph-lod-badge"
            style={{
              position: "absolute",
              bottom: "12px",
              left: "12px",
              zIndex: 10,
              backgroundColor: "rgba(255, 255, 255, 0.9)",
              backdropFilter: "blur(4px)",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "4px 8px",
              fontSize: "11px",
              fontFamily: "ui-monospace, monospace",
              color: "#475569",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                backgroundColor:
                  currentLod === "detail"
                    ? "#10b981"
                    : currentLod === "module"
                      ? "#3b82f6"
                      : "#8b5cf6",
              }}
            />
            <span>
              LOD: <strong>{currentLod}</strong> ({nodes.length}/{inputNodes.length} nodes)
            </span>
            {impactSliceMetrics && impactSliceMetrics.totalImpactedNodes > 0 && (
              <span
                data-testid="impact-slice-indicator"
                style={{
                  color:
                    impactSliceMetrics.hiddenImpactedNodes > 0 ? "#b45309" : "#15803d",
                  fontWeight: 600,
                  marginLeft: "4px",
                }}
              >
                • {impactSliceMetrics.visibleImpactedNodes}/{impactSliceMetrics.totalImpactedNodes} impacted visible
              </span>
            )}
            {simulationSliceMetrics && simulationSliceMetrics.totalResultNodes > 0 && (
              <span
                data-testid="simulation-slice-indicator"
                style={{
                  color:
                    simulationSliceMetrics.hiddenResultNodes > 0 ? "#7c3aed" : "#15803d",
                  fontWeight: 600,
                  marginLeft: "4px",
                }}
              >
                • {simulationSliceMetrics.visibleResultNodes}/{simulationSliceMetrics.totalResultNodes} sim results visible
              </span>
            )}
          </div>
        )}
        {showBackground && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={16}
            size={1}
            color="#cbd5e1"
          />
        )}
        {showControls && <Controls showInteractive={false} />}
        {showMiniMap && (
          <MiniMap
            nodeStrokeWidth={3}
            zoomable
            pannable
            style={{
              backgroundColor: "#f1f5f9",
              border: "1px solid #cbd5e1",
            }}
          />
        )}
      </ReactFlow>
    </div>
  );
}
