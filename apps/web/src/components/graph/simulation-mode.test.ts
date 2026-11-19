import { test, describe } from "vitest";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SimulationCausalStep,
  SimulationResponse,
  SimulationResultResponse,
  SimulationResultState,
} from "@fluxora/shared-types";
import {
  buildExplorerSimulationUrl,
  CANONICAL_SIMULATION_STATES,
  computeSimulationSliceMetrics,
  DEFAULT_SIMULATION_MODE_STATE,
  extractSimulationCausalSteps,
  isCanonicalSimulationState,
  normalizeSimulationResponse,
  type NormalizedSimulationModeState,
} from "./simulation-mode-data.ts";
import { computeNodeVisualStyles } from "./node-styles.ts";
import { SimulationModeBar } from "./SimulationModeBar.tsx";
import { NodeInspectorPanel } from "./NodeInspectorPanel.tsx";
import { NodeRenderer } from "./NodeRenderer.tsx";
import { ReactFlowProvider } from "@xyflow/react";

const SIM_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "22222222-3333-4444-8555-666666666666";
const REPO_ID = "33333333-4444-4555-8666-777777777777";

const NODE_FAILED = "aaaa0001-0000-0000-0000-000000000001";
const NODE_DEGRADED = "aaaa0002-0000-0000-0000-000000000002";
const NODE_AT_RISK = "aaaa0003-0000-0000-0000-000000000003";
const NODE_HEALTHY = "aaaa0004-0000-0000-0000-000000000004";
const NODE_UNREACHED = "aaaa0005-0000-0000-0000-000000000005";

const EDGE_CAUSAL_1 = "edge-causal-001";
const EDGE_CAUSAL_2 = "edge-causal-002";

function createMockResult(
  nodeId: string,
  state: SimulationResultState,
  options: {
    rule?: string;
    confidence?: number;
    assumptions?: string[];
    steps?: (SimulationCausalStep | string)[];
  } = {},
): SimulationResultResponse {
  return {
    id: `res-${nodeId.slice(0, 8)}`,
    simulation_id: SIM_ID,
    node_id: nodeId,
    resulting_state: state,
    state,
    rule_applied: options.rule ?? "CALLS_SYNC_NO_FALLBACK",
    confidence: options.confidence ?? 0.9,
    assumptions: options.assumptions ?? ["No fallback detected on synchronous call"],
    created_at: "2026-11-18T10:00:00.000Z",
    propagation_path: options.steps ?? [
      {
        nodeId,
        edgeId: EDGE_CAUSAL_1,
        ruleId: options.rule ?? "CALLS_SYNC_NO_FALLBACK",
        ruleVersion: "1.0.0",
        previousState: "healthy",
        resultingState: state,
        assumptions: options.assumptions ?? ["No fallback detected"],
        confidence: options.confidence ?? 0.9,
      },
    ],
  };
}

