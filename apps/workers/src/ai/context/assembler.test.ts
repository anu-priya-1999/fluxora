/**
 * @file assembler.test.ts
 * Comprehensive unit test suite for the Pure Impact Explanation Context Assembler.
 *
 * Verifies all 24 pure assembler requirements:
 * - Completed impact analysis handling
 * - Empty findings handling
 * - All 5 finding categories preservation
 * - Evidence association and manifest construction
 * - Rejection of evidence from another analysis run
 * - Rejection of evidence associated with another impact analysis
 * - Rejection of evidence with wrong subjectType
 * - Rejection of evidence whose subject ID does not match the finding
 * - Missing evidence IDs handling
 * - Duplicate evidence IDs deduplication
 * - Fabricated evidence IDs stripping
 * - Stable ordering for equal confidence and depth (tie-breaker on nodeId)
 * - Confidence prioritization (descending)
 * - Hop-distance prioritization (ascending depth)
 * - Category preservation (direct, downstream, api, event, service)
 * - Maximum finding limit (maxFindings)
 * - Maximum evidence limit (maxEvidenceRecords)
 * - Maximum string length truncation
 * - Context character budget enforcement
 * - Transparent truncation metadata and reasons
 * - Unresolved files limits
 * - Malformed / unexpected optional values
 * - Input immutability
 * - Deterministic repeatability (identical outputs for identical inputs)
 */

import type {
  EvidenceRecord,
  GraphNode,
  ImpactAnalysis,
  ImpactFinding,
  UnresolvedChangedFile,
} from "@fluxora/shared-types";
import { describe, expect, it } from "vitest";

import { assembleImpactExplanationContext } from "./assembler.ts";
import { ImpactExplanationContextError } from "./types.ts";

function createMockNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "node-default-1",
    analysisRunId: "run-default-1",
    canonicalId: "mod:lib/payment.ts",
    nodeType: "module",
    name: "PaymentModule",
    path: "lib/payment.ts",
    metadata: { sensitiveInternalProp: "secret-should-not-leak" },
    confidence: 1.0,
    createdAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

function createMockFinding(overrides: Partial<ImpactFinding> = {}): ImpactFinding {
  return {
    node: createMockNode(),
    depth: 1,
    confidence: 0.9,
    path: ["lib/index.ts", "lib/payment.ts"],
    evidenceIds: ["ev-default-1"],
    ...overrides,
  };
}

