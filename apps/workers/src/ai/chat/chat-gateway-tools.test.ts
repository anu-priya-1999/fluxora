import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { AnthropicProviderAdapter } from "../anthropic-adapter.ts";
import { MockModelGateway, MockModelProvider } from "../mock-gateway.ts";
import {
  CHAT_TOOL_DEFINITIONS,
  executeControlledChatTool,
  type ChatToolDependencies,
  type DbPool,
} from "./tools.ts";
import type { ToolExecutionContext } from "./types.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_RUN_ID = "44444444-4444-4444-8444-444444444444";
const CHAT_ID = "55555555-5555-4555-8555-555555555555";
const NODE_ID = "66666666-6666-4666-8666-666666666666";
const EVIDENCE_ID = "77777777-7777-4777-8777-777777777777";
const SIM_ID = "88888888-8888-4888-8888-888888888888";
const SCEN_ID = "99999999-9999-4999-8999-999999999999";
const SIM_EVIDENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeToolCtx(): ToolExecutionContext {
  return {
    trusted: {
      organizationId: ORG_ID,
      repositoryId: REPO_ID,
      analysisRunId: RUN_ID,
      chatQueryId: CHAT_ID,
    },
    allowedEvidenceIds: new Set<string>(),
    toolActivity: [],
    simulationCountInRequest: { count: 0 },
    simulationCountInSession: { count: 0 },
    simulationCache: new Map(),
  };
}

describe("Provider-independent tool calling & Anthropic/Mock adapters", () => {
  it("maps tool definitions, tool_use, and tool_result blocks in AnthropicProviderAdapter", async () => {
    const createMock = vi.fn().mockResolvedValue({
      id: "msg_123",
      model: "claude-sonnet-5-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 45 },
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "query_graph",
          input: { start_node: NODE_ID, direction: "outgoing", max_depth: 2 },
        },
      ],
    } as unknown as Anthropic.Message);

    const adapter = new AnthropicProviderAdapter({
      client: { messages: { create: createMock } },
    });

    const result = await adapter.generate({
      model: "claude-sonnet-5-5",
      systemInstruction: "System",
      tools: CHAT_TOOL_DEFINITIONS,
      messages: [
        { role: "user", content: "What calls PaymentService?" },
        {
          role: "assistant",
          content: "",
          blocks: [
            {
              type: "tool_use",
              id: "toolu_prev",
              name: "get_evidence",
              input: { evidence_id: EVIDENCE_ID },
            },
          ],
        },
        {
          role: "user",
          content: "",
          blocks: [
            {
              type: "tool_result",
              toolUseId: "toolu_prev",
              content: '{"evidence_id":"' + EVIDENCE_ID + '"}',
            },
          ],
        },
      ],
      maxTokens: 1024,
      timeoutMs: 5000,
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses?.[0]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "query_graph",
      input: { start_node: NODE_ID, direction: "outgoing", max_depth: 2 },
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const sentPayload = createMock.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(sentPayload.tools).toHaveLength(3);
  });

  it("supports queued tool_use and tool_result round trips in MockModelGateway", async () => {
    const provider = new MockModelProvider({
      responseQueue: [
        {
          text: "",
          toolUses: [
            {
              type: "tool_use",
              id: "mock-tu-1",
              name: "get_evidence",
              input: { evidence_id: EVIDENCE_ID },
            },
          ],
          stopReason: "tool_use",
        },
        {
          text: '{"summary":"Done","claims":[],"confidence":"high","caveats":[]}',
          stopReason: "end_turn",
        },
      ],
    });
    const gateway = new MockModelGateway(provider);

    const first = await gateway.generate({
      taskType: "chat_query",
      promptVersion: "chat-query-v1",
      tools: CHAT_TOOL_DEFINITIONS,
      messages: [{ role: "user", content: "Check evidence" }],
    });
    expect(first.toolUses).toHaveLength(1);
    expect(first.toolUses?.[0]?.name).toBe("get_evidence");

    const second = await gateway.generate({
      taskType: "chat_query",
      promptVersion: "chat-query-v1",
      tools: CHAT_TOOL_DEFINITIONS,
      messages: [
        { role: "user", content: "Check evidence" },
        {
          role: "assistant",
          content: "",
          blocks: first.toolUses!,
        },
        {
          role: "user",
          content: "",
          blocks: [
            {
              type: "tool_result",
              toolUseId: "mock-tu-1",
              content: '{"ok":true}',
            },
          ],
        },
      ],
    });
    expect(second.toolUses).toBeUndefined();
    expect(second.text).toContain('"summary":"Done"');
  });
});

