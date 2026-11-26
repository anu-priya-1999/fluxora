import {
  getTracer,
  markSpanError,
  markSpanSuccess,
} from "@fluxora/observability";
import {
  SIMULATION_NARRATION_JOB_TYPE,
  parseSimulationNarrationJobPayload,
  type Job,
} from "@fluxora/shared-types";

import type { JobHandler } from "../handlers.ts";
import { permanentIngestionError } from "../ingest/errors.ts";
import {
  orchestrateSimulationNarration,
  type SimulationNarrationOrchestrationResult,
} from "../ai/simulation-orchestrator.ts";

const tracer = getTracer("@fluxora/workers");

export interface SimulationNarrationDependencies {
  orchestrateNarration(options: {
    organizationId: string;
    simulationId: string;
    forceRetry?: boolean | undefined;
    maxRetries?: number | undefined;
  }): Promise<SimulationNarrationOrchestrationResult>;
}

export function createProductionSimulationNarrationDependencies(): SimulationNarrationDependencies {
  return {
    async orchestrateNarration(options) {
      return orchestrateSimulationNarration(options);
    },
  };
}

export async function processSimulationNarrationJob(
  job: Job,
  deps: SimulationNarrationDependencies,
): Promise<SimulationNarrationOrchestrationResult | null> {
  // Empty payload check (allows dummy jobs in worker unit tests to complete safely)
  if (Object.keys(job.payload).length === 0) {
    return null;
  }

  const payload = parseSimulationNarrationJobPayload(job.payload);
  if (payload === null) {
    throw permanentIngestionError(
      "invalid_payload",
      "malformed simulation.narration payload",
    );
  }

  const span = tracer.startSpan("fluxora.worker.simulation_narration.process", {
    attributes: {
      "fluxora.job.id": job.id,
      "fluxora.job.organization_id": job.organizationId,
      "fluxora.simulation_id": payload.simulationId,
    },
  });

  try {
    // Step 63: End-to-end AI Simulation Narration orchestration
    // Failure isolation: AI generation failure or rejection must NEVER turn a completed
    // deterministic simulation into a failure or trigger unexpected job retries.
    let result: SimulationNarrationOrchestrationResult | null = null;
    try {
      result = await deps.orchestrateNarration({
        organizationId: job.organizationId,
        simulationId: payload.simulationId,
      });
    } catch (aiError) {
      console.error(
        `[simulation-narration-handler] AI narration isolation catch: ${aiError instanceof Error ? aiError.message : String(aiError)}`,
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

export function createSimulationNarrationHandler(
  deps: SimulationNarrationDependencies,
): JobHandler {
  return async (job: Job): Promise<void> => {
    if (job.type !== SIMULATION_NARRATION_JOB_TYPE) {
      throw permanentIngestionError(
        "invalid_payload",
        `handler received unexpected job type ${job.type}`,
      );
    }

    await processSimulationNarrationJob(job, deps);
  };
}
