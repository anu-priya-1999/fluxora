/**
 * @file types.ts
 * Types and contracts for the Fluxora AI Evaluation Suite (Phase 9 Step 65).
 *
 * Enforces explicit separation between:
 * 1. Structural evidence association (Steps 60/63/64)
 * 2. Evidence manifest membership (Step 61)
 * 3. Semantic evidence support (Step 65)
 */

import type { AIExplanationOutputDto, EvidenceRecord } from "@fluxora/shared-types";

import type { ModelTaskType } from "../types.ts";

export type SemanticSupportLabel =
  | "supported"
  | "unsupported"
  | "contradicted"
  | "ambiguous";

export type EvaluationMode = "ci_mock" | "live";

export type ReleaseGateStatus = "pass" | "fail" | "inconclusive";

export interface EvidenceSelector {
  readonly selectorId: string;
  readonly subjectType: string;
  readonly canonicalId: string;
  readonly filePath: string;
  readonly relationshipDescriptionContains?: string | undefined;
  readonly resultingState?: string | undefined;
  readonly ruleApplied?: string | undefined;
}

export interface HumanReferenceAnnotation {
  readonly claimPattern: string;
  readonly requiredSelectorIds: readonly string[];
  readonly expectedLabel: SemanticSupportLabel;
  readonly rationale: string;
}

export interface ExpectedToolBehavior {
  readonly allowedTools: readonly string[];
  readonly expectedMinToolCalls: number;
  readonly expectedToolsUsed: readonly string[];
}

export interface AIEvalCase {
  readonly caseId: string;
  readonly taskType: ModelTaskType;
  readonly promptVersion: string;
  readonly goldenFixtureId: string;
  readonly pinnedCommitSha: string;
  readonly title: string;
  readonly description: string;
  readonly query?: string | undefined;
  readonly expectedToolBehavior?: ExpectedToolBehavior | undefined;
  readonly expectedFindings: readonly string[];
  readonly expectedEntities: readonly string[];
  readonly expectedEvidenceSelectors: readonly EvidenceSelector[];
  readonly expectedCaveats: readonly string[];
  readonly prohibitedClaims: readonly string[];
  readonly humanReferenceAnnotations: readonly HumanReferenceAnnotation[];
}

export interface AIEvalDataset {
  readonly datasetVersion: string;
  readonly description: string;
  readonly goldenRepository: string;
  readonly pinnedCommitSha: string;
  readonly createdAt: string;
  readonly cases: readonly AIEvalCase[];
}

export interface AdversarialAttackVector {
  readonly vectorId: string;
  readonly location: string;
  readonly attackCategory: string;
  readonly payload: string;
  readonly prohibitedEffects?: readonly string[] | undefined;
  readonly prohibitedEntities?: readonly string[] | undefined;
  readonly prohibitedEvidenceIds?: readonly string[] | undefined;
  readonly prohibitedClaims?: readonly string[] | undefined;
  readonly prohibitedTools?: readonly string[] | undefined;
}

export interface AdversarialInjectionFixture {
  readonly fixtureVersion: string;
  readonly baseGoldenFixtureId: string;
  readonly pinnedCommitSha: string;
  readonly description: string;
  readonly verifiedFacts: {
    readonly impactedFiles: readonly string[];
    readonly simulationTarget: string;
    readonly simulationAffected: ReadonlyArray<{
      readonly canonicalId: string;
      readonly resultingState: string;
      readonly ruleApplied: string;
    }>;
    readonly unaffectedCanonicalIds: readonly string[];
  };
  readonly attackVectors: readonly AdversarialAttackVector[];
}

export interface EvalEvidenceContext {
  readonly allowedEvidenceIds: ReadonlySet<string>;
  readonly evidenceById: ReadonlyMap<string, EvidenceRecord>;
  readonly selectorToEvidenceId: ReadonlyMap<string, string>;
  readonly knownEntities: ReadonlySet<string>;
  readonly simulationOutcomes?: ReadonlyMap<string, { resultingState: string; ruleApplied: string }> | undefined;
  readonly unaffectedEntities?: ReadonlySet<string> | undefined;
}

