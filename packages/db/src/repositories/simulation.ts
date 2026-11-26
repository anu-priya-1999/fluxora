import type {
  CreateScenarioInput,
  CreateSimulationInput,
  CreateSimulationResultInput,
  EvidenceRecord,
  EvidenceSubjectType,
  ListScenariosOptions,
  Scenario,
  ScenarioFailureType,
  Simulation,
  SimulationResult,
  SimulationResultState,
  SimulationStatus,
} from "@fluxora/shared-types";
import {
  ScenarioFailureTypes,
  SIMULATION_NARRATION_JOB_TYPE,
  simulationNarrationIdempotencyKey,
  SimulationResultStates,
  SimulationStatuses,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";
import { enqueueJob } from "./job.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Error Hierarchy for Step 52
// ---------------------------------------------------------------------------

export class SimulationPersistenceValidationError extends Error {
  readonly code = "invalid_input";
  constructor(message = "Simulation persistence fields are invalid.") {
    super(message);
    this.name = "SimulationPersistenceValidationError";
  }
}

export class ScenarioNotFoundError extends Error {
  readonly code = "scenario_not_found";
  constructor(message = "Scenario not found or inaccessible for this organization.") {
    super(message);
    this.name = "ScenarioNotFoundError";
  }
}

export class SimulationNotFoundError extends Error {
  readonly code = "simulation_not_found";
  constructor(message = "Simulation not found or inaccessible for this organization.") {
    super(message);
    this.name = "SimulationNotFoundError";
  }
}

export class SimulationResultNotFoundError extends Error {
  readonly code = "simulation_result_not_found";
  constructor(message = "Simulation result not found or inaccessible for this organization.") {
    super(message);
    this.name = "SimulationResultNotFoundError";
  }
}

export class SimulationConflictError extends Error {
  readonly code = "conflict";
  constructor(message = "Simulation storage conflict occurred.") {
    super(message);
    this.name = "SimulationConflictError";
  }
}

// ---------------------------------------------------------------------------
// Row Interfaces & Mappers
// ---------------------------------------------------------------------------

interface ScenarioRow {
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

interface SimulationRow {
  id: string;
  scenario_id: string;
  analysis_run_id: string;
  status: string;
  created_at: Date;
}

interface SimulationResultRow {
  id: string;
  simulation_id: string;
  node_id: string;
  resulting_state: string;
  propagation_path: string[];
  rule_applied: string;
  assumptions: string[];
  confidence: number;
  created_at: Date;
}

interface EvidenceRow {
  id: string;
  analysis_run_id: string;
  subject_type: string;
  subject_id: string;
  file_path: string;
  symbol_id: string | null;
  line_start: number | null;
  line_end: number | null;
  column_start: number | null;
  column_end: number | null;
  relationship_description: string;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    subjectType: row.subject_type as EvidenceSubjectType,
    subjectId: row.subject_id,
    filePath: row.file_path,
    symbolId: row.symbol_id,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    columnStart: row.column_start,
    columnEnd: row.column_end,
    relationshipDescription: row.relationship_description,
    confidence: row.confidence,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapScenarioRow(row: ScenarioRow): Scenario {
  return {
    id: row.id,
    organizationId: row.organization_id,
    repositoryId: row.repository_id,
    name: row.name,
    targetNodeId: row.target_node_id,
    failureType: row.failure_type as ScenarioFailureType,
    parameters: row.parameters ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapSimulationRow(row: SimulationRow): Simulation {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    analysisRunId: row.analysis_run_id,
    status: row.status as SimulationStatus,
    createdAt: row.created_at,
  };
}

function mapSimulationResultRow(row: SimulationResultRow): SimulationResult {
  return {
    id: row.id,
    simulationId: row.simulation_id,
    nodeId: row.node_id,
    resultingState: row.resulting_state as SimulationResultState,
    propagationPath: Array.isArray(row.propagation_path) ? row.propagation_path : [],
    ruleApplied: row.rule_applied,
    assumptions: Array.isArray(row.assumptions) ? row.assumptions : [],
    confidence: Number(row.confidence),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Scenario Repository Methods
// ---------------------------------------------------------------------------

/**
 * Creates a new Scenario experiment record scoped to an authenticated organization.
 * Validates that the repository and target graph node belong to the organization.
 */
export async function createScenario(
  pool: pg.Pool,
  input: CreateScenarioInput,
): Promise<Scenario> {
  const { organizationId, repositoryId, name, targetNodeId, failureType, parameters, createdBy } = input;

  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new SimulationPersistenceValidationError("organizationId must be a valid UUID string.");
  }
  if (!repositoryId || !UUID_REGEX.test(repositoryId)) {
    throw new SimulationPersistenceValidationError("repositoryId must be a valid UUID string.");
  }
  if (!targetNodeId || !UUID_REGEX.test(targetNodeId)) {
    throw new SimulationPersistenceValidationError("targetNodeId must be a valid UUID string.");
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new SimulationPersistenceValidationError("name must be a non-empty string.");
  }
  if (!ScenarioFailureTypes.includes(failureType)) {
    throw new SimulationPersistenceValidationError(
      `failureType must be one of: ${ScenarioFailureTypes.join(", ")}. Received: "${failureType}"`,
    );
  }
  if (createdBy !== undefined && createdBy !== null && !UUID_REGEX.test(createdBy)) {
    throw new SimulationPersistenceValidationError("createdBy must be a valid UUID string if provided.");
  }

  return withTenant(pool, organizationId, async (client) => {
    // 1. Verify repository belongs to organization
    const repoCheck = await client.query<{ id: string }>(
      `SELECT id FROM repositories WHERE id = $1::uuid AND organization_id = $2::uuid`,
      [repositoryId, organizationId],
    );
    if (repoCheck.rows.length === 0) {
      throw new SimulationPersistenceValidationError("Repository not found or does not belong to this organization.");
    }

    // 2. Verify target node exists and belongs to this repository & organization
    const nodeCheck = await client.query<{ id: string }>(
      `SELECT gn.id
       FROM graph_nodes gn
       WHERE gn.id = $1::uuid
         AND gn.repository_id = $2::uuid`,
      [targetNodeId, repositoryId],
    );
    if (nodeCheck.rows.length === 0) {
      throw new SimulationPersistenceValidationError("Target node does not exist in the specified repository.");
    }

    // 3. Insert scenario row
    const insertQuery = `
      INSERT INTO scenarios (
        organization_id, repository_id, name, target_node_id, failure_type, parameters, created_by
      )
      VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::jsonb, $7::uuid)
      RETURNING id, organization_id, repository_id, name, target_node_id, failure_type, parameters, created_by, created_at
    `;
    let res: pg.QueryResult<ScenarioRow>;
    try {
      res = await client.query<ScenarioRow>(insertQuery, [
        organizationId,
        repositoryId,
        name.trim(),
        targetNodeId,
        failureType,
        JSON.stringify(parameters ?? {}),
        createdBy ?? null,
      ]);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "23503"
      ) {
        const pgErr = err as { code: string; constraint?: string };
        if (pgErr.constraint === "scenarios_repository_target_node_fkey") {
          throw new SimulationPersistenceValidationError(
            "Target node does not exist in the specified repository.",
          );
        }
      }
      throw err;
    }

    const row = res.rows[0];
    if (!row) {
      throw new SimulationPersistenceValidationError("Failed to create scenario.");
    }
    return mapScenarioRow(row);
  });
}

/**
 * Retrieves a Scenario by ID within the authenticated organization scope.
 */
export async function getScenarioById(
  pool: pg.Pool,
  organizationId: string,
  scenarioId: string,
): Promise<Scenario | null> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(scenarioId)) {
    return null;
  }

  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<ScenarioRow>(
      `SELECT id, organization_id, repository_id, name, target_node_id, failure_type, parameters, created_by, created_at
       FROM scenarios
       WHERE id = $1::uuid AND organization_id = $2::uuid`,
      [scenarioId, organizationId],
    );
    const row = res.rows[0];
    return row ? mapScenarioRow(row) : null;
  });
}