describe("Simulation Mode Data Normalization", () => {
  test("canonical states verification and type guard", () => {
    assert.equal(CANONICAL_SIMULATION_STATES.length, 4);
    assert.ok(isCanonicalSimulationState("failed"));
    assert.ok(isCanonicalSimulationState("degraded"));
    assert.ok(isCanonicalSimulationState("at_risk"));
    assert.ok(isCanonicalSimulationState("healthy"));

    // Scenario failure types are NOT simulation result states
    assert.equal(isCanonicalSimulationState("unavailable"), false);
    assert.equal(isCanonicalSimulationState("latency"), false);
    assert.equal(isCanonicalSimulationState("unknown"), false);
  });

  test("normalizes empty simulation or null responses cleanly", () => {
    const idle = normalizeSimulationResponse(null, null);
    assert.equal(idle.status, "idle");
    assert.equal(idle.totalResultsCount, 0);

    const empty = normalizeSimulationResponse(
      {
        id: SIM_ID,
        scenario_id: "scen-1",
        analysis_run_id: RUN_ID,
        status: "completed",
        created_at: "2026-11-18T10:00:00Z",
      },
      {
        simulation_id: SIM_ID,
        results: [],
        total: 0,
      },
    );
    assert.equal(empty.status, "empty");
    assert.equal(empty.totalResultsCount, 0);
  });

  test("correctly maps all four canonical states from API results", () => {
    const results: SimulationResultResponse[] = [
      createMockResult(NODE_FAILED, "failed"),
      createMockResult(NODE_DEGRADED, "degraded"),
      createMockResult(NODE_AT_RISK, "at_risk"),
      createMockResult(NODE_HEALTHY, "healthy"),
    ];

    const normalized = normalizeSimulationResponse(
      {
        id: SIM_ID,
        scenario_id: "scen-1",
        analysis_run_id: RUN_ID,
        status: "completed",
        created_at: "2026-11-18T10:00:00Z",
      },
      {
        simulation_id: SIM_ID,
        results,
        total: 4,
      },
    );

    assert.equal(normalized.status, "ready");
    assert.equal(normalized.totalResultsCount, 4);
    assert.equal(normalized.failedCount, 1);
    assert.equal(normalized.degradedCount, 1);
    assert.equal(normalized.atRiskCount, 1);
    assert.equal(normalized.healthyCount, 1);

    assert.equal(normalized.resultingStateByNodeId.get(NODE_FAILED), "failed");
    assert.equal(normalized.resultingStateByNodeId.get(NODE_DEGRADED), "degraded");
    assert.equal(normalized.resultingStateByNodeId.get(NODE_AT_RISK), "at_risk");
    assert.equal(normalized.resultingStateByNodeId.get(NODE_HEALTHY), "healthy");
    // Absent node must NOT be mapped to healthy
    assert.equal(normalized.resultingStateByNodeId.get(NODE_UNREACHED), undefined);
  });

  test("handles capped circuit-breaker propagation metadata", () => {
    const cappedResult: SimulationResultResponse = {
      ...createMockResult(NODE_DEGRADED, "degraded"),
      propagation_path: [
        {
          nodeId: NODE_DEGRADED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_CIRCUIT_BREAKER",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: ["Circuit breaker isolated further propagation"],
          confidence: 0.95,
          capped: true,
        },
      ],
    };

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [cappedResult],
      total: 1,
    });

    assert.equal(normalized.cappedCount, 1);
    assert.equal(normalized.hasCappedByNodeId.get(NODE_DEGRADED), true);
  });

  test("extracts real causal edge IDs without synthesizing edges for seed steps", () => {
    const seedResult: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: null, // Seed failure has no edge ID
          ruleId: "target_failure",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: ["Initial failure seed"],
          confidence: 1.0,
        },
        {
          nodeId: NODE_DEGRADED,
          edgeId: EDGE_CAUSAL_2,
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: [],
          confidence: 0.9,
        },
      ],
    };

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [seedResult],
      total: 1,
    });

    // Only actual edge IDs are included
    assert.equal(normalized.causalEdgeIds.size, 1);
    assert.ok(normalized.causalEdgeIds.has(EDGE_CAUSAL_2));
    assert.ok(!normalized.causalEdgeIds.has(""));
    assert.ok(!normalized.causalEdgeIds.has("null"));
  });

  test("legacy string entries do not create fabricated state transitions", () => {
    const resultWithStringPath: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: ["target_failure", "downstream_hop"],
    };

    const steps = extractSimulationCausalSteps(resultWithStringPath);
    // Legacy string entries do not contain structured transitions and must not fabricate "healthy → resultingState"
    assert.equal(steps.length, 0);
  });

  test("handles duplicate node results deterministically by preserving higher severity", () => {
    const duplicateResults: SimulationResultResponse[] = [
      createMockResult(NODE_FAILED, "at_risk"),
      createMockResult(NODE_FAILED, "failed"), // higher severity
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: duplicateResults,
      total: 2,
    });

    assert.equal(normalized.resultsByNodeId.size, 1);
    assert.equal(normalized.resultingStateByNodeId.get(NODE_FAILED), "failed");
    assert.equal(normalized.failedCount, 1);
    assert.equal(normalized.atRiskCount, 0);
  });

  test("duplicate resolution derives causalEdgeIds and ruleTableVersion exclusively from final accepted result", () => {
    // 1. First result for a node has state at_risk and causal edge edge-old, ruleVersion 0.9.0-old
    const result1: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "at_risk"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: "edge-old",
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "0.9.0-old",
          previousState: "healthy",
          resultingState: "at_risk",
          assumptions: ["Old assumption"],
          confidence: 0.8,
        },
      ],
    };

    // 2. Second result for the same node has state failed and causal edge edge-final, ruleVersion 1.0.0-final
    const result2: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: "edge-final",
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.0.0-final",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: ["Final assumption"],
          confidence: 0.95,
        },
      ],
    };

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [result1, result2],
      total: 2,
    });

    // 3. Final normalized state must be failed
    assert.equal(normalized.resultingStateByNodeId.get(NODE_FAILED), "failed");
    assert.equal(normalized.failedCount, 1);
    assert.equal(normalized.atRiskCount, 0);

    // 4. Final causal edge set must contain edge-final
    assert.ok(normalized.causalEdgeIds.has("edge-final"));

    // 5. Final causal edge set must not contain edge-old
    assert.ok(!normalized.causalEdgeIds.has("edge-old"));
    assert.equal(normalized.causalEdgeIds.size, 1);

    // Rule-table metadata must be derived from accepted result, not discarded result
    assert.equal(normalized.ruleTableVersion, "1.0.0-final");
  });

  test("handles failed simulation status cleanly as error", () => {
    const failedSim: SimulationResponse = {
      id: SIM_ID,
      scenario_id: "scen-1",
      analysis_run_id: RUN_ID,
      status: "failed",
      created_at: "2026-11-18T10:00:00Z",
    };

    const normalized = normalizeSimulationResponse(failedSim, null);
    assert.equal(normalized.status, "error");
    assert.equal(normalized.executionStatus, "failed");
    assert.ok(normalized.errorMessage?.includes("failed during execution"));
  });

  test("computeSimulationSliceMetrics distinguishes visible LOD nodes from total results", () => {
    const results: SimulationResultResponse[] = [
      createMockResult(NODE_FAILED, "failed"),
      createMockResult(NODE_DEGRADED, "degraded"),
      createMockResult(NODE_AT_RISK, "at_risk"),
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results,
      total: 3,
    });

    // Only NODE_FAILED and NODE_DEGRADED are visible in the current graph slice
    const visibleNodes = [
      { id: NODE_FAILED, name: "Node 1", confidence: 1.0 },
      { id: NODE_DEGRADED, name: "Node 2", confidence: 1.0 },
    ];

    const slice = computeSimulationSliceMetrics(normalized, visibleNodes);
    assert.equal(slice.totalResultNodes, 3);
    assert.equal(slice.visibleResultNodes, 2);
    assert.equal(slice.hiddenResultNodes, 1);
    assert.equal(slice.visibleByState.failed, 1);
    assert.equal(slice.visibleByState.degraded, 1);
    assert.equal(slice.visibleByState.at_risk, 0);
  });

  test("buildExplorerSimulationUrl validates all identifiers and constructs valid deep-link", () => {
    const validUrl = buildExplorerSimulationUrl({
      repositoryId: REPO_ID,
      analysisRunId: RUN_ID,
      startNodeId: NODE_FAILED,
      simulationId: SIM_ID,
      selectedNodeId: NODE_DEGRADED,
    });

    assert.ok(validUrl !== null);
    assert.ok(validUrl.includes(`/repositories/${REPO_ID}/explorer`));
    assert.ok(validUrl.includes(`analysis_run_id=${RUN_ID}`));
    assert.ok(validUrl.includes(`start_node_id=${NODE_FAILED}`));
    assert.ok(validUrl.includes(`simulation_id=${SIM_ID}`));
    assert.ok(validUrl.includes(`node_id=${NODE_DEGRADED}`));

    // Rejects missing/malformed UUIDs
    const invalidUrl = buildExplorerSimulationUrl({
      repositoryId: "invalid-uuid",
      analysisRunId: RUN_ID,
      startNodeId: NODE_FAILED,
      simulationId: SIM_ID,
    });
    assert.equal(invalidUrl, null);
  });
});

