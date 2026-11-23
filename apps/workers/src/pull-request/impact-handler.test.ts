import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
  type AIAnalysis,
  type Job,
  type PersistPullRequestImpactAnalysisOptions,
} from "@fluxora/shared-types";

import { createDefaultJobHandlers } from "../handlers.ts";
import {
  createPullRequestImpactAnalysisHandler,
  processPullRequestImpactJob,
  type PullRequestImpactDependencies,
} from "./impact-handler.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PR_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ANALYSIS_ID = "44444444-4444-4444-8444-444444444444";

function createMockJob(payload: Record<string, unknown>, type: string = PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE): Job {
  return {
    id: "job-1",
    organizationId: ORG_ID,
    type: type as Job["type"],
    payload,
    status: "pending",
    idempotencyKey: "test-key-1",
    attemptCount: 0,
    maxAttempts: 3,
    configuredMaxAttempts: 3,
    availableAt: new Date(),
    lockedAt: null,
    lockedBy: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
  };
}

describe("PullRequest impact analysis worker handler", () => {
  it("processes valid impact analysis job and invokes persistAnalysis with tenant scope", async () => {
    let capturedOptions: PersistPullRequestImpactAnalysisOptions | null = null;

    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis(options) {
        capturedOptions = options;
        return {
          impactAnalysis: {
            id: options.id ?? ANALYSIS_ID,
            pullRequestId: options.pullRequestId,
            analysisRunId: options.analysisRunId ?? RUN_ID,
            status: "completed",
            directImpact: [],
            downstreamImpact: [],
            affectedApis: [],
            affectedEvents: [],
            affectedServices: [],
            workflowImpactSummary: [],
            unresolvedFiles: [],
            truncated: false,
            truncationReason: null,
            maxDepthReached: 0,
            executionMetrics: {
              totalSeedNodes: 0,
              totalAffectedNodes: 0,
              totalEdgesTraversed: 0,
              durationMs: 10,
            },
            metadata: {},
            createdAt: new Date(),
          },
          evidenceRecords: [],
        };
      },
    };

    const job = createMockJob({
      pullRequestId: PR_ID,
      analysisRunId: RUN_ID,
      impactAnalysisId: ANALYSIS_ID,
      maxDepth: 3,
      direction: "outgoing",
      includeEvidence: true,
    });

    const result = await processPullRequestImpactJob(job, mockDeps);
    assert.ok(result);
    assert.equal(capturedOptions!.organizationId, ORG_ID);
    assert.equal(capturedOptions!.pullRequestId, PR_ID);
    assert.equal(capturedOptions!.analysisRunId, RUN_ID);
    assert.equal(capturedOptions!.id, ANALYSIS_ID);
    assert.equal(capturedOptions!.maxDepth, 3);
    assert.equal(capturedOptions!.direction, "outgoing");
    assert.equal(capturedOptions!.includeEvidence, true);
  });

  it("safely handles empty payload by returning null", async () => {
    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis() {
        throw new Error("Should not be called");
      },
    };

    const job = createMockJob({});
    const result = await processPullRequestImpactJob(job, mockDeps);
    assert.equal(result, null);
  });

  it("throws permanent error on malformed payload", async () => {
    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis() {
        throw new Error("Should not be called");
      },
    };

    const job = createMockJob({
      pullRequestId: "not-a-uuid",
    });

    await assert.rejects(
      async () => {
        await processPullRequestImpactJob(job, mockDeps);
      },
      {
        name: "IngestionError",
        message: "malformed pull_request.impact_analysis payload",
      },
    );
  });

  it("rejects unexpected job types in handler", async () => {
    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis() {
        throw new Error("Should not be called");
      },
    };

    const handler = createPullRequestImpactAnalysisHandler(mockDeps);
    const job = createMockJob(
      { pullRequestId: PR_ID },
      "unsupported.type",
    );

    await assert.rejects(
      async () => {
        await handler(job);
      },
      {
        name: "IngestionError",
      },
    );
  });

  it("createDefaultJobHandlers registers the impact analysis handler", () => {
    const handlers = createDefaultJobHandlers({
      ingestHandler: async () => {},
    });
    assert.ok(typeof handlers[PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE] === "function");
  });

  it("invokes explainImpact when analysis completes successfully", async () => {
    let explainCalledWith: { organizationId: string; impactAnalysisId: string } | null = null;

    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis(options) {
        return {
          impactAnalysis: {
            id: options.id ?? ANALYSIS_ID,
            pullRequestId: options.pullRequestId,
            analysisRunId: options.analysisRunId ?? RUN_ID,
            status: "completed",
            directImpact: [],
            downstreamImpact: [],
            affectedApis: [],
            affectedEvents: [],
            affectedServices: [],
            workflowImpactSummary: [],
            unresolvedFiles: [],
            truncated: false,
            truncationReason: null,
            maxDepthReached: 0,
            executionMetrics: {
              totalSeedNodes: 0,
              totalAffectedNodes: 0,
              totalEdgesTraversed: 0,
              durationMs: 10,
            },
            metadata: {},
            createdAt: new Date(),
          },
          evidenceRecords: [],
        };
      },
      async explainImpact(options) {
        explainCalledWith = options;
        return {
          status: "completed",
          aiAnalysis: { id: "ai-123" } as unknown as AIAnalysis,
        };
      },
    };

    const job = createMockJob({
      pullRequestId: PR_ID,
      analysisRunId: RUN_ID,
      impactAnalysisId: ANALYSIS_ID,
    });

    const result = await processPullRequestImpactJob(job, mockDeps);
    assert.ok(result);
    const called = explainCalledWith as { organizationId: string; impactAnalysisId: string } | null;
    assert.ok(called);
    assert.equal(called.organizationId, ORG_ID);
    assert.equal(called.impactAnalysisId, ANALYSIS_ID);
  });

  it("isolates AI failure: exception in explainImpact does not fail the deterministic impact result", async () => {
    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis(options) {
        return {
          impactAnalysis: {
            id: options.id ?? ANALYSIS_ID,
            pullRequestId: options.pullRequestId,
            analysisRunId: options.analysisRunId ?? RUN_ID,
            status: "completed",
            directImpact: [],
            downstreamImpact: [],
            affectedApis: [],
            affectedEvents: [],
            affectedServices: [],
            workflowImpactSummary: [],
            unresolvedFiles: [],
            truncated: false,
            truncationReason: null,
            maxDepthReached: 0,
            executionMetrics: {
              totalSeedNodes: 0,
              totalAffectedNodes: 0,
              totalEdgesTraversed: 0,
              durationMs: 10,
            },
            metadata: {},
            createdAt: new Date(),
          },
          evidenceRecords: [],
        };
      },
      async explainImpact() {
        throw new Error("AI provider gateway network failure (503)");
      },
    };

    const job = createMockJob({
      pullRequestId: PR_ID,
      analysisRunId: RUN_ID,
      impactAnalysisId: ANALYSIS_ID,
    });

    // Must NOT throw or reject; must return deterministic result
    const result = await processPullRequestImpactJob(job, mockDeps);
    assert.ok(result);
    assert.equal(result.impactAnalysis.id, ANALYSIS_ID);
    assert.equal(result.impactAnalysis.status, "completed");
  });

  it("does not invoke explainImpact when deterministic impact analysis status is not completed", async () => {
    let explainCalled = false;
    const mockDeps: PullRequestImpactDependencies = {
      async persistAnalysis(options) {
        return {
          impactAnalysis: {
            id: options.id ?? ANALYSIS_ID,
            pullRequestId: options.pullRequestId,
            analysisRunId: options.analysisRunId ?? RUN_ID,
            status: "failed",
            directImpact: [],
            downstreamImpact: [],
            affectedApis: [],
            affectedEvents: [],
            affectedServices: [],
            workflowImpactSummary: [],
            unresolvedFiles: [],
            truncated: false,
            truncationReason: null,
            maxDepthReached: 0,
            executionMetrics: {
              totalSeedNodes: 0,
              totalAffectedNodes: 0,
              totalEdgesTraversed: 0,
              durationMs: 5,
            },
            metadata: {},
            createdAt: new Date(),
          },
          evidenceRecords: [],
        };
      },
      async explainImpact() {
        explainCalled = true;
        throw new Error("Should not be called");
      },
    };

    const job = createMockJob({
      pullRequestId: PR_ID,
      analysisRunId: RUN_ID,
      impactAnalysisId: ANALYSIS_ID,
    });

    const result = await processPullRequestImpactJob(job, mockDeps);
    assert.ok(result);
    assert.equal(result.impactAnalysis.status, "failed");
    assert.equal(explainCalled, false, "explainImpact must not be invoked on non-completed deterministic results");
  });
});

