import React, { useState } from "react";
import type {
  GraphQueryResponseEdge,
  GraphQueryResponseNode,
} from "@fluxora/shared-types";
import type { NormalizedChangeModeState } from "./change-mode-data.ts";
import {
  calculateGraphEdgeCoverage,
  calculateImpactFindingCoverage,
  type AnalysisCoverageSummary,
  type CoverageFilter,
  type CoverageSubjectType,
  type UncoveredGraphEdgeItem,
  type CoveredGraphEdgeItem,
  type UncoveredImpactFindingItem,
  type CoveredImpactFindingItem,
} from "./coverage-data.ts";
import { normalizeConfidence } from "./confidence-data.ts";

export interface AnalysisCoverageBarProps {
  readonly edges?: readonly GraphQueryResponseEdge[] | undefined;
  readonly nodes?: readonly GraphQueryResponseNode[] | undefined;
  readonly changeModeState?: NormalizedChangeModeState | undefined;
  readonly analysisRunId?: string | null | undefined;
  readonly repositoryName?: string | null | undefined;
  readonly commitSha?: string | null | undefined;
  readonly gitRef?: string | null | undefined;
  readonly isLoading?: boolean | undefined;
  readonly isRefreshing?: boolean | undefined;
  readonly errorMessage?: string | null | undefined;
  readonly initialExpanded?: boolean | undefined;
  readonly onSelectNode?: ((nodeId: string) => void) | undefined;
  readonly onSelectEdge?: ((edgeId: string) => void) | undefined;
  readonly selectedEdgeId?: string | null | undefined;
  readonly selectedNodeId?: string | null | undefined;
  readonly className?: string | undefined;
}

/**
 * Analysis Evidence Coverage View (Global Step 51).
 *
 * Responsibilities:
 * - Surfaces deterministic evidence coverage for the loaded analysis slice.
 * - Distinguishes between Graph Edge coverage and PR Impact Finding coverage without mixing denominators.
 * - Displays exact numeric percentage, covered count, and missing count.
 * - Multi-channel accessibility: coverage is understandable without color alone.
 * - Provides expandable category breakdowns and actionable list of uncovered items.
 * - Selecting an uncovered item triggers native graph/inspector selection.
 * - Pure frontend presentation over authoritative API data; never accesses @fluxora/db directly.
 */