describe("Simulation Node Styles and Visual Distinctions", () => {
  test("visually distinguishes all four canonical simulation states", () => {
    const failedStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: "failed",
    });
    assert.ok(failedStyles.border.includes("#dc2626"));
    assert.equal(failedStyles.opacity, 1.0);

    const degradedStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: "degraded",
    });
    assert.ok(degradedStyles.border.includes("#d97706"));

    const atRiskStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: "at_risk",
    });
    assert.ok(atRiskStyles.border.includes("#eab308"));

    const healthyStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: "healthy",
    });
    assert.ok(healthyStyles.border.includes("#059669"));

    // Node absent from simulation results must retain normal appearance (never fabricated healthy or faded)
    const unreachedStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: undefined,
    });
    assert.equal(unreachedStyles.opacity, 1.0);
    assert.equal(unreachedStyles.filter, undefined);
    assert.ok(!unreachedStyles.border.includes("#059669")); // Not green/healthy
    assert.ok(!unreachedStyles.border.includes("#eab308")); // Not yellow/at_risk
  });

  test("selected node styling retains absolute priority over simulation overlay", () => {
    const selectedFailedStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: true,
      simulationModeActive: true,
      simulationState: "failed",
    });
    // Selection blue #2563eb wins
    assert.ok(selectedFailedStyles.border.includes("#2563eb"));
    assert.ok(selectedFailedStyles.boxShadow.includes("37, 99, 235"));
  });
});

describe("NodeRenderer in Simulation Mode", () => {
  test("renders simulation state badges and confidence correctly", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(NodeRenderer, {
          id: NODE_FAILED,
          selected: false,
          type: "fluxoraNode",
          zIndex: 1,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
          dragging: false,
          draggable: false,
          selectable: false,
          deletable: false,
          data: {
            id: NODE_FAILED,
            canonicalId: "svc:orders",
            nodeType: "service",
            name: "Orders Service",
            path: "src/orders.ts",
            confidence: 1.0,
            metadata: {},
            simulationModeActive: true,
            simulationState: "failed",
            simulationRule: "target_failure",
            simulationConfidence: 1.0,
            simulationCapped: false,
          },
        }),
      ),
    );

    assert.ok(markup.includes('data-testid="simulation-failed-badge"'));
    assert.ok(markup.includes("Failed"));
    assert.ok(markup.includes('data-simulation-state="failed"'));
    assert.ok(markup.includes('data-testid="node-simulation-confidence"'));
    assert.ok(markup.includes("100%"));
  });

  test("preserves normal appearance for nodes absent from simulation (no simulation badge)", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(NodeRenderer, {
          id: NODE_UNREACHED,
          selected: false,
          type: "fluxoraNode",
          zIndex: 1,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
          dragging: false,
          draggable: false,
          selectable: false,
          deletable: false,
          data: {
            id: NODE_UNREACHED,
            canonicalId: "svc:billing",
            nodeType: "service",
            name: "Billing Service",
            path: "src/billing.ts",
            confidence: 0.85,
            metadata: {},
            simulationModeActive: true,
            simulationState: undefined, // no simulation result
          },
        }),
      ),
    );

    assert.ok(!markup.includes('data-testid="simulation-no-result-badge"'));
    assert.ok(!markup.includes('data-testid="simulation-failed-badge"'));
    assert.ok(!markup.includes('data-testid="simulation-healthy-badge"'));
    assert.ok(markup.includes('data-simulation-state="none"'));
    // Retains normal confidence indicator when confidence < 1.0
    assert.ok(markup.includes('data-testid="node-confidence"'));
    assert.ok(markup.includes("85%"));
  });

  test("renders capped badge when circuit-breaker capped is true", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(NodeRenderer, {
          id: NODE_DEGRADED,
          selected: false,
          type: "fluxoraNode",
          zIndex: 1,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
          dragging: false,
          draggable: false,
          selectable: false,
          deletable: false,
          data: {
            id: NODE_DEGRADED,
            canonicalId: "svc:payments",
            nodeType: "service",
            name: "Payments Service",
            path: "src/payments.ts",
            confidence: 1.0,
            metadata: {},
            simulationModeActive: true,
            simulationState: "degraded",
            simulationRule: "CALLS_CIRCUIT_BREAKER",
            simulationConfidence: 0.95,
            simulationCapped: true,
          },
        }),
      ),
    );

    assert.ok(markup.includes('data-testid="simulation-capped-badge"'));
    assert.ok(markup.includes("Capped"));
  });
});

describe("SimulationModeBar Component", () => {
  test("renders toggle and idle state when disabled", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: DEFAULT_SIMULATION_MODE_STATE,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-mode-bar"'));
    assert.ok(markup.includes("Simulation Mode: OFF"));
    assert.ok(!markup.includes('data-testid="simulation-mode-id-input"'));
  });

  test("renders input and ready metrics summary when ready", () => {
    const readyState: NormalizedSimulationModeState = {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled: true,
      simulationId: SIM_ID,
      analysisRunId: RUN_ID,
      status: "ready",
      totalResultsCount: 4,
      failedCount: 1,
      degradedCount: 1,
      atRiskCount: 1,
      healthyCount: 1,
      cappedCount: 1,
      ruleTableVersion: "1.0.0",
    };

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: readyState,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
        analysisRunId: RUN_ID,
      }),
    );

    assert.ok(markup.includes("Simulation Mode: ON"));
    assert.ok(markup.includes('data-testid="simulation-chip-total"'));
    assert.ok(markup.includes("Total Results: 4"));
    assert.ok(markup.includes("Failed: 1"));
    assert.ok(markup.includes("Degraded: 1"));
    assert.ok(markup.includes("At Risk: 1"));
    assert.ok(markup.includes("Healthy: 1"));
    assert.ok(markup.includes("Capped (Breakers): 1"));
    assert.ok(markup.includes('data-testid="simulation-confidence-notice"'));
  });

  test("renders error state with retry action button", () => {
    const errorState: NormalizedSimulationModeState = {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled: true,
      status: "error",
      errorMessage: "Analysis run mismatch: Simulation belongs to run ...",
    };

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: errorState,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-error"'));
    assert.ok(markup.includes("Analysis run mismatch"));
    assert.ok(markup.includes('data-testid="simulation-retry-btn"'));
  });
});

