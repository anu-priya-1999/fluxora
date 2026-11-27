/**
 * @file entity-checker.ts
 * Deterministic named-entity, file-path, API, and relationship hallucination checker (Step 65).
 *
 * Extracts technical entities from AI summary, claims, and caveats and compares them
 * against the verified entities present in the supplied evidence and context.
 */

import type { AIExplanationOutputDto } from "@fluxora/shared-types";

import type { AIEvalCase, EntityCheckResult, EvalEvidenceContext } from "./types.ts";

const FILE_PATH_REGEX =
  /\b[a-zA-Z0-9_()[\]-]+(?:\/[a-zA-Z0-9_.()[\]-]+)+\.[a-zA-Z]{1,6}\b/g;
const HTTP_API_REGEX = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[a-zA-Z0-9_./:-]+\b/g;
const INTERNAL_HOST_OR_SERVICE_REGEX =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|svc|cluster)\b/gi;
const CANONICAL_ID_REGEX = /\b(?:mod|sym|route):[a-zA-Z0-9_./():#-]+\b/g;

function extractEntitiesFromText(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.match(HTTP_API_REGEX) ?? []) {
    found.add(match.trim());
  }
  for (const match of text.match(CANONICAL_ID_REGEX) ?? []) {
    found.add(match.trim());
  }
  for (const match of text.match(FILE_PATH_REGEX) ?? []) {
    // Skip if already part of an HTTP route like /api/posts
    if (!match.startsWith("/")) {
      found.add(match.trim());
    }
  }
  for (const match of text.match(INTERNAL_HOST_OR_SERVICE_REGEX) ?? []) {
    found.add(match.trim());
  }

  return Array.from(found).sort();
}

function isEntityKnown(entity: string, knownEntities: ReadonlySet<string>): boolean {
  if (knownEntities.has(entity)) {
    return true;
  }
  const lower = entity.toLowerCase();
  for (const known of knownEntities) {
    const knownLower = known.toLowerCase();
    if (knownLower === lower || knownLower.includes(lower) || lower.includes(knownLower)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks extracted named entities, relationships, and simulation states against deterministic context.
 */
export function checkEntityHallucinations(params: {
  readonly output: AIExplanationOutputDto;
  readonly evalCase: AIEvalCase;
  readonly context: EvalEvidenceContext;
}): EntityCheckResult {
  const { output, context } = params;
  const allText = [
    output.summary,
    ...output.claims.map((c) => c.text),
    ...output.caveats,
  ].join("\n");

  const extractedEntities = extractEntitiesFromText(allText);
  const supportedEntities: string[] = [];
  const unsupportedEntities: string[] = [];

  for (const entity of extractedEntities) {
    if (isEntityKnown(entity, context.knownEntities)) {
      supportedEntities.push(entity);
    } else {
      unsupportedEntities.push(entity);
    }
  }

  const absentRelationshipClaims: string[] = [];
  const simulationMismatches: string[] = [];

  for (const claim of output.claims) {
    if (context.unaffectedEntities) {
      for (const unaffected of context.unaffectedEntities) {
        const clean = unaffected.replace(/^(mod|sym|route):/, "").toLowerCase();
        if (
          clean.length > 0 &&
          claim.text.toLowerCase().includes(clean) &&
          /\b(calls|depends on|impacts|affects|affected|degraded|failed)\b/i.test(claim.text) &&
          !/\b(unaffected|not affected|not impacted|healthy)\b/i.test(claim.text)
        ) {
          absentRelationshipClaims.push(claim.text);
        }
      }
    }

    if (context.simulationOutcomes) {
      for (const [canonicalId, expected] of context.simulationOutcomes.entries()) {
        const clean = canonicalId.replace(/^(mod|sym|route):/, "").toLowerCase();
        if (claim.text.toLowerCase().includes(clean)) {
          for (const state of ["failed", "degraded", "at_risk", "healthy"]) {
            if (
              state !== expected.resultingState &&
              new RegExp(`\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]*\\b${state}\\b`, "i").test(
                claim.text,
              )
            ) {
              simulationMismatches.push(
                `${clean}: claimed '${state}' vs deterministic '${expected.resultingState}'`,
              );
            }
          }
        }
      }
    }
  }

  return {
    extractedEntities,
    supportedEntities,
    unsupportedEntities,
    absentRelationshipClaims,
    simulationMismatches,
    entityHallucinationCount:
      unsupportedEntities.length +
      absentRelationshipClaims.length +
      simulationMismatches.length,
  };
}
