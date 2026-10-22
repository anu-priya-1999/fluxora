import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import type pg from "pg";
import type {
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  ScenarioFailureType,
  SimulationGraphSnapshot,
} from "@fluxora/shared-types";
import {
  RULE_ID_CALLS_CIRCUIT_BREAKER,
  RULE_ID_CALLS_SYNC_NO_FALLBACK,
  RULE_ID_EMITS_CONSUMER_AT_RISK,
  RULE_ID_TARGET_FAILURE,
  RULE_ID_WRITES_FAILURE,
} from "@fluxora/shared-types";

import { getPool } from "../pool.ts";
import { loadRootEnvFile } from "../cli/env.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import { createAnalysisRun, createGraphEdge, createGraphNode } from "./graph.ts";
import { EvidenceWriter } from "./evidence-writer.ts";
import { createScenario, createSimulation, listSimulationResults } from "./simulation.ts";
import {
  CrossAnalysisRunBoundaryError,
  executeSimulation,
  runSimulationEngine,
  SimulationConvergenceError,
  SimulationEngineValidationError,
  UnsupportedScenarioFailureTypeError,
} from "./simulation-engine.ts";

loadRootEnvFile();

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;
const RLS_TEST_ROLE = "fluxora_rls_test";

async function ensureRlsTestRole(pool: pg.Pool): Promise<void> {
  await runMigrations(pool);

  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE fluxora_rls_test
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOINHERIT
        NOLOGIN
        NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await pool.query(`GRANT fluxora_rls_test TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO fluxora_rls_test`);
  await pool.query(`
    GRANT USAGE ON TYPE repository_connection_status TO fluxora_rls_test
  `);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_snapshot_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_scenario_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_simulation_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence, pull_requests, pull_request_files, impact_analyses, scenarios, simulations, simulation_results
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

// ===========================================================================
// Helper for Synthetic In-Memory Graph Creation
// ===========================================================================

function makeNode(id: string, name: string, runId: string = "run-1"): GraphNode {
  return {
    id,
    analysisRunId: runId,
    canonicalId: `node:${id}`,
    nodeType: "Service",
    name,
    path: `src/${name.toLowerCase()}.ts`,
    metadata: {},
    confidence: 1.0,
    createdAt: new Date(),
  };
}

function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: GraphEdgeType,
  metadata: Record<string, unknown> = {},
  runId: string = "run-1",
): GraphEdge {
  return {
    id,
    analysisRunId: runId,
    sourceNodeId,
    targetNodeId,
    edgeType,
    canonicalId: `edge:${id}`,
    metadata,
    confidence: 1.0,
    provenance: "static-analysis",
    createdAt: new Date(),
  };
}

// ===========================================================================
// Part 1: Pure Domain Engine Unit & Full-Scenario Tests (Section 27: Tests 1-20)
// ===========================================================================

