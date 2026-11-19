import React, { useState } from "react";
import {
  UUID_REGEX,
  type NormalizedSimulationModeState,
} from "./simulation-mode-data.ts";

export interface SimulationModeBarProps {
  readonly state: NormalizedSimulationModeState;
  readonly onToggle: (enabled: boolean) => void;
  readonly onLoadSimulation: (simulationId: string) => void;
  readonly onRetry: () => void;
  readonly onClear: () => void;
  readonly onSelectNode?: (nodeId: string) => void;
  readonly analysisRunId?: string | null | undefined;
  readonly className?: string;
}

/**
 * Simulation Mode Control Bar, Legend, and Summary Header (Step 57).
 *
 * Responsibilities:
 * - Mode toggle (ON / OFF).
 * - Input/button to load a persisted Simulation by UUID.
 * - Displays loading, ready, empty, and error states.
 * - Summary metric chips: Total Affected, Failed, Degraded, At Risk, Healthy, Capped.
 * - Visual legend explaining canonical simulation states and the neutral treatment of unreached nodes.
 * - Displays honest simulation confidence notice.
 * - Does not perform graph queries or database access directly.
 */
export function SimulationModeBar({
  state,
  onToggle,
  onLoadSimulation,
  onRetry,
  onClear,
  analysisRunId,
  className,
}: SimulationModeBarProps): React.JSX.Element {
  const [prevSimulationId, setPrevSimulationId] = useState(state.simulationId);
  const [inputId, setInputId] = useState(state.simulationId ?? "");
  const [showLegend, setShowLegend] = useState(false);

  // Synchronize internal input state when parent updates or clears simulationId (React pattern for prop adjustment)
  if (state.simulationId !== prevSimulationId) {
    setPrevSimulationId(state.simulationId);
    setInputId(state.simulationId ?? "");
  }

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputId.trim();
    if (trimmed) {
      onLoadSimulation(trimmed);
    }
  };

  const isUuidValid = UUID_REGEX.test(inputId.trim());

  return React.createElement(
    "section",
    {
      "data-testid": "simulation-mode-bar",
      className: `px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs flex flex-col gap-2 ${className ?? ""}`,
      "aria-label": "Simulation Mode Controls",
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
            "data-testid": "simulation-mode-toggle",
            onClick: () => onToggle(!state.enabled),
            className: `px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
              state.enabled
                ? "bg-purple-700 text-white hover:bg-purple-800 shadow-sm"
                : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"
            }`,
            title: state.enabled ? "Disable Simulation Mode" : "Enable Simulation Mode",
          },
          React.createElement("span", {
            className: `w-2 h-2 rounded-full ${state.enabled ? "bg-white" : "bg-slate-400"}`,
          }),
          React.createElement(
            "span",
            null,
            state.enabled ? "Simulation Mode: ON" : "Simulation Mode: OFF",
          ),
        ),

        // Simulation ID Input (interactive when enabled)
        state.enabled
          ? React.createElement(
              "form",
              {
                onSubmit: handleInputSubmit,
                className: "flex items-center gap-1.5",
              },
              React.createElement("input", {
                type: "text",
                "data-testid": "simulation-mode-id-input",
                value: inputId,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInputId(e.target.value),
                placeholder: "Simulation UUID...",
                className: `px-2 py-1 font-mono text-xs border rounded w-64 focus:outline-none focus:ring-1 ${
                  inputId.trim() && !isUuidValid
                    ? "border-red-300 bg-red-50 focus:ring-red-400"
                    : "border-slate-300 bg-white focus:ring-purple-500"
                }`,
              }),
              React.createElement(
                "button",
                {
                  type: "submit",
                  "data-testid": "simulation-mode-load-btn",
                  disabled: !isUuidValid || state.status === "loading",
                  className:
                    "px-2.5 py-1 bg-purple-600 text-white rounded font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
                },
                state.status === "loading" ? "Loading..." : "Load",
              ),
              state.simulationId
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "simulation-mode-clear-btn",
                      onClick: onClear,
                      className:
                        "px-2 py-1 bg-white border border-slate-300 text-slate-700 rounded hover:bg-slate-100 transition-colors",
                    },
                    "Clear",
                  )
                : null,
            )
          : null,
      ),

      // Status indicator / actions on the right
      state.enabled
        ? React.createElement(
            "div",
            { className: "flex items-center gap-2" },
            state.status === "loading"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "simulation-status-loading",
                    className: "flex items-center gap-1.5 text-slate-600",
                  },
                  React.createElement("span", {
                    className:
                      "w-3.5 h-3.5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin",
                  }),
                  React.createElement("span", null, "Retrieving simulation results..."),
                )
              : null,

            state.status === "pending"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "simulation-status-pending",
                    className: "flex items-center gap-2 text-slate-600",
                  },
                  React.createElement("span", {
                    className:
                      "w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-medium" },
                    "Simulation pending execution...",
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "simulation-refresh-btn",
                      onClick: onRetry,
                      className:
                        "px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-semibold ml-1 transition-colors",
                    },
                    "Refresh",
                  ),
                )
              : null,

            state.status === "running"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "simulation-status-running",
                    className: "flex items-center gap-2 text-purple-700",
                  },
                  React.createElement("span", {
                    className:
                      "w-3.5 h-3.5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-medium" },
                    "Simulation is running...",
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "simulation-refresh-btn",
                      onClick: onRetry,
                      className:
                        "px-2 py-0.5 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-300 rounded text-xs font-semibold ml-1 transition-colors",
                    },
                    "Refresh",
                  ),
                )
              : null,

            state.status === "ready"
              ? React.createElement(
                  "div",
                  { className: "flex items-center gap-2" },
                  React.createElement(
                    "span",
                    {
                      "data-testid": "simulation-status-ready",
                      className:
                        "px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold text-xs border border-emerald-300",
                    },
                    "Ready",
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "simulation-legend-toggle",
                      onClick: () => setShowLegend(!showLegend),
                      className:
                        "text-xs text-slate-600 hover:text-slate-900 underline ml-1",
                    },
                    showLegend ? "Hide Legend" : "Show Legend",
                  ),
                )
              : null,

            state.status === "empty"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "simulation-status-empty",
                    className: "text-amber-700 font-medium",
                  },
                  state.converged === true
                    ? "Simulation converged with 0 affected nodes."
                    : "Completed with no result nodes.",
                )
              : null,

            state.status === "error"
              ? React.createElement(
                  "div",
                  {
                    "data-testid": "simulation-status-error",
                    className: "flex items-center gap-2 text-red-700",
                  },
                  React.createElement(
                    "span",
                    { className: "font-semibold" },
                    state.errorMessage ?? "Failed to load simulation.",
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-testid": "simulation-retry-btn",
                      onClick: onRetry,
                      className:
                        "px-2 py-0.5 bg-red-100 hover:bg-red-200 text-red-800 border border-red-300 rounded text-xs font-semibold",
                    },
                    "Retry",
                  ),
                )
              : null,
          )
        : null,
    ),

    // Middle Row: Ready State Metrics Summary Chips
    state.enabled && state.status === "ready"
      ? React.createElement(
          "div",
          {
            "data-testid": "simulation-summary-chips",
            className: "flex items-center gap-2 flex-wrap pt-1 border-t border-slate-200",
          },
          React.createElement(
            "span",
            {
              "data-testid": "simulation-chip-total",
              className: "px-2 py-0.5 rounded bg-slate-100 border border-slate-300 text-slate-800 font-medium",
            },
            `Total Results: ${state.totalResultsCount}`,
          ),
          React.createElement(
            "span",
            {
              "data-testid": "simulation-chip-failed",
              className: "px-2 py-0.5 rounded bg-red-100 border border-red-300 text-red-800 font-semibold",
            },
            `Failed: ${state.failedCount}`,
          ),
          React.createElement(
            "span",
            {
              "data-testid": "simulation-chip-degraded",
              className: "px-2 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-800 font-semibold",
            },
            `Degraded: ${state.degradedCount}`,
          ),
          React.createElement(
            "span",
            {
              "data-testid": "simulation-chip-at-risk",
              className: "px-2 py-0.5 rounded bg-yellow-100 border border-yellow-300 text-yellow-800 font-semibold",
            },
            `At Risk: ${state.atRiskCount}`,
          ),
          React.createElement(
            "span",
            {
              "data-testid": "simulation-chip-healthy",
              className: "px-2 py-0.5 rounded bg-emerald-100 border border-emerald-300 text-emerald-800 font-semibold",
            },
            `Healthy: ${state.healthyCount}`,
          ),
          state.cappedCount > 0
            ? React.createElement(
                "span",
                {
                  "data-testid": "simulation-chip-capped",
                  className: "px-2 py-0.5 rounded bg-indigo-100 border border-indigo-300 text-indigo-800 font-semibold",
                },
                `Capped (Breakers): ${state.cappedCount}`,
              )
            : null,
          state.causalEdgeIds.size > 0
            ? React.createElement(
                "span",
                {
                  "data-testid": "simulation-chip-causal-edges",
                  className: "px-2 py-0.5 rounded bg-purple-100 border border-purple-300 text-purple-800 font-medium",
                },
                `Causal Edges: ${state.causalEdgeIds.size}`,
              )
            : null,
          state.ruleTableVersion
            ? React.createElement(
                "span",
                {
                  "data-testid": "simulation-chip-rule-table",
                  className: "text-slate-500 font-mono text-[11px] ml-auto",
                },
                `Rule Table v${state.ruleTableVersion}`,
              )
            : null,
          analysisRunId
            ? React.createElement(
                "span",
                {
                  "data-testid": "simulation-chip-run-id",
                  className: "text-slate-400 font-mono text-[10px]",
                },
                `Snapshot: ${analysisRunId.slice(0, 8)}...`,
              )
            : null,
        )
      : null,

    // Bottom Row: Notice & Optional Legend
    state.enabled && state.status === "ready"
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-1.5 pt-1 text-slate-600" },
          React.createElement(
            "p",
            {
              "data-testid": "simulation-confidence-notice",
              className: "text-[11px] text-slate-500 italic",
            },
            "Simulation confidence reflects deterministic rule confidence and static metadata assumptions. It is not a real-world failure probability.",
          ),
          showLegend
            ? React.createElement(
                "div",
                {
                  "data-testid": "simulation-visual-legend",
                  className:
                    "bg-white border border-slate-200 rounded p-2.5 flex flex-wrap gap-4 text-xs mt-1",
                },
                React.createElement(
                  "div",
                  { className: "flex items-center gap-1.5" },
                  React.createElement("span", {
                    className: "w-3 h-3 rounded-full bg-red-600 inline-block",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-semibold text-slate-800" },
                    "Failed:",
                  ),
                  React.createElement("span", null, "Component failure"),
                ),
                React.createElement(
                  "div",
                  { className: "flex items-center gap-1.5" },
                  React.createElement("span", {
                    className: "w-3 h-3 rounded-full bg-amber-600 inline-block",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-semibold text-slate-800" },
                    "Degraded:",
                  ),
                  React.createElement("span", null, "Component has degraded behavior"),
                ),
                React.createElement(
                  "div",
                  { className: "flex items-center gap-1.5" },
                  React.createElement("span", {
                    className: "w-3 h-3 rounded-full bg-yellow-500 inline-block",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-semibold text-slate-800" },
                    "At Risk:",
                  ),
                  React.createElement("span", null, "Component is exposed to propagated risk"),
                ),
                React.createElement(
                  "div",
                  { className: "flex items-center gap-1.5" },
                  React.createElement("span", {
                    className: "w-3 h-3 rounded-full bg-emerald-600 inline-block",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-semibold text-slate-800" },
                    "Healthy:",
                  ),
                  React.createElement("span", null, "Explicit healthy simulation result"),
                ),
                React.createElement(
                  "div",
                  { className: "flex items-center gap-1.5" },
                  React.createElement("span", {
                    className: "w-3 h-3 rounded-full border border-slate-400 bg-white inline-block",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-semibold text-slate-600" },
                    "No Result:",
                  ),
                  React.createElement(
                    "span",
                    null,
                    "Neutral / not reached (normal appearance, not assumed healthy)",
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "flex items-center gap-1.5" },
                  React.createElement("span", {
                    className: "w-4 h-0.5 bg-red-500 inline-block",
                  }),
                  React.createElement(
                    "span",
                    { className: "font-semibold text-slate-800" },
                    "Red Edge:",
                  ),
                  React.createElement("span", null, "Causal propagation path"),
                ),
              )
            : null,
        )
      : null,
  );
}
