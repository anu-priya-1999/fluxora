import type { GraphEdge } from "./graph.ts";
import type {
  ExtractedSimulationEdgeMetadata,
  MetadataPresence,
  ScenarioFailureType,
  SimulationResultState,
  SimulationRule,
  SimulationRuleDecision,
  SimulationRuleInput,
  SimulationRuleTable,
} from "./simulation.ts";
import { DEFAULT_SIMULATION_RULE_TABLE_VERSION } from "./simulation.ts";

// ---------------------------------------------------------------------------
// Canonical Rule Identifiers (Step 53)
// ---------------------------------------------------------------------------

export const RULE_ID_CALLS_CIRCUIT_BREAKER = "CALLS+circuit_breaker" as const;
export const RULE_ID_CALLS_SYNC_NO_FALLBACK = "CALLS+sync+no_fallback" as const;
export const RULE_ID_WRITES_FAILURE = "WRITES+failure" as const;
export const RULE_ID_EMITS_CONSUMER_AT_RISK = "EMITS+consumer_only" as const;
export const RULE_ID_NO_MATCH = "NO_MATCH" as const;

// ---------------------------------------------------------------------------
// State Severity Hierarchy Helper
// ---------------------------------------------------------------------------

const STATE_SEVERITY_ORDER: Record<SimulationResultState, number> = {
  healthy: 0,
  at_risk: 1,
  degraded: 2,
  failed: 3,
};

/**
 * Returns true if newState is strictly more severe than currentState.
 * Severity order: failed (3) > degraded (2) > at_risk (1) > healthy (0).
 */
export function isStateMoreSevere(
  newState: SimulationResultState,
  currentState: SimulationResultState,
): boolean {
  return STATE_SEVERITY_ORDER[newState] > STATE_SEVERITY_ORDER[currentState];
}

// ---------------------------------------------------------------------------
// Edge Metadata Extraction Helper
// ---------------------------------------------------------------------------

/**
 * Extracts and normalizes simulation-relevant properties from an edge's metadata.
 * Preserves explicit unknown states (never silently defaults unknown to false).
 */
export function extractSimulationEdgeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ExtractedSimulationEdgeMetadata {
  if (!metadata || typeof metadata !== "object") {
    return {
      sync: "unknown",
      hasFallback: "unknown",
      hasCircuitBreaker: "unknown",
    };
  }

  // sync / async normalization
  let sync: MetadataPresence = "unknown";
  if (metadata.sync === true || metadata.isSync === true) {
    sync = true;
  } else if (
    metadata.sync === false ||
    metadata.isSync === false ||
    metadata.async === true ||
    metadata.isAsync === true
  ) {
    sync = false;
  } else if (metadata.sync === "unknown" || metadata.isSync === "unknown") {
    sync = "unknown";
  }

  // fallback normalization
  let hasFallback: MetadataPresence = "unknown";
  if (
    metadata.hasFallback === true ||
    metadata.fallback === true ||
    metadata.hasFallbackHandler === true
  ) {
    hasFallback = true;
  } else if (
    metadata.hasFallback === false ||
    metadata.fallback === false ||
    metadata.hasFallbackHandler === false
  ) {
    hasFallback = false;
  } else if (
    metadata.hasFallback === "unknown" ||
    metadata.fallback === "unknown"
  ) {
    hasFallback = "unknown";
  }

  // circuit breaker normalization
  let hasCircuitBreaker: MetadataPresence = "unknown";
  if (
    metadata.hasCircuitBreaker === true ||
    metadata.circuitBreaker === true ||
    metadata.hasCircuitBreakerProtection === true
  ) {
    hasCircuitBreaker = true;
  } else if (
    metadata.hasCircuitBreaker === false ||
    metadata.circuitBreaker === false ||
    metadata.hasCircuitBreakerProtection === false
  ) {
    hasCircuitBreaker = false;
  } else if (
    metadata.hasCircuitBreaker === "unknown" ||
    metadata.circuitBreaker === "unknown"
  ) {
    hasCircuitBreaker = "unknown";
  }

  return {
    sync,
    hasFallback,
    hasCircuitBreaker,
  };
}

/**
 * Convenience adapter constructing a SimulationRuleInput from a GraphEdge.
 */
