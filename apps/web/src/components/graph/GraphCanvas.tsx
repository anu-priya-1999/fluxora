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
}

/**
 * GraphCanvas component for Fluxora (Step 34).
 *
 * Responsibilities:
 * - Client-side wrapper around React Flow.
 * - Accepts typed graph nodes/edges as props.
 * - Deterministically maps domain graph models to React Flow nodes/edges.
 * - Renders per-node-type presentations via NodeRenderer.
 * - Provides pan/zoom viewport controls.
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
}: GraphCanvasProps): React.JSX.Element {
  // Map input nodes and edges deterministically to React Flow format
  const { nodes, edges } = useMemo(() => {
    const mapped = mapDomainGraphToFlow(inputNodes, inputEdges);

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
  }, [inputNodes, inputEdges, selectedNodeId]);

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
        fitView
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        minZoom={0.2}
        maxZoom={2.5}
      >
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
