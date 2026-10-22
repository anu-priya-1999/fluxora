import type {
  GraphEdge,
  GraphEdgeProvenance,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
} from "./graph.ts";

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
 * Canonical rule identifier for scenario target failure seed.
 */
export const RULE_ID_TARGET_FAILURE = "target_failure" as const;

/**
 * Structured causal step explaining why a node reached a simulation state (Step 54).
 */
export interface SimulationCausalStep {
  readonly nodeId: string;
  readonly edgeId?: string | null | undefined;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly previousState: SimulationResultState;
  readonly resultingState: SimulationResultState;
  readonly assumptions: readonly string[];
  readonly confidence: number;
  readonly capped?: boolean | undefined;
}

export type SimulationPropagationPathStep = SimulationCausalStep | string;

/**
 * Persisted SimulationResult record (Step 52 & Step 54).
 * Records the deterministic resulting state of an individual graph node in a simulation.
 */
export interface SimulationResult {
  readonly id: string;
  readonly simulationId: string;
  readonly nodeId: string;
  readonly resultingState: SimulationResultState;
  readonly propagationPath: readonly (SimulationCausalStep | string)[];
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
  readonly propagationPath?: readonly (SimulationCausalStep | string)[];
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

// ---------------------------------------------------------------------------
// Simulation Rule Table Domain Contracts (Step 53)
// ---------------------------------------------------------------------------

/**
 * Three-state boolean representation for simulation metadata properties:
 * - true: verified present / confirmed
 * - false: verified absent / confirmed
 * - "unknown": not detected, not inspectable, or omitted from static analysis
 */
export type MetadataPresence = boolean | "unknown";

/**
 * Current default version of the Simulation Rule Table.
 */
export const DEFAULT_SIMULATION_RULE_TABLE_VERSION = "1.0.0" as const;

/**
 * Canonical rule identifiers for the normative simulation rule table.
 */
export const SimulationRuleIds = [
  "CALLS_CIRCUIT_BREAKER",
  "CALLS_SYNC_NO_FALLBACK",
  "WRITES_FAILURE_DEPENDENT_READS",
  "EMITS_CONSUMER_AT_RISK",
] as const;

export type SimulationRuleId = (typeof SimulationRuleIds)[number] | (string & {});

/**
 * Which node relative to the edge being evaluated is affected by the rule decision.
 */
export type AffectedNodeRole = "source" | "target" | "none";

/**
 * Input evaluated by a simulation rule.
 */
export interface SimulationRuleInput {
  /** The edge type (e.g. "CALLS", "WRITES", "QUERIES_DB", "EMITS_EVENT", "CONSUMES_EVENT", or shorthand "EMITS") */
  readonly edgeType: GraphEdgeType;

  /** Current state of the edge's source node */
  readonly sourceState: SimulationResultState;

  /** Current state of the edge's target node */
  readonly targetState: SimulationResultState;

  /**
   * Whether the interaction is synchronous:
   * - true: confirmed synchronous
   * - false: confirmed asynchronous
   * - "unknown" (or undefined): unknown/unverified -> conservative default (synchronous)
   */
  readonly sync?: MetadataPresence | undefined;

  /**
   * Whether a fallback handler/mechanism is present:
   * - true: fallback handler present (suppresses calls.sync.no_fallback)
   * - false: verified absent
   * - "unknown" (or undefined): unknown/unverified -> conservative assumption (no fallback assumed)
   */
  readonly hasFallback?: MetadataPresence | undefined;

  /**
   * Whether a circuit breaker is present on the dependency call:
   * - true: circuit breaker present (triggers calls.circuit_breaker)
   * - false: verified absent
   * - "unknown" (or undefined): unknown/unverified -> conservative assumption (no circuit breaker assumed)
   */
  readonly hasCircuitBreaker?: MetadataPresence | undefined;

  /**
   * The scenario failure type being simulated (MVP: "unavailable" | "latency").
   * Defaults to "unavailable" if not specified.
   */
  readonly failureType?: ScenarioFailureType | undefined;

  /**
   * Explicit flag indicating a write failure occurred on the datastore / write edge.
   */
  readonly isWriteFailure?: boolean | undefined;

  /**
   * Optional name of the source node for generating human-readable assumptions.
   */
  readonly sourceNodeName?: string | undefined;

  /**
   * Optional name of the target node for generating human-readable assumptions.
   */
  readonly targetNodeName?: string | undefined;

