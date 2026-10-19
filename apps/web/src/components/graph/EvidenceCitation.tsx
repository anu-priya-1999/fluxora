"use client";

import React, { useState } from "react";
import type { GraphQueryResponseEvidence } from "@fluxora/shared-types";
import {
  buildSourcePermalink,
  deduplicateAndSortEvidence,
  formatLineRange,
} from "./evidence-citation-data.ts";

export interface EvidenceCitationProps {
  /**
   * Complete evidence record with provenance fields.
   */
  readonly evidence?: GraphQueryResponseEvidence | undefined;
  /**
   * Raw evidence ID (used for lookup or fallback display when record is not yet resolved).
   */
  readonly evidenceId?: string | undefined;
  /**
   * Display mode: compact badge/chip or expanded detail card.
   */
  readonly mode?: "compact" | "expanded" | undefined;
  /**
   * Repository name in "owner/repo" format.
   */
  readonly repositoryName?: string | null | undefined;
  /**
   * Pinned immutable commit SHA.
   */
  readonly commitSha?: string | null | undefined;
  /**
   * Mutable branch or ref name fallback.
   */
  readonly gitRef?: string | null | undefined;
  readonly ref?: string | null | undefined;
  /**
   * Analysis run identifier producing this evidence.
   */
  readonly analysisRunId?: string | null | undefined;
  /**
   * Finding category role for contextual coloring/badging.
   */
  readonly findingRole?:
    | "direct"
    | "downstream"
    | "affected_api"
    | "affected_event"
    | "affected_service"
    | undefined;
  /**
   * Hop distance for downstream findings.
   */
  readonly hopDistance?: number | undefined;
  /**
   * Optional click handler called when external source navigation is triggered.
   */
  readonly onOpenSource?: ((url: string) => void) | undefined;
  /**
   * Whether evidence is currently being fetched asynchronously.
   */
  readonly isLoading?: boolean | undefined;
  /**
   * Error message if fetching this evidence failed.
   */
  readonly errorMessage?: string | null | undefined;
  /**
   * Additional container CSS classes.
   */
  readonly className?: string | undefined;
}

/**
 * Reusable EvidenceCitation component for Fluxora (Step 49).
 *
 * Responsibilities:
 * - Surfaces exact source provenance for any graph edge, node, or impact finding.
 * - Compact mode for inline finding/edge chips; expanded mode for detail inspection.
 * - Computes safe, validated GitHub permalinks with exact line anchors without fabricating data.
 * - Renders accessible external links with security attributes (target="_blank", rel="noopener noreferrer").
 * - Gracefully handles unavailable source navigation with honest explanations.
 * - Fully accessible via keyboard with visible focus states and semantic ARIA attributes.
 */
