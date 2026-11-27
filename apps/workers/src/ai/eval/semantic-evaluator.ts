/**
 * @file semantic-evaluator.ts
 * Semantic groundedness evaluator for AI-generated claims (Phase 9 Step 65).
 *
 * Evaluates each factual claim beyond manifest membership:
 * 1. Manifest membership (cited ID belongs to allowedEvidenceIds)
 * 2. Substantive support (cited evidence record + provisional reference annotations support the claim)
 * 3. Contradiction detection (does not contradict deterministic findings or prohibited claims)
 * 4. Unsupported detail detection
 * 5. Ambiguity classification (ambiguous claims are never silently classified as supported)
 */

import type { AIExplanationOutputDto, EvidenceRecord } from "@fluxora/shared-types";

import type {
  AIEvalCase,
  ClaimEvaluationResult,
  EvalEvidenceContext,
  SemanticSupportLabel,
} from "./types.ts";

export interface HeldOutSemanticJudge {
  readonly judgeVersion: string;
  evaluateClaim(params: {
    readonly claimText: string;
    readonly citedEvidence: readonly EvidenceRecord[];
    readonly expectedFindings: readonly string[];
  }): Promise<{ readonly label: SemanticSupportLabel; readonly reason: string }>;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function evidenceTextBlob(record: EvidenceRecord): string {
  const parts = [
    record.subjectType,
    record.subjectId,
    record.filePath,
    record.symbolId ?? "",
    record.relationshipDescription,
    JSON.stringify(record.metadata ?? {}),
  ];
  return normalizeForMatch(parts.join(" "));
}

function detectContradiction(
  claimText: string,
  evalCase: AIEvalCase,
  context: EvalEvidenceContext,
): { readonly contradicted: boolean; readonly reason?: string } {
  const normalized = normalizeForMatch(claimText);

  for (const prohibited of evalCase.prohibitedClaims) {
    const normProhibited = normalizeForMatch(prohibited);
    if (normProhibited.length > 0 && normalized.includes(normProhibited)) {
      return {
        contradicted: true,
        reason: `Claim matches prohibited/contradictory statement: "${prohibited}".`,
      };
    }
  }

  if (context.simulationOutcomes) {
    for (const [canonicalId, expected] of context.simulationOutcomes.entries()) {
      const filePart = canonicalId.replace(/^(mod|sym|route):/, "").toLowerCase();
      if (normalized.includes(filePart)) {
        const states = ["failed", "degraded", "at_risk", "healthy"];
        for (const state of states) {
          if (
            state !== expected.resultingState &&
            new RegExp(`\\b${filePart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]*\\b${state}\\b`, "i").test(
              claimText,
            )
          ) {
            return {
              contradicted: true,
              reason: `Claim attributes state '${state}' to ${filePart}, contradicting deterministic SimulationResult '${expected.resultingState}'.`,
            };
          }
        }
      }
    }
  }

  if (context.unaffectedEntities) {
    for (const unaffected of context.unaffectedEntities) {
      const clean = unaffected.replace(/^(mod|sym|route):/, "").toLowerCase();
      if (
        clean.length > 0 &&
        normalized.includes(clean) &&
        /\b(affected|impacted|failed|degraded|broken|calls)\b/i.test(claimText) &&
        !/\b(unaffected|not affected|not impacted|healthy)\b/i.test(claimText)
      ) {
        return {
          contradicted: true,
          reason: `Claim asserts unaffected entity '${clean}' is impacted/affected.`,
        };
      }
    }
  }

  return { contradicted: false };
}

function checkSubstantiveSupportFromEvidence(
  claimText: string,
  citedRecords: readonly EvidenceRecord[],
): { readonly supported: boolean; readonly ambiguous: boolean; readonly reason: string } {
  if (citedRecords.length === 0) {
    return {
      supported: false,
      ambiguous: false,
      reason: "No valid evidence records from the trusted manifest were cited.",
    };
  }

  const claimNorm = normalizeForMatch(claimText);
  const combinedEvidence = citedRecords.map(evidenceTextBlob).join(" ");

  // Extract file paths or route paths mentioned in the claim
  const pathMatches = claimText.match(/[a-zA-Z0-9_()[\]-]+(?:\/[a-zA-Z0-9_.()[\]-]+)+(?:\.[a-z]{1,4})?/g) ?? [];
  for (const mentionedPath of pathMatches) {
    const cleanPath = mentionedPath.replace(/^\/+/, "").toLowerCase();
    // Ignore API route prefixes if the route path itself is in evidence
    if (!combinedEvidence.includes(cleanPath) && !combinedEvidence.includes(mentionedPath.toLowerCase())) {
      return {
        supported: false,
        ambiguous: false,
        reason: `Cited evidence does not mention referenced path '${mentionedPath}'.`,
      };
    }
  }

  // Check if at least one meaningful domain token from the claim appears in the cited evidence
  const tokens = claimNorm
    .split(/[^a-z0-9_./:-]+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));

