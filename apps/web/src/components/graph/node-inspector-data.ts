import React from "react";
import type {
  GraphQueryResponseEdge,
  GraphQueryResponseEvidence,
  GraphQueryResponseNode,
} from "@fluxora/shared-types";
import { getNodeVisualConfig } from "./node-styles.ts";
import type { NormalizedChangeModeState } from "./change-mode-data.ts";
import { buildSourcePermalink } from "./evidence-citation-data.ts";
import { EvidenceCitation } from "./EvidenceCitation.tsx";
import { normalizeConfidence } from "./confidence-data.ts";

export interface EvidenceTrailProps {
  /**
   * The evidence records from the GraphQueryResponse.
   */
  readonly evidence?: readonly GraphQueryResponseEvidence[] | undefined;
  /**
   * The currently selected node ID. When provided, filters evidence strictly to this node.
   */
  readonly selectedNodeId?: string | null | undefined;
  /**
   * Optional repository name (owner/repo) for constructing source permalinks.
   */
  readonly repositoryName?: string | null | undefined;
  /**
   * Optional commit SHA for constructing source permalinks.
   */
  readonly commitSha?: string | null | undefined;
  /**
   * Optional branch/ref for constructing source permalinks.
   */
  readonly gitRef?: string | null | undefined;
  readonly ref?: string | null | undefined;
  /**
   * Optional analysis run ID.
   */
  readonly analysisRunId?: string | null | undefined;
  /**
   * Optional custom container CSS classes.
   */
  readonly className?: string;
}

export interface NodeInspectorPanelProps {
  /**
   * Currently selected graph node. When null or undefined, checks edge or renders empty state.
   */
  readonly node?: GraphQueryResponseNode | null | undefined;
  /**
   * Currently selected graph edge. When node is null and edge is provided, renders edge inspection.
   */
  readonly edge?: GraphQueryResponseEdge | null | undefined;
  /**
   * Graph evidence records from the existing GraphQueryResponse.
   */
  readonly evidence?: readonly GraphQueryResponseEvidence[] | undefined;
  /**
   * Optional repository name (owner/repo) for constructing source permalinks.
   */
  readonly repositoryName?: string | null | undefined;
  /**
   * Optional commit SHA for constructing source permalinks.
   */
  readonly commitSha?: string | null | undefined;
  /**
   * Optional branch/ref for constructing source permalinks.
   */
  readonly gitRef?: string | null | undefined;
  readonly ref?: string | null | undefined;
  /**
   * Optional analysis run ID.
   */
  readonly analysisRunId?: string | null | undefined;
  /**
   * Optional callback when the user clears or closes the selection.
   */
  readonly onClose?: () => void;
  /**
   * Optional container CSS classes.
   */
  readonly className?: string;
  /**
   * Optional active Change-Mode state (Step 46).
   */
  readonly changeMode?: NormalizedChangeModeState | null | undefined;
}

/**
 * Formats line and column coordinates into a readable string safely.
 * Handles partial or missing coordinate fields without crashing.
 */
export function formatCoordinates(
  evidence: Pick<
    GraphQueryResponseEvidence,
    "line_start" | "line_end" | "column_start" | "column_end"
  >,
): string | null {
  const { line_start, line_end, column_start, column_end } = evidence;
  const hasLine = typeof line_start === "number";
  const hasCol = typeof column_start === "number";

  if (!hasLine && !hasCol) {
    return null;
  }

  let linePart = "";
  if (hasLine) {
    if (typeof line_end === "number" && line_end !== line_start) {
      linePart = `Lines ${line_start}–${line_end}`;
    } else {
      linePart = `Line ${line_start}`;
    }
  }

  let colPart = "";
  if (hasCol) {
    if (typeof column_end === "number" && column_end !== column_start) {
      colPart = `Col ${column_start}–${column_end}`;
    } else {
      colPart = `Col ${column_start}`;
    }
  }

  if (linePart && colPart) {
    return `${linePart}, ${colPart}`;
  }
  return linePart || colPart;
}

