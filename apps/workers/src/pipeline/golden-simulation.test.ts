import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";

import type {
  GraphProjectionResult,
  SimulationEdge,
  SimulationGraphSnapshot,
  SimulationNode,
} from "@fluxora/shared-types";
import {
  DEFAULT_SIMULATION_RULE_TABLE_VERSION,
  RULE_ID_CALLS_SYNC_NO_FALLBACK,
  RULE_ID_TARGET_FAILURE,
  SimulationResultStates,
} from "@fluxora/shared-types";
import { runSimulationEngine } from "@fluxora/db";

import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_PINNED_SHA,
  GOLDEN_SIMULATION_FIXTURE_ID,
  loadGoldenFixtureFileMap,
  loadGoldenFixtureManifest,
  loadGoldenSimulationExpectationManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";
import { runPhase3Pipeline } from "./phase3.ts";
import { buildGraphProjection } from "../builder/graph-builder.ts";

describe("Step 58: Golden Fixture Simulation Validation", () => {
  const organizationId = "00000000-0000-0000-0000-000000000001";
  const analysisRunId = "00000000-0000-0000-0000-000000000002";

  let simManifest: ReturnType<typeof loadGoldenSimulationExpectationManifest>;
  let projection: GraphProjectionResult;
  let simulationNodes: SimulationNode[];
  let simulationEdges: SimulationEdge[];
  let targetNode: SimulationNode;
  let callerNode: SimulationNode;
  let negativeControlNode: SimulationNode;
  let testEdge: SimulationEdge;

  beforeAll(async () => {
    // 1. Load manifests and verify fixture identities
    const fixtureManifest = loadGoldenFixtureManifest();
    assert.equal(fixtureManifest.fixtureId, GOLDEN_FIXTURE_ID);
    assert.equal(fixtureManifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);

    simManifest = loadGoldenSimulationExpectationManifest();
    assert.equal(simManifest.fixtureId, GOLDEN_SIMULATION_FIXTURE_ID);
    assert.equal(simManifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);

    // 2. Load golden fixture source files
    const fileMap = loadGoldenFixtureFileMap();
    assert.ok(fileMap.size > 100, "Golden fixture snapshot must have >100 files");

    // 3. Execute full Phase 3 extraction pipeline
    const pipelineResult = await runPhase3Pipeline({ files: fileMap });
    assert.ok(pipelineResult.normalized.symbols.length > 0);
    assert.ok(pipelineResult.normalized.moduleEdges.length > 0);
    assert.ok(pipelineResult.normalized.routes.length > 0);

    // 4. Build deterministic graph projection
    projection = buildGraphProjection({
      organizationId,
      analysisRunId,
      normalizedResult: pipelineResult.normalized,
    });

    simulationNodes = projection.nodes.map((n) => ({
      id: n.id!,
      canonicalId: n.canonicalId,
      nodeType: n.nodeType,
      name: n.name,
      path: n.path,
      metadata: n.metadata,
      confidence: n.confidence,
      analysisRunId: n.analysisRunId,
    }));

    simulationEdges = projection.edges.map((e) => ({
      id: e.id!,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      edgeType: e.edgeType,
      canonicalId: e.canonicalId,
      metadata: e.metadata,
      confidence: e.confidence,
      provenance: e.provenance,
      analysisRunId: e.analysisRunId,
    }));

    const target = simulationNodes.find(
      (n) => n.canonicalId === simManifest.scenario.targetCanonicalId,
    );
    assert.ok(
      target,
      `Target node ${simManifest.scenario.targetCanonicalId} must exist in projection`,
    );
    targetNode = target;

    const caller = simulationNodes.find(
      (n) =>
        n.canonicalId ===
        simManifest.manuallyVerifiedCallRelationship.callerCanonicalId,
    );
    assert.ok(
      caller,
      `Caller node ${simManifest.manuallyVerifiedCallRelationship.callerCanonicalId} must exist in projection`,
    );
    callerNode = caller;

    const negControl = simulationNodes.find(
      (n) => n.canonicalId === "mod:components/site-footer.tsx",
    );
    assert.ok(
      negControl,
      "Negative control node mod:components/site-footer.tsx must exist in projection",
    );
    negativeControlNode = negControl;

    // Construct the explicitly test-only CALLS edge from manifest
    testEdge = {
      id: simManifest.manuallyVerifiedCallRelationship.edgeId,
      analysisRunId,
      sourceNodeId: callerNode.id,
      targetNodeId: targetNode.id,
      edgeType: simManifest.manuallyVerifiedCallRelationship.edgeType,
      canonicalId: `test-call:${callerNode.canonicalId}->${targetNode.canonicalId}`,
      metadata: simManifest.manuallyVerifiedCallRelationship.metadata,
      confidence: 1.0,
      provenance: simManifest.manuallyVerifiedCallRelationship.provenance,
    };
  });

  // =========================================================================
  // Test A — Production graph projection integrity
  // =========================================================================
  it("Test A: Production graph projection integrity — verifies baseline nodes, edges, and absence of fabricated CALLS", () => {
    // Assert 490 canonical nodes
    assert.equal(
      projection.nodes.length,
      490,
      "Taxonomy must project exactly 490 canonical nodes",
    );
    const symbolNodes = projection.nodes.filter((n) => n.nodeType === "symbol");
    const moduleNodes = projection.nodes.filter((n) => n.nodeType === "module");
    const routeNodes = projection.nodes.filter((n) => n.nodeType === "api");
    assert.equal(symbolNodes.length, 367, "Expected 367 symbol nodes");
    assert.equal(moduleNodes.length, 118, "Expected 118 module nodes");
    assert.equal(routeNodes.length, 5, "Expected 5 API route nodes");

    // Assert 888 canonical edges
    assert.equal(
      projection.edges.length,
      888,
      "Taxonomy must project exactly 888 canonical edges",
    );
    const importEdges = projection.edges.filter((e) => e.edgeType === "IMPORTS");
    const routeEdges = projection.edges.filter((e) => e.edgeType === "EXPOSES_ROUTE");
    const resolveEdges = projection.edges.filter((e) => e.edgeType === "RESOLVES_TO");
    assert.equal(importEdges.length, 511, "Expected 511 IMPORTS edges");
    assert.equal(routeEdges.length, 5, "Expected 5 EXPOSES_ROUTE edges");
    assert.equal(resolveEdges.length, 372, "Expected 372 RESOLVES_TO edges");

    // Crucial check: zero CALLS edges exist in production projection
    const callsEdges = projection.edges.filter((e) => e.edgeType === "CALLS");
    assert.equal(
      callsEdges.length,
      0,
      "Production graph projection must NOT contain any CALLS edges",
    );

    // Existing relationship between caller and target in production is IMPORTS
    const productionImportEdge = projection.edges.find(
      (e) =>
        e.sourceNodeId === callerNode.id &&
        e.targetNodeId === targetNode.id &&
        e.edgeType === "IMPORTS",
    );
    assert.ok(
      productionImportEdge,
      "Production graph must have IMPORTS edge from caller to target module",
    );

    // Verify source code call-site in pinned fixture
    const callerSource = readGoldenFixtureFileText(
      simManifest.manuallyVerifiedCallRelationship.sourceFile,
    );
    const callerLines = callerSource.split("\n");
    const verifiedLine =
      callerLines[
        simManifest.manuallyVerifiedCallRelationship.sourceLine - 1
      ]!.trim();
    assert.equal(
      verifiedLine,
      simManifest.manuallyVerifiedCallRelationship.sourceSnippet,
    );
  });

  // =========================================================================
  // Test B — IMPORTS negative control
  // =========================================================================
  it("Test B: IMPORTS negative control — proves existing IMPORTS relationship does NOT propagate failure", () => {
    const pureSnapshot: SimulationGraphSnapshot = {
      analysisRunId,
      nodes: simulationNodes,
      edges: simulationEdges, // Untouched production edges
    };

    const result = runSimulationEngine({
      scenario: {
        targetNodeId: targetNode.id,
        failureType: simManifest.scenario.failureType,
      },
      graph: pureSnapshot,
    });

    assert.equal(result.converged, true);
    assert.equal(result.nodeStates.get(targetNode.id), "failed");

    // CRITICAL: The caller connected via IMPORTS remains healthy!
    assert.equal(
      result.nodeStates.get(callerNode.id),
      "healthy",
      "IMPORTS edge must NOT be interpreted as CALLS; caller must remain healthy",
    );

    // Unrelated negative control remains healthy
    assert.equal(result.nodeStates.get(negativeControlNode.id), "healthy");

    // Exactly 1 affected node in results (the seed target)
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.nodeId, targetNode.id);
    assert.equal(result.results[0]!.resultingState, "failed");
    assert.equal(result.results[0]!.ruleApplied, RULE_ID_TARGET_FAILURE);
  });

  // =========================================================================
  // Test C — Hand-verified simulation relationship
  // =========================================================================
  it("Test C: Hand-verified simulation relationship — propagates failure across explicit test CALLS edge", () => {
    // Augment snapshot with the explicitly test-only CALLS edge without mutating projection
    const augmentedSnapshot: SimulationGraphSnapshot = {
      analysisRunId,
      nodes: simulationNodes,
      edges: [...simulationEdges, testEdge],
    };

    // Ensure production projection remains unmutated
    assert.equal(projection.edges.length, 888);

    const result = runSimulationEngine({
      scenario: {
        targetNodeId: targetNode.id,
        failureType: simManifest.scenario.failureType,
      },
      graph: augmentedSnapshot,
    });

    assert.equal(result.converged, true);
    assert.equal(result.ruleTableVersion, DEFAULT_SIMULATION_RULE_TABLE_VERSION);

    // Assert exact logical results: exactly 2 affected nodes
    assert.equal(
      result.results.length,
      2,
      "Expected exactly 2 affected nodes: target (failed) and caller (degraded)",
    );

    // 1. Subscription helper becomes failed
    const targetResult = result.results.find((r) => r.nodeId === targetNode.id);
    assert.ok(targetResult, "Target node must be in simulation results");
    assert.equal(targetResult.resultingState, "failed");
    assert.equal(targetResult.ruleApplied, RULE_ID_TARGET_FAILURE);
    assert.equal(targetResult.confidence, 1.0);
    assert.equal(targetResult.capped, false);
    assert.deepEqual(targetResult.assumptions, [
      "Scenario target node directly seeded as failed (unavailable)",
    ]);

    // 2. API route caller becomes degraded
    const callerResult = result.results.find((r) => r.nodeId === callerNode.id);
    assert.ok(callerResult, "Caller node must be in simulation results");
    assert.equal(callerResult.resultingState, "degraded");
    assert.equal(callerResult.ruleApplied, RULE_ID_CALLS_SYNC_NO_FALLBACK);
    assert.equal(callerResult.confidence, 0.9);
    assert.equal(callerResult.capped, false);

    // 3. Call-site causal step references exact test-only edge ID
    assert.equal(callerResult.propagationPath.length, 2);
    const [seedStep, propStep] = callerResult.propagationPath;
    assert.ok(seedStep && propStep);

    // 8. Seed step has edgeId: null
    assert.equal(seedStep.nodeId, targetNode.id);
    assert.equal(seedStep.edgeId, null);
    assert.equal(seedStep.ruleId, RULE_ID_TARGET_FAILURE);
    assert.equal(seedStep.ruleVersion, DEFAULT_SIMULATION_RULE_TABLE_VERSION);
    assert.equal(seedStep.previousState, "healthy");
    assert.equal(seedStep.resultingState, "failed");

    // 4. Propagation step uses CALLS+sync+no_fallback & 5. Rule version
    assert.equal(propStep.nodeId, callerNode.id);
    assert.equal(propStep.edgeId, testEdge.id);
    assert.equal(propStep.ruleId, RULE_ID_CALLS_SYNC_NO_FALLBACK);
    assert.equal(propStep.ruleVersion, DEFAULT_SIMULATION_RULE_TABLE_VERSION);
    assert.equal(propStep.previousState, "healthy");
    assert.equal(propStep.resultingState, "degraded");

    // 6. Confidence matches verified rule output (0.9)
    assert.equal(propStep.confidence, 0.9);

    // 7. Assumptions match actual rule output
    const expectedDescriptor = `${callerNode.name}->${targetNode.name}`;
    assert.deepEqual(propStep.assumptions, [
      `No circuit breaker detected on ${expectedDescriptor} call`,
      `No fallback handler detected on ${expectedDescriptor} call`,
    ]);
    assert.deepEqual(callerResult.assumptions, [
      "Scenario target node directly seeded as failed (unavailable)",
      `No circuit breaker detected on ${expectedDescriptor} call`,
      `No fallback handler detected on ${expectedDescriptor} call`,
    ]);

    // 9. No phantom edge is introduced: only testEdge is cited
    assert.equal(propStep.edgeId, testEdge.id);

    // 10. Negative-control site-footer module remains healthy and is not emitted
    assert.equal(result.nodeStates.get(negativeControlNode.id), "healthy");
    assert.equal(
      result.results.find((r) => r.nodeId === negativeControlNode.id),
      undefined,
      "Negative control node must not appear in simulation results",
    );
  });

  // =========================================================================
  // Test D — Determinism
  // =========================================================================
  it("Test D: Determinism — repeated executions produce identical states, rules, causal paths, and assumptions", () => {
    const augmentedSnapshot: SimulationGraphSnapshot = {
      analysisRunId,
      nodes: simulationNodes,
      edges: [...simulationEdges, testEdge],
    };

    const run1 = runSimulationEngine({
      scenario: {
        targetNodeId: targetNode.id,
        failureType: simManifest.scenario.failureType,
      },
      graph: augmentedSnapshot,
    });

    const run2 = runSimulationEngine({
      scenario: {
        targetNodeId: targetNode.id,
        failureType: simManifest.scenario.failureType,
      },
      graph: augmentedSnapshot,
    });

    const run3 = runSimulationEngine({
      scenario: {
        targetNodeId: targetNode.id,
        failureType: simManifest.scenario.failureType,
      },
      graph: augmentedSnapshot,
    });

    // Convergence & iterations
    assert.equal(run1.converged, run2.converged);
    assert.equal(run2.converged, run3.converged);
    assert.equal(run1.iterations, run2.iterations);
    assert.equal(run2.iterations, run3.iterations);
    assert.equal(run1.ruleTableVersion, run2.ruleTableVersion);

    // Node states map
    assert.equal(run1.nodeStates.size, run2.nodeStates.size);
    for (const [nodeId, state] of run1.nodeStates) {
      assert.equal(run2.nodeStates.get(nodeId), state);
      assert.equal(run3.nodeStates.get(nodeId), state);
    }

    // Results array comparison
    assert.equal(run1.results.length, run2.results.length);
    assert.equal(run2.results.length, run3.results.length);

    for (let i = 0; i < run1.results.length; i++) {
      const r1 = run1.results[i]!;
      const r2 = run2.results[i]!;
      const r3 = run3.results[i]!;

      assert.equal(r1.nodeId, r2.nodeId);
      assert.equal(r2.nodeId, r3.nodeId);
      assert.equal(r1.resultingState, r2.resultingState);
      assert.equal(r1.ruleApplied, r2.ruleApplied);
      assert.equal(r1.confidence, r2.confidence);
      assert.equal(r1.capped, r2.capped);
      assert.deepEqual(r1.assumptions, r2.assumptions);
      assert.deepEqual(r2.assumptions, r3.assumptions);
      assert.deepEqual(r1.propagationPath, r2.propagationPath);
      assert.deepEqual(r2.propagationPath, r3.propagationPath);
    }
  });

  // =========================================================================
  // Test E — Causal evidence integrity
  // =========================================================================
  it("Test E: Causal evidence integrity — verifies every propagated step references valid edges, valid rules, and valid state transitions", () => {
    const augmentedSnapshot: SimulationGraphSnapshot = {
      analysisRunId,
      nodes: simulationNodes,
      edges: [...simulationEdges, testEdge],
    };

    const edgeMap = new Map<string, SimulationEdge>();
    for (const edge of augmentedSnapshot.edges) {
      edgeMap.set(edge.id, edge);
    }

    const nodeMap = new Map<string, SimulationNode>();
    for (const node of augmentedSnapshot.nodes) {
      nodeMap.set(node.id, node);
    }

    const result = runSimulationEngine({
      scenario: {
        targetNodeId: targetNode.id,
        failureType: simManifest.scenario.failureType,
      },
      graph: augmentedSnapshot,
    });

    for (const nodeResult of result.results) {
      assert.ok(SimulationResultStates.includes(nodeResult.resultingState));
      assert.ok(nodeResult.confidence >= 0 && nodeResult.confidence <= 1.0);
      assert.ok(nodeResult.propagationPath.length >= 1);

      // Verify path starts with seed step
      const firstStep = nodeResult.propagationPath[0]!;
      assert.equal(firstStep.nodeId, targetNode.id);
      assert.equal(firstStep.edgeId, null);
      assert.equal(firstStep.ruleId, RULE_ID_TARGET_FAILURE);
      assert.equal(firstStep.previousState, "healthy");
      assert.equal(firstStep.resultingState, "failed");

      // Verify subsequent propagation steps
      for (let s = 1; s < nodeResult.propagationPath.length; s++) {
        const step = nodeResult.propagationPath[s]!;
        assert.ok(step.edgeId, "Non-seed causal step must reference an edge ID");

        // Edge must exist in the snapshot
        const stepEdgeId = step.edgeId!;
        const edge = edgeMap.get(stepEdgeId);
        assert.ok(edge, `Referenced edge ${stepEdgeId} must exist in snapshot`);

        // Edge must connect valid nodes
        const srcNode = nodeMap.get(edge.sourceNodeId);
        const tgtNode = nodeMap.get(edge.targetNodeId);
        assert.ok(srcNode && tgtNode);

        // Target of causal transition is the affected node
        assert.equal(step.nodeId, edge.sourceNodeId);
        assert.equal(srcNode.id, callerNode.id);
        assert.equal(tgtNode.id, targetNode.id);

        // Valid canonical rule & states
        assert.equal(step.ruleId, RULE_ID_CALLS_SYNC_NO_FALLBACK);
        assert.equal(step.ruleVersion, DEFAULT_SIMULATION_RULE_TABLE_VERSION);
        assert.ok(SimulationResultStates.includes(step.previousState));
        assert.ok(SimulationResultStates.includes(step.resultingState));
        assert.ok(step.confidence >= 0 && step.confidence <= 1.0);
        assert.ok(step.assumptions.length > 0);
      }
    }
  });
});
