import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it, beforeAll, afterAll } from "vitest";

import { loadRootEnvFile } from "../cli/env.ts";
import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import {
  AIAnalysisValidationError,
  getAIAnalysisById,
  getAIAnalysisBySubject,
  saveAIAnalysis,
  validateSaveAIAnalysisInput,
} from "./ai-analysis.ts";

loadRootEnvFile();

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

describe("AIAnalysis Repository & Persistence (Step 62)", () => {
  describe("Input validation (unit tests)", () => {
    const validOrgId = "11111111-1111-4111-8111-111111111111";
    const validSubjectId = "22222222-2222-4222-8222-222222222222";

    it("rejects invalid organization ID", () => {
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: "not-a-uuid",
            subjectId: validSubjectId,
            subjectType: "impact_analysis",
          }),
        AIAnalysisValidationError,
      );
    });

    it("rejects invalid subject ID", () => {
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: "invalid-uuid",
            subjectType: "impact_analysis",
          }),
        AIAnalysisValidationError,
      );
    });

    it("rejects unsupported subject type", () => {
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: validSubjectId,
            // @ts-expect-error Testing invalid runtime value
            subjectType: "unsupported_type",
          }),
        AIAnalysisValidationError,
      );
    });

    it("rejects unsupported lifecycle status", () => {
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: validSubjectId,
            subjectType: "impact_analysis",
            // @ts-expect-error Testing invalid runtime value
            status: "unknown_status",
          }),
        AIAnalysisValidationError,
      );
    });

    it("rejects unsupported validation status", () => {
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: validSubjectId,
            subjectType: "impact_analysis",
            // @ts-expect-error Testing invalid runtime value
            validationStatus: "invalid_val_status",
          }),
        AIAnalysisValidationError,
      );
    });

    it("rejects negative metrics", () => {
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: validSubjectId,
            subjectType: "impact_analysis",
            tokenCount: -5,
          }),
        AIAnalysisValidationError,
      );
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: validSubjectId,
            subjectType: "impact_analysis",
            costUsd: -0.01,
          }),
        AIAnalysisValidationError,
      );
      assert.throws(
        () =>
          validateSaveAIAnalysisInput({
            organizationId: validOrgId,
            subjectId: validSubjectId,
            subjectType: "impact_analysis",
            latencyMs: -100,
          }),
        AIAnalysisValidationError,
      );
    });
  });

  describe.skipIf(!hasDatabase)("Database integration & RLS", () => {
    let pool: ReturnType<typeof getPool>;
    let orgAId: string;
    let orgBId: string;

    beforeAll(async () => {
      pool = getPool();
      await runMigrations(pool);

      const orgA = await createOrganization(pool, { name: `ai-test-org-a-${Date.now()}` });
      const orgB = await createOrganization(pool, { name: `ai-test-org-b-${Date.now()}` });
      orgAId = orgA.id;
      orgBId = orgB.id;
    });

    afterAll(async () => {
      await closePool();
    });

    it("creates an initial pending AIAnalysis record", async () => {
      const subjectId = crypto.randomUUID();
      const created = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "pending",
      });

      assert.ok(created.id);
      assert.equal(created.organizationId, orgAId);
      assert.equal(created.subjectType, "impact_analysis");
      assert.equal(created.subjectId, subjectId);
      assert.equal(created.status, "pending");
      assert.equal(created.outputText, null);
      assert.equal(created.outputStructured, null);
      assert.equal(created.validationStatus, null);
      assert.equal(created.tokenCount, 0);
      assert.equal(created.costUsd, 0);
    });

    it("updates pending record to completed with validated structured output", async () => {
      const subjectId = crypto.randomUUID();
      // First save pending
      const initial = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "pending",
      });

      const structuredOutput = {
        summary: "PaymentService change cascades to CheckoutService.",
        claims: [
          {
            text: "CheckoutService depends on PaymentService directly.",
            evidence_ids: ["ev_1001"],
          },
        ],
        confidence: "high" as const,
        caveats: ["Context was bounded to direct dependencies."],
      };

      // Update to completed
      const updated = await saveAIAnalysis(pool, {
        id: initial.id,
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        modelUsed: "claude-sonnet-5-5",
        promptVersion: "impact-explain-v1",
        inputEvidenceIds: ["ev_1001", "ev_1002"],
        outputText: structuredOutput.summary,
        outputStructured: structuredOutput,
        validationStatus: "passed",
        tokenCount: 450,
        costUsd: 0.0035,
        latencyMs: 1200,
        metadata: { schemaVersion: "impact-explanation-output-v1", attempts: 1 },
      });

      assert.equal(updated.id, initial.id);
      assert.equal(updated.status, "completed");
      assert.equal(updated.validationStatus, "passed");
      assert.equal(updated.modelUsed, "claude-sonnet-5-5");
      assert.equal(updated.promptVersion, "impact-explain-v1");
      assert.deepEqual(updated.inputEvidenceIds, ["ev_1001", "ev_1002"]);
      assert.equal(updated.outputText, structuredOutput.summary);
      assert.deepEqual(updated.outputStructured, structuredOutput);
      assert.equal(updated.tokenCount, 450);
      assert.equal(updated.costUsd, 0.0035);
      assert.equal(updated.latencyMs, 1200);

      // Verify retrieval by ID
      const fetched = await getAIAnalysisById(pool, orgAId, initial.id);
      assert.ok(fetched);
      assert.equal(fetched.id, initial.id);
      assert.equal(fetched.status, "completed");

      // Verify retrieval by subject
      const fetchedBySubject = await getAIAnalysisBySubject(
        pool,
        orgAId,
        "impact_analysis",
        subjectId,
      );
      assert.ok(fetchedBySubject);
      assert.equal(fetchedBySubject.id, initial.id);
    });

    it("persists rejection without raw invalid model text", async () => {
      const subjectId = crypto.randomUUID();
      const rejected = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "rejected",
        modelUsed: "claude-sonnet-5-5",
        promptVersion: "impact-explain-v1",
        inputEvidenceIds: ["ev_1001"],
        outputText: null,
        outputStructured: null,
        validationStatus: "rejected",
        tokenCount: 300,
        costUsd: 0.002,
        latencyMs: 800,
        metadata: {
          schemaVersion: "impact-explanation-output-v1",
          attempts: 2,
          validationErrors: [{ code: "UNKNOWN_EVIDENCE_ID", path: "claims[0].evidence_ids[0]" }],
        },
      });

      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.validationStatus, "rejected");
      assert.equal(rejected.outputText, null);
      assert.equal(rejected.outputStructured, null);
      assert.ok(rejected.metadata?.validationErrors);
    });

    it("persists provider failure state cleanly", async () => {
      const subjectId = crypto.randomUUID();
      const failed = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "failed",
        modelUsed: "claude-sonnet-5-5",
        promptVersion: "impact-explain-v1",
        outputText: null,
        outputStructured: null,
        validationStatus: null,
        errorMessage: "Model provider gateway request timed out after 20000ms.",
      });

      assert.equal(failed.status, "failed");
      assert.equal(failed.validationStatus, null);
      assert.equal(failed.outputText, null);
      assert.equal(failed.outputStructured, null);
      assert.equal(failed.errorMessage, "Model provider gateway request timed out after 20000ms.");
    });

    it("enforces tenant isolation across organizations", async () => {
      const subjectId = crypto.randomUUID();
      const recordA = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        outputText: "Summary for Org A",
      });

      // Org B cannot access Org A's record by ID
      const crossTenantFetch = await getAIAnalysisById(pool, orgBId, recordA.id);
      assert.equal(crossTenantFetch, null);

      // Org B cannot access Org A's record by subject
      const crossTenantSubjectFetch = await getAIAnalysisBySubject(
        pool,
        orgBId,
        "impact_analysis",
        subjectId,
      );
      assert.equal(crossTenantSubjectFetch, null);
    });

    it("handles idempotency: repeated save on same subject updates rather than creates duplicate", async () => {
      const subjectId = crypto.randomUUID();
      const first = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "pending",
      });

      const second = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        outputText: "Updated summary",
      });

      assert.equal(second.id, first.id, "Must update the same row due to UNIQUE(org, subject_type, subject_id)");
      assert.equal(second.status, "completed");
      assert.equal(second.outputText, "Updated summary");
    });

    it("concurrency: late rejected write cannot overwrite completed result", async () => {
      const subjectId = crypto.randomUUID();

      // Worker A successfully completes and persists validated explanation
      const completed = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        modelUsed: "claude-sonnet-5-5",
        promptVersion: "impact-explain-v1",
        inputEvidenceIds: ["ev-1001", "ev-1002"],
        outputText: "Authoritative completed explanation",
        outputStructured: {
          summary: "Authoritative completed explanation",
          claims: [{ text: "Valid claim", evidence_ids: ["ev-1001"] }],
          confidence: "high",
          caveats: [],
        },
        validationStatus: "passed",
        tokenCount: 450,
        costUsd: 0.0045,
        latencyMs: 850,
        metadata: {
          schemaVersion: "v1",
          attempts: 1,
          provider: "mock-anthropic",
        },
      });

      assert.equal(completed.status, "completed");
      assert.equal(completed.validationStatus, "passed");

      // Worker B concurrently generated invalid response, exhausted retries, attempts to persist rejected
      const lateRejected = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "rejected",
        modelUsed: "rogue-model-v2",
        promptVersion: "rogue-prompt-v2",
        inputEvidenceIds: ["ev-9999"],
        outputText: null,
        outputStructured: null,
        validationStatus: "rejected",
        tokenCount: 1200,
        costUsd: 0.012,
        latencyMs: 2500,
        metadata: {
          schemaVersion: "v1",
          attempts: 2,
          validationErrors: [{ code: "ungrounded_citation", message: "Hallucinated citation" }],
        },
      });

      // Assert late rejected write was rejected by the database and completed state preserved
      assert.equal(lateRejected.id, completed.id);
      assert.equal(lateRejected.status, "completed", "Rejected write must not overwrite completed status");
      assert.equal(lateRejected.validationStatus, "passed", "Validation status must remain passed");
      assert.equal(lateRejected.outputText, "Authoritative completed explanation", "Output text must be preserved");
      assert.deepEqual(lateRejected.outputStructured, completed.outputStructured, "Output structured must be preserved");
      assert.equal(lateRejected.modelUsed, "claude-sonnet-5-5", "Model used must be preserved");
      assert.equal(lateRejected.promptVersion, "impact-explain-v1", "Prompt version must be preserved");
      assert.deepEqual(lateRejected.inputEvidenceIds, ["ev-1001", "ev-1002"], "Evidence IDs must be preserved");
      assert.equal(lateRejected.tokenCount, 450, "Token count must be preserved");
      assert.equal(lateRejected.costUsd, 0.0045, "Cost USD must be preserved");
      assert.equal(lateRejected.latencyMs, 850, "Latency ms must be preserved");
      assert.deepEqual(
        lateRejected.metadata,
        completed.metadata,
        "Metadata must not be polluted with validation errors from late rejected write",
      );
      assert.equal(lateRejected.errorMessage, null);
      assert.equal(
        lateRejected.updatedAt.getTime(),
        completed.updatedAt.getTime(),
        "Updated timestamp must not be bumped by late rejected write",
      );
    });

    it("concurrency: late failed write cannot overwrite completed result", async () => {
      const subjectId = crypto.randomUUID();

      const completed = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        outputText: "Authoritative completed explanation",
        validationStatus: "passed",
        tokenCount: 300,
        costUsd: 0.003,
        latencyMs: 600,
        metadata: { author: "Worker A" },
      });

      // Worker B hits transient network error and attempts to persist failed
      const lateFailed = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "failed",
        errorMessage: "Late transient upstream timeout 504",
        metadata: { errorDetail: "Gateway timeout" },
      });

      assert.equal(lateFailed.id, completed.id);
      assert.equal(lateFailed.status, "completed", "Failed write must not overwrite completed status");
      assert.equal(lateFailed.validationStatus, "passed", "Validation status must remain passed");
      assert.equal(lateFailed.outputText, "Authoritative completed explanation");
      assert.equal(lateFailed.errorMessage, null, "Error message must remain null");
      assert.deepEqual(lateFailed.metadata, { author: "Worker A" }, "Metadata must not be polluted by failed write");
      assert.equal(
        lateFailed.updatedAt.getTime(),
        completed.updatedAt.getTime(),
        "Updated timestamp must not be bumped by late failed write",
      );
    });

    it("concurrency: late pending write cannot overwrite completed result", async () => {
      const subjectId = crypto.randomUUID();

      const completed = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        outputText: "Authoritative completed explanation",
        validationStatus: "passed",
      });

      // Worker B attempts to record initial pending placeholder after Worker A completed
      const latePending = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "pending",
      });

      assert.equal(latePending.id, completed.id);
      assert.equal(latePending.status, "completed", "Pending write must not overwrite completed status");
      assert.equal(latePending.outputText, "Authoritative completed explanation");
      assert.equal(latePending.validationStatus, "passed");
      assert.equal(
        latePending.updatedAt.getTime(),
        completed.updatedAt.getTime(),
        "Updated timestamp must not be bumped by late pending write",
      );
    });

    it("concurrency: completed result remains readable with its original validated output and metadata after late writes", async () => {
      const subjectId = crypto.randomUUID();

      const completed = await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "completed",
        modelUsed: "claude-sonnet-5-5",
        promptVersion: "impact-explain-v1",
        inputEvidenceIds: ["ev-1", "ev-2"],
        outputText: "Authoritative completed explanation",
        outputStructured: {
          summary: "Authoritative completed explanation",
          claims: [{ text: "Verified Claim 1", evidence_ids: ["ev-1"] }],
          confidence: "high",
          caveats: ["Known boundary"],
        },
        validationStatus: "passed",
        tokenCount: 520,
        costUsd: 0.0052,
        latencyMs: 900,
        metadata: { authoritative: true, runId: "run-original" },
      });

      // Fire multiple late uncoordinated writes (pending, failed, rejected)
      await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "pending",
      });

      await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "failed",
        errorMessage: "Competing transient error",
        metadata: { corrupted: true },
      });

      await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "rejected",
        validationStatus: "rejected",
        metadata: { validationErrors: [{ code: "hallucination" }] },
      });

      // Query by subject
      const bySubject = await getAIAnalysisBySubject(pool, orgAId, "impact_analysis", subjectId);
      assert.ok(bySubject);
      assert.equal(bySubject.id, completed.id);
      assert.equal(bySubject.status, "completed");
      assert.equal(bySubject.validationStatus, "passed");
      assert.equal(bySubject.outputText, "Authoritative completed explanation");
      assert.deepEqual(bySubject.outputStructured, completed.outputStructured);
      assert.deepEqual(bySubject.metadata, { authoritative: true, runId: "run-original" });
      assert.equal(bySubject.errorMessage, null);
      assert.equal(bySubject.updatedAt.getTime(), completed.updatedAt.getTime());

      // Query by ID
      const byId = await getAIAnalysisById(pool, orgAId, completed.id);
      assert.ok(byId);
      assert.equal(byId.status, "completed");
      assert.equal(byId.validationStatus, "passed");
      assert.equal(byId.outputText, "Authoritative completed explanation");
      assert.deepEqual(byId.metadata, { authoritative: true, runId: "run-original" });
    });

    describe("Manifest persistence and empty manifest overwrite policy", () => {
      it("a completed update with a non-empty manifest replaces the previous manifest", async () => {
        const subjectId = crypto.randomUUID();

        // 1. Initial pending record with old manifest
        const initial = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
          inputEvidenceIds: ["ev-old-1", "ev-old-2"],
        });
        assert.deepEqual(initial.inputEvidenceIds, ["ev-old-1", "ev-old-2"]);

        // 2. Completed update with new non-empty manifest
        const completed = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          inputEvidenceIds: ["ev-new-1", "ev-new-2", "ev-new-3"],
          outputText: "Explanation with new evidence",
          validationStatus: "passed",
        });

        assert.equal(completed.id, initial.id);
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.inputEvidenceIds, ["ev-new-1", "ev-new-2", "ev-new-3"]);

        // Verify from database read
        const fetched = await getAIAnalysisBySubject(pool, orgAId, "impact_analysis", subjectId);
        assert.ok(fetched);
        assert.deepEqual(fetched.inputEvidenceIds, ["ev-new-1", "ev-new-2", "ev-new-3"]);
      });

      it("a completed update with an empty manifest stores an empty array rather than retaining stale IDs", async () => {
        const subjectId = crypto.randomUUID();

        // 1. Initial record with stale evidence IDs
        const initial = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
          inputEvidenceIds: ["ev-stale-1", "ev-stale-2"],
        });
        assert.deepEqual(initial.inputEvidenceIds, ["ev-stale-1", "ev-stale-2"]);

        // 2. Completed update with explicit empty manifest (e.g. 0-affected-nodes impact analysis)
        const completed = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          inputEvidenceIds: [],
          outputText: "Authoritative explanation with empty manifest",
          outputStructured: {
            summary: "Authoritative explanation with empty manifest",
            claims: [],
            confidence: "high",
            caveats: [],
          },
          validationStatus: "passed",
          tokenCount: 150,
          costUsd: 0.0015,
          latencyMs: 350,
          metadata: { emptyManifestAuthoritative: true },
        });

        assert.equal(completed.id, initial.id);
        assert.equal(completed.status, "completed");
        assert.equal(completed.inputEvidenceIds.length, 0);
        assert.deepEqual(completed.inputEvidenceIds, []);

        // Verify from fresh database query
        const fetched = await getAIAnalysisBySubject(pool, orgAId, "impact_analysis", subjectId);
        assert.ok(fetched);
        assert.equal(fetched.status, "completed");
        assert.equal(fetched.validationStatus, "passed");
        assert.equal(fetched.inputEvidenceIds.length, 0);
        assert.deepEqual(fetched.inputEvidenceIds, []);
        assert.equal(fetched.outputText, "Authoritative explanation with empty manifest");
        assert.deepEqual(fetched.metadata, { emptyManifestAuthoritative: true });
      });

      it("a late rejected write cannot overwrite a completed record with an empty manifest", async () => {
        const subjectId = crypto.randomUUID();

        // 1. Worker A completes with empty manifest
        const completed = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          inputEvidenceIds: [],
          outputText: "Authoritative completed explanation with empty manifest",
          validationStatus: "passed",
          tokenCount: 200,
          costUsd: 0.002,
          latencyMs: 400,
          metadata: { author: "Worker A", manifestCount: 0 },
        });
        assert.deepEqual(completed.inputEvidenceIds, []);

        // 2. Worker B late rejected write arrives with rogue evidence IDs
        const lateRejected = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "rejected",
          inputEvidenceIds: ["ev-rogue-1", "ev-rogue-2"],
          validationStatus: "rejected",
          outputText: null,
          metadata: { validationErrors: [{ code: "ungrounded_citation" }] },
        });

        // 3. Completed record with empty manifest is preserved
        assert.equal(lateRejected.id, completed.id);
        assert.equal(lateRejected.status, "completed");
        assert.equal(lateRejected.validationStatus, "passed");
        assert.deepEqual(lateRejected.inputEvidenceIds, []);
        assert.equal(lateRejected.outputText, "Authoritative completed explanation with empty manifest");
        assert.deepEqual(lateRejected.metadata, { author: "Worker A", manifestCount: 0 });
        assert.equal(lateRejected.updatedAt.getTime(), completed.updatedAt.getTime());

        // Verify direct DB query
        const fetched = await getAIAnalysisBySubject(pool, orgAId, "impact_analysis", subjectId);
        assert.ok(fetched);
        assert.equal(fetched.status, "completed");
        assert.deepEqual(fetched.inputEvidenceIds, []);
      });

      it("a late failed write cannot overwrite a completed record with an empty manifest", async () => {
        const subjectId = crypto.randomUUID();

        const completed = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          inputEvidenceIds: [],
          outputText: "Authoritative completed explanation",
          validationStatus: "passed",
          tokenCount: 180,
          costUsd: 0.0018,
          latencyMs: 380,
          metadata: { authoritative: true },
        });

        const lateFailed = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "failed",
          inputEvidenceIds: ["ev-failed-1"],
          errorMessage: "Worker B failed",
          metadata: { failed: true },
        });

        assert.equal(lateFailed.id, completed.id);
        assert.equal(lateFailed.status, "completed");
        assert.equal(lateFailed.validationStatus, "passed");
        assert.deepEqual(lateFailed.inputEvidenceIds, []);
        assert.equal(lateFailed.outputText, "Authoritative completed explanation");
        assert.equal(lateFailed.errorMessage, null);
        assert.deepEqual(lateFailed.metadata, { authoritative: true });
        assert.equal(lateFailed.updatedAt.getTime(), completed.updatedAt.getTime());
      });

      it("a late pending write cannot overwrite a completed record with an empty manifest", async () => {
        const subjectId = crypto.randomUUID();

        const completed = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          inputEvidenceIds: [],
          outputText: "Authoritative completed explanation",
          validationStatus: "passed",
        });

        const latePending = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
          inputEvidenceIds: ["ev-stale-retry"],
        });

        assert.equal(latePending.id, completed.id);
        assert.equal(latePending.status, "completed");
        assert.equal(latePending.validationStatus, "passed");
        assert.deepEqual(latePending.inputEvidenceIds, []);
        assert.equal(latePending.outputText, "Authoritative completed explanation");
        assert.equal(latePending.updatedAt.getTime(), completed.updatedAt.getTime());
      });

      it("stored output, validation status, metadata, usage, and timestamps remain consistent with intended update policy", async () => {
        const subjectId = crypto.randomUUID();

        // Initial pending with placeholder manifest
        const initial = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
          promptVersion: "impact-explain-v1",
          inputEvidenceIds: ["ev-initial"],
        });

        assert.equal(initial.status, "pending");
        assert.deepEqual(initial.inputEvidenceIds, ["ev-initial"]);

        // First completed write with non-empty manifest
        const firstCompleted = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          modelUsed: "claude-sonnet-5-5",
          promptVersion: "impact-explain-v1",
          inputEvidenceIds: ["ev-100", "ev-200"],
          outputText: "First completed summary",
          outputStructured: {
            summary: "First completed summary",
            claims: [{ text: "Claim 1", evidence_ids: ["ev-100"] }],
            confidence: "high",
            caveats: [],
          },
          validationStatus: "passed",
          tokenCount: 300,
          costUsd: 0.003,
          latencyMs: 500,
          metadata: { version: 1 },
        });

        assert.equal(firstCompleted.status, "completed");
        assert.equal(firstCompleted.validationStatus, "passed");
        assert.deepEqual(firstCompleted.inputEvidenceIds, ["ev-100", "ev-200"]);
        assert.equal(firstCompleted.outputText, "First completed summary");
        assert.equal(firstCompleted.tokenCount, 300);
        assert.equal(firstCompleted.costUsd, 0.003);
        assert.equal(firstCompleted.latencyMs, 500);

        // Competing completed write with updated output and empty manifest (legitimate update policy)
        const updatedCompleted = await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          modelUsed: "claude-sonnet-5-5",
          promptVersion: "impact-explain-v1",
          inputEvidenceIds: [],
          outputText: "Updated completed summary with empty manifest",
          outputStructured: {
            summary: "Updated completed summary with empty manifest",
            claims: [],
            confidence: "high",
            caveats: [],
          },
          validationStatus: "passed",
          tokenCount: 350,
          costUsd: 0.0035,
          latencyMs: 550,
          metadata: { version: 2 },
        });

        assert.equal(updatedCompleted.id, firstCompleted.id);
        assert.equal(updatedCompleted.status, "completed");
        assert.equal(updatedCompleted.validationStatus, "passed");
        assert.deepEqual(updatedCompleted.inputEvidenceIds, [], "Must replace non-empty manifest with empty array");
        assert.equal(updatedCompleted.outputText, "Updated completed summary with empty manifest");
        assert.equal(updatedCompleted.tokenCount, 350);
        assert.equal(updatedCompleted.costUsd, 0.0035);
        assert.equal(updatedCompleted.latencyMs, 550);
        assert.equal(updatedCompleted.metadata?.["version"], 2);

        // Now attempt late rejected, failed, and pending writes
        await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "rejected",
          inputEvidenceIds: ["ev-stale-ignored"],
          validationStatus: "rejected",
        });

        await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "failed",
          inputEvidenceIds: ["ev-failed-ignored"],
          errorMessage: "Should be ignored",
        });

        await saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
          inputEvidenceIds: ["ev-pending-ignored"],
        });

        // Verify final record remains exactly as updatedCompleted
        const finalRecord = await getAIAnalysisBySubject(pool, orgAId, "impact_analysis", subjectId);
        assert.ok(finalRecord);
        assert.equal(finalRecord.status, "completed");
        assert.equal(finalRecord.validationStatus, "passed");
        assert.deepEqual(finalRecord.inputEvidenceIds, []);
        assert.equal(finalRecord.outputText, "Updated completed summary with empty manifest");
        assert.deepEqual(finalRecord.outputStructured, updatedCompleted.outputStructured);
        assert.equal(finalRecord.tokenCount, 350);
        assert.equal(finalRecord.costUsd, 0.0035);
        assert.equal(finalRecord.latencyMs, 550);
        assert.equal(finalRecord.errorMessage, null);
        assert.equal(finalRecord.updatedAt.getTime(), updatedCompleted.updatedAt.getTime());
      });
    });

    it("handles simultaneous initial pending creation: two concurrent workers resolve to same record without unique collision", async () => {
      const subjectId = crypto.randomUUID();

      // Simulate two workers starting simultaneously and creating the pending record in parallel
      const [workerA, workerB] = await Promise.all([
        saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
        }),
        saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "pending",
        }),
      ]);

      assert.ok(workerA.id);
      assert.ok(workerB.id);
      assert.equal(
        workerA.id,
        workerB.id,
        "Concurrent initial pending writes must resolve to the exact same record ID",
      );
      assert.equal(workerA.status, "pending");
      assert.equal(workerB.status, "pending");

      // Verify exactly one record exists in DB
      const fetched = await getAIAnalysisBySubject(
        pool,
        orgAId,
        "impact_analysis",
        subjectId,
      );
      assert.ok(fetched);
      assert.equal(fetched.id, workerA.id);
    });

    it("handles competing concurrent completed writes: safely updates in-place without corrupting record", async () => {
      const subjectId = crypto.randomUUID();

      // Initial pending record
      await saveAIAnalysis(pool, {
        organizationId: orgAId,
        subjectType: "impact_analysis",
        subjectId,
        status: "pending",
      });

      // Two workers complete around the same time with valid outputs
      const [workerA, workerB] = await Promise.all([
        saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          outputText: "Summary from Worker A",
          validationStatus: "passed",
          tokenCount: 200,
          costUsd: 0.002,
          latencyMs: 400,
        }),
        saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          outputText: "Summary from Worker B",
          validationStatus: "passed",
          tokenCount: 220,
          costUsd: 0.0022,
          latencyMs: 450,
        }),
      ]);

      assert.equal(workerA.id, workerB.id);
      assert.equal(workerA.status, "completed");
      assert.equal(workerB.status, "completed");

      const fetched = await getAIAnalysisBySubject(
        pool,
        orgAId,
        "impact_analysis",
        subjectId,
      );
      assert.ok(fetched);
      assert.equal(fetched.status, "completed");
      assert.equal(fetched.validationStatus, "passed");
      assert.ok(
        fetched.outputText === "Summary from Worker A" ||
          fetched.outputText === "Summary from Worker B",
      );
    });

    it("competing concurrent completed vs failed writes preserves the completed state", async () => {
      const subjectId = crypto.randomUUID();

      // One worker completes while another worker hits a transient failure concurrently
      await Promise.all([
        saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "completed",
          outputText: "Validated Completed Summary",
          validationStatus: "passed",
          tokenCount: 300,
          costUsd: 0.003,
          latencyMs: 600,
        }),
        saveAIAnalysis(pool, {
          organizationId: orgAId,
          subjectType: "impact_analysis",
          subjectId,
          status: "failed",
          errorMessage: "Competing transient error",
        }),
      ]);

      const fetched = await getAIAnalysisBySubject(
        pool,
        orgAId,
        "impact_analysis",
        subjectId,
      );
      assert.ok(fetched);
      assert.equal(fetched.status, "completed", "Authoritative completed record must be preserved");
      assert.equal(fetched.outputText, "Validated Completed Summary");
      assert.equal(fetched.validationStatus, "passed");
    });
  });
});
