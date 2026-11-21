/**
 * @file assembler.ts
 * Pure deterministic context assembler for impact explanation.
 *
 * Transforms persisted ImpactAnalysis records and associated Evidence rows
 * into a minimal, bounded, typed ImpactExplanationContext with a strict
 * evidence grounding manifest.
 *
 * INVARIANTS:
 * - Pure function: no database calls, no network, no file I/O, no LLM calls.
 * - Deterministic: zero clock dependencies, zero random identifiers.
 * - Input immutability: never mutates input analysis or evidence records.
 * - Strict evidence grounding: manifest contains only verified, retained evidence IDs.
 */

import type {
  EvidenceRecord,
  ImpactAnalysis,
  ImpactFinding,
  UnresolvedChangedFile,
} from "@fluxora/shared-types";

import { resolveContextLimits, sanitizeUntrustedString } from "./limits.ts";
import {
  ImpactExplanationContextError,
  type AssembleImpactExplanationContextParams,
  type BoundedEvidenceRecord,
  type BoundedExecutionMetrics,
  type BoundedFinding,
  type BoundedUnresolvedFile,
  type ContextLimits,
  type ImpactExplanationContext,
  type TruncationDetails,
} from "./types.ts";

type FindingCategory = "direct" | "downstream" | "api" | "event" | "service";

interface RankedFindingItem {
  readonly category: FindingCategory;
  readonly finding: BoundedFinding;
  readonly rawEvidenceIds: readonly string[];
}

/**
 * Deterministic finding comparator:
 * 1. Higher confidence first
 * 2. Lower hop distance (depth) first
 * 3. Stable nodeId as tie-breaker
 */
function compareFindings(a: BoundedFinding, b: BoundedFinding): number {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  if (a.depth !== b.depth) {
    return a.depth - b.depth;
  }
  return a.nodeId.localeCompare(b.nodeId);
}

/**
 * Deterministic global comparator across categories:
 * 1. Higher confidence first
 * 2. Lower hop distance (depth) first
 * 3. Canonical category ordering (direct < downstream < api < event < service)
 * 4. Stable nodeId as tie-breaker
 */
const CATEGORY_ORDER: Readonly<Record<FindingCategory, number>> = Object.freeze({
  direct: 0,
  downstream: 1,
  api: 2,
  event: 3,
  service: 4,
});

function compareRankedFindings(
  a: RankedFindingItem,
  b: RankedFindingItem,
): number {
  if (b.finding.confidence !== a.finding.confidence) {
    return b.finding.confidence - a.finding.confidence;
  }
  if (a.finding.depth !== b.finding.depth) {
    return a.finding.depth - b.finding.depth;
  }
  const catDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (catDiff !== 0) {
    return catDiff;
  }
  return a.finding.nodeId.localeCompare(b.finding.nodeId);
}

/**
 * Deterministic evidence record comparator:
 * 1. Higher confidence first
 * 2. Stable file path
 * 3. Stable ID
 */