describe("NodeInspectorPanel Simulation Section", () => {
  test("renders simulation details and multi-hop causal transitions in order", () => {
    const readySimulationState: NormalizedSimulationModeState = {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled: true,
      simulationId: SIM_ID,
      status: "ready",
      resultsByNodeId: new Map([[NODE_DEGRADED, createMockResult(NODE_DEGRADED, "degraded")]]),
      resultingStateByNodeId: new Map([[NODE_DEGRADED, "degraded"]]),
      ruleByNodeId: new Map([[NODE_DEGRADED, "CALLS_SYNC_NO_FALLBACK"]]),
      confidenceByNodeId: new Map([[NODE_DEGRADED, 0.9]]),
      assumptionsByNodeId: new Map([[NODE_DEGRADED, ["No fallback detected on synchronous call"]]]),
      causalStepsByNodeId: new Map([
        [
          NODE_DEGRADED,
          [
            {
              nodeId: NODE_FAILED,
              edgeId: null,
              ruleId: "target_failure",
              ruleVersion: "1.0.0",
              previousState: "healthy",
              resultingState: "failed",
              assumptions: ["Initial failure seed"],
              confidence: 1.0,
            },
            {
              nodeId: NODE_DEGRADED,
              edgeId: EDGE_CAUSAL_1,
              ruleId: "CALLS_SYNC_NO_FALLBACK",
              ruleVersion: "1.0.0",
              previousState: "healthy",
              resultingState: "degraded",
              assumptions: ["No fallback detected"],
              confidence: 0.9,
              capped: true,
            },
          ],
        ],
      ]),
      hasCappedByNodeId: new Map([[NODE_DEGRADED, true]]),
    };

    const markup = renderToStaticMarkup(
      React.createElement(NodeInspectorPanel, {
        node: {
          id: NODE_DEGRADED,
          name: "Payment Gateway",
          type: "service",
          canonical_id: "svc:payments",
          depth: 1,
          confidence: 1.0,
        },
        simulationMode: readySimulationState,
      }),
    );

    assert.ok(markup.includes('data-testid="inspector-simulation-section"'));
    assert.ok(markup.includes('data-testid="inspector-simulation-state-badge"'));
    assert.ok(markup.includes("degraded"));
    assert.ok(markup.includes('data-testid="inspector-simulation-rule"'));
    assert.ok(markup.includes("CALLS_SYNC_NO_FALLBACK"));
    assert.ok(markup.includes('data-testid="inspector-simulation-confidence"'));
    assert.ok(markup.includes("90%"));
    assert.ok(markup.includes('data-testid="inspector-simulation-confidence-notice"'));
    assert.ok(markup.includes("No fallback detected on synchronous call"));

    // Multi-hop causal transitions in execution order
    assert.ok(markup.includes('data-testid="simulation-causal-step-0"'));
    assert.ok(markup.includes("Step 1:"));
    assert.ok(markup.includes("healthy → failed"));
    assert.ok(markup.includes("None (Seed target failure)"));

    assert.ok(markup.includes('data-testid="simulation-causal-step-1"'));
    assert.ok(markup.includes("Step 2:"));
    assert.ok(markup.includes("healthy → degraded"));
    assert.ok(markup.includes(EDGE_CAUSAL_1));
    assert.ok(markup.includes('data-testid="simulation-step-capped"'));
  });

  test("clearly states when a node was not reached by simulation (never fabricates healthy)", () => {
    const readySimulationState: NormalizedSimulationModeState = {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled: true,
      simulationId: SIM_ID,
      status: "ready",
      resultsByNodeId: new Map([[NODE_FAILED, createMockResult(NODE_FAILED, "failed")]]),
      resultingStateByNodeId: new Map([[NODE_FAILED, "failed"]]),
    };

    const markup = renderToStaticMarkup(
      React.createElement(NodeInspectorPanel, {
        node: {
          id: NODE_UNREACHED, // absent from simulation results
          name: "Reports Service",
          type: "service",
          canonical_id: "svc:reports",
          depth: 1,
          confidence: 1.0,
        },
        simulationMode: readySimulationState,
      }),
    );

    assert.ok(markup.includes('data-testid="inspector-simulation-section"'));
    assert.ok(markup.includes('data-testid="inspector-simulation-no-result"'));
    assert.ok(markup.includes("No simulation result for this node"));
    assert.ok(!markup.includes("HEALTHY")); // Never fabricates healthy!
  });

  test("clearly distinguishes an invalid result from no simulation result", () => {
    const invalidResult = {
      ...createMockResult(NODE_UNREACHED, "failed"),
      resulting_state: "corrupted_state" as unknown as SimulationResultState,
      state: "corrupted_state" as unknown as SimulationResultState,
    };

    const simulationStateWithInvalid: NormalizedSimulationModeState = {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled: true,
      simulationId: SIM_ID,
      status: "ready",
      invalidResultsByNodeId: new Map([[NODE_UNREACHED, invalidResult]]),
    };

    const markup = renderToStaticMarkup(
      React.createElement(NodeInspectorPanel, {
        node: {
          id: NODE_UNREACHED,
          name: "Corrupted Node",
          type: "service",
          canonical_id: "svc:corrupted",
          depth: 1,
          confidence: 1.0,
        },
        simulationMode: simulationStateWithInvalid,
      }),
    );

    assert.ok(markup.includes('data-testid="inspector-simulation-section"'));
    assert.ok(markup.includes('data-testid="inspector-simulation-invalid-badge"'));
    assert.ok(markup.includes("Invalid State"));
    assert.ok(markup.includes('data-testid="inspector-simulation-invalid-result"'));
    assert.ok(markup.includes("Unrecognized Simulation Result State"));
    assert.ok(markup.includes("corrupted_state"));
    // Must NOT state "No simulation result" when an invalid result was recorded for diagnostics
    assert.ok(!markup.includes('data-testid="inspector-simulation-no-result"'));
    // Must NOT assign any canonical state
    assert.ok(!markup.includes('data-testid="inspector-simulation-state-badge"'));
  });
});

