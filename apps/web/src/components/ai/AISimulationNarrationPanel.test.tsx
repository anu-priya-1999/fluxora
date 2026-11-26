import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import type {
  AIAnalysisResponse,
  GraphQueryResponseEvidence,
} from "@fluxora/shared-types";

import {
  AISimulationNarrationPanel,
  MAX_AI_DISCOVERY_ATTEMPTS,
} from "./AISimulationNarrationPanel.tsx";

// Minimal test harness for functional components with hooks in Node environment
function createTestHarness<P>(Component: (props: P) => React.JSX.Element) {
  const states: unknown[] = [];
  let stateIndex = 0;
  const cleanups: (() => void)[] = [];
  const effectDeps: (unknown[] | undefined)[] = [];
  let effectIndex = 0;
  const refs: { current: unknown }[] = [];
  let refIndex = 0;
  let currentProps: P;
  let currentTree: React.JSX.Element;
  let mounted = true;

  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
      H: unknown;
    };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  function render(props?: P) {
    if (!mounted) return currentTree;
    if (props !== undefined) currentProps = props;
    stateIndex = 0;
    refIndex = 0;
    effectIndex = 0;

    const prevH = internals?.H;
    if (internals) {
      internals.H = {
        useState: (initial: unknown) => {
          const idx = stateIndex++;
          if (states.length <= idx) {
            states.push(typeof initial === "function" ? (initial as () => unknown)() : initial);
          }
          const setter = (next: unknown) => {
            const nextVal = typeof next === "function" ? (next as (prev: unknown) => unknown)(states[idx]) : next;
            if (!Object.is(states[idx], nextVal)) {
              states[idx] = nextVal;
              render();
            }
          };
          return [states[idx], setter];
        },
        useRef: (initial: unknown) => {
          const idx = refIndex++;
          if (refs.length <= idx) {
            refs.push({ current: initial });
          }
          return refs[idx];
        },
        useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
          const idx = effectIndex++;
          const prevDeps = effectDeps[idx];
          const hasChanged = !prevDeps || !deps || deps.some((d, i) => !Object.is(d, prevDeps[i]));
          if (hasChanged) {
            effectDeps[idx] = deps;
            if (cleanups[idx]) {
              try {
                cleanups[idx]();
              } catch {
                // Best-effort cleanup in test harness
              }
              cleanups[idx] = undefined as unknown as () => void;
            }
            const res = fn();
            if (typeof res === "function") {
              cleanups[idx] = res;
            }
          }
        },
        useCallback: (fn: unknown) => fn,
        useMemo: (fn: () => unknown) => fn(),
      };
    }

    try {
      currentTree = Component(currentProps);
      return currentTree;
    } finally {
      if (internals) {
        internals.H = prevH;
      }
    }
  }

  function mount(props: P) {
    mounted = true;
    return render(props);
  }

  function unmount() {
    mounted = false;
    for (const cleanup of cleanups) {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch {
          // Best-effort cleanup in test harness
        }
      }
    }
    cleanups.length = 0;
  }

  function getHtml(): string {
    return renderToStaticMarkup(currentTree);
  }

  function findProps(testId: string): Record<string, unknown> | null {
    function search(el: unknown): Record<string, unknown> | null {
      if (!React.isValidElement(el)) return null;
      const props = el.props as Record<string, unknown> | undefined;
      if (props?.["data-testid"] === testId) return props;
      const children = props?.["children"];
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = search(child);
          if (found) return found;
        }
      } else if (children) {
        return search(children);
      }
      return null;
    }
    return search(currentTree);
  }

  return {
    mount,
    render,
    unmount,
    getHtml,
    findProps,
  };
}

const mockCompletedAIAnalysis: AIAnalysisResponse = {
  id: "ai_sim_111",
  subject_type: "simulation",
  subject_id: "sim_222",
  status: "completed",
  model_used: "claude-sonnet-5-5",
  prompt_version: "simulation-narrate-v1",
  input_evidence_ids: ["ev_sim_01"],
  output_text: "Simulated unavailability of PaymentService propagated failure to CheckoutService.",
  output_structured: {
    summary: "Simulated unavailability of PaymentService propagated failure to CheckoutService.",
    claims: [
      {
        text: "PaymentService is the primary failure target of the scenario.",
        evidence_ids: ["ev_sim_01"],
      },
    ],
    confidence: "high",
    caveats: [
      "Simulated scenario based on static dependency graph, not observed production incident.",
    ],
  },
  validation_status: "passed",
  token_count: 350,
  cost_usd: 0.002,
  latency_ms: 180,
  created_at: "2026-11-24T12:00:00.000Z",
  updated_at: "2026-11-24T12:00:01.000Z",
};

const mockEvidencePool: GraphQueryResponseEvidence[] = [
  {
    id: "ev_sim_01",
    subject_id: "sr_01",
    subject_type: "simulation_state",
    file_path: "src/payment.ts",
    relationship_description: "Target failure",
    confidence: 1.0,
  },
];

