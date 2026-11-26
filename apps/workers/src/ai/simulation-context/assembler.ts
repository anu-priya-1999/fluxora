/**
 * @file assembler.ts
 * Pure deterministic context assembler for simulation narration (Phase 9 Step 63).
 *
 * Transforms persisted Simulation, Scenario, SimulationResult rows, and associated
 * simulation_state Evidence rows into a bounded SimulationNarrationContext with a
 * strictly synchronized allowed-evidence-ID manifest.
 *
 * INVARIANTS:
 * - Pure function: zero I/O, zero network, zero database, zero random generation.
 * - Deterministic: stable comparators across results, evidence, and manifest.
 * - Input immutability: never mutates input records.
 * - Strict evidence grounding: allowedEvidenceIds contains ONLY verified, retained evidence IDs.
 * - Authoritative deterministic core: metrics, paths, and states reflect simulation truth.
 */

import type {
  EvidenceRecord,
  Simulation,
  SimulationCausalStep,
  SimulationResult,
  SimulationResultState,
} from "@fluxora/shared-types";

import {
  DEFAULT_SIMULATION_CONTEXT_LIMITS,
  SimulationNarrationContextError,
  type AssembleSimulationNarrationContextParams,
  type BoundedScenario,
  type BoundedSimulationEvidenceRecord,
  type BoundedSimulationExecutionMetrics,
  type BoundedSimulationNodeResult,
  type SimulationContextLimits,
  type SimulationNarrationContext,
} from "./types.ts";

const STATE_SEVERITY_ORDER: Readonly<Record<SimulationResultState, number>> = Object.freeze({
  failed: 3,
  degraded: 2,
  at_risk: 1,
  healthy: 0,
});

function sanitizeString(val: unknown, maxLength: number): string {
  if (typeof val !== "string") {
    return "";
  }
  return val.trim().slice(0, maxLength);
}

function computeHopDistance(r: SimulationResult): number {
  if (Array.isArray(r.propagationPath) && r.propagationPath.length > 0) {
    return Math.max(0, r.propagationPath.length - 1);
  }
  return 0;
}

function parseCausalSteps(steps: readonly (SimulationCausalStep | string)[]): SimulationCausalStep[] {
  const parsed: SimulationCausalStep[] = [];
  for (const s of steps) {
    if (typeof s === "object" && s !== null && "nodeId" in s && "ruleId" in s) {
      parsed.push(s as SimulationCausalStep);
    }
  }
  return parsed;
}

/**
 * Deterministic result comparator:
 * 1. Higher confidence first
 * 2. Higher state severity first (failed > degraded > at_risk > healthy)
 * 3. Lower hop distance first
 * 4. Stable nodeId as tie-breaker
 */
function compareResults(a: BoundedSimulationNodeResult, b: BoundedSimulationNodeResult): number {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  const sevDiff =
    (STATE_SEVERITY_ORDER[b.resultingState] ?? 0) -
    (STATE_SEVERITY_ORDER[a.resultingState] ?? 0);
  if (sevDiff !== 0) {
    return sevDiff;
  }
  if (a.hopDistance !== b.hopDistance) {
    return a.hopDistance - b.hopDistance;
  }
  return a.nodeId.localeCompare(b.nodeId);
}

/**
 * Deterministic evidence comparator:
 * 1. Higher confidence first
 * 2. Stable file path
 * 3. Stable ID
 */
