import assert from "node:assert/strict";
import test from "node:test";

import type { Job } from "@fluxora/shared-types";

import { PermanentJobError, RetryableJobError, isRetryableJobError } from "./errors.ts";
import {
  computeRetryDelay,
  MAX_RETRY_DELAY_SECONDS,
  JobWorker,
  type WorkerJobStore,
} from "./worker.ts";

function runningJob(attemptCount = 1): Job {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: "11111111-1111-4111-8111-111111111111",
    type: "repository.ingest",
    payload: {},
    status: "running",
    idempotencyKey: "k",
    attemptCount,
    maxAttempts: 10,
    availableAt: new Date(),
    lockedAt: new Date(),
    lockedBy: "w1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    failedAt: null,
  };
}

function failedJob(job: Job): Job {
  return { ...job, status: "failed", lastError: "x", failedAt: new Date() };
}

test("isRetryableJobError treats permanent ingestion failures as non-retryable", () => {
  assert.equal(isRetryableJobError(new PermanentJobError("no")), false);
  assert.equal(isRetryableJobError(new RetryableJobError("later")), true);
  assert.equal(isRetryableJobError(new Error("boom")), true);
});

test("computeRetryDelay produces bounded exponential backoff sequence", () => {
  const base = 5;
  // attempt 1: 5 * 2^0 = 5
  // attempt 2: 5 * 2^1 = 10
  // attempt 3: 5 * 2^2 = 20
  // attempt 4: 5 * 2^3 = 40
  // attempt 5: 5 * 2^4 = 80
  // attempt 6: 5 * 2^5 = 160
  // attempt 7: 5 * 2^6 = 320 -> capped at 300
  // attempt 8: 5 * 2^7 = 640 -> capped at 300
  const expected = [5, 10, 20, 40, 80, 160, 300, 300];
  const actual = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
    computeRetryDelay(base, attempt),
  );
  assert.deepEqual(actual, expected);
  assert.equal(MAX_RETRY_DELAY_SECONDS, 300);
});

test("JobWorker retries retryable failures with exponential retry delays across attempts", async () => {
  const delays: number[] = [];
  let currentAttempt = 1;

  const store: WorkerJobStore = {
    async claimNextJob() {
      return runningJob(currentAttempt);
    },
    async completeJob() {
      throw new Error("should not complete");
    },
    async failJob(jobId) {
      return failedJob({ ...runningJob(currentAttempt), id: jobId });
    },
    async retryFailedJob(jobId, retryDelaySeconds = 0) {
      delays.push(retryDelaySeconds);
      return { ...runningJob(currentAttempt), id: jobId, status: "pending" };
    },
  };

  const worker = new JobWorker({
    workerId: "w1",
    retryDelaySeconds: 5,
    handlers: {
      "repository.ingest": async () => {
        throw new RetryableJobError("temporary failure");
      },
    },
    jobStore: store,
  });

  for (let attempt = 1; attempt <= 7; attempt += 1) {
    currentAttempt = attempt;
    await worker.runOnce();
  }

  assert.deepEqual(delays, [5, 10, 20, 40, 80, 160, 300]);
});

test("JobWorker retries retryable failures and leaves permanent failures failed", async () => {
  const job = runningJob();
  const retried: string[] = [];
  const store: WorkerJobStore = {
    async claimNextJob() {
      return job;
    },
    async completeJob() {
      throw new Error("should not complete");
    },
    async failJob(jobId) {
      return failedJob({ ...job, id: jobId });
    },
    async retryFailedJob(jobId) {
      retried.push(jobId);
      return { ...job, id: jobId, status: "pending" };
    },
  };

  const retryWorker = new JobWorker({
    workerId: "w1",
    handlers: {
      "repository.ingest": async () => {
        throw new RetryableJobError("rate limit");
      },
    },
    jobStore: store,
  });
  await retryWorker.runOnce();
  assert.deepEqual(retried, [job.id]);

  retried.length = 0;
  const permanentWorker = new JobWorker({
    workerId: "w1",
    handlers: {
      "repository.ingest": async () => {
        throw new PermanentJobError("needs reauth");
      },
    },
    jobStore: store,
  });
  await permanentWorker.runOnce();
  assert.deepEqual(retried, []);
});
