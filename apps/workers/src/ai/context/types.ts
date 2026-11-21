/**
 * @file types.ts
 * Types and contracts for the Impact Explanation Context Assembler.
 *
 * Defines the minimal, deterministic, typed representation of an impact analysis
 * and its evidence, ready for provider-independent model prompt generation.
 */

import type {
  EvidenceRecord,
  ImpactAnalysis,
  ImpactAnalysisStatus,
} from "@fluxora/shared-types";

/**
 * Named, configurable limits for context assembly and budgeting.
 */
export interface ContextLimits {
  /**
   * Maximum total serialized compact JSON characters for the assembled context envelope.
   *
   * NOTE: This bounds the raw compact JSON envelope (ImpactExplanationContext) during assembly.
   * It must NOT be confused with the final request message limit (MAX_REQUEST_MESSAGE_CHARACTERS = 100,000),
   * which independently bounds the final ModelGatewayRequest.messages[0].content after pretty-printing (space=2),
   * secondary evidence manifest serialization, static prompt instructions, truncation disclosures,
   * and Unicode escaping of markup-significant characters. They are separate boundaries.
   *
   * Note also that character limits are deterministic application-level safeguards, not tokenizers;
   * provider-specific token windows are handled downstream by the Model Gateway and provider policies.
   */
  readonly maxTotalCharacters: number;
  /** Maximum findings retained across all categories. */
  readonly maxFindings: number;
  /** Maximum evidence records retained. */
  readonly maxEvidenceRecords: number;
  /** Maximum character length of individual untrusted repository-derived strings. */
  readonly maxStringLength: number;
  /** Maximum unresolved file entries retained. */
  readonly maxUnresolvedFiles: number;
}

/**
 * Default limits matching the Step 59 cost model and Claude token budgets.
 */
export const DEFAULT_CONTEXT_LIMITS: Readonly<ContextLimits> = Object.freeze({
  maxTotalCharacters: 30_000,
  maxFindings: 50,
  maxEvidenceRecords: 50,
  maxStringLength: 500,
  maxUnresolvedFiles: 20,
});

/**
 * Allowlisted representation of an impact finding for model consumption.
 * Excludes arbitrary GraphNode.metadata and database internals.
 */
export interface BoundedFinding {
  readonly nodeId: string;
  readonly name: string;
  readonly nodeType: string;
  readonly filePath: string | null;
  readonly depth: number;
  readonly confidence: number;
  readonly path: readonly string[];
  /** Evidence IDs verified against the retained evidence records in this context. */
  readonly evidenceIds: readonly string[];
}

/**
 * Bounded representation of a pull request changed file that could not be mapped to the graph.
 */
export interface BoundedUnresolvedFile {
  readonly path: string;
  readonly reason: string;
}

/**
 * Bounded representation of an evidence record selected for the context.
 * Excludes arbitrary database metadata and internal fields.
 */
export interface BoundedEvidenceRecord {
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
}

/**
 * Execution metrics summarizing the underlying deterministic graph traversal.
 */
export interface BoundedExecutionMetrics {
  readonly totalSeedNodes: number;
  readonly totalAffectedNodes: number;
  readonly totalEdgesTraversed: number;
  readonly durationMs: number;
  readonly maxDepthReached: number;
}

/**
 * Explicit, transparent truncation tracking.
 */
export interface TruncationDetails {
  /** True if either the underlying impact analysis or context limits caused truncation. */
  readonly isTruncated: boolean;
  /** True if the underlying graph traversal was truncated. */
  readonly analysisWasTruncated: boolean;
  /** Underlying analysis truncation reason if provided. */
  readonly analysisTruncationReason: string | null;
  /** True if context limits (findings, evidence, characters, unresolved files) caused truncation. */
  readonly contextLimitsExceeded: boolean;
  /** Human-readable list of truncation reasons. */
  readonly reasons: readonly string[];
  /** Count of findings omitted due to context limits or character budgeting. */
  readonly omittedFindingsCount: number;
  /** Count of evidence records omitted due to limits or orphaned finding omission. */
  readonly omittedEvidenceCount: number;
  /** Count of unresolved files omitted due to limits. */
  readonly omittedUnresolvedFilesCount: number;
}

/**
 * Strongly-typed, minimal representation of a persisted impact analysis
 * assembled for LLM narration.
 */
export interface ImpactExplanationContext {
  readonly impactAnalysisId: string;
  readonly pullRequestId: string;
  readonly analysisRunId: string;
  readonly status: ImpactAnalysisStatus;
  readonly directImpact: readonly BoundedFinding[];
  readonly downstreamImpact: readonly BoundedFinding[];
  readonly affectedApis: readonly BoundedFinding[];
  readonly affectedEvents: readonly BoundedFinding[];
  readonly affectedServices: readonly BoundedFinding[];
  readonly workflowImpactSummary: readonly string[];
  readonly unresolvedFiles: readonly BoundedUnresolvedFile[];
  readonly executionMetrics: BoundedExecutionMetrics;
  /** Primary truncation flag. True if underlying analysis was truncated or context limits were exceeded. */
  readonly truncated: boolean;
  /** Formatted truncation reason string, or null if un-truncated. */
  readonly truncationReason: string | null;
  /** Structured truncation metadata for detailed reporting. */
  readonly truncation: TruncationDetails;
  /** Evidence records actually selected and retained in this context. */
  readonly evidenceRecords: readonly BoundedEvidenceRecord[];
  /**
   * Explicit manifest of permitted evidence IDs.
   * Derived strictly from evidenceRecords actually retained in this context.
   */
  readonly allowedEvidenceIds: readonly string[];
}

/**
 * Parameters for the pure context assembler.
 */
export interface AssembleImpactExplanationContextParams {
  readonly analysis: ImpactAnalysis;
  readonly evidenceRecords: readonly EvidenceRecord[];
  readonly limits?: Partial<ContextLimits> | undefined;
}

/**
 * Error hierarchy for Context Assembly and Loading failures.
 */
export class ImpactExplanationContextError extends Error {
  readonly code:
    | "not_found"
    | "not_completed"
    | "invalid_input"
    | "budget_exceeded"
    | "assembly_failed";

  constructor(message: string, code: ImpactExplanationContextError["code"]) {
    super(message);
    this.name = "ImpactExplanationContextError";
    this.code = code;
  }

  static notFound(message = "Impact analysis not found or inaccessible."): ImpactExplanationContextError {
    return new ImpactExplanationContextError(message, "not_found");
  }

  static notCompleted(message = "Impact analysis is not in completed status."): ImpactExplanationContextError {
    return new ImpactExplanationContextError(message, "not_completed");
  }

  static invalidInput(message: string): ImpactExplanationContextError {
    return new ImpactExplanationContextError(message, "invalid_input");
  }

  static budgetExceeded(message: string): ImpactExplanationContextError {
    return new ImpactExplanationContextError(message, "budget_exceeded");
  }

  static assemblyFailed(message: string): ImpactExplanationContextError {
    return new ImpactExplanationContextError(message, "assembly_failed");
  }
}