function compareEvidenceRecords(
  a: BoundedSimulationEvidenceRecord,
  b: BoundedSimulationEvidenceRecord,
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
 * Validates and indexes simulation_state evidence records.
 * Rejects records that:
 * 1. Are not subjectType === "simulation_state"
 * 2. Do not match analysisRunId
 * 3. Do not match simulationId in metadata or subjectId
 * 4. Have empty/invalid IDs
 */
function validateAndIndexEvidence(
  evidenceRecords: readonly EvidenceRecord[],
  simulation: Simulation,
  resultsById: ReadonlyMap<string, SimulationResult>,
  maxStringLength: number,
): Map<string, BoundedSimulationEvidenceRecord> {
  const map = new Map<string, BoundedSimulationEvidenceRecord>();

  for (const rec of evidenceRecords) {
    if (!rec || typeof rec !== "object") {
      continue;
    }

    if (rec.subjectType !== "simulation_state") {
      continue;
    }

    if (rec.analysisRunId !== simulation.analysisRunId) {
      continue;
    }

    const metadataSimId =
      typeof rec.metadata?.simulationId === "string"
        ? rec.metadata.simulationId
        : typeof rec.metadata?.simulation_id === "string"
          ? rec.metadata.simulation_id
          : null;

    if (metadataSimId && metadataSimId !== simulation.id) {
      continue;
    }

    const result = resultsById.get(rec.subjectId);
    // If not found by simulation_results ID, check if subjectId is nodeId or in metadata
    const nodeId =
      result?.nodeId ??
      (typeof rec.metadata?.nodeId === "string"
        ? rec.metadata.nodeId
        : typeof rec.metadata?.node_id === "string"
          ? rec.metadata.node_id
          : "");

    const resultingState =
      result?.resultingState ??
      (typeof rec.metadata?.resultingState === "string"
        ? rec.metadata.resultingState
        : typeof rec.metadata?.resulting_state === "string"
          ? rec.metadata.resulting_state
          : "unknown");

    const ruleApplied =
      result?.ruleApplied ??
      (typeof rec.metadata?.ruleApplied === "string"
        ? rec.metadata.ruleApplied
        : typeof rec.metadata?.rule_applied === "string"
          ? rec.metadata.rule_applied
          : "unknown");

    if (!rec.id || typeof rec.id !== "string" || rec.id.trim().length === 0) {
      continue;
    }

    map.set(rec.id, {
      id: rec.id.trim(),
      subjectType: rec.subjectType,
      subjectId: rec.subjectId,
      filePath: sanitizeString(rec.filePath, maxStringLength),
      symbolId: rec.symbolId ? sanitizeString(rec.symbolId, maxStringLength) : null,
      lineStart: rec.lineStart ?? null,
      lineEnd: rec.lineEnd ?? null,
      columnStart: rec.columnStart ?? null,
      columnEnd: rec.columnEnd ?? null,
      relationshipDescription: sanitizeString(rec.relationshipDescription, maxStringLength),
      confidence: typeof rec.confidence === "number" && Number.isFinite(rec.confidence) ? rec.confidence : 1.0,
      nodeId,
      resultingState,
      ruleApplied,
    });
  }

  return map;
}

/**
 * Computes execution metrics across all un-truncated results.
 */
function computeExecutionMetrics(
  results: readonly SimulationResult[],
): BoundedSimulationExecutionMetrics {
  let failedCount = 0;
  let degradedCount = 0;
  let atRiskCount = 0;
  let healthyCount = 0;
  let cappedCount = 0;
  let maxHopDistance = 0;

  for (const r of results) {
    const state = r.resultingState;
    if (state === "failed") failedCount++;
    else if (state === "degraded") degradedCount++;
    else if (state === "at_risk") atRiskCount++;
    else if (state === "healthy") healthyCount++;

    const hop = computeHopDistance(r);
    if (hop > maxHopDistance) {
      maxHopDistance = hop;
    }

    const steps = parseCausalSteps(r.propagationPath ?? []);
    if (steps.some((s) => s.capped === true)) {
      cappedCount++;
    }
  }

  return {
    totalResults: results.length,
    affectedCount: failedCount + degradedCount + atRiskCount,
    failedCount,
    degradedCount,
    atRiskCount,
    healthyCount,
    cappedCount,
    maxHopDistance,
  };
}

export function assembleSimulationNarrationContext(
  params: AssembleSimulationNarrationContextParams,
): SimulationNarrationContext {
  const { simulation, scenario, results, evidenceRecords } = params;

  if (simulation.status !== "completed") {
    throw SimulationNarrationContextError.notCompleted(
      `Simulation ${simulation.id} has status '${simulation.status}', but must be 'completed' for narration generation.`,
    );
  }

  if (scenario.id !== simulation.scenarioId) {
    throw SimulationNarrationContextError.invalidInput(
      `Scenario ID '${scenario.id}' does not match simulation scenario ID '${simulation.scenarioId}'.`,
    );
  }

  const limits: SimulationContextLimits = {
    ...DEFAULT_SIMULATION_CONTEXT_LIMITS,
    ...(params.limits ?? {}),
  };

  const resultsById = new Map<string, SimulationResult>();
  for (const r of results) {
    resultsById.set(r.id, r);
    resultsById.set(r.nodeId, r);
  }

  // 1. Validate and index verified evidence
  const validEvidenceMap = validateAndIndexEvidence(
    evidenceRecords,
    simulation,
    resultsById,
    limits.maxStringLength,
  );

  // Map node ID and simulation result ID to valid evidence IDs
  const evidenceIdsByResultId = new Map<string, string[]>();
  const evidenceIdsByNodeId = new Map<string, string[]>();

  for (const ev of validEvidenceMap.values()) {
    // Index by subjectId (which is result.id)
    const listBySubject = evidenceIdsByResultId.get(ev.subjectId) ?? [];
    listBySubject.push(ev.id);
    evidenceIdsByResultId.set(ev.subjectId, listBySubject);

    // Index by nodeId
    if (ev.nodeId) {
      const listByNode = evidenceIdsByNodeId.get(ev.nodeId) ?? [];
      listByNode.push(ev.id);
      evidenceIdsByNodeId.set(ev.nodeId, listByNode);
    }
  }

  // 2. Build Bounded Scenario
  const boundedScenario: BoundedScenario = {
    id: scenario.id,
    name: sanitizeString(scenario.name, limits.maxStringLength),
    targetNodeId: scenario.targetNodeId,
    failureType: scenario.failureType,
    parameters: typeof scenario.parameters === "object" && scenario.parameters !== null
      ? scenario.parameters
      : {},
  };

  // 3. Compute execution metrics over full results
  const executionMetrics = computeExecutionMetrics(results);

  // 4. Map raw results to BoundedSimulationNodeResult
  const allBoundedResults: BoundedSimulationNodeResult[] = [];
  for (const r of results) {
    const steps = parseCausalSteps(r.propagationPath ?? []);
    const hopDistance = computeHopDistance(r);
    const isCapped = steps.some((s) => s.capped === true);

    const linkedEvidenceIds = Array.from(
      new Set([
        ...(evidenceIdsByResultId.get(r.id) ?? []),
        ...(evidenceIdsByNodeId.get(r.nodeId) ?? []),
      ]),
    ).sort();

    allBoundedResults.push({
      nodeId: r.nodeId,
      resultingState: r.resultingState,
      ruleApplied: sanitizeString(r.ruleApplied, limits.maxStringLength),
      assumptions: Array.isArray(r.assumptions)
        ? r.assumptions.map((a) => sanitizeString(a, limits.maxStringLength))
        : [],
      confidence: typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? r.confidence
        : 1.0,
      hopDistance,
      capped: isCapped,
      propagationPath: steps,
      evidenceIds: linkedEvidenceIds,
    });
  }

  // Deterministically sort results
  allBoundedResults.sort(compareResults);

  // 5. Apply limits and budgeting
  let retainedResults = [...allBoundedResults];
  const truncationReasons: string[] = [];

  if (retainedResults.length > limits.maxResults) {
    const omitted = retainedResults.length - limits.maxResults;
    retainedResults = retainedResults.slice(0, limits.maxResults);
    truncationReasons.push(
      `Context limited to top ${limits.maxResults} results by confidence, severity, and hop distance (${omitted} omitted).`,
    );
  }

  // Collect evidence referenced by retained results
  const referencedEvidenceIds = new Set<string>();
  for (const r of retainedResults) {
    for (const evId of r.evidenceIds) {
      referencedEvidenceIds.add(evId);
    }
  }

  // Filter retained evidence records to only those referenced by retained results
  let retainedEvidenceRecords = Array.from(referencedEvidenceIds)
    .map((id) => validEvidenceMap.get(id))
    .filter((ev): ev is BoundedSimulationEvidenceRecord => ev !== undefined)
    .sort(compareEvidenceRecords);

  if (retainedEvidenceRecords.length > limits.maxEvidenceRecords) {
    const omittedEv = retainedEvidenceRecords.length - limits.maxEvidenceRecords;
    retainedEvidenceRecords = retainedEvidenceRecords.slice(0, limits.maxEvidenceRecords);
    truncationReasons.push(
      `Context limited to top ${limits.maxEvidenceRecords} evidence records (${omittedEv} omitted).`,
    );
  }

  // Derive allowed manifest strictly from retained evidence records
  let allowedEvidenceIds = retainedEvidenceRecords.map((e) => e.id).sort();
  let allowedEvidenceSet = new Set(allowedEvidenceIds);

  // Update retainedResults to filter their evidenceIds to only those in the allowed manifest
  retainedResults = retainedResults.map((r) => ({
    ...r,
    evidenceIds: r.evidenceIds.filter((id) => allowedEvidenceSet.has(id)),
  }));

  // 6. Character budgeting loop
  function buildEnvelope(
    curResults: readonly BoundedSimulationNodeResult[],
    curEvidence: readonly BoundedSimulationEvidenceRecord[],
    curManifest: readonly string[],
  ): string {
    return JSON.stringify({
      simulationId: simulation.id,
      scenarioId: scenario.id,
      analysisRunId: simulation.analysisRunId,
      status: simulation.status,
      scenario: boundedScenario,
      results: curResults,
      executionMetrics,
      allowedEvidenceIds: curManifest,
      evidenceRecords: curEvidence,
    });
  }

  let serialized = buildEnvelope(retainedResults, retainedEvidenceRecords, allowedEvidenceIds);

  while (serialized.length > limits.maxTotalCharacters && retainedResults.length > 1) {
    // Pop lowest-ranked result
    retainedResults.pop();

    // Recompute referenced evidence
    const curRefEvidenceIds = new Set<string>();
    for (const r of retainedResults) {
      for (const evId of r.evidenceIds) {
        curRefEvidenceIds.add(evId);
      }
    }

    retainedEvidenceRecords = retainedEvidenceRecords.filter((ev) => curRefEvidenceIds.has(ev.id));
    allowedEvidenceIds = retainedEvidenceRecords.map((e) => e.id).sort();
    allowedEvidenceSet = new Set(allowedEvidenceIds);

    retainedResults = retainedResults.map((r) => ({
      ...r,
      evidenceIds: r.evidenceIds.filter((id) => allowedEvidenceSet.has(id)),
    }));

    if (!truncationReasons.some((r) => r.includes("character budget"))) {
      truncationReasons.push("Results reduced to satisfy total character budget.");
    }

    serialized = buildEnvelope(retainedResults, retainedEvidenceRecords, allowedEvidenceIds);
  }

  const omittedResultsCount = results.length - retainedResults.length;
  const omittedEvidenceCount = validEvidenceMap.size - retainedEvidenceRecords.length;
  const isTruncated = omittedResultsCount > 0 || omittedEvidenceCount > 0 || truncationReasons.length > 0;

  return {
    simulationId: simulation.id,
    scenarioId: scenario.id,
    analysisRunId: simulation.analysisRunId,
    status: simulation.status,
    scenario: boundedScenario,
    results: Object.freeze(retainedResults),
    executionMetrics,
    allowedEvidenceIds: Object.freeze(allowedEvidenceIds),
    evidenceRecords: Object.freeze(retainedEvidenceRecords),
    truncated: isTruncated,
    truncationReason: isTruncated ? truncationReasons.join(" ") : null,
    truncation: {
      isTruncated,
      reasons: Object.freeze(truncationReasons),
      omittedResultsCount: Math.max(0, omittedResultsCount),
      omittedEvidenceCount: Math.max(0, omittedEvidenceCount),
    },
  };
}