export function createSimulationRuleInputFromEdge(
  edge: GraphEdge,
  sourceState: SimulationResultState,
  targetState: SimulationResultState,
  options?: {
    readonly failureType?: ScenarioFailureType;
    readonly sourceNodeName?: string;
    readonly targetNodeName?: string;
    readonly isWriteFailure?: boolean;
  },
): SimulationRuleInput {
  const extracted = extractSimulationEdgeMetadata(edge.metadata);
  return {
    edgeType: edge.edgeType,
    sourceState,
    targetState,
    sync: extracted.sync,
    hasFallback: extracted.hasFallback,
    hasCircuitBreaker: extracted.hasCircuitBreaker,
    failureType: options?.failureType ?? "unavailable",
    isWriteFailure: options?.isWriteFailure,
    sourceNodeName: options?.sourceNodeName,
    targetNodeName: options?.targetNodeName,
    metadata: edge.metadata,
  };
}

// ---------------------------------------------------------------------------
// Helpers for Assumptions & Rule Evaluation
// ---------------------------------------------------------------------------

function isTargetImpaired(state: SimulationResultState): boolean {
  return state === "failed" || state === "degraded";
}

function resolveCallDescriptor(
  sourceName?: string,
  targetName?: string,
): string {
  if (sourceName && targetName) {
    return `${sourceName}->${targetName}`;
  }
  return "call";
}

function resolveResolvedMetadata(
  input: SimulationRuleInput,
): ExtractedSimulationEdgeMetadata {
  const fromMeta = input.metadata
    ? extractSimulationEdgeMetadata(input.metadata)
    : undefined;

  const sync =
    input.sync !== undefined
      ? input.sync
      : (fromMeta?.sync ?? "unknown");

  const hasFallback =
    input.hasFallback !== undefined
      ? input.hasFallback
      : (fromMeta?.hasFallback ?? "unknown");

  const hasCircuitBreaker =
    input.hasCircuitBreaker !== undefined
      ? input.hasCircuitBreaker
      : (fromMeta?.hasCircuitBreaker ?? "unknown");

  return {
    sync,
    hasFallback,
    hasCircuitBreaker,
  };
}

// ---------------------------------------------------------------------------
// Normative Rule Definitions (Step 53)
// ---------------------------------------------------------------------------

/**
 * Rule 1: calls.circuit_breaker
 * CALLS + circuit breaker present
 * -> dependent/caller DEGRADED, capped=true
 */
export const callsCircuitBreakerRule: SimulationRule = {
  id: RULE_ID_CALLS_CIRCUIT_BREAKER,
  version: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  name: "Calls with Circuit Breaker Protection",
  description:
    "Synchronous call to a failed or degraded dependency with circuit breaker trips and isolates failure, degrading caller with capped blast radius.",
  supportedEdgeTypes: ["CALLS"],
  evaluate(input: SimulationRuleInput): SimulationRuleDecision {
    if (input.edgeType !== "CALLS") {
      return noMatchDecision();
    }
    if (!isTargetImpaired(input.targetState)) {
      return noMatchDecision();
    }
    if (input.sourceState === "failed") {
      return noMatchDecision();
    }

    const { sync, hasCircuitBreaker, hasFallback } =
      resolveResolvedMetadata(input);

    if (sync === false) {
      return noMatchDecision();
    }

    // Must have circuit breaker explicitly confirmed present (true)
    if (hasCircuitBreaker !== true) {
      return noMatchDecision();
    }

    const descriptor = resolveCallDescriptor(
      input.sourceNodeName,
      input.targetNodeName,
    );
    const assumptions: string[] = [
      descriptor === "call"
        ? "Circuit breaker present on call; caller degrades with fail-fast isolation, capping downstream propagation"
        : `Circuit breaker detected on ${descriptor} call; caller degrades with fail-fast isolation, capping downstream propagation`,
    ];

    if (hasFallback === "unknown") {
      assumptions.push(
        descriptor === "call"
          ? "No fallback handler detected on call"
          : `No fallback handler detected on ${descriptor} call`,
      );
    }

    const confidence = hasFallback === "unknown" ? 0.9 : 0.95;

    return {
      matched: true,
      resultingState: "degraded",
      ruleId: RULE_ID_CALLS_CIRCUIT_BREAKER,
      ruleVersion: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
      affectedNode: "source",
      capped: true,
      assumptions,
      confidence,
    };
  },
};

/**
 * Rule 2: calls.sync.no_fallback
 * CALLS + sync + no fallback
 * -> dependent/caller DEGRADED, capped=false
 *
 * Semantic conditions:
 * - sync: confirmed true OR "unknown" (conservative default: assume synchronous)
 * - hasFallback: confirmed false OR "unknown" (conservative default: assume no fallback)
 * - hasCircuitBreaker: confirmed false OR "unknown" (conservative default: assume no circuit breaker)
 *
 * Suppression conditions (returns non-match):
 * - sync === false (async call does not match synchronous rule; non-match)
 * - hasFallback === true (fallback present suppresses this rule; non-match)
 * - hasCircuitBreaker === true (handled by callsCircuitBreakerRule)
 */
