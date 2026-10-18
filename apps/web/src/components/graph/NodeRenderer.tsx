import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FluxoraNodeData } from "./graph-mapping.ts";
import { computeNodeVisualStyles, getNodeVisualConfig } from "./node-styles.ts";

export interface NodeRendererProps extends NodeProps {
  data: FluxoraNodeData;
}

/**
 * Presentational node renderer for React Flow in Fluxora (Step 34 & Step 46).
 *
 * Responsibilities:
 * - Renders per-node-type visual styling deterministically based on shared graph node types.
 * - Supports Change-Mode overlay (Step 46):
 *   - Direct changes: prominent red border & ring with "Direct Change" badge.
 *   - Downstream impacts: chromatic amber hierarchy by hop distance with "Downstream" badge.
 *   - Low-confidence findings: dashed borders and explicit confidence display.
 *   - Affected APIs and Events: distinct semantic badges.
 *   - Unaffected nodes: de-emphasized with reduced opacity while remaining fully interactive.
 *   - Selected node styling takes absolute priority over change-mode overlay.
 * - Does not perform any network calls, side effects, or mutations.
 */
export function NodeRenderer({ data, selected }: NodeRendererProps): React.JSX.Element {
  const {
    nodeType,
    name,
    path,
    confidence,
    depth,
    canonicalId,
    changeModeActive,
    impactRole,
    impactHopDistance,
    impactConfidence,
    isAffectedApi,
    isAffectedEvent,
  } = data;

  const config = getNodeVisualConfig(nodeType);
  const isSelected = selected || data.isSelected;

  const computedStyles = computeNodeVisualStyles({
    nodeType,
    isSelected: Boolean(isSelected),
    changeModeActive,
    impactRole,
    impactHopDistance,
    impactConfidence,
  });

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

    // Header: Node Type Badge & Category & Change-Mode Badges
    React.createElement(
      "div",
      {
        key: "header",
        style: {
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "6px",
          gap: "6px",
        },
      },
      React.createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "4px",
            flexWrap: "wrap",
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
        // Step 46: Change-Mode Badges
        changeModeActive && impactRole === "direct"
          ? React.createElement(
              "span",
              {
                key: "impact-direct",
                "data-testid": "impact-direct-badge",
                style: {
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 5px",
                  borderRadius: "4px",
                  backgroundColor: "#fee2e2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                },
              },
              "Direct Change",
            )
          : null,
        changeModeActive && impactRole === "downstream"
          ? React.createElement(
              "span",
              {
                key: "impact-downstream",
                "data-testid": "impact-downstream-badge",
                style: {
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 5px",
                  borderRadius: "4px",
                  backgroundColor: "#fef3c7",
                  color: "#b45309",
                  border: "1px solid #fde68a",
                },
              },
              impactHopDistance !== undefined
                ? `Downstream (hop ${impactHopDistance})`
                : "Downstream",
            )
          : null,
        changeModeActive && isAffectedApi
          ? React.createElement(
              "span",
              {
                key: "impact-api",
                "data-testid": "impact-api-badge",
                style: {
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 5px",
                  borderRadius: "4px",
                  backgroundColor: "#d1fae5",
                  color: "#047857",
                  border: "1px solid #a7f3d0",
                },
              },
              "API",
            )
          : null,
        changeModeActive && isAffectedEvent
          ? React.createElement(
              "span",
              {
                key: "impact-event",
                "data-testid": "impact-event-badge",
                style: {
                  fontSize: "9px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 5px",
                  borderRadius: "4px",
                  backgroundColor: "#ede9fe",
                  color: "#6d28d9",
                  border: "1px solid #ddd6fe",
                },
              },
              "Event",
            )
          : null,
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

    // Footer: Base Graph Confidence score indicator
    confidence < 1.0 && !changeModeActive
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

    // Step 46: Impact Confidence indicator
    changeModeActive && impactConfidence !== undefined
      ? React.createElement(
          "div",
          {
            key: "impact-confidence",
            "data-testid": "node-impact-confidence",
            style: {
              marginTop: "6px",
              fontSize: "10px",
              color: impactConfidence < 0.7 ? "#b45309" : "#64748b",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            },
          },
          React.createElement("span", null, "Impact Conf:"),
          React.createElement(
            "span",
            { style: { fontWeight: 600 } },
            `${Math.round(impactConfidence * 100)}%`,
          ),
          impactConfidence < 0.7
            ? React.createElement(
                "span",
                {
                  key: "low-badge",
                  "data-testid": "impact-low-confidence",
                  style: {
                    fontSize: "9px",
                    fontWeight: 600,
                    color: "#b45309",
                    backgroundColor: "#fef3c7",
                    padding: "1px 4px",
                    borderRadius: "3px",
                  },
                },
                "low",
              )
            : null,
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
      "data-change-mode": changeModeActive ? "true" : "false",
      "data-impact-role": impactRole ?? "none",
      style: {
        border: computedStyles.border,
        backgroundColor: computedStyles.backgroundColor,
        boxShadow: computedStyles.boxShadow,
        opacity: computedStyles.opacity,
        ...(computedStyles.filter ? { filter: computedStyles.filter } : {}),
        borderRadius: "8px",
        padding: "10px 14px",
        minWidth: "180px",
        maxWidth: "280px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "#0f172a",
        cursor: "pointer",
        transition:
          "border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease",
      },
    },
    ...children,
  );
}
