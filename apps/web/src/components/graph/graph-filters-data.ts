import React from "react";
import {
  DEFAULT_MAX_TRAVERSAL_DEPTH,
  HARD_MAX_TRAVERSAL_DEPTH,
  GraphNodeTypes,
  GraphEdgeTypes,
  type GraphNodeType,
  type GraphEdgeType,
} from "@fluxora/shared-types";
import { getNodeVisualConfig } from "./node-styles.ts";

/**
 * Filter state representation for Architecture Explorer graph queries.
 * Distinguishes selected node types, edge types, min confidence, and max depth.
 */
export interface GraphFilterState {
  readonly nodeTypes: readonly GraphNodeType[];
  readonly edgeTypes: readonly GraphEdgeType[];
  readonly minConfidence: number;
  readonly maxDepth: number;
}

export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  nodeTypes: [],
  edgeTypes: [],
  minConfidence: 0,
  maxDepth: DEFAULT_MAX_TRAVERSAL_DEPTH,
};

/**
 * Clamps and sanitizes maxDepth to [1, HARD_MAX_TRAVERSAL_DEPTH].
 */
export function sanitizeMaxDepth(depth: number): number {
  if (!Number.isFinite(depth) || depth < 1) {
    return 1;
  }
  if (depth > HARD_MAX_TRAVERSAL_DEPTH) {
    return HARD_MAX_TRAVERSAL_DEPTH;
  }
  return Math.floor(depth);
}

/**
 * Clamps minConfidence to [0, 1].
 */
export function sanitizeMinConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0) {
    return 0;
  }
  if (confidence > 1) {
    return 1;
  }
  return confidence;
}

export interface GraphFiltersProps {
  /**
   * Current filter state.
   */
  readonly filters: GraphFilterState;
  /**
   * Callback fired when any filter value changes.
   */
  readonly onChange: (nextFilters: GraphFilterState) => void;
  /**
   * Callback fired when user clicks reset.
   */
  readonly onReset: () => void;
  /**
   * Optional disabled state (e.g. while fetching).
   */
  readonly disabled?: boolean;
  /**
   * Optional container CSS classes.
   */
  readonly className?: string;
}

/**
 * Pure presentational component rendering filtering controls for the Architecture Explorer.
 *
 * Responsibilities:
 * - Renders supported filter categories (Node Types, Edge Types, Minimum Confidence, Max Depth)
 * - Emits typed changes through onChange callback
 * - Emits onReset callback
 * - Never fetches data directly
 * - Never accesses the database or imports @fluxora/db
 * - Never mutates state or owns global application state
 * - Clamps maxDepth <= HARD_MAX_TRAVERSAL_DEPTH
 */