function compareEvidenceRecords(
  a: BoundedEvidenceRecord,
  b: BoundedEvidenceRecord,
): number {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  const fileDiff = a.filePath.localeCompare(b.filePath);
  if (fileDiff !== 0) {
    return fileDiff;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Validates and maps raw evidence records from the database.
 * Rejects records that do not match:
 * 1. subjectType === "impact_finding"
 * 2. analysisRunId === analysis.analysisRunId
 * 3. metadata.impactAnalysisId === analysis.id
 * 4. Non-empty string id and subjectId
 */
function validateAndIndexEvidence(
  evidenceRecords: readonly EvidenceRecord[],
  analysis: ImpactAnalysis,
  maxStringLength: number,
): Map<string, BoundedEvidenceRecord> {
  const map = new Map<string, BoundedEvidenceRecord>();

  for (const rec of evidenceRecords) {
    if (!rec || typeof rec !== "object") {
      continue;
    }

    if (rec.subjectType !== "impact_finding") {
      continue;
    }

    if (rec.analysisRunId !== analysis.analysisRunId) {
      continue;
    }

    const metadataImpactAnalysisId =
      typeof rec.metadata?.impactAnalysisId === "string"
        ? rec.metadata.impactAnalysisId
        : typeof rec.metadata?.impact_analysis_id === "string"
          ? rec.metadata.impact_analysis_id
          : null;

    if (metadataImpactAnalysisId !== analysis.id) {
      continue;
    }

    if (typeof rec.id !== "string" || rec.id.trim().length === 0) {
      continue;
    }

    if (typeof rec.subjectId !== "string" || rec.subjectId.trim().length === 0) {
      continue;
    }

    const boundedRec: BoundedEvidenceRecord = {
      id: rec.id.trim(),
      subjectType: "impact_finding",
      subjectId: rec.subjectId.trim(),
      filePath: sanitizeUntrustedString(rec.filePath ?? "unknown", maxStringLength),
      symbolId: rec.symbolId
        ? sanitizeUntrustedString(rec.symbolId, maxStringLength)
        : null,
      lineStart: typeof rec.lineStart === "number" ? rec.lineStart : null,
      lineEnd: typeof rec.lineEnd === "number" ? rec.lineEnd : null,
      columnStart: typeof rec.columnStart === "number" ? rec.columnStart : null,
      columnEnd: typeof rec.columnEnd === "number" ? rec.columnEnd : null,
      relationshipDescription: sanitizeUntrustedString(
        rec.relationshipDescription ?? "",
        maxStringLength,
      ),
      confidence:
        typeof rec.confidence === "number"
          ? Math.max(0, Math.min(1, rec.confidence))
          : 1.0,
    };

    // If duplicate ID exists, preserve the one with higher confidence
    const existing = map.get(boundedRec.id);
    if (!existing || boundedRec.confidence > existing.confidence) {
      map.set(boundedRec.id, boundedRec);
    }
  }

  return map;
}

/**
 * Normalizes, deduplicates, and validates evidence IDs on a list of raw findings.
 */
function processCategoryFindings(
  findings: readonly ImpactFinding[],
  category: FindingCategory,
  validEvidenceMap: Map<string, BoundedEvidenceRecord>,
  maxStringLength: number,
): RankedFindingItem[] {
  const byNodeId = new Map<string, RankedFindingItem>();

  for (const f of findings) {
    if (!f || !f.node || typeof f.node !== "object") {
      continue;
    }

    const nodeId = sanitizeUntrustedString(f.node.id, maxStringLength);
    if (!nodeId) {
      continue;
    }

    const name = sanitizeUntrustedString(f.node.name ?? "unnamed", maxStringLength);
    const nodeType = sanitizeUntrustedString(f.node.nodeType ?? "unknown", maxStringLength);
    const filePath = f.node.path
      ? sanitizeUntrustedString(f.node.path, maxStringLength)
      : null;
    const depth = typeof f.depth === "number" ? Math.max(0, f.depth) : 0;
    const confidence =
      typeof f.confidence === "number"
        ? Math.max(0, Math.min(1, f.confidence))
        : 1.0;

    const path = Array.isArray(f.path)
      ? f.path.map((segment) => sanitizeUntrustedString(segment, maxStringLength))
      : [];

    const rawEvidenceIds = Array.isArray(f.evidenceIds)
      ? f.evidenceIds.filter((id) => typeof id === "string" && id.trim().length > 0)
      : [];

    // Verify each cited evidence ID:
    // 1. Must exist in validEvidenceMap
    // 2. Must match the finding's nodeId as subjectId
    const verifiedEvidenceIds: string[] = [];
    for (const rawId of rawEvidenceIds) {
      const ev = validEvidenceMap.get(rawId);
      if (ev && ev.subjectId === nodeId) {
        verifiedEvidenceIds.push(ev.id);
      }
    }

    const deduplicatedEvidenceIds = Array.from(new Set(verifiedEvidenceIds)).sort();

    const boundedFinding: BoundedFinding = {
      nodeId,
      name,
      nodeType,
      filePath,
      depth,
      confidence,
      path,
      evidenceIds: deduplicatedEvidenceIds,
    };

    const item: RankedFindingItem = {
      category,
      finding: boundedFinding,
      rawEvidenceIds,
    };

    // Deduplicate within the same category by nodeId (preserve higher confidence / lower depth)
    const existing = byNodeId.get(nodeId);
    if (!existing || compareFindings(boundedFinding, existing.finding) < 0) {
      byNodeId.set(nodeId, item);
    }
  }

  return Array.from(byNodeId.values());
}

/**
 * Filters and bounds unresolved changed files.
 */
function processUnresolvedFiles(
  files: readonly UnresolvedChangedFile[],
  maxStringLength: number,
): BoundedUnresolvedFile[] {
  const seenPaths = new Set<string>();
  const result: BoundedUnresolvedFile[] = [];

  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }
    const path = sanitizeUntrustedString(file.path, maxStringLength);
    if (!path || seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    result.push({
      path,
      reason: sanitizeUntrustedString(file.reason ?? "unresolved", maxStringLength),
    });
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Pure deterministic context assembler for impact explanation.
 */
export function assembleImpactExplanationContext(
  params: AssembleImpactExplanationContextParams,
): ImpactExplanationContext {
  const { analysis, evidenceRecords } = params;
  const limits: ContextLimits = resolveContextLimits(params.limits);

  const reasons: string[] = [];
  let omittedFindingsCount = 0;
  let omittedEvidenceCount = 0;
  let omittedUnresolvedFilesCount = 0;

  // 1. Validate and index evidence records
  const validEvidenceMap = validateAndIndexEvidence(
    evidenceRecords ?? [],
    analysis,
    limits.maxStringLength,
  );

  // 2. Process all findings categories
  const directItems = processCategoryFindings(
    analysis.directImpact ?? [],
    "direct",
    validEvidenceMap,
    limits.maxStringLength,
  );
  const downstreamItems = processCategoryFindings(
    analysis.downstreamImpact ?? [],
    "downstream",
    validEvidenceMap,
    limits.maxStringLength,
  );
  const apiItems = processCategoryFindings(
    analysis.affectedApis ?? [],
    "api",
    validEvidenceMap,
    limits.maxStringLength,
  );
  const eventItems = processCategoryFindings(
    analysis.affectedEvents ?? [],
    "event",
    validEvidenceMap,
    limits.maxStringLength,
  );
  const serviceItems = processCategoryFindings(
    analysis.affectedServices ?? [],
    "service",
    validEvidenceMap,
    limits.maxStringLength,
  );

  const allRankedFindings: RankedFindingItem[] = [
    ...directItems,
    ...downstreamItems,
    ...apiItems,
    ...eventItems,
    ...serviceItems,
  ].sort(compareRankedFindings);

  const totalRawFindingsCount = allRankedFindings.length;

  // 3. Apply maxFindings limit
  let retainedFindingsList = allRankedFindings;
  if (retainedFindingsList.length > limits.maxFindings) {
    const excess = retainedFindingsList.length - limits.maxFindings;
    omittedFindingsCount += excess;
    retainedFindingsList = retainedFindingsList.slice(0, limits.maxFindings);
    reasons.push(
      `Finding limit (${limits.maxFindings}) exceeded: retained ${retainedFindingsList.length} of ${totalRawFindingsCount} findings (${excess} omitted)`,
    );
  }

  // 4. Process unresolved files and apply maxUnresolvedFiles
  const allUnresolved = processUnresolvedFiles(
    analysis.unresolvedFiles ?? [],
    limits.maxStringLength,
  );
  let retainedUnresolved = allUnresolved;
  if (retainedUnresolved.length > limits.maxUnresolvedFiles) {
    const excess = retainedUnresolved.length - limits.maxUnresolvedFiles;
    omittedUnresolvedFilesCount += excess;
    retainedUnresolved = retainedUnresolved.slice(0, limits.maxUnresolvedFiles);
    reasons.push(
      `Unresolved files limit (${limits.maxUnresolvedFiles}) exceeded: retained ${retainedUnresolved.length} of ${allUnresolved.length} files (${excess} omitted)`,
    );
  }

  // 5. Select and bound evidence records based on retained findings
  function resolveRetainedEvidence(
    findingsList: readonly RankedFindingItem[],
  ): {
    evidenceRecords: BoundedEvidenceRecord[];
    allowedEvidenceIds: string[];
    omittedCount: number;
    reasonAdded: boolean;
  } {
    const neededIds = new Set<string>();
    for (const item of findingsList) {
      for (const evId of item.finding.evidenceIds) {
        neededIds.add(evId);
      }
    }

    const availableRecords = Array.from(neededIds)
      .map((id) => validEvidenceMap.get(id)!)
      .filter(Boolean)
      .sort(compareEvidenceRecords);

    let retainedRecords = availableRecords;
    let omitted = 0;
    let reasonAdded = false;

    if (retainedRecords.length > limits.maxEvidenceRecords) {
      omitted = retainedRecords.length - limits.maxEvidenceRecords;
      retainedRecords = retainedRecords.slice(0, limits.maxEvidenceRecords);
      reasonAdded = true;
    }

    const allowedIds = retainedRecords.map((r) => r.id).sort();
    return {
      evidenceRecords: retainedRecords,
      allowedEvidenceIds: allowedIds,
      omittedCount: omitted,
      reasonAdded,
    };
  }

  const initialEvidence = resolveRetainedEvidence(retainedFindingsList);
  let retainedEvidenceRecords = initialEvidence.evidenceRecords;
  let allowedEvidenceIds = initialEvidence.allowedEvidenceIds;
  const initialOmittedEvidence = initialEvidence.omittedCount;
  const evidenceLimitReasonAdded = initialEvidence.reasonAdded;

  if (evidenceLimitReasonAdded) {
    omittedEvidenceCount += initialOmittedEvidence;
    reasons.push(
      `Evidence records limit (${limits.maxEvidenceRecords}) exceeded: retained ${retainedEvidenceRecords.length} records (${initialOmittedEvidence} omitted)`,
    );
  }

  // 6. Partition findings back into categories and synchronize finding.evidenceIds with allowedEvidenceIds
  function buildCategorizedFindings(
    findingsList: readonly RankedFindingItem[],
    allowedSet: Set<string>,
  ): {
    directImpact: BoundedFinding[];
    downstreamImpact: BoundedFinding[];
    affectedApis: BoundedFinding[];
    affectedEvents: BoundedFinding[];
    affectedServices: BoundedFinding[];
  } {
    const direct: BoundedFinding[] = [];
    const downstream: BoundedFinding[] = [];
    const apis: BoundedFinding[] = [];
    const events: BoundedFinding[] = [];
    const services: BoundedFinding[] = [];

    for (const item of findingsList) {
      const sanitizedFinding: BoundedFinding = {
        ...item.finding,
        evidenceIds: item.finding.evidenceIds.filter((id) => allowedSet.has(id)),
      };

      switch (item.category) {
        case "direct":
          direct.push(sanitizedFinding);
          break;
        case "downstream":
          downstream.push(sanitizedFinding);
          break;
        case "api":
          apis.push(sanitizedFinding);
          break;
        case "event":
          events.push(sanitizedFinding);
          break;
        case "service":
          services.push(sanitizedFinding);
          break;
      }
    }

    direct.sort(compareFindings);
    downstream.sort(compareFindings);
    apis.sort(compareFindings);
    events.sort(compareFindings);
    services.sort(compareFindings);

    return {
      directImpact: direct,
      downstreamImpact: downstream,
      affectedApis: apis,
      affectedEvents: events,
      affectedServices: services,
    };
  }

  const executionMetrics: BoundedExecutionMetrics = {
    totalSeedNodes: Number(analysis.executionMetrics?.totalSeedNodes ?? 0),
    totalAffectedNodes: Number(
      analysis.executionMetrics?.totalAffectedNodes ??
        directItems.length + downstreamItems.length,
    ),
    totalEdgesTraversed: Number(
      analysis.executionMetrics?.totalEdgesTraversed ?? 0,
    ),
    durationMs: Number(analysis.executionMetrics?.durationMs ?? 0),
    maxDepthReached: Number(analysis.maxDepthReached ?? 0),
  };

  const workflowImpactSummary = Array.isArray(analysis.workflowImpactSummary)
    ? analysis.workflowImpactSummary.map((s) =>
        sanitizeUntrustedString(s, limits.maxStringLength),
      )
    : [];

  // Helper to generate test envelope for character budget check
  function buildContextEnvelope(
    findingsList: readonly RankedFindingItem[],
    evidenceList: readonly BoundedEvidenceRecord[],
    allowedIds: readonly string[],
    unresolvedList: readonly BoundedUnresolvedFile[],
    currentReasons: readonly string[],
    truncatedFlag: boolean,
  ): ImpactExplanationContext {
    const allowedSet = new Set(allowedIds);
    const cat = buildCategorizedFindings(findingsList, allowedSet);
    const isTruncated = truncatedFlag;
    const analysisWasTruncated = Boolean(analysis.truncated);
    const contextLimitsExceeded =
      omittedFindingsCount > 0 ||
      omittedEvidenceCount > 0 ||
      omittedUnresolvedFilesCount > 0;

    const truncationDetails: TruncationDetails = {
      isTruncated,
      analysisWasTruncated,
      analysisTruncationReason: analysis.truncationReason ?? null,
      contextLimitsExceeded,
      reasons: currentReasons,
      omittedFindingsCount,
      omittedEvidenceCount,
      omittedUnresolvedFilesCount,
    };

    return {
      impactAnalysisId: analysis.id,
      pullRequestId: analysis.pullRequestId,
      analysisRunId: analysis.analysisRunId,
      status: analysis.status,
      directImpact: cat.directImpact,
      downstreamImpact: cat.downstreamImpact,
      affectedApis: cat.affectedApis,
      affectedEvents: cat.affectedEvents,
      affectedServices: cat.affectedServices,
      workflowImpactSummary,
      unresolvedFiles: unresolvedList,
      executionMetrics,
      truncated: isTruncated,
      truncationReason: currentReasons.length > 0 ? currentReasons.join("; ") : null,
      truncation: truncationDetails,
      evidenceRecords: evidenceList,
      allowedEvidenceIds: allowedIds,
    };
  }

  // 7. Initialize underlying analysis truncation state
  const analysisWasTruncated = Boolean(analysis.truncated);
  if (analysisWasTruncated) {
    const rawReason = analysis.truncationReason?.trim();
    const analysisReason = rawReason
      ? sanitizeUntrustedString(rawReason, limits.maxStringLength)
      : "Underlying impact analysis was truncated during graph traversal";
    if (!reasons.includes(analysisReason)) {
      reasons.unshift(analysisReason);
    }
  }

  // Helper to build a candidate envelope including potential budget truncation reasons
  let budgetTrimmedFindings = 0;
  let budgetTrimmedFiles = 0;

  function buildBudgetCandidate(): ImpactExplanationContext {
    const activeReasons = [...reasons];
    if (budgetTrimmedFindings > 0 || budgetTrimmedFiles > 0) {
      activeReasons.push(
        `Context character budget (${limits.maxTotalCharacters}) exceeded: ${budgetTrimmedFindings} findings and ${budgetTrimmedFiles} unresolved files omitted to fit context`,
      );
    }
    const isTruncated = analysisWasTruncated || activeReasons.length > 0;
    return buildContextEnvelope(
      retainedFindingsList,
      retainedEvidenceRecords,
      allowedEvidenceIds,
      retainedUnresolved,
      activeReasons,
      isTruncated,
    );
  }

  // 8. Enforce context character budget (maxTotalCharacters)
  // NOTE: limits.maxTotalCharacters strictly bounds the compact serialized JSON context envelope.
  // The final request message (ModelGatewayRequest.messages[0].content) will be larger due to
  // pretty-printing (space=2), secondary manifest serialization, static prompt instructions,
  // truncation disclosures, and Unicode escaping of markup characters. The final request message
  // is bounded by DEFAULT_MAX_REQUEST_MESSAGE_CHARACTERS with a deterministic fail-closed check
  // in request-builder.ts.
  let candidateContext = buildBudgetCandidate();
  let serializedLength = JSON.stringify(candidateContext).length;

  if (serializedLength > limits.maxTotalCharacters) {
    // Step A: Drop unresolved files if present
    while (
      retainedUnresolved.length > 0 &&
      serializedLength > limits.maxTotalCharacters
    ) {
      retainedUnresolved = retainedUnresolved.slice(0, -1);
      budgetTrimmedFiles++;
      omittedUnresolvedFilesCount++;

      candidateContext = buildBudgetCandidate();
      serializedLength = JSON.stringify(candidateContext).length;
    }

    // Step B: Iteratively drop lowest-priority findings
    while (
      retainedFindingsList.length > 0 &&
      serializedLength > limits.maxTotalCharacters
    ) {
      // Remove lowest priority finding (at the end of sorted array)
      retainedFindingsList = retainedFindingsList.slice(0, -1);
      budgetTrimmedFindings++;
      omittedFindingsCount++;

      // Recompute required evidence
      const prevEvidenceCount = retainedEvidenceRecords.length;
      const resolved = resolveRetainedEvidence(retainedFindingsList);
      retainedEvidenceRecords = resolved.evidenceRecords;
      allowedEvidenceIds = resolved.allowedEvidenceIds;

      const droppedEvidence = prevEvidenceCount - retainedEvidenceRecords.length;
      if (droppedEvidence > 0) {
        omittedEvidenceCount += droppedEvidence;
      }

      candidateContext = buildBudgetCandidate();
      serializedLength = JSON.stringify(candidateContext).length;
    }

    if (serializedLength > limits.maxTotalCharacters) {
      throw ImpactExplanationContextError.budgetExceeded(
        `Context character budget (${limits.maxTotalCharacters}) is too small to fit the base context envelope (${serializedLength} characters).`,
      );
    }
  }

  return candidateContext;
}
