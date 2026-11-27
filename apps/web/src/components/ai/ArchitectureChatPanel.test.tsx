import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIAnalysisResponse } from "@fluxora/shared-types";

import {
  ArchitectureChatPanel,
  type ChatTurnMessage,
} from "./ArchitectureChatPanel.tsx";
import { submitChatQuery } from "./chat-query-data.ts";

const REPO_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const AI_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID = "77777777-7777-4777-8777-777777777777";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ArchitectureChatPanel & submitChatQuery", () => {
  it("renders empty state and accessible input", () => {
    const html = renderToStaticMarkup(
      React.createElement(ArchitectureChatPanel, {
        repositoryId: REPO_ID,
        analysisRunId: RUN_ID,
      }),
    );

    expect(html).toContain("data-testid=\"chat-empty-state\"");
    expect(html).toContain("data-testid=\"chat-question-input\"");
    expect(html).toContain("Ask an architecture question");
    expect(html).toContain("query_graph");
    expect(html).toContain("get_evidence");
    expect(html).toContain("run_simulation");
  });

  it("renders pending, completed (with tool activity and evidence citations), rejected, and failed states", () => {
    const completedAnalysis: AIAnalysisResponse = {
      id: AI_ID,
      subject_type: "chat_query",
      subject_id: "55555555-5555-4555-8555-555555555555",
      status: "completed",
      model_used: "claude-sonnet-5-5",
      prompt_version: "chat-query-v1",
      input_evidence_ids: [EVIDENCE_ID],
      output_text: "PaymentService calls CheckoutService.",
      output_structured: {
        summary: "PaymentService calls CheckoutService.",
        claims: [
          {
            text: "PaymentService directly invokes CheckoutService.",
            evidence_ids: [EVIDENCE_ID],
          },
        ],
        confidence: "high",
        caveats: ["Bounded to 2-hop traversal."],
      },
      validation_status: "passed",
      token_count: 220,
      cost_usd: 0.001,
      latency_ms: 420,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const messages: ChatTurnMessage[] = [
      { id: "u1", role: "user", content: "What calls CheckoutService?" },
      { id: "a1", role: "assistant", content: "", status: "pending" },
      {
        id: "a2",
        role: "assistant",
        content: "PaymentService calls CheckoutService.",
        status: "completed",
        aiAnalysis: completedAnalysis,
        toolActivity: [
          {
            tool_name: "query_graph",
            status: "completed",
            summary: "Traversed 2 nodes.",
          },
        ],
      },
      {
        id: "a3",
        role: "assistant",
        content: "",
        status: "rejected",
        errorMessage: "Response withheld: citations failed grounding validation.",
        questionForRetry: "Retry me",
      },
      {
        id: "a4",
        role: "assistant",
        content: "",
        status: "failed",
        errorMessage: "Network timeout",
        questionForRetry: "Retry me",
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ArchitectureChatPanel, {
        repositoryId: REPO_ID,
        analysisRunId: RUN_ID,
        initialMessages: messages,
        evidencePool: [
          {
            id: EVIDENCE_ID,
            subject_type: "graph_edge",
            subject_id: "node-1",
            file_path: "src/payment.ts",
            line_start: 10,
            line_end: 15,
            relationship_description: "Calls CheckoutService",
            confidence: 0.95,
          },
        ],
        repositoryName: "acme/shop",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      }),
    );

    expect(html).toContain("data-testid=\"chat-message-user\"");
    expect(html).toContain("data-testid=\"chat-pending-state\"");
    expect(html).toContain("data-testid=\"chat-tool-activity\"");
    expect(html).toContain("Graph Traversal");
    expect(html).toContain("PaymentService calls CheckoutService.");
    expect(html).toContain("PaymentService directly invokes CheckoutService.");
    expect(html).toContain("high confidence");
    expect(html).toContain("Bounded to 2-hop traversal.");
    expect(html).toContain("data-testid=\"chat-rejected-state\"");
    expect(html).toContain("data-testid=\"chat-failed-state\"");
    expect(html).toContain("data-testid=\"chat-retry-button\"");
  });

  it("submits authenticated POST /api/v1/chat/query and handles failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chat_query_id: "55555555-5555-4555-8555-555555555555",
          ai_analysis_id: AI_ID,
          status: "pending",
          job_id: "job-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: "forbidden", message: "Access denied" },
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const okRes = await submitChatQuery({
      apiUrl: "http://localhost:3001",
      getToken: async () => "tok-1",
      repositoryId: REPO_ID,
      analysisRunId: RUN_ID,
      question: "What calls Checkout?",
    });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.data.ai_analysis_id).toBe(AI_ID);
    }

    const errRes = await submitChatQuery({
      apiUrl: "http://localhost:3001",
      getToken: async () => "tok-1",
      repositoryId: REPO_ID,
      analysisRunId: RUN_ID,
      question: "What calls Checkout?",
    });
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) {
      expect(errRes.code).toBe("forbidden");
    }
  });
});
