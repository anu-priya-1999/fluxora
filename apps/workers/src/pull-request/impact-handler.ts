import {
  getTracer,
  markSpanError,
  markSpanSuccess,
} from "@fluxora/observability";
import {
  getPool,
  persistPullRequestImpactAnalysis,
} from "@fluxora/db";
import {
  PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
  parsePullRequestImpactAnalysisJobPayload,
  type Job,
  type PersistImpactAnalysisResult,
  type PersistPullRequestImpactAnalysisOptions,
} from "@fluxora/shared-types";

import type { JobHandler } from "../handlers.ts";
import { permanentIngestionError } from "../ingest/errors.ts";
import {
  orchestrateImpactExplanation,
  type AIExplanationOrchestrationResult,
} from "../ai/orchestrator.ts";

const tracer = getTracer("@fluxora/workers");

export interface PullRequestImpactDependencies {
  persistAnalysis(
    options: PersistPullRequestImpactAnalysisOptions,
  ): Promise<PersistImpactAnalysisResult>;
  explainImpact?: (options: {
    organizationId: string;
    impactAnalysisId: string;
  }) => Promise<AIExplanationOrchestrationResult>;
}

export function createProductionPullRequestImpactDependencies(): PullRequestImpactDependencies {
  return {
    async persistAnalysis(options: PersistPullRequestImpactAnalysisOptions) {
      return persistPullRequestImpactAnalysis(getPool(), options);
    },
    async explainImpact(options) {
      return orchestrateImpactExplanation(options);
    },
  };
}

export async function processPullRequestImpactJob(
  job: Job,
  deps: PullRequestImpactDependencies,
): Promise<PersistImpactAnalysisResult | null> {
  // Empty payload check (allows dummy jobs in worker unit tests to complete safely)
  if (Object.keys(job.payload).length === 0) {
    return null;
  }

  const payload = parsePullRequestImpactAnalysisJobPayload(job.payload);
  if (payload === null) {
    throw permanentIngestionError(
      "invalid_payload",
      "malformed pull_request.impact_analysis payload",
    );
  }

  const span = tracer.startSpan("fluxora.worker.pull_request_impact.process", {
    attributes: {
      "fluxora.job.id": job.id,
      "fluxora.job.organization_id": job.organizationId,
      "fluxora.pull_request_id": payload.pullRequestId,
      ...(payload.analysisRunId
        ? { "fluxora.analysis_run_id": payload.analysisRunId }
        : {}),
    },
  });

  try {
    const result = await deps.persistAnalysis({
      organizationId: job.organizationId,
      pullRequestId: payload.pullRequestId,
      ...(payload.analysisRunId ? { analysisRunId: payload.analysisRunId } : {}),
      ...(payload.impactAnalysisId ? { id: payload.impactAnalysisId } : {}),
      ...(payload.maxDepth !== undefined ? { maxDepth: payload.maxDepth } : {}),
      ...(payload.direction ? { direction: payload.direction } : {}),
      ...(payload.edgeTypes ? { edgeTypes: payload.edgeTypes } : {}),
      ...(payload.nodeTypes ? { nodeTypes: payload.nodeTypes } : {}),
      ...(payload.decayFactor !== undefined
        ? { decayFactor: payload.decayFactor }
        : {}),
      ...(payload.includeEvidence !== undefined
        ? { includeEvidence: payload.includeEvidence }
        : {}),
    });

    // Step 62: End-to-end AI Impact Explanation orchestration
    // Failure isolation: AI generation failure or rejection must NEVER turn a completed
    // deterministic impact analysis into a failure or trigger job retries.
    if (result && result.impactAnalysis && result.impactAnalysis.status === "completed" && deps.explainImpact) {
      try {
        await deps.explainImpact({
          organizationId: job.organizationId,
          impactAnalysisId: result.impactAnalysis.id,
        });
      } catch (aiError) {
        console.error(
          `[impact-handler] AI explanation isolation catch: ${aiError instanceof Error ? aiError.message : String(aiError)}`,
        );
      }
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

export function createPullRequestImpactAnalysisHandler(
  deps: PullRequestImpactDependencies,
): JobHandler {
  return async (job: Job): Promise<void> => {
    if (job.type !== PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE) {
      throw permanentIngestionError(
        "invalid_payload",
        `handler received unexpected job type ${job.type}`,
      );
    }

    await processPullRequestImpactJob(job, deps);
  };
}

