/**
 * @file orchestrator.ts
 * Tool-Calling Architecture Chat Orchestrator (Phase 9 Step 64).
 *
 * Coordinates:
 * 1. Idempotency guard via AIAnalysis (`subject_type = 'chat_query'`, `subject_id = chatQueryId`)
 * 2. Tenant-scoped repository and analysis-run ownership verification
 * 3. Bounded conversation & prompt construction (`chat-query-v1`)
 * 4. Multi-round bounded tool-calling loop through provider-independent ModelGateway
 * 5. Controlled execution of ONLY `query_graph`, `get_evidence`, and `run_simulation`
 * 6. Evidence manifest accumulation from successful tool outputs
 * 7. Strict structured-output + grounding validation (`chat-query-output-v1`) with max 1 corrective retry
 * 8. Usage, cost, and latency aggregation across all rounds
 * 9. Durable AIAnalysis persistence (never persisting raw invalid output or secrets)
 */

import {
  getAIAnalysisBySubject,
  getAnalysisRunById,
  getPool,
  getRepositoryById,
  saveAIAnalysis,
} from "@fluxora/db";
import {
  getTracer,
  markSpanError,
  markSpanSuccess,
} from "@fluxora/observability";
import type {
  AIAnalysis,
  AIExplanationOutputDto,
  ChatHistoryMessageDto,
} from "@fluxora/shared-types";

import { createModelGateway } from "../factory.ts";
import type { ValidationIssue } from "../structured-output/index.ts";
import type {
  ModelGateway,
  ModelGatewayResponse,
  ModelMessage,
  ModelMessageContentBlock,
  ModelToolResultBlock,
} from "../types.ts";
import { buildChatQueryInitialRequest } from "./request-builder.ts";
import {
  executeControlledChatTool,
  type ChatToolDependencies,
  type DbPool,
} from "./tools.ts";
import {
  CHAT_EXECUTION_LIMITS,
  CHAT_QUERY_PROMPT_VERSION,
  type ToolExecutionContext,
} from "./types.ts";
import { validateChatQueryWithRetry } from "./validator.ts";

const tracer = getTracer("@fluxora/workers");

export interface OrchestrateChatQueryOptions {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly analysisRunId: string;
  readonly chatQueryId: string;
  readonly question: string;
  readonly history?: readonly ChatHistoryMessageDto[] | undefined;
  readonly sessionId?: string | undefined;
  readonly forceRetry?: boolean | undefined;
  readonly maxExecutionTimeMs?: number | undefined;
  readonly maxToolRounds?: number | undefined;
  readonly maxTotalToolCalls?: number | undefined;
}

export type ChatQueryOrchestrationResult =
  | {
      readonly status: "completed";
      readonly aiAnalysis: AIAnalysis;
    }
  | {
      readonly status: "already_completed";
      readonly aiAnalysis: AIAnalysis;
    }
  | {
      readonly status: "rejected";
      readonly aiAnalysis?: AIAnalysis | undefined;
      readonly errors: readonly ValidationIssue[];
    }
  | {
      readonly status: "failed";
      readonly aiAnalysis?: AIAnalysis | undefined;
      readonly error: string;
    };

export interface ChatQueryOrchestratorDependencies {
  pool?: DbPool | undefined;
  gateway?: ModelGateway | undefined;
  getAIAnalysisBySubject?: typeof getAIAnalysisBySubject | undefined;
  saveAIAnalysis?: typeof saveAIAnalysis | undefined;
  getRepositoryById?: typeof getRepositoryById | undefined;
  getAnalysisRunById?: typeof getAnalysisRunById | undefined;
  toolDeps?: Partial<Omit<ChatToolDependencies, "pool">> | undefined;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");
  }
  return String(error);
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  gatewayCalls: number;
  usedFallback: boolean;
  lastModel: string | null;
  lastProvider: string | null;
}

function accumulateGatewayResponse(
  acc: UsageAccumulator,
  res: ModelGatewayResponse,
): void {
  acc.inputTokens += res.inputTokens ?? 0;
  acc.outputTokens += res.outputTokens ?? 0;
  acc.costUsd += res.costUsd ?? 0;
  acc.latencyMs += res.latencyMs;
  acc.gatewayCalls += 1;
  acc.usedFallback = acc.usedFallback || res.usedFallback;
  acc.lastModel = res.model;
  acc.lastProvider = res.provider;
}