export function AnalysisCoverageBar({
  edges = [],
  nodes = [],
  changeModeState,
  analysisRunId,
  repositoryName,
  commitSha,
  gitRef,
  isLoading = false,
  isRefreshing = false,
  errorMessage,
  initialExpanded = false,
  onSelectNode,
  onSelectEdge,
  selectedEdgeId,
  selectedNodeId,
  className = "",
}: AnalysisCoverageBarProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [activeTab, setActiveTab] = useState<CoverageSubjectType>("graph_edge");
  const [itemFilter, setItemFilter] = useState<CoverageFilter>("uncovered");

  const hasImpactAnalysis = Boolean(
    changeModeState?.enabled && changeModeState.status === "ready",
  );

  // Compute Graph Edge Coverage
  const graphCoverage = calculateGraphEdgeCoverage({
    edges,
    nodes,
    analysisRunId,
    repositoryName: repositoryName ?? undefined,
    commitSha: commitSha ?? undefined,
    gitRef: gitRef ?? undefined,
    isLoading,
    isStale: isRefreshing,
    errorMessage,
  });

  // Compute PR Impact Finding Coverage (if active)
  const impactCoverage = changeModeState
    ? calculateImpactFindingCoverage({
        changeModeState,
        analysisRunId,
        repositoryName: repositoryName ?? undefined,
        commitSha: commitSha ?? undefined,
        gitRef: gitRef ?? undefined,
      })
    : null;

  // Active coverage model based on tab selection
  const currentCoverage: AnalysisCoverageSummary =
    activeTab === "impact_finding" && impactCoverage
      ? impactCoverage
      : graphCoverage;

  const isEdgeScope = currentCoverage.subjectType === "graph_edge";

  // Visual status classes
  const isHealthy = currentCoverage.isFullCoverage;
  const isWarning =
    !isHealthy && !currentCoverage.isZeroCoverage && currentCoverage.total > 0;
  const isCritical = currentCoverage.isZeroCoverage && currentCoverage.total > 0;

  return React.createElement(
    "section",
    {
      "data-testid": "analysis-coverage-bar",
      className: `px-4 py-2 bg-white border-b border-slate-200 text-xs flex flex-col gap-2 transition-all ${className}`,
      "aria-label": "Analysis Evidence Coverage",
      role: "region",
    },
    // Top Bar: Scope, Coverage Percentage, Progress Bar, Action Buttons
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      // Left Group: Title, Scope, and Subject Tabs
      React.createElement(
        "div",
        { className: "flex items-center gap-2.5 flex-wrap" },
        React.createElement(
          "span",
          {
            className:
              "font-bold text-slate-800 uppercase tracking-wider text-[11px] flex items-center gap-1.5",
          },
          React.createElement("span", {
            className: `w-2 h-2 rounded-full ${
              isHealthy
                ? "bg-emerald-500"
                : isWarning
                  ? "bg-amber-500"
                  : isCritical
                    ? "bg-rose-500"
                    : "bg-slate-400"
            }`,
            "aria-hidden": "true",
          }),
          "Evidence Coverage",
        ),
        // Scope pill
        React.createElement(
          "span",
          {
            "data-testid": "coverage-scope-badge",
            className:
              "font-mono text-[10px] text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded",
            title: analysisRunId ? `Analysis Run: ${analysisRunId}` : undefined,
          },
          currentCoverage.scopeLabel,
        ),
        // Stale / Refreshing indicator
        isRefreshing
          ? React.createElement(
              "span",
              {
                "data-testid": "coverage-stale-badge",
                className:
                  "text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded",
              },
              "Refreshing...",
            )
          : null,
        // Subject Selector Tabs (when Impact Analysis is also active)
        hasImpactAnalysis
          ? React.createElement(
              "div",
              {
                className: "flex items-center border border-slate-200 rounded p-0.5 bg-slate-50",
                role: "tablist",
                "aria-label": "Coverage Scope Surface",
              },
              React.createElement(
                "button",
                {
                  type: "button",
                  role: "tab",
                  "aria-selected": activeTab === "graph_edge",
                  "data-testid": "coverage-tab-graph",
                  onClick: () => setActiveTab("graph_edge"),
                  className: `px-2 py-0.5 text-[11px] rounded transition-colors ${
                    activeTab === "graph_edge"
                      ? "bg-white font-semibold text-slate-800 shadow-xs"
                      : "text-slate-500 hover:text-slate-800"
                  }`,
                },
                "Graph Edges",
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  role: "tab",
                  "aria-selected": activeTab === "impact_finding",
                  "data-testid": "coverage-tab-impact",
                  onClick: () => setActiveTab("impact_finding"),
                  className: `px-2 py-0.5 text-[11px] rounded transition-colors ${
                    activeTab === "impact_finding"
                      ? "bg-white font-semibold text-slate-800 shadow-xs"
                      : "text-slate-500 hover:text-slate-800"
                  }`,
                },
                "PR Impact Findings",
              ),
            )
          : null,
      ),
      // Right Group: Numeric Stats, Visual Progress Bar, Expand Toggle
      React.createElement(
        "div",
        { className: "flex items-center gap-3.5 flex-wrap" },
        // Numeric Summary Counts
        React.createElement(
          "div",
          {
            className: "flex items-center gap-2 text-[11px] text-slate-600 font-mono",
            "data-testid": "coverage-summary-counts",
          },
          React.createElement(
            "span",
            null,
            "Covered: ",
            React.createElement(
              "strong",
              {
                "data-testid": "coverage-covered-count",
                className: "text-slate-900 font-semibold",
              },
              currentCoverage.covered,
            ),
          ),
          React.createElement("span", { className: "text-slate-300" }, "|"),
          React.createElement(
            "span",
            null,
            "Missing: ",
            React.createElement(
              "strong",
              {
                "data-testid": "coverage-uncovered-count",
                className:
                  currentCoverage.uncovered > 0
                    ? "text-rose-600 font-semibold"
                    : "text-slate-900 font-semibold",
              },
              currentCoverage.uncovered,
            ),
          ),
          React.createElement("span", { className: "text-slate-300" }, "|"),
          React.createElement(
            "span",
            null,
            "Total: ",
            React.createElement(
              "strong",
              {
                "data-testid": "coverage-total-count",
                className: "text-slate-900 font-semibold",
              },
              currentCoverage.total,
            ),
          ),
        ),
        // Coverage Percentage Badge
        React.createElement(
          "span",
          {
            "data-testid": "coverage-percentage-badge",
            "aria-label": currentCoverage.accessibleLabel,
            className: `font-bold px-2 py-0.5 rounded text-[11px] border font-mono ${
              isHealthy
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : isWarning
                  ? "bg-amber-50 text-amber-800 border-amber-200"
                  : isCritical
                    ? "bg-rose-50 text-rose-800 border-rose-200"
                    : "bg-slate-100 text-slate-700 border-slate-200"
            }`,
          },
          currentCoverage.formattedPercentage,
        ),
        // Segmented Visual Progress Bar
        React.createElement(
          "div",
          {
            className:
              "w-28 sm:w-36 h-2 rounded-full bg-slate-100 border border-slate-200 overflow-hidden flex",
            role: "progressbar",
            "aria-valuenow": currentCoverage.percentage,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-label": currentCoverage.accessibleLabel,
            "data-testid": "coverage-progress-bar",
          },
          currentCoverage.percentage > 0
            ? React.createElement("div", {
                className: `h-full transition-all ${
                  isHealthy
                    ? "bg-emerald-500"
                    : isWarning
                      ? "bg-amber-500"
                      : "bg-rose-500"
                }`,
                style: { width: `${currentCoverage.percentage}%` },
              })
            : null,
          currentCoverage.uncovered > 0 && currentCoverage.total > 0
            ? React.createElement("div", {
                className: "h-full bg-rose-200 flex-1",
                title: `${currentCoverage.uncovered} missing evidence`,
              })
            : null,
        ),
        // Expand / Collapse Details Drawer Button
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "coverage-expand-toggle",
            onClick: () => setIsExpanded(!isExpanded),
            "aria-expanded": isExpanded,
            className:
              "px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500 transition-colors flex items-center gap-1",
          },
          React.createElement("span", null, isExpanded ? "Hide Details" : "View Details"),
          React.createElement(
            "span",
            { className: "text-[10px] text-slate-400 font-mono", "aria-hidden": "true" },
            isExpanded ? "▲" : "▼",
          ),
        ),
      ),
    ),
    // Expanded Drawer: Categories Breakdown, Uncovered Items List & Filters
    isExpanded
      ? React.createElement(
          "div",
          {
            "data-testid": "coverage-expanded-panel",
            className:
              "pt-2 border-t border-slate-200/80 flex flex-col gap-3 transition-all",
          },
          // Categories Breakdown Section
          currentCoverage.categories.length > 0
            ? React.createElement(
                "div",
                {
                  "data-testid": "coverage-categories-section",
                  className: "flex flex-col gap-1.5",
                },
                React.createElement(
                  "div",
                  { className: "text-[11px] font-semibold text-slate-600 flex items-center justify-between" },
                  React.createElement("span", null, "Category Coverage Breakdown"),
                  React.createElement(
                    "span",
                    { className: "font-mono text-[10px] text-slate-400" },
                    `${currentCoverage.categories.length} categories analyzed`,
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2" },
                  currentCoverage.categories.map((cat) =>
                    React.createElement(
                      "div",
                      {
                        key: cat.id,
                        "data-testid": `coverage-category-${cat.id}`,
                        className:
                          "p-2 bg-slate-50 border border-slate-200/90 rounded flex flex-col gap-1",
                      },
                      React.createElement(
                        "div",
                        { className: "flex justify-between items-center" },
                        React.createElement(
                          "span",
                          {
                            "data-testid": "coverage-category-name",
                            className: "font-medium text-slate-800 text-[11px] truncate",
                            title: cat.name,
                          },
                          cat.name,
                        ),
                        React.createElement(
                          "span",
                          {
                            "data-testid": "coverage-category-percentage",
                            className: `font-mono text-[10px] font-bold px-1.5 py-0.2 rounded border ${
                              cat.covered === cat.total
                                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                : cat.covered === 0
                                  ? "bg-rose-50 text-rose-800 border-rose-200"
                                  : "bg-amber-50 text-amber-800 border-amber-200"
                            }`,
                            "aria-label": cat.accessibleLabel,
                          },
                          cat.formattedPercentage,
                        ),
                      ),
                      React.createElement(
                        "div",
                        { className: "flex justify-between items-center text-[10px] text-slate-500 font-mono" },
                        React.createElement(
                          "span",
                          null,
                          `${cat.covered} / ${cat.total} covered`,
                        ),
                        cat.uncovered > 0
                          ? React.createElement(
                              "span",
                              { className: "text-rose-600 font-semibold" },
                              `${cat.uncovered} missing`,
                            )
                          : React.createElement(
                              "span",
                              { className: "text-emerald-700" },
                              "Complete",
                            ),
                      ),
                      // Mini Progress Bar
                      React.createElement(
                        "div",
                        {
                          className:
                            "w-full h-1.5 rounded-full bg-slate-200 overflow-hidden flex mt-0.5",
                          role: "progressbar",
                          "aria-valuenow": cat.percentage,
                          "aria-valuemin": 0,
                          "aria-valuemax": 100,
                          "aria-label": cat.accessibleLabel,
                        },
                        cat.percentage > 0
                          ? React.createElement("div", {
                              className: `h-full ${
                                cat.covered === cat.total ? "bg-emerald-500" : "bg-amber-500"
                              }`,
                              style: { width: `${cat.percentage}%` },
                            })
                          : null,
                      ),
                    ),
                  ),
                ),
              )
            : null,
          // Unresolved PR Files Notice (for impact mode)
          currentCoverage.unresolvedFilesCount > 0
            ? React.createElement(
                "div",
                {
                  "data-testid": "coverage-unresolved-files-notice",
                  className:
                    "p-2 bg-amber-50/70 border border-amber-200 rounded text-amber-900 flex items-center justify-between text-[11px]",
                },
                React.createElement(
                  "span",
                  null,
                  `Notice: ${currentCoverage.unresolvedFilesCount} changed PR files could not be mapped to architectural graph nodes (unsupported/unmapped).`,
                ),
              )
            : null,
          // Actionable Items List & Filter Controls
          React.createElement(
            "div",
            {
              "data-testid": "coverage-items-container",
              className: "flex flex-col gap-2 pt-1 border-t border-slate-100",
            },
            React.createElement(
              "div",
              { className: "flex flex-wrap items-center justify-between gap-2" },
              React.createElement(
                "span",
                { className: "text-[11px] font-semibold text-slate-700" },
                isEdgeScope
                  ? "Graph Edge Findings"
                  : "PR Blast Radius Findings",
              ),
              // Filter Buttons: All, Covered, Uncovered
              React.createElement(
                "div",
                {
                  className: "flex items-center gap-1 bg-slate-100 p-0.5 rounded border border-slate-200",
                  role: "group",
                  "aria-label": "Filter Findings By Evidence Status",
                },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    "data-testid": "coverage-filter-all",
                    onClick: () => setItemFilter("all"),
                    className: `px-2 py-0.5 text-[10px] rounded transition-colors ${
                      itemFilter === "all"
                        ? "bg-white font-semibold text-slate-800 shadow-xs"
                        : "text-slate-500 hover:text-slate-800"
                    }`,
                  },
                  `All (${currentCoverage.total})`,
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    "data-testid": "coverage-filter-covered",
                    onClick: () => setItemFilter("covered"),
                    className: `px-2 py-0.5 text-[10px] rounded transition-colors ${
                      itemFilter === "covered"
                        ? "bg-white font-semibold text-slate-800 shadow-xs"
                        : "text-slate-500 hover:text-slate-800"
                    }`,
                  },
                  `Covered (${currentCoverage.covered})`,
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    "data-testid": "coverage-filter-uncovered",
                    onClick: () => setItemFilter("uncovered"),
                    className: `px-2 py-0.5 text-[10px] rounded transition-colors ${
                      itemFilter === "uncovered"
                        ? "bg-white font-semibold text-slate-800 shadow-xs"
                        : "text-slate-500 hover:text-slate-800"
                    }`,
                  },
                  `Missing Evidence (${currentCoverage.uncovered})`,
                ),
              ),
            ),
            // Items List Display
            renderCoverageItemsList({
              coverage: currentCoverage,
              filter: itemFilter,
              onSelectNode,
              onSelectEdge,
              selectedEdgeId,
              selectedNodeId,
            }),
          ),
        )
      : null,
  );
}