describe("Fix A: Invalid Simulation State Integrity", () => {
  const NODE_MALFORMED = "bbbb0001-0000-0000-0000-000000000001";
  const NODE_UNKNOWN_STR = "bbbb0002-0000-0000-0000-000000000002";

  test("unknown string states are never silently converted to at_risk or other canonical states", () => {
    const malformedResults = [
      {
        ...createMockResult(NODE_MALFORMED, "failed"),
        resulting_state: "catastrophic_failure" as unknown as SimulationResultState,
        state: "catastrophic_failure" as unknown as SimulationResultState,
      },
      {
        ...createMockResult(NODE_UNKNOWN_STR, "at_risk"),
        resulting_state: "unknown_state_xyz" as unknown as SimulationResultState,
        state: "unknown_state_xyz" as unknown as SimulationResultState,
      },
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: malformedResults,
      total: 2,
    });

    assert.equal(normalized.resultingStateByNodeId.has(NODE_MALFORMED), false);
    assert.equal(normalized.resultingStateByNodeId.has(NODE_UNKNOWN_STR), false);
    assert.equal(normalized.atRiskCount, 0);
    assert.equal(normalized.failedCount, 0);
    assert.equal(normalized.degradedCount, 0);
    assert.equal(normalized.healthyCount, 0);
    assert.equal(normalized.totalResultsCount, 0);

    // Retained in invalidResultsByNodeId for diagnostics
    assert.ok(normalized.invalidResultsByNodeId.has(NODE_MALFORMED));
    assert.ok(normalized.invalidResultsByNodeId.has(NODE_UNKNOWN_STR));
  });

  test("invalid state does not receive canonical state styling and retains normal appearance", () => {
    const invalidStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: "not_a_valid_state" as unknown as SimulationResultState,
    });

    const baseNormalStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
    });

    assert.equal(invalidStyles.border, baseNormalStyles.border);
    assert.equal(invalidStyles.backgroundColor, baseNormalStyles.backgroundColor);
    assert.equal(invalidStyles.opacity, 1.0);
    assert.equal(invalidStyles.filter, undefined);
    assert.ok(!invalidStyles.border.includes("#eab308")); // Not yellow/at_risk
    assert.ok(!invalidStyles.border.includes("#dc2626")); // Not red/failed
  });

  test("invalid results do not inflate canonical summary counts or totalResultsCount", () => {
    const mixedResults = [
      createMockResult(NODE_FAILED, "failed"),
      createMockResult(NODE_HEALTHY, "healthy"),
      {
        ...createMockResult(NODE_MALFORMED, "failed"),
        resulting_state: "corrupted_123" as unknown as SimulationResultState,
        state: "corrupted_123" as unknown as SimulationResultState,
      },
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: mixedResults,
      total: 3,
    });

    assert.equal(normalized.failedCount, 1);
    assert.equal(normalized.healthyCount, 1);
    assert.equal(normalized.atRiskCount, 0);
    assert.equal(normalized.degradedCount, 0);
    // Total valid results count is 2 (invalid result does not inflate totalResultsCount)
    assert.equal(normalized.totalResultsCount, 2);
    assert.equal(normalized.resultsByNodeId.size, 2);
    assert.equal(normalized.invalidResultsByNodeId.size, 1);
  });

  test("invalid results cannot create fabricated causal edges", () => {
    const invalidResultWithEdge = {
      ...createMockResult(NODE_MALFORMED, "failed"),
      resulting_state: "bad_state" as unknown as SimulationResultState,
      state: "bad_state" as unknown as SimulationResultState,
      propagation_path: [
        {
          nodeId: NODE_MALFORMED,
          edgeId: "edge-should-never-be-highlighted",
          ruleId: "BAD_RULE",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "bad_state" as unknown as SimulationResultState,
          assumptions: [],
          confidence: 1.0,
        },
      ],
    };

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [invalidResultWithEdge as unknown as SimulationResultResponse],
      total: 1,
    });

    assert.equal(normalized.causalEdgeIds.size, 0);
    assert.equal(normalized.causalEdgeIds.has("edge-should-never-be-highlighted"), false);
  });

  test("extractSimulationCausalSteps rejects steps with invalid resultingState or previousState without fabrication", () => {
    const resultWithInvalidSteps = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: "edge-valid",
          ruleId: "RULE_VALID",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        },
        {
          nodeId: NODE_FAILED,
          edgeId: "edge-invalid-state",
          ruleId: "RULE_INVALID",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "bogus_state" as unknown as SimulationResultState,
          assumptions: [],
          confidence: 1.0,
        },
        {
          nodeId: NODE_FAILED,
          edgeId: "edge-invalid-previous",
          ruleId: "RULE_INVALID_PREV",
          ruleVersion: "1.0.0",
          previousState: "non_canonical_prev" as unknown as SimulationResultState,
          resultingState: "degraded",
          assumptions: [],
          confidence: 1.0,
        },
      ],
    };

    const steps = extractSimulationCausalSteps(
      resultWithInvalidSteps as unknown as SimulationResultResponse,
    );
    // Only the valid step is accepted; the 2 invalid steps are skipped and not fabricated
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.edgeId, "edge-valid");
    assert.equal(steps[0]?.resultingState, "failed");
  });

  test("deterministic duplicate handling preserves valid result over invalid result", () => {
    const duplicateResults = [
      {
        ...createMockResult(NODE_FAILED, "failed"),
        resulting_state: "corrupted" as unknown as SimulationResultState,
        state: "corrupted" as unknown as SimulationResultState,
      },
      createMockResult(NODE_FAILED, "failed"),
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: duplicateResults,
      total: 2,
    });

    assert.equal(normalized.resultsByNodeId.size, 1);
    assert.equal(normalized.resultingStateByNodeId.get(NODE_FAILED), "failed");
    assert.equal(normalized.failedCount, 1);
    assert.equal(normalized.invalidResultsByNodeId.size, 0);
  });
});