export interface ClaimEvaluationResult {
  readonly claimIndex: number;
  readonly claimText: string;
  readonly citedEvidenceIds: readonly string[];
  readonly allCitationsInManifest: boolean;
  readonly invalidCitations: readonly string[];
  readonly label: SemanticSupportLabel;
  readonly matchedReferencePattern?: string | undefined;
  readonly contradictsDeterministicFact: boolean;
  readonly introducesUnsupportedDetails: boolean;
  readonly reason: string;
}

export interface EntityCheckResult {
  readonly extractedEntities: readonly string[];
  readonly supportedEntities: readonly string[];
  readonly unsupportedEntities: readonly string[];
  readonly absentRelationshipClaims: readonly string[];
  readonly simulationMismatches: readonly string[];
  readonly entityHallucinationCount: number;
}

export interface AttemptTelemetrySample {
  readonly caseId: string;
  readonly taskType: ModelTaskType;
  readonly promptVersion: string;
  readonly model: string;
  readonly provider: string;
  readonly isMock: boolean;
  readonly initialSchemaValid: boolean;
  readonly requiredCorrectiveRetry: boolean;
  readonly finalSchemaValid: boolean;
  readonly rejected: boolean;
  readonly attempts: number;
  readonly validationErrorCategories: readonly string[];
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly retryCostUsd: number | null;
  readonly usedFallback: boolean;
}

export interface CaseEvaluationResult {
  readonly caseId: string;
  readonly taskType: ModelTaskType;
  readonly promptVersion: string;
  readonly output: AIExplanationOutputDto | null;
  readonly telemetry: AttemptTelemetrySample;
  readonly citationCount: number;
  readonly validManifestCitationCount: number;
  readonly invalidCitationCount: number;
  readonly claimEvaluations: readonly ClaimEvaluationResult[];
  readonly entityCheck: EntityCheckResult;
  readonly prohibitedClaimViolations: readonly string[];
}

export interface CitationProvenanceMetrics {
  readonly totalCitations: number;
  readonly citationsInManifest: number;
  readonly invalidOrFabricatedCitations: number;
  readonly manifestComplianceRate: number;
}

export interface SemanticGroundednessMetrics {
  readonly totalEvaluatedClaims: number;
  readonly supportedClaims: number;
  readonly unsupportedClaims: number;
  readonly contradictedClaims: number;
  readonly ambiguousClaims: number;
  readonly semanticGroundednessRate: number;
  /**
   * Calculated as (unsupported + contradicted) / totalEvaluatedClaims.
   * Ambiguous claims are tracked separately and never silently classified as supported.
   */
  readonly hallucinationRate: number;
  /**
   * Conservative upper bound treating ambiguous claims as failing groundedness:
   * (unsupported + contradicted + ambiguous) / totalEvaluatedClaims.
   */
  readonly conservativeHallucinationRate: number;
  readonly denominatorNotes: string;
}

export interface StructuredOutputMetrics {
  readonly totalCalls: number;
  readonly firstAttemptValidCount: number;
  readonly correctiveRetryCount: number;
  readonly finalValidCount: number;
  readonly rejectedCount: number;
  readonly firstAttemptValidRate: number;
  readonly correctiveRetryRate: number;
  readonly finalValidRate: number;
  readonly rejectionRate: number;
  readonly validationErrorCategories: Readonly<Record<string, number>>;
}

export interface EntityHallucinationMetrics {
  readonly totalExtractedEntities: number;
  readonly supportedEntitiesCount: number;
  readonly unsupportedEntitiesCount: number;
  readonly absentRelationshipCount: number;
  readonly simulationMismatchCount: number;
}

export interface LatencyAndCostMetrics {
  readonly sampleCount: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly meanLatencyMs: number;
  readonly totalInputTokens: number | null;
  readonly totalOutputTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly averageCostPerSuccessUsd: number | null;
  readonly correctiveRetryCostUsd: number | null;
  readonly fallbackFrequency: number;
}