/**
 * Filters and sorts evidence for a given node deterministically.
 *
 * Rules:
 * 1. Only accepts evidence where subject_type === "graph_node" AND subject_id === nodeId.
 * 2. Never includes edge evidence (subject_type === "graph_edge") or evidence for other nodes.
 * 3. Sorts deterministically by:
 *    a. file_path (lexicographical)
 *    b. line_start (numerical ascending)
 *    c. line_end (numerical ascending)
 *    d. id (lexicographical)
 */
export function filterAndSortNodeEvidence(
  evidenceList: readonly GraphQueryResponseEvidence[] | undefined,
  nodeId: string | null | undefined,
): GraphQueryResponseEvidence[] {
  if (!evidenceList || !Array.isArray(evidenceList) || evidenceList.length === 0 || !nodeId) {
    return [];
  }

  const filtered = evidenceList.filter(
    (e) => e.subject_type === "graph_node" && e.subject_id === nodeId,
  );

  return filtered.slice().sort((a, b) => {
    // 1. file_path
    const pathA = a.file_path ?? "";
    const pathB = b.file_path ?? "";
    const pathCmp = pathA.localeCompare(pathB);
    if (pathCmp !== 0) return pathCmp;

    // 2. line_start
    const startA = a.line_start ?? -1;
    const startB = b.line_start ?? -1;
    if (startA !== startB) return startA - startB;

    // 3. line_end
    const endA = a.line_end ?? -1;
    const endB = b.line_end ?? -1;
    if (endA !== endB) return endA - endB;

    // 4. id
    const idA = a.id ?? "";
    const idB = b.id ?? "";
    return idA.localeCompare(idB);
  });
}

/**
 * Safely stringifies a metadata value without dumping unbounded payloads.
 */
export function safeFormatMetadataValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 200) {
      return serialized.slice(0, 197) + "...";
    }
    return serialized;
  } catch {
    return "[Unserializable object]";
  }
}

/**
 * Resolves the selected node object from a list of nodes and a selected node ID.
 */
export function resolveSelectedNode(
  nodes: readonly GraphQueryResponseNode[] | undefined,
  selectedNodeId: string | null | undefined,
): GraphQueryResponseNode | null {
  if (!nodes || !selectedNodeId) {
    return null;
  }
  return nodes.find((n) => n.id === selectedNodeId) ?? null;
}

/**
 * EvidenceTrail component for Step 36.
 *
 * Responsibilities:
 * - Displays source code provenance linking the selected graph node to exact source files.
 * - Explicitly associates evidence by subject_type === "graph_node" and subject_id === selectedNodeId.
 * - Deterministically sorts evidence by file_path, line_start, line_end, id.
 * - Renders relationship descriptions, file paths, coordinates, symbol identifiers, confidence, and metadata.
 * - Safely handles missing, empty, or partial data without crashing.
 * - Does not perform any network calls or database access.
 */
