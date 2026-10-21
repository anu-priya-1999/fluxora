import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type {
  GraphEdge,
  SimulationRule,
  SimulationRuleInput,
  SimulationRuleTable,
} from "./simulation-rules.ts";
import {
  DEFAULT_SIMULATION_RULE_TABLE,
  DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  RULE_ID_CALLS_CIRCUIT_BREAKER,
  RULE_ID_CALLS_SYNC_NO_FALLBACK,
  RULE_ID_EMITS_CONSUMER_AT_RISK,
  RULE_ID_NO_MATCH,
  RULE_ID_WRITES_FAILURE,
  callsCircuitBreakerRule,
  callsSyncNoFallbackRule,
  createSimulationRuleInputFromEdge,
  emitsConsumerAtRiskRule,
  evaluateAllSimulationRules,
  evaluateSimulationRule,
  extractSimulationEdgeMetadata,
  isStateMoreSevere,
  writesFailureRule,
} from "./simulation-rules.ts";

describe("Step 53: Simulation Rule Table — Unit Tests (§12.1, §5.10, §4.7)", () => {
  // -------------------------------------------------------------------------
  // 1. Rule 1: calls.sync.no_fallback (CALLS + sync + no fallback -> DEGRADED)
  // -------------------------------------------------------------------------
  describe("Rule: calls.sync.no_fallback", () => {
    it("sync CALLS + no fallback -> degraded", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
      assert.equal(decision.affectedNode, "source");
      assert.equal(decision.capped, false);
      assert.equal(decision.ruleId, RULE_ID_CALLS_SYNC_NO_FALLBACK);
      assert.equal(decision.ruleVersion, DEFAULT_SIMULATION_RULE_TABLE_VERSION);
      assert.equal(decision.confidence, 1.0);
      assert.equal(decision.assumptions.length, 0);
    });

    it("matches when target dependency is degraded", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "degraded",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
    });

    it("does not match if target dependency is healthy", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "healthy",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, false);
      assert.equal(decision.resultingState, undefined);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
    });

    it("does not match if caller is already failed", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "failed",
        targetState: "failed",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, false);
    });

    // Correction 1: fallback presence suppresses no-fallback rule -> no match
    it("sync CALLS + fallback present -> no match (Correction 1)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: true,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, false);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
      assert.equal(decision.resultingState, undefined);
    });

    // Correction 2: async call does not match synchronous rule -> no match
    it("async CALLS -> no match (Correction 2)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: false,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, false);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
      assert.equal(decision.resultingState, undefined);
    });

    it("does not match if circuit breaker is present (handled by circuit breaker rule)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: true,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Rule 2: calls.circuit_breaker (CALLS + circuit breaker -> DEGRADED, capped)
  // -------------------------------------------------------------------------
  describe("Rule: calls.circuit_breaker", () => {
    it("CALLS + circuit breaker -> degraded + capped", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasCircuitBreaker: true,
        hasFallback: false,
      };

      const decision = callsCircuitBreakerRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
      assert.equal(decision.affectedNode, "source");
      assert.equal(decision.capped, true);
      assert.equal(decision.ruleId, RULE_ID_CALLS_CIRCUIT_BREAKER);
      assert.equal(decision.confidence, 0.95);
      assert.ok(
        decision.assumptions[0]?.includes("Circuit breaker present on call"),
      );
      assert.ok(
        decision.assumptions[0]?.includes("capping downstream propagation"),
      );
    });

    it("includes named nodes in circuit breaker assumption", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sourceNodeName: "CheckoutService",
        targetNodeName: "PaymentGateway",
        sync: true,
        hasCircuitBreaker: true,
        hasFallback: false,
      };

      const decision = callsCircuitBreakerRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.ok(
        decision.assumptions[0]?.includes(
          "Circuit breaker detected on CheckoutService->PaymentGateway call",
        ),
      );
    });

    it("does not match if target dependency is healthy", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "healthy",
        hasCircuitBreaker: true,
      };

      const decision = callsCircuitBreakerRule.evaluate(input);
      assert.equal(decision.matched, false);
    });

    it("does not match if call is async (sync: false)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: false,
        hasCircuitBreaker: true,
      };

      const decision = callsCircuitBreakerRule.evaluate(input);
      assert.equal(decision.matched, false);
    });

    it("does not match if circuit breaker is unknown (cannot assume protection)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasCircuitBreaker: "unknown",
      };

      const decision = callsCircuitBreakerRule.evaluate(input);
      assert.equal(decision.matched, false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Conservative Defaults & Explicit Unknown Metadata (Correction 4 & §5.10)
  // -------------------------------------------------------------------------
  describe("Conservative Defaults & Explicit Unknown Metadata (Correction 4 & §5.10)", () => {
    it("circuit breaker unknown -> conservative assumption", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: "unknown",
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
      assert.equal(decision.confidence, 0.9);
      assert.equal(decision.assumptions.length, 1);
      assert.equal(
        decision.assumptions[0],
        "No circuit breaker detected on call",
      );
    });

    it("fallback unknown -> conservative assumption", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: "unknown",
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
      assert.equal(decision.confidence, 0.9);
      assert.equal(decision.assumptions.length, 1);
      assert.equal(
        decision.assumptions[0],
        "No fallback handler detected on call",
      );
    });

    it("surfaces all assumptions when all metadata is unknown/omitted", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        // sync, hasFallback, hasCircuitBreaker all omitted -> unknown
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
      assert.equal(decision.confidence, 0.9);
      assert.equal(decision.assumptions.length, 3);
      assert.ok(
        decision.assumptions.includes("No circuit breaker detected on call"),
      );
      assert.ok(
        decision.assumptions.includes("No fallback handler detected on call"),
      );
      assert.ok(
        decision.assumptions.includes(
          "Synchronous invocation assumed (no async decoupling detected)",
        ),
      );
    });

    it("formats assumptions with node names when unknown metadata is present", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sourceNodeName: "OrderService",
        targetNodeName: "PaymentProvider",
        hasCircuitBreaker: "unknown",
        hasFallback: "unknown",
        sync: "unknown",
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.ok(
        decision.assumptions.includes(
          "No circuit breaker detected on OrderService->PaymentProvider call",
        ),
      );
      assert.ok(
        decision.assumptions.includes(
          "No fallback handler detected on OrderService->PaymentProvider call",
        ),
      );
      assert.ok(
        decision.assumptions.includes(
          "Synchronous invocation assumed on OrderService->PaymentProvider (no async decoupling detected)",
        ),
      );
    });

    it("unavailable scenario: default failure type evaluated", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        failureType: "unavailable",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);
      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
    });

    it("latency scenario: qualitative latency degradation propagation", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "degraded",
        failureType: "latency",
        sync: true,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = callsSyncNoFallbackRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "degraded");
      assert.equal(decision.confidence, 0.9);
      assert.ok(
        decision.assumptions.includes(
          "Dependency latency degradation propagates to synchronous caller",
        ),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Rule 3: writes.failure (Correction 3: dependent READS only)
  // -------------------------------------------------------------------------
  describe("Rule: writes.failure (Correction 3)", () => {
    it("WRITES + failure + dependent read -> at_risk", () => {
      const input: SimulationRuleInput = {
        edgeType: "QUERIES_DB",
        sourceState: "healthy",
        targetState: "failed",
        hasFallback: false,
      };

      const decision = writesFailureRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "at_risk");
      assert.equal(decision.affectedNode, "source");
      assert.equal(decision.capped, false);
      assert.equal(decision.ruleId, RULE_ID_WRITES_FAILURE);
      assert.ok(
        decision.assumptions.some((a) =>
          a.includes("Write failure or datastore outage places dependent data reads at risk"),
        ),
      );
    });

    // Correction 3 Regression Test:
    it("WRITES + failure + dependent write -> no match (Correction 3 regression test)", () => {
      const input: SimulationRuleInput = {
        edgeType: "WRITES",
        sourceState: "healthy",
        targetState: "failed",
        hasFallback: false,
      };

      const decision = writesFailureRule.evaluate(input);

      assert.equal(decision.matched, false);
      assert.equal(decision.resultingState, undefined);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
    });

    it("matches QUERIES_DB when datastore is degraded", () => {
      const input: SimulationRuleInput = {
        edgeType: "QUERIES_DB",
        sourceState: "healthy",
        targetState: "degraded",
        hasFallback: false,
      };

      const decision = writesFailureRule.evaluate(input);
      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "at_risk");
    });

    it("matches QUERIES_DB when explicit isWriteFailure is true", () => {
      const input: SimulationRuleInput = {
        edgeType: "QUERIES_DB",
        sourceState: "healthy",
        targetState: "degraded",
        isWriteFailure: true,
        hasFallback: false,
      };

      const decision = writesFailureRule.evaluate(input);
      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "at_risk");
    });

    it("surfaces latency assumption for datastore latency scenario", () => {
      const input: SimulationRuleInput = {
        edgeType: "QUERIES_DB",
        sourceState: "healthy",
        targetState: "degraded",
        failureType: "latency",
        hasFallback: false,
      };

      const decision = writesFailureRule.evaluate(input);
      assert.equal(decision.matched, true);
      assert.ok(
        decision.assumptions.some((a) =>
          a.includes("Datastore latency degradation may cause read timeouts"),
        ),
      );
    });

    it("does not match if datastore is healthy and no write failure occurred", () => {
      const input: SimulationRuleInput = {
        edgeType: "QUERIES_DB",
        sourceState: "healthy",
        targetState: "healthy",
        hasFallback: false,
      };

      const decision = writesFailureRule.evaluate(input);
      assert.equal(decision.matched, false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Rule 4: emits.consumer_only (EMITS + consumer -> AT_RISK, producer unaffected)
  // -------------------------------------------------------------------------
  describe("Rule: emits.consumer_only", () => {
    it("EMITS + consumer -> consumer at_risk", () => {
      const input: SimulationRuleInput = {
        edgeType: "CONSUMES_EVENT",
        sourceState: "failed", // broker / event node failed
        targetState: "healthy", // consumer handler
      };

      const decision = emitsConsumerAtRiskRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.resultingState, "at_risk");
      assert.equal(decision.affectedNode, "target");
      assert.equal(decision.capped, false);
      assert.equal(decision.ruleId, RULE_ID_EMITS_CONSUMER_AT_RISK);
      assert.ok(
        decision.assumptions[0]?.includes(
          "Event delivery failure or broker outage places event consumer at risk",
        ),
      );
    });

    it("producer remains unaffected -> no match on EMITS_EVENT edge", () => {
      const input: SimulationRuleInput = {
        edgeType: "EMITS_EVENT",
        sourceState: "healthy", // producer
        targetState: "failed", // event broker
      };

      const decision = emitsConsumerAtRiskRule.evaluate(input);

      // Producer is unaffected: no propagation state change!
      assert.equal(decision.matched, false);
      assert.equal(decision.resultingState, undefined);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
    });

    it("EMITS + consumer latency scenario surfaces queue delay assumption", () => {
      const input: SimulationRuleInput = {
        edgeType: "CONSUMES_EVENT",
        sourceState: "degraded",
        targetState: "healthy",
        failureType: "latency",
      };

      const decision = emitsConsumerAtRiskRule.evaluate(input);

      assert.equal(decision.matched, true);
      assert.ok(
        decision.assumptions.some((a) =>
          a.includes("Event broker latency delays message processing queue"),
        ),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Evaluator Engine & Normative Rule Table Integration
  // -------------------------------------------------------------------------
  describe("evaluateSimulationRule & Normative Table Integration", () => {
    it("DEFAULT_SIMULATION_RULE_TABLE contains exactly the 4 normative rules", () => {
      assert.equal(DEFAULT_SIMULATION_RULE_TABLE.version, "1.0.0");
      assert.equal(DEFAULT_SIMULATION_RULE_TABLE.rules.length, 4);

      const ruleIds = DEFAULT_SIMULATION_RULE_TABLE.rules.map((r) => r.id);
      assert.deepEqual(ruleIds, [
        RULE_ID_CALLS_CIRCUIT_BREAKER,
        RULE_ID_CALLS_SYNC_NO_FALLBACK,
        RULE_ID_WRITES_FAILURE,
        RULE_ID_EMITS_CONSUMER_AT_RISK,
      ]);
    });

    it("circuit breaker evaluated before no-fallback", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasCircuitBreaker: true,
        hasFallback: false,
      };

      const decision = evaluateSimulationRule(input);

      assert.equal(decision.matched, true);
      assert.equal(decision.ruleId, RULE_ID_CALLS_CIRCUIT_BREAKER);
      assert.equal(decision.capped, true);
    });

    it("sync CALLS + fallback present -> no match (Correction 1)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: true,
        hasCircuitBreaker: false,
      };

      const decision = evaluateSimulationRule(input);

      assert.equal(decision.matched, false);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
      assert.equal(decision.resultingState, undefined);
    });

    it("async CALLS -> no match (Correction 2)", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: false,
        hasFallback: false,
        hasCircuitBreaker: false,
      };

      const decision = evaluateSimulationRule(input);

      assert.equal(decision.matched, false);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
    });

    it("WRITES edge -> no match (Correction 3)", () => {
      const input: SimulationRuleInput = {
        edgeType: "WRITES",
        sourceState: "healthy",
        targetState: "failed",
      };

      const decision = evaluateSimulationRule(input);

      assert.equal(decision.matched, false);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
    });

    it("EMITS_EVENT edge -> producer unaffected (no match)", () => {
      const input: SimulationRuleInput = {
        edgeType: "EMITS_EVENT",
        sourceState: "healthy",
        targetState: "failed",
      };

      const decision = evaluateSimulationRule(input);

      assert.equal(decision.matched, false);
      assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
    });

    it("unsupported combinations -> no match", () => {
      const unsupportedEdges = ["IMPORTS", "EXTENDS", "EXPOSES_ROUTE", "RESOLVES_TO"];

      for (const edgeType of unsupportedEdges) {
        const input: SimulationRuleInput = {
          edgeType,
          sourceState: "healthy",
          targetState: "failed",
        };

        const decision = evaluateSimulationRule(input);
        assert.equal(decision.matched, false, `Edge ${edgeType} must not match`);
        assert.equal(decision.ruleId, RULE_ID_NO_MATCH);
      }
    });

    it("deterministic repeated evaluation gives identical result", () => {
      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
        sync: true,
        hasFallback: "unknown",
        hasCircuitBreaker: "unknown",
        sourceNodeName: "SvcA",
        targetNodeName: "SvcB",
      };

      const decision1 = evaluateSimulationRule(input);
      const decision2 = evaluateSimulationRule(input);
      const decision3 = evaluateSimulationRule(input);

      assert.deepEqual(decision1, decision2);
      assert.deepEqual(decision2, decision3);
    });

    it("evaluateAllSimulationRules returns matching decisions", () => {
      const input: SimulationRuleInput = {
        edgeType: "QUERIES_DB",
        sourceState: "healthy",
        targetState: "failed",
        hasFallback: false,
      };

      const decisions = evaluateAllSimulationRules(input);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.ruleId, RULE_ID_WRITES_FAILURE);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Table Customization & Versioning
  // -------------------------------------------------------------------------
  describe("Rule Table Extensibility & Versioning", () => {
    it("supports evaluating with a custom versioned rule table", () => {
      const customRule: SimulationRule = {
        id: "CUSTOM_OVERRIDE",
        version: "2.0.0-beta",
        name: "Custom Test Rule",
        description: "Overrides CALLS degradation to failed",
        supportedEdgeTypes: ["CALLS"],
        evaluate(input: SimulationRuleInput) {
          if (input.edgeType === "CALLS" && input.targetState === "failed") {
            return {
              matched: true,
              resultingState: "failed",
              ruleId: "CUSTOM_OVERRIDE",
              ruleVersion: "2.0.0-beta",
              affectedNode: "source",
              capped: false,
              assumptions: ["Custom override applied"],
              confidence: 0.99,
            };
          }
          return {
            matched: false,
            ruleId: RULE_ID_NO_MATCH,
            ruleVersion: "2.0.0-beta",
            assumptions: [],
            confidence: 1.0,
          };
        },
      };

      const customTable: SimulationRuleTable = {
        version: "2.0.0-beta",
        rules: [customRule, ...DEFAULT_SIMULATION_RULE_TABLE.rules],
      };

      const input: SimulationRuleInput = {
        edgeType: "CALLS",
        sourceState: "healthy",
        targetState: "failed",
      };

      const decision = evaluateSimulationRule(input, customTable);

      assert.equal(decision.matched, true);
      assert.equal(decision.ruleId, "CUSTOM_OVERRIDE");
      assert.equal(decision.ruleVersion, "2.0.0-beta");
      assert.equal(decision.resultingState, "failed");
    });
  });

  // -------------------------------------------------------------------------
  // 8. State Severity Hierarchy Helper (isStateMoreSevere)
  // -------------------------------------------------------------------------
  describe("State Severity Hierarchy (isStateMoreSevere)", () => {
    it("correctly identifies monotonic severity transitions: failed > degraded > at_risk > healthy", () => {
      assert.equal(isStateMoreSevere("failed", "degraded"), true);
      assert.equal(isStateMoreSevere("failed", "at_risk"), true);
      assert.equal(isStateMoreSevere("failed", "healthy"), true);

      assert.equal(isStateMoreSevere("degraded", "at_risk"), true);
      assert.equal(isStateMoreSevere("degraded", "healthy"), true);
      assert.equal(isStateMoreSevere("degraded", "failed"), false);

      assert.equal(isStateMoreSevere("at_risk", "healthy"), true);
      assert.equal(isStateMoreSevere("at_risk", "degraded"), false);
      assert.equal(isStateMoreSevere("at_risk", "failed"), false);

      assert.equal(isStateMoreSevere("healthy", "at_risk"), false);
      assert.equal(isStateMoreSevere("healthy", "degraded"), false);
      assert.equal(isStateMoreSevere("healthy", "failed"), false);

      // Identity comparisons return false
      assert.equal(isStateMoreSevere("failed", "failed"), false);
      assert.equal(isStateMoreSevere("degraded", "degraded"), false);
      assert.equal(isStateMoreSevere("at_risk", "at_risk"), false);
      assert.equal(isStateMoreSevere("healthy", "healthy"), false);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Edge Metadata Extraction Helper (extractSimulationEdgeMetadata)
  // -------------------------------------------------------------------------
  describe("extractSimulationEdgeMetadata (Correction 4)", () => {
    it("extracts boolean flags from standard metadata keys", () => {
      const extracted = extractSimulationEdgeMetadata({
        sync: true,
        hasFallback: true,
        hasCircuitBreaker: true,
      });

      assert.equal(extracted.sync, true);
      assert.equal(extracted.hasFallback, true);
      assert.equal(extracted.hasCircuitBreaker, true);
    });

    it("extracts boolean flags from alternative aliases (isSync, fallback, circuitBreaker)", () => {
      const extracted = extractSimulationEdgeMetadata({
        isSync: true,
        fallback: true,
        circuitBreaker: true,
      });

      assert.equal(extracted.sync, true);
      assert.equal(extracted.hasFallback, true);
      assert.equal(extracted.hasCircuitBreaker, true);
    });

    it("interprets async: true as sync: false", () => {
      const extracted = extractSimulationEdgeMetadata({
        async: true,
      });

      assert.equal(extracted.sync, false);
    });

    it("preserves explicit unknown states instead of defaulting to false (Correction 4)", () => {
      const extracted = extractSimulationEdgeMetadata({});

      assert.equal(extracted.sync, "unknown");
      assert.equal(extracted.hasFallback, "unknown");
      assert.equal(extracted.hasCircuitBreaker, "unknown");
    });

    it("handles null or undefined metadata gracefully returning unknown", () => {
      const nullExtracted = extractSimulationEdgeMetadata(null);
      assert.equal(nullExtracted.sync, "unknown");

      const undefinedExtracted = extractSimulationEdgeMetadata(undefined);
      assert.equal(undefinedExtracted.sync, "unknown");
    });
  });

  // -------------------------------------------------------------------------
  // 10. Edge Adapter Helper (createSimulationRuleInputFromEdge)
  // -------------------------------------------------------------------------
  describe("createSimulationRuleInputFromEdge", () => {
    it("adapts a GraphEdge into a SimulationRuleInput with extracted metadata", () => {
      const edge: GraphEdge = {
        id: "00000000-0000-0000-0000-000000000001",
        analysisRunId: "00000000-0000-0000-0000-000000000002",
        sourceNodeId: "node-order-service",
        targetNodeId: "node-payment-service",
        edgeType: "CALLS",
        confidence: 1.0,
        provenance: "static-analysis",
        metadata: {
          circuitBreaker: true,
          fallback: false,
        },
        createdAt: new Date(),
      };

      const ruleInput = createSimulationRuleInputFromEdge(
        edge,
        "healthy",
        "failed",
        {
          sourceNodeName: "OrderService",
          targetNodeName: "PaymentService",
          failureType: "unavailable",
        },
      );

      assert.equal(ruleInput.edgeType, "CALLS");
      assert.equal(ruleInput.sourceState, "healthy");
      assert.equal(ruleInput.targetState, "failed");
      assert.equal(ruleInput.hasCircuitBreaker, true);
      assert.equal(ruleInput.hasFallback, false);
      assert.equal(ruleInput.sync, "unknown"); // omitted in metadata -> unknown
      assert.equal(ruleInput.sourceNodeName, "OrderService");
      assert.equal(ruleInput.targetNodeName, "PaymentService");
      assert.equal(ruleInput.failureType, "unavailable");

      const decision = evaluateSimulationRule(ruleInput);
      assert.equal(decision.matched, true);
      assert.equal(decision.ruleId, RULE_ID_CALLS_CIRCUIT_BREAKER);
      assert.equal(decision.capped, true);
    });
  });
});
