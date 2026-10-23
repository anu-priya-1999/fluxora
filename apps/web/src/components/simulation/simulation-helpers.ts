import type {
  SimulationCausalStep,
  SimulationImpactSummary,
  SimulationResponse,
  SimulationResultResponse,
  SimulationResultState,
  StudioFilterState,
  SupportedFailureType,
} from "./simulation-types.ts";
import { SUPPORTED_FAILURE_TYPES } from "./simulation-types.ts";
import { UUID_REGEX } from "./simulation-api.ts";

export const STATE_SEVERITY: Record<SimulationResultState, number> = {
  failed: 4,
  degraded: 3,
  at_risk: 2,
  healthy: 1,
};

export function calculateSimulationImpact(
  results: readonly SimulationResultResponse[],
  simulation?: SimulationResponse | null,
  totalCount?: number | undefined,
): SimulationImpactSummary {
  let failedCount = 0;
  let degradedCount = 0;
  let atRiskCount = 0;
  let healthyCount = 0;
  let cappedCount = 0;

  for (const r of results) {
    const state = r.resulting_state ?? r.state;
    if (state === "failed") {
      failedCount++;
    } else if (state === "degraded") {
      degradedCount++;
    } else if (state === "at_risk") {
      atRiskCount++;
    } else if (state === "healthy") {
      healthyCount++;
    }

    const steps = extractCausalSteps(r);
    if (steps.some((s) => s.capped === true)) {
      cappedCount++;
    }
  }

  // Derive rule table version from the first causal step that provides it, if available
  let ruleTableVersion: string | undefined;
  for (const r of results) {
    const steps = extractCausalSteps(r);
    for (const step of steps) {
      if (typeof step.ruleVersion === "string" && step.ruleVersion.trim().length > 0) {
        ruleTableVersion = step.ruleVersion.trim();
        break;
      }
    }
    if (ruleTableVersion) break;
  }

  return {
    totalAffected: totalCount ?? simulation?.total_results ?? results.length,
    failedCount,
    degradedCount,
    atRiskCount,
    healthyCount,
    cappedCount,
    ...(simulation?.converged !== undefined ? { converged: simulation.converged } : {}),
    ...(simulation?.iterations !== undefined ? { iterations: simulation.iterations } : {}),
    ...(ruleTableVersion !== undefined ? { ruleTableVersion } : {}),
  };
}

export function extractCausalSteps(
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

      const nodeId =
        (typeof stepRecord.nodeId === "string" ? stepRecord.nodeId : undefined) ??
        (typeof stepRecord.node_id === "string" ? stepRecord.node_id : undefined) ??
        result.node_id;

      const edgeId =
        stepRecord.edgeId !== undefined
          ? (stepRecord.edgeId as string | null)
          : stepRecord.edge_id !== undefined
            ? (stepRecord.edge_id as string | null)
            : null;

      const previousState =
        (typeof stepRecord.previousState === "string" ? stepRecord.previousState : undefined) ??
        (typeof stepRecord.previous_state === "string" ? stepRecord.previous_state : undefined) ??
        "healthy";

      const resultingState =
        (typeof stepRecord.resultingState === "string" ? stepRecord.resultingState : undefined) ??
        (typeof stepRecord.resulting_state === "string" ? stepRecord.resulting_state : undefined) ??
        result.resulting_state ??
        result.state;

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
        previousState: previousState as SimulationResultState,
        resultingState: resultingState as SimulationResultState,
        assumptions,
        confidence,
        ...(capped !== undefined ? { capped } : {}),
      });
    } else if (typeof item === "string") {
      steps.push({
        nodeId: result.node_id,
        edgeId: null,
        ruleId: item,
        ruleVersion: "",
        previousState: "healthy",
        resultingState: result.resulting_state ?? result.state,
        assumptions: result.assumptions ?? [],
        confidence: Number(result.confidence),
      });
    }
  }

  return steps;
}

