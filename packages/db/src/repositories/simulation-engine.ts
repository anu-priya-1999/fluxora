import type {
  EvidenceRecord,
  GraphEdge,
  GraphNode,
  GraphEdgeType,
  ScenarioFailureType,
  Simulation,
  SimulationCausalStep,
  SimulationEdge,
  SimulationEngineInput,
  SimulationEngineNodeResult,
  SimulationEngineResult,
  SimulationGraphSnapshot,
  SimulationNode,
  SimulationResult,
  SimulationResultState,
  SimulationRuleTable,
} from "@fluxora/shared-types";
import {
  DEFAULT_SIMULATION_RULE_TABLE,
  isStateMoreSevere,
  createSimulationRuleInputFromEdge,
  evaluateSimulationRule,
  RULE_ID_TARGET_FAILURE,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";
import { EvidenceWriter } from "./evidence-writer.ts";
import { getGraphStateForAnalysisRunTx } from "./graph-diff.ts";
import {
  ScenarioNotFoundError,
  SimulationNotFoundError,
  updateSimulationStatus,
} from "./simulation.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Error Hierarchy for Simulation Engine (Step 54)
// ---------------------------------------------------------------------------

export class SimulationEngineValidationError extends Error {
  readonly code = "invalid_simulation_engine_input";
  constructor(message: string) {
    super(message);
    this.name = "SimulationEngineValidationError";
  }
}

export class UnsupportedScenarioFailureTypeError extends Error {
  readonly code = "unsupported_failure_type";
  constructor(failureType: string) {
    super(
      `Unsupported scenario failure type: "${failureType}". MVP simulation engine only supports "unavailable" and "latency".`,
    );
    this.name = "UnsupportedScenarioFailureTypeError";
  }
}

export class SimulationConvergenceError extends Error {
  readonly code = "simulation_convergence_failure";
  constructor(message: string) {
    super(message);
    this.name = "SimulationConvergenceError";
  }
}

export class CrossAnalysisRunBoundaryError extends Error {
  readonly code = "cross_analysis_run_boundary";
  constructor(message: string) {
    super(message);
    this.name = "CrossAnalysisRunBoundaryError";
  }
}

export { ScenarioNotFoundError, SimulationNotFoundError };

// ---------------------------------------------------------------------------
// Internal Node Transition State
// ---------------------------------------------------------------------------

interface InternalNodeTransitionData {
  readonly nodeId: string;
  readonly resultingState: SimulationResultState;
  readonly propagationPath: readonly SimulationCausalStep[];
  readonly ruleApplied: string;
  readonly assumptions: readonly string[];
  readonly confidence: number;
  readonly capped?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Pure Propagation Simulation Engine (Step 54 Domain Core)
// ---------------------------------------------------------------------------

/**
 * Deterministically propagates a scenario failure across a graph snapshot.
 *
 * Invariants:
 * 1. Monotonic state transitions: healthy (0) -> at_risk (1) -> degraded (2) -> failed (3).
 * 2. Guaranteed termination on cyclic graphs via monotonic state limits.
 * 3. Deterministic edge processing and worklist ordering.
 * 4. Step 53 normative rule table is the sole source of propagation semantics.
 * 5. Full causal path and assumption preservation across multi-hop propagation.
 */
export function runSimulationEngine(
  input: SimulationEngineInput,
): SimulationEngineResult {
  const { scenario, graph, options } = input;
  const failureType = scenario.failureType;

  // 1. Boundary & Scenario Validation
  if (failureType !== "unavailable" && failureType !== "latency") {
    throw new UnsupportedScenarioFailureTypeError(String(failureType));
  }

  const analysisRunId = graph.analysisRunId;
  if (!analysisRunId || typeof analysisRunId !== "string") {
    throw new SimulationEngineValidationError(
      "Graph snapshot must provide a valid analysisRunId string.",
    );
  }

  // 2. Cross-Analysis-Run Defensive Validation
  for (const node of graph.nodes) {
    if (node.analysisRunId && node.analysisRunId !== analysisRunId) {
      throw new CrossAnalysisRunBoundaryError(
        `Node "${node.id}" analysisRunId "${node.analysisRunId}" does not match graph snapshot analysisRunId "${analysisRunId}".`,
      );
    }
  }

  for (const edge of graph.edges) {
    if (edge.analysisRunId && edge.analysisRunId !== analysisRunId) {
      throw new CrossAnalysisRunBoundaryError(
        `Edge "${edge.id}" analysisRunId "${edge.analysisRunId}" does not match graph snapshot analysisRunId "${analysisRunId}".`,
      );
    }
  }

  // 3. Node Indexing & Target Node Verification
  const nodesById = new Map<string, SimulationNode | GraphNode>();
  for (const node of graph.nodes) {
    nodesById.set(node.id, node);
  }

  const targetNode = nodesById.get(scenario.targetNodeId);
  if (!targetNode) {
    throw new SimulationEngineValidationError(
      `Scenario target node "${scenario.targetNodeId}" not found in graph snapshot.`,
    );
  }

  // Verify all edges connect known nodes within snapshot
  for (const edge of graph.edges) {
    if (!nodesById.has(edge.sourceNodeId)) {
      throw new SimulationEngineValidationError(
        `Edge "${edge.id}" references unknown source node "${edge.sourceNodeId}".`,
      );
    }
    if (!nodesById.has(edge.targetNodeId)) {
      throw new SimulationEngineValidationError(
        `Edge "${edge.id}" references unknown target node "${edge.targetNodeId}".`,
      );
    }
  }

  // 4. Incident Edges Indexing with Strict Deterministic Ordering
  const incidentEdges = new Map<string, (SimulationEdge | GraphEdge)[]>();
  for (const node of graph.nodes) {
    incidentEdges.set(node.id, []);
  }

  // Copy and sort edges deterministically before indexing
  const sortedEdges = [...graph.edges].sort((a, b) => {
    const cmpSrc = a.sourceNodeId.localeCompare(b.sourceNodeId);
    if (cmpSrc !== 0) return cmpSrc;
    const cmpTgt = a.targetNodeId.localeCompare(b.targetNodeId);
    if (cmpTgt !== 0) return cmpTgt;
    const cmpType = a.edgeType.localeCompare(b.edgeType);
    if (cmpType !== 0) return cmpType;
    return a.id.localeCompare(b.id);
  });

  for (const edge of sortedEdges) {
    incidentEdges.get(edge.sourceNodeId)?.push(edge);
    incidentEdges.get(edge.targetNodeId)?.push(edge);
  }

  // 5. State Map Initialization: All nodes start HEALTHY
  const stateMap = new Map<string, SimulationResultState>();
  for (const node of graph.nodes) {
    stateMap.set(node.id, "healthy");
  }

  const ruleTable: SimulationRuleTable =
    input.ruleTable ?? DEFAULT_SIMULATION_RULE_TABLE;

  // 6. Target Failure Seeding
  // unavailable -> failed, latency -> degraded
  const seededState: SimulationResultState =
    failureType === "unavailable" ? "failed" : "degraded";
  stateMap.set(targetNode.id, seededState);

  const targetAssumptions: readonly string[] =
    failureType === "unavailable"
      ? ["Scenario target node directly seeded as failed (unavailable)"]
      : ["Scenario target node directly seeded as degraded (latency injection)"];

  const seedStep: SimulationCausalStep = {
    nodeId: targetNode.id,
    edgeId: null,
    ruleId: RULE_ID_TARGET_FAILURE,
    ruleVersion: ruleTable.version,
    previousState: "healthy",
    resultingState: seededState,
    assumptions: targetAssumptions,
    confidence: 1.0,
    capped: false,
  };

  const nodeDataMap = new Map<string, InternalNodeTransitionData>();
  nodeDataMap.set(targetNode.id, {
    nodeId: targetNode.id,
    resultingState: seededState,
    propagationPath: [seedStep],
    ruleApplied: RULE_ID_TARGET_FAILURE,
    assumptions: targetAssumptions,
    confidence: 1.0,
    capped: false,
  });

  // 7. Deterministic Worklist Propagation Loop
  const workQueue: string[] = [targetNode.id];
  const inQueue = new Set<string>([targetNode.id]);

  let iterations = 0;
  // Maximum allowed iterations: each node can transition at most 3 times (healthy -> at_risk -> degraded -> failed)
  const maxIterations =
    options?.maxIterations ?? Math.max(10_000, nodesById.size * 5 + 100);

  while (workQueue.length > 0) {
    iterations++;
    if (iterations > maxIterations) {
      throw new SimulationConvergenceError(
        `Simulation failed to converge within ${maxIterations} iterations. Possible non-monotonic transition cycle detected.`,
      );
    }

    const currentNodeId = workQueue.shift()!;
    inQueue.delete(currentNodeId);

    const edgesForNode = incidentEdges.get(currentNodeId) ?? [];

    for (const edge of edgesForNode) {
      const sourceNode = nodesById.get(edge.sourceNodeId)!;
      const targetNode = nodesById.get(edge.targetNodeId)!;
      const currentSourceState = stateMap.get(edge.sourceNodeId)!;
      const currentTargetState = stateMap.get(edge.targetNodeId)!;

      // Construct rule input using Step 53 adapter
      const ruleInput = createSimulationRuleInputFromEdge(
        edge as GraphEdge,
        currentSourceState,
        currentTargetState,
        {
          failureType,
          sourceNodeName: sourceNode.name,
          targetNodeName: targetNode.name,
          isWriteFailure:
            (currentTargetState === "failed" || currentTargetState === "degraded") &&
            (edge.edgeType === "WRITES" || edge.edgeType === "QUERIES_DB"),
        },
      );

      const decision = evaluateSimulationRule(ruleInput, ruleTable);
      if (
        !decision.matched ||
        !decision.resultingState ||
        decision.affectedNode === "none" ||
        !decision.affectedNode
      ) {
        continue;
      }

      const affectedNodeId =
        decision.affectedNode === "source"
          ? edge.sourceNodeId
          : edge.targetNodeId;

      const currentAffectedState = stateMap.get(affectedNodeId)!;
      const proposedState = decision.resultingState;

      // Monotonicity enforcement: only strictly more severe transitions are applied
      if (!isStateMoreSevere(proposedState, currentAffectedState)) {
        // Equal-severity or less severe: preserve the first deterministic explanation (tie-breaker)
        continue;
      }

      // Transition applied
      stateMap.set(affectedNodeId, proposedState);

      // Determine the triggering node on the opposite side of the evaluated edge
      const triggerNodeId =
        decision.affectedNode === "source"
          ? edge.targetNodeId
          : edge.sourceNodeId;

      const triggerData = nodeDataMap.get(triggerNodeId);
      const triggerPath = triggerData?.propagationPath ?? [];

      const causalStep: SimulationCausalStep = {
        nodeId: affectedNodeId,
        edgeId: edge.id,
        ruleId: decision.ruleId,
        ruleVersion: decision.ruleVersion,
        previousState: currentAffectedState,
        resultingState: proposedState,
        assumptions: decision.assumptions,
        confidence: decision.confidence,
        capped: decision.capped,
      };

      const newPath = [...triggerPath, causalStep];
      const combinedAssumptions = Array.from(
        new Set([...(triggerData?.assumptions ?? []), ...decision.assumptions]),
      );

      nodeDataMap.set(affectedNodeId, {
        nodeId: affectedNodeId,
        resultingState: proposedState,
        propagationPath: newPath,
        ruleApplied: decision.ruleId,
        assumptions: combinedAssumptions,
        confidence: decision.confidence,
        capped: decision.capped,
      });

      // Circuit Breaker / Capped propagation:
      // If decision.capped === true, fail-fast isolation prevents cascading downstream propagation.
      // Otherwise, enqueue the affected node to propagate downstream to dependent nodes.
      if (!decision.capped) {
        if (!inQueue.has(affectedNodeId)) {
          workQueue.push(affectedNodeId);
          inQueue.add(affectedNodeId);
        }
      }
    }
  }

  // 8. Formulate Deterministic Output
  // Sorted deterministically by nodeId ascending
  const results: readonly SimulationEngineNodeResult[] = Array.from(
    nodeDataMap.values(),
  )
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map((d) => ({
      nodeId: d.nodeId,
      resultingState: d.resultingState,
      propagationPath: d.propagationPath,
      ruleApplied: d.ruleApplied,
      assumptions: d.assumptions,
      confidence: d.confidence,
      capped: d.capped,
    }));

  return {
    converged: true,
    iterations,
    ruleTableVersion: ruleTable.version,
    results,
    nodeStates: stateMap,
  };
}

// ---------------------------------------------------------------------------
// Database Orchestration Layer (Step 54 Persistence & Transaction)
// ---------------------------------------------------------------------------

export interface ExecuteSimulationOptions {
  readonly ruleTable?: SimulationRuleTable;
  readonly maxIterations?: number;
}

export interface ExecuteSimulationResult {
  readonly simulation: Simulation;
  readonly engineResult: SimulationEngineResult;
  readonly savedResults: readonly SimulationResult[];
  readonly evidence: readonly EvidenceRecord[];
}

interface ScenarioDbRow {
  id: string;
  organization_id: string;
  repository_id: string;
  name: string;
  target_node_id: string;
  failure_type: string;
  parameters: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
}

interface SimulationDbRow {
  id: string;
  scenario_id: string;
  analysis_run_id: string;
  status: string;
  created_at: Date;
}

interface SimulationResultDbRow {
  id: string;
  simulation_id: string;
  node_id: string;
  resulting_state: string;
  propagation_path: SimulationCausalStep[];
  rule_applied: string;
  assumptions: string[];
  confidence: number;
  created_at: Date;
}

/**
 * Orchestrates simulation execution against PostgreSQL:
 * 1. Checks tenant boundaries and scenario/analysis-run consistency.
 * 2. Updates simulation status: pending -> running.
 * 3. Fetches graph snapshot and executes the pure Simulation Engine.
 * 4. Atomically persists SimulationResult records and EvidenceWriter-backed simulation_state Evidence.
 * 5. Updates simulation status: running -> completed (or failed on error with rollback).
 */
export async function executeSimulation(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
  options?: ExecuteSimulationOptions,
): Promise<ExecuteSimulationResult> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(simulationId)) {
    throw new SimulationEngineValidationError("Invalid organizationId or simulationId UUID.");
  }

  try {
    return await withTenant(pool, organizationId, async (client) => {
      // 1. Fetch Simulation and verify tenant access
      const simRes = await client.query<SimulationDbRow>(
        `SELECT sim.id, sim.scenario_id, sim.analysis_run_id, sim.status, sim.created_at
         FROM simulations sim
         JOIN scenarios s ON s.id = sim.scenario_id
         WHERE sim.id = $1::uuid AND s.organization_id = $2::uuid`,
        [simulationId, organizationId],
      );

      const simRow = simRes.rows[0];
      if (!simRow) {
        throw new SimulationNotFoundError("Simulation not found or inaccessible for this organization.");
      }

      // 2. Fetch Scenario
      const scenarioRes = await client.query<ScenarioDbRow>(
        `SELECT id, organization_id, repository_id, name, target_node_id, failure_type, parameters, created_by, created_at
         FROM scenarios
         WHERE id = $1::uuid AND organization_id = $2::uuid`,
        [simRow.scenario_id, organizationId],
      );

      const scenarioRow = scenarioRes.rows[0];
      if (!scenarioRow) {
        throw new ScenarioNotFoundError("Scenario not found or inaccessible for this organization.");
      }

      // 3. Validate MVP failure type
      if (
        scenarioRow.failure_type !== "unavailable" &&
        scenarioRow.failure_type !== "latency"
      ) {
        throw new UnsupportedScenarioFailureTypeError(scenarioRow.failure_type);
      }

      // 4. Update Simulation status to 'running'
      await client.query(
        `UPDATE simulations SET status = 'running' WHERE id = $1::uuid`,
        [simulationId],
      );

      // 5. Fetch graph snapshot within the current tenant transaction
      const { nodes, edges } = await getGraphStateForAnalysisRunTx(
        client,
        organizationId,
        simRow.analysis_run_id,
      );

      const graphSnapshot: SimulationGraphSnapshot = {
        analysisRunId: simRow.analysis_run_id,
        nodes: nodes.map((n) => ({
          id: n.id ?? "",
          canonicalId: n.canonicalId,
          nodeType: n.nodeType,
          name: n.name,
          path: n.path,
          metadata: n.metadata,
          confidence: n.confidence,
          analysisRunId: simRow.analysis_run_id,
        })),
        edges: edges.map((e) => ({
          id: e.id ?? "",
          sourceNodeId: e.sourceNodeId ?? "",
          targetNodeId: e.targetNodeId ?? "",
          edgeType: e.edgeType as GraphEdgeType,
          canonicalId: e.canonicalId,
          metadata: e.metadata,
          confidence: e.confidence,
          provenance: e.provenance,
          analysisRunId: simRow.analysis_run_id,
        })),
      };

      // 6. Execute pure Simulation Engine
      const engineResult = runSimulationEngine({
        scenario: {
          id: scenarioRow.id,
          targetNodeId: scenarioRow.target_node_id,
          failureType: scenarioRow.failure_type as ScenarioFailureType,
          parameters: scenarioRow.parameters ?? {},
        },
        graph: graphSnapshot,
        ruleTable: options?.ruleTable,
        options:
          options?.maxIterations !== undefined
            ? { maxIterations: options.maxIterations }
            : undefined,
      });

      // 7. Atomically persist SimulationResult records
      const savedResults: SimulationResult[] = [];
      const upsertQuery = `
        INSERT INTO simulation_results (
          simulation_id, node_id, resulting_state, propagation_path, rule_applied, assumptions, confidence
        )
        VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::jsonb, $7)
        ON CONFLICT (simulation_id, node_id) DO UPDATE
          SET resulting_state = EXCLUDED.resulting_state,
              propagation_path = EXCLUDED.propagation_path,
              rule_applied = EXCLUDED.rule_applied,
              assumptions = EXCLUDED.assumptions,
              confidence = EXCLUDED.confidence
        RETURNING id, simulation_id, node_id, resulting_state, propagation_path, rule_applied, assumptions, confidence, created_at
      `;

      for (const r of engineResult.results) {
        const res = await client.query<SimulationResultDbRow>(upsertQuery, [
          simulationId,
          r.nodeId,
          r.resultingState,
          JSON.stringify(r.propagationPath),
          r.ruleApplied.trim(),
          JSON.stringify(r.assumptions),
          r.confidence,
        ]);

        const row = res.rows[0];
        if (row) {
          savedResults.push({
            id: row.id,
            simulationId: row.simulation_id,
            nodeId: row.node_id,
            resultingState: row.resulting_state as SimulationResultState,
            propagationPath: row.propagation_path,
            ruleApplied: row.rule_applied,
            assumptions: row.assumptions,
            confidence: Number(row.confidence),
            createdAt: row.created_at,
          });
        }
      }

      // 8. Construct simulation_state evidence using EvidenceWriter
      const evidenceInputs = [];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      for (const saved of savedResults) {
        const lastStep = Array.isArray(saved.propagationPath) && saved.propagationPath.length > 0
          ? (saved.propagationPath[saved.propagationPath.length - 1] as SimulationCausalStep)
          : undefined;

        const edgeId =
          lastStep && typeof lastStep === "object" && lastStep.edgeId
            ? lastStep.edgeId
            : null;
        let edgeEvidence: {
          file_path: string;
          symbol_id: string | null;
          line_start: number | null;
          line_end: number | null;
          column_start: number | null;
          column_end: number | null;
        } | null = null;

        if (edgeId) {
          const edgeEvRes = await client.query<{
            file_path: string;
            symbol_id: string | null;
            line_start: number | null;
            line_end: number | null;
            column_start: number | null;
            column_end: number | null;
          }>(
            `SELECT file_path, symbol_id, line_start, line_end, column_start, column_end
             FROM evidence
             WHERE subject_id = $1::uuid AND subject_type = 'graph_edge'
             LIMIT 1`,
            [edgeId],
          );
          if (edgeEvRes.rows.length > 0) {
            edgeEvidence = edgeEvRes.rows[0]!;
          }
        }

        const node = nodeMap.get(saved.nodeId);
        const filePath =
          edgeEvidence?.file_path ??
          node?.path ??
          "simulation:scenario-target";

        const relationshipDescription = edgeId
          ? `Simulation state changed from ${lastStep?.previousState ?? "healthy"} to ${saved.resultingState} because rule ${saved.ruleApplied} propagated impairment across graph edge ${edgeId}.`
          : `Simulation state set to ${saved.resultingState} because node is the directly seeded failure target of scenario.`;

        const evInput = EvidenceWriter.createSimulationStateEvidence({
          organizationId,
          analysisRunId: simRow.analysis_run_id,
          simulationResultId: saved.id,
          nodeId: saved.nodeId,
          resultingState: saved.resultingState,
          ruleApplied: saved.ruleApplied,
          edgeId,
          filePath,
          symbolId: edgeEvidence?.symbol_id ?? null,
          lineStart: edgeEvidence?.line_start ?? null,
          lineEnd: edgeEvidence?.line_end ?? null,
          columnStart: edgeEvidence?.column_start ?? null,
          columnEnd: edgeEvidence?.column_end ?? null,
          relationshipDescription,
          confidence: saved.confidence,
          metadata: {
            simulationId,
            propagationPath: saved.propagationPath,
            assumptions: saved.assumptions,
          },
        });

        evidenceInputs.push(evInput);
      }

      // 9. Persist evidence batch atomically via EvidenceWriter
      const writtenEvidence = await EvidenceWriter.writeEvidenceBatchTx(
        client,
        evidenceInputs,
      );

      // 10. Update simulation status to 'completed'
      const completedSimRes = await client.query<SimulationDbRow>(
        `UPDATE simulations
         SET status = 'completed'
         WHERE id = $1::uuid
         RETURNING id, scenario_id, analysis_run_id, status, created_at`,
        [simulationId],
      );

      const completedRow = completedSimRes.rows[0]!;
      const finalSimulation: Simulation = {
        id: completedRow.id,
        scenarioId: completedRow.scenario_id,
        analysisRunId: completedRow.analysis_run_id,
        status: "completed",
        createdAt: completedRow.created_at,
      };

      return {
        simulation: finalSimulation,
        engineResult,
        savedResults,
        evidence: writtenEvidence,
      };
    });
  } catch (error) {
    // On failure: transaction rolls back atomically.
    // Update simulation status to 'failed' in a separate connection.
    try {
      await updateSimulationStatus(pool, organizationId, simulationId, "failed");
    } catch {
      // Best-effort status update; keep original error
    }
    throw error;
  }
}