export const callsSyncNoFallbackRule: SimulationRule = {
  id: RULE_ID_CALLS_SYNC_NO_FALLBACK,
  version: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  name: "Synchronous Call Without Fallback",
  description:
    "Synchronous call to a failed or degraded dependency with no fallback causes caller to become degraded.",
  supportedEdgeTypes: ["CALLS"],
  evaluate(input: SimulationRuleInput): SimulationRuleDecision {
    if (input.edgeType !== "CALLS") {
      return noMatchDecision();
    }
    if (!isTargetImpaired(input.targetState)) {
      return noMatchDecision();
    }
    if (input.sourceState === "failed") {
      return noMatchDecision();
    }

    const { sync, hasFallback, hasCircuitBreaker } =
      resolveResolvedMetadata(input);

    // Explicit non-matches per Corrections 1 & 2:
    // Fallback present suppresses rule -> non-match
    if (hasFallback === true) {
      return noMatchDecision();
    }
    // Async call does not match synchronous rule -> non-match
    if (sync === false) {
      return noMatchDecision();
    }
    // Circuit breaker handled by separate rule -> non-match
    if (hasCircuitBreaker === true) {
      return noMatchDecision();
    }

    const descriptor = resolveCallDescriptor(
      input.sourceNodeName,
      input.targetNodeName,
    );
    const assumptions: string[] = [];

    // Surface explicit assumptions only for unverified ("unknown") properties
    if (hasCircuitBreaker === "unknown") {
      assumptions.push(
        descriptor === "call"
          ? "No circuit breaker detected on call"
          : `No circuit breaker detected on ${descriptor} call`,
      );
    }

    if (hasFallback === "unknown") {
      assumptions.push(
        descriptor === "call"
          ? "No fallback handler detected on call"
          : `No fallback handler detected on ${descriptor} call`,
      );
    }

    if (sync === "unknown") {
      assumptions.push(
        descriptor === "call"
          ? "Synchronous invocation assumed (no async decoupling detected)"
          : `Synchronous invocation assumed on ${descriptor} (no async decoupling detected)`,
      );
    }

    if (input.failureType === "latency") {
      assumptions.push(
        "Dependency latency degradation propagates to synchronous caller",
      );
    }

    const confidence = assumptions.length > 0 ? 0.9 : 1.0;

    return {
      matched: true,
      resultingState: "degraded",
      ruleId: RULE_ID_CALLS_SYNC_NO_FALLBACK,
      ruleVersion: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
      affectedNode: "source",
      capped: false,
      assumptions,
      confidence,
    };
  },
};

/**
 * Rule 3: writes.failure
 * WRITES + failed dependency
 * -> dependent READERS AT_RISK
 *
 * Strictly scoped per Correction 3:
 * Only produces AT_RISK for dependent READ / query consumers (QUERIES_DB).
 * Dependent write edges (WRITES) return non-match.
 */
export const writesFailureRule: SimulationRule = {
  id: RULE_ID_WRITES_FAILURE,
  version: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  name: "Write Failure Impact on Dependent Reads",
  description:
    "Datastore write failure or database outage places dependent data reads at risk of stale, missing, or inconsistent state.",
  supportedEdgeTypes: ["QUERIES_DB"],
  evaluate(input: SimulationRuleInput): SimulationRuleDecision {
    // Correction 3: Narrow to dependent read operations only.
    // Dependent writes (edgeType === "WRITES") are strictly non-matching.
    if (input.edgeType !== "QUERIES_DB") {
      return noMatchDecision();
    }

    const targetHasOutage = isTargetImpaired(input.targetState);
    const writeFailed = input.isWriteFailure === true;

    if (!targetHasOutage && !writeFailed) {
      return noMatchDecision();
    }

    if (input.sourceState === "failed") {
      return noMatchDecision();
    }

    const assumptions: string[] = [
      "Write failure or datastore outage places dependent data reads at risk of stale, missing, or inconsistent state",
    ];

    const { hasFallback } = resolveResolvedMetadata(input);
    if (hasFallback === "unknown") {
      assumptions.push(
        "No read-replica or secondary datastore fallback detected",
      );
    }

    if (input.failureType === "latency") {
      assumptions.push(
        "Datastore latency degradation may cause read timeouts or stale read-after-write windows",
      );
    }

    const confidence = hasFallback === "unknown" ? 0.85 : 0.9;

    return {
      matched: true,
      resultingState: "at_risk",
      ruleId: RULE_ID_WRITES_FAILURE,
      ruleVersion: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
      affectedNode: "source",
      capped: false,
      assumptions,
      confidence,
    };
  },
};