export function EvidenceCitation({
  evidence,
  evidenceId,
  mode = "compact",
  repositoryName,
  commitSha,
  gitRef,
  analysisRunId,
  findingRole,
  hopDistance,
  onOpenSource,
  isLoading = false,
  errorMessage,
  className,
  ...restProps
}: EvidenceCitationProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(mode === "expanded");

  // Loading State
  if (isLoading) {
    return React.createElement(
      "div",
      {
        "data-testid": "citation-loading-state",
        className: `inline-flex items-center gap-1.5 px-2 py-1 rounded bg-slate-100 text-slate-500 text-xs animate-pulse ${className ?? ""}`,
        role: "status",
        "aria-label": "Loading evidence metadata",
      },
      React.createElement("span", {
        className:
          "w-2.5 h-2.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin",
      }),
      React.createElement("span", null, "Loading evidence..."),
    );
  }

  // Error State
  if (errorMessage) {
    return React.createElement(
      "div",
      {
        "data-testid": "citation-error-state",
        className: `inline-flex items-center gap-1.5 px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200 text-xs ${className ?? ""}`,
        role: "alert",
      },
      React.createElement("span", null, "⚠️"),
      React.createElement("span", null, errorMessage),
    );
  }

  // Fallback: only ID is known, but record is missing
  if (!evidence) {
    return React.createElement(
      "div",
      {
        "data-testid": "citation-unresolved-id",
        className: `inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[11px] bg-slate-100 text-slate-600 border border-slate-200 ${className ?? ""}`,
        title: "Evidence record metadata not loaded",
      },
      React.createElement("span", { "aria-hidden": "true" }, "📎"),
      React.createElement("span", null, evidenceId ?? "unknown-evidence"),
      React.createElement(
        "span",
        { className: "text-[10px] text-slate-400 italic" },
        "(metadata unavailable)",
      ),
    );
  }

  // Extract metadata and coordinates safely
  const lineRangeStr = formatLineRange(evidence.line_start, evidence.line_end);
  const confidenceScore =
    typeof evidence.confidence === "number" ? evidence.confidence : undefined;
  const confidencePct =
    confidenceScore !== undefined ? `${Math.round(confidenceScore * 100)}%` : null;

  // Resolve repository / ref / commit from props or evidence metadata
  const effectiveRepo =
    repositoryName ??
    (typeof evidence.metadata?.repository === "string"
      ? evidence.metadata.repository
      : typeof evidence.metadata?.repositoryName === "string"
        ? evidence.metadata.repositoryName
        : typeof evidence.metadata?.repo_name === "string"
          ? evidence.metadata.repo_name
          : undefined);

  const effectiveCommit =
    commitSha ??
    (typeof evidence.metadata?.commitSha === "string"
      ? evidence.metadata.commitSha
      : typeof evidence.metadata?.commit_sha === "string"
        ? evidence.metadata.commit_sha
        : undefined);

  const rawRef = gitRef ?? (restProps as { ref?: string | null | undefined }).ref;
  const effectiveRef =
    rawRef ??
    (typeof evidence.metadata?.ref === "string"
      ? evidence.metadata.ref
      : undefined);

  const permalink = buildSourcePermalink({
    repositoryName: effectiveRepo,
    commitSha: effectiveCommit,
    gitRef: effectiveRef,
    filePath: evidence.file_path,
    lineStart: evidence.line_start,
    lineEnd: evidence.line_end,
  });

  // Short file name for compact rendering
  const shortFileName = evidence.file_path.split("/").pop() ?? evidence.file_path;

  // Render Compact Mode
  if (!isExpanded) {
    return React.createElement(
      "div",
      {
        className: `inline-flex items-center gap-1 ${className ?? ""}`,
      },
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "evidence-citation-compact",
          onClick: () => setIsExpanded(true),
          className:
            "inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-mono text-[11px] bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200/70 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 text-left cursor-pointer",
          title: `Click to inspect evidence for ${evidence.file_path}`,
          "aria-label": `Evidence citation for ${evidence.file_path}${lineRangeStr ? ` at ${lineRangeStr}` : ""}`,
        },
        React.createElement(
          "span",
          { "aria-hidden": "true", className: "text-indigo-500" },
          "📄",
        ),
        React.createElement(
          "span",
          { className: "font-medium text-slate-800 break-all" },
          `${shortFileName}${lineRangeStr ? `:${lineRangeStr}` : ""}`,
        ),
        confidencePct
          ? React.createElement(
              "span",
              {
                "data-testid": "citation-confidence-chip",
                className:
                  "text-[10px] px-1 py-0.2 rounded bg-indigo-200/60 text-indigo-800 font-sans font-semibold shrink-0",
              },
              confidencePct,
            )
          : null,
      ),
    );
  }

  // Render Expanded / Detail Mode
  const roleLabel =
    findingRole === "direct"
      ? "Direct Impact"
      : findingRole === "downstream"
        ? `Downstream (hop ${hopDistance ?? 1})`
        : findingRole;

  return React.createElement(
    "article",
    {
      "data-testid": "evidence-citation-card",
      "data-evidence-id": evidence.id,
      className: `p-3 bg-white border border-slate-200 rounded-lg shadow-sm flex flex-col gap-2 text-xs ${className ?? ""}`,
      "aria-label": `Evidence provenance for ${evidence.file_path}`,
    },
    // Header
    React.createElement(
      "header",
      {
        className:
          "flex items-start justify-between gap-2 border-b border-slate-100 pb-1.5",
      },
      React.createElement(
        "div",
        { className: "flex flex-col gap-0.5" },
        React.createElement(
          "div",
          { className: "flex items-center gap-1.5 flex-wrap" },
          React.createElement(
            "span",
            {
              "data-testid": "citation-badge-label",
              className:
                "font-bold text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200/60",
            },
            "Verified Evidence",
          ),
          roleLabel
            ? React.createElement(
                "span",
                {
                  "data-testid": "citation-role-badge",
                  className:
                    "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-700",
                },
                roleLabel,
              )
            : null,
          confidencePct
            ? React.createElement(
                "span",
                {
                  "data-testid": "citation-confidence",
                  className:
                    "text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700",
                },
                `Confidence: ${confidencePct}`,
              )
            : null,
        ),
        React.createElement(
          "h4",
          {
            "data-testid": "citation-relationship",
            className:
              "font-semibold text-slate-900 mt-1 break-words leading-tight",
          },
          evidence.relationship_description,
        ),
      ),
      mode === "compact"
        ? React.createElement(
            "button",
            {
              type: "button",
              "data-testid": "citation-collapse-button",
              onClick: () => setIsExpanded(false),
              className:
                "text-slate-400 hover:text-slate-600 rounded px-1.5 py-0.5 text-[11px] shrink-0",
              "aria-label": "Collapse evidence details",
              title: "Collapse evidence details",
            },
            "✕",
          )
        : null,
    ),

    // Body
    React.createElement(
      "div",
      { className: "flex flex-col gap-1.5" },
      // Source file
      React.createElement(
        "div",
        { className: "flex flex-col gap-0.5" },
        React.createElement(
          "span",
          {
            className:
              "text-[10px] uppercase tracking-wider font-semibold text-slate-400",
          },
          "Source File",
        ),
        React.createElement(
          "span",
          {
            "data-testid": "citation-file-path",
            className:
              "font-mono text-slate-800 break-all bg-slate-50 px-2 py-1 rounded border border-slate-100 select-all",
          },
          evidence.file_path,
        ),
      ),

      // Line / Coordinates
      lineRangeStr
        ? React.createElement(
            "div",
            { className: "flex items-center gap-2" },
            React.createElement(
              "span",
              {
                className:
                  "text-[10px] uppercase tracking-wider font-semibold text-slate-400",
              },
              "Coordinates:",
            ),
            React.createElement(
              "span",
              {
                "data-testid": "citation-lines",
                className: "font-mono font-medium text-slate-700",
              },
              lineRangeStr,
            ),
            typeof evidence.column_start === "number"
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "citation-columns",
                    className: "font-mono text-slate-500 text-[11px]",
                  },
                  `(Col ${evidence.column_start}${
                    typeof evidence.column_end === "number" &&
                    evidence.column_end !== evidence.column_start
                      ? `–${evidence.column_end}`
                      : ""
                  })`,
                )
              : null,
          )
        : null,

      // Symbol
      evidence.symbol_id
        ? React.createElement(
            "div",
            { className: "flex flex-col gap-0.5" },
            React.createElement(
              "span",
              {
                className:
                  "text-[10px] uppercase tracking-wider font-semibold text-slate-400",
              },
              "Symbol",
            ),
            React.createElement(
              "span",
              {
                "data-testid": "citation-symbol",
                className:
                  "font-mono text-[11px] text-indigo-800 bg-indigo-50/70 px-2 py-0.5 rounded border border-indigo-100/70 break-all",
              },
              evidence.symbol_id,
            ),
          )
        : null,

      // Analysis run
      analysisRunId ||
        (typeof evidence.metadata?.analysisRunId === "string"
          ? evidence.metadata.analysisRunId
          : null)
        ? React.createElement(
            "div",
            { className: "flex items-center gap-1.5 text-[11px] text-slate-500" },
            React.createElement(
              "span",
              { className: "font-medium text-slate-600" },
              "Run:",
            ),
            React.createElement(
              "span",
              {
                "data-testid": "citation-analysis-run",
                className: "font-mono text-slate-600 break-all",
              },
              analysisRunId ?? String(evidence.metadata?.analysisRunId),
            ),
          )
        : null,
    ),

    // Footer
    React.createElement(
      "footer",
      {
        className:
          "pt-2 border-t border-slate-100 flex items-center justify-between gap-2 mt-0.5",
      },
      permalink.available && permalink.url
        ? React.createElement(
            "a",
            {
              href: permalink.url,
              target: "_blank",
              rel: "noopener noreferrer",
              "data-testid": "citation-source-link",
              onClick: () => onOpenSource?.(permalink.url!),
              className:
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-1 transition-colors text-[11px]",
              "aria-label": `Open source for ${evidence.file_path}${lineRangeStr ? ` at ${lineRangeStr}` : ""} on GitHub (opens in a new tab)`,
            },
            React.createElement("span", null, "Open Source on GitHub"),
            React.createElement(
              "span",
              { "aria-hidden": "true", className: "text-slate-300" },
              "↗",
            ),
          )
        : React.createElement(
            "div",
            {
              "data-testid": "citation-source-unavailable",
              className:
                "flex items-center gap-1.5 text-[11px] text-slate-500 italic bg-slate-50 px-2 py-1 rounded border border-slate-200/60",
              title: permalink.reason ?? "Source link not resolved",
            },
            React.createElement("span", { "aria-hidden": "true" }, "ℹ️"),
            React.createElement(
              "span",
              null,
              `Source permalink unavailable: ${permalink.reason}`,
            ),
          ),
      React.createElement(
        "span",
        {
          "data-testid": "citation-evidence-id",
          className: "font-mono text-[10px] text-slate-400 select-all",
          title: `Evidence UUID: ${evidence.id}`,
        },
        `${evidence.id.slice(0, 8)}...`,
      ),
    ),
  );
}

