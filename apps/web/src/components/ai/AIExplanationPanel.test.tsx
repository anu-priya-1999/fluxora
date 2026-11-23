import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import type {
  AIAnalysisResponse,
  GraphQueryResponseEvidence,
} from "@fluxora/shared-types";

import { AIExplanationPanel, MAX_AI_DISCOVERY_ATTEMPTS } from "./AIExplanationPanel.tsx";
import { fetchAIAnalysis } from "./ai-analysis-data.ts";

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

const MOCK_EVIDENCE_1: GraphQueryResponseEvidence = {
  id: "ev-1001",
  subject_type: "impact_finding",
  subject_id: "node_payment",
  file_path: "src/payment.ts",
  line_start: 10,
  line_end: 25,
  relationship_description: "Direct service modification",
  confidence: 1.0,
};

const MOCK_COMPLETED_ANALYSIS: AIAnalysisResponse = {
  id: "ai-1111-1111-1111-111111111111",
  subject_type: "impact_analysis",
  subject_id: "impact-2222-2222-2222-222222222222",
  status: "completed",
  model_used: "claude-sonnet-5-5",
  prompt_version: "impact-explain-v1",
  input_evidence_ids: ["ev-1001"],
  output_text: "PaymentService was directly modified in this pull request.",
  output_structured: {
    summary: "PaymentService was directly modified in this pull request.",
    claims: [
      {
        text: "Direct modification to payment handler logic.",
        evidence_ids: ["ev-1001"],
      },
    ],
    confidence: "high",
    caveats: ["Context bounded to direct blast-radius."],
  },
  validation_status: "passed",
  token_count: 240,
  cost_usd: 0.002,
  latency_ms: 650,
  schema_version: "impact-explanation-output-v1",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("AIExplanationPanel Component (Step 62)", () => {
  it("renders successful grounded explanation with summary, claims, citations, and confidence", () => {
    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        initialData: MOCK_COMPLETED_ANALYSIS,
        evidencePool: [MOCK_EVIDENCE_1],
        repositoryName: "acme/fluxora",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      }),
    );

    assert.match(html, /data-testid="ai-narration-badge"/);
    assert.match(html, /AI Narration/);
    assert.match(html, /data-testid="ai-model-confidence"/);
    assert.match(html, /Model Confidence: high/);
    assert.match(html, /data-testid="ai-explanation-summary"/);
    assert.match(html, /PaymentService was directly modified/);
    assert.match(html, /data-testid="ai-claim-text"/);
    assert.match(html, /Direct modification to payment handler logic\./);
    // Verified citation chip is rendered
    assert.match(html, /data-testid="evidence-citation-list"/);
    assert.match(html, /src\/payment\.ts/);
    // Caveats rendered
    assert.match(html, /data-testid="ai-explanation-caveats"/);
    assert.match(html, /Context bounded to direct blast-radius\./);
  });

  it("renders waiting for deterministic impact analysis state", () => {
    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        impactStatus: "running",
        aiAnalysisId: "ai-123",
      }),
    );

    assert.match(html, /data-testid="ai-state-waiting-for-impact"/);
    assert.match(html, /Waiting for deterministic impact analysis to complete/);
  });

  it("renders pending generation state when AI analysis is generating", () => {
    const pendingData: AIAnalysisResponse = {
      ...MOCK_COMPLETED_ANALYSIS,
      status: "pending",
      validation_status: null,
      output_text: null,
      output_structured: null,
    };

    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        initialData: pendingData,
        aiAnalysisId: "ai-123",
      }),
    );

    assert.match(html, /data-testid="ai-state-pending"/);
    assert.match(html, /Generating evidence-grounded AI explanation/);
  });

  it("renders validation rejected state and never displays raw model text", () => {
    const rejectedData: AIAnalysisResponse = {
      ...MOCK_COMPLETED_ANALYSIS,
      status: "rejected",
      validation_status: "rejected",
      output_text: null,
      output_structured: null,
    };

    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        initialData: rejectedData,
        aiAnalysisId: "ai-123",
      }),
    );

    assert.match(html, /data-testid="ai-state-rejected"/);
    assert.match(html, /AI Explanation Rejected/);
    assert.match(html, /cited evidence outside the verified evidence manifest/);
    // Ensure raw model output is absent
    assert.ok(!html.includes("raw unvalidated response"));
  });

  it("renders provider failure state cleanly", () => {
    const failedData: AIAnalysisResponse = {
      ...MOCK_COMPLETED_ANALYSIS,
      status: "failed",
      validation_status: null,
      output_text: null,
      output_structured: null,
      error_message: "Rate limit exceeded",
    };

    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        initialData: failedData,
        aiAnalysisId: "ai-123",
      }),
    );

    assert.match(html, /data-testid="ai-state-failed"/);
    assert.match(html, /AI Explanation Unavailable/);
  });

  it("renders unavailable state when no AI analysis ID is present", () => {
    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        aiAnalysisId: null,
      }),
    );

    assert.match(html, /data-testid="ai-state-unavailable"/);
    assert.match(html, /No AI explanation available/);
  });

  it("renders empty claims indicator when claims list is empty", () => {
    const emptyClaimsData: AIAnalysisResponse = {
      ...MOCK_COMPLETED_ANALYSIS,
      output_structured: {
        summary: "No components were modified.",
        claims: [],
        confidence: "medium",
        caveats: [],
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(AIExplanationPanel, {
        initialData: emptyClaimsData,
        aiAnalysisId: "ai-123",
      }),
    );

    assert.match(html, /data-testid="ai-claims-empty"/);
    assert.match(html, /No component claims generated/);
  });

  describe("Lifecycle, Discovery Race, Terminal Polling and Stale Responses", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("transitions from unavailable to pending when AIAnalysis record becomes discoverable via polling (discovery race)", async () => {
      let impactPollCount = 0;
      let aiPollCount = 0;
      let discoveredIdReported: string | null = null;

      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const DISCOVERED_AI_ID = "b0000000-0000-4000-8000-000000000002";

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string) => {
          if (url.includes(`/api/v1/impact-analyses/${RACE_IMPACT_ID}`)) {
            impactPollCount += 1;
            if (impactPollCount === 1) {
              // Worker hasn't created the pending record yet: race window
              return {
                ok: true,
                status: 200,
                async json() {
                  return {
                    id: RACE_IMPACT_ID,
                    pull_request_id: "pr-123",
                    ai_analysis_id: null,
                    ai_analysis_status: null,
                    direct_impact: [],
                    downstream_impact: [],
                  };
                },
              };
            }
            // Worker has now committed the pending record
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  id: RACE_IMPACT_ID,
                  pull_request_id: "pr-123",
                  ai_analysis_id: DISCOVERED_AI_ID,
                  ai_analysis_status: "pending",
                  direct_impact: [],
                  downstream_impact: [],
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
                  ...MOCK_COMPLETED_ANALYSIS,
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

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
          onAIAnalysisDiscovered: (id) => {
            discoveredIdReported = id;
          },
        });

        // 1. Initial state: before discovery poll fires, panel renders unavailable
        assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
        assert.equal(discoveredIdReported, null);

        // 2. Advance time 2000ms: first discovery poll fires, returns null
        await vi.advanceTimersByTimeAsync(2000);
        assert.equal(impactPollCount, 1);
        assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
        assert.equal(discoveredIdReported, null);

        // 3. Advance time 2000ms: second discovery poll fires, discovers ID!
        await vi.advanceTimersByTimeAsync(2000);
        assert.equal(impactPollCount, 2);
        assert.equal(discoveredIdReported, DISCOVERED_AI_ID);

        // 4. Panel transitions from unavailable to pending!
        assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);
        assert.match(harness.getHtml(), /Generating evidence-grounded AI explanation/);
        assert.equal(aiPollCount, 1);

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("stops discovery polling after MAX_AI_DISCOVERY_ATTEMPTS if no AIAnalysis record is created", async () => {
      let impactPollCount = 0;
      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          async json() {
            impactPollCount += 1;
            return {
              id: RACE_IMPACT_ID,
              pull_request_id: "pr-123",
              ai_analysis_id: null,
              direct_impact: [],
              downstream_impact: [],
            };
          },
        })) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
        });

        // Advance well beyond MAX_AI_DISCOVERY_ATTEMPTS (5 attempts * 2000ms = 10,000ms)
        await vi.advanceTimersByTimeAsync(25000);

        // Must strictly stop at MAX_AI_DISCOVERY_ATTEMPTS (5) and NOT poll indefinitely
        assert.equal(impactPollCount, MAX_AI_DISCOVERY_ATTEMPTS);
        assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
        assert.match(harness.getHtml(), /data-testid="ai-check-again-btn"/);
        assert.match(harness.getHtml(), />Check again</);

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("user-triggered retry starts a new bounded discovery cycle", async () => {
      let impactPollCount = 0;
      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          async json() {
            impactPollCount += 1;
            return {
              id: RACE_IMPACT_ID,
              pull_request_id: "pr-123",
              ai_analysis_id: null,
              direct_impact: [],
              downstream_impact: [],
            };
          },
        })) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
        });

        // 1. Initial 5 attempts elapse
        await vi.advanceTimersByTimeAsync(25000);
        assert.equal(impactPollCount, MAX_AI_DISCOVERY_ATTEMPTS);
        assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);
        assert.match(harness.getHtml(), /data-testid="ai-check-again-btn"/);
        assert.match(harness.getHtml(), />Check again</);

        // 2. User clicks Check again
        const btnProps = harness.findProps("ai-check-again-btn");
        assert.ok(btnProps);
        assert.equal(btnProps["disabled"], false);
        (btnProps["onClick"] as () => void)();

        // Button indicates active checking and becomes disabled
        assert.match(harness.getHtml(), /Checking\.\.\./);
        const activeBtnProps = harness.findProps("ai-check-again-btn");
        assert.equal(activeBtnProps?.["disabled"], true);

        // 3. Next bounded cycle runs 5 more attempts
        await vi.advanceTimersByTimeAsync(25000);
        assert.equal(
          impactPollCount,
          MAX_AI_DISCOVERY_ATTEMPTS * 2,
          "User-triggered retry must execute exactly one new bounded discovery cycle (5 attempts)",
        );
        // Polling stops and Check again becomes re-enabled
        assert.match(harness.getHtml(), />Check again</);
        assert.equal(harness.findProps("ai-check-again-btn")?.["disabled"], false);

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("a record discovered during the retry transitions to pending", async () => {
      let impactPollCount = 0;
      let aiPollCount = 0;
      let discoveredIdReported: string | null = null;
      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const DISCOVERED_AI_ID = "b0000000-0000-4000-8000-000000000002";

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string) => {
          if (url.includes(`/api/v1/impact-analyses/${RACE_IMPACT_ID}`)) {
            impactPollCount += 1;
            if (impactPollCount <= MAX_AI_DISCOVERY_ATTEMPTS) {
              // Initial budget: not yet available
              return {
                ok: true,
                status: 200,
                async json() {
                  return {
                    id: RACE_IMPACT_ID,
                    pull_request_id: "pr-123",
                    ai_analysis_id: null,
                    ai_analysis_status: null,
                    direct_impact: [],
                    downstream_impact: [],
                  };
                },
              };
            }
            // Discovered during retry on 1st tick of new budget
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  id: RACE_IMPACT_ID,
                  pull_request_id: "pr-123",
                  ai_analysis_id: DISCOVERED_AI_ID,
                  ai_analysis_status: "pending",
                  direct_impact: [],
                  downstream_impact: [],
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
                  ...MOCK_COMPLETED_ANALYSIS,
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

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
          onAIAnalysisDiscovered: (id) => {
            discoveredIdReported = id;
          },
        });

        // 1. Initial 5 attempts elapse without finding record
        await vi.advanceTimersByTimeAsync(25000);
        assert.equal(impactPollCount, 5);
        assert.equal(discoveredIdReported, null);
        assert.match(harness.getHtml(), /data-testid="ai-state-unavailable"/);

        // 2. Click Check again
        const btnProps = harness.findProps("ai-check-again-btn");
        assert.ok(btnProps);
        (btnProps["onClick"] as () => void)();

        // 3. Advance timer to first retry attempt (2000ms)
        await vi.advanceTimersByTimeAsync(2000);
        assert.equal(impactPollCount, 6);
        assert.equal(discoveredIdReported, DISCOVERED_AI_ID);

        // 4. Panel transitions to pending!
        assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);
        assert.match(harness.getHtml(), /Generating evidence-grounded AI explanation/);
        assert.equal(aiPollCount, 1);

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("repeated clicks cannot create overlapping discovery loops", async () => {
      let impactPollCount = 0;
      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          async json() {
            impactPollCount += 1;
            return {
              id: RACE_IMPACT_ID,
              pull_request_id: "pr-123",
              ai_analysis_id: null,
              direct_impact: [],
              downstream_impact: [],
            };
          },
        })) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
        });

        // Initial budget expires
        await vi.advanceTimersByTimeAsync(25000);
        assert.equal(impactPollCount, 5);

        // Rapid repeated clicks
        const btnProps = harness.findProps("ai-check-again-btn");
        assert.ok(btnProps);
        const onClick = btnProps["onClick"] as () => void;
        onClick();
        onClick();
        onClick();

        // Advance timers to allow the single retry cycle to finish
        await vi.advanceTimersByTimeAsync(25000);

        // Must strictly be 10 total polls (5 initial + 5 from the single retry cycle), not 15 or 20
        assert.equal(
          impactPollCount,
          10,
          "Repeated clicks must not spawn duplicate or overlapping polling loops",
        );

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("unmount cancels the active discovery timer during user-triggered retry", async () => {
      let impactPollCount = 0;
      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          async json() {
            impactPollCount += 1;
            return {
              id: RACE_IMPACT_ID,
              pull_request_id: "pr-123",
              ai_analysis_id: null,
              direct_impact: [],
              downstream_impact: [],
            };
          },
        })) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
        });

        // Initial budget expires
        await vi.advanceTimersByTimeAsync(25000);
        assert.equal(impactPollCount, 5);

        // User triggers retry
        const btnProps = harness.findProps("ai-check-again-btn");
        assert.ok(btnProps);
        (btnProps["onClick"] as () => void)();

        // Unmount while retry timer is active
        harness.unmount();

        // Advance timers by 25 seconds: no additional poll should fire
        await vi.advanceTimersByTimeAsync(25000);
        assert.equal(
          impactPollCount,
          5,
          "No retry poll requests should fire after unmount",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("polls only while pending and stops polling immediately upon completed terminal state", async () => {
      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCount += 1;
          if (fetchCount === 1) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  ...MOCK_COMPLETED_ANALYSIS,
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
              return MOCK_COMPLETED_ANALYSIS;
            },
          };
        }) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          aiAnalysisId: "ai-123",
          impactStatus: "completed",
        });

        // Initial fetch loads pending
        await vi.advanceTimersByTimeAsync(10);
        assert.equal(fetchCount, 1);
        assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);

        // Advance poll timer (2500ms): second fetch returns completed
        await vi.advanceTimersByTimeAsync(2500);
        assert.equal(fetchCount, 2);
        assert.match(harness.getHtml(), /data-testid="ai-narration-badge"/);
        assert.match(harness.getHtml(), /Model Confidence: high/);

        // Advance further (10,000ms): prove no further requests are made!
        await vi.advanceTimersByTimeAsync(10000);
        assert.equal(fetchCount, 2, "No further poll requests must be dispatched after completed");

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("polls only while pending and stops polling immediately upon rejected terminal state with raw output withheld", async () => {
      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCount += 1;
          if (fetchCount === 1) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  ...MOCK_COMPLETED_ANALYSIS,
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
                ...MOCK_COMPLETED_ANALYSIS,
                status: "rejected",
                validation_status: "rejected",
                output_text: null,
                output_structured: null,
              };
            },
          };
        }) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          aiAnalysisId: "ai-123",
          impactStatus: "completed",
        });

        await vi.advanceTimersByTimeAsync(10);
        assert.equal(fetchCount, 1);
        assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);

        await vi.advanceTimersByTimeAsync(2500);
        assert.equal(fetchCount, 2);
        assert.match(harness.getHtml(), /data-testid="ai-state-rejected"/);
        assert.match(harness.getHtml(), /AI Explanation Rejected/);

        // Advance further: polling must have halted
        await vi.advanceTimersByTimeAsync(10000);
        assert.equal(fetchCount, 2, "No further poll requests after rejected");

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("polls only while pending and stops polling immediately upon failed terminal state without displaying unvalidated output", async () => {
      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCount += 1;
          if (fetchCount === 1) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  ...MOCK_COMPLETED_ANALYSIS,
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
                ...MOCK_COMPLETED_ANALYSIS,
                status: "failed",
                validation_status: null,
                output_text: "UNVALIDATED_CORRUPT_PROSE",
                output_structured: null,
                error_message: "Gateway timeout 504",
              };
            },
          };
        }) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          aiAnalysisId: "ai-123",
          impactStatus: "completed",
        });

        await vi.advanceTimersByTimeAsync(10);
        assert.equal(fetchCount, 1);
        assert.match(harness.getHtml(), /data-testid="ai-state-pending"/);

        await vi.advanceTimersByTimeAsync(2500);
        assert.equal(fetchCount, 2);
        assert.match(harness.getHtml(), /data-testid="ai-state-failed"/);
        assert.match(harness.getHtml(), /AI Explanation Unavailable/);

        // Verify unvalidated output is suppressed
        assert.ok(!harness.getHtml().includes("UNVALIDATED_CORRUPT_PROSE"));

        // Advance further: polling halted
        await vi.advanceTimersByTimeAsync(10000);
        assert.equal(fetchCount, 2, "No further poll requests after failed");

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("renders persisted failed status correctly with no unvalidated output displayed", () => {
      const failedWithRogueText: AIAnalysisResponse = {
        ...MOCK_COMPLETED_ANALYSIS,
        status: "failed",
        validation_status: null,
        output_text: "POTENTIAL_UNVALIDATED_OUTPUT_LEAK",
        output_structured: {
          summary: "POTENTIAL_UNVALIDATED_OUTPUT_LEAK",
          claims: [{ text: "LEAKED_CLAIM", evidence_ids: ["ev-1"] }],
          confidence: "low",
          caveats: [],
        },
        error_message: "Upstream rate limit reached.",
      };

      const html = renderToStaticMarkup(
        React.createElement(AIExplanationPanel, {
          initialData: failedWithRogueText,
          aiAnalysisId: "ai-123",
        }),
      );

      assert.match(html, /data-testid="ai-state-failed"/);
      assert.match(html, /AI Explanation Unavailable/);
      assert.ok(!html.includes("POTENTIAL_UNVALIDATED_OUTPUT_LEAK"));
      assert.ok(!html.includes("LEAKED_CLAIM"));
    });

    it("discards responses from superseded AIAnalysis IDs so old responses cannot overwrite current view", async () => {
      let resolveOldRequest!: () => void;
      let resolveNewRequest!: () => void;

      const OLD_AI_ID = "c0000000-0000-4000-8000-000000000003";
      const NEW_AI_ID = "d0000000-0000-4000-8000-000000000004";

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = ((url: string) => {
          if (url.includes(OLD_AI_ID)) {
            return new Promise((resolve) => {
              resolveOldRequest = () =>
                resolve({
                  ok: true,
                  status: 200,
                  async json() {
                    return {
                      ...MOCK_COMPLETED_ANALYSIS,
                      id: OLD_AI_ID,
                      output_text: "OLD_STALE_SUMMARY",
                    };
                  },
                });
            });
          }
          if (url.includes(NEW_AI_ID)) {
            return new Promise((resolve) => {
              resolveNewRequest = () =>
                resolve({
                  ok: true,
                  status: 200,
                  async json() {
                    return {
                      ...MOCK_COMPLETED_ANALYSIS,
                      id: NEW_AI_ID,
                      output_text: "NEW_FRESH_SUMMARY",
                    };
                  },
                });
            });
          }
          throw new Error(`Unexpected URL ${url}`);
        }) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        // Mount with old ID
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          aiAnalysisId: OLD_AI_ID,
          impactStatus: "completed",
        });

        // Allow mount to dispatch fetch for OLD_AI_ID
        await Promise.resolve();
        await Promise.resolve();

        // Prop switches to new ID before old request finishes
        harness.render({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          aiAnalysisId: NEW_AI_ID,
          impactStatus: "completed",
        });

        // Allow microtasks to run so fetch for NEW_AI_ID is invoked
        await Promise.resolve();
        await Promise.resolve();

        // Resolve new request first
        resolveNewRequest();
        await vi.advanceTimersByTimeAsync(10);
        assert.match(harness.getHtml(), /NEW_FRESH_SUMMARY/);

        // Now old request finishes late
        resolveOldRequest();
        await vi.advanceTimersByTimeAsync(10);

        // Old request MUST NOT overwrite view
        assert.match(harness.getHtml(), /NEW_FRESH_SUMMARY/);
        assert.ok(!harness.getHtml().includes("OLD_STALE_SUMMARY"));

        harness.unmount();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("cleans up poll and discovery timers on unmount", async () => {
      let impactPollCount = 0;
      const RACE_IMPACT_ID = "a0000000-0000-4000-8000-000000000001";
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          async json() {
            impactPollCount += 1;
            return {
              id: RACE_IMPACT_ID,
              pull_request_id: "pr-123",
              ai_analysis_id: null,
              direct_impact: [],
              downstream_impact: [],
            };
          },
        })) as unknown as typeof fetch;

        const harness = createTestHarness(AIExplanationPanel);
        harness.mount({
          apiUrl: "http://localhost:3000",
          getToken: async () => "token-1",
          impactAnalysisId: RACE_IMPACT_ID,
          aiAnalysisId: null,
          impactStatus: "completed",
        });

        // Unmount immediately
        harness.unmount();

        // Advance timers by 10 seconds: no poll should have fired
        await vi.advanceTimersByTimeAsync(10000);
        assert.equal(impactPollCount, 0, "No poll requests should fire after unmount");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("fetchAIAnalysis data helper (Step 62)", () => {
  it("rejects empty AI analysis ID", async () => {
    const result = await fetchAIAnalysis({
      apiUrl: "http://localhost:3000",
      aiAnalysisId: "",
      getToken: async () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_id");
  });

  it("handles non-ok HTTP responses with typed error code and message", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: false,
        status: 404,
        async json() {
          return { error: { code: "not_found", message: "AI analysis not found." } };
        },
      })) as unknown as typeof fetch;

      const result = await fetchAIAnalysis({
        apiUrl: "http://localhost:3000",
        aiAnalysisId: "ai-1234-5678",
        getToken: async () => "token-1",
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, "not_found");
      assert.equal(result.message, "AI analysis not found.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles network failure safely without throwing", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error("Failed to connect to API server");
      }) as unknown as typeof fetch;

      const result = await fetchAIAnalysis({
        apiUrl: "http://localhost:3000",
        aiAnalysisId: "ai-1234-5678",
        getToken: async () => "token-1",
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, "network_error");
      assert.equal(result.message, "Failed to connect to API server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