export function filterAndSortSimulationResults(
  results: readonly SimulationResultResponse[],
  filters: StudioFilterState,
  nodeNameMap?: ReadonlyMap<string, string>,
): readonly SimulationResultResponse[] {
  let filtered = results;

  // Filter by state
  if (filters.stateFilter !== "all") {
    filtered = filtered.filter(
      (r) => (r.resulting_state ?? r.state) === filters.stateFilter,
    );
  }

  // Filter by search query
  if (filters.searchQuery.trim().length > 0) {
    const q = filters.searchQuery.trim().toLowerCase();
    filtered = filtered.filter((r) => {
      const name = nodeNameMap?.get(r.node_id)?.toLowerCase() ?? "";
      const nodeId = r.node_id.toLowerCase();
      const rule = r.rule_applied.toLowerCase();
      return name.includes(q) || nodeId.includes(q) || rule.includes(q);
    });
  }

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let comparison = 0;

    switch (filters.sortBy) {
      case "state": {
        const severityA = STATE_SEVERITY[a.resulting_state ?? a.state] ?? 0;
        const severityB = STATE_SEVERITY[b.resulting_state ?? b.state] ?? 0;
        comparison = severityA - severityB;
        break;
      }
      case "name": {
        const nameA = nodeNameMap?.get(a.node_id) ?? a.node_id;
        const nameB = nodeNameMap?.get(b.node_id) ?? b.node_id;
        comparison = nameA.localeCompare(nameB);
        break;
      }
      case "confidence": {
        const confA = a.confidence ?? 1.0;
        const confB = b.confidence ?? 1.0;
        comparison = confA - confB;
        break;
      }
      case "steps": {
        const stepsA = a.propagation_path?.length ?? 0;
        const stepsB = b.propagation_path?.length ?? 0;
        comparison = stepsA - stepsB;
        break;
      }
    }

    return filters.sortDirection === "asc" ? comparison : -comparison;
  });

  return sorted;
}

export function formatConfidence(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

export interface ScenarioValidationResult {
  readonly valid: boolean;
  readonly errors: {
    readonly name?: string | undefined;
    readonly targetNodeId?: string | undefined;
    readonly failureType?: string | undefined;
    readonly repositoryId?: string | undefined;
    readonly analysisRunId?: string | undefined;
  };
}

export function validateScenarioInput(input: {
  readonly name: string;
  readonly targetNodeId: string;
  readonly failureType: string;
  readonly repositoryId?: string | undefined;
  readonly analysisRunId?: string | undefined;
}): ScenarioValidationResult {
  const errors: {
    name?: string;
    targetNodeId?: string;
    failureType?: string;
    repositoryId?: string;
    analysisRunId?: string;
  } = {};

  if (!input.name || input.name.trim().length === 0) {
    errors.name = "Scenario name is required.";
  }

  if (!input.targetNodeId || !UUID_REGEX.test(input.targetNodeId.trim())) {
    errors.targetNodeId = "A valid target node must be selected.";
  }

  if (
    !input.failureType ||
    !SUPPORTED_FAILURE_TYPES.includes(input.failureType as SupportedFailureType)
  ) {
    errors.failureType = `Failure type must be one of: ${SUPPORTED_FAILURE_TYPES.join(", ")}.`;
  }

  if (input.repositoryId && !UUID_REGEX.test(input.repositoryId.trim())) {
    errors.repositoryId = "Repository identifier must be a valid UUID.";
  }

  if (input.analysisRunId && !UUID_REGEX.test(input.analysisRunId.trim())) {
    errors.analysisRunId = "Analysis run identifier must be a valid UUID.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function getStateBadgeColors(state: SimulationResultState): {
  readonly bg: string;
  readonly text: string;
  readonly border: string;
  readonly label: string;
} {
  switch (state) {
    case "failed":
      return {
        bg: "bg-red-50",
        text: "text-red-700",
        border: "border-red-300",
        label: "Failed",
      };
    case "degraded":
      return {
        bg: "bg-amber-50",
        text: "text-amber-700",
        border: "border-amber-300",
        label: "Degraded",
      };
    case "at_risk":
      return {
        bg: "bg-yellow-50",
        text: "text-yellow-700",
        border: "border-yellow-300",
        label: "At Risk",
      };
    case "healthy":
      return {
        bg: "bg-emerald-50",
        text: "text-emerald-700",
        border: "border-emerald-300",
        label: "Healthy",
      };
  }
}