describe("Step 54: Simulation Engine - Pure Domain Propagation (Tests 1-20)", () => {
  const runId = "00000000-0000-0000-0000-000000000001";

  // -------------------------------------------------------------------------
  // Test 1 — single unavailable target
  // -------------------------------------------------------------------------
  it("Test 1: single unavailable target seeds FAILED and leaves unrelated nodes healthy", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const unrelated = makeNode("node-unrelated", "UnrelatedService", runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, unrelated],
      edges: [],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "failed");
    assert.equal(res.nodeStates.get(unrelated.id), "healthy");

    // Results only contain affected nodes
    assert.equal(res.results.length, 1);
    const rPayment = res.results[0]!;
    assert.equal(rPayment.nodeId, payment.id);
    assert.equal(rPayment.resultingState, "failed");
    assert.equal(rPayment.ruleApplied, RULE_ID_TARGET_FAILURE);
    assert.equal(rPayment.propagationPath.length, 1);
    assert.equal(rPayment.propagationPath[0]!.ruleId, RULE_ID_TARGET_FAILURE);
  });

  // -------------------------------------------------------------------------
  // Test 2 — one-hop synchronous CALLS
  // -------------------------------------------------------------------------
  it("Test 2: one-hop synchronous CALLS degrades caller", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const checkout = makeNode("node-checkout", "CheckoutService", runId);

    // Checkout --CALLS(sync, no fallback)--> Payment
    const edge = makeEdge("edge-checkout-payment", checkout.id, payment.id, "CALLS", {
      sync: true,
      hasFallback: false,
      hasCircuitBreaker: false,
    }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, checkout],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "failed");
    assert.equal(res.nodeStates.get(checkout.id), "degraded");

    const rCheckout = res.results.find((r) => r.nodeId === checkout.id)!;
    assert.ok(rCheckout);
    assert.equal(rCheckout.resultingState, "degraded");
    assert.equal(rCheckout.ruleApplied, RULE_ID_CALLS_SYNC_NO_FALLBACK);
    assert.equal(rCheckout.propagationPath.length, 2);
    assert.equal(rCheckout.propagationPath[0]!.nodeId, payment.id);
    assert.equal(rCheckout.propagationPath[1]!.nodeId, checkout.id);
    assert.equal(rCheckout.propagationPath[1]!.edgeId, edge.id);
  });

  // -------------------------------------------------------------------------
  // Test 3 — two-hop propagation
  // -------------------------------------------------------------------------
  it("Test 3: two-hop propagation propagates impairment through intermediate degraded node", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const checkout = makeNode("node-checkout", "CheckoutService", runId);
    const orders = makeNode("node-orders", "OrdersService", runId);

    // Checkout --CALLS--> Payment
    const edge1 = makeEdge("edge-checkout-payment", checkout.id, payment.id, "CALLS", {
      sync: true,
      hasFallback: false,
    }, runId);
    // Orders --CALLS--> Checkout
    const edge2 = makeEdge("edge-orders-checkout", orders.id, checkout.id, "CALLS", {
      sync: true,
      hasFallback: false,
    }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, checkout, orders],
      edges: [edge1, edge2],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "failed");
    assert.equal(res.nodeStates.get(checkout.id), "degraded");
    assert.equal(res.nodeStates.get(orders.id), "degraded");

    const rOrders = res.results.find((r) => r.nodeId === orders.id)!;
    assert.ok(rOrders);
    assert.equal(rOrders.resultingState, "degraded");
    assert.equal(rOrders.propagationPath.length, 3);
    assert.equal(rOrders.propagationPath[0]!.nodeId, payment.id);
    assert.equal(rOrders.propagationPath[1]!.nodeId, checkout.id);
    assert.equal(rOrders.propagationPath[2]!.nodeId, orders.id);
    assert.equal(rOrders.propagationPath[2]!.edgeId, edge2.id);
  });

  // -------------------------------------------------------------------------
  // Test 4 — circuit breaker
  // -------------------------------------------------------------------------
  it("Test 4: circuit breaker isolates failure with caller DEGRADED and capped=true", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const checkout = makeNode("node-checkout", "CheckoutService", runId);
    const upstream = makeNode("node-upstream", "UpstreamService", runId);

    // Checkout --CALLS(circuit breaker)--> Payment
    const edge1 = makeEdge("edge-checkout-payment", checkout.id, payment.id, "CALLS", {
      sync: true,
      hasCircuitBreaker: true,
      hasFallback: false,
    }, runId);

    // Upstream --CALLS--> Checkout
    const edge2 = makeEdge("edge-upstream-checkout", upstream.id, checkout.id, "CALLS", {
      sync: true,
      hasFallback: false,
    }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, checkout, upstream],
      edges: [edge1, edge2],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "failed");
    assert.equal(res.nodeStates.get(checkout.id), "degraded");
    // Because checkout has capped = true, it isolates failure: upstream is unaffected!
    assert.equal(res.nodeStates.get(upstream.id), "healthy");

    const rCheckout = res.results.find((r) => r.nodeId === checkout.id)!;
    assert.ok(rCheckout);
    assert.equal(rCheckout.ruleApplied, RULE_ID_CALLS_CIRCUIT_BREAKER);
    assert.equal(rCheckout.capped, true);
  });

  // -------------------------------------------------------------------------
  // Test 5 — fallback suppresses propagation
  // -------------------------------------------------------------------------
  it("Test 5: fallback suppresses CALLS propagation", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const checkout = makeNode("node-checkout", "CheckoutService", runId);

    // Checkout --CALLS(fallback present)--> Payment
    const edge = makeEdge("edge-checkout-payment", checkout.id, payment.id, "CALLS", {
      sync: true,
      hasFallback: true,
    }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, checkout],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "failed");
    assert.equal(res.nodeStates.get(checkout.id), "healthy");
    assert.equal(res.results.length, 1);
  });

  // -------------------------------------------------------------------------
  // Test 6 — async call
  // -------------------------------------------------------------------------
  it("Test 6: async CALLS does not propagate impairment", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const notification = makeNode("node-notif", "NotificationService", runId);

    // Notification --CALLS(async)--> Payment
    const edge = makeEdge("edge-notif-payment", notification.id, payment.id, "CALLS", {
      sync: false,
    }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, notification],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "failed");
    assert.equal(res.nodeStates.get(notification.id), "healthy");
  });

  // -------------------------------------------------------------------------
  // Test 7 — database read dependency
  // -------------------------------------------------------------------------
  it("Test 7: database outage places dependent reader at risk (QUERIES_DB)", () => {
    const db = makeNode("node-db", "PrimaryPostgres", runId);
    const reader = makeNode("node-reader", "ReportingService", runId);

    // Reader --QUERIES_DB--> DB
    const edge = makeEdge("edge-reader-db", reader.id, db.id, "QUERIES_DB", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [db, reader],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: db.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(db.id), "failed");
    assert.equal(res.nodeStates.get(reader.id), "at_risk");

    const rReader = res.results.find((r) => r.nodeId === reader.id)!;
    assert.ok(rReader);
    assert.equal(rReader.resultingState, "at_risk");
    assert.equal(rReader.ruleApplied, RULE_ID_WRITES_FAILURE);
  });

  // -------------------------------------------------------------------------
  // Test 8 — dependent write is not propagated by WRITES+failure
  // -------------------------------------------------------------------------
  it("Test 8: dependent write is not propagated by WRITES+failure (Step 53 correction)", () => {
    const db = makeNode("node-db", "PrimaryPostgres", runId);
    const writer = makeNode("node-writer", "AuditLogger", runId);

    // Writer --WRITES--> DB
    const edge = makeEdge("edge-writer-db", writer.id, db.id, "WRITES", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [db, writer],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: db.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(db.id), "failed");
    assert.equal(res.nodeStates.get(writer.id), "healthy");
  });

  // -------------------------------------------------------------------------
  // Test 9 — event consumer
  // -------------------------------------------------------------------------
  it("Test 9: event broker impairment places consumer at risk (CONSUMES_EVENT)", () => {
    const broker = makeNode("node-broker", "KafkaBroker", runId);
    const consumer = makeNode("node-consumer", "EmailWorker", runId);

    // Broker --CONSUMES_EVENT--> Consumer
    const edge = makeEdge("edge-broker-consumer", broker.id, consumer.id, "CONSUMES_EVENT", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [broker, consumer],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: broker.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(broker.id), "failed");
    assert.equal(res.nodeStates.get(consumer.id), "at_risk");

    const rConsumer = res.results.find((r) => r.nodeId === consumer.id)!;
    assert.ok(rConsumer);
    assert.equal(rConsumer.ruleApplied, RULE_ID_EMITS_CONSUMER_AT_RISK);
  });

  // -------------------------------------------------------------------------
  // Test 10 — producer unaffected
  // -------------------------------------------------------------------------
  it("Test 10: producer remains unaffected by event broker failure (EMITS_EVENT)", () => {
    const broker = makeNode("node-broker", "KafkaBroker", runId);
    const producer = makeNode("node-producer", "OrderCreatedProducer", runId);

    // Producer --EMITS_EVENT--> Broker
    const edge = makeEdge("edge-producer-broker", producer.id, broker.id, "EMITS_EVENT", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [broker, producer],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: broker.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(broker.id), "failed");
    assert.equal(res.nodeStates.get(producer.id), "healthy");
  });

  // -------------------------------------------------------------------------
  // Test 11 — latency scenario
  // -------------------------------------------------------------------------
  it("Test 11: latency scenario seeds DEGRADED and propagates qualitatively without numerical modeling", () => {
    const payment = makeNode("node-payment", "PaymentService", runId);
    const checkout = makeNode("node-checkout", "CheckoutService", runId);

    // Checkout --CALLS--> Payment
    const edge = makeEdge("edge-checkout-payment", checkout.id, payment.id, "CALLS", {
      sync: true,
      hasFallback: false,
    }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [payment, checkout],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: payment.id,
        failureType: "latency",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(payment.id), "degraded");
    assert.equal(res.nodeStates.get(checkout.id), "degraded");

    const rPayment = res.results.find((r) => r.nodeId === payment.id)!;
    assert.equal(rPayment.resultingState, "degraded");
    assert.ok(rPayment.assumptions[0]!.includes("latency injection"));

    const rCheckout = res.results.find((r) => r.nodeId === checkout.id)!;
    assert.ok(rCheckout.assumptions.some((a) => a.includes("latency degradation propagates")));
  });

  // -------------------------------------------------------------------------
  // Test 12 — cycle
  // -------------------------------------------------------------------------
  it("Test 12: cyclic dependencies converge deterministically without infinite loop", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const nodeB = makeNode("node-b", "ServiceB", runId);

    // A --CALLS--> B and B --CALLS--> A
    const edgeAB = makeEdge("edge-ab", nodeA.id, nodeB.id, "CALLS", { sync: true, hasFallback: false }, runId);
    const edgeBA = makeEdge("edge-ba", nodeB.id, nodeA.id, "CALLS", { sync: true, hasFallback: false }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA, nodeB],
      edges: [edgeAB, edgeBA],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: nodeA.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(nodeA.id), "failed");
    assert.equal(res.nodeStates.get(nodeB.id), "degraded");
    assert.ok(res.iterations <= 5, "Must converge in very few iterations");
  });

  // -------------------------------------------------------------------------
  // Test 13 — fan-out
  // -------------------------------------------------------------------------
  it("Test 13: fan-out propagates independently to multiple callers", () => {
    const auth = makeNode("node-auth", "AuthService", runId);
    const service1 = makeNode("node-s1", "Service1", runId);
    const service2 = makeNode("node-s2", "Service2", runId);
    const service3 = makeNode("node-s3", "Service3", runId);

    const edge1 = makeEdge("edge-1", service1.id, auth.id, "CALLS", { sync: true, hasFallback: false }, runId);
    const edge2 = makeEdge("edge-2", service2.id, auth.id, "CALLS", { sync: true, hasFallback: false }, runId);
    const edge3 = makeEdge("edge-3", service3.id, auth.id, "CALLS", { sync: true, hasFallback: false }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [auth, service1, service2, service3],
      edges: [edge1, edge2, edge3],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: auth.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(auth.id), "failed");
    assert.equal(res.nodeStates.get(service1.id), "degraded");
    assert.equal(res.nodeStates.get(service2.id), "degraded");
    assert.equal(res.nodeStates.get(service3.id), "degraded");
    assert.equal(res.results.length, 4);
  });

  // -------------------------------------------------------------------------
  // Test 14 — fan-in
  // -------------------------------------------------------------------------
  it("Test 14: fan-in applies state changes monotonically to the most severe state", () => {
    const db = makeNode("node-db", "Database", runId);
    const auth = makeNode("node-auth", "AuthService", runId);
    const api = makeNode("node-api", "GatewayAPI", runId);

    // API --QUERIES_DB--> DB (would propose at_risk)
    const edgeDb = makeEdge("edge-api-db", api.id, db.id, "QUERIES_DB", {}, runId);
    // API --CALLS--> Auth (proposes degraded)
    const edgeAuth = makeEdge("edge-api-auth", api.id, auth.id, "CALLS", { sync: true, hasFallback: false }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [db, auth, api],
      edges: [edgeDb, edgeAuth],
    };

    // First seed db, then evaluate: API should reach degraded when Auth also fails
    const res = runSimulationEngine({
      scenario: {
        targetNodeId: auth.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(auth.id), "failed");
    assert.equal(res.nodeStates.get(api.id), "degraded");
  });

  // -------------------------------------------------------------------------
  // Test 15 — mixed rules
  // -------------------------------------------------------------------------
  it("Test 15: mixed rules graph evaluates only supported rules and ignores irrelevant edges", () => {
    const target = makeNode("node-target", "TargetService", runId);
    const callerCb = makeNode("node-cb", "CallerCB", runId);
    const callerSync = makeNode("node-sync", "CallerSync", runId);
    const reader = makeNode("node-reader", "ReaderService", runId);
    const importer = makeNode("node-importer", "ImporterService", runId);

    const edgeCb = makeEdge("edge-cb", callerCb.id, target.id, "CALLS", { sync: true, hasCircuitBreaker: true }, runId);
    const edgeSync = makeEdge("edge-sync", callerSync.id, target.id, "CALLS", { sync: true, hasFallback: false }, runId);
    const edgeRead = makeEdge("edge-read", reader.id, target.id, "QUERIES_DB", {}, runId);
    const edgeImport = makeEdge("edge-import", importer.id, target.id, "IMPORTS", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [target, callerCb, callerSync, reader, importer],
      edges: [edgeCb, edgeSync, edgeRead, edgeImport],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: target.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(target.id), "failed");
    assert.equal(res.nodeStates.get(callerCb.id), "degraded");
    assert.equal(res.nodeStates.get(callerSync.id), "degraded");
    assert.equal(res.nodeStates.get(reader.id), "at_risk");
    assert.equal(res.nodeStates.get(importer.id), "healthy", "IMPORTS edge must have no simulation effect");
  });

  // -------------------------------------------------------------------------
  // Test 16 — monotonic state
  // -------------------------------------------------------------------------
  it("Test 16: monotonic state invariant - node never reverts to a less severe state", () => {
    const target = makeNode("node-target", "CoreService", runId);
    const client = makeNode("node-client", "ClientService", runId);

    // edge 1: CALLS (proposes degraded)
    const edge1 = makeEdge("edge-calls", client.id, target.id, "CALLS", { sync: true, hasFallback: false }, runId);
    // edge 2: QUERIES_DB (proposes at_risk)
    const edge2 = makeEdge("edge-queries", client.id, target.id, "QUERIES_DB", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [target, client],
      edges: [edge1, edge2],
    };

    const res = runSimulationEngine({
      scenario: {
        targetNodeId: target.id,
        failureType: "unavailable",
      },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    assert.equal(res.nodeStates.get(client.id), "degraded");
  });

  // -------------------------------------------------------------------------
  // Test 17 — deterministic ordering
  // -------------------------------------------------------------------------
  it("Test 17: multiple executions produce strictly identical results, orderings, and paths", () => {
    const node1 = makeNode("node-1", "Service1", runId);
    const node2 = makeNode("node-2", "Service2", runId);
    const node3 = makeNode("node-3", "Service3", runId);

    const edge12 = makeEdge("edge-12", node2.id, node1.id, "CALLS", { sync: true, hasFallback: false }, runId);
    const edge23 = makeEdge("edge-23", node3.id, node2.id, "CALLS", { sync: true, hasFallback: false }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [node3, node1, node2], // intentionally unordered
      edges: [edge23, edge12],
    };

    const res1 = runSimulationEngine({
      scenario: { targetNodeId: node1.id, failureType: "unavailable" },
      graph: snapshot,
    });

    const res2 = runSimulationEngine({
      scenario: { targetNodeId: node1.id, failureType: "unavailable" },
      graph: snapshot,
    });

    assert.deepEqual(res1.results, res2.results);
    assert.equal(res1.iterations, res2.iterations);
    assert.equal(res1.ruleTableVersion, res2.ruleTableVersion);
  });

  // -------------------------------------------------------------------------
  // Test 18 — unknown metadata
  // -------------------------------------------------------------------------
  it("Test 18: conservative Step 53 assumptions for unknown metadata are preserved into engine output", () => {
    const target = makeNode("node-target", "TargetService", runId);
    const caller = makeNode("node-caller", "CallerService", runId);

    // CALLS with empty metadata (all fallback/circuit breaker unknown)
    const edge = makeEdge("edge-call", caller.id, target.id, "CALLS", {}, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [target, caller],
      edges: [edge],
    };

    const res = runSimulationEngine({
      scenario: { targetNodeId: target.id, failureType: "unavailable" },
      graph: snapshot,
    });

    assert.equal(res.converged, true);
    const rCaller = res.results.find((r) => r.nodeId === caller.id)!;
    assert.ok(rCaller);
    assert.ok(rCaller.assumptions.some((a) => a.includes("No fallback handler detected")));
    assert.ok(rCaller.assumptions.some((a) => a.includes("No circuit breaker detected")));
    assert.equal(rCaller.confidence, 0.9);
  });

  // -------------------------------------------------------------------------
  // Test 19 — cross-analysis-run rejection
  // -------------------------------------------------------------------------
  it("Test 19: cross-analysis-run boundary rejection throws error when snapshots mix runs", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const foreignNode = makeNode("node-foreign", "ForeignService", "00000000-0000-0000-0000-000000000099");

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA, foreignNode],
      edges: [],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "unavailable" },
          graph: snapshot,
        }),
      (err: Error) =>
        err instanceof CrossAnalysisRunBoundaryError &&
        err.message.includes("does not match graph snapshot analysisRunId"),
    );
  });

  // -------------------------------------------------------------------------
  // Test 20 — evidence completeness & failure type validation
  // -------------------------------------------------------------------------
  it("Test 20: unsupported scenario failure type throws UnsupportedScenarioFailureTypeError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA],
      edges: [],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "capacity" as unknown as ScenarioFailureType },
          graph: snapshot,
        }),
      (err: Error) =>
        err instanceof UnsupportedScenarioFailureTypeError &&
        err.message.includes("MVP simulation engine only supports"),
    );
  });

  // -------------------------------------------------------------------------
  // Defensive failure tests (Audit Requirement 8)
  // -------------------------------------------------------------------------
  it("Defensive: missing target node throws SimulationEngineValidationError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA],
      edges: [],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: "missing-target-id", failureType: "unavailable" },
          graph: snapshot,
        }),
      (err: Error) =>
        err instanceof SimulationEngineValidationError &&
        err.message.includes('Scenario target node "missing-target-id" not found in graph snapshot.'),
    );
  });

  it("Defensive: edge referencing unknown source node throws SimulationEngineValidationError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const badEdge = makeEdge("edge-bad-src", "unknown-source", nodeA.id, "CALLS", {}, runId);
    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA],
      edges: [badEdge],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "unavailable" },
          graph: snapshot,
        }),
      (err: Error) =>
        err instanceof SimulationEngineValidationError &&
        err.message.includes('references unknown source node "unknown-source"'),
    );
  });

  it("Defensive: edge referencing unknown target node throws SimulationEngineValidationError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const badEdge = makeEdge("edge-bad-tgt", nodeA.id, "unknown-target", "CALLS", {}, runId);
    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA],
      edges: [badEdge],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "unavailable" },
          graph: snapshot,
        }),
      (err: Error) =>
        err instanceof SimulationEngineValidationError &&
        err.message.includes('references unknown target node "unknown-target"'),
    );
  });

  it("Defensive: missing or invalid graph snapshot analysisRunId throws SimulationEngineValidationError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const snapshot = {
      analysisRunId: "",
      nodes: [nodeA],
      edges: [],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "unavailable" },
          graph: snapshot as unknown as SimulationGraphSnapshot,
        }),
      (err: Error) =>
        err instanceof SimulationEngineValidationError &&
        err.message.includes("Graph snapshot must provide a valid analysisRunId string."),
    );
  });

  it("Defensive: edge with incompatible analysisRunId throws CrossAnalysisRunBoundaryError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const nodeB = makeNode("node-b", "ServiceB", runId);
    const foreignEdge = makeEdge(
      "edge-foreign",
      nodeA.id,
      nodeB.id,
      "CALLS",
      {},
      "00000000-0000-0000-0000-000000000099",
    );
    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA, nodeB],
      edges: [foreignEdge],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "unavailable" },
          graph: snapshot,
        }),
      (err: Error) =>
        err instanceof CrossAnalysisRunBoundaryError &&
        err.message.includes("does not match graph snapshot analysisRunId"),
    );
  });

  it("Defensive: convergence safety guard activation throws SimulationConvergenceError", () => {
    const nodeA = makeNode("node-a", "ServiceA", runId);
    const nodeB = makeNode("node-b", "ServiceB", runId);
    const nodeC = makeNode("node-c", "ServiceC", runId);
    const edgeAB = makeEdge("edge-ab", nodeB.id, nodeA.id, "CALLS", { sync: true, hasFallback: false }, runId);
    const edgeBC = makeEdge("edge-bc", nodeC.id, nodeB.id, "CALLS", { sync: true, hasFallback: false }, runId);

    const snapshot: SimulationGraphSnapshot = {
      analysisRunId: runId,
      nodes: [nodeA, nodeB, nodeC],
      edges: [edgeAB, edgeBC],
    };

    assert.throws(
      () =>
        runSimulationEngine({
          scenario: { targetNodeId: nodeA.id, failureType: "unavailable" },
          graph: snapshot,
          options: { maxIterations: 1 },
        }),
      (err: Error) =>
        err instanceof SimulationConvergenceError &&
        err.message.includes("Simulation failed to converge within 1 iterations"),
    );
  });
});