export function GraphFilters({
  filters,
  onChange,
  onReset,
  disabled = false,
  className = "",
}: GraphFiltersProps): React.JSX.Element {
  const isFiltered =
    filters.nodeTypes.length > 0 ||
    filters.edgeTypes.length > 0 ||
    filters.minConfidence > 0 ||
    filters.maxDepth !== DEFAULT_MAX_TRAVERSAL_DEPTH;

  const handleToggleNodeType = (type: GraphNodeType) => {
    const nextNodeTypes = filters.nodeTypes.includes(type)
      ? filters.nodeTypes.filter((t) => t !== type)
      : [...filters.nodeTypes, type];
    onChange({
      ...filters,
      nodeTypes: nextNodeTypes,
    });
  };

  const handleToggleEdgeType = (type: GraphEdgeType) => {
    const nextEdgeTypes = filters.edgeTypes.includes(type)
      ? filters.edgeTypes.filter((t) => t !== type)
      : [...filters.edgeTypes, type];
    onChange({
      ...filters,
      edgeTypes: nextEdgeTypes,
    });
  };

  const handleMinConfidenceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = parseFloat(e.target.value);
    const sanitized = sanitizeMinConfidence(Number.isNaN(rawVal) ? 0 : rawVal);
    onChange({
      ...filters,
      minConfidence: sanitized,
    });
  };

  const handleMaxDepthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = parseInt(e.target.value, 10);
    const sanitized = sanitizeMaxDepth(Number.isNaN(rawVal) ? DEFAULT_MAX_TRAVERSAL_DEPTH : rawVal);
    onChange({
      ...filters,
      maxDepth: sanitized,
    });
  };

  return React.createElement(
    "div",
    {
      "data-testid": "graph-filters",
      className: `bg-white border-b border-slate-200 px-4 py-3 text-xs flex flex-col gap-3 shadow-sm ${className}`,
    },
    // Header row
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2" },
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement("span", { className: "font-semibold text-slate-800 text-sm" }, "Graph Filters"),
        isFiltered
          ? React.createElement(
              "span",
              {
                "data-testid": "filters-active-badge",
                className: "px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200",
              },
              "Active Filters",
            )
          : React.createElement(
              "span",
              {
                "data-testid": "filters-all-badge",
                className: "px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500",
              },
              "Showing All",
            ),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "reset-filters-btn",
          disabled: disabled || !isFiltered,
          onClick: onReset,
          className:
            "text-xs font-medium text-slate-600 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1 rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors",
        },
        "Reset Filters",
      ),
    ),

    // Filter controls grid
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" },

      // 1. Node Types
      React.createElement(
        "fieldset",
        {
          "data-testid": "filter-node-types",
          className: "flex flex-col gap-1.5 min-w-[200px]",
        },
        React.createElement(
          "legend",
          { className: "font-semibold text-slate-700 text-xs mb-1" },
          `Node Types ${filters.nodeTypes.length > 0 ? `(${filters.nodeTypes.length})` : "(All)"}`,
        ),
        React.createElement(
          "div",
          { className: "flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-1 border border-slate-100 rounded bg-slate-50/50" },
          ...GraphNodeTypes.map((type) => {
            const selected = filters.nodeTypes.includes(type);
            const config = getNodeVisualConfig(type);
            return React.createElement(
              "button",
              {
                type: "button",
                key: type,
                "data-testid": `filter-node-type-${type}`,
                disabled,
                onClick: () => handleToggleNodeType(type),
                className: `px-2 py-0.5 rounded text-[11px] font-medium transition-colors border ${
                  selected
                    ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                    : "bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                }`,
                "aria-pressed": selected,
                title: `Toggle ${config.label} node filter`,
              },
              config.label,
            );
          }),
        ),
      ),

      // 2. Edge Types
      React.createElement(
        "fieldset",
        {
          "data-testid": "filter-edge-types",
          className: "flex flex-col gap-1.5 min-w-[220px]",
        },
        React.createElement(
          "legend",
          { className: "font-semibold text-slate-700 text-xs mb-1" },
          `Edge Types ${filters.edgeTypes.length > 0 ? `(${filters.edgeTypes.length})` : "(All)"}`,
        ),
        React.createElement(
          "div",
          { className: "flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-1 border border-slate-100 rounded bg-slate-50/50" },
          ...GraphEdgeTypes.map((type) => {
            const selected = filters.edgeTypes.includes(type);
            return React.createElement(
              "button",
              {
                type: "button",
                key: type,
                "data-testid": `filter-edge-type-${type}`,
                disabled,
                onClick: () => handleToggleEdgeType(type),
                className: `px-2 py-0.5 rounded text-[11px] font-mono transition-colors border ${
                  selected
                    ? "bg-slate-800 text-white border-slate-800 shadow-xs"
                    : "bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                }`,
                "aria-pressed": selected,
                title: `Toggle ${type} edge filter`,
              },
              type,
            );
          }),
        ),
      ),

      // 3. Minimum Confidence
      React.createElement(
        "div",
        {
          "data-testid": "filter-min-confidence",
          className: "flex flex-col gap-1.5",
        },
        React.createElement(
          "div",
          { className: "flex justify-between items-center" },
          React.createElement(
            "label",
            { htmlFor: "min-confidence-slider", className: "font-semibold text-slate-700 text-xs" },
            "Min Confidence",
          ),
          React.createElement(
            "span",
            {
              "data-testid": "min-confidence-value",
              className: "font-mono text-[11px] text-slate-600 font-medium",
            },
            `${Math.round(filters.minConfidence * 100)}%`,
          ),
        ),
        React.createElement("input", {
          id: "min-confidence-slider",
          type: "range",
          min: "0",
          max: "1",
          step: "0.05",
          value: filters.minConfidence,
          disabled,
          onChange: handleMinConfidenceChange,
          className: "w-full accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer",
        }),
        React.createElement(
          "div",
          { className: "flex justify-between text-[10px] text-slate-400 font-mono" },
          React.createElement("span", null, "0%"),
          React.createElement("span", null, "50%"),
          React.createElement("span", null, "100%"),
        ),
      ),

      // 4. Max Depth
      React.createElement(
        "div",
        {
          "data-testid": "filter-max-depth",
          className: "flex flex-col gap-1.5",
        },
        React.createElement(
          "div",
          { className: "flex justify-between items-center" },
          React.createElement(
            "label",
            { htmlFor: "max-depth-input", className: "font-semibold text-slate-700 text-xs" },
            `Max Depth (1–${HARD_MAX_TRAVERSAL_DEPTH})`,
          ),
          React.createElement(
            "span",
            {
              "data-testid": "max-depth-value",
              className: "font-mono text-[11px] text-slate-600 font-medium",
            },
            `depth: ${filters.maxDepth}`,
          ),
        ),
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement("input", {
            id: "max-depth-slider",
            type: "range",
            min: "1",
            max: HARD_MAX_TRAVERSAL_DEPTH,
            step: "1",
            value: filters.maxDepth,
            disabled,
            onChange: handleMaxDepthChange,
            className: "w-full accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer",
          }),
          React.createElement("input", {
            id: "max-depth-input",
            "data-testid": "max-depth-number-input",
            type: "number",
            min: "1",
            max: HARD_MAX_TRAVERSAL_DEPTH,
            value: filters.maxDepth,
            disabled,
            onChange: handleMaxDepthChange,
            className: "w-14 px-1.5 py-1 text-center font-mono text-xs border border-slate-200 rounded bg-white text-slate-800",
          }),
        ),
        React.createElement(
          "div",
          { className: "flex justify-between text-[10px] text-slate-400 font-mono" },
          React.createElement("span", null, "1"),
          React.createElement("span", null, `default: ${DEFAULT_MAX_TRAVERSAL_DEPTH}`),
          React.createElement("span", null, `max: ${HARD_MAX_TRAVERSAL_DEPTH}`),
        ),
      ),
    ),
  );
}

