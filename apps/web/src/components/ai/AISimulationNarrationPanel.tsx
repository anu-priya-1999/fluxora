"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  AIAnalysisResponse,
  GraphQueryResponseEvidence,
  SimulationStatus,
} from "@fluxora/shared-types";
import { EvidenceCitationList } from "../graph/EvidenceCitation.tsx";
import { getSimulationApi } from "../simulation/simulation-api.ts";
import { fetchAIAnalysis } from "./ai-analysis-data.ts";

export const MAX_AI_DISCOVERY_ATTEMPTS = 5;
export const AI_DISCOVERY_INTERVAL_MS = 2000;

export interface AISimulationNarrationPanelProps {
  /**
   * The API base URL.
   */
  readonly apiUrl?: string | undefined;
  /**
   * Clerk token getter for authenticated requests.
   */
  readonly getToken?: (() => Promise<string | null>) | undefined;
  /**
   * Active simulation ID.
   */
  readonly simulationId?: string | null | undefined;
  /**
   * Associated AI Analysis ID (discovered from simulation response).
   */
  readonly aiAnalysisId?: string | null | undefined;
  /**
   * Current execution status of the deterministic simulation run.
   */
  readonly simulationStatus?: SimulationStatus | undefined;
  /**
   * Pre-loaded AI analysis data (for controlled unit testing or initial state).
   */
  readonly initialData?: AIAnalysisResponse | null | undefined;
  /**
   * Array of evidence records from the deterministic simulation pool.
   */
  readonly evidencePool?: readonly GraphQueryResponseEvidence[] | undefined;
  /**
   * Provenance context properties passed to EvidenceCitation.
   */
  readonly repositoryName?: string | null | undefined;
  readonly commitSha?: string | null | undefined;
  readonly gitRef?: string | null | undefined;
  readonly analysisRunId?: string | null | undefined;
  /**
   * Additional container CSS classes.
   */
  readonly className?: string | undefined;
  /**
   * Optional callback when an AI analysis ID is discovered via polling.
   */
  readonly onAIAnalysisDiscovered?: ((aiAnalysisId: string, aiAnalysisStatus?: string | null) => void) | undefined;
}