describe("Controlled chat tools validation, isolation, and limits", () => {
  const fakePool = {} as DbPool;

  it("rejects unknown tools and malformed arguments safely", async () => {
    const ctx = makeToolCtx();
    const deps: ChatToolDependencies = { pool: fakePool };

    const unknownRes = await executeControlledChatTool(
      "read_arbitrary_file",
      { path: "/etc/passwd" },
      ctx,
      deps,
    );
    expect(unknownRes.isError).toBe(true);
    expect(unknownRes.content).toContain("unknown_tool");

    const nonObjectRes = await executeControlledChatTool(
      "query_graph",
      "not-an-object",
      ctx,
      deps,
    );
    expect(nonObjectRes.isError).toBe(true);
    expect(nonObjectRes.content).toContain("invalid_arguments");

    const extraKeyRes = await executeControlledChatTool(
      "query_graph",
      { start_node: NODE_ID, organizationId: "attacker-org" },
      ctx,
      deps,
    );
    expect(extraKeyRes.isError).toBe(true);
    expect(extraKeyRes.content).toContain("Unrecognized argument");

    const badDepthRes = await executeControlledChatTool(
      "query_graph",
      { start_node: NODE_ID, max_depth: 999 },
      ctx,
      deps,
    );
    expect(badDepthRes.isError).toBe(true);
    expect(badDepthRes.content).toContain("max_depth");
  });

  it("enforces tenant and analysis-run isolation in get_evidence", async () => {
    const ctx = makeToolCtx();
    const deps: ChatToolDependencies = {
      pool: fakePool,
      getEvidenceById: vi.fn().mockResolvedValue({
        id: EVIDENCE_ID,
        analysisRunId: OTHER_RUN_ID, // Cross-run evidence must be rejected
        subjectType: "graph_edge",
        subjectId: NODE_ID,
        filePath: "src/secret.ts",
        relationshipDescription: "secret",
        confidence: 1,
        metadata: {},
        createdAt: new Date(),
      }),
    };

    const res = await executeControlledChatTool(
      "get_evidence",
      { evidence_id: EVIDENCE_ID },
      ctx,
      deps,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("evidence_not_found");
    expect(ctx.allowedEvidenceIds.size).toBe(0);
  });

  it("enforces simulation execution limits and idempotency", async () => {
    const ctx = makeToolCtx();
    const createScenarioMock = vi.fn().mockResolvedValue({
      id: SCEN_ID,
      organizationId: ORG_ID,
      repositoryId: REPO_ID,
      name: "Sim",
      targetNodeId: NODE_ID,
      failureType: "unavailable",
      parameters: {},
      createdAt: new Date(),
    });
    const createSimMock = vi.fn().mockResolvedValue({
      id: SIM_ID,
      scenarioId: SCEN_ID,
      analysisRunId: RUN_ID,
      status: "pending",
      createdAt: new Date(),
    });
    const execSimMock = vi.fn().mockResolvedValue({
      simulation: { id: SIM_ID, status: "completed" },
      engineResult: { converged: true, iterations: 1, ruleTableVersion: "1.0.0", results: [], nodeStates: new Map() },
      savedResults: [
        {
          id: "res-1",
          simulationId: SIM_ID,
          nodeId: NODE_ID,
          resultingState: "failed",
          propagationPath: [],
          ruleApplied: "target_failure",
          assumptions: [],
          confidence: 1,
          createdAt: new Date(),
        },
      ],
      evidence: [
        {
          id: SIM_EVIDENCE_ID,
          analysisRunId: RUN_ID,
          subjectType: "simulation_state",
          subjectId: NODE_ID,
          filePath: "src/pay.ts",
          relationshipDescription: "Target failed",
          confidence: 1,
          metadata: { simulationId: SIM_ID },
          createdAt: new Date(),
        },
      ],
    });
    const listSimEvMock = vi.fn().mockResolvedValue([
      {
        id: SIM_EVIDENCE_ID,
        analysisRunId: RUN_ID,
        subjectType: "simulation_state",
        subjectId: NODE_ID,
        filePath: "src/pay.ts",
        relationshipDescription: "Target failed",
        confidence: 1,
        metadata: { simulationId: SIM_ID },
        createdAt: new Date(),
      },
    ]);

    const deps: ChatToolDependencies = {
      pool: fakePool,
      getGraphNodeById: vi.fn().mockResolvedValue({
        id: NODE_ID,
        analysisRunId: RUN_ID,
        canonicalId: "mod:pay",
        nodeType: "module",
        name: "pay.ts",
        metadata: {},
        confidence: 1,
        createdAt: new Date(),
      }),
      createScenario: createScenarioMock,
      createSimulation: createSimMock,
      executeSimulation: execSimMock,
      listSimulationEvidence: listSimEvMock,
    };

    // First call executes simulation
    const first = await executeControlledChatTool(
      "run_simulation",
      { target_node: NODE_ID, failure_type: "unavailable" },
      ctx,
      deps,
    );
    expect(first.isError).toBe(false);
    expect(ctx.allowedEvidenceIds.has(SIM_EVIDENCE_ID)).toBe(true);
    expect(execSimMock).toHaveBeenCalledTimes(1);

    // Identical call reuses idempotent cached result without re-executing
    const duplicate = await executeControlledChatTool(
      "run_simulation",
      { target_node: NODE_ID, failure_type: "unavailable" },
      ctx,
      deps,
    );
    expect(duplicate.isError).toBe(false);
    expect(execSimMock).toHaveBeenCalledTimes(1);

    // Second distinct simulation succeeds (limit = 2)
    const second = await executeControlledChatTool(
      "run_simulation",
      { target_node: NODE_ID, failure_type: "latency" },
      ctx,
      deps,
    );
    expect(second.isError).toBe(false);
    expect(execSimMock).toHaveBeenCalledTimes(2);

    // Third distinct simulation is blocked by per-request limit
    ctx.simulationCache.clear();
    const third = await executeControlledChatTool(
      "run_simulation",
      { target_node: NODE_ID, failure_type: "unavailable" },
      ctx,
      deps,
    );
    expect(third.isError).toBe(true);
    expect(third.content).toContain("simulation_limit_exceeded");
  });
});
