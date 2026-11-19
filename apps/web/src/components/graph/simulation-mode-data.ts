import type {
  SimulationCausalStep,
  SimulationResponse,
  SimulationResultResponse,
  SimulationResultsListResponse,
  SimulationResultState,
  SimulationStatus,
} from "@fluxora/shared-types";
import type { CanvasInputNode } from "./graph-mapping.ts";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CANONICAL_SIMULATION_STATES: readonly SimulationResultState[] = [
  "failed",
  "degraded",
  "at_risk",
  "healthy",
] as const;

export const SIMULATION_STATE_SEVERITY: Readonly<Record<SimulationResultState, number>> = {
  failed: 4,
  degraded: 3,
  at_risk: 2,
  healthy: 1,
};

export function isCanonicalSimulationState(value: unknown): value is SimulationResultState {
  return (
    typeof value === "string" &&
    (value === "failed" || value === "degraded" || value === "at_risk" || value === "healthy")
  );
}

export type SimulationModeStatus =
  | "idle"
  | "loading"
  | "pending"
  | "running"
  | "ready"
  | "empty"
  | "error";

/**
 * Normalized Simulation Mode State for graph visualization and inspection.
 * Uses Maps and Sets for O(1) graph rendering lookups.
 */
export interface NormalizedSimulationModeState {
  readonly enabled: boolean;
  readonly simulationId: string | null;
  readonly analysisRunId: string | null;
  readonly executionStatus: SimulationStatus | null;
  readonly status: SimulationModeStatus;
  readonly errorMessage: string | null;

  // Indexed results for O(1) node rendering
  readonly resultsByNodeId: ReadonlyMap<string, SimulationResultResponse>;
  readonly resultingStateByNodeId: ReadonlyMap<string, SimulationResultState>;
  readonly invalidResultsByNodeId: ReadonlyMap<string, SimulationResultResponse>;
  readonly ruleByNodeId: ReadonlyMap<string, string>;
  readonly confidenceByNodeId: ReadonlyMap<string, number>;
  readonly assumptionsByNodeId: ReadonlyMap<string, readonly string[]>;
  readonly causalStepsByNodeId: ReadonlyMap<string, readonly SimulationCausalStep[]>;
  readonly hasCappedByNodeId: ReadonlyMap<string, boolean>;

  // Verified causal edge IDs from structured propagation steps
  readonly causalEdgeIds: ReadonlySet<string>;

  // Aggregate metrics derived from actual simulation results
  readonly totalResultsCount: number;
  readonly failedCount: number;
  readonly degradedCount: number;
  readonly atRiskCount: number;
  readonly healthyCount: number;
  readonly cappedCount: number;

  // Metadata from simulation run (when available)
  readonly converged?: boolean | undefined;
  readonly iterations?: number | undefined;
  readonly ruleTableVersion?: string | undefined;
}

export const DEFAULT_SIMULATION_MODE_STATE: NormalizedSimulationModeState = {
  enabled: false,
  simulationId: null,
  analysisRunId: null,
  executionStatus: null,
  status: "idle",
  errorMessage: null,
  resultsByNodeId: new Map(),
  resultingStateByNodeId: new Map(),
  invalidResultsByNodeId: new Map(),
  ruleByNodeId: new Map(),
  confidenceByNodeId: new Map(),
  assumptionsByNodeId: new Map(),
  causalStepsByNodeId: new Map(),
  hasCappedByNodeId: new Map(),
  causalEdgeIds: new Set(),
  totalResultsCount: 0,
  failedCount: 0,
  degradedCount: 0,
  atRiskCount: 0,
  healthyCount: 0,
  cappedCount: 0,
};

/**
 * Extracts structured SimulationCausalStep objects from a result's propagation_path.
 * Supports both structured causal step objects and string path entries.
 */
