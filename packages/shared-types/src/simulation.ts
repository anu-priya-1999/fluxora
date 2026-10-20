/**
 * Failure types supported by the architectural Scenario definition.
 * Note: MVP rule table in Step 53 implements "unavailable" and "latency",
 * but "capacity" and "removal" are valid domain failure types supported at the schema layer.
 */
export const ScenarioFailureTypes = [
  "unavailable",
  "latency",
  "capacity",
  "removal",
] as const;

export type ScenarioFailureType = (typeof ScenarioFailureTypes)[number];

/**
 * Resulting states for affected nodes in a simulation result.
 */
export const SimulationResultStates = [
  "healthy",
  "degraded",
  "at_risk",
  "failed",
] as const;

export type SimulationResultState = (typeof SimulationResultStates)[number];

/**
 * Valid lifecycle states for a simulation run.
 */
export const SimulationStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type SimulationStatus = (typeof SimulationStatuses)[number];

/**
 * Persisted Scenario record (Step 52).
 * Defines what experiment is being simulated and the target graph node.
 */
export interface Scenario {
  readonly id: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly targetNodeId: string;
  readonly failureType: ScenarioFailureType;
  readonly parameters: Record<string, unknown>;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

/**
 * Persisted Simulation record (Step 52).
 * Records an execution of a Scenario against a specific AnalysisRun graph snapshot.
 */
export interface Simulation {
  readonly id: string;
  readonly scenarioId: string;
  readonly analysisRunId: string;
  readonly status: SimulationStatus;
  readonly createdAt: Date;
}

/**
 * Persisted SimulationResult record (Step 52).
 * Records the deterministic resulting state of an individual graph node in a simulation.
 */
export interface SimulationResult {
  readonly id: string;
  readonly simulationId: string;
  readonly nodeId: string;
  readonly resultingState: SimulationResultState;
  readonly propagationPath: readonly string[];
  readonly ruleApplied: string;
  readonly assumptions: readonly string[];
  readonly confidence: number;
  readonly createdAt: Date;
}

/**
 * Input for creating a new Scenario.
 */
export interface CreateScenarioInput {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly targetNodeId: string;
  readonly failureType: ScenarioFailureType;
  readonly parameters?: Record<string, unknown>;
  readonly createdBy?: string | null;
}

/**
 * Input for creating a new Simulation execution record.
 */
export interface CreateSimulationInput {
  readonly scenarioId: string;
  readonly analysisRunId: string;
  readonly status?: SimulationStatus;
}

/**
 * Input for creating an individual node SimulationResult.
 */
export interface CreateSimulationResultInput {
  readonly simulationId?: string;
  readonly nodeId: string;
  readonly resultingState: SimulationResultState;
  readonly propagationPath?: readonly string[];
  readonly ruleApplied: string;
  readonly assumptions?: readonly string[];
  readonly confidence?: number;
}

/**
 * Options for listing scenarios in an organization.
 */
export interface ListScenariosOptions {
  readonly repositoryId?: string;
  readonly limit?: number;
}