describe("Fix B: Unreached Node Appearance & Semantic Truth", () => {
  test("unreached node retains identical appearance to normal node styling without fade or grayscale", () => {
    const unreachedStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: true,
      simulationState: undefined,
    });

    const normalBaseStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: false,
    });

    assert.equal(unreachedStyles.border, normalBaseStyles.border);
    assert.equal(unreachedStyles.backgroundColor, normalBaseStyles.backgroundColor);
    assert.equal(unreachedStyles.boxShadow, normalBaseStyles.boxShadow);
    assert.equal(unreachedStyles.opacity, 1.0);
    assert.equal(unreachedStyles.filter, undefined);
  });

  test("unreached node is never assigned healthy and never included in canonical counts", () => {
    const results = [
      createMockResult(NODE_FAILED, "failed"),
      createMockResult(NODE_DEGRADED, "degraded"),
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results,
      total: 2,
    });

    assert.equal(normalized.resultingStateByNodeId.get(NODE_UNREACHED), undefined);
    assert.equal(normalized.resultsByNodeId.has(NODE_UNREACHED), false);
    assert.equal(normalized.healthyCount, 0);
  });

  test("LOD slice metrics accurately distinguish visible and hidden affected nodes, excluding unreached nodes", () => {
    const results = [
      createMockResult(NODE_FAILED, "failed"),
      createMockResult(NODE_DEGRADED, "degraded"),
      createMockResult(NODE_AT_RISK, "at_risk"),
      {
        ...createMockResult("invalid-node-id", "failed"),
        resulting_state: "invalid_state" as unknown as SimulationResultState,
        state: "invalid_state" as unknown as SimulationResultState,
      },
    ];

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results,
      total: 4,
    });

    // Visible in the current slice: NODE_FAILED and NODE_UNREACHED
    const visibleNodes = [
      { id: NODE_FAILED, name: "Failed Node", confidence: 1.0 },
      { id: NODE_UNREACHED, name: "Unreached Node", confidence: 1.0 },
    ];

    const slice = computeSimulationSliceMetrics(normalized, visibleNodes);
    // Total valid result nodes is 3 (invalid result excluded)
    assert.equal(slice.totalResultNodes, 3);
    // Visible result nodes is 1 (only NODE_FAILED; NODE_UNREACHED is not a result node)
    assert.equal(slice.visibleResultNodes, 1);
    // Hidden result nodes is 2 (NODE_DEGRADED and NODE_AT_RISK)
    assert.equal(slice.hiddenResultNodes, 2);
    assert.equal(slice.visibleByState.failed, 1);
    assert.equal(slice.visibleByState.degraded, 0);
    assert.equal(slice.visibleByState.at_risk, 0);
    assert.equal(slice.visibleByState.healthy, 0);
  });

  test("Change Mode and Simulation Mode visual interactions preserve Change Mode data", () => {
    // When Simulation Mode is inactive, Change Mode styles apply directly
    const changeModeDirectStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      changeModeActive: true,
      simulationModeActive: false,
      impactRole: "direct",
    });
    assert.ok(changeModeDirectStyles.border.includes("#dc2626"));

    // When Simulation Mode is active and node has simulation result, simulation state wins
    const simulationHealthyStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      changeModeActive: true,
      simulationModeActive: true,
      simulationState: "healthy",
      impactRole: "direct",
    });
    assert.ok(simulationHealthyStyles.border.includes("#059669")); // Emerald/healthy wins

    // When Simulation Mode is active and node has NO simulation result, it retains normal base appearance
    const simulationUnreachedStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      changeModeActive: true,
      simulationModeActive: true,
      simulationState: undefined,
      impactRole: "unaffected",
    });
    assert.equal(simulationUnreachedStyles.opacity, 1.0);
    assert.equal(simulationUnreachedStyles.filter, undefined);
  });
});

describe("Correction A: Never Fabricate Previous Simulation States", () => {
  test("missing previousState is not replaced with healthy (step is rejected)", () => {
    const resultMissingPrev: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_SYNC",
          ruleVersion: "1.0.0",
          // previousState intentionally omitted/undefined
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        } as unknown as SimulationCausalStep,
      ],
    };

    const steps = extractSimulationCausalSteps(resultMissingPrev);
    assert.equal(steps.length, 0);
  });

  test("invalid non-canonical previousState is rejected", () => {
    const resultInvalidPrev: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_SYNC",
          ruleVersion: "1.0.0",
          previousState: "unknown_state_invalid" as unknown as SimulationResultState,
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        },
      ],
    };

    const steps = extractSimulationCausalSteps(resultInvalidPrev);
    assert.equal(steps.length, 0);
  });

  test("valid structured steps are preserved", () => {
    const resultValid: SimulationResultResponse = {
      ...createMockResult(NODE_DEGRADED, "degraded"),
      propagation_path: [
        {
          nodeId: NODE_DEGRADED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.2.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: ["No fallback detected"],
          confidence: 0.85,
          capped: true,
        },
      ],
    };

    const steps = extractSimulationCausalSteps(resultValid);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.nodeId, NODE_DEGRADED);
    assert.equal(steps[0]?.edgeId, EDGE_CAUSAL_1);
    assert.equal(steps[0]?.ruleId, "CALLS_SYNC_NO_FALLBACK");
    assert.equal(steps[0]?.ruleVersion, "1.2.0");
    assert.equal(steps[0]?.previousState, "healthy");
    assert.equal(steps[0]?.resultingState, "degraded");
    assert.equal(steps[0]?.confidence, 0.85);
    assert.equal(steps[0]?.capped, true);
  });

  test("extractSimulationCausalSteps rejects steps missing nodeId rather than inventing result.node_id", () => {
    const multiHopResult: SimulationResultResponse = {
      ...createMockResult(NODE_DEGRADED, "degraded"),
      propagation_path: [
        {
          // Step 1 belongs to NODE_FAILED (seed), but nodeId is omitted/undefined
          edgeId: null,
          ruleId: "target_failure",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        } as unknown as SimulationCausalStep,
        {
          // Step 2 belongs to NODE_DEGRADED
          nodeId: NODE_DEGRADED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: [],
          confidence: 0.9,
        },
      ],
    };

    const steps = extractSimulationCausalSteps(multiHopResult);
    // Incomplete step missing nodeId is rejected; it must NOT be attributed to NODE_DEGRADED!
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.nodeId, NODE_DEGRADED);
    assert.equal(steps[0]?.edgeId, EDGE_CAUSAL_1);
  });

  test("extractSimulationCausalSteps rejects steps missing resultingState rather than inventing result.resulting_state", () => {
    const multiHopResult: SimulationResultResponse = {
      ...createMockResult(NODE_DEGRADED, "degraded"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: null,
          ruleId: "target_failure",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          // resultingState is omitted/undefined
          assumptions: [],
          confidence: 1.0,
        } as unknown as SimulationCausalStep,
        {
          nodeId: NODE_DEGRADED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: [],
          confidence: 0.9,
        },
      ],
    };

    const steps = extractSimulationCausalSteps(multiHopResult);
    // Incomplete step missing resultingState is rejected; it must NOT take NODE_DEGRADED's "degraded" state!
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.nodeId, NODE_DEGRADED);
    assert.equal(steps[0]?.resultingState, "degraded");
  });

  test("legacy string entries do not create fabricated state transitions or causal edges", () => {
    const resultWithLegacyStrings: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: ["target_failure", "downstream_propagation"],
    };

    const steps = extractSimulationCausalSteps(resultWithLegacyStrings);
    assert.equal(steps.length, 0);

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [resultWithLegacyStrings],
      total: 1,
    });
    assert.equal(normalized.causalEdgeIds.size, 0);
  });

  test("invalid steps cannot produce causal-edge highlights", () => {
    const resultWithInvalidStepEdge: SimulationResultResponse = {
      ...createMockResult(NODE_FAILED, "failed"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: "phantom-edge-should-not-exist",
          ruleId: "RULE_BAD",
          ruleVersion: "1.0.0",
          previousState: "bad_prev_state" as unknown as SimulationResultState,
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        },
      ],
    };

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [resultWithInvalidStepEdge],
      total: 1,
    });

    assert.equal(normalized.causalEdgeIds.has("phantom-edge-should-not-exist"), false);
    assert.equal(normalized.causalEdgeIds.size, 0);
  });

  test("existing valid causal-path behavior remains unchanged", () => {
    const validChainResult: SimulationResultResponse = {
      ...createMockResult(NODE_DEGRADED, "degraded"),
      propagation_path: [
        {
          nodeId: NODE_FAILED,
          edgeId: null,
          ruleId: "target_failure",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: ["Seed failure"],
          confidence: 1.0,
        },
        {
          nodeId: NODE_DEGRADED,
          edgeId: EDGE_CAUSAL_1,
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: ["Sync call"],
          confidence: 0.95,
        },
      ],
    };

    const steps = extractSimulationCausalSteps(validChainResult);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.nodeId, NODE_FAILED);
    assert.equal(steps[0]?.edgeId, null);
    assert.equal(steps[0]?.previousState, "healthy");
    assert.equal(steps[0]?.resultingState, "failed");

    assert.equal(steps[1]?.nodeId, NODE_DEGRADED);
    assert.equal(steps[1]?.edgeId, EDGE_CAUSAL_1);
    assert.equal(steps[1]?.previousState, "healthy");
    assert.equal(steps[1]?.resultingState, "degraded");

    const normalized = normalizeSimulationResponse(null, {
      simulation_id: SIM_ID,
      results: [validChainResult],
      total: 1,
    });
    assert.equal(normalized.causalEdgeIds.size, 1);
    assert.ok(normalized.causalEdgeIds.has(EDGE_CAUSAL_1));
  });
});