export interface EvidenceCitationListProps {
  /**
   * Pre-resolved evidence records.
   */
  readonly evidenceList?: readonly GraphQueryResponseEvidence[] | undefined;
  /**
   * Evidence IDs to resolve against evidencePool.
   */
  readonly evidenceIds?: readonly string[] | undefined;
  /**
   * Pool of evidence records to resolve against.
   */
  readonly evidencePool?: readonly GraphQueryResponseEvidence[] | undefined;
  /**
   * Display mode for rendered citations.
   */
  readonly mode?: "compact" | "expanded" | undefined;
  /**
   * Repository name in "owner/repo" format.
   */
  readonly repositoryName?: string | null | undefined;
  /**
   * Pinned immutable commit SHA.
   */
  readonly commitSha?: string | null | undefined;
  /**
   * Mutable branch or ref name fallback.
   */
  readonly gitRef?: string | null | undefined;
  readonly ref?: string | null | undefined;
  /**
   * Analysis run identifier.
   */
  readonly analysisRunId?: string | null | undefined;
  /**
   * Finding category role.
   */
  readonly findingRole?:
    | "direct"
    | "downstream"
    | "affected_api"
    | "affected_event"
    | "affected_service"
    | undefined;
  /**
   * Hop distance for downstream findings.
   */
  readonly hopDistance?: number | undefined;
  /**
   * Additional container CSS classes.
   */
  readonly className?: string | undefined;
}

