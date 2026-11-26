/**
 * @file types.ts
 * Types and contracts for the Simulation Narration Context Assembler (Phase 9 Step 63).
 *
 * Defines the deterministic, strongly-typed representation of a completed
 * Simulation run, Scenario, SimulationResults, and simulation_state Evidence,
 * ready for provider-independent model prompt generation.
 */

import type {
  EvidenceRecord,
  Scenario,
  ScenarioFailureType,
  Simulation,
  SimulationCausalStep,
  SimulationResult,
  SimulationResultState,
  SimulationStatus,
} from "@fluxora/shared-types";

/**
 * Named, configurable limits for simulation narration context budgeting.
 */
export interface SimulationContextLimits {
  /** Maximum total serialized compact JSON characters for the assembled context envelope. */
  readonly maxTotalCharacters: number;
  /** Maximum node results retained. */
  readonly maxResults: number;
  /** Maximum evidence records retained. */
  readonly maxEvidenceRecords: number;
  /** Maximum character length of individual untrusted repository/scenario strings. */
  readonly maxStringLength: number;
}

export const DEFAULT_SIMULATION_CONTEXT_LIMITS: Readonly<SimulationContextLimits> =
  Object.freeze({
    maxTotalCharacters: 30_000,
    maxResults: 50,
    maxEvidenceRecords: 50,
    maxStringLength: 500,
  });

/**
 * Bounded representation of a Scenario configuration.
 */
export interface BoundedScenario {
  readonly id: string;
  readonly name: string;
  readonly targetNodeId: string;
  readonly failureType: ScenarioFailureType;
  readonly parameters: Record<string, unknown>;
}

/**
 * Bounded representation of an individual node simulation result for model consumption.
 */
export interface BoundedSimulationNodeResult {
  readonly nodeId: string;
  readonly resultingState: SimulationResultState;
  readonly ruleApplied: string;
  readonly assumptions: readonly string[];
  readonly confidence: number;
  readonly hopDistance: number;
  readonly capped: boolean;
  readonly propagationPath: readonly SimulationCausalStep[];
  /** Evidence IDs verified against retained evidence records in this context. */
  readonly evidenceIds: readonly string[];
}

/**
 * Bounded representation of a simulation_state evidence record selected for context.
 */
export interface BoundedSimulationEvidenceRecord {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly filePath: string;
  readonly symbolId: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly columnStart: number | null;
  readonly columnEnd: number | null;
  readonly relationshipDescription: string;
  readonly confidence: number;
  readonly nodeId: string;
  readonly resultingState: string;
  readonly ruleApplied: string;
}

/**
 * Summary metrics of the deterministic simulation run.
 */
export interface BoundedSimulationExecutionMetrics {
  readonly totalResults: number;
  readonly affectedCount: number;
  readonly failedCount: number;
  readonly degradedCount: number;
  readonly atRiskCount: number;
  readonly healthyCount: number;
  readonly cappedCount: number;
  readonly maxHopDistance: number;
}

/**
 * Transparent tracking of context limits and truncation.
 */
export interface SimulationTruncationDetails {
  readonly isTruncated: boolean;
  readonly reasons: readonly string[];
  readonly omittedResultsCount: number;
  readonly omittedEvidenceCount: number;
}

/**
 * Strongly-typed, bounded representation of a completed simulation run assembled for LLM narration.
 */
export interface SimulationNarrationContext {
  readonly simulationId: string;
  readonly scenarioId: string;
  readonly analysisRunId: string;
  readonly status: SimulationStatus;
  readonly scenario: BoundedScenario;
  readonly results: readonly BoundedSimulationNodeResult[];
  readonly executionMetrics: BoundedSimulationExecutionMetrics;
  /** Strictly verified allowed evidence IDs for manifest grounding. */
  readonly allowedEvidenceIds: readonly string[];
  /** Retained bounded evidence records corresponding to allowedEvidenceIds. */
  readonly evidenceRecords: readonly BoundedSimulationEvidenceRecord[];
  /** True if context limits caused truncation. */
  readonly truncated: boolean;
  /** Human-readable explanation of truncation, or null if complete. */
  readonly truncationReason: string | null;
  /** Structured truncation metadata for diagnostics. */
  readonly truncation: SimulationTruncationDetails;
}

export interface AssembleSimulationNarrationContextParams {
  readonly simulation: Simulation;
  readonly scenario: Scenario;
  readonly results: readonly SimulationResult[];
  readonly evidenceRecords: readonly EvidenceRecord[];
  readonly limits?: Partial<SimulationContextLimits> | undefined;
}

export class SimulationNarrationContextError extends Error {
  readonly code: "not_found" | "not_completed" | "invalid_input";

  constructor(
    code: "not_found" | "not_completed" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "SimulationNarrationContextError";
    this.code = code;
  }

  static notFound(message = "Simulation not found or inaccessible."): SimulationNarrationContextError {
    return new SimulationNarrationContextError("not_found", message);
  }

  static notCompleted(message = "Simulation is not in completed state."): SimulationNarrationContextError {
    return new SimulationNarrationContextError("not_completed", message);
  }

  static invalidInput(message = "Invalid simulation context input."): SimulationNarrationContextError {
    return new SimulationNarrationContextError("invalid_input", message);
  }
}
