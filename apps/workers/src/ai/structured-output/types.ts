/**
 * @file types.ts
 * Types and contracts for Structured Output Schemas and Evidence Grounding Validation.
 *
 * Defines the canonical impact-explanation output contract, confidence levels,
 * validation issue descriptors, and strongly typed validation result models.
 */

/**
 * Model-assessed confidence level in its natural-language explanation.
 * Represents explanation confidence, not deterministic impact confidence.
 */
export type ImpactExplanationConfidence = "high" | "medium" | "low";

/**
 * A single factual statement about an affected component or dependency,
 * citing one or more verified evidence IDs from the trusted manifest.
 */
export interface ImpactExplanationClaim {
  readonly text: string;
  readonly evidence_ids: readonly string[];
}

/**
 * The canonical validated impact-explanation payload conforming to
 * docs/architecture/09-ai-architecture.md §9.6.
 *
 * Contains exactly four fields: summary, claims, confidence, caveats.
 */
export interface ImpactExplanationOutput {
  /** Concise explanation synthesizing deterministic impact findings and evidence. */
  readonly summary: string;
  /** Factual statements, each citing one or more verified evidence IDs. */
  readonly claims: readonly ImpactExplanationClaim[];
  /** Model-assessed confidence in its explanation narrative ('high' | 'medium' | 'low'). */
  readonly confidence: ImpactExplanationConfidence;
  /** Limitations, uncertainties, and relevant qualifications. */
  readonly caveats: readonly string[];
}

/**
 * Model-assessed confidence level in its simulation narration explanation.
 */
export type SimulationNarrationConfidence = "high" | "medium" | "low";

/**
 * A single factual statement about a simulated failure or propagation path,
 * citing one or more verified evidence IDs from the trusted simulation manifest.
 */
export interface SimulationNarrationClaim {
  readonly text: string;
  readonly evidence_ids: readonly string[];
}

/**
 * The canonical validated simulation-narration payload conforming to
 * Phase 9 Step 63.
 *
 * Contains exactly four fields: summary, claims, confidence, caveats.
 */
export interface SimulationNarrationOutput {
  /** Concise narrative explaining the simulated failure scenario and propagation results. */
  readonly summary: string;
  /** Factual statements, each citing one or more verified evidence IDs from the simulation manifest. */
  readonly claims: readonly SimulationNarrationClaim[];
  /** Model-assessed confidence in its explanation narrative ('high' | 'medium' | 'low'). */
  readonly confidence: SimulationNarrationConfidence;
  /** Limitations, scenario bounds, and relevant caveats. */
  readonly caveats: readonly string[];
}

/**
 * Category of a validation issue:
 * - 'parse': strict JSON parsing failures (syntax error, markdown fences, non-object root, empty input)
 * - 'schema': structure, required fields, types, string length, array bounds, unrecognized fields
 * - 'grounding': evidence ID manifest membership, duplicates within claim, empty evidence citations
 */
export type ValidationIssueCategory = "parse" | "schema" | "grounding";

/**
 * Strongly typed validation issue representing a single deterministic validation error.
 */
export interface ValidationIssue {
  readonly category: ValidationIssueCategory;
  /** Stable machine-readable error code. */
  readonly code: string;
  /** Property or path where the issue was detected (e.g., "summary", "claims[0].text", "$"). */
  readonly path: string;
  /** Concise, safe descriptive message without echoing raw untrusted model output. */
  readonly message: string;
}

/**
 * Strongly typed discriminated validation result.
 * When success is false, errors contains at most MAX_VALIDATION_ISSUES (20) issues.
 */
export type ValidationResult<T> =
  | {
      readonly success: true;
      readonly data: T;
      readonly schemaVersion: string;
    }
  | {
      readonly success: false;
      readonly errors: readonly ValidationIssue[];
    };

/**
 * Context provided to an injected retry callback when the initial response fails validation.
 * validationErrors contains the initial validation errors (bounded to MAX_VALIDATION_ISSUES = 20),
 * while correctiveInstruction formats at most MAX_CORRECTIVE_FEEDBACK_ISSUES = 10 issues for the model.
 */
export interface ValidationRetryContext {
  readonly attemptNumber: 2;
  readonly correctiveInstruction: string;
  readonly validationErrors: readonly ValidationIssue[];
}

/**
 * Callback invoked to request exactly one corrective retry from a model provider or orchestrator.
 */
export type ValidationRetryCallback = (
  context: ValidationRetryContext
) => Promise<string>;

/**
 * Options for validating with bounded corrective retry.
 */
export interface ValidateWithRetryOptions {
  readonly initialResponseText: string;
  readonly allowedEvidenceIds: readonly string[] | ReadonlySet<string>;
  readonly retry: ValidationRetryCallback;
}

/**
 * Strongly typed discriminated result of validating with retry.
 */
export type ValidationWithRetryResult<T> =
  | {
      readonly success: true;
      readonly data: T;
      readonly schemaVersion: string;
      readonly attempts: 1 | 2;
    }
  | {
      readonly success: false;
      readonly errors: readonly ValidationIssue[];
      readonly attempts: 1 | 2;
    };