/**
 * Rule 4: emits.consumer_only
 * EMITS + consumer
 * -> consumer AT_RISK, producer unaffected
 *
 * When evaluated on CONSUMES_EVENT (or EMITS evaluating consumer target),
 * consumer becomes AT_RISK.
 * When evaluated on EMITS_EVENT (producer edge), producer is unaffected (non-match).
 */
export const emitsConsumerAtRiskRule: SimulationRule = {
  id: RULE_ID_EMITS_CONSUMER_AT_RISK,
  version: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  name: "Event Consumer at Risk",
  description:
    "Event delivery failure or broker outage places event consumer at risk of missed or delayed messages.",
  supportedEdgeTypes: ["CONSUMES_EVENT"],
  evaluate(input: SimulationRuleInput): SimulationRuleDecision {
    // If edge is EMITS_EVENT: producer remains unaffected -> non-match
    if (input.edgeType === "EMITS_EVENT") {
      return noMatchDecision();
    }

    const isConsumeEdge =
      input.edgeType === "CONSUMES_EVENT" || input.edgeType === "EMITS";

    if (!isConsumeEdge) {
      return noMatchDecision();
    }

    const sourceImpaired = isTargetImpaired(input.sourceState);
    const targetImpaired = isTargetImpaired(input.targetState);

    if (!sourceImpaired && !targetImpaired) {
      return noMatchDecision();
    }

    if (input.targetState === "failed") {
      return noMatchDecision();
    }

    const assumptions: string[] = [
      "Event delivery failure or broker outage places event consumer at risk of missed or delayed messages; producer remains unaffected",
    ];

    if (input.failureType === "latency") {
      assumptions.push(
        "Event broker latency delays message processing queue; consumer SLA at risk",
      );
    }

    return {
      matched: true,
      resultingState: "at_risk",
      ruleId: RULE_ID_EMITS_CONSUMER_AT_RISK,
      ruleVersion: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
      affectedNode: "target",
      capped: false,
      assumptions,
      confidence: 0.9,
    };
  },
};

// ---------------------------------------------------------------------------
// Normative Rule Table (Step 53)
// ---------------------------------------------------------------------------

/**
 * Deterministically ordered normative simulation rule table (Version 1.0.0).
 * Exactly 4 rules per architecture:
 * 1. calls.circuit_breaker
 * 2. calls.sync.no_fallback
 * 3. writes.failure
 * 4. emits.consumer_only
 */
export const DEFAULT_SIMULATION_RULES: readonly SimulationRule[] = [
  callsCircuitBreakerRule,
  callsSyncNoFallbackRule,
  writesFailureRule,
  emitsConsumerAtRiskRule,
] as const;

export const DEFAULT_SIMULATION_RULE_TABLE: SimulationRuleTable = {
  version: DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  rules: DEFAULT_SIMULATION_RULES,
};

// ---------------------------------------------------------------------------
// Evaluator Functions (Step 53)
// ---------------------------------------------------------------------------

function noMatchDecision(
  version: string = DEFAULT_SIMULATION_RULE_TABLE_VERSION,
): SimulationRuleDecision {
  return {
    matched: false,
    resultingState: undefined,
    ruleId: RULE_ID_NO_MATCH,
    ruleVersion: version,
    affectedNode: "none",
    capped: false,
    assumptions: [],
    confidence: 1.0,
  };
}

/**
 * Evaluates an edge relationship against the simulation rule table.
 * Returns the first deterministic matching decision, or a non-matching decision
 * if no rule conditions were met.
 */
export function evaluateSimulationRule(
  input: SimulationRuleInput,
  table: SimulationRuleTable = DEFAULT_SIMULATION_RULE_TABLE,
): SimulationRuleDecision {
  for (const rule of table.rules) {
    const decision = rule.evaluate(input);
    if (decision.matched) {
      return decision;
    }
  }

  return noMatchDecision(table.version);
}

/**
 * Evaluates an edge relationship against all rules in the table, returning
 * every rule decision that matched.
 */
export function evaluateAllSimulationRules(
  input: SimulationRuleInput,
  table: SimulationRuleTable = DEFAULT_SIMULATION_RULE_TABLE,
): readonly SimulationRuleDecision[] {
  const matches: SimulationRuleDecision[] = [];

  for (const rule of table.rules) {
    const decision = rule.evaluate(input);
    if (decision.matched) {
      matches.push(decision);
    }
  }

  return matches;
}