  /**
   * Raw metadata map from the GraphEdge, allowing rules to inspect custom properties.
   */
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * The decision output from evaluating a simulation rule.
 */
export interface SimulationRuleDecision {
  /** Whether the rule matched the input conditions */
  readonly matched: boolean;

  /**
   * The resulting state for the affected node.
   * Undefined if matched is false.
   */
  readonly resultingState?: SimulationResultState | undefined;

  /**
   * Identifier of the rule that produced this decision.
   */
  readonly ruleId: string;

  /**
   * Version of the rule / rule table that produced this decision.
   */
  readonly ruleVersion: string;

  /**
   * Which node in the edge relationship is affected by this decision:
   * - "source": the source node transitions to resultingState (e.g. caller, dependent reader, event producer)
   * - "target": the target node transitions to resultingState (e.g. event consumer)
   * - "none": neither node changes state
   */
  readonly affectedNode?: AffectedNodeRole | undefined;

  /**
   * Whether propagation is capped at the affected node (e.g. circuit breaker tripped),
   * preventing downstream cascading failure from propagating further.
   */
  readonly capped?: boolean | undefined;

  /**
   * Explicit list of assumptions made during evaluation (e.g. conservative defaults
   * used because edge metadata was unknown or unverified).
   */
  readonly assumptions: readonly string[];

  /**
   * Confidence score in [0.0, 1.0] for the rule decision.
   * Reflected lower when assumptions are made due to unknown metadata.
   */
  readonly confidence: number;
}

/**
 * A versioned, deterministic simulation rule.
 */
export interface SimulationRule {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly supportedEdgeTypes: readonly GraphEdgeType[];
  readonly evaluate: (input: SimulationRuleInput) => SimulationRuleDecision;
}

/**
 * A versioned table of simulation rules.
 */
export interface SimulationRuleTable {
  readonly version: string;
  readonly rules: readonly SimulationRule[];
}

/**
 * Normalized edge metadata relevant to simulation propagation.
 */
export interface ExtractedSimulationEdgeMetadata {
  readonly sync: MetadataPresence;
  readonly hasFallback: MetadataPresence;
  readonly hasCircuitBreaker: MetadataPresence;
}

// ---------------------------------------------------------------------------
// Simulation Engine Contracts (Step 54)
// ---------------------------------------------------------------------------

/**
 * Node definition in a SimulationGraphSnapshot.
 */
export interface SimulationNode {
  readonly id: string;
  readonly canonicalId?: string | null | undefined;
  readonly nodeType?: GraphNodeType | string | undefined;
  readonly name: string;
  readonly path?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly confidence?: number | undefined;
  readonly analysisRunId?: string | undefined;
}

/**
 * Edge definition in a SimulationGraphSnapshot.
 */
export interface SimulationEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: GraphEdgeType;
  readonly canonicalId?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly confidence?: number | undefined;
  readonly provenance?: GraphEdgeProvenance | string | undefined;
  readonly analysisRunId?: string | undefined;
}

/**
 * Snapshot of a deterministic graph structure scoped to a single analysis run.
 */
export interface SimulationGraphSnapshot {
  readonly analysisRunId: string;
  readonly nodes: readonly (GraphNode | SimulationNode)[];
  readonly edges: readonly (GraphEdge | SimulationEdge)[];
}

/**
 * Input contract for the pure Simulation Engine propagation runner.
 */
export interface SimulationEngineInput {
  readonly scenario: Scenario | {
    readonly id?: string | undefined;
    readonly targetNodeId: string;
    readonly failureType: ScenarioFailureType;
    readonly parameters?: Record<string, unknown> | undefined;
  };
  readonly graph: SimulationGraphSnapshot;
  readonly ruleTable?: SimulationRuleTable | undefined;
  readonly options?: {
    readonly maxIterations?: number | undefined;
  } | undefined;
}

/**
 * Simulation result for an individual affected node produced by the engine.
 */
export interface SimulationEngineNodeResult {
  readonly nodeId: string;
  readonly resultingState: SimulationResultState;
  readonly propagationPath: readonly SimulationCausalStep[];
  readonly ruleApplied: string;
  readonly assumptions: readonly string[];
  readonly confidence: number;
  readonly capped?: boolean | undefined;
}

/**
 * Complete outcome produced by running the deterministic Simulation Engine.
 */
export interface SimulationEngineResult {
  readonly converged: boolean;
  readonly iterations: number;
  readonly ruleTableVersion: string;
  readonly results: readonly SimulationEngineNodeResult[];
  readonly nodeStates: ReadonlyMap<string, SimulationResultState>;
}