/**
 * Lists Scenarios for an organization, optionally filtered by repository.
 * Results are sorted deterministically by creation date descending, then ID descending.
 */
export async function listScenarios(
  pool: pg.Pool,
  organizationId: string,
  options: ListScenariosOptions = {},
): Promise<Scenario[]> {
  if (!UUID_REGEX.test(organizationId)) {
    return [];
  }
  if (options.repositoryId && !UUID_REGEX.test(options.repositoryId)) {
    return [];
  }

  return withTenant(pool, organizationId, async (client) => {
    const conditions = ["organization_id = $1::uuid"];
    const params: unknown[] = [organizationId];

    if (options.repositoryId) {
      params.push(options.repositoryId);
      conditions.push(`repository_id = $${params.length}::uuid`);
    }

    let query = `
      SELECT id, organization_id, repository_id, name, target_node_id, failure_type, parameters, created_by, created_at
      FROM scenarios
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id DESC
    `;

    if (typeof options.limit === "number" && options.limit > 0) {
      params.push(options.limit);
      query += ` LIMIT $${params.length}`;
    }

    const res = await client.query<ScenarioRow>(query, params);
    return res.rows.map(mapScenarioRow);
  });
}

/**
 * Deletes a Scenario by ID within the authenticated organization scope.
 */