export function EvidenceTrail({
  evidence,
  selectedNodeId,
  repositoryName,
  commitSha,
  gitRef,
  ref: inputRef,
  analysisRunId,
  className,
}: EvidenceTrailProps): React.JSX.Element {
  const effectiveRef = gitRef ?? inputRef;
  const nodeEvidence = filterAndSortNodeEvidence(evidence, selectedNodeId);

  if (nodeEvidence.length === 0) {
    return React.createElement(
      "div",
      {
        "data-testid": "evidence-empty-state",
        className:
          "p-4 text-center text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md",
      },
      "No evidence records found for this node.",
    );
  }

  const items = nodeEvidence.map((ev) => {
    const coords = formatCoordinates(ev);
    const confidencePct = `${Math.round((ev.confidence ?? 1.0) * 100)}%`;
    const permalink = buildSourcePermalink({
      repositoryName,
      commitSha,
      gitRef: effectiveRef,
      filePath: ev.file_path,
      lineStart: ev.line_start,
      lineEnd: ev.line_end,
    });

    const children: React.ReactNode[] = [
      // Header: Relationship description & Confidence score
      React.createElement(
        "div",
        {
          key: "header",
          className: "flex items-start justify-between gap-2",
        },
        React.createElement(
          "span",
          {
            "data-testid": "evidence-relationship",
            className: "font-semibold text-slate-900 break-words leading-tight",
          },
          ev.relationship_description,
        ),
        React.createElement(
          "span",
          {
            "data-testid": "evidence-confidence",
            className:
              "inline-block text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0",
          },
          confidencePct,
        ),
      ),

      // File path
      React.createElement(
        "div",
        {
          key: "file-path",
          "data-testid": "evidence-file-path",
          className:
            "font-mono text-[11px] text-slate-700 break-all bg-slate-50 px-2 py-1 rounded border border-slate-100",
        },
        ev.file_path,
      ),

      // Coordinates if present
      coords !== null
        ? React.createElement(
            "div",
            {
              key: "coordinates",
              "data-testid": "evidence-coordinates",
              className: "font-mono text-[11px] text-slate-500",
            },
            coords,
          )
        : null,

      // Symbol ID if present
      ev.symbol_id
        ? React.createElement(
            "div",
            {
              key: "symbol",
              "data-testid": "evidence-symbol",
              className:
                "font-mono text-[11px] text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 break-all self-start",
            },
            ev.symbol_id,
          )
        : null,

      // Metadata if present and non-empty
      ev.metadata && Object.keys(ev.metadata).length > 0
        ? React.createElement(
            "div",
            {
              key: "metadata",
              "data-testid": "evidence-metadata",
              className: "mt-1 pt-1 border-t border-slate-100 text-[11px] text-slate-600 space-y-0.5",
            },
            ...Object.entries(ev.metadata).map(([key, val]) =>
              React.createElement(
                "div",
                { key, className: "break-all" },
                React.createElement("span", { className: "font-medium text-slate-700" }, `${key}: `),
                React.createElement("span", { className: "font-mono" }, safeFormatMetadataValue(val)),
              ),
            ),
          )
        : null,

      // Step 49: Source citation navigation action & provenance link
      React.createElement(
        "div",
        {
          key: "citation-action",
          className: "mt-1 pt-1.5 border-t border-slate-100 flex items-center justify-between text-[11px]",
        },
        permalink.available && permalink.url
          ? React.createElement(
              "a",
              {
                "data-testid": "citation-source-link",
                href: permalink.url,
                target: "_blank",
                rel: "noopener noreferrer",
                className:
                  "inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-800 hover:underline focus:outline-none focus:ring-1 focus:ring-blue-500 rounded",
                "aria-label": `Open ${ev.file_path} in source repository (opens in new tab)`,
              },
              React.createElement("span", { className: "text-xs select-none" }, "↗"),
              "Open in source",
            )
          : React.createElement(
              "span",
              {
                "data-testid": "citation-source-unavailable",
                title: permalink.reason ?? "Source repository or commit not configured",
                className: "text-slate-400 italic flex items-center gap-1 cursor-help",
              },
              "Source link unavailable",
            ),
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          analysisRunId
            ? React.createElement(
                "span",
                { className: "text-[10px] text-slate-400 font-mono" },
                `run: ${analysisRunId}`,
              )
            : null,
          React.createElement(
            "span",
            { className: "text-[10px] text-slate-400 font-mono" },
            ev.id,
          ),
        ),
      ),
    ];

    return React.createElement(
      "div",
      {
        key: ev.id,
        "data-testid": `evidence-item-${ev.id}`,
        className:
          "p-3 border border-slate-200 rounded-lg bg-white shadow-sm flex flex-col gap-1.5 text-xs",
      },
      ...children,
    );
  });

  return React.createElement(
    "div",
    {
      "data-testid": "evidence-trail",
      className: `flex flex-col gap-2.5 ${className ?? ""}`,
    },
    ...items,
  );
}

/**
 * NodeInspectorPanel component for Step 36.
 *
 * Responsibilities:
 * - Displays the attributes, properties, and metadata of the selected node.
 * - Embeds the EvidenceTrail for verified source code provenance.
 * - Displays a clear empty state when no node is selected.
 * - Provides a clear/close action to deselect the active node.
 * - Does not perform any network calls, side effects, or database access.
 */