function renderCoverageItemsList(props: {
  readonly coverage: AnalysisCoverageSummary;
  readonly filter: CoverageFilter;
  readonly onSelectNode?: ((nodeId: string) => void) | undefined;
  readonly onSelectEdge?: ((edgeId: string) => void) | undefined;
  readonly selectedEdgeId?: string | null | undefined;
  readonly selectedNodeId?: string | null | undefined;
}): React.JSX.Element {
  const {
    coverage,
    filter,
    onSelectNode,
    onSelectEdge,
    selectedEdgeId,
    selectedNodeId,
  } = props;

  const isEdgeScope = coverage.subjectType === "graph_edge";

  if (isEdgeScope) {
    const itemsToDisplay: Array<{
      item: UncoveredGraphEdgeItem | CoveredGraphEdgeItem;
      isCovered: boolean;
    }> = [];

    if (filter === "all" || filter === "uncovered") {
      for (const item of coverage.uncoveredEdges) {
        itemsToDisplay.push({ item, isCovered: false });
      }
    }
    if (filter === "all" || filter === "covered") {
      for (const item of coverage.coveredEdges) {
        itemsToDisplay.push({ item, isCovered: true });
      }
    }

    if (itemsToDisplay.length === 0) {
      if (filter === "uncovered" && coverage.total > 0 && coverage.uncovered === 0) {
        return React.createElement(
          "div",
          {
            "data-testid": "coverage-all-covered-message",
            className:
              "p-3 bg-emerald-50/70 border border-emerald-200 text-emerald-800 rounded text-center text-xs flex flex-col gap-1",
          },
          React.createElement(
            "span",
            { className: "font-semibold" },
            "All analyzed conclusions have verified evidence.",
          ),
          React.createElement(
            "span",
            { className: "text-[11px] text-emerald-700" },
            "No evidence gaps detected across the loaded graph slice.",
          ),
        );
      }

      return React.createElement(
        "div",
        {
          "data-testid": "coverage-empty-filter-message",
          className:
            "p-3 bg-slate-50 border border-slate-200 text-slate-500 rounded text-center text-xs",
        },
        "No graph edges match the current coverage filter.",
      );
    }

    return React.createElement(
      "div",
      {
        "data-testid": "coverage-edges-list",
        className:
          "max-h-60 overflow-y-auto border border-slate-200 rounded divide-y divide-slate-100 bg-white",
      },
      itemsToDisplay.map(({ item, isCovered }) => {
        const isSelected = selectedEdgeId === item.id;
        const normalizedEdgeConf = normalizeConfidence(item.confidence);
        const confPct = normalizedEdgeConf
          ? normalizedEdgeConf.formattedPercentage
          : `${Math.round(item.confidence * 100)}%`;

        return React.createElement(
          "div",
          {
            key: item.id,
            "data-testid": isCovered
              ? "coverage-covered-item"
              : "coverage-uncovered-item",
            "data-coverage-status": isCovered ? "covered" : "uncovered",
            className: `p-2 flex items-center justify-between gap-3 text-xs hover:bg-slate-50 transition-colors ${
              isSelected ? "bg-blue-50/60 border-l-2 border-blue-500" : ""
            }`,
          },
          // Left: Edge Type, Source -> Target, Confidence & Status Badge
          React.createElement(
            "div",
            { className: "flex items-center gap-2 flex-wrap min-w-0" },
            React.createElement(
              "span",
              {
                className:
                  "text-[10px] font-mono font-bold px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 uppercase",
              },
              item.edgeType,
            ),
            React.createElement(
              "span",
              {
                className: "font-mono text-slate-800 text-[11px] truncate max-w-xs sm:max-w-md",
                title: `${item.sourceName} → ${item.targetName}`,
              },
              `${item.sourceName} → ${item.targetName}`,
            ),
            React.createElement(
              "span",
              {
                className: `text-[10px] font-mono font-medium px-1.5 py-0.2 rounded border ${
                  normalizedEdgeConf?.tier === "high"
                    ? "bg-slate-100 text-slate-700 border-slate-200"
                    : normalizedEdgeConf?.tier === "medium"
                      ? "bg-amber-50 text-amber-800 border-amber-200"
                      : "bg-amber-100/80 text-amber-900 border-amber-300 border-dashed"
                }`,
                title: `Confidence: ${confPct}`,
              },
              confPct,
            ),
            React.createElement(
              "span",
              {
                className: `text-[10px] font-semibold px-1.5 py-0.2 rounded border ${
                  isCovered
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : "bg-rose-50 text-rose-800 border-rose-200"
                }`,
              },
              isCovered ? "Covered" : "Missing Evidence",
            ),
          ),
          // Right: Action button to inspect/highlight in graph
          onSelectEdge !== undefined
            ? React.createElement(
                "button",
                {
                  type: "button",
                  "data-testid": isCovered
                    ? "inspect-covered-edge-button"
                    : "inspect-uncovered-edge-button",
                  onClick: () => onSelectEdge(item.id),
                  className:
                    "shrink-0 px-2 py-0.5 text-[11px] rounded bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 focus:outline-hidden focus:ring-1 focus:ring-blue-500 transition-colors font-medium",
                },
                isSelected ? "Selected" : "Inspect in Graph",
              )
            : null,
        );
      }),
    );
  }

  // PR Impact Findings Scope
  const findingsToDisplay: Array<{
    item: UncoveredImpactFindingItem | CoveredImpactFindingItem;
    isCovered: boolean;
  }> = [];

  if (filter === "all" || filter === "uncovered") {
    for (const item of coverage.uncoveredFindings) {
      findingsToDisplay.push({ item, isCovered: false });
    }
  }
  if (filter === "all" || filter === "covered") {
    for (const item of coverage.coveredFindings) {
      findingsToDisplay.push({ item, isCovered: true });
    }
  }

  if (findingsToDisplay.length === 0) {
    if (filter === "uncovered" && coverage.total > 0 && coverage.uncovered === 0) {
      return React.createElement(
        "div",
        {
          "data-testid": "coverage-all-covered-message",
          className:
            "p-3 bg-emerald-50/70 border border-emerald-200 text-emerald-800 rounded text-center text-xs flex flex-col gap-1",
        },
        React.createElement(
          "span",
          { className: "font-semibold" },
          "All analyzed impact findings have verified evidence.",
        ),
        React.createElement(
          "span",
          { className: "text-[11px] text-emerald-700" },
          "No evidence gaps detected in the PR blast radius.",
        ),
      );
    }

    return React.createElement(
      "div",
      {
        "data-testid": "coverage-empty-filter-message",
        className:
          "p-3 bg-slate-50 border border-slate-200 text-slate-500 rounded text-center text-xs",
      },
      "No impact findings match the current coverage filter.",
    );
  }

  return React.createElement(
    "div",
    {
      "data-testid": "coverage-findings-list",
      className:
        "max-h-60 overflow-y-auto border border-slate-200 rounded divide-y divide-slate-100 bg-white",
    },
    findingsToDisplay.map(({ item, isCovered }) => {
      const isSelected = selectedNodeId === item.nodeId;
      const normalizedFindingConf = normalizeConfidence(item.confidence);
      const confPct = normalizedFindingConf
        ? normalizedFindingConf.formattedPercentage
        : `${Math.round(item.confidence * 100)}%`;

      return React.createElement(
        "div",
        {
          key: `${item.category}-${item.nodeId}`,
          "data-testid": isCovered
            ? "coverage-covered-item"
            : "coverage-uncovered-item",
          "data-coverage-status": isCovered ? "covered" : "uncovered",
          className: `p-2 flex items-center justify-between gap-3 text-xs hover:bg-slate-50 transition-colors ${
            isSelected ? "bg-blue-50/60 border-l-2 border-blue-500" : ""
          }`,
        },
        // Left: Category badge, Node name & type, Confidence, Coverage status
        React.createElement(
          "div",
          { className: "flex items-center gap-2 flex-wrap min-w-0" },
          React.createElement(
            "span",
            {
              className: `text-[10px] font-mono font-bold px-1.5 py-0.2 rounded border uppercase ${
                item.category === "direct"
                  ? "bg-rose-50 text-rose-700 border-rose-200"
                  : item.category === "downstream"
                    ? "bg-amber-50 text-amber-700 border-amber-200"
                    : "bg-indigo-50 text-indigo-700 border-indigo-200"
              }`,
            },
            item.categoryLabel,
          ),
          React.createElement(
            "span",
            {
              className: "font-semibold text-slate-800 text-[11px] truncate max-w-xs sm:max-w-md",
              title: item.name,
            },
            item.name,
          ),
          React.createElement(
            "span",
            { className: "font-mono text-[10px] text-slate-500" },
            `(${item.type}, hop: ${item.hopDistance})`,
          ),
          React.createElement(
            "span",
            {
              className: `text-[10px] font-mono font-medium px-1.5 py-0.2 rounded border ${
                normalizedFindingConf?.tier === "high"
                  ? "bg-slate-100 text-slate-700 border-slate-200"
                  : normalizedFindingConf?.tier === "medium"
                    ? "bg-amber-50 text-amber-800 border-amber-200"
                    : "bg-amber-100/80 text-amber-900 border-amber-300 border-dashed"
              }`,
              title: `Confidence: ${confPct}`,
            },
            confPct,
          ),
          React.createElement(
            "span",
            {
              className: `text-[10px] font-semibold px-1.5 py-0.2 rounded border ${
                isCovered
                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                  : "bg-rose-50 text-rose-800 border-rose-200"
              }`,
            },
            isCovered ? "Covered" : "Missing Evidence",
          ),
        ),
        // Right: Action button to inspect/highlight node in graph
        onSelectNode !== undefined
          ? React.createElement(
              "button",
              {
                type: "button",
                "data-testid": isCovered
                  ? "inspect-covered-finding-button"
                  : "inspect-uncovered-finding-button",
                onClick: () => onSelectNode(item.nodeId),
                className:
                  "shrink-0 px-2 py-0.5 text-[11px] rounded bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 focus:outline-hidden focus:ring-1 focus:ring-blue-500 transition-colors font-medium",
              },
              isSelected ? "Selected" : "Inspect in Graph",
            )
          : null,
      );
    }),
  );
}