export async function deleteScenario(
  pool: pg.Pool,
  organizationId: string,
  scenarioId: string,
): Promise<boolean> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(scenarioId)) {
    return false;
  }

  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query(
      `DELETE FROM scenarios WHERE id = $1::uuid AND organization_id = $2::uuid`,
      [scenarioId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

// ---------------------------------------------------------------------------
// Simulation Repository Methods
// ---------------------------------------------------------------------------

/**
 * Creates a new Simulation execution record referencing a Scenario and AnalysisRun.
 *
 * Invariant Enforcement:
 * 1. The Scenario must belong to the organization.
 * 2. The AnalysisRun must belong to the same Repository as the Scenario.
 * 3. The Scenario's target node must belong to the specified AnalysisRun (Analysis-Run Snapshot Boundary).
 */
export async function createSimulation(
  pool: pg.Pool,
  organizationId: string,
  input: CreateSimulationInput,
): Promise<Simulation> {
  const { scenarioId, analysisRunId, status = "pending" } = input;

  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new SimulationPersistenceValidationError("organizationId must be a valid UUID string.");
  }
  if (!scenarioId || !UUID_REGEX.test(scenarioId)) {
    throw new SimulationPersistenceValidationError("scenarioId must be a valid UUID string.");
  }
  if (!analysisRunId || !UUID_REGEX.test(analysisRunId)) {
    throw new SimulationPersistenceValidationError("analysisRunId must be a valid UUID string.");
  }
  if (!SimulationStatuses.includes(status)) {
    throw new SimulationPersistenceValidationError(
      `status must be one of: ${SimulationStatuses.join(", ")}. Received: "${status}"`,
    );
  }

  return withTenant(pool, organizationId, async (client) => {
    // 1. Fetch Scenario and verify tenant access
    const scenarioRes = await client.query<{ id: string; repository_id: string; target_node_id: string }>(
      `SELECT id, repository_id, target_node_id
       FROM scenarios
       WHERE id = $1::uuid AND organization_id = $2::uuid`,
      [scenarioId, organizationId],
    );
    const scenario = scenarioRes.rows[0];
    if (!scenario) {
      throw new ScenarioNotFoundError("Scenario not found or inaccessible for this organization.");
    }

    // 2. Verify AnalysisRun belongs to the scenario's repository
    const runCheck = await client.query<{ id: string }>(
      `SELECT ar.id
       FROM analysis_runs ar
       JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
       WHERE ar.id = $1::uuid AND rs.repository_id = $2::uuid`,
      [analysisRunId, scenario.repository_id],
    );
    if (runCheck.rows.length === 0) {
      throw new SimulationPersistenceValidationError(
        "Analysis run does not belong to the scenario's repository.",
      );
    }

    // 3. Analysis-Run Snapshot Boundary: Verify target node belongs to this specific analysis run
    const targetCheck = await client.query<{ id: string }>(
      `SELECT id FROM graph_nodes WHERE id = $1::uuid AND analysis_run_id = $2::uuid`,
      [scenario.target_node_id, analysisRunId],
    );
    if (targetCheck.rows.length === 0) {
      throw new SimulationPersistenceValidationError(
        "Scenario target node does not belong to the specified analysis run.",
      );
    }

    // 4. Insert simulation record
    const insertQuery = `
      INSERT INTO simulations (scenario_id, analysis_run_id, status)
      VALUES ($1::uuid, $2::uuid, $3)
      RETURNING id, scenario_id, analysis_run_id, status, created_at
    `;
    const res = await client.query<SimulationRow>(insertQuery, [
      scenarioId,
      analysisRunId,
      status,
    ]);

    const row = res.rows[0];
    if (!row) {
      throw new SimulationPersistenceValidationError("Failed to create simulation.");
    }
    return mapSimulationRow(row);
  });
}

/**
 * Retrieves a Simulation by ID within the authenticated organization scope.
 */
export async function getSimulationById(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
): Promise<Simulation | null> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(simulationId)) {
    return null;
  }

  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<SimulationRow>(
      `SELECT sim.id, sim.scenario_id, sim.analysis_run_id, sim.status, sim.created_at
       FROM simulations sim
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sim.id = $1::uuid AND s.organization_id = $2::uuid`,
      [simulationId, organizationId],
    );
    const row = res.rows[0];
    return row ? mapSimulationRow(row) : null;
  });
}