export interface TaskTypeEvaluationMetrics {
  readonly taskType: ModelTaskType;
  readonly sampleCount: number;
  readonly citationProvenance: CitationProvenanceMetrics;
  readonly semanticGroundedness: SemanticGroundednessMetrics;
  readonly structuredOutput: StructuredOutputMetrics;
  readonly entityHallucination: EntityHallucinationMetrics;
  readonly latencyAndCost: LatencyAndCostMetrics;
}

export interface AdversarialVectorResult {
  readonly vectorId: string;
  readonly attackCategory: string;
  readonly deterministicFactsUnchanged: boolean;
  readonly noFabricatedEntities: boolean;
  readonly noInvalidCitations: boolean;
  readonly toolAllowlistRespected: boolean;
  readonly prohibitedClaimsAbsent: boolean;
  readonly passed: boolean;
  readonly details: string;
}

export interface AdversarialEvaluationSummary {
  readonly fixtureVersion: string;
  readonly totalVectors: number;
  readonly passedVectors: number;
  readonly failedVectors: number;
  readonly allPassed: boolean;
  readonly results: readonly AdversarialVectorResult[];
}

export interface ReleaseGateCheck {
  readonly gateId: string;
  readonly name: string;
  readonly status: ReleaseGateStatus;
  readonly observedValue: string;
  readonly threshold: string;
  readonly rationale: string;
}

export interface AIEvaluationReport {
  readonly reportVersion: "ai-eval-report-v1";
  readonly runId: string;
  readonly timestamp: string;
  readonly mode: EvaluationMode;
  readonly datasetVersion: string;
  readonly datasetHashSha256: string;
  readonly goldenFixtureId: string;
  readonly pinnedCommitSha: string;
  readonly modelIdentity: string;
  readonly providerIdentity: string;
  readonly promptVersions: Readonly<Record<ModelTaskType, string>>;
  readonly totalCases: number;
  readonly perTaskMetrics: readonly TaskTypeEvaluationMetrics[];
  readonly overallMetrics: {
    readonly citationProvenance: CitationProvenanceMetrics;
    readonly semanticGroundedness: SemanticGroundednessMetrics;
    readonly structuredOutput: StructuredOutputMetrics;
    readonly entityHallucination: EntityHallucinationMetrics;
    readonly latencyAndCost: LatencyAndCostMetrics;
  };
  readonly caseResults: readonly CaseEvaluationResult[];
  readonly adversarialSummary: AdversarialEvaluationSummary;
  readonly releaseGates: readonly ReleaseGateCheck[];
  readonly overallGateStatus: ReleaseGateStatus;
  readonly statisticalLimitations: readonly string[];
}

export interface AIEvalBaseline {
  readonly baselineVersion: "ai-eval-baseline-v1";
  readonly recordedAt: string;
  readonly evidenceKind: "mock_harness" | "live_model";
  readonly modelIdentity: string;
  readonly datasetVersion: string;
  readonly datasetHashSha256: string;
  /**
   * Legacy alias for `evaluatedCasesCount` (number of golden evaluation cases executed).
   * Kept for backward compatibility; distinct from `evaluatedClaimsCount`.
   */
  readonly sampleCount: number;
  readonly evaluatedCasesCount: number;
  readonly evaluatedClaimsCount: number;
  readonly minimumRecommendedSampleSize: number;
  readonly hallucinationRate: number;
  readonly conservativeHallucinationRate: number;
  readonly unsupportedClaimsCount: number;
  readonly contradictedClaimsCount: number;
  readonly ambiguousClaimsCount: number;
  readonly hallucinationRateDenominator: string;
  readonly firstAttemptValidRate: number;
  readonly correctiveRetryRate: number;
  readonly finalValidRate: number;
  readonly invalidCitationCount: number;
  readonly adversarialAllPassed: boolean;
  readonly p95LatencyMs: number;
  readonly totalCostUsd: number | null;
  readonly notes: string;
}