export function extractSimulationCausalSteps(
  result: SimulationResultResponse,
): readonly SimulationCausalStep[] {
  const rawPath = result.propagation_path;
  if (!rawPath || !Array.isArray(rawPath)) {
    return [];
  }

  const steps: SimulationCausalStep[] = [];

  for (const item of rawPath) {
    if (typeof item === "object" && item !== null) {
      const stepRecord = item as Record<string, unknown>;
      const ruleId =
        (typeof stepRecord.ruleId === "string" ? stepRecord.ruleId : undefined) ??
        (typeof stepRecord.rule_id === "string" ? stepRecord.rule_id : undefined) ??
        result.rule_applied;

      const ruleVersion =
        (typeof stepRecord.ruleVersion === "string" ? stepRecord.ruleVersion : undefined) ??
        (typeof stepRecord.rule_version === "string" ? stepRecord.rule_version : undefined) ??
        "";

      const rawNodeId =
        (typeof stepRecord.nodeId === "string" ? stepRecord.nodeId : undefined) ??
        (typeof stepRecord.node_id === "string" ? stepRecord.node_id : undefined);

      // Semantic integrity: A structured causal step missing a nodeId must be rejected,
      // never fallen back to result.node_id which would falsely attribute another node's step.
      if (!rawNodeId || rawNodeId.trim().length === 0) {
        continue;
      }
      const nodeId = rawNodeId.trim();

      const edgeId =
        stepRecord.edgeId !== undefined
          ? (stepRecord.edgeId as string | null)
          : stepRecord.edge_id !== undefined
            ? (stepRecord.edge_id as string | null)
            : null;

      const previousStateRaw =
        (typeof stepRecord.previousState === "string" ? stepRecord.previousState : undefined) ??
        (typeof stepRecord.previous_state === "string" ? stepRecord.previous_state : undefined);

      // Semantic integrity: Never fabricate "healthy" or any fallback when previousState is missing or noncanonical.
      // A structured causal step missing a canonical previousState must be rejected.
      if (!isCanonicalSimulationState(previousStateRaw)) {
        continue;
      }
      const previousState: SimulationResultState = previousStateRaw;

      const rawResulting =
        (typeof stepRecord.resultingState === "string" ? stepRecord.resultingState : undefined) ??
        (typeof stepRecord.resulting_state === "string" ? stepRecord.resulting_state : undefined);

      // Semantic integrity: A structured causal step missing a canonical resultingState must be rejected,
      // never fallen back to result.resulting_state or result.state which would falsely attribute another node's state.
      if (!isCanonicalSimulationState(rawResulting)) {
        continue;
      }

      const resultingState: SimulationResultState = rawResulting;

      const assumptions = Array.isArray(stepRecord.assumptions)
        ? (stepRecord.assumptions as readonly string[])
        : result.assumptions ?? [];

      const confidence =
        typeof stepRecord.confidence === "number"
          ? stepRecord.confidence
          : Number(result.confidence);

      const capped =
        typeof stepRecord.capped === "boolean" ? stepRecord.capped : undefined;

      steps.push({
        nodeId,
        edgeId,
        ruleId,
        ruleVersion,
        previousState,
        resultingState,
        assumptions,
        confidence,
        ...(capped !== undefined ? { capped } : {}),
      });
    }
    // Note: Legacy string entries (e.g. "target_failure") do not contain structured state transitions
    // and must never be converted into invented "healthy → resultingState" transitions or create causal edges.
  }

  return steps;
}

/**
 * Transforms Step 55 simulation responses into a normalized, graph-friendly view model.
 * Deterministic, pure function.
 */
