import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AIExplanationOutputDto, EvidenceRecord } from "@fluxora/shared-types";
import { describe, expect, it } from "vitest";

import {
  buildBaselineFromReport,
  checkEntityHallucinations,
  evaluateOutputSemanticGroundedness,
  evaluateReleaseGates,
  loadAdversarialInjectionFixture,
  loadAIEvalBaseline,
  loadAIEvalDataset,
  runAIEvaluationSuite,
  saveAIEvalBaseline,
  type AIEvalCase,
  type EvalEvidenceContext,
} from "./index.ts";

describe("AI Evaluation Suite (Global Step 65)", () => {
  it("loads versioned evaluation dataset and adversarial fixture with SHA-256 hashes covering all 3 task types", () => {
    const { dataset, sha256 } = loadAIEvalDataset();
    expect(dataset.datasetVersion).toBe("ai-eval-dataset-v1");
    expect(dataset.pinnedCommitSha).toBe("298a8857c7128a0d121e7f699dfd729f23b3966d");
    expect(dataset.description.toLowerCase()).not.toContain("human-reviewed");
    expect(dataset.description.toLowerCase()).toContain("provisional");
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);

    const taskTypes = new Set(dataset.cases.map((c) => c.taskType));
    expect(taskTypes.has("impact_explanation")).toBe(true);
    expect(taskTypes.has("simulation_narration")).toBe(true);
    expect(taskTypes.has("chat_query")).toBe(true);

    const kafkaAbstentionCase = dataset.cases.find(
      (c) => c.caseId === "eval-chat-taxonomy-missing-evidence-abstention",
    );
    expect(kafkaAbstentionCase).toBeDefined();
    expect(kafkaAbstentionCase?.expectedFindings[0]).toMatch(/no verified graph evidence/i);
    expect(kafkaAbstentionCase?.expectedFindings[0]).toMatch(/abstain/i);
    expect(kafkaAbstentionCase?.expectedFindings[0]).not.toMatch(/are present/i);

    const { fixture, sha256: advHash } = loadAdversarialInjectionFixture();
    expect(fixture.fixtureVersion).toBe("golden-taxonomy-adversarial-v1");
    expect(fixture.attackVectors.length).toBeGreaterThanOrEqual(4);
    expect(advHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes manifest membership from semantic support and detects contradictions and ambiguity", async () => {
    const evSub: EvidenceRecord = {
      id: "ev-sub",
      analysisRunId: "run-1",
      subjectType: "impact_finding",
      subjectId: "node-sub",
      filePath: "lib/subscription.ts",
      symbolId: "getUserSubscriptionPlan",
      lineStart: 1,
      lineEnd: 10,
      columnStart: 0,
      columnEnd: 1,
      relationshipDescription: "Direct impact on lib/subscription.ts (getUserSubscriptionPlan).",
      confidence: 1.0,
      metadata: {},
      createdAt: new Date("2026-11-27T00:00:00Z"),
    };

    const evFooter: EvidenceRecord = {
      id: "ev-other",
      analysisRunId: "run-1",
      subjectType: "impact_finding",
      subjectId: "node-other",
      filePath: "app/api/posts/route.ts",
      symbolId: "POST",
      lineStart: 1,
      lineEnd: 10,
      columnStart: 0,
      columnEnd: 1,
      relationshipDescription: "Direct impact on app/api/posts/route.ts.",
      confidence: 0.9,
      metadata: {},
      createdAt: new Date("2026-11-27T00:00:00Z"),
    };

    const evalCase: AIEvalCase = {
      caseId: "test-semantic-case",
      taskType: "impact_explanation",
      promptVersion: "impact-explain-v1",
      goldenFixtureId: "golden-taxonomy-pr-subscription-v1",
      pinnedCommitSha: "298a8857c7128a0d121e7f699dfd729f23b3966d",
      title: "Semantic distinction test",
      description: "Tests supported, wrong-selector, contradicted, and ambiguous claims.",
      expectedFindings: ["lib/subscription.ts is impacted"],
      expectedEntities: ["lib/subscription.ts", "app/api/posts/route.ts"],
      expectedEvidenceSelectors: [],
      expectedCaveats: [],
      prohibitedClaims: ["components/site-footer.tsx is affected"],
      humanReferenceAnnotations: [
        {
          claimPattern: "lib/subscription.ts",
          requiredSelectorIds: ["sel-sub"],
          expectedLabel: "supported",
          rationale: "Requires sel-sub",
        },
      ],
    };

    const context: EvalEvidenceContext = {
      allowedEvidenceIds: new Set(["ev-sub", "ev-other"]),
      evidenceById: new Map([
        ["ev-sub", evSub],
        ["ev-other", evFooter],
      ]),
      selectorToEvidenceId: new Map([["sel-sub", "ev-sub"]]),
      knownEntities: new Set(["lib/subscription.ts", "app/api/posts/route.ts"]),
      unaffectedEntities: new Set(["mod:components/site-footer.tsx"]),
    };

    const output: AIExplanationOutputDto = {
      summary: "Test summary",
      claims: [
        // 0: Valid manifest AND correct selector -> supported
        { text: "lib/subscription.ts is directly impacted.", evidence_ids: ["ev-sub"] },
        // 1: Valid manifest ID (ev-other) but WRONG selector for lib/subscription.ts -> unsupported!
        { text: "lib/subscription.ts has changes.", evidence_ids: ["ev-other"] },
        // 2: Contradicts unaffected entity / prohibited claim -> contradicted
        { text: "components/site-footer.tsx is affected by this PR.", evidence_ids: ["ev-other"] },
        // 3: Weak single-token overlap across >=4 tokens -> ambiguous (never silently supported)
        { text: "The subscription behavior might change across several modules.", evidence_ids: ["ev-sub"] },
      ],
      confidence: "medium",
      caveats: [],
    };

    const result = await evaluateOutputSemanticGroundedness({ output, evalCase, context });
    expect(result.claimEvaluations.map((c) => c.label)).toEqual([
      "supported",
      "unsupported",
      "contradicted",
      "ambiguous",
    ]);
    expect(result.prohibitedClaimViolations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fabricated entities, absent relationships, and simulation state mismatches", () => {
    const evalCase: AIEvalCase = {
      caseId: "test-entity-case",
      taskType: "simulation_narration",
      promptVersion: "simulation-narrate-v1",
      goldenFixtureId: "golden-taxonomy-simulation-v1",
      pinnedCommitSha: "298a8857c7128a0d121e7f699dfd729f23b3966d",
      title: "Entity hallucination test",
      description: "Detects unknown services, files, and simulation mismatches.",
      expectedFindings: [],
      expectedEntities: ["lib/subscription.ts", "app/api/users/stripe/route.ts"],
      expectedEvidenceSelectors: [],
      expectedCaveats: [],
      prohibitedClaims: [],
      humanReferenceAnnotations: [],
    };

    const context: EvalEvidenceContext = {
      allowedEvidenceIds: new Set(["ev-1"]),
      evidenceById: new Map(),
      selectorToEvidenceId: new Map(),
      knownEntities: new Set(["lib/subscription.ts", "app/api/users/stripe/route.ts"]),
      simulationOutcomes: new Map([
        [
          "mod:app/api/users/stripe/route.ts",
          { resultingState: "degraded", ruleApplied: "CALLS+sync+no_fallback" },
        ],
      ]),
      unaffectedEntities: new Set(["mod:components/site-footer.tsx"]),
    };

    const output: AIExplanationOutputDto = {
      summary: "Calls external-secret-exfil-service.internal and lib/fabricated-module.ts.",
      claims: [
        {
          text: "app/api/users/stripe/route.ts is failed in the simulation.",
          evidence_ids: ["ev-1"],
        },
        {
          text: "components/site-footer.tsx is degraded as well.",
          evidence_ids: ["ev-1"],
        },
      ],
      confidence: "high",
      caveats: [],
    };

    const entityResult = checkEntityHallucinations({ output, evalCase, context });
    expect(entityResult.unsupportedEntities).toContain("external-secret-exfil-service.internal");
    expect(entityResult.unsupportedEntities).toContain("lib/fabricated-module.ts");
    expect(entityResult.simulationMismatches.length).toBe(1);
    expect(entityResult.absentRelationshipClaims.length).toBe(1);
    expect(entityResult.entityHallucinationCount).toBeGreaterThanOrEqual(4);
  });

  it("runs complete deterministic CI evaluation suite with 0 invalid citations, 100% schema validity, and 100% adversarial resistance", async () => {
    const report = await runAIEvaluationSuite({ mode: "ci_mock", baseline: null });

    expect(report.mode).toBe("ci_mock");
    expect(report.totalCases).toBe(5);
    expect(report.perTaskMetrics.length).toBe(3);

    expect(report.overallMetrics.citationProvenance.invalidOrFabricatedCitations).toBe(0);
    expect(report.overallMetrics.citationProvenance.manifestComplianceRate).toBe(1);

    expect(report.overallMetrics.structuredOutput.finalValidRate).toBe(1);
    expect(report.overallMetrics.structuredOutput.firstAttemptValidRate).toBe(1);
    expect(report.overallMetrics.structuredOutput.correctiveRetryRate).toBe(0);

    expect(report.overallMetrics.semanticGroundedness.hallucinationRate).toBe(0);
    expect(report.overallMetrics.entityHallucination.unsupportedEntitiesCount).toBe(0);

    // Never fabricates cost values when MockModelProvider reports null
    expect(report.overallMetrics.latencyAndCost.totalCostUsd).toBeNull();
    expect(report.overallMetrics.latencyAndCost.totalInputTokens).toBeNull();

    // Adversarial fixture checks
    expect(report.adversarialSummary.allPassed).toBe(true);
    expect(report.adversarialSummary.passedVectors).toBe(4);

    // Mock mode cannot pass statistical live hallucination gate -> inconclusive
    const hallucinationGate = report.releaseGates.find(
      (g) => g.gateId === "gate-hallucination-rate",
    );
    expect(hallucinationGate?.status).toBe("inconclusive");
    expect(report.overallGateStatus).toBe("inconclusive");
  });

  it("accounts for corrective retries and blocks rising retry rate or failed validation after 2 attempts", async () => {
    const invalidJson = "```json\n{\"summary\":\"bad\"}\n```";
    const validRetry = JSON.stringify({
      summary: "lib/subscription.ts is directly impacted by PR #42.",
      claims: [
        {
          text: "lib/subscription.ts is directly impacted.",
          evidence_ids: ["ev-impact-sub"],
        },
      ],
      confidence: "medium",
      caveats: ["Truncated at maxDepth 2; content/docs/billing.mdx unresolved."],
    });

    const report = await runAIEvaluationSuite({
      mode: "ci_mock",
      baseline: null,
      mockResponsesByCaseId: {
        "eval-impact-taxonomy-pr42-truncation-caveat": [invalidJson, validRetry],
      },
    });

    expect(report.overallMetrics.structuredOutput.correctiveRetryCount).toBe(1);
    expect(report.overallMetrics.structuredOutput.correctiveRetryRate).toBe(0.2);
    expect(report.overallMetrics.structuredOutput.finalValidRate).toBe(1);

    // Compare against a baseline with 0 retry rate -> regression blocks schema-validity gate
    const zeroRetryBaseline = buildBaselineFromReport(
      { ...report, overallMetrics: { ...report.overallMetrics, structuredOutput: { ...report.overallMetrics.structuredOutput, correctiveRetryRate: 0 } } },
      "zero retry baseline",
    );
    const gateEval = evaluateReleaseGates({ report, baseline: zeroRetryBaseline });
    const schemaGate = gateEval.releaseGates.find((g) => g.gateId === "gate-schema-validity");
    expect(schemaGate?.status).toBe("fail");
    expect(gateEval.overallGateStatus).toBe("fail");
  });

  it("requires explicit approval to overwrite baseline and fails closed in live mode without credentials", async () => {
    const report = await runAIEvaluationSuite({ mode: "ci_mock", baseline: null });
    const baseline = buildBaselineFromReport(report, "test baseline");

    const tmpDir = mkdtempSync(path.join(tmpdir(), "fluxora-eval-"));
    try {
      const targetPath = path.join(tmpDir, "baseline.json");
      expect(() =>
        saveAIEvalBaseline(baseline, { approved: false, baselinePath: targetPath }),
      ).toThrow(/explicit approval/i);

      saveAIEvalBaseline(baseline, { approved: true, baselinePath: targetPath });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    await expect(
      runAIEvaluationSuite({
        mode: "live",
        environment: { USE_REAL_LLM: "false" },
      }),
    ).rejects.toThrow(/USE_REAL_LLM=true/i);
  });

  it("distinguishes evaluated cases from evaluated claims and records auditable claim counts, conservative rate, and denominator in baseline", async () => {
    const { sha256 } = loadAIEvalDataset();
    const report = await runAIEvaluationSuite({ mode: "ci_mock", baseline: null });
    const builtBaseline = buildBaselineFromReport(report, "auditable baseline test");

    expect(builtBaseline.sampleCount).toBe(builtBaseline.evaluatedCasesCount);
    expect(builtBaseline.evaluatedCasesCount).toBe(5);
    expect(builtBaseline.evaluatedClaimsCount).toBe(9);
    expect(builtBaseline.evaluatedClaimsCount).not.toBe(builtBaseline.evaluatedCasesCount);
    expect(builtBaseline.hallucinationRate).toBe(
      report.overallMetrics.semanticGroundedness.hallucinationRate,
    );
    expect(builtBaseline.conservativeHallucinationRate).toBe(
      report.overallMetrics.semanticGroundedness.conservativeHallucinationRate,
    );
    expect(builtBaseline.unsupportedClaimsCount).toBe(0);
    expect(builtBaseline.contradictedClaimsCount).toBe(0);
    expect(builtBaseline.ambiguousClaimsCount).toBe(0);
    expect(builtBaseline.hallucinationRateDenominator).toContain(
      "(unsupported + contradicted) / total_evaluated_factual_claims",
    );

    // Verify non-zero claim breakdown counts and conservativeHallucinationRate are faithfully persisted without recalculation
    const syntheticReport = {
      ...report,
      overallMetrics: {
        ...report.overallMetrics,
        semanticGroundedness: {
          ...report.overallMetrics.semanticGroundedness,
          totalEvaluatedClaims: 10,
          supportedClaims: 5,
          unsupportedClaims: 2,
          contradictedClaims: 1,
          ambiguousClaims: 2,
          hallucinationRate: 0.3,
          conservativeHallucinationRate: 0.5,
        },
      },
    };
    const syntheticBaseline = buildBaselineFromReport(syntheticReport, "synthetic breakdown");
    expect(syntheticBaseline.sampleCount).toBe(syntheticBaseline.evaluatedCasesCount);
    expect(syntheticBaseline.evaluatedCasesCount).toBe(5);
    expect(syntheticBaseline.evaluatedClaimsCount).toBe(10);
    expect(syntheticBaseline.hallucinationRate).toBe(0.3);
    expect(syntheticBaseline.conservativeHallucinationRate).toBe(0.5);
    expect(syntheticBaseline.unsupportedClaimsCount).toBe(2);
    expect(syntheticBaseline.contradictedClaimsCount).toBe(1);
    expect(syntheticBaseline.ambiguousClaimsCount).toBe(2);

    // Committed baseline matches current dataset hash and auditable fields
    const committedBaseline = loadAIEvalBaseline();
    expect(committedBaseline).not.toBeNull();
    expect(committedBaseline?.datasetHashSha256).toBe(sha256);
    expect(committedBaseline?.sampleCount).toBe(committedBaseline?.evaluatedCasesCount);
    expect(committedBaseline?.evaluatedCasesCount).toBe(5);
    expect(committedBaseline?.evaluatedClaimsCount).toBe(9);
    expect(committedBaseline?.hallucinationRate).toBe(0);
    expect(committedBaseline?.conservativeHallucinationRate).toBe(0);
    expect(committedBaseline?.unsupportedClaimsCount).toBe(0);
    expect(committedBaseline?.contradictedClaimsCount).toBe(0);
    expect(committedBaseline?.ambiguousClaimsCount).toBe(0);
    expect(committedBaseline?.hallucinationRateDenominator).toContain(
      "(unsupported + contradicted) / total_evaluated_factual_claims",
    );
  });
});