function createMockEvidence(
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    id: "ev-default-1",
    analysisRunId: "run-default-1",
    subjectType: "impact_finding",
    subjectId: "node-default-1",
    filePath: "lib/payment.ts",
    symbolId: "PaymentModule",
    lineStart: 10,
    lineEnd: 25,
    columnStart: 1,
    columnEnd: 15,
    relationshipDescription: "PaymentModule affected via direct import",
    confidence: 0.95,
    metadata: {
      impactAnalysisId: "analysis-default-1",
      pullRequestId: "pr-default-1",
      nodeId: "node-default-1",
      databaseInternalField: "db-secret",
    },
    createdAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

function createMockAnalysis(
  overrides: Partial<ImpactAnalysis> = {},
): ImpactAnalysis {
  return {
    id: "analysis-default-1",
    pullRequestId: "pr-default-1",
    analysisRunId: "run-default-1",
    status: "completed",
    directImpact: [createMockFinding({ node: createMockNode({ id: "node-direct-1" }) })],
    downstreamImpact: [],
    affectedApis: [],
    affectedEvents: [],
    affectedServices: [],
    workflowImpactSummary: ["Payment checkout workflow potentially degraded"],
    unresolvedFiles: [],
    truncated: false,
    truncationReason: null,
    maxDepthReached: 1,
    executionMetrics: {
      totalSeedNodes: 1,
      totalAffectedNodes: 1,
      totalEdgesTraversed: 2,
      durationMs: 45,
    },
    metadata: { internalRunFlags: { debug: true } },
    createdAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

describe("Pure Deterministic Impact Explanation Context Assembler", () => {
  it("1. Valid completed impact analysis produces bounded context and explicit allowed manifest", () => {
    const analysis = createMockAnalysis({
      id: "analysis-100",
      pullRequestId: "pr-100",
      analysisRunId: "run-100",
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "node-101", name: "CheckoutService" }),
          evidenceIds: ["ev-101"],
          depth: 0,
          confidence: 1.0,
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-101",
        analysisRunId: "run-100",
        subjectId: "node-101",
        metadata: { impactAnalysisId: "analysis-100", nodeId: "node-101" },
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.impactAnalysisId).toBe("analysis-100");
    expect(context.pullRequestId).toBe("pr-100");
    expect(context.analysisRunId).toBe("run-100");
    expect(context.status).toBe("completed");
    expect(context.directImpact).toHaveLength(1);
    expect(context.directImpact[0]!.nodeId).toBe("node-101");
    expect(context.directImpact[0]!.evidenceIds).toEqual(["ev-101"]);
    expect(context.allowedEvidenceIds).toEqual(["ev-101"]);
    expect(context.evidenceRecords).toHaveLength(1);
    expect(context.evidenceRecords[0]!.id).toBe("ev-101");
    expect(context.truncated).toBe(false);
    expect(context.truncationReason).toBeNull();
  });

  it("2. Empty findings across all categories produce valid empty arrays without error", () => {
    const analysis = createMockAnalysis({
      directImpact: [],
      downstreamImpact: [],
      affectedApis: [],
      affectedEvents: [],
      affectedServices: [],
      workflowImpactSummary: [],
      unresolvedFiles: [],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.directImpact).toEqual([]);
    expect(context.downstreamImpact).toEqual([]);
    expect(context.affectedApis).toEqual([]);
    expect(context.affectedEvents).toEqual([]);
    expect(context.affectedServices).toEqual([]);
    expect(context.workflowImpactSummary).toEqual([]);
    expect(context.unresolvedFiles).toEqual([]);
    expect(context.evidenceRecords).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.truncated).toBe(false);
  });

  it("3. All 5 finding categories are populated and their category identities preserved", () => {
    const analysis = createMockAnalysis({
      directImpact: [createMockFinding({ node: createMockNode({ id: "n-direct" }) })],
      downstreamImpact: [createMockFinding({ node: createMockNode({ id: "n-downstream" }) })],
      affectedApis: [createMockFinding({ node: createMockNode({ id: "n-api", nodeType: "api" }) })],
      affectedEvents: [createMockFinding({ node: createMockNode({ id: "n-event", nodeType: "event" }) })],
      affectedServices: [createMockFinding({ node: createMockNode({ id: "n-service", nodeType: "service" }) })],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.directImpact).toHaveLength(1);
    expect(context.directImpact[0]!.nodeId).toBe("n-direct");
    expect(context.downstreamImpact).toHaveLength(1);
    expect(context.downstreamImpact[0]!.nodeId).toBe("n-downstream");
    expect(context.affectedApis).toHaveLength(1);
    expect(context.affectedApis[0]!.nodeId).toBe("n-api");
    expect(context.affectedEvents).toHaveLength(1);
    expect(context.affectedEvents[0]!.nodeId).toBe("n-event");
    expect(context.affectedServices).toHaveLength(1);
    expect(context.affectedServices[0]!.nodeId).toBe("n-service");
  });

  it("4. Evidence association and manifest construction links valid evidence to findings", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1" }),
          evidenceIds: ["ev-1", "ev-2"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({ id: "ev-1", subjectId: "n-1" }),
      createMockEvidence({ id: "ev-2", subjectId: "n-1" }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual(["ev-1", "ev-2"]);
    expect(context.allowedEvidenceIds).toEqual(["ev-1", "ev-2"]);
    expect(context.evidenceRecords.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
  });

  it("5. Evidence from a different analysisRunId is rejected", () => {
    const analysis = createMockAnalysis({
      analysisRunId: "run-correct",
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1" }),
          evidenceIds: ["ev-wrong-run"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-wrong-run",
        analysisRunId: "run-different",
        subjectId: "n-1",
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.evidenceRecords).toHaveLength(0);
  });

  it("6. Evidence associated with another impact analysis is rejected", () => {
    const analysis = createMockAnalysis({
      id: "analysis-correct",
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1" }),
          evidenceIds: ["ev-other-analysis"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-other-analysis",
        subjectId: "n-1",
        metadata: { impactAnalysisId: "analysis-foreign-999" },
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.evidenceRecords).toHaveLength(0);
  });

  it("7. Wrong subject type is rejected", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1" }),
          evidenceIds: ["ev-edge-type"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-edge-type",
        subjectType: "graph_edge" as unknown as EvidenceRecord["subjectType"],
        subjectId: "n-1",
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.evidenceRecords).toHaveLength(0);
  });

  it("8. Evidence subject ID does not match the finding is rejected", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-finding-owner" }),
          evidenceIds: ["ev-mismatched-subject"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-mismatched-subject",
        subjectId: "n-different-node",
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.evidenceRecords).toHaveLength(0);
  });

  it("8b. Evidence with mismatched subjectId is rejected even if metadata.nodeId matches the finding (metadata.nodeId is never a substitute)", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-finding-owner" }),
          evidenceIds: ["ev-metadata-node-id-only"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-metadata-node-id-only",
        subjectType: "impact_finding",
        subjectId: "n-unrelated-foreign-node", // subjectId does NOT match finding.node.id
        metadata: {
          impactAnalysisId: "analysis-default-1",
          nodeId: "n-finding-owner", // metadata.nodeId matches finding, but subjectId does NOT
        },
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    // Evidence must NOT be accepted: metadata.nodeId must never substitute for subjectId
    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.evidenceRecords).toHaveLength(0);
  });

  it("9. Missing evidence IDs on finding result in empty verified evidenceIds without error", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-no-ev" }),
          evidenceIds: undefined,
        }),
      ],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
  });

  it("10. Duplicate evidence IDs on findings are deterministically deduplicated", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1" }),
          evidenceIds: ["ev-1", "ev-1", "ev-1"],
        }),
      ],
    });

    const evidence = [createMockEvidence({ id: "ev-1", subjectId: "n-1" })];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual(["ev-1"]);
    expect(context.allowedEvidenceIds).toEqual(["ev-1"]);
  });

  it("11. Findings containing fabricated evidence IDs strip fake IDs and preserve valid ones", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1" }),
          evidenceIds: ["ev-real", "ev-fake-fabricated-id"],
        }),
      ],
    });

    const evidence = [createMockEvidence({ id: "ev-real", subjectId: "n-1" })];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(context.directImpact[0]!.evidenceIds).toEqual(["ev-real"]);
    expect(context.allowedEvidenceIds).toEqual(["ev-real"]);
    expect(context.allowedEvidenceIds).not.toContain("ev-fake-fabricated-id");
  });

  it("12. Stable ordering for equal confidence and depth breaks ties deterministically on nodeId", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "node-zebra" }),
          depth: 1,
          confidence: 0.8,
        }),
        createMockFinding({
          node: createMockNode({ id: "node-apple" }),
          depth: 1,
          confidence: 0.8,
        }),
        createMockFinding({
          node: createMockNode({ id: "node-mango" }),
          depth: 1,
          confidence: 0.8,
        }),
      ],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.directImpact.map((f) => f.nodeId)).toEqual([
      "node-apple",
      "node-mango",
      "node-zebra",
    ]);
  });

  it("13. Confidence prioritization places higher confidence first", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-low" }),
          depth: 1,
          confidence: 0.5,
        }),
        createMockFinding({
          node: createMockNode({ id: "n-high" }),
          depth: 1,
          confidence: 0.95,
        }),
        createMockFinding({
          node: createMockNode({ id: "n-mid" }),
          depth: 1,
          confidence: 0.8,
        }),
      ],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.directImpact.map((f) => f.nodeId)).toEqual([
      "n-high",
      "n-mid",
      "n-low",
    ]);
  });

  it("14. Hop-distance prioritization places lower depth first when confidence is equal", () => {
    const analysis = createMockAnalysis({
      downstreamImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-hop-3" }),
          depth: 3,
          confidence: 0.9,
        }),
        createMockFinding({
          node: createMockNode({ id: "n-hop-1" }),
          depth: 1,
          confidence: 0.9,
        }),
        createMockFinding({
          node: createMockNode({ id: "n-hop-2" }),
          depth: 2,
          confidence: 0.9,
        }),
      ],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.downstreamImpact.map((f) => f.nodeId)).toEqual([
      "n-hop-1",
      "n-hop-2",
      "n-hop-3",
    ]);
  });

  it("15. Category preservation: findings remain strictly categorized without cross-contamination", () => {
    const analysis = createMockAnalysis({
      directImpact: [createMockFinding({ node: createMockNode({ id: "d-1" }) })],
      downstreamImpact: [createMockFinding({ node: createMockNode({ id: "ds-1" }) })],
      affectedApis: [createMockFinding({ node: createMockNode({ id: "api-1", nodeType: "api" }) })],
      affectedEvents: [createMockFinding({ node: createMockNode({ id: "ev-1", nodeType: "event" }) })],
      affectedServices: [createMockFinding({ node: createMockNode({ id: "svc-1", nodeType: "service" }) })],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
    });

    expect(context.directImpact.map((f) => f.nodeId)).toEqual(["d-1"]);
    expect(context.downstreamImpact.map((f) => f.nodeId)).toEqual(["ds-1"]);
    expect(context.affectedApis.map((f) => f.nodeId)).toEqual(["api-1"]);
    expect(context.affectedEvents.map((f) => f.nodeId)).toEqual(["ev-1"]);
    expect(context.affectedServices.map((f) => f.nodeId)).toEqual(["svc-1"]);
  });

  it("16. Maximum finding limit omits lower-ranked findings and marks context as truncated", () => {
    const findings: ImpactFinding[] = [];
    for (let i = 1; i <= 10; i++) {
      findings.push(
        createMockFinding({
          node: createMockNode({ id: `node-${i}` }),
          confidence: i / 10,
          depth: 1,
        }),
      );
    }

    const analysis = createMockAnalysis({
      directImpact: findings,
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
      limits: { maxFindings: 4 },
    });

    expect(context.directImpact).toHaveLength(4);
    // Highest confidence findings should be preserved: 10, 9, 8, 7
    expect(context.directImpact.map((f) => f.nodeId)).toEqual([
      "node-10",
      "node-9",
      "node-8",
      "node-7",
    ]);
    expect(context.truncated).toBe(true);
    expect(context.truncation.contextLimitsExceeded).toBe(true);
    expect(context.truncation.omittedFindingsCount).toBe(6);
    expect(context.truncationReason).toContain("Finding limit (4) exceeded");
  });

  it("17. Maximum evidence limit omits excess evidence and purges omitted IDs from manifest and findings", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "node-1" }),
          evidenceIds: ["ev-1", "ev-2", "ev-3", "ev-4"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({ id: "ev-1", subjectId: "node-1", confidence: 0.99 }),
      createMockEvidence({ id: "ev-2", subjectId: "node-1", confidence: 0.90 }),
      createMockEvidence({ id: "ev-3", subjectId: "node-1", confidence: 0.80 }),
      createMockEvidence({ id: "ev-4", subjectId: "node-1", confidence: 0.70 }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
      limits: { maxEvidenceRecords: 2 },
    });

    expect(context.evidenceRecords).toHaveLength(2);
    expect(context.evidenceRecords.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(context.allowedEvidenceIds).toEqual(["ev-1", "ev-2"]);
    // Finding's evidenceIds must only contain the retained IDs
    expect(context.directImpact[0]!.evidenceIds).toEqual(["ev-1", "ev-2"]);
    expect(context.truncated).toBe(true);
    expect(context.truncation.omittedEvidenceCount).toBe(2);
  });

  it("18. Maximum string length bounds individual untrusted strings without mutating inputs", () => {
    const longName = "A".repeat(1000);
    const longPath = "dir/" + "B".repeat(1000);
    const longReason = "C".repeat(1000);

    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-long", name: longName, path: longPath }),
          path: [longPath],
        }),
      ],
      unresolvedFiles: [{ path: longPath, reason: longReason }],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
      limits: { maxStringLength: 50 },
    });

    expect(context.directImpact[0]!.name).toHaveLength(50);
    expect(context.directImpact[0]!.filePath).toHaveLength(50);
    expect(context.directImpact[0]!.path[0]!).toHaveLength(50);
    expect(context.unresolvedFiles[0]!.path).toHaveLength(50);
    expect(context.unresolvedFiles[0]!.reason).toHaveLength(50);

    // Verify input object was not mutated
    expect(analysis.directImpact[0]!.node.name).toHaveLength(1000);
  });

  it("19. Context character budget iteratively omits lower priority findings until within limit", () => {
    const findings: ImpactFinding[] = [];
    for (let i = 1; i <= 20; i++) {
      findings.push(
        createMockFinding({
          node: createMockNode({
            id: `node-${i}`,
            name: `LongServiceComponentNumber${i}`,
            path: `packages/services/src/handlers/component_${i}.ts`,
          }),
          depth: i,
          confidence: 1 / i,
        }),
      );
    }

    const analysis = createMockAnalysis({
      directImpact: findings,
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
      limits: { maxTotalCharacters: 3_000 },
    });

    const json = JSON.stringify(context);
    expect(json.length).toBeLessThanOrEqual(3_000);
    expect(context.truncated).toBe(true);
    expect(context.truncation.omittedFindingsCount).toBeGreaterThan(0);
    expect(context.truncationReason).toContain("Context character budget");
  });

  it("19b. Context character budget strictly bounds JSON output including truncation disclosure and reasons", () => {
    // Generate findings with moderate size to test tight budget boundary
    const findings: ImpactFinding[] = [];
    for (let i = 1; i <= 10; i++) {
      findings.push(
        createMockFinding({
          node: createMockNode({
            id: `tight-node-${i}`,
            name: `TightBudgetComponent_${i}`,
            path: `apps/api/src/routes/handler_${i}.ts`,
          }),
          depth: i,
          confidence: 0.9 - i * 0.05,
        }),
      );
    }

    const analysis = createMockAnalysis({
      directImpact: findings,
      unresolvedFiles: [
        { path: "docs/api-changes.md", reason: "not code" },
        { path: "scripts/deploy.sh", reason: "script not mapped" },
      ],
      truncated: true,
      truncationReason: "Underlying graph traversal hit depth limit 4",
    });

    const budget = 2_500;
    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
      limits: { maxTotalCharacters: budget },
    });

    const serialized = JSON.stringify(context);
    // MUST strictly respect budget, inclusive of reasons, truncation metadata, metrics, and retained findings
    expect(serialized.length).toBeLessThanOrEqual(budget);
    expect(context.truncated).toBe(true);
    expect(context.truncation.analysisWasTruncated).toBe(true);
    expect(context.truncation.reasons).toEqual(
      expect.arrayContaining([
        "Underlying graph traversal hit depth limit 4",
        expect.stringContaining(`Context character budget (${budget}) exceeded`),
      ]),
    );
  });

  it("20. Transparent truncation metadata captures traversal and context limits simultaneously", () => {
    const analysis = createMockAnalysis({
      truncated: true,
      truncationReason: "Traversal depth cap of 5 reached",
      directImpact: [
        createMockFinding({ node: createMockNode({ id: "n-1" }), confidence: 0.9 }),
        createMockFinding({ node: createMockNode({ id: "n-2" }), confidence: 0.8 }),
      ],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
      limits: { maxFindings: 1 },
    });

    expect(context.truncated).toBe(true);
    expect(context.truncation.analysisWasTruncated).toBe(true);
    expect(context.truncation.analysisTruncationReason).toBe(
      "Traversal depth cap of 5 reached",
    );
    expect(context.truncation.contextLimitsExceeded).toBe(true);
    expect(context.truncation.omittedFindingsCount).toBe(1);
    expect(context.truncation.reasons).toEqual(
      expect.arrayContaining([
        "Traversal depth cap of 5 reached",
        expect.stringContaining("Finding limit (1) exceeded"),
      ]),
    );
  });

  it("21. Unresolved file limits cap entries and track omission", () => {
    const files: UnresolvedChangedFile[] = [];
    for (let i = 1; i <= 10; i++) {
      files.push({ path: `file-${i}.txt`, reason: "not in graph" });
    }

    const analysis = createMockAnalysis({
      unresolvedFiles: files,
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [],
      limits: { maxUnresolvedFiles: 3 },
    });

    expect(context.unresolvedFiles).toHaveLength(3);
    expect(context.truncated).toBe(true);
    expect(context.truncation.omittedUnresolvedFilesCount).toBe(7);
  });

  it("22. Malformed or unexpected optional values handle safely without exceptions", () => {
    const analysis = createMockAnalysis({
      workflowImpactSummary: undefined as unknown as string[],
      unresolvedFiles: undefined as unknown as UnresolvedChangedFile[],
      executionMetrics: undefined as unknown as ImpactAnalysis["executionMetrics"],
      directImpact: [
        {
          node: {
            id: "n-minimal",
            canonicalId: "n-min",
            name: undefined as unknown as string,
            nodeType: undefined as unknown as GraphNode["nodeType"],
            path: null,
            metadata: null as unknown as Record<string, unknown>,
            confidence: undefined as unknown as number,
            analysisRunId: "run-default-1",
            createdAt: new Date(),
          },
          depth: undefined as unknown as number,
          confidence: undefined as unknown as number,
          path: undefined as unknown as string[],
          evidenceIds: null as unknown as string[],
        },
      ],
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: [
        null as unknown as EvidenceRecord,
        undefined as unknown as EvidenceRecord,
        { id: "" } as unknown as EvidenceRecord,
      ],
    });

    expect(context.directImpact).toHaveLength(1);
    expect(context.directImpact[0]!.nodeId).toBe("n-minimal");
    expect(context.directImpact[0]!.name).toBe("unnamed");
    expect(context.directImpact[0]!.nodeType).toBe("unknown");
    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.workflowImpactSummary).toEqual([]);
    expect(context.unresolvedFiles).toEqual([]);
    expect(context.executionMetrics.totalAffectedNodes).toBe(1);
  });

  it("23. Input immutability guarantees input analysis and evidence records are not modified", () => {
    const findingNode = createMockNode({ id: "n-immutable", name: "OriginalName" });
    const finding = createMockFinding({
      node: findingNode,
      evidenceIds: ["ev-orig-1", "ev-orig-fake"],
    });

    const analysis = createMockAnalysis({
      directImpact: [finding],
      workflowImpactSummary: ["OriginalWorkflow"],
    });

    const evidence = [
      createMockEvidence({ id: "ev-orig-1", subjectId: "n-immutable" }),
    ];

    const deepCloneAnalysis = JSON.parse(JSON.stringify(analysis));
    const deepCloneEvidence = JSON.parse(JSON.stringify(evidence));

    assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(JSON.parse(JSON.stringify(analysis))).toEqual(deepCloneAnalysis);
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(deepCloneEvidence);
  });

  it("24. Repeatability guarantees identical outputs for identical inputs", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-1", name: "Alpha" }),
          confidence: 0.9,
          depth: 1,
          evidenceIds: ["ev-1"],
        }),
        createMockFinding({
          node: createMockNode({ id: "n-2", name: "Beta" }),
          confidence: 0.85,
          depth: 2,
          evidenceIds: ["ev-2"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({ id: "ev-1", subjectId: "n-1" }),
      createMockEvidence({ id: "ev-2", subjectId: "n-2" }),
    ];

    const run1 = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    const run2 = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    expect(run1).toEqual(run2);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it("25. Evidence records without a valid associated finding do not enter the final manifest or evidence records", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-associated" }),
          evidenceIds: ["ev-associated"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-associated",
        subjectId: "n-associated",
      }),
      createMockEvidence({
        id: "ev-unassociated-1",
        subjectId: "n-other-node-not-in-findings",
      }),
      createMockEvidence({
        id: "ev-unassociated-2",
        subjectId: "n-associated", // matches node, but finding did not cite it
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    // Only the cited and associated evidence ID should be in the manifest and records
    expect(context.allowedEvidenceIds).toEqual(["ev-associated"]);
    expect(context.evidenceRecords).toHaveLength(1);
    expect(context.evidenceRecords[0]!.id).toBe("ev-associated");
    expect(context.allowedEvidenceIds).not.toContain("ev-unassociated-1");
    expect(context.allowedEvidenceIds).not.toContain("ev-unassociated-2");
  });

  it("26. Findings with mismatched subjectId remain explicitly unsupported rather than receiving fabricated evidence", () => {
    const analysis = createMockAnalysis({
      directImpact: [
        createMockFinding({
          node: createMockNode({ id: "n-owner-node" }),
          evidenceIds: ["ev-wrong-subject"],
        }),
      ],
    });

    const evidence = [
      createMockEvidence({
        id: "ev-wrong-subject",
        subjectId: "n-different-subject",
        metadata: {
          impactAnalysisId: "analysis-default-1",
          nodeId: "n-owner-node", // metadata.nodeId must NOT compensate
        },
      }),
    ];

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
    });

    // Finding remains in context, but its evidenceIds array is empty (unsupported)
    expect(context.directImpact).toHaveLength(1);
    expect(context.directImpact[0]!.nodeId).toBe("n-owner-node");
    expect(context.directImpact[0]!.evidenceIds).toEqual([]);
    expect(context.allowedEvidenceIds).toEqual([]);
    expect(context.evidenceRecords).toHaveLength(0);
  });

  it("27. Multiple simultaneous truncation reasons (analysis-level + finding limit + evidence limit + unresolved file limit + budget) are tracked transparently", () => {
    const findings: ImpactFinding[] = [];
    for (let i = 1; i <= 20; i++) {
      findings.push(
        createMockFinding({
          node: createMockNode({
            id: `multi-node-${i}`,
            name: `Service_${i}_LongNameForBudgeting`,
            path: `packages/services/src/comp_${i}.ts`,
          }),
          depth: i,
          confidence: 0.95 - i * 0.02,
          evidenceIds: [`ev-${i}`],
        }),
      );
    }

    const evidence = findings.map((f, i) =>
      createMockEvidence({
        id: `ev-${i + 1}`,
        subjectId: f.node.id,
        confidence: 0.95 - i * 0.02,
      }),
    );

    const unresolvedFiles: UnresolvedChangedFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `unresolved/file_${i}.txt`,
      reason: `Not tracked in graph ${i}`,
    }));

    const analysis = createMockAnalysis({
      truncated: true,
      truncationReason: "Graph traversal hit max depth of 3",
      directImpact: findings,
      unresolvedFiles,
    });

    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
      limits: {
        maxFindings: 10,
        maxEvidenceRecords: 5,
        maxUnresolvedFiles: 3,
        maxTotalCharacters: 3_500,
      },
    });

    const serialized = JSON.stringify(context);
    expect(serialized.length).toBeLessThanOrEqual(3_500);
    expect(context.truncated).toBe(true);
    expect(context.truncation.isTruncated).toBe(true);
    expect(context.truncation.analysisWasTruncated).toBe(true);
    expect(context.truncation.analysisTruncationReason).toBe(
      "Graph traversal hit max depth of 3",
    );
    expect(context.truncation.contextLimitsExceeded).toBe(true);
    expect(context.truncation.omittedFindingsCount).toBeGreaterThan(0);
    expect(context.truncation.omittedEvidenceCount).toBeGreaterThan(0);
    // 7 omitted due to maxUnresolvedFiles: 3, plus remaining 3 omitted during character budget trimming = 10 total
    expect(context.truncation.omittedUnresolvedFilesCount).toBe(10);
    expect(context.unresolvedFiles).toHaveLength(0);

    // Reasons must include traversal truncation, finding limits, and character budget
    expect(context.truncation.reasons).toEqual(
      expect.arrayContaining([
        "Graph traversal hit max depth of 3",
        expect.stringContaining("Finding limit (10) exceeded"),
        expect.stringContaining("Unresolved files limit (3) exceeded"),
      ]),
    );
  });

  it("28. Budget trimming drops orphaned evidence when finding is dropped and tracks omittedEvidenceCount", () => {
    const findings: ImpactFinding[] = [
      createMockFinding({
        node: createMockNode({
          id: "n-high-pri",
          name: "HighPriorityService",
          path: "services/high.ts",
        }),
        depth: 0,
        confidence: 1.0,
        evidenceIds: ["ev-high"],
      }),
      createMockFinding({
        node: createMockNode({
          id: "n-low-pri",
          name: "LowPriorityService_WithVeryLongNameForcedToTrim".repeat(10),
          path: "services/low.ts",
        }),
        depth: 2,
        confidence: 0.2,
        evidenceIds: ["ev-low-1", "ev-low-2"],
      }),
    ];

    const evidence = [
      createMockEvidence({ id: "ev-high", subjectId: "n-high-pri" }),
      createMockEvidence({ id: "ev-low-1", subjectId: "n-low-pri" }),
      createMockEvidence({ id: "ev-low-2", subjectId: "n-low-pri" }),
    ];

    const analysis = createMockAnalysis({
      directImpact: findings,
    });

    // Budget tight enough to fit only high-pri finding
    const context = assembleImpactExplanationContext({
      analysis,
      evidenceRecords: evidence,
      limits: { maxTotalCharacters: 1_800 },
    });

    expect(context.directImpact).toHaveLength(1);
    expect(context.directImpact[0]!.nodeId).toBe("n-high-pri");
    expect(context.allowedEvidenceIds).toEqual(["ev-high"]);
    expect(context.evidenceRecords.map((e) => e.id)).toEqual(["ev-high"]);
    // Orphaned evidence ev-low-1 and ev-low-2 were removed
    expect(context.allowedEvidenceIds).not.toContain("ev-low-1");
    expect(context.allowedEvidenceIds).not.toContain("ev-low-2");
    expect(context.truncation.omittedEvidenceCount).toBe(2);
  });

  it("Throws budgetExceeded when budget is impossibly small to fit base context skeleton", () => {
    const analysis = createMockAnalysis({
      directImpact: [],
    });

    expect(() =>
      assembleImpactExplanationContext({
        analysis,
        evidenceRecords: [],
        limits: { maxTotalCharacters: 50 },
      }),
    ).toThrow(ImpactExplanationContextError);
  });
});