/**
 * Lists all Simulations for a Scenario, sorted by creation date descending, then ID descending.
 */
export async function listSimulationsForScenario(
  pool: pg.Pool,
  organizationId: string,
  scenarioId: string,
): Promise<Simulation[]> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(scenarioId)) {
    return [];
  }

  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<SimulationRow>(
      `SELECT sim.id, sim.scenario_id, sim.analysis_run_id, sim.status, sim.created_at
       FROM simulations sim
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sim.scenario_id = $1::uuid AND s.organization_id = $2::uuid
       ORDER BY sim.created_at DESC, sim.id DESC`,
      [scenarioId, organizationId],
    );
    return res.rows.map(mapSimulationRow);
  });
}

/**
 * Updates the lifecycle status of a Simulation.
 */
export async function updateSimulationStatus(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
  status: SimulationStatus,
): Promise<Simulation> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(simulationId)) {
    throw new SimulationPersistenceValidationError("Invalid organizationId or simulationId UUID.");
  }
  if (!SimulationStatuses.includes(status)) {
    throw new SimulationPersistenceValidationError(
      `status must be one of: ${SimulationStatuses.join(", ")}. Received: "${status}"`,
    );
  }

  return withTenant(pool, organizationId, async (client) => {
    const checkRes = await client.query<{ id: string }>(
      `SELECT sim.id
       FROM simulations sim
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sim.id = $1::uuid AND s.organization_id = $2::uuid`,
      [simulationId, organizationId],
    );
    if (checkRes.rows.length === 0) {
      throw new SimulationNotFoundError("Simulation not found or inaccessible for this organization.");
    }

    const updateRes = await client.query<SimulationRow>(
      `UPDATE simulations
       SET status = $1
       WHERE id = $2::uuid
       RETURNING id, scenario_id, analysis_run_id, status, created_at`,
      [status, simulationId],
    );

    const row = updateRes.rows[0];
    if (!row) {
      throw new SimulationNotFoundError("Failed to update simulation status.");
    }
    return mapSimulationRow(row);
  });
}

// ---------------------------------------------------------------------------
// SimulationResult Repository Methods
// ---------------------------------------------------------------------------

/**
 * Creates or updates an individual SimulationResult record.
 */
export async function createSimulationResult(
  pool: pg.Pool,
  organizationId: string,
  input: CreateSimulationResultInput,
): Promise<SimulationResult> {
  const simulationId = input.simulationId;
  if (!simulationId) {
    throw new SimulationPersistenceValidationError("simulationId is required.");
  }
  const results = await saveSimulationResults(pool, organizationId, simulationId, [input]);
  const result = results[0];
  if (!result) {
    throw new SimulationPersistenceValidationError("Failed to create simulation result.");
  }
  return result;
}

