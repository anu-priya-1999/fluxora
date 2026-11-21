/**
 * @file loader.test.ts
 * Unit tests for the Tenant-Scoped Context Loader.
 *
 * Verifies:
 * - Successful tenant-scoped retrieval and delegation to assembler
 * - Missing or inaccessible analysis fails safely with not_found (without leaking cross-tenant status)
 * - Incomplete / running / pending / failed analyses are rejected with not_completed
 * - Evidence is fetched using exact tenant organizationId and impactAnalysisId
 * - Repository errors are caught and surfaced safely
 * - Input validation rejects malformed UUIDs
 * - Unit tests execute 100% offline without live PostgreSQL
 */

import type { EvidenceRecord, ImpactAnalysis } from "@fluxora/shared-types";
import { describe, expect, it, vi } from "vitest";

import {
  loadImpactExplanationContext,
  type DatabasePool,
  type ImpactExplanationRepository,
} from "./loader.ts";

const VALID_ORG_ID = "11111111-1111-4111-8111-111111111111";
const VALID_ANALYSIS_ID = "22222222-2222-4222-8222-222222222222";
const VALID_RUN_ID = "33333333-3333-4333-8333-333333333333";
const VALID_PR_ID = "44444444-4444-4444-8444-444444444444";

function createMockAnalysis(
  overrides: Partial<ImpactAnalysis> = {},
): ImpactAnalysis {
  return {
    id: VALID_ANALYSIS_ID,
    pullRequestId: VALID_PR_ID,
    analysisRunId: VALID_RUN_ID,
    status: "completed",
    directImpact: [
      {
        node: {
          id: "node-1",
          canonicalId: "mod:lib/core.ts",
          analysisRunId: VALID_RUN_ID,
          nodeType: "module",
          name: "CoreModule",
          path: "lib/core.ts",
          confidence: 1.0,
          metadata: {},
          createdAt: new Date("2026-11-20T10:00:00Z"),
        },
        depth: 0,
        confidence: 1.0,
        path: ["lib/core.ts"],
        evidenceIds: ["ev-1"],
      },
    ],
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
      totalSeedNodes: 1,
      totalAffectedNodes: 1,
      totalEdgesTraversed: 0,
      durationMs: 10,
    },
    metadata: {},
    createdAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

function createMockEvidence(
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    id: "ev-1",
    analysisRunId: VALID_RUN_ID,
    subjectType: "impact_finding",
    subjectId: "node-1",
    filePath: "lib/core.ts",
    symbolId: "CoreModule",
    lineStart: 1,
    lineEnd: 20,
    columnStart: 1,
    columnEnd: 10,
    relationshipDescription: "Direct modification",
    confidence: 1.0,
    metadata: { impactAnalysisId: VALID_ANALYSIS_ID, nodeId: "node-1" },
    createdAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

describe("Tenant-Scoped Context Loader", () => {
  const dummyPool = {} as DatabasePool;

  it("1. Successfully loads completed analysis and evidence within tenant scope", async () => {
    const analysis = createMockAnalysis();
    const evidence = [createMockEvidence()];

    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn().mockResolvedValue(analysis),
      listImpactFindingEvidence: vi.fn().mockResolvedValue(evidence),
    };

    const context = await loadImpactExplanationContext({
      pool: dummyPool,
      organizationId: VALID_ORG_ID,
      impactAnalysisId: VALID_ANALYSIS_ID,
      repository: mockRepo,
    });

    expect(mockRepo.getImpactAnalysisById).toHaveBeenCalledWith(
      dummyPool,
      VALID_ORG_ID,
      VALID_ANALYSIS_ID,
    );
    expect(mockRepo.listImpactFindingEvidence).toHaveBeenCalledWith(
      dummyPool,
      VALID_ORG_ID,
      VALID_ANALYSIS_ID,
    );

    expect(context.impactAnalysisId).toBe(VALID_ANALYSIS_ID);
    expect(context.status).toBe("completed");
    expect(context.directImpact).toHaveLength(1);
    expect(context.directImpact[0]!.evidenceIds).toEqual(["ev-1"]);
    expect(context.allowedEvidenceIds).toEqual(["ev-1"]);
  });

  it("2. Fails safely with not_found when analysis does not exist or is inaccessible", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn().mockResolvedValue(null),
      listImpactFindingEvidence: vi.fn().mockResolvedValue([]),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: VALID_ORG_ID,
        impactAnalysisId: VALID_ANALYSIS_ID,
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "not_found",
    });

    // Verify evidence is never queried when analysis is missing
    expect(mockRepo.listImpactFindingEvidence).not.toHaveBeenCalled();
  });

  it("3. Rejects pending analysis with not_completed", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn().mockResolvedValue(
        createMockAnalysis({ status: "pending" }),
      ),
      listImpactFindingEvidence: vi.fn().mockResolvedValue([]),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: VALID_ORG_ID,
        impactAnalysisId: VALID_ANALYSIS_ID,
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "not_completed",
      message: expect.stringContaining("status 'pending'"),
    });
  });

  it("4. Rejects running analysis with not_completed", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn().mockResolvedValue(
        createMockAnalysis({ status: "running" }),
      ),
      listImpactFindingEvidence: vi.fn().mockResolvedValue([]),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: VALID_ORG_ID,
        impactAnalysisId: VALID_ANALYSIS_ID,
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "not_completed",
      message: expect.stringContaining("status 'running'"),
    });
  });

  it("5. Rejects failed analysis with not_completed", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn().mockResolvedValue(
        createMockAnalysis({ status: "failed" }),
      ),
      listImpactFindingEvidence: vi.fn().mockResolvedValue([]),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: VALID_ORG_ID,
        impactAnalysisId: VALID_ANALYSIS_ID,
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "not_completed",
      message: expect.stringContaining("status 'failed'"),
    });
  });

  it("6. Rejects invalid organizationId UUID early", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn(),
      listImpactFindingEvidence: vi.fn(),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: "not-a-uuid",
        impactAnalysisId: VALID_ANALYSIS_ID,
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "invalid_input",
    });

    expect(mockRepo.getImpactAnalysisById).not.toHaveBeenCalled();
  });

  it("7. Rejects invalid impactAnalysisId UUID early", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn(),
      listImpactFindingEvidence: vi.fn(),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: VALID_ORG_ID,
        impactAnalysisId: "malformed-id",
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "invalid_input",
    });

    expect(mockRepo.getImpactAnalysisById).not.toHaveBeenCalled();
  });

  it("8. Propagates repository failures safely as not_found without leaking internals", async () => {
    const mockRepo: ImpactExplanationRepository = {
      getImpactAnalysisById: vi.fn().mockRejectedValue(new Error("Database connection lost")),
      listImpactFindingEvidence: vi.fn(),
    };

    await expect(
      loadImpactExplanationContext({
        pool: dummyPool,
        organizationId: VALID_ORG_ID,
        impactAnalysisId: VALID_ANALYSIS_ID,
        repository: mockRepo,
      }),
    ).rejects.toMatchObject({
      name: "ImpactExplanationContextError",
      code: "not_found",
    });
  });
});
