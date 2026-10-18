"use client";

import React, { useState } from "react";
import {
  UUID_REGEX,
  type NormalizedChangeModeState,
} from "./change-mode-data.ts";

export interface ChangeModeBarProps {
  readonly state: NormalizedChangeModeState;
  readonly onToggle: (enabled: boolean) => void;
  readonly onLoadAnalysis: (impactAnalysisId: string) => void;
  readonly onRetry: () => void;
  readonly onClear: () => void;
  readonly className?: string;
}

/**
 * Compact Change-Mode control bar, legend, and summary header (Step 46).
 *
 * Responsibilities:
 * - Clear UX controls to toggle change mode ON / OFF.
 * - Input/button to load a persisted ImpactAnalysis by ID.
 * - Surfaces all change-mode states: idle, loading, ready, empty, error.
 * - Displays compact summary chips: direct, downstream, affected APIs, affected events.
 * - Explains visual legend (direct red, downstream chromatic amber, dashed low-confidence, faded unaffected).
 * - Surfaces unresolved files and truncation warnings explicitly without hiding uncertainty.
 * - Does not perform graph queries or database access directly.
 */
export function ChangeModeBar({
  state,
  onToggle,
  onLoadAnalysis,
  onRetry,
  onClear,
  className,
}: ChangeModeBarProps): React.JSX.Element {
  const [inputId, setInputId] = useState(state.impactAnalysisId ?? "");
  const [showUnresolvedDetails, setShowUnresolvedDetails] = useState(false);

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputId.trim();
    if (trimmed) {
      onLoadAnalysis(trimmed);
    }
  };

  const isUuidValid = UUID_REGEX.test(inputId.trim());

  return React.createElement(
    "section",
    {
      "data-testid": "change-mode-bar",
      className: `px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs flex flex-col gap-2 ${className ?? ""}`,
      "aria-label": "Change Mode Controls",
    },
    // Top Row: Mode Toggle, ID input, Load/Clear buttons, Status indicator
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-2.5" },
      React.createElement(
        "div",
        { className: "flex items-center gap-3 flex-wrap" },
        // Mode Toggle Button
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "change-mode-toggle",
            onClick: () => onToggle(!state.enabled),
            className: `px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
              state.enabled
                ? "bg-amber-600 text-white hover:bg-amber-700 shadow-sm"
                : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"
            }`,
            title: state.enabled ? "Disable Change Mode" : "Enable Change Mode",
          },
          React.createElement("span", {
            className: `w-2 h-2 rounded-full ${state.enabled ? "bg-white" : "bg-slate-400"}`,
          }),
          React.createElement(
            "span",
            null,
            state.enabled ? "Change Mode: ON" : "Change Mode: OFF",
          ),
        ),

        // Impact Analysis ID Input (only interactive when change mode is active)
        state.enabled
          ? React.createElement(
              "form",
              {
                onSubmit: handleInputSubmit,
                className: "flex items-center gap-1.5",
              },
              React.createElement("input", {
                type: "text",
                "data-testid": "change-mode-id-input",
                value: inputId,
                onChange: (e) => setInputId(e.target.value),
                placeholder: "Impact Analysis UUID...",
                className:
                  "font-mono text-xs px-2.5 py-1 border border-slate-300 rounded bg-white w-64 focus:outline-none focus:ring-1 focus:ring-amber-500",
              }),
              React.createElement(
                "button",
                {
                  type: "submit",
                  "data-testid": "change-mode-load-btn",
                  disabled: !isUuidValid || state.status === "loading",
                  className: `px-2.5 py-1 rounded font-medium ${
                    isUuidValid && state.status !== "loading"
                      ? "bg-slate-800 text-white hover:bg-slate-900"
                      : "bg-slate-200 text-slate-400 cursor-not-allowed"
                  }`,
                },
                "Load",
              ),
              state.impactAnalysisId
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "change-mode-clear-btn",
                      onClick: () => {
                        setInputId("");
                        onClear();
                      },
                      className:
                        "px-2 py-1 text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 rounded",
                    },
                    "Clear",
                  )
                : null,
            )
          : null,
      ),

      // Status Badge on the right
      state.enabled
        ? React.createElement(
            "div",
            { className: "flex items-center gap-2", "data-testid": "change-mode-status-container" },
            state.status === "loading"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "change-mode-loading-status",
                    className: "flex items-center gap-1.5 text-amber-700 font-medium",
                  },
                  React.createElement("span", {
                    className:
                      "w-3 h-3 border-2 border-amber-600 border-t-transparent rounded-full animate-spin",
                  }),
                  React.createElement(
                    "span",
                    null,
                    state.executionStatus === "pending" || state.executionStatus === "running"
                      ? `Analysis in progress (${state.executionStatus})...`
                      : "Fetching impact analysis...",
                  ),
                )
              : null,

            state.status === "error"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "change-mode-error-status",
                    className: "flex items-center gap-2 text-red-700 font-medium bg-red-50 px-2 py-0.5 rounded border border-red-200",
                  },
                  React.createElement("span", null, state.errorMessage ?? "Failed to load impact analysis."),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "change-mode-retry-btn",
                      onClick: onRetry,
                      className: "underline hover:text-red-900 font-semibold",
                    },
                    "Retry",
                  ),
                )
              : null,

            state.status === "empty"
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "change-mode-empty-status",
                    className: "text-slate-500 italic",
                  },
                  "Analysis completed with 0 affected nodes.",
                )
              : null,

            state.status === "ready"
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "change-mode-ready-status",
                    className: "text-emerald-700 font-medium flex items-center gap-1",
                  },
                  React.createElement("span", { className: "w-2 h-2 rounded-full bg-emerald-500" }),
                  "Overlay Active",
                )
              : null,
          )
        : React.createElement(
            "span",
            { className: "text-slate-400 italic" },
            "Enter Change Mode to overlay PR blast-radius findings",
          ),
    ),

    // Summary & Legend Row (only when ready and enabled)
    state.enabled && state.status === "ready"
      ? React.createElement(
          "div",
          {
            "data-testid": "change-mode-summary-row",
            className: "flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-200/60",
          },
          // Metric Chips
          React.createElement(
            "div",
            { className: "flex items-center gap-2 flex-wrap", "data-testid": "change-mode-counts" },
            // Direct Count
            React.createElement(
              "span",
              {
                "data-testid": "count-direct",
                className:
                  "px-2 py-0.5 rounded bg-red-100 text-red-800 border border-red-200 font-medium flex items-center gap-1",
              },
              React.createElement("strong", null, state.directCount),
              "Direct Changes",
            ),
            // Downstream Count
            React.createElement(
              "span",
              {
                "data-testid": "count-downstream",
                className:
                  "px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 font-medium flex items-center gap-1",
              },
              React.createElement("strong", null, state.downstreamCount),
              "Downstream Impact",
            ),
            // Affected APIs
            state.affectedApiCount > 0
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "count-apis",
                    className:
                      "px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-medium flex items-center gap-1",
                  },
                  React.createElement("strong", null, state.affectedApiCount),
                  "APIs",
                )
              : null,
            // Affected Events
            state.affectedEventCount > 0
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "count-events",
                    className:
                      "px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200 font-medium flex items-center gap-1",
                  },
                  React.createElement("strong", null, state.affectedEventCount),
                  "Events",
                )
              : null,
            // Unresolved Files Warning
            state.unresolvedFiles.length > 0
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    "data-testid": "count-unresolved",
                    onClick: () => setShowUnresolvedDetails((prev) => !prev),
                    className:
                      "px-2 py-0.5 rounded bg-orange-100 text-orange-800 border border-orange-200 font-medium flex items-center gap-1 hover:bg-orange-200 transition-colors cursor-pointer",
                    title: "Click to toggle unresolved files details",
                  },
                  React.createElement("strong", null, state.unresolvedFiles.length),
                  "Unresolved Files ⚠️",
                )
              : null,
            // Truncation Warning
            state.truncated
              ? React.createElement(
                  "span",
                  {
                    "data-testid": "indicator-truncated",
                    className:
                      "px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-300 font-medium flex items-center gap-1",
                    title: state.truncationReason ?? "Max traversal depth ceiling reached",
                  },
                  "⚠️ Truncated (Depth ",
                  state.maxDepthReached,
                  ")",
                )
              : null,
          ),

          // Legend Guide
          React.createElement(
            "div",
            {
              "data-testid": "change-mode-legend",
              className: "flex items-center gap-3 text-[11px] text-slate-500 flex-wrap",
            },
            React.createElement(
              "span",
              { className: "flex items-center gap-1" },
              React.createElement("span", {
                className: "inline-block w-2.5 h-2.5 rounded bg-red-500 border border-red-700",
              }),
              "Direct",
            ),
            React.createElement(
              "span",
              { className: "flex items-center gap-1" },
              React.createElement("span", {
                className: "inline-block w-2.5 h-2.5 rounded bg-amber-500 border border-amber-600",
              }),
              "Downstream (Hop 1–N)",
            ),
            React.createElement(
              "span",
              { className: "flex items-center gap-1" },
              React.createElement("span", {
                className: "inline-block w-3 h-0 border-t-2 border-dashed border-amber-500",
              }),
              "Low Confidence (< 70%)",
            ),
            React.createElement(
              "span",
              { className: "flex items-center gap-1 opacity-70" },
              React.createElement("span", {
                className: "inline-block w-2.5 h-2.5 rounded bg-slate-300 border border-slate-400",
              }),
              "Unaffected (Faded)",
            ),
          ),
        )
      : null,

    // Expandable Unresolved Files Box
    showUnresolvedDetails && state.unresolvedFiles.length > 0
      ? React.createElement(
          "div",
          {
            "data-testid": "unresolved-files-panel",
            className:
              "p-2.5 bg-orange-50 border border-orange-200 rounded text-xs flex flex-col gap-1.5 mt-1",
          },
          React.createElement(
            "div",
            { className: "font-semibold text-orange-900 flex justify-between items-center" },
            React.createElement("span", null, "Unresolved Changed Files (outside parsed graph):"),
            React.createElement(
              "button",
              {
                type: "button",
                onClick: () => setShowUnresolvedDetails(false),
                className: "text-orange-700 hover:text-orange-900 text-[11px]",
              },
              "Close",
            ),
          ),
          React.createElement(
            "ul",
            { className: "divide-y divide-orange-200/60 max-h-36 overflow-y-auto space-y-1" },
            ...state.unresolvedFiles.map((file) =>
              React.createElement(
                "li",
                {
                  key: file.path,
                  "data-testid": `unresolved-file-${file.path}`,
                  className: "pt-1 text-[11px] text-orange-800 flex justify-between gap-2",
                },
                React.createElement("span", { className: "font-mono break-all" }, file.path),
                React.createElement(
                  "span",
                  { className: "text-orange-600 italic shrink-0" },
                  file.reason,
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

