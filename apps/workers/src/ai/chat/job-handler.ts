/**
 * @file job-handler.ts
 * Worker job handler for `chat.query` (Phase 9 Step 64).
 */

import {
  getTracer,
  markSpanError,
  markSpanSuccess,
} from "@fluxora/observability";
import {
  CHAT_QUERY_JOB_TYPE,
  parseChatQueryJobPayload,
  type Job,
} from "@fluxora/shared-types";

import type { JobHandler } from "../../handlers.ts";
import { permanentIngestionError } from "../../ingest/errors.ts";
import {
  orchestrateChatQuery,
  type ChatQueryOrchestrationResult,
  type OrchestrateChatQueryOptions,
} from "./orchestrator.ts";

const tracer = getTracer("@fluxora/workers");

export interface ChatQueryJobDependencies {
  orchestrateChatQuery(
    options: OrchestrateChatQueryOptions,
  ): Promise<ChatQueryOrchestrationResult>;
}

export function createProductionChatQueryDependencies(): ChatQueryJobDependencies {
  return {
    async orchestrateChatQuery(options) {
      return orchestrateChatQuery(options);
    },
  };
}

export async function processChatQueryJob(
  job: Job,
  deps: ChatQueryJobDependencies,
): Promise<ChatQueryOrchestrationResult | null> {
  if (Object.keys(job.payload).length === 0) {
    return null;
  }

  const payload = parseChatQueryJobPayload(job.payload);
  if (payload === null) {
    throw permanentIngestionError(
      "invalid_payload",
      "malformed chat.query payload",
    );
  }

  const span = tracer.startSpan("fluxora.worker.chat_query.process", {
    attributes: {
      "fluxora.job.id": job.id,
      "fluxora.job.organization_id": job.organizationId,
      "fluxora.chat_query_id": payload.chatQueryId,
      "fluxora.repository_id": payload.repositoryId,
      "fluxora.analysis_run_id": payload.analysisRunId,
    },
  });

  try {
    let result: ChatQueryOrchestrationResult | null = null;
    try {
      result = await deps.orchestrateChatQuery({
        organizationId: job.organizationId,
        repositoryId: payload.repositoryId,
        analysisRunId: payload.analysisRunId,
        chatQueryId: payload.chatQueryId,
        question: payload.question,
        history: payload.history,
        sessionId: payload.sessionId,
      });
    } catch (aiError) {
      console.error(
        `[chat-query-handler] AI chat isolation catch: ${aiError instanceof Error ? aiError.message : String(aiError)}`,
      );
    }

    markSpanSuccess(span);
    return result;
  } catch (error) {
    markSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

export function createChatQueryHandler(
  deps: ChatQueryJobDependencies,
): JobHandler {
  return async (job: Job): Promise<void> => {
    if (job.type !== CHAT_QUERY_JOB_TYPE) {
      throw permanentIngestionError(
        "invalid_payload",
        `handler received unexpected job type ${job.type}`,
      );
    }

    await processChatQueryJob(job, deps);
  };
}