  if (tokens.length === 0) {
    return {
      supported: false,
      ambiguous: true,
      reason: "Claim contains too few verifiable technical tokens to confirm semantic support.",
    };
  }

  const matchedTokens = tokens.filter((t) => combinedEvidence.includes(t));
  if (matchedTokens.length === 0) {
    return {
      supported: false,
      ambiguous: false,
      reason: "Cited evidence records share no verifiable technical terms with the claim.",
    };
  }

  if (matchedTokens.length === 1 && tokens.length >= 4) {
    return {
      supported: false,
      ambiguous: true,
      reason: "Only weak lexical overlap with cited evidence; claim is ambiguous without stronger alignment.",
    };
  }

  return {
    supported: true,
    ambiguous: false,
    reason: `Claim aligns with cited evidence (${matchedTokens.slice(0, 4).join(", ")}).`,
  };
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "will",
  "when",
  "where",
  "which",
  "what",
  "does",
  "into",
  "only",
  "also",
  "more",
  "than",
  "because",
  "based",
  "through",
  "simulated",
  "simulation",
  "impact",
  "directly",
  "downstream",
]);

/**
 * Evaluates all claims in an AI output for citation provenance and semantic groundedness.
 */
export async function evaluateOutputSemanticGroundedness(params: {
  readonly output: AIExplanationOutputDto;
  readonly evalCase: AIEvalCase;
  readonly context: EvalEvidenceContext;
  readonly heldOutJudge?: HeldOutSemanticJudge | undefined;
}): Promise<{
  readonly claimEvaluations: readonly ClaimEvaluationResult[];
  readonly prohibitedClaimViolations: readonly string[];
}> {
  const { output, evalCase, context, heldOutJudge } = params;
  const claimEvaluations: ClaimEvaluationResult[] = [];
  const prohibitedClaimViolations: string[] = [];

  // Check summary and caveats for prohibited claims as well
  const summaryAndCaveats = [output.summary, ...output.caveats].map(normalizeForMatch).join(" ");
  for (const prohibited of evalCase.prohibitedClaims) {
    if (summaryAndCaveats.includes(normalizeForMatch(prohibited))) {
      prohibitedClaimViolations.push(prohibited);
    }
  }

  for (let i = 0; i < output.claims.length; i++) {
    const claim = output.claims[i]!;
    const invalidCitations = claim.evidence_ids.filter(
      (id) => !context.allowedEvidenceIds.has(id),
    );
    const allCitationsInManifest =
      claim.evidence_ids.length > 0 && invalidCitations.length === 0;

    const citedRecords: EvidenceRecord[] = [];
    for (const id of claim.evidence_ids) {
      const rec = context.evidenceById.get(id);
      if (rec) {
        citedRecords.push(rec);
      }
    }

    const contradiction = detectContradiction(claim.text, evalCase, context);
    if (contradiction.contradicted) {
      prohibitedClaimViolations.push(claim.text);
      claimEvaluations.push({
        claimIndex: i,
        claimText: claim.text,
        citedEvidenceIds: claim.evidence_ids,
        allCitationsInManifest,
        invalidCitations,
        label: "contradicted",
        contradictsDeterministicFact: true,
        introducesUnsupportedDetails: true,
        reason: contradiction.reason ?? "Contradicts deterministic finding.",
      });
      continue;
    }

    if (!allCitationsInManifest) {
      claimEvaluations.push({
        claimIndex: i,
        claimText: claim.text,
        citedEvidenceIds: claim.evidence_ids,
        allCitationsInManifest: false,
        invalidCitations,
        label: "unsupported",
        contradictsDeterministicFact: false,
        introducesUnsupportedDetails: true,
        reason:
          invalidCitations.length > 0
            ? `Cites evidence IDs outside trusted manifest: ${invalidCitations.join(", ")}.`
            : "Claim has no evidence citations.",
      });
      continue;
    }

    // Check provisional reference annotations if applicable
    const matchedAnnotation = evalCase.humanReferenceAnnotations.find((ann) =>
      normalizeForMatch(claim.text).includes(normalizeForMatch(ann.claimPattern)),
    );

    if (matchedAnnotation) {
      const requiredIds = matchedAnnotation.requiredSelectorIds
        .map((sel) => context.selectorToEvidenceId.get(sel))
        .filter((id): id is string => Boolean(id));

      const citesRequiredSelector =
        requiredIds.length === 0 ||
        requiredIds.some((reqId) => claim.evidence_ids.includes(reqId));

      if (!citesRequiredSelector) {
        claimEvaluations.push({
          claimIndex: i,
          claimText: claim.text,
          citedEvidenceIds: claim.evidence_ids,
          allCitationsInManifest: true,
          invalidCitations: [],
          label: "unsupported",
          matchedReferencePattern: matchedAnnotation.claimPattern,
          contradictsDeterministicFact: false,
          introducesUnsupportedDetails: true,
          reason: `Cites manifest ID(s) that do not correspond to the required evidence selector(s) for '${matchedAnnotation.claimPattern}'.`,
        });
        continue;
      }

      const substantive = checkSubstantiveSupportFromEvidence(claim.text, citedRecords);
      const finalLabel: SemanticSupportLabel = substantive.supported
        ? matchedAnnotation.expectedLabel
        : substantive.ambiguous
          ? "ambiguous"
          : "unsupported";

      claimEvaluations.push({
        claimIndex: i,
        claimText: claim.text,
        citedEvidenceIds: claim.evidence_ids,
        allCitationsInManifest: true,
        invalidCitations: [],
        label: finalLabel,
        matchedReferencePattern: matchedAnnotation.claimPattern,
        contradictsDeterministicFact: false,
        introducesUnsupportedDetails: finalLabel !== "supported",
        reason: substantive.supported
          ? `Verified against human reference annotation (${matchedAnnotation.rationale}).`
          : substantive.reason,
      });
      continue;
    }

    // Fallback: deterministic evidence alignment + optional bounded held-out judge
    const substantive = checkSubstantiveSupportFromEvidence(claim.text, citedRecords);
    let label: SemanticSupportLabel = substantive.supported
      ? "supported"
      : substantive.ambiguous
        ? "ambiguous"
        : "unsupported";
    let reason = substantive.reason;

    if (heldOutJudge && label === "ambiguous") {
      const judged = await heldOutJudge.evaluateClaim({
        claimText: claim.text,
        citedEvidence: citedRecords,
        expectedFindings: evalCase.expectedFindings,
      });
      // Held-out judge can refine ambiguous claims but never overrides deterministic contradictions
      label = judged.label;
      reason = `${reason} [Held-out judge ${heldOutJudge.judgeVersion}: ${judged.reason}]`;
    }

    claimEvaluations.push({
      claimIndex: i,
      claimText: claim.text,
      citedEvidenceIds: claim.evidence_ids,
      allCitationsInManifest: true,
      invalidCitations: [],
      label,
      contradictsDeterministicFact: false,
      introducesUnsupportedDetails: label !== "supported",
      reason,
    });
  }

  return {
    claimEvaluations,
    prohibitedClaimViolations,
  };
}