describe("Correction B: Pending, Running, and Convergence Integrity", () => {
  const baseSim: SimulationResponse = {
    id: SIM_ID,
    scenario_id: "scen-1",
    analysis_run_id: RUN_ID,
    status: "completed",
    created_at: "2026-11-18T10:00:00Z",
  };

  test("pending simulation with zero results produces explicit pending state", () => {
    const normalized = normalizeSimulationResponse(
      { ...baseSim, status: "pending" },
      { simulation_id: SIM_ID, results: [], total: 0 },
    );

    assert.equal(normalized.status, "pending");
    assert.equal(normalized.executionStatus, "pending");
    assert.equal(normalized.totalResultsCount, 0);
    assert.equal(normalized.resultsByNodeId.size, 0);
    assert.notEqual(normalized.status, "ready");
    assert.notEqual(normalized.status, "empty");

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: normalized,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-pending"'));
    assert.ok(markup.includes("Simulation pending execution..."));
    assert.ok(markup.includes('data-testid="simulation-refresh-btn"'));
    assert.ok(!markup.includes('data-testid="simulation-status-ready"'));
    assert.ok(!markup.includes('data-testid="simulation-status-empty"'));
    assert.ok(!markup.includes('data-testid="simulation-summary-chips"'));
  });

  test("running simulation with zero results produces explicit running state", () => {
    const normalized = normalizeSimulationResponse(
      { ...baseSim, status: "running" },
      { simulation_id: SIM_ID, results: [], total: 0 },
    );

    assert.equal(normalized.status, "running");
    assert.equal(normalized.executionStatus, "running");
    assert.equal(normalized.totalResultsCount, 0);
    assert.notEqual(normalized.status, "ready");
    assert.notEqual(normalized.status, "empty");

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: normalized,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-running"'));
    assert.ok(markup.includes("Simulation is running..."));
    assert.ok(markup.includes('data-testid="simulation-refresh-btn"'));
    assert.ok(!markup.includes('data-testid="simulation-status-ready"'));
    assert.ok(!markup.includes('data-testid="simulation-status-empty"'));
    assert.ok(!markup.includes('data-testid="simulation-summary-chips"'));
  });

  test("running simulation with partial results does not present partial results as completed", () => {
    const partialResult = createMockResult(NODE_FAILED, "failed");
    const normalized = normalizeSimulationResponse(
      { ...baseSim, status: "running" },
      { simulation_id: SIM_ID, results: [partialResult], total: 1 },
    );

    assert.equal(normalized.status, "running");
    assert.equal(normalized.executionStatus, "running");
    // Partial results must not be presented as completed result set
    assert.equal(normalized.resultsByNodeId.size, 0);
    assert.equal(normalized.causalEdgeIds.size, 0);
    assert.equal(normalized.totalResultsCount, 0);
    assert.notEqual(normalized.status, "ready");
    assert.notEqual(normalized.status, "empty");

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: normalized,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-running"'));
    assert.ok(!markup.includes('data-testid="simulation-status-ready"'));
    assert.ok(!markup.includes('data-testid="simulation-status-empty"'));
    assert.ok(!markup.includes('data-testid="simulation-summary-chips"'));
  });

  test("completed simulation with zero results and converged: true claims convergence", () => {
    const normalized = normalizeSimulationResponse(
      { ...baseSim, status: "completed", converged: true },
      { simulation_id: SIM_ID, results: [], total: 0 },
    );

    assert.equal(normalized.status, "empty");
    assert.equal(normalized.executionStatus, "completed");
    assert.equal(normalized.converged, true);

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: normalized,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-empty"'));
    assert.ok(markup.includes("Simulation converged with 0 affected nodes."));
  });

  test("completed simulation with zero results and convergence unknown uses neutral wording", () => {
    const normalized = normalizeSimulationResponse(
      { ...baseSim, status: "completed" }, // converged is undefined
      { simulation_id: SIM_ID, results: [], total: 0 },
    );

    assert.equal(normalized.status, "empty");
    assert.equal(normalized.executionStatus, "completed");
    assert.equal(normalized.converged, undefined);

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: normalized,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-empty"'));
    assert.ok(markup.includes("Completed with no result nodes."));
    assert.ok(!markup.includes("Simulation converged"));
  });

  test("failed simulation produces explicit error state with retry", () => {
    const normalized = normalizeSimulationResponse(
      { ...baseSim, status: "failed" },
      null,
    );

    assert.equal(normalized.status, "error");
    assert.equal(normalized.executionStatus, "failed");
    assert.ok(normalized.errorMessage?.includes("failed during execution"));

    const markup = renderToStaticMarkup(
      React.createElement(SimulationModeBar, {
        state: normalized,
        onToggle: () => {},
        onLoadSimulation: () => {},
        onRetry: () => {},
        onClear: () => {},
      }),
    );

    assert.ok(markup.includes('data-testid="simulation-status-error"'));
    assert.ok(markup.includes('data-testid="simulation-retry-btn"'));
  });

  test("pending/running states never apply a completed graph overlay", () => {
    const pendingState = normalizeSimulationResponse(
      { ...baseSim, status: "pending" },
      { simulation_id: SIM_ID, results: [createMockResult(NODE_FAILED, "failed")], total: 1 },
    );

    const runningState = normalizeSimulationResponse(
      { ...baseSim, status: "running" },
      { simulation_id: SIM_ID, results: [createMockResult(NODE_FAILED, "failed")], total: 1 },
    );

    // Neither pending nor running has status === "ready"
    assert.notEqual(pendingState.status, "ready");
    assert.notEqual(runningState.status, "ready");

    // In GraphCanvas, isSimulationModeActive requires:
    // simulationMode.enabled && simulationMode.status === "ready"
    const isPendingActive = Boolean(pendingState.enabled && pendingState.status === "ready");
    const isRunningActive = Boolean(runningState.enabled && runningState.status === "ready");
    assert.equal(isPendingActive, false);
    assert.equal(isRunningActive, false);

    // Node styles remain standard base styles, not simulation overlay styles
    const pendingNodeStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: isPendingActive,
      simulationState: pendingState.resultingStateByNodeId.get(NODE_FAILED),
    });
    const normalStyles = computeNodeVisualStyles({
      nodeType: "service",
      isSelected: false,
      simulationModeActive: false,
    });

    assert.equal(pendingNodeStyles.border, normalStyles.border);
    assert.equal(pendingNodeStyles.backgroundColor, normalStyles.backgroundColor);
  });

  // Helper to render functional components with hooks in Node test environment
  function renderWithHooks<P>(
    Component: (props: P) => React.JSX.Element,
    props: P,
  ): React.JSX.Element {
    const internals = (React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
        H: unknown;
      };
    }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

    const prevH = internals?.H;
    if (internals) {
      internals.H = {
        useState: (initial: unknown) => [
          typeof initial === "function" ? (initial as () => unknown)() : initial,
          () => {},
        ],
        useEffect: (fn: () => void | (() => void)) => {
          fn();
        },
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
        useRef: (initial: unknown) => ({ current: initial }),
      };
    }

    try {
      return Component(props);
    } finally {
      if (internals) {
        internals.H = prevH;
      }
    }
  }

  test("refresh button interaction invokes the supplied onRetry callback", () => {
    let refreshTriggerCount = 0;
    const runningState: NormalizedSimulationModeState = {
      ...DEFAULT_SIMULATION_MODE_STATE,
      enabled: true,
      simulationId: SIM_ID,
      executionStatus: "running",
      status: "running",
    };

    const renderedTree = renderWithHooks(SimulationModeBar, {
      state: runningState,
      onToggle: () => {},
      onLoadSimulation: () => {},
      onRetry: () => {
        refreshTriggerCount += 1;
      },
      onClear: () => {},
    });

    // Traverse the rendered element tree to find the Refresh button by testid
    function findElement(el: unknown): React.ReactElement<{ onClick?: () => void }> | null {
      if (!React.isValidElement(el)) return null;
      const props = el.props as Record<string, unknown>;
      if (props["data-testid"] === "simulation-refresh-btn") {
        return el as React.ReactElement<{ onClick?: () => void }>;
      }
      const children = props.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = findElement(child);
          if (found) return found;
        }
      } else if (children) {
        return findElement(children);
      }
      return null;
    }

    const refreshBtn = findElement(renderedTree);
    assert.ok(refreshBtn, "Refresh button element must be present in running state");
    assert.equal(typeof refreshBtn.props.onClick, "function");

    // Invoke click handler
    refreshBtn.props.onClick!();
    assert.equal(refreshTriggerCount, 1, "Clicking Refresh button must invoke onRetry callback");
  });

  test("SimulationModeBar input value reflects parent simulationId updates and clearing", () => {
    function findInput(el: unknown): React.ReactElement<{ value?: string }> | null {
      if (!React.isValidElement(el)) return null;
      const props = el.props as Record<string, unknown>;
      if (props["data-testid"] === "simulation-mode-id-input") {
        return el as React.ReactElement<{ value?: string }>;
      }
      const children = props.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = findInput(child);
          if (found) return found;
        }
      } else if (children) {
        return findInput(children);
      }
      return null;
    }

    // When mounted with an initial simulation ID
    const initialTree = renderWithHooks(SimulationModeBar, {
      state: {
        ...DEFAULT_SIMULATION_MODE_STATE,
        enabled: true,
        simulationId: SIM_ID,
      },
      onToggle: () => {},
      onLoadSimulation: () => {},
      onRetry: () => {},
      onClear: () => {},
    });

    const inputInitial = findInput(initialTree);
    assert.ok(inputInitial);
    assert.equal(inputInitial.props.value, SIM_ID);

    // When cleared by parent (simulationId: null)
    const clearedTree = renderWithHooks(SimulationModeBar, {
      state: {
        ...DEFAULT_SIMULATION_MODE_STATE,
        enabled: true,
        simulationId: null,
      },
      onToggle: () => {},
      onLoadSimulation: () => {},
      onRetry: () => {},
      onClear: () => {},
    });
    const inputCleared = findInput(clearedTree);
    assert.ok(inputCleared);
    assert.equal(inputCleared.props.value, "");
  });
});