/**
 * Renders an ordered, deduplicated list of EvidenceCitation components.
 */
export function EvidenceCitationList({
  evidenceList,
  evidenceIds,
  evidencePool,
  mode = "compact",
  repositoryName,
  commitSha,
  gitRef,
  analysisRunId,
  findingRole,
  hopDistance,
  className,
  ...restProps
}: EvidenceCitationListProps): React.JSX.Element {
  const effectiveRef = gitRef ?? (restProps as { ref?: string | null | undefined }).ref;
  // 1. Gather all candidate evidence records
  const candidates: GraphQueryResponseEvidence[] = [];

  if (evidenceList && Array.isArray(evidenceList)) {
    candidates.push(...evidenceList);
  }

  const poolMap = new Map<string, GraphQueryResponseEvidence>();
  if (evidencePool && Array.isArray(evidencePool)) {
    for (const ev of evidencePool) {
      if (ev && ev.id) {
        poolMap.set(ev.id, ev);
      }
    }
  }

  const unresolvedIds: string[] = [];

  if (evidenceIds && Array.isArray(evidenceIds)) {
    for (const id of evidenceIds) {
      if (!id || typeof id !== "string") continue;
      const found = poolMap.get(id);
      if (found) {
        candidates.push(found);
      } else {
        unresolvedIds.push(id);
      }
    }
  }

  // 2. Deduplicate and sort candidate records deterministically
  const sorted = deduplicateAndSortEvidence(candidates);

  // 3. Deduplicate unresolved IDs
  const uniqueUnresolvedIds = Array.from(new Set(unresolvedIds)).sort((a, b) =>
    a.localeCompare(b),
  );

  if (sorted.length === 0 && uniqueUnresolvedIds.length === 0) {
    return React.createElement(
      "div",
      {
        "data-testid": "evidence-citation-empty",
        className: "text-[11px] text-slate-400 italic",
      },
      "No evidence citations attached.",
    );
  }

  const items = [
    ...sorted.map((ev) =>
      React.createElement(EvidenceCitation, {
        key: ev.id,
        evidence: ev,
        mode,
        repositoryName,
        commitSha,
        gitRef: effectiveRef,
        analysisRunId,
        findingRole,
        hopDistance,
      }),
    ),
    ...uniqueUnresolvedIds.map((id) =>
      React.createElement(EvidenceCitation, {
        key: id,
        evidenceId: id,
        mode,
        repositoryName,
        commitSha,
        gitRef: effectiveRef,
        analysisRunId,
        findingRole,
        hopDistance,
      }),
    ),
  ];

  return React.createElement(
    "div",
    {
      "data-testid": "evidence-citation-list",
      className: `flex ${mode === "compact" ? "flex-wrap gap-1.5" : "flex-col gap-2.5"} ${className ?? ""}`,
    },
    ...items,
  );
}