describe("AISimulationNarrationPanel Component (Step 63)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("1. Renders waiting state when simulation is pending or running", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        simulationStatus: "running",
        simulationId: "sim_1",
      }),
    );

    assert.ok(html.includes('data-testid="ai-state-waiting-for-simulation"'));
    assert.ok(html.includes("Waiting for deterministic simulation execution to complete..."));
    assert.ok(html.includes('data-testid="ai-simulation-disclaimer"'));
  });

  it("2. Renders pending state when AI narration is pending", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        initialData: {
          ...mockCompletedAIAnalysis,
          status: "pending",
          output_text: null,
          output_structured: null,
        },
      }),
    );

    assert.ok(html.includes('data-testid="ai-state-pending"'));
    assert.ok(html.includes("Generating evidence-grounded simulation narration..."));
  });

  it("3. Renders completed state with summary, claims, citations, model confidence, and caveats", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        initialData: mockCompletedAIAnalysis,
        evidencePool: mockEvidencePool,
      }),
    );

    assert.ok(html.includes('data-testid="ai-simulation-narration-panel"'));
    assert.ok(html.includes('data-testid="ai-narration-badge"'));
    assert.ok(html.includes("AI Simulation Narration"));
    assert.ok(html.includes('data-testid="ai-simulation-disclaimer"'));
    assert.ok(html.includes("Simulated Scenario Notice"));
    assert.ok(html.includes('data-testid="ai-narration-summary"'));
    assert.ok(html.includes("PaymentService propagated failure"));
    assert.ok(html.includes('data-testid="ai-model-confidence"'));
    assert.ok(html.includes("Model Confidence: high"));
    assert.ok(html.includes('data-testid="ai-claim-text"'));
    assert.ok(html.includes('data-testid="ai-narration-caveats"'));
    assert.ok(html.includes("Simulated scenario based on static dependency graph"));
  });

  it("4. Renders validation rejected state without exposing raw rejected output", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        initialData: {
          ...mockCompletedAIAnalysis,
          status: "rejected",
          validation_status: "rejected",
          output_text: null,
          output_structured: null,
        },
      }),
    );

    assert.ok(html.includes('data-testid="ai-state-rejected"'));
    assert.ok(html.includes("Simulation Narration Rejected"));
    assert.ok(!html.includes("PaymentService propagated failure")); // Raw output not exposed
  });

  it("5. Renders generation failed state cleanly without raw exceptions", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        initialData: {
          ...mockCompletedAIAnalysis,
          status: "failed",
          output_text: null,
          output_structured: null,
        },
      }),
    );

    assert.ok(html.includes('data-testid="ai-state-failed"'));
    assert.ok(html.includes("Simulation Narration Unavailable"));
  });

  it("6. Renders unavailable state with Check again button when record is missing", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        apiUrl: "https://api.fluxora.test",
        getToken: async () => "token",
        simulationId: "sim_123",
      }),
    );

    assert.ok(html.includes('data-testid="ai-state-unavailable"'));
    assert.ok(html.includes("No AI narration available for this simulation."));
    assert.ok(html.includes('data-testid="ai-check-again-btn"'));
  });

  it("7. Renders empty claims state when claims array is empty", () => {
    const html = renderToStaticMarkup(
      React.createElement(AISimulationNarrationPanel, {
        initialData: {
          ...mockCompletedAIAnalysis,
          output_structured: {
            ...mockCompletedAIAnalysis.output_structured!,
            claims: [],
          },
        },
      }),
    );

    assert.ok(html.includes('data-testid="ai-claims-empty"'));
    assert.ok(html.includes("No component claims generated"));
  });

  it("8. Bounded automatic discovery polling transitions from unavailable to pending upon discovering record", async () => {
    let simPollCount = 0;
    let aiPollCount = 0;
    let discoveredIdReported: string | null = null;

    const RACE_SIM_ID = "a0000000-0000-4000-8000-000000000001";
    const DISCOVERED_AI_ID = "b0000000-0000-4000-8000-000000000002";

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes(`/simulations/${RACE_SIM_ID}`)) {
          simPollCount += 1;
          if (simPollCount === 1) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  id: RACE_SIM_ID,
                  scenario_id: "scen_1",
                  analysis_run_id: "run_1",
                  status: "completed",
                  created_at: new Date().toISOString(),
                  ai_analysis_id: null,
                  ai_analysis_status: null,
                };
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: RACE_SIM_ID,
                scenario_id: "scen_1",
                analysis_run_id: "run_1",
                status: "completed",
                created_at: new Date().toISOString(),
                ai_analysis_id: DISCOVERED_AI_ID,
                ai_analysis_status: "pending",
              };
            },
          };
        }
        if (url.includes(`/api/v1/ai-analyses/${DISCOVERED_AI_ID}`)) {
          aiPollCount += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ...mockCompletedAIAnalysis,
                id: DISCOVERED_AI_ID,
                status: "pending",
                output_text: null,
                output_structured: null,
              };
            },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const harness = createTestHarness(AISimulationNarrationPanel);
      harness.mount({
        apiUrl: "http://localhost:3000",
        getToken: async () => "token-1",
        simulationId: RACE_SIM_ID,
        aiAnalysisId: null,
        simulationStatus: "completed",
        onAIAnalysisDiscovered: (id) => {
          discoveredIdReported = id;
        },
      });

      // 1. Initial state: before discovery poll fires, panel renders unavailable
      assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
      assert.equal(discoveredIdReported, null);

      // 2. Advance time 2000ms: first discovery poll fires, returns null
      await vi.advanceTimersByTimeAsync(2000);
      assert.equal(simPollCount, 1);
      assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
      assert.equal(discoveredIdReported, null);

      // 3. Advance time 2000ms: second discovery poll fires, discovers ID!
      await vi.advanceTimersByTimeAsync(2000);
      assert.equal(simPollCount, 2);
      assert.equal(discoveredIdReported, DISCOVERED_AI_ID);

      // 4. Panel transitions to pending
      assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);
      assert.match(harness.getHtml(), /Generating evidence-grounded simulation narration/);
      assert.equal(aiPollCount, 1);

      harness.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("9. Discovery poller halts after MAX_AI_DISCOVERY_ATTEMPTS (5)", async () => {
    let simCalls = 0;
    const NOT_FOUND_SIM_ID = "c0000000-0000-4000-8000-000000000003";
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes(`/simulations/${NOT_FOUND_SIM_ID}`)) {
          simCalls += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: NOT_FOUND_SIM_ID,
                scenario_id: "scen_1",
                analysis_run_id: "run_1",
                status: "completed",
                created_at: new Date().toISOString(),
                ai_analysis_id: null,
                ai_analysis_status: null,
              };
            },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const harness = createTestHarness(AISimulationNarrationPanel);
      harness.mount({
        apiUrl: "http://localhost:3000",
        getToken: async () => "token-1",
        simulationId: NOT_FOUND_SIM_ID,
        simulationStatus: "completed",
      });

      // Advance well beyond MAX_AI_DISCOVERY_ATTEMPTS (5 attempts * 2000ms = 10,000ms)
      await vi.advanceTimersByTimeAsync(25000);

      // Must strictly stop at MAX_AI_DISCOVERY_ATTEMPTS (5) and NOT poll indefinitely
      assert.equal(simCalls, MAX_AI_DISCOVERY_ATTEMPTS);
      assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
      assert.match(harness.getHtml(), /data-testid="ai-check-again-btn"/);

      harness.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("10. Polling halts upon reaching terminal state (pending -> completed)", async () => {
    let fetchCount = 0;
    const AI_POLL_ID = "d0000000-0000-4000-8000-000000000004";
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes(`/api/v1/ai-analyses/${AI_POLL_ID}`)) {
          fetchCount += 1;
          if (fetchCount === 1) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  ...mockCompletedAIAnalysis,
                  id: AI_POLL_ID,
                  status: "pending",
                  output_text: null,
                  output_structured: null,
                };
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ...mockCompletedAIAnalysis,
                id: AI_POLL_ID,
                status: "completed",
              };
            },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const harness = createTestHarness(AISimulationNarrationPanel);
      harness.mount({
        apiUrl: "http://localhost:3000",
        getToken: async () => "token-1",
        aiAnalysisId: AI_POLL_ID,
        simulationStatus: "completed",
      });

      // Initial fetch loads pending
      await vi.advanceTimersByTimeAsync(10);
      assert.equal(fetchCount, 1);
      assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);

      // Advance poll timer (2500ms): second fetch returns completed
      await vi.advanceTimersByTimeAsync(2500);
      assert.equal(fetchCount, 2);
      assert.match(harness.getHtml(), /data-testid="ai-narration-summary"/);
      assert.match(harness.getHtml(), /PaymentService propagated failure/);

      // Advance further (10,000ms): prove no further requests are made
      await vi.advanceTimersByTimeAsync(10000);
      assert.equal(fetchCount, 2, "No further poll requests must be dispatched after completed");

      harness.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("11. Unmount safely cleans up all polling and discovery timers", async () => {
    let fetchCount = 0;
    const AI_UNMOUNT_ID = "e0000000-0000-4000-8000-000000000005";
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes(`/api/v1/ai-analyses/${AI_UNMOUNT_ID}`)) {
          fetchCount += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ...mockCompletedAIAnalysis,
                id: AI_UNMOUNT_ID,
                status: "pending",
                output_text: null,
                output_structured: null,
              };
            },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const harness = createTestHarness(AISimulationNarrationPanel);
      harness.mount({
        apiUrl: "http://localhost:3000",
        getToken: async () => "token-1",
        aiAnalysisId: AI_UNMOUNT_ID,
        simulationStatus: "completed",
      });

      // Initial load
      await vi.advanceTimersByTimeAsync(10);
      assert.equal(fetchCount, 1);

      // Unmount before poll timer (2500ms) fires
      harness.unmount();

      // Advance timer past poll delay
      await vi.advanceTimersByTimeAsync(5000);
      // Fetch should not have been called again after unmount
      assert.equal(fetchCount, 1, "Fetch must not be called after unmount");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
