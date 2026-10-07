import {
  getTracer,
  markSpanError,
  markSpanSuccess,
} from "@fluxora/observability";

import {
  claimNextJob,
  completeJob,
  failJob,
  retryFailedJob,
} from "@fluxora/db";
import type { Job } from "@fluxora/shared-types";

import { isRetryableJobError } from "./errors.ts";
import type { JobHandlerRegistry } from "./handlers.ts";

export interface WorkerJobStore {
  claimNextJob: typeof claimNextJob;
  completeJob: typeof completeJob;
  failJob: typeof failJob;
  retryFailedJob: typeof retryFailedJob;
}

export interface WorkerOptions {
  workerId: string;
  handlers: JobHandlerRegistry;
  pollIntervalMs?: number;
  retryDelaySeconds?: number;
  jobStore?: WorkerJobStore;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export const MAX_RETRY_DELAY_SECONDS = 300;

export function computeRetryDelay(
  baseDelaySeconds: number,
  attemptCount: number,
  maxDelaySeconds = MAX_RETRY_DELAY_SECONDS,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  const factor = Math.pow(2, exponent);
  const calculated = Math.floor(baseDelaySeconds * factor);
  return Math.min(calculated, maxDelaySeconds);
}

const tracer = getTracer("@fluxora/workers");

export class JobWorker {
  private readonly workerId: string;
  private readonly handlers: JobHandlerRegistry;
  private readonly pollIntervalMs: number;
  private readonly retryDelaySeconds: number;
  private readonly jobStore: WorkerJobStore;

  constructor(options: WorkerOptions) {
    if (options.workerId.trim().length === 0) {
      throw new Error("workerId must not be empty");
    }

    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0)
    ) {
      throw new Error("pollIntervalMs must be a positive integer");
    }

    if (
      options.retryDelaySeconds !== undefined &&
      (!Number.isInteger(options.retryDelaySeconds) ||
        options.retryDelaySeconds < 0)
    ) {
      throw new Error("retryDelaySeconds must be a non-negative integer");
    }

    this.workerId = options.workerId.trim();
    this.handlers = options.handlers;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.retryDelaySeconds = options.retryDelaySeconds ?? 5;
    this.jobStore = options.jobStore ?? {
      claimNextJob,
      completeJob,
      failJob,
      retryFailedJob,
    };
  }

  async runOnce(): Promise<boolean> {
    const job = await this.jobStore.claimNextJob(this.workerId);

    if (job === null) {
      return false;
    }

    await this.executeJob(job);

    return true;
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (signal?.aborted !== true) {
      try {
        const processed = await this.runOnce();

        if (!processed) {
          await sleep(this.pollIntervalMs);
        }
      } catch (error) {
        console.error(
          `[worker:${this.workerId}] queue error:`,
          getErrorMessage(error),
        );

        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const span = tracer.startSpan("fluxora.worker.job.process", {
      attributes: {
        "fluxora.worker.id": this.workerId,
        "fluxora.job.id": job.id,
        "fluxora.job.type": job.type,
        "fluxora.job.organization_id": job.organizationId,
        "fluxora.job.attempt": job.attemptCount,
      },
    });

    try {
      const handler = this.handlers[job.type];

      if (handler === undefined) {
        const error = new Error(
          `No handler registered for job type "${job.type}"`,
        );

        markSpanError(span, error);

        await this.handleFailure(job, error);

        return;
      }

      try {
        await handler(job);
      } catch (error) {
        markSpanError(span, error);

        await this.handleFailure(job, error);

        return;
      }

      try {
        await this.jobStore.completeJob(job.id, this.workerId);
      } catch (error) {
        markSpanError(span, error);

        console.error(
          `[worker:${this.workerId}] completion failed for job ${job.id}:`,
          getErrorMessage(error),
        );

        return;
      }

      markSpanSuccess(span);
    } finally {
      span.end();
    }
  }

  private async handleFailure(job: Job, error: unknown): Promise<void> {
    const failed = await this.jobStore.failJob(
      job.id,
      this.workerId,
      getErrorMessage(error),
    );

    if (failed.status === "failed" && isRetryableJobError(error)) {
      const delaySeconds = computeRetryDelay(
        this.retryDelaySeconds,
        failed.attemptCount,
      );
      await this.jobStore.retryFailedJob(failed.id, delaySeconds);
    }
  }
}