export function normalizeSimulationResponse(
  simulation: SimulationResponse | null,
  resultsList: SimulationResultsListResponse | null,
  options: {
    readonly enabled?: boolean;
    readonly errorMessage?: string | null;
  } = {},
): NormalizedSimulationModeState {
  const enabled = options.enabled ?? true;
  const rawResults = resultsList?.results ?? simulation?.results ?? [];

  if (!simulation && !resultsList) {
    return {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled,
      status: options.errorMessage ? "error" : "idle",
      errorMessage: options.errorMessage ?? null,
    };
  }

  const simulationId = simulation?.id ?? resultsList?.simulation_id ?? null;
  const analysisRunId = simulation?.analysis_run_id ?? null;
  const executionStatus = simulation?.status ?? null;

  if (executionStatus === "failed") {
    return {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled,
      simulationId,
      analysisRunId,
      executionStatus: "failed",
      status: "error",
      errorMessage: "Simulation failed during execution on the server.",
    };
  }

  if (executionStatus === "pending") {
    return {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled,
      simulationId,
      analysisRunId,
      executionStatus: "pending",
      status: "pending",
      errorMessage: null,
    };
  }

  if (executionStatus === "running") {
    return {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled,
      simulationId,
      analysisRunId,
      executionStatus: "running",
      status: "running",
      errorMessage: null,
    };
  }

  if (rawResults.length === 0) {
    return {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled,
      simulationId,
      analysisRunId,
      executionStatus: executionStatus ?? "completed",
      status: "empty",
      totalResultsCount: 0,
      ...(simulation?.converged !== undefined ? { converged: simulation.converged } : {}),
      ...(simulation?.iterations !== undefined ? { iterations: simulation.iterations } : {}),
    };
  }

  const resultsByNodeId = new Map<string, SimulationResultResponse>();
  const resultingStateByNodeId = new Map<string, SimulationResultState>();
  const invalidResultsByNodeId = new Map<string, SimulationResultResponse>();
  const ruleByNodeId = new Map<string, string>();
  const confidenceByNodeId = new Map<string, number>();
  const assumptionsByNodeId = new Map<string, readonly string[]>();
  const causalStepsByNodeId = new Map<string, readonly SimulationCausalStep[]>();
  const hasCappedByNodeId = new Map<string, boolean>();

  let failedCount = 0;
  let degradedCount = 0;
  let atRiskCount = 0;
  let healthyCount = 0;
  let cappedCount = 0;

  for (const r of rawResults) {
    if (!r.node_id || typeof r.node_id !== "string") {
      continue;
    }

    const rawState = r.resulting_state ?? r.state;
    if (!isCanonicalSimulationState(rawState)) {
      // Retain invalid result explicitly for diagnostics, but keep it strictly
      // out of canonical simulation-state rendering, counts, and causal-edge highlighting.
      if (!resultingStateByNodeId.has(r.node_id)) {
        invalidResultsByNodeId.set(r.node_id, r);
      }
      continue;
    }

    // A valid canonical result clears any previously recorded invalid result for this node
    invalidResultsByNodeId.delete(r.node_id);

    // Deterministic duplicate resolution:
    // If a node appears multiple times, preserve the result with higher severity
    const existingState = resultingStateByNodeId.get(r.node_id);
    if (existingState !== undefined) {
      const existingSeverity = SIMULATION_STATE_SEVERITY[existingState] ?? 0;
      const newSeverity = SIMULATION_STATE_SEVERITY[rawState] ?? 0;
      if (newSeverity <= existingSeverity) {
        continue;
      }
      // Decrement prior count if replacing with higher severity
      if (existingState === "failed") failedCount--;
      else if (existingState === "degraded") degradedCount--;
      else if (existingState === "at_risk") atRiskCount--;
      else if (existingState === "healthy") healthyCount--;

      const prevHadCapped = hasCappedByNodeId.get(r.node_id);
      if (prevHadCapped) cappedCount--;
    }

    resultsByNodeId.set(r.node_id, r);
    resultingStateByNodeId.set(r.node_id, rawState);
    ruleByNodeId.set(r.node_id, r.rule_applied ?? "unknown_rule");

    const conf = typeof r.confidence === "number" ? r.confidence : 1.0;
    confidenceByNodeId.set(r.node_id, conf);
    assumptionsByNodeId.set(r.node_id, Array.isArray(r.assumptions) ? r.assumptions : []);

    const steps = extractSimulationCausalSteps(r);
    causalStepsByNodeId.set(r.node_id, steps);

    const hasCapped = steps.some((s) => s.capped === true);
    hasCappedByNodeId.set(r.node_id, hasCapped);

    if (rawState === "failed") failedCount++;
    else if (rawState === "degraded") degradedCount++;
    else if (rawState === "at_risk") atRiskCount++;
    else if (rawState === "healthy") healthyCount++;

    if (hasCapped) cappedCount++;
  }

  // Derive causal edge IDs and rule-table version metadata exclusively from
  // the final accepted results after deterministic duplicate resolution.
  const causalEdgeIds = new Set<string>();
  let derivedRuleTableVersion: string | undefined = undefined;

  for (const steps of causalStepsByNodeId.values()) {
    for (const step of steps) {
      if (step.edgeId && typeof step.edgeId === "string" && step.edgeId.trim().length > 0) {
        causalEdgeIds.add(step.edgeId.trim());
      }
      if (!derivedRuleTableVersion && step.ruleVersion && step.ruleVersion.trim().length > 0) {
        derivedRuleTableVersion = step.ruleVersion.trim();
      }
    }
  }

  // Canonical total results count only reflects valid simulation results
  const totalResultsCount = resultsByNodeId.size;

  return {
    enabled,
    simulationId,
    analysisRunId,
    executionStatus: executionStatus ?? "completed",
    status: "ready",
    errorMessage: null,
    resultsByNodeId,
    resultingStateByNodeId,
    invalidResultsByNodeId,
    ruleByNodeId,
    confidenceByNodeId,
    assumptionsByNodeId,
    causalStepsByNodeId,
    hasCappedByNodeId,
    causalEdgeIds,
    totalResultsCount,
    failedCount,
    degradedCount,
    atRiskCount,
    healthyCount,
    cappedCount,
    ...(simulation?.converged !== undefined ? { converged: simulation.converged } : {}),
    ...(simulation?.iterations !== undefined ? { iterations: simulation.iterations } : {}),
    ...(derivedRuleTableVersion !== undefined ? { ruleTableVersion: derivedRuleTableVersion } : {}),
  };
}