export function NodeInspectorPanel({
  node,
  edge,
  evidence,
  repositoryName,
  commitSha,
  gitRef,
  ref: inputRef,
  analysisRunId,
  onClose,
  className,
  changeMode,
}: NodeInspectorPanelProps): React.JSX.Element {
  const effectiveRef = gitRef ?? inputRef;

  // If an edge is selected (and no node is selected), render Edge Inspector
  if (!node && edge) {
    const normalizedEdgeConf = normalizeConfidence(edge.confidence);
    const edgeConfidencePct = normalizedEdgeConf ? normalizedEdgeConf.formattedPercentage : `${Math.round(edge.confidence * 100)}%`;
    const edgeEvidence = edge.evidence_id
      ? evidence?.find((e) => e.id === edge.evidence_id)
      : undefined;

    return React.createElement(
      "div",
      {
        "data-testid": "node-inspector-panel",
        className: `flex flex-col h-full overflow-y-auto bg-white border-l border-slate-200 divide-y divide-slate-100 ${className ?? ""}`,
      },
      // Header: Edge Type & Close Action
      React.createElement(
        "header",
        {
          className: "p-4 flex flex-col gap-2 bg-slate-50/50",
        },
        React.createElement(
          "div",
          { className: "flex items-center justify-between gap-2" },
          React.createElement(
            "div",
            { className: "flex items-center gap-1.5" },
            React.createElement(
              "span",
              {
                "data-testid": "inspector-edge-type",
                className:
                  "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded inline-block bg-indigo-100 text-indigo-800 border border-indigo-200 font-mono",
              },
              edge.type,
            ),
            React.createElement(
              "span",
              {
                "data-testid": "inspector-edge-coverage-status",
                "data-coverage-status": edge.evidence_id ? "covered" : "uncovered",
                className: `text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                  edge.evidence_id
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : "bg-rose-50 text-rose-800 border-rose-200"
                }`,
                "aria-label": edge.evidence_id
                  ? "Evidence Status: Covered"
                  : "Evidence Status: Missing Evidence (Uncovered)",
              },
              edge.evidence_id ? "Covered" : "Missing Evidence",
            ),
          ),
          onClose !== undefined
            ? React.createElement(
                "button",
                {
                  type: "button",
                  "data-testid": "clear-selection-button",
                  onClick: onClose,
                  className:
                    "text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded px-1.5 py-0.5 text-xs transition-colors",
                  title: "Clear selection",
                },
                "Clear",
              )
            : null,
        ),
        React.createElement(
          "h2",
          {
            "data-testid": "inspector-edge-name",
            className: "text-sm font-bold text-slate-900 break-words font-mono leading-snug",
          },
          `${edge.source} → ${edge.target}`,
        ),
      ),
      // Edge Properties
      React.createElement(
        "section",
        {
          "data-testid": "inspector-edge-details",
          className: "p-4 flex flex-col gap-3 text-xs",
        },
        React.createElement(
          "h3",
          { className: "text-xs font-semibold text-slate-500 uppercase tracking-wider" },
          "Edge Properties",
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Edge ID"),
          React.createElement(
            "span",
            {
              "data-testid": "inspector-edge-id",
              className: "font-mono text-slate-800 break-all bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100",
            },
            edge.id,
          ),
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Source Node"),
          React.createElement(
            "span",
            {
              "data-testid": "inspector-edge-source",
              className: "font-mono text-slate-800 break-all bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100",
            },
            edge.source,
          ),
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Target Node"),
          React.createElement(
            "span",
            {
              "data-testid": "inspector-edge-target",
              className: "font-mono text-slate-800 break-all bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100",
            },
            edge.target,
          ),
        ),
        React.createElement(
          "div",
          { className: "grid grid-cols-2 gap-2 pt-1" },
          React.createElement(
            "div",
            { className: "flex flex-col gap-0.5" },
            React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Confidence"),
            React.createElement(
              "div",
              { className: "flex items-center gap-1.5" },
              React.createElement(
                "span",
                {
                  "data-testid": "inspector-edge-confidence",
                  "data-confidence-tier": normalizedEdgeConf?.tier,
                  "aria-label": normalizedEdgeConf ? normalizedEdgeConf.accessibleLabel : `Confidence: ${edgeConfidencePct}`,
                  className: "font-semibold text-slate-800",
                },
                edgeConfidencePct,
              ),
              normalizedEdgeConf
                ? React.createElement(
                    "span",
                    {
                      className: `text-[10px] font-mono font-medium px-1.5 py-0.2 rounded border ${
                        normalizedEdgeConf.tier === "high"
                          ? "bg-slate-100 text-slate-700 border-slate-200"
                          : normalizedEdgeConf.tier === "medium"
                            ? "bg-amber-50 text-amber-800 border-amber-200"
                            : "bg-amber-100/80 text-amber-900 border-amber-300 border-dashed"
                      }`,
                    },
                    normalizedEdgeConf.tier,
                  )
                : null,
            ),
          ),
          React.createElement(
            "div",
            { className: "flex flex-col gap-0.5" },
            React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Provenance"),
            React.createElement(
              "span",
              {
                "data-testid": "inspector-edge-provenance",
                className: "font-mono text-[11px] text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded",
              },
              edge.provenance,
            ),
          ),
        ),
      ),
      // Edge Evidence Provenance
      React.createElement(
        "section",
        {
          "data-testid": "inspector-edge-evidence-section",
          className: "p-4 flex flex-col gap-2.5 text-xs flex-1",
        },
        React.createElement(
          "h3",
          { className: "text-xs font-semibold text-slate-500 uppercase tracking-wider" },
          "Edge Evidence Provenance",
        ),
        edge.evidence_id
          ? React.createElement(EvidenceCitation, {
              evidence: edgeEvidence,
              evidenceId: edge.evidence_id,
              confidence: edge.confidence,
              mode: "expanded",
              repositoryName,
              commitSha: commitSha ?? changeMode?.headCommit,
              gitRef: effectiveRef ?? changeMode?.headCommit,
              analysisRunId,
            })
          : React.createElement(
              "div",
              {
                "data-testid": "edge-evidence-empty",
                className: "p-3 text-center text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md",
              },
              "No evidence record linked to this edge.",
            ),
      ),
    );
  }

  // Empty State: No node is currently selected
  if (!node) {
    return React.createElement(
      "div",
      {
        "data-testid": "inspector-empty-state",
        className: `flex flex-col items-center justify-center h-full p-6 text-center text-slate-500 bg-slate-50 ${className ?? ""}`,
      },
      React.createElement(
        "div",
        {
          className:
            "w-10 h-10 mb-3 rounded-full bg-slate-200 flex items-center justify-center text-slate-400 font-bold text-lg select-none",
        },
        "i",
      ),
      React.createElement(
        "h3",
        { className: "text-sm font-semibold text-slate-700 mb-1" },
        "No Node Selected",
      ),
      React.createElement(
        "p",
        { className: "text-xs text-slate-500 max-w-xs leading-relaxed" },
        "Select a node in the graph canvas to inspect its architecture properties and evidence trail.",
      ),
    );
  }

  const visualConfig = getNodeVisualConfig(node.type);
  const confidencePercent = `${Math.round(node.confidence * 100)}%`;

  const metadataEntries =
    node.metadata && typeof node.metadata === "object"
      ? Object.entries(node.metadata)
      : [];

  const isChangeModeReady = Boolean(
    changeMode && changeMode.enabled && changeMode.status === "ready",
  );
  const isDirect = Boolean(isChangeModeReady && changeMode?.directNodeIds.has(node.id));
  const isDownstream = Boolean(
    isChangeModeReady && !isDirect && changeMode?.downstreamNodeIds.has(node.id),
  );
  const isImpacted = isDirect || isDownstream;
  const impactHop = isChangeModeReady
    ? changeMode?.hopDistanceByNodeId.get(node.id) ?? (isDirect ? 0 : 1)
    : undefined;
  const impactConf = isChangeModeReady
    ? changeMode?.confidenceByNodeId.get(node.id)
    : undefined;
  const isApi = Boolean(isChangeModeReady && changeMode?.affectedApiNodeIds.has(node.id));
  const isEvent = Boolean(isChangeModeReady && changeMode?.affectedEventNodeIds.has(node.id));
  const impactEvidenceIds = isChangeModeReady
    ? changeMode?.evidenceIdsByNodeId.get(node.id) ?? []
    : [];

  return React.createElement(
    "div",
    {
      "data-testid": "node-inspector-panel",
      className: `flex flex-col h-full overflow-y-auto bg-white border-l border-slate-200 divide-y divide-slate-100 ${className ?? ""}`,
    },

    // 1. Header: Node Type Badge, Name, and Close Action
    React.createElement(
      "header",
      {
        className: "p-4 flex flex-col gap-2 bg-slate-50/50",
      },
      React.createElement(
        "div",
        { className: "flex items-center justify-between gap-2" },
        React.createElement(
          "span",
          {
            "data-testid": "inspector-node-type",
            style: {
              backgroundColor: visualConfig.badgeBg,
              color: visualConfig.badgeColor,
            },
            className:
              "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded inline-block",
          },
          visualConfig.label,
        ),
        onClose !== undefined
          ? React.createElement(
              "button",
              {
                type: "button",
                "data-testid": "clear-selection-button",
                onClick: onClose,
                className:
                  "text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded px-1.5 py-0.5 text-xs transition-colors",
                title: "Clear node selection",
              },
              "Clear",
            )
          : null,
      ),
      React.createElement(
        "h2",
        {
          "data-testid": "inspector-node-name",
          className: "text-base font-bold text-slate-900 break-words leading-snug",
        },
        node.name,
      ),
    ),

    // Step 46: PR Impact Analysis Section (rendered when change mode is ready)
    isChangeModeReady
      ? React.createElement(
          "section",
          {
            key: "change-mode-impact",
            "data-testid": "inspector-impact-section",
            className:
              "p-4 flex flex-col gap-2.5 text-xs bg-slate-50/70 border-b border-slate-100",
          },
          React.createElement(
            "div",
            { className: "flex items-center justify-between gap-2" },
            React.createElement(
              "h3",
              { className: "text-xs font-semibold text-slate-700 uppercase tracking-wider" },
              "PR Impact Analysis",
            ),
            isImpacted
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "inspector-impact-role-badge",
                    className: `text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                      isDirect
                        ? "bg-red-100 text-red-700 border border-red-200"
                        : "bg-amber-100 text-amber-800 border border-amber-200"
                    }`,
                  },
                  isDirect ? "Direct Change" : `Downstream (hop ${impactHop ?? 1})`,
                )
              : React.createElement(
                  "span",
                  {
                    "data-testid": "inspector-impact-unaffected-badge",
                    className:
                      "text-[10px] font-medium text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded",
                  },
                  "Unaffected",
                ),
          ),
          isImpacted
            ? React.createElement(
                "div",
                {
                  className:
                    "flex flex-col gap-2 bg-white rounded-md p-2.5 border border-slate-200/60",
                },
                React.createElement(
                  "div",
                  { className: "grid grid-cols-2 gap-2" },
                  React.createElement(
                    "div",
                    { className: "flex flex-col gap-0.5" },
                    React.createElement(
                      "span",
                      { className: "text-slate-500 text-[11px]" },
                      "Hop Distance",
                    ),
                    React.createElement(
                      "span",
                      {
                        "data-testid": "inspector-impact-hop",
                        className: "font-semibold text-slate-800",
                      },
                      String(impactHop ?? 0),
                    ),
                  ),
                  (() => {
                    const normalizedImpactConf = normalizeConfidence(impactConf);
                    return React.createElement(
                      "div",
                      { className: "flex flex-col gap-0.5" },
                      React.createElement(
                        "span",
                        { className: "text-slate-500 text-[11px]" },
                        "Impact Confidence",
                      ),
                      React.createElement(
                        "div",
                        { className: "flex items-center gap-1.5" },
                        React.createElement(
                          "span",
                          {
                            "data-testid": "inspector-impact-confidence",
                            "data-confidence-tier": normalizedImpactConf?.tier,
                            "aria-label": normalizedImpactConf?.accessibleLabel ?? undefined,
                            className: `font-semibold ${
                              normalizedImpactConf?.tier === "low"
                                ? "text-amber-600"
                                : "text-slate-800"
                            }`,
                          },
                          normalizedImpactConf
                            ? normalizedImpactConf.formattedPercentage
                            : "—",
                        ),
                        normalizedImpactConf
                          ? React.createElement(
                              "span",
                              {
                                className: `text-[10px] font-mono px-1.5 py-0.2 rounded border ${
                                  normalizedImpactConf.tier === "high"
                                    ? "bg-slate-100 text-slate-700 border-slate-200"
                                    : normalizedImpactConf.tier === "medium"
                                      ? "bg-amber-50 text-amber-800 border-amber-200"
                                      : "bg-amber-100/80 text-amber-900 border-amber-300 border-dashed"
                                }`,
                              },
                              normalizedImpactConf.tier,
                            )
                          : null,
                      ),
                    );
                  })(),
                ),
                isApi || isEvent
                  ? React.createElement(
                      "div",
                      {
                        className:
                          "flex flex-wrap gap-1.5 pt-1.5 border-t border-slate-100",
                      },
                      isApi
                        ? React.createElement(
                            "span",
                            {
                              key: "api-tag",
                              "data-testid": "inspector-affected-api-badge",
                              className:
                                "text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200",
                            },
                            "Affected API Route",
                          )
                        : null,
                      isEvent
                        ? React.createElement(
                            "span",
                            {
                              key: "event-tag",
                              "data-testid": "inspector-affected-event-badge",
                              className:
                                "text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200",
                            },
                            "Affected Event",
                          )
                        : null,
                    )
                  : null,
                impactEvidenceIds.length > 0
                  ? React.createElement(
                      "div",
                      {
                        className: "flex flex-col gap-1.5 pt-1.5 border-t border-slate-100",
                      },
                      React.createElement(
                        "span",
                        { className: "text-slate-500 text-[11px] font-semibold" },
                        "Impact Finding Evidence",
                      ),
                      React.createElement(
                        "div",
                        {
                          "data-testid": "inspector-impact-evidence-list",
                          className: "flex flex-col gap-1.5",
                        },
                        ...impactEvidenceIds.map((evId) => {
                          const ev =
                            changeMode?.evidenceById?.get(evId) ??
                            evidence?.find((e) => e.id === evId);
                          return React.createElement(
                            "div",
                            {
                              key: evId,
                              "data-testid": `inspector-evidence-id-${evId}`,
                            },
                            React.createElement(EvidenceCitation, {
                              evidence: ev,
                              evidenceId: evId,
                              confidence: impactConf,
                              mode: "compact",
                              repositoryName,
                              commitSha: commitSha ?? changeMode?.headCommit,
                              gitRef: effectiveRef ?? changeMode?.headCommit,
                              analysisRunId,
                            }),
                          );
                        }),
                      ),
                    )
                  : null,
              )
            : React.createElement(
                "p",
                {
                  "data-testid": "inspector-impact-unaffected-msg",
                  className: "text-slate-500 text-xs italic",
                },
                "This node is outside the blast radius of the analyzed pull request.",
              ),
        )
      : null,

    // 2. Identity & Architecture Properties
    React.createElement(
      "section",
      {
        "data-testid": "inspector-node-details",
        className: "p-4 flex flex-col gap-3 text-xs",
      },
      React.createElement(
        "h3",
        { className: "text-xs font-semibold text-slate-500 uppercase tracking-wider" },
        "Node Properties",
      ),

      // Node ID
      React.createElement(
        "div",
        { className: "flex flex-col gap-0.5" },
        React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Node ID"),
        React.createElement(
          "span",
          {
            "data-testid": "inspector-node-id",
            className: "font-mono text-slate-800 break-all bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100",
          },
          node.id,
        ),
      ),

      // Canonical ID
      React.createElement(
        "div",
        { className: "flex flex-col gap-0.5" },
        React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Canonical ID"),
        React.createElement(
          "span",
          {
            "data-testid": "inspector-node-canonical-id",
            className: "font-mono text-slate-800 break-all bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100",
          },
          node.canonical_id,
        ),
      ),

      // Path if present
      node.path
        ? React.createElement(
            "div",
            { className: "flex flex-col gap-0.5" },
            React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Path"),
            React.createElement(
              "span",
              {
                "data-testid": "inspector-node-path",
                className: "font-mono text-slate-800 break-all bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100",
              },
              node.path,
            ),
          )
        : null,

      // Depth & Confidence row
      React.createElement(
        "div",
        { className: "grid grid-cols-2 gap-2 pt-1" },
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Depth"),
          React.createElement(
            "span",
            {
              "data-testid": "inspector-node-depth",
              className: "font-semibold text-slate-800",
            },
            String(node.depth),
          ),
        ),
        (() => {
          const normalizedNodeConf = normalizeConfidence(node.confidence);
          return React.createElement(
            "div",
            { className: "flex flex-col gap-0.5" },
            React.createElement("span", { className: "text-slate-500 text-[11px]" }, "Confidence"),
            React.createElement(
              "div",
              { className: "flex items-center gap-1.5" },
              React.createElement(
                "span",
                {
                  "data-testid": "inspector-node-confidence",
                  "data-confidence-tier": normalizedNodeConf?.tier,
                  "aria-label": normalizedNodeConf ? normalizedNodeConf.accessibleLabel : `Confidence: ${confidencePercent}`,
                  className: "font-semibold text-slate-800",
                },
                confidencePercent,
              ),
              normalizedNodeConf && normalizedNodeConf.raw < 1.0
                ? React.createElement(
                    "span",
                    {
                      className: `text-[10px] font-mono px-1.5 py-0.2 rounded border ${
                        normalizedNodeConf.tier === "high"
                          ? "bg-slate-100 text-slate-700 border-slate-200"
                          : normalizedNodeConf.tier === "medium"
                            ? "bg-amber-50 text-amber-800 border-amber-200"
                            : "bg-amber-100/80 text-amber-900 border-amber-300 border-dashed"
                      }`,
                    },
                    normalizedNodeConf.tier,
                  )
                : null,
            ),
          );
        })(),
      ),
    ),

    // 3. Metadata Section (only when metadata keys exist)
    metadataEntries.length > 0
      ? React.createElement(
          "section",
          {
            "data-testid": "inspector-node-metadata",
            className: "p-4 flex flex-col gap-2 text-xs",
          },
          React.createElement(
            "h3",
            { className: "text-xs font-semibold text-slate-500 uppercase tracking-wider" },
            "Metadata",
          ),
          React.createElement(
            "div",
            { className: "bg-slate-50 rounded-md p-2.5 border border-slate-200/60 flex flex-col gap-1.5" },
            ...metadataEntries.map(([key, val]) =>
              React.createElement(
                "div",
                {
                  key,
                  "data-testid": `metadata-item-${key}`,
                  className: "flex flex-col gap-0.5",
                },
                React.createElement(
                  "span",
                  { className: "text-[11px] font-medium text-slate-600" },
                  key,
                ),
                React.createElement(
                  "span",
                  { className: "font-mono text-[11px] text-slate-800 break-all" },
                  safeFormatMetadataValue(val),
                ),
              ),
            ),
          ),
        )
      : null,

    // 4. Evidence Trail Section
    React.createElement(
      "section",
      {
        className: "p-4 flex flex-col gap-2 text-xs flex-1",
      },
      React.createElement(
        "div",
        { className: "flex items-center justify-between" },
        React.createElement(
          "h3",
          { className: "text-xs font-semibold text-slate-500 uppercase tracking-wider" },
          "Evidence Trail",
        ),
      ),
      React.createElement(EvidenceTrail, {
        evidence,
        selectedNodeId: node.id,
        repositoryName,
        commitSha: commitSha ?? changeMode?.headCommit,
        gitRef: effectiveRef ?? changeMode?.headCommit,
        analysisRunId,
      }),
    ),
  );
}