/**
 * Orchestrates a bounded, tool-calling architecture chat query end-to-end.
 */
export async function orchestrateChatQuery(
  options: OrchestrateChatQueryOptions,
  deps?: ChatQueryOrchestratorDependencies,
): Promise<ChatQueryOrchestrationResult> {
  const {
    organizationId,
    repositoryId,
    analysisRunId,
    chatQueryId,
    question,
    history,
    sessionId,
  } = options;

  const pool = deps?.pool ?? getPool();
  const getSubject = deps?.getAIAnalysisBySubject ?? getAIAnalysisBySubject;
  const save = deps?.saveAIAnalysis ?? saveAIAnalysis;
  const fetchRepo = deps?.getRepositoryById ?? getRepositoryById;
  const fetchRun = deps?.getAnalysisRunById ?? getAnalysisRunById;
  const gateway = deps?.gateway ?? (await createModelGateway());

  const maxExecutionTimeMs =
    options.maxExecutionTimeMs ?? CHAT_EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS;
  const maxToolRounds =
    options.maxToolRounds ?? CHAT_EXECUTION_LIMITS.MAX_TOOL_ROUNDS;
  const maxTotalToolCalls =
    options.maxTotalToolCalls ?? CHAT_EXECUTION_LIMITS.MAX_TOTAL_TOOL_CALLS;

  const span = tracer.startSpan("fluxora.ai.orchestrate_chat_query", {
    attributes: {
      "fluxora.organization_id": organizationId,
      "fluxora.repository_id": repositoryId,
      "fluxora.analysis_run_id": analysisRunId,
      "fluxora.chat_query_id": chatQueryId,
      "fluxora.task_type": "chat_query",
    },
  });

  let currentRecord: AIAnalysis | undefined;
  const usage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    gatewayCalls: 0,
    usedFallback: false,
    lastModel: null,
    lastProvider: null,
  };

  const toolCtx: ToolExecutionContext = {
    trusted: {
      organizationId,
      repositoryId,
      analysisRunId,
      chatQueryId,
      sessionId,
    },
    allowedEvidenceIds: new Set<string>(),
    toolActivity: [],
    simulationCountInRequest: { count: 0 },
    simulationCountInSession: { count: 0 },
    simulationCache: new Map<string, Record<string, unknown>>(),
  };

  const toolDeps: ChatToolDependencies = {
    pool,
    ...deps?.toolDeps,
  };

  try {
    // 1. Idempotency Guard
    let existing: AIAnalysis | null = null;
    try {
      existing = await getSubject(pool, organizationId, "chat_query", chatQueryId);
      if (existing && existing.status === "completed") {
        span.setAttribute("fluxora.ai.idempotent_hit", true);
        markSpanSuccess(span);
        return {
          status: "already_completed",
          aiAnalysis: existing,
        };
      }
      if (existing && existing.status === "rejected" && !options.forceRetry) {
        span.setAttribute("fluxora.ai.idempotent_hit", true);
        markSpanSuccess(span);
        return {
          status: "rejected",
          aiAnalysis: existing,
          errors:
            (existing.metadata?.validationErrors as ValidationIssue[] | undefined) ??
            [],
        };
      }
      if (existing && existing.status === "failed" && !options.forceRetry) {
        span.setAttribute("fluxora.ai.idempotent_hit", true);
        markSpanSuccess(span);
        return {
          status: "failed",
          aiAnalysis: existing,
          error: existing.errorMessage ?? "Chat query previously failed.",
        };
      }
    } catch {
      // Non-fatal: proceed to pending placeholder
    }

    // 2. Ensure pending placeholder
    if (existing && existing.status === "pending") {
      currentRecord = existing;
    } else {
      try {
        currentRecord = await save(pool, {
          id: existing?.id,
          organizationId,
          subjectType: "chat_query",
          subjectId: chatQueryId,
          status: "pending",
          promptVersion: CHAT_QUERY_PROMPT_VERSION,
          metadata: {
            repositoryId,
            analysisRunId,
            ...(sessionId ? { sessionId } : {}),
          },
        });
      } catch (saveErr) {
        console.error(
          `[chat-orchestrator] failed to save initial pending status: ${sanitizeErrorMessage(saveErr)}`,
        );
      }
    }

    // 3. Verify trusted repository & analysis run ownership
    const [repo, run] = await Promise.all([
      fetchRepo(pool, organizationId, repositoryId),
      fetchRun(pool, organizationId, analysisRunId),
    ]);

    if (!repo || !run) {
      const errorMsg = !repo
        ? "Repository not found or inaccessible for this organization."
        : "Analysis run not found or inaccessible for this organization.";
      currentRecord = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "chat_query",
        subjectId: chatQueryId,
        status: "failed",
        promptVersion: CHAT_QUERY_PROMPT_VERSION,
        outputText: null,
        outputStructured: null,
        errorMessage: errorMsg,
        metadata: { repositoryId, analysisRunId },
      });
      markSpanError(span, errorMsg);
      return {
        status: "failed",
        aiAnalysis: currentRecord,
        error: errorMsg,
      };
    }

    // 4. Build initial provider-independent request
    const abortController = new AbortController();
    const executionStartMs = Date.now();
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Chat query timed out after ${maxExecutionTimeMs}ms`));
    }, maxExecutionTimeMs);

    try {
      const baseRequest = buildChatQueryInitialRequest({
        repositoryId,
        analysisRunId,
        question,
        history,
        signal: abortController.signal,
      });

      const conversationMessages: ModelMessage[] = [...baseRequest.messages];
      let latestResponse: ModelGatewayResponse | undefined;
      let totalToolCalls = 0;

      // 5. Bounded tool-calling loop
      for (let round = 0; round <= maxToolRounds; round++) {
        if (Date.now() - executionStartMs > maxExecutionTimeMs) {
          throw new Error(`Chat query exceeded execution time budget (${maxExecutionTimeMs}ms).`);
        }

        const isFinalAllowedRound = round === maxToolRounds;
        const response = await gateway.generate({
          ...baseRequest,
          messages: conversationMessages,
          // On the final round after exhausting tool rounds, omit tools to force a final JSON answer
          tools: isFinalAllowedRound ? undefined : baseRequest.tools,
        });

        accumulateGatewayResponse(usage, response);
        latestResponse = response;

        const toolUses = response.toolUses ?? [];
        if (toolUses.length === 0) {
          break;
        }

        if (isFinalAllowedRound) {
          throw new Error("Model attempted tool calls beyond maximum allowed tool rounds.");
        }

        // Record assistant message with text + tool_use blocks
        const assistantBlocks: ModelMessageContentBlock[] = [];
        if (response.text.length > 0) {
          assistantBlocks.push({ type: "text", text: response.text });
        }
        for (const tu of toolUses) {
          assistantBlocks.push(tu);
        }
        conversationMessages.push({
          role: "assistant",
          content: response.text,
          blocks: assistantBlocks,
        });

        // Execute each tool call within total tool call budget
        const toolResultBlocks: ModelToolResultBlock[] = [];
        for (const toolUse of toolUses) {
          if (totalToolCalls >= maxTotalToolCalls) {
            toolResultBlocks.push({
              type: "tool_result",
              toolUseId: toolUse.id,
              content: JSON.stringify({
                error: {
                  code: "tool_call_limit_exceeded",
                  message: `Maximum total tool calls (${maxTotalToolCalls}) exceeded. Provide your final JSON response using the evidence already gathered.`,
                },
              }),
              isError: true,
            });
            continue;
          }

          totalToolCalls += 1;
          const result = await executeControlledChatTool(
            toolUse.name,
            toolUse.input,
            toolCtx,
            toolDeps,
          );

          toolResultBlocks.push({
            type: "tool_result",
            toolUseId: toolUse.id,
            content: result.content,
            isError: result.isError,
          });
        }

        conversationMessages.push({
          role: "user",
          content: "",
          blocks: toolResultBlocks,
        });
      }

      if (!latestResponse) {
        throw new Error("Model gateway did not produce a response.");
      }

      // 6. Validate final structured output & evidence manifest grounding (with max 1 corrective retry)
      const validationResult = await validateChatQueryWithRetry({
        initialResponseText: latestResponse.text,
        allowedEvidenceIds: toolCtx.allowedEvidenceIds,
        retry: async (retryParams) => {
          const retryRes = await gateway.generate({
            ...baseRequest,
            tools: undefined,
            systemInstruction: `${baseRequest.systemInstruction ?? ""}\n\n${retryParams.correctiveInstruction}`,
            messages: [
              ...conversationMessages,
              {
                role: "user",
                content:
                  "Provide ONLY the corrected raw JSON object conforming to the schema and citing only evidence IDs returned by tools in this query.",
              },
            ],
          });
          accumulateGatewayResponse(usage, retryRes);
          return retryRes.text;
        },
      });

      const totalTokens = usage.inputTokens + usage.outputTokens;
      const modelUsed = usage.lastModel ?? latestResponse.model;
      const providerUsed = usage.lastProvider ?? latestResponse.provider;

      if (validationResult.success) {
        const validatedData = validationResult.data;
        const structuredOutput: AIExplanationOutputDto = {
          summary: validatedData.summary,
          claims: validatedData.claims.map((c) => ({
            text: c.text,
            evidence_ids: [...c.evidence_ids],
          })),
          confidence: validatedData.confidence,
          caveats: [...validatedData.caveats],
        };

        const saved = await save(pool, {
          id: currentRecord?.id,
          organizationId,
          subjectType: "chat_query",
          subjectId: chatQueryId,
          status: "completed",
          modelUsed,
          promptVersion: CHAT_QUERY_PROMPT_VERSION,
          inputEvidenceIds: Array.from(toolCtx.allowedEvidenceIds),
          outputText: validatedData.summary,
          outputStructured: structuredOutput,
          validationStatus: "passed",
          tokenCount: totalTokens,
          costUsd: usage.costUsd,
          latencyMs: usage.latencyMs,
          metadata: {
            schemaVersion: validationResult.schemaVersion,
            repositoryId,
            analysisRunId,
            ...(sessionId ? { sessionId } : {}),
            gatewayCalls: usage.gatewayCalls,
            validationAttempts: validationResult.attempts,
            usedFallback: usage.usedFallback,
            provider: providerUsed,
            toolActivity: toolCtx.toolActivity,
            totalToolCalls,
          },
        });

        markSpanSuccess(span);
        return {
          status: "completed",
          aiAnalysis: saved,
        };
      }

      // Validation Rejected — never persist raw invalid output
      const sanitizedErrors = validationResult.errors.map((e) => ({
        category: e.category,
        code: e.code,
        path: e.path,
        message: e.message,
      }));

      const savedRejected = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "chat_query",
        subjectId: chatQueryId,
        status: "rejected",
        modelUsed,
        promptVersion: CHAT_QUERY_PROMPT_VERSION,
        inputEvidenceIds: Array.from(toolCtx.allowedEvidenceIds),
        outputText: null,
        outputStructured: null,
        validationStatus: "rejected",
        tokenCount: totalTokens,
        costUsd: usage.costUsd,
        latencyMs: usage.latencyMs,
        metadata: {
          repositoryId,
          analysisRunId,
          ...(sessionId ? { sessionId } : {}),
          validationErrors: sanitizedErrors,
          gatewayCalls: usage.gatewayCalls,
          validationAttempts: validationResult.attempts,
          usedFallback: usage.usedFallback,
          provider: providerUsed,
          toolActivity: toolCtx.toolActivity,
          totalToolCalls,
        },
        errorMessage: `Structured output validation failed: ${sanitizedErrors.map((e) => `[${e.code}] ${e.message}`).join("; ")}`,
      });

      markSpanSuccess(span);
      return {
        status: "rejected",
        aiAnalysis: savedRejected,
        errors: validationResult.errors,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err: unknown) {
    const sanitized = sanitizeErrorMessage(err);
    try {
      currentRecord = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "chat_query",
        subjectId: chatQueryId,
        status: "failed",
        promptVersion: CHAT_QUERY_PROMPT_VERSION,
        inputEvidenceIds: Array.from(toolCtx.allowedEvidenceIds),
        outputText: null,
        outputStructured: null,
        tokenCount: usage.inputTokens + usage.outputTokens,
        costUsd: usage.costUsd,
        latencyMs: usage.latencyMs,
        metadata: {
          repositoryId,
          analysisRunId,
          ...(sessionId ? { sessionId } : {}),
          gatewayCalls: usage.gatewayCalls,
          usedFallback: usage.usedFallback,
          toolActivity: toolCtx.toolActivity,
        },
        errorMessage: sanitized,
      });
    } catch {
      // Safe swallow
    }
    markSpanError(span, sanitized);
    return {
      status: "failed",
      aiAnalysis: currentRecord,
      error: sanitized,
    };
  } finally {
    span.end();
  }
}
