import type {
  Scenario,
  ScenarioResponse,
  Simulation,
  SimulationResponse,
  SimulationResult,
  SimulationResultResponse,
  SimulationResultsListResponse,
} from "@fluxora/shared-types";

export function formatScenarioResponse(scenario: Scenario): ScenarioResponse {
  return {
    id: scenario.id,
    organization_id: scenario.organizationId,
    repository_id: scenario.repositoryId,
    name: scenario.name,
    target_node_id: scenario.targetNodeId,
    failure_type: scenario.failureType,
    parameters: scenario.parameters ?? {},
    created_by: scenario.createdBy,
    created_at:
      scenario.createdAt instanceof Date
        ? scenario.createdAt.toISOString()
        : String(scenario.createdAt),
  };
}

export function formatSimulationResultResponse(
  result: SimulationResult,
): SimulationResultResponse {
  return {
    id: result.id,
    simulation_id: result.simulationId,
    node_id: result.nodeId,
    resulting_state: result.resultingState,
    state: result.resultingState,
    propagation_path: Array.isArray(result.propagationPath)
      ? result.propagationPath
      : [],
    rule_applied: result.ruleApplied,
    assumptions: Array.isArray(result.assumptions) ? result.assumptions : [],
    confidence: Number(result.confidence),
    created_at:
      result.createdAt instanceof Date
        ? result.createdAt.toISOString()
        : String(result.createdAt),
  };
}

export function formatSimulationResponse(
  simulation: Simulation,
  results?: readonly SimulationResult[] | undefined,
  metadata?: {
    readonly converged?: boolean | undefined;
    readonly iterations?: number | undefined;
  } | undefined,
): SimulationResponse {
  const createdAtIso =
    simulation.createdAt instanceof Date
      ? simulation.createdAt.toISOString()
      : String(simulation.createdAt);

  const base: SimulationResponse = {
    id: simulation.id,
    scenario_id: simulation.scenarioId,
    analysis_run_id: simulation.analysisRunId,
    status: simulation.status,
    created_at: createdAtIso,
    simulation: {
      id: simulation.id,
      scenario_id: simulation.scenarioId,
      analysis_run_id: simulation.analysisRunId,
      status: simulation.status,
      created_at: createdAtIso,
    },
  };

  if (results !== undefined) {
    const formattedResults = results.map(formatSimulationResultResponse);
    const assumptionSet = new Set<string>();
    for (const r of results) {
      if (Array.isArray(r.assumptions)) {
        for (const a of r.assumptions) {
          if (typeof a === "string" && a.trim().length > 0) {
            assumptionSet.add(a.trim());
          }
        }
      }
    }

    return {
      ...base,
      results: formattedResults,
      assumptions: Array.from(assumptionSet),
      total_results: formattedResults.length,
      ...(metadata?.converged !== undefined
        ? { converged: metadata.converged }
        : {}),
      ...(metadata?.iterations !== undefined
        ? { iterations: metadata.iterations }
        : {}),
    };
  }

  return base;
}

export function formatSimulationResultsResponse(
  simulationId: string,
  results: readonly SimulationResult[],
): SimulationResultsListResponse {
  const formattedResults = results.map(formatSimulationResultResponse);
  return {
    simulation_id: simulationId,
    results: formattedResults,
    total: formattedResults.length,
  };
}