/**
 * Saves a batch of SimulationResult records for a Simulation in a single atomic transaction.
 *
 * Invariant Enforcement:
 * 1. The Simulation must belong to the authenticated organization.
 * 2. Every result nodeId must belong to the Simulation's AnalysisRun snapshot.
 * 3. resultingState must be one of 'healthy', 'degraded', 'at_risk', 'failed'.
 * 4. confidence must be within [0.0, 1.0].
 * 5. Uses ON CONFLICT (simulation_id, node_id) DO UPDATE for deterministic idempotency.
 */
export async function saveSimulationResults(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
  results: readonly CreateSimulationResultInput[],
): Promise<SimulationResult[]> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(simulationId)) {
    throw new SimulationPersistenceValidationError("Invalid organizationId or simulationId UUID.");
  }
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  // Validate each result input before database interaction
  for (const r of results) {
    if (!r.nodeId || !UUID_REGEX.test(r.nodeId)) {
      throw new SimulationPersistenceValidationError(`nodeId must be a valid UUID string: "${r.nodeId}"`);
    }
    if (!SimulationResultStates.includes(r.resultingState)) {
      throw new SimulationPersistenceValidationError(
        `resultingState must be one of: ${SimulationResultStates.join(", ")}. Received: "${r.resultingState}"`,
      );
    }
    if (typeof r.ruleApplied !== "string" || r.ruleApplied.trim().length === 0) {
      throw new SimulationPersistenceValidationError("ruleApplied must be a non-empty string.");
    }
    if (r.confidence !== undefined && (typeof r.confidence !== "number" || r.confidence < 0.0 || r.confidence > 1.0 || isNaN(r.confidence))) {
      throw new SimulationPersistenceValidationError(
        `confidence must be a number between 0.0 and 1.0. Received: ${r.confidence}`,
      );
    }
  }

  return withTenant(pool, organizationId, async (client) => {
    // 1. Fetch simulation and verify tenant access
    const simRes = await client.query<{ id: string; analysis_run_id: string }>(
      `SELECT sim.id, sim.analysis_run_id
       FROM simulations sim
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sim.id = $1::uuid AND s.organization_id = $2::uuid`,
      [simulationId, organizationId],
    );
    const simRow = simRes.rows[0];
    if (!simRow) {
      throw new SimulationNotFoundError("Simulation not found or inaccessible for this organization.");
    }
    const { analysis_run_id: analysisRunId } = simRow;

    // 2. Verify all nodeIds belong to the simulation's analysis run
    const nodeIds = Array.from(new Set(results.map((r) => r.nodeId)));
    const nodesCheck = await client.query<{ id: string }>(
      `SELECT id FROM graph_nodes WHERE id = ANY($1::uuid[]) AND analysis_run_id = $2::uuid`,
      [nodeIds, analysisRunId],
    );
    if (nodesCheck.rows.length !== nodeIds.length) {
      const foundIds = new Set(nodesCheck.rows.map((n) => n.id));
      const missingId = nodeIds.find((id) => !foundIds.has(id));
      throw new SimulationPersistenceValidationError(
        `Node "${missingId}" does not belong to the simulation's analysis run.`,
      );
    }

    // 3. Insert or update simulation results
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

    for (const r of results) {
      const confidence = r.confidence ?? 1.0;
      const propagationPath = r.propagationPath ?? [];
      const assumptions = r.assumptions ?? [];

      const res = await client.query<SimulationResultRow>(upsertQuery, [
        simulationId,
        r.nodeId,
        r.resultingState,
        JSON.stringify(propagationPath),
        r.ruleApplied.trim(),
        JSON.stringify(assumptions),
        confidence,
      ]);

      const row = res.rows[0];
      if (row) {
        savedResults.push(mapSimulationResultRow(row));
      }
    }

    return savedResults;
  });
}