export function AISimulationNarrationPanel({
  apiUrl,
  getToken,
  simulationId,
  aiAnalysisId,
  simulationStatus,
  initialData,
  evidencePool,
  repositoryName,
  commitSha,
  gitRef,
  analysisRunId,
  className,
  onAIAnalysisDiscovered,
}: AISimulationNarrationPanelProps): React.JSX.Element {
  const [data, setData] = useState<AIAnalysisResponse | null>(initialData ?? null);
  const [discoveredAiAnalysisId, setDiscoveredAiAnalysisId] = useState<string | null>(null);
  const effectiveAiAnalysisId = aiAnalysisId ?? discoveredAiAnalysisId;
  const [isLoading, setIsLoading] = useState<boolean>(!initialData && Boolean(effectiveAiAnalysisId));
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [discoveryCycle, setDiscoveryCycle] = useState<number>(0);
  const [isDiscovering, setIsDiscovering] = useState<boolean>(false);
  const isDiscoveringRef = useRef<boolean>(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryAttemptsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const inFlightIdRef = useRef<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  const clearPollTimer = () => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const clearDiscoveryTimer = () => {
    if (discoveryTimerRef.current !== null) {
      clearTimeout(discoveryTimerRef.current);
      discoveryTimerRef.current = null;
    }
  };

  const loadData = useCallback(async () => {
    if (!apiUrl || !getToken || !effectiveAiAnalysisId) {
      return;
    }

    if (inFlightIdRef.current === effectiveAiAnalysisId) {
      return;
    }

    clearPollTimer();
    setFetchError(null);
    inFlightIdRef.current = effectiveAiAnalysisId;

    const requestId = `${effectiveAiAnalysisId}-${Date.now()}`;
    activeRequestIdRef.current = requestId;

    try {
      const result = await fetchAIAnalysis({
        apiUrl,
        aiAnalysisId: effectiveAiAnalysisId,
        getToken,
      });

      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      if (!result.ok) {
        setIsLoading(false);
        setFetchError(result.message);
        return;
      }

      setData(result.data);
      setIsLoading(false);

      if (result.data.status === "pending") {
        pollTimerRef.current = setTimeout(() => {
          if (isMountedRef.current && activeRequestIdRef.current === requestId) {
            void loadData();
          }
        }, 2500);
      }
    } finally {
      inFlightIdRef.current = null;
    }
  }, [apiUrl, effectiveAiAnalysisId, getToken]);

  const handleCheckAgain = useCallback(() => {
    if (isDiscoveringRef.current) {
      return;
    }
    clearDiscoveryTimer();
    discoveryAttemptsRef.current = 0;
    setDiscoveryCycle((prev) => prev + 1);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPollTimer();
      clearDiscoveryTimer();
    };
  }, []);

  // Discovery effect: when simulation completes but aiAnalysisId is not yet linked,
  // poll GET /api/v1/simulations/:id until the worker creates the pending record.
  useEffect(() => {
    if (aiAnalysisId) {
      setDiscoveredAiAnalysisId(null);
      clearDiscoveryTimer();
      discoveryAttemptsRef.current = 0;
      setIsDiscovering(false);
      isDiscoveringRef.current = false;
      return;
    }

    if (
      !apiUrl ||
      !getToken ||
      !simulationId ||
      effectiveAiAnalysisId ||
      initialData ||
      simulationStatus === "pending" ||
      simulationStatus === "running"
    ) {
      clearDiscoveryTimer();
      setIsDiscovering(false);
      isDiscoveringRef.current = false;
      return;
    }

    let isCancelled = false;
    discoveryAttemptsRef.current = 0;
    setIsDiscovering(true);
    isDiscoveringRef.current = true;

    const pollDiscovery = async () => {
      if (isCancelled || !isMountedRef.current) return;
      if (discoveryAttemptsRef.current >= MAX_AI_DISCOVERY_ATTEMPTS) {
        clearDiscoveryTimer();
        setIsDiscovering(false);
        isDiscoveringRef.current = false;
        return;
      }

      discoveryAttemptsRef.current += 1;

      try {
        const simResult = await getSimulationApi({
          apiUrl,
          simulationId,
          getToken,
        });

        if (isCancelled || !isMountedRef.current) return;

        if (simResult.ok && simResult.data) {
          const foundId = simResult.data.ai_analysis_id;
          const foundStatus = simResult.data.ai_analysis_status ?? null;

          if (foundId && typeof foundId === "string") {
            setDiscoveredAiAnalysisId(foundId);
            onAIAnalysisDiscovered?.(foundId, foundStatus);
            clearDiscoveryTimer();
            setIsDiscovering(false);
            isDiscoveringRef.current = false;
            return;
          }
        }
      } catch {
        // Non-fatal: retry next tick
      }

      if (
        !isCancelled &&
        isMountedRef.current &&
        discoveryAttemptsRef.current < MAX_AI_DISCOVERY_ATTEMPTS
      ) {
        discoveryTimerRef.current = setTimeout(() => {
          void pollDiscovery();
        }, AI_DISCOVERY_INTERVAL_MS);
      } else {
        clearDiscoveryTimer();
        setIsDiscovering(false);
        isDiscoveringRef.current = false;
      }
    };

    discoveryTimerRef.current = setTimeout(() => {
      void pollDiscovery();
    }, AI_DISCOVERY_INTERVAL_MS);

    return () => {
      isCancelled = true;
      clearDiscoveryTimer();
      setIsDiscovering(false);
      isDiscoveringRef.current = false;
    };
  }, [
    apiUrl,
    getToken,
    simulationId,
    aiAnalysisId,
    effectiveAiAnalysisId,
    initialData,
    simulationStatus,
    onAIAnalysisDiscovered,
    discoveryCycle,
  ]);

  useEffect(() => {
    if (!effectiveAiAnalysisId) {
      if (!initialData) {
        setData(null);
      }
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    void loadData();

    return () => {
      clearPollTimer();
    };
  }, [effectiveAiAnalysisId, initialData, loadData]);

  // 1. State: Waiting for deterministic simulation to complete
  if (simulationStatus === "pending" || simulationStatus === "running") {
    return React.createElement(
      "section",
      {
        "data-testid": "ai-simulation-narration-panel",
        "data-simulation-id": simulationId ?? undefined,
        className: `p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs flex flex-col gap-2 ${className ?? ""}`,
        "aria-label": "AI Simulation Narration",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(SimulationDisclaimer, null),
      React.createElement(
        "div",
        {
          "data-testid": "ai-state-waiting-for-simulation",
          className: "flex items-center gap-2 py-2 text-slate-500 italic",
        },
        React.createElement("span", {
          className:
            "inline-block w-2.5 h-2.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin",
        }),
        React.createElement(
          "span",
          null,
          "Waiting for deterministic simulation execution to complete...",
        ),
      ),
    );
  }

  // 2. State: Initial loading or active polling while AI narration is pending
  if (isLoading || data?.status === "pending") {
    return React.createElement(
      "section",
      {
        "data-testid": "ai-simulation-narration-panel",
        "data-simulation-id": simulationId ?? undefined,
        className: `p-3.5 bg-indigo-50/40 border border-indigo-100 rounded-lg text-xs flex flex-col gap-2 ${className ?? ""}`,
        "aria-label": "AI Simulation Narration",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(SimulationDisclaimer, null),
      React.createElement(
        "div",
        {
          "data-testid": "ai-state-pending",
          className: "flex items-center gap-2 py-2 text-indigo-700",
        },
        React.createElement("span", {
          className:
            "inline-block w-2.5 h-2.5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin",
        }),
        React.createElement(
          "span",
          { className: "font-medium" },
          "Generating evidence-grounded simulation narration...",
        ),
      ),
    );
  }

  // 3. State: Fetch/Network Error
  if (fetchError) {
    return React.createElement(
      "section",
      {
        "data-testid": "ai-simulation-narration-panel",
        "data-simulation-id": simulationId ?? undefined,
        className: `p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs flex flex-col gap-2 ${className ?? ""}`,
        "aria-label": "AI Simulation Narration",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(SimulationDisclaimer, null),
      React.createElement(
        "div",
        {
          "data-testid": "ai-state-error",
          className:
            "flex items-center justify-between gap-2 p-2 bg-amber-50 border border-amber-200 text-amber-800 rounded",
        },
        React.createElement(
          "span",
          null,
          `Failed to load AI narration: ${fetchError}`,
        ),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => void loadData(),
            className:
              "px-2 py-0.5 text-[11px] font-semibold bg-white border border-amber-300 rounded hover:bg-amber-100 text-amber-900 cursor-pointer",
          },
          "Retry",
        ),
      ),
    );
  }

  // 4. State: No AI Analysis record available
  if (!data) {
    const canCheckAgain = Boolean(
      apiUrl &&
        getToken &&
        simulationId &&
        !effectiveAiAnalysisId,
    );

    return React.createElement(
      "section",
      {
        "data-testid": "ai-simulation-narration-panel",
        "data-simulation-id": simulationId ?? undefined,
        className: `p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs flex flex-col gap-2 ${className ?? ""}`,
        "aria-label": "AI Simulation Narration",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(SimulationDisclaimer, null),
      React.createElement(
        "div",
        {
          "data-testid": "ai-state-unavailable",
          className:
            "flex items-center justify-between gap-2 py-1 text-slate-500",
        },
        React.createElement(
          "span",
          { className: "italic" },
          "No AI narration available for this simulation.",
        ),
        canCheckAgain
          ? React.createElement(
              "button",
              {
                type: "button",
                "data-testid": "ai-check-again-btn",
                onClick: handleCheckAgain,
                disabled: isDiscovering,
                className:
                  "not-italic px-2 py-0.5 text-[11px] font-semibold bg-white border border-slate-300 rounded hover:bg-slate-100 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus:outline-none focus:ring-1 focus:ring-slate-400",
                "aria-label": "Check again for AI narration",
              },
              isDiscovering ? "Checking..." : "Check again",
            )
          : null,
      ),
    );
  }

  // 5. State: Validation Rejected (ADR-014)
  if (data.status === "rejected" || data.validation_status === "rejected") {
    return React.createElement(
      "section",
      {
        "data-testid": "ai-simulation-narration-panel",
        "data-simulation-id": simulationId ?? undefined,
        className: `p-3.5 bg-amber-50/60 border border-amber-200 rounded-lg text-xs flex flex-col gap-2 ${className ?? ""}`,
        "aria-label": "AI Simulation Narration",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(SimulationDisclaimer, null),
      React.createElement(
        "div",
        {
          "data-testid": "ai-state-rejected",
          className:
            "p-2.5 bg-white border border-amber-200/80 rounded text-amber-900 flex flex-col gap-1",
        },
        React.createElement(
          "div",
          {
            className:
              "font-semibold text-amber-950 flex items-center gap-1.5",
          },
          React.createElement(
            "span",
            { className: "text-amber-600 font-bold" },
            "⚠",
          ),
          React.createElement("span", null, "Simulation Narration Rejected"),
        ),
        React.createElement(
          "p",
          { className: "text-[11px] text-amber-800 leading-relaxed" },
          "The AI-generated narration was rejected because its claims cited evidence outside the verified simulation evidence manifest. Raw ungrounded model narrations are withheld to preserve model integrity. Deterministic simulation results remain fully valid and accessible below.",
        ),
      ),
    );
  }

  // 6. State: Generation / Provider Failed
  if (data.status === "failed") {
    return React.createElement(
      "section",
      {
        "data-testid": "ai-simulation-narration-panel",
        "data-simulation-id": simulationId ?? undefined,
        className: `p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs flex flex-col gap-2 ${className ?? ""}`,
        "aria-label": "AI Simulation Narration",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(SimulationDisclaimer, null),
      React.createElement(
        "div",
        {
          "data-testid": "ai-state-failed",
          className:
            "p-2.5 bg-white border border-slate-200 rounded text-slate-700 flex flex-col gap-1",
        },
        React.createElement(
          "span",
          { className: "font-semibold text-slate-800" },
          "Simulation Narration Unavailable",
        ),
        React.createElement(
          "p",
          { className: "text-[11px] text-slate-600 leading-relaxed" },
          "Simulation narration encountered a provider or system error. Deterministic findings are unaffected and available below.",
        ),
      ),
    );
  }

  // 7. State: Successful, Grounded Simulation Narration
  const structured = data.output_structured;
  const summary = data.output_text ?? structured?.summary ?? "";
  const claims = structured?.claims ?? [];
  const caveats = structured?.caveats ?? [];
  const modelConfidence = structured?.confidence ?? "medium";

  const confidenceColorClasses =
    modelConfidence === "high"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : modelConfidence === "medium"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : "bg-rose-50 text-rose-800 border-rose-200";

  return React.createElement(
    "section",
    {
      "data-testid": "ai-simulation-narration-panel",
      "data-simulation-id": simulationId ?? undefined,
      className: `p-4 bg-gradient-to-br from-indigo-50/30 to-slate-50 border border-indigo-200/80 rounded-lg text-xs flex flex-col gap-3 shadow-sm ${className ?? ""}`,
      "aria-label": "AI Simulation Narration",
    },
    // Header Row with Narration badge & Model Confidence
    React.createElement(
      "div",
      {
        className:
          "flex items-center justify-between border-b border-indigo-100 pb-2 flex-wrap gap-2",
      },
      React.createElement(HeaderBadge, null),
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement(
          "span",
          {
            "data-testid": "ai-model-confidence",
            "data-confidence": modelConfidence,
            className: `px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${confidenceColorClasses}`,
            title:
              "Model-assessed confidence in the natural-language narration, distinct from deterministic simulation confidence metrics.",
          },
          `Model Confidence: ${modelConfidence}`,
        ),
        data.model_used
          ? React.createElement(
              "span",
              {
                "data-testid": "ai-model-used",
                className: "font-mono text-[10px] text-slate-400",
              },
              data.model_used,
            )
          : null,
      ),
    ),

    // Simulation vs. Production Reality Disclaimer Banner
    React.createElement(SimulationDisclaimer, null),

    // Summary Narrative
    React.createElement(
      "div",
      { className: "flex flex-col gap-1" },
      React.createElement(
        "span",
        { className: "font-semibold text-slate-900 text-xs" },
        "Simulation Summary",
      ),
      React.createElement(
        "p",
        {
          "data-testid": "ai-narration-summary",
          className:
            "text-slate-800 text-[11px] leading-relaxed bg-white/80 p-2.5 rounded border border-indigo-100/60",
        },
        summary,
      ),
    ),

    // Grounded Claims with Citations
    React.createElement(
      "div",
      { className: "flex flex-col gap-1.5" },
      React.createElement(
        "span",
        { className: "font-semibold text-slate-900 text-xs" },
        "Component Claims & Causal Evidence Citations",
      ),
      claims.length === 0
        ? React.createElement(
            "div",
            {
              "data-testid": "ai-claims-empty",
              className:
                "text-slate-500 italic text-[11px] p-2 bg-white/60 rounded border border-slate-200",
            },
            "No component claims generated in this simulation narration.",
          )
        : React.createElement(
            "div",
            {
              "data-testid": "ai-narration-claims",
              className: "flex flex-col gap-2",
            },
            ...claims.map((claim, index) =>
              React.createElement(
                "div",
                {
                  key: `claim-${index}`,
                  "data-testid": `ai-claim-item-${index}`,
                  className:
                    "p-2.5 bg-white border border-slate-200 rounded flex flex-col gap-1.5 shadow-2xs",
                },
                React.createElement(
                  "div",
                  {
                    "data-testid": "ai-claim-text",
                    className:
                      "text-slate-800 text-[11px] font-medium leading-normal",
                  },
                  claim.text,
                ),
                React.createElement(
                  "div",
                  { className: "pt-0.5" },
                  React.createElement(EvidenceCitationList, {
                    evidenceIds: claim.evidence_ids,
                    evidencePool,
                    mode: "compact",
                    repositoryName,
                    commitSha,
                    gitRef,
                    analysisRunId,
                  }),
                ),
              ),
            ),
          ),
    ),

    // Caveats & Truncation Warnings
    caveats.length > 0
      ? React.createElement(
          "div",
          {
            className:
              "flex flex-col gap-1 border-t border-indigo-100/60 pt-2",
          },
          React.createElement(
            "span",
            { className: "font-semibold text-slate-700 text-[11px]" },
            "Simulation Caveats & Boundaries",
          ),
          React.createElement(
            "ul",
            {
              "data-testid": "ai-narration-caveats",
              className:
                "list-disc list-inside text-slate-600 text-[10.5px] space-y-0.5",
            },
            ...caveats.map((caveat, index) =>
              React.createElement("li", { key: `caveat-${index}` }, caveat),
            ),
          ),
        )
      : null,
  );
}

function HeaderBadge(): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex items-center gap-2" },
    React.createElement(
      "span",
      { className: "font-bold text-slate-900 text-xs tracking-tight" },
      "AI Simulation Narration",
    ),
    React.createElement(
      "span",
      {
        "data-testid": "ai-narration-badge",
        className:
          "px-1.5 py-0.2 rounded text-[9.5px] font-semibold uppercase tracking-wider bg-purple-100 text-purple-800 border border-purple-200",
      },
      "AI Narration",
    ),
  );
}

function SimulationDisclaimer(): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-testid": "ai-simulation-disclaimer",
      className:
        "p-2 bg-purple-50/70 border border-purple-200/80 rounded text-purple-900 text-[10.5px] leading-relaxed flex items-start gap-1.5",
    },
    React.createElement(
      "span",
      { className: "font-bold text-purple-700", "aria-hidden": "true" },
      "ℹ",
    ),
    React.createElement(
      "span",
      null,
      "Simulated Scenario Notice: This narration describes a deterministic failure simulation experiment computed via static graph traversal, not an observed production incident.",
    ),
  );
}