// ===========================================================================
// Part 2: Database Persistence & Evidence Integration Tests (Section 28)
// ===========================================================================

describe.skipIf(!hasDatabase)("Step 54: Simulation Engine - PostgreSQL Persistence & Evidence Integration", () => {
  let pool: pg.Pool;
  const suffix = Math.random().toString(36).substring(2, 8);

  let orgA: { id: string };
  let orgB: { id: string };
  let repoA: { id: string };
  let runA1: { id: string };

  let nodePayment: GraphNode;
  let nodeCheckout: GraphNode;
  let nodeOrders: GraphNode;

  beforeAll(async () => {
    pool = getPool();
    await ensureRlsTestRole(pool);

    // Setup Org A
    orgA = await createOrganization(pool, { name: `sim-eng-org-a-${suffix}` });
    repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 4000}`,
      name: `sim-eng-repo-a-${suffix}`,
      defaultBranch: "main",
    });

    const snapshotA1 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "c".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/sim-eng-a1",
      sha256: "c".repeat(64),
      fileCount: 3,
      sizeBytes: "1024",
    });

    runA1 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA1.id,
      status: "completed",
    });

    // Create 3 GraphNodes with Evidence
    nodePayment = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: `node:payment-${suffix}`,
      nodeType: "Service",
      name: "PaymentService",
      path: "src/payment.ts",
      confidence: 1.0,
      evidence: EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:node:payment`),
        filePath: "src/payment.ts",
        lineStart: 1,
        lineEnd: 50,
        relationshipDescription: "Payment service node",
      }),
    });

    nodeCheckout = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: `node:checkout-${suffix}`,
      nodeType: "Service",
      name: "CheckoutService",
      path: "src/checkout.ts",
      confidence: 1.0,
      evidence: EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:node:checkout`),
        filePath: "src/checkout.ts",
        lineStart: 1,
        lineEnd: 80,
        relationshipDescription: "Checkout service node",
      }),
    });

    nodeOrders = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: `node:orders-${suffix}`,
      nodeType: "Service",
      name: "OrdersService",
      path: "src/orders.ts",
      confidence: 1.0,
      evidence: EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:node:orders`),
        filePath: "src/orders.ts",
        lineStart: 1,
        lineEnd: 60,
        relationshipDescription: "Orders service node",
      }),
    });

    // Create 2 GraphEdges with Evidence
    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      sourceNodeId: nodeCheckout.id,
      targetNodeId: nodePayment.id,
      edgeType: "CALLS",
      canonicalId: `edge:checkout-payment-${suffix}`,
      metadata: { sync: true, hasFallback: false, hasCircuitBreaker: false },
      confidence: 1.0,
      provenance: "static-analysis",
      evidence: EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_edge",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:edge:checkout-payment`),
        filePath: "src/checkout.ts",
        lineStart: 42,
        lineEnd: 45,
        relationshipDescription: "Checkout calls Payment synchronously without fallback",
      }),
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      sourceNodeId: nodeOrders.id,
      targetNodeId: nodeCheckout.id,
      edgeType: "CALLS",
      canonicalId: `edge:orders-checkout-${suffix}`,
      metadata: { sync: true, hasFallback: false, hasCircuitBreaker: false },
      confidence: 1.0,
      provenance: "static-analysis",
      evidence: EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_edge",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:edge:orders-checkout`),
        filePath: "src/orders.ts",
        lineStart: 15,
        lineEnd: 18,
        relationshipDescription: "Orders calls Checkout synchronously without fallback",
      }),
    });

    // Setup Org B for RLS checks
    orgB = await createOrganization(pool, { name: `sim-eng-org-b-${suffix}` });
  });

  it("1. executeSimulation runs scenario, persists SimulationResults and simulation_state Evidence atomically", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Payment Outage Scenario",
      targetNodeId: nodePayment.id,
      failureType: "unavailable",
    });

    const simulation = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
      status: "pending",
    });

    const execRes = await executeSimulation(pool, orgA.id, simulation.id);

    assert.equal(execRes.simulation.status, "completed");
    assert.equal(execRes.engineResult.converged, true);
    assert.equal(execRes.savedResults.length, 3);
    assert.equal(execRes.evidence.length, 3);

    // Verify all 3 results match expected states
    const statesMap = new Map(execRes.savedResults.map((r) => [r.nodeId, r.resultingState]));
    assert.equal(statesMap.get(nodePayment.id), "failed");
    assert.equal(statesMap.get(nodeCheckout.id), "degraded");
    assert.equal(statesMap.get(nodeOrders.id), "degraded");

    // Verify EvidenceWriter evidence records
    for (const ev of execRes.evidence) {
      assert.equal(ev.subjectType, "simulation_state");
      assert.equal(ev.analysisRunId, runA1.id);
      assert.ok(ev.id);
      assert.ok(ev.relationshipDescription.length > 0);
    }
  });

  it("2. executeSimulation is idempotent across reruns without creating duplicate results", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Idempotent Scenario",
      targetNodeId: nodePayment.id,
      failureType: "unavailable",
    });

    const simulation = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
    });

    const run1 = await executeSimulation(pool, orgA.id, simulation.id);
    const run2 = await executeSimulation(pool, orgA.id, simulation.id);

    assert.equal(run1.savedResults.length, run2.savedResults.length);
    const list = await listSimulationResults(pool, orgA.id, simulation.id);
    assert.equal(list.length, 3, "Must not duplicate simulation_results rows");
  });

  it("3. executeSimulation updates status to failed and rolls back on invalid failure type", async () => {
    // Force direct insertion of scenario with unsupported type to test engine rejection & rollback
    const badScenarioRes = await pool.query<{ id: string }>(
      `INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
       VALUES ($1::uuid, $2::uuid, 'Bad Type Scenario', $3::uuid, 'capacity')
       RETURNING id`,
      [orgA.id, repoA.id, nodePayment.id],
    );
    const badScenarioId = badScenarioRes.rows[0]!.id;

    const simRes = await pool.query<{ id: string }>(
      `INSERT INTO simulations (scenario_id, analysis_run_id, status)
       VALUES ($1::uuid, $2::uuid, 'pending')
       RETURNING id`,
      [badScenarioId, runA1.id],
    );
    const badSimId = simRes.rows[0]!.id;

    await assert.rejects(
      () => executeSimulation(pool, orgA.id, badSimId),
      (err: Error) => err instanceof UnsupportedScenarioFailureTypeError,
    );

    // Verify simulation status transitioned to 'failed'
    const checkSim = await pool.query<{ status: string }>(
      `SELECT status FROM simulations WHERE id = $1::uuid`,
      [badSimId],
    );
    assert.equal(checkSim.rows[0]?.status, "failed");

    // Verify no unevidenced simulation_results were committed
    const results = await listSimulationResults(pool, orgA.id, badSimId);
    assert.equal(results.length, 0);
  });

  it("4. Tenant isolation: Org B cannot execute or access Org A simulation", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Org A Protected Scenario",
      targetNodeId: nodePayment.id,
      failureType: "unavailable",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
    });

    // Org B attempt to execute Org A simulation
    await assert.rejects(
      () => executeSimulation(pool, orgB.id, sim.id),
      (err: Error) => err.message.includes("Simulation not found"),
    );
  });

  it("5. executeSimulation rolls back results and marks simulation as failed when evidence persistence fails", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Evidence Persistence Failure Scenario",
      targetNodeId: nodePayment.id,
      failureType: "unavailable",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
    });

    const originalWriteEvidenceBatchTx = EvidenceWriter.writeEvidenceBatchTx;
    EvidenceWriter.writeEvidenceBatchTx = async () => {
      throw new Error("Simulated evidence database persistence error");
    };

    try {
      await assert.rejects(
        () => executeSimulation(pool, orgA.id, sim.id),
        (err: Error) => err.message.includes("Simulated evidence database persistence error"),
      );

      // Verify simulation status transitioned to 'failed'
      const checkSim = await pool.query<{ status: string }>(
        `SELECT status FROM simulations WHERE id = $1::uuid`,
        [sim.id],
      );
      assert.equal(checkSim.rows[0]?.status, "failed");

      // Verify atomic rollback: no simulation_results were committed
      const results = await listSimulationResults(pool, orgA.id, sim.id);
      assert.equal(results.length, 0, "Simulation results must be rolled back on evidence failure");
    } finally {
      EvidenceWriter.writeEvidenceBatchTx = originalWriteEvidenceBatchTx;
    }
  });
});