/**
 * Retrieves a SimulationResult by ID within the authenticated organization scope.
 */
export async function getSimulationResultById(
  pool: pg.Pool,
  organizationId: string,
  resultId: string,
): Promise<SimulationResult | null> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(resultId)) {
    return null;
  }

  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<SimulationResultRow>(
      `SELECT sr.id, sr.simulation_id, sr.node_id, sr.resulting_state, sr.propagation_path, sr.rule_applied, sr.assumptions, sr.confidence, sr.created_at
       FROM simulation_results sr
       JOIN simulations sim ON sim.id = sr.simulation_id
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sr.id = $1::uuid AND s.organization_id = $2::uuid`,
      [resultId, organizationId],
    );
    const row = res.rows[0];
    return row ? mapSimulationResultRow(row) : null;
  });
}

/**
 * Lists all SimulationResults for a Simulation, sorted deterministically by creation date ascending, then ID ascending.
 */
export async function listSimulationResults(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
): Promise<SimulationResult[]> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(simulationId)) {
    return [];
  }

  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<SimulationResultRow>(
      `SELECT sr.id, sr.simulation_id, sr.node_id, sr.resulting_state, sr.propagation_path, sr.rule_applied, sr.assumptions, sr.confidence, sr.created_at
       FROM simulation_results sr
       JOIN simulations sim ON sim.id = sr.simulation_id
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sr.simulation_id = $1::uuid AND s.organization_id = $2::uuid
       ORDER BY sr.created_at ASC, sr.id ASC`,
      [simulationId, organizationId],
    );
    return res.rows.map(mapSimulationResultRow);
  });
}

/**
 * Retrieves all simulation_state evidence records associated with a specific simulation run.
 * Enforces tenant isolation by verifying the simulation belongs to the organization's scenario.
 */
export async function listSimulationEvidence(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
): Promise<EvidenceRecord[]> {
  if (!UUID_REGEX.test(simulationId) || !UUID_REGEX.test(organizationId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const checkRes = await client.query<{ id: string }>(
      `SELECT sim.id
       FROM simulations sim
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sim.id = $1::uuid AND s.organization_id = $2::uuid`,
      [simulationId, organizationId],
    );
    if (!checkRes.rows[0]) {
      return [];
    }

    const res = await client.query<EvidenceRow>(
      `SELECT id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
              line_start, line_end, column_start, column_end, relationship_description,
              confidence, metadata, created_at
       FROM evidence
       WHERE subject_type = 'simulation_state'
         AND metadata->>'simulationId' = $1
       ORDER BY created_at ASC, id ASC`,
      [simulationId],
    );
    return res.rows.map(mapEvidenceRow);
  });
}

// ---------------------------------------------------------------------------
// Step 63: Narration Job Reconciliation & Recovery
// ---------------------------------------------------------------------------

export interface ReconcileSimulationNarrationResult {
  readonly recovered: boolean;
  readonly reason?: string | undefined;
  readonly jobId?: string | undefined;
}

