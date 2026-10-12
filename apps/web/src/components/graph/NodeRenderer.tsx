import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FluxoraNodeData } from "./graph-mapping.ts";
import { getNodeVisualConfig } from "./node-styles.ts";

export interface NodeRendererProps extends NodeProps {
  data: FluxoraNodeData;
}

/**
 * Presentational node renderer for React Flow in Fluxora.
 *
 * Responsibilities:
 * - Renders per-node-type visual styling deterministically based on shared graph node types.
 * - Displays node category, name, canonical identifier/path, and confidence.
 * - Reflects selected/active state cleanly through styles.
 * - Does not perform any network calls, side effects, or mutations.
 */
export function NodeRenderer({ data, selected }: NodeRendererProps): React.JSX.Element {
  const { nodeType, name, path, confidence, depth, canonicalId } = data;
  const config = getNodeVisualConfig(nodeType);

  const isSelected = selected || data.isSelected;

  const children: React.ReactNode[] = [
    // Target handle for incoming edges
    React.createElement(Handle, {
      key: "target-handle",
      type: "target",
      position: Position.Top,
      style: {
        background: config.borderColor,
        width: 8,
        height: 8,
        borderRadius: "50%",
      },
    }),

    // Header: Node Type Badge & Category
    React.createElement(
      "div",
      {
        key: "header",
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "6px",
          gap: "8px",
        },
      },
      React.createElement(
        "span",
        {
          "data-testid": "node-type-badge",
          style: {
            display: "inline-block",
            fontSize: "10px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "2px 6px",
            borderRadius: "4px",
            backgroundColor: config.badgeBg,
            color: config.badgeColor,
          },
        },
        config.label,
      ),
      typeof depth === "number"
        ? React.createElement(
            "span",
            {
              key: "depth",
              "data-testid": "node-depth",
              style: {
                fontSize: "10px",
                color: "#64748b",
              },
            },
            `depth ${depth}`,
          )
        : null,
    ),

    // Node Name
    React.createElement(
      "div",
      {
        key: "name",
        "data-testid": "node-name",
        style: {
          fontWeight: 600,
          fontSize: "13px",
          lineHeight: "1.3",
          wordBreak: "break-word",
          marginBottom: path || canonicalId ? "4px" : "0px",
        },
      },
      name,
    ),

    // Secondary metadata: Path or Canonical ID
    path || canonicalId
      ? React.createElement(
          "div",
          {
            key: "path",
            "data-testid": "node-path",
            title: path ?? canonicalId,
            style: {
              fontSize: "11px",
              color: "#475569",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            },
          },
          path ?? canonicalId,
        )
      : null,

    // Footer: Confidence score indicator
    confidence < 1.0
      ? React.createElement(
          "div",
          {
            key: "confidence",
            "data-testid": "node-confidence",
            style: {
              marginTop: "6px",
              fontSize: "10px",
              color: "#64748b",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            },
          },
          React.createElement("span", null, "Confidence:"),
          React.createElement(
            "span",
            { style: { fontWeight: 600 } },
            `${Math.round(confidence * 100)}%`,
          ),
        )
      : null,

    // Source handle for outgoing edges
    React.createElement(Handle, {
      key: "source-handle",
      type: "source",
      position: Position.Bottom,
      style: {
        background: config.borderColor,
        width: 8,
        height: 8,
        borderRadius: "50%",
      },
    }),
  ];

  return React.createElement(
    "div",
    {
      "data-testid": `graph-node-${data.id}`,
      "data-nodetype": nodeType,
      "data-selected": isSelected ? "true" : "false",
      style: {
        border: `2px solid ${isSelected ? "#2563eb" : config.borderColor}`,
        backgroundColor: config.backgroundColor,
        boxShadow: isSelected
          ? "0 0 0 3px rgba(37, 99, 235, 0.3), 0 4px 6px -1px rgba(0, 0, 0, 0.1)"
          : "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
        borderRadius: "8px",
        padding: "10px 14px",
        minWidth: "180px",
        maxWidth: "280px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "#0f172a",
        cursor: "pointer",
        transition: "border-color 0.15s ease, box-shadow 0.15s ease",
      },
    },
    ...children,
  );
}
