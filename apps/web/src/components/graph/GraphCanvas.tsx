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
   * Optional callback when a node is clicked.
   */
  readonly onNodeClick?: (nodeId: string) => void;
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
  onNodeClick,
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

  // Map input nodes and edges deterministically to React Flow format
  const { nodes, edges } = useMemo(() => {
    const mapped = mapDomainGraphToFlow(visibleNodes, visibleEdges);

    if (selectedNodeId) {
      const updatedNodes = mapped.nodes.map((n) => {
        if (n.id === selectedNodeId) {
          return {
            ...n,
            data: {
              ...n.data,
              isSelected: true,
            },
          };
        }
        return n;
      });
      return { nodes: updatedNodes, edges: mapped.edges };
    }

    return mapped;
  }, [visibleNodes, visibleEdges, selectedNodeId]);

  const handleNodeClick = useMemo(() => {
    if (!onNodeClick) return undefined;
    return (_event: React.MouseEvent, node: FluxoraFlowNode) => {
      onNodeClick(node.id);
    };
  }, [onNodeClick]);

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