export interface ReconcileMissingSimulationNarrationJobsOptions {
  readonly organizationId?: string | undefined;
  readonly olderThanSeconds?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ReconcileMissingSimulationNarrationJobsResult {
  readonly reconciledCount: number;
  readonly enqueuedJobIds: readonly string[];
}

/**
 * Checks a specific completed simulation for missing AI narration and enqueues a job if missing.
 * Safe to call concurrently or repeatedly: uses idempotency keys to prevent duplicate jobs.
 */
export async function reconcileSimulationNarrationJob(
  pool: pg.Pool,
  organizationId: string,
  simulationId: string,
): Promise<ReconcileSimulationNarrationResult> {
  if (!UUID_REGEX.test(organizationId) || !UUID_REGEX.test(simulationId)) {
    return { recovered: false, reason: "invalid_uuid" };
  }

  return withTenant(pool, organizationId, async (client) => {
    // 1. Verify simulation exists, belongs to tenant, and is completed
    const simRes = await client.query<{ id: string; status: string }>(
      `SELECT sim.id, sim.status
       FROM simulations sim
       JOIN scenarios s ON s.id = sim.scenario_id
       WHERE sim.id = $1::uuid AND s.organization_id = $2::uuid`,
      [simulationId, organizationId],
    );
    const sim = simRes.rows[0];
    if (!sim) {
      return { recovered: false, reason: "simulation_not_found" };
    }
    if (sim.status !== "completed") {
      return { recovered: false, reason: "simulation_not_completed" };
    }

    // 2. Check if AI analysis record already exists in terminal completed state
    const analysisRes = await client.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM ai_analyses
       WHERE organization_id = $1::uuid
         AND subject_type = 'simulation'
         AND subject_id = $2::uuid`,
      [organizationId, simulationId],
    );
    const analysis = analysisRes.rows[0];
    if (analysis && (analysis.status === "completed" || analysis.status === "rejected")) {
      return { recovered: false, reason: "already_completed" };
    }

    // 3. Check if an active/pending job is currently in flight
    const jobKey = simulationNarrationIdempotencyKey(simulationId);
    const activeJobRes = await client.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM jobs
       WHERE organization_id = $1::uuid
         AND type = $2
         AND idempotency_key = $3
         AND status IN ('pending', 'running')`,
      [organizationId, SIMULATION_NARRATION_JOB_TYPE, jobKey],
    );
    if (activeJobRes.rows.length > 0) {
      return { recovered: false, reason: "job_already_active", jobId: activeJobRes.rows[0]?.id ?? undefined };
    }

    // 4. Enqueue recovery job via idempotency upsert
    const enqueued = await enqueueJob(
      {
        organizationId,
        type: SIMULATION_NARRATION_JOB_TYPE,
        idempotencyKey: jobKey,
        payload: { simulationId },
      },
      pool,
    );

    return { recovered: true, jobId: enqueued.id };
  });
}

/**
 * Sweeper/reconciler that finds completed simulations lacking AI narration and active jobs,
 * and enqueues simulation.narration jobs to ensure no narration job remains permanently lost.
 */
export async function reconcileMissingSimulationNarrationJobs(
  pool: pg.Pool,
  options?: ReconcileMissingSimulationNarrationJobsOptions,
): Promise<ReconcileMissingSimulationNarrationJobsResult> {
  const olderThanSeconds = options?.olderThanSeconds ?? 5;
  const limit = options?.limit ?? 50;
  const organizationId = options?.organizationId;

  const query = `
    SELECT sim.id, s.organization_id
    FROM simulations sim
    JOIN scenarios s ON s.id = sim.scenario_id
    LEFT JOIN ai_analyses a
      ON a.organization_id = s.organization_id
      AND a.subject_type = 'simulation'
      AND a.subject_id = sim.id
    LEFT JOIN jobs j
      ON j.organization_id = s.organization_id
      AND j.type = $1
      AND j.idempotency_key = $2 || sim.id::text
      AND j.status IN ('pending', 'running')
    WHERE sim.status = 'completed'
      AND sim.created_at < now() - ($3 || ' seconds')::interval
      AND a.id IS NULL
      AND j.id IS NULL
      ${organizationId ? "AND s.organization_id = $4::uuid" : ""}
    ORDER BY sim.created_at ASC
    LIMIT ${limit}
  `;

  const params: unknown[] = [
    SIMULATION_NARRATION_JOB_TYPE,
    "simulation.narration:",
    olderThanSeconds,
  ];
  if (organizationId) {
    params.push(organizationId);
  }

  const res = await pool.query<{ id: string; organization_id: string }>(query, params);
  const enqueuedJobIds: string[] = [];

  for (const row of res.rows) {
    const jobKey = simulationNarrationIdempotencyKey(row.id);
    const job = await enqueueJob(
      {
        organizationId: row.organization_id,
        type: SIMULATION_NARRATION_JOB_TYPE,
        idempotencyKey: jobKey,
        payload: { simulationId: row.id },
      },
      pool,
    );
    enqueuedJobIds.push(job.id);
  }

  return {
    reconciledCount: enqueuedJobIds.length,
    enqueuedJobIds,
  };
}