export interface SimulationSliceMetrics {
  readonly totalResultNodes: number;
  readonly visibleResultNodes: number;
  readonly hiddenResultNodes: number;
  readonly visibleByState: Readonly<Record<SimulationResultState, number>>;
}

/**
 * Computes how many simulation result nodes are present in the current visible LOD graph slice.
 * Distinguishes the full persisted simulation result count from the currently visible graph slice.
 */
export function computeSimulationSliceMetrics(
  state: NormalizedSimulationModeState,
  visibleNodes: readonly CanvasInputNode[],
): SimulationSliceMetrics {
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  let visibleCount = 0;
  const visibleByState: Record<SimulationResultState, number> = {
    failed: 0,
    degraded: 0,
    at_risk: 0,
    healthy: 0,
  };

  for (const [nodeId, resultState] of state.resultingStateByNodeId.entries()) {
    if (visibleNodeIds.has(nodeId)) {
      visibleCount++;
      visibleByState[resultState]++;
    }
  }

  const totalResultNodes = state.resultsByNodeId.size;
  const hiddenResultNodes = Math.max(0, totalResultNodes - visibleCount);

  return {
    totalResultNodes,
    visibleResultNodes: visibleCount,
    hiddenResultNodes,
    visibleByState,
  };
}

export function formatSimulationConfidence(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

export function getSimulationStateBadgeConfig(state: SimulationResultState): {
  readonly bg: string;
  readonly text: string;
  readonly border: string;
  readonly label: string;
} {
  switch (state) {
    case "failed":
      return {
        bg: "bg-red-100",
        text: "text-red-800",
        border: "border-red-300",
        label: "Failed",
      };
    case "degraded":
      return {
        bg: "bg-amber-100",
        text: "text-amber-800",
        border: "border-amber-300",
        label: "Degraded",
      };
    case "at_risk":
      return {
        bg: "bg-yellow-100",
        text: "text-yellow-800",
        border: "border-yellow-300",
        label: "At Risk",
      };
    case "healthy":
      return {
        bg: "bg-emerald-100",
        text: "text-emerald-800",
        border: "border-emerald-300",
        label: "Healthy",
      };
  }
}

/**
 * Builds deep-link URL from Simulation Studio to Architecture Explorer.
 * Validates all required UUIDs to guarantee no malformed or missing identifiers.
 */
export function buildExplorerSimulationUrl(input: {
  readonly repositoryId: string;
  readonly analysisRunId: string;
  readonly startNodeId: string;
  readonly simulationId: string;
  readonly selectedNodeId?: string | null | undefined;
}): string | null {
  const repoId = input.repositoryId.trim();
  const runId = input.analysisRunId.trim();
  const startId = input.startNodeId.trim();
  const simId = input.simulationId.trim();

  if (
    !UUID_REGEX.test(repoId) ||
    !UUID_REGEX.test(runId) ||
    !UUID_REGEX.test(startId) ||
    !UUID_REGEX.test(simId)
  ) {
    return null;
  }

  const params = new URLSearchParams({
    analysis_run_id: runId,
    start_node_id: startId,
    simulation_id: simId,
  });

  if (input.selectedNodeId && UUID_REGEX.test(input.selectedNodeId.trim())) {
    params.set("node_id", input.selectedNodeId.trim());
  }

  return `/repositories/${repoId}/explorer?${params.toString()}`;
}
