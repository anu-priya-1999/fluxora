import assert from "node:assert/strict";
import test from "node:test";

import type { Job } from "@fluxora/shared-types";

import { PermanentJobError, RetryableJobError, isRetryableJobError } from "./errors.ts";
import { JobWorker, type WorkerJobStore } from "./worker.ts";

function runningJob(): Job {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: "11111111-1111-4111-8111-111111111111",
    type: "repository.ingest",
    payload: {},
    status: "running",
    idempotencyKey: "k",
    attemptCount: 1,
    maxAttempts: 3,
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
