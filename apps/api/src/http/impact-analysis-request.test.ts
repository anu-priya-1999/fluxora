import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ImpactRequestValidationError,
  isImpactAnalysisGetPath,
  isPullRequestAnalyzeImpactPath,
  matchImpactAnalysisGetPath,
  matchPullRequestAnalyzeImpactPath,
  parseAnalyzeImpactBody,
} from "./impact-analysis-request.ts";

const PR_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_ID = "33333333-3333-4333-8333-333333333333";

describe("impact-analysis-request path matchers", () => {
  it("matches POST /api/v1/pull-requests/:id/analyze-impact", () => {
    assert.equal(
      isPullRequestAnalyzeImpactPath(`/api/v1/pull-requests/${PR_ID}/analyze-impact`),
      true,
    );
    assert.equal(
      isPullRequestAnalyzeImpactPath(`/api/v1/pull-requests/${PR_ID}/analyze-impact/`),
      true,
    );
    assert.equal(
      isPullRequestAnalyzeImpactPath(`/api/v1/pull-requests/${PR_ID}/other`),
      false,
    );
    assert.equal(
      isPullRequestAnalyzeImpactPath(`/api/v1/pull-requests`),
      false,
    );

    const match = matchPullRequestAnalyzeImpactPath(
      `/api/v1/pull-requests/${PR_ID}/analyze-impact`,
    );
    assert.ok(match);
    assert.equal(match.pullRequestId, PR_ID);
  });

  it("matches GET /api/v1/impact-analyses/:id", () => {
    assert.equal(
      isImpactAnalysisGetPath(`/api/v1/impact-analyses/${ANALYSIS_ID}`),
      true,
    );
    assert.equal(
      isImpactAnalysisGetPath(`/api/v1/impact-analyses/${ANALYSIS_ID}/`),
      true,
    );
    assert.equal(
      isImpactAnalysisGetPath(`/api/v1/impact-analyses`),
      false,
    );
    assert.equal(
      isImpactAnalysisGetPath(`/api/v1/impact-analyses/${ANALYSIS_ID}/extra`),
      false,
    );

    const match = matchImpactAnalysisGetPath(
      `/api/v1/impact-analyses/${ANALYSIS_ID}`,
    );
    assert.ok(match);
    assert.equal(match.impactAnalysisId, ANALYSIS_ID);
  });
});

describe("parseAnalyzeImpactBody", () => {
  it("handles undefined or empty body with default options", () => {
    assert.deepEqual(parseAnalyzeImpactBody(undefined), {});
    assert.deepEqual(parseAnalyzeImpactBody(null), {});
    assert.deepEqual(parseAnalyzeImpactBody({}), {});
  });

  it("parses valid options", () => {
    const input = {
      analysis_run_id: RUN_ID,
      max_depth: 3,
      direction: "downstream",
      edge_types: ["CALLS", "IMPORTS"],
      node_types: ["module", "service"],
      decay_factor: 0.85,
      include_evidence: true,
    };

    const parsed = parseAnalyzeImpactBody(input);
    assert.equal(parsed.analysisRunId, RUN_ID);
    assert.equal(parsed.maxDepth, 3);
    assert.equal(parsed.publicDirection, "downstream");
    assert.equal(parsed.internalDirection, "outgoing");
    assert.deepEqual(parsed.edgeTypes, ["CALLS", "IMPORTS"]);
    assert.deepEqual(parsed.nodeTypes, ["module", "service"]);
    assert.equal(parsed.decayFactor, 0.85);
    assert.equal(parsed.includeEvidence, true);
  });

  it("rejects organization_id in request body", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ organization_id: "org-id" }),
      (err: unknown) => {
        return (
          err instanceof ImpactRequestValidationError &&
          err.code === "invalid_request" &&
          err.statusCode === 400
        );
      },
    );

    assert.throws(
      () => parseAnalyzeImpactBody({ organizationId: "org-id" }),
      (err: unknown) => {
        return (
          err instanceof ImpactRequestValidationError &&
          err.code === "invalid_request"
        );
      },
    );
  });

  it("rejects non-object body", () => {
    assert.throws(
      () => parseAnalyzeImpactBody("string"),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
    assert.throws(
      () => parseAnalyzeImpactBody([1, 2, 3]),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
  });

  it("rejects invalid analysis_run_id", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ analysis_run_id: "not-a-uuid" }),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
  });

  it("rejects invalid max_depth", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ max_depth: -1 }),
      (err: unknown) =>
        err instanceof ImpactRequestValidationError &&
        err.code === "invalid_traversal_options",
    );
    assert.throws(
      () => parseAnalyzeImpactBody({ max_depth: 25 }),
      (err: unknown) =>
        err instanceof ImpactRequestValidationError &&
        err.code === "invalid_traversal_options",
    );
    assert.throws(
      () => parseAnalyzeImpactBody({ max_depth: "three" }),
      (err: unknown) =>
        err instanceof ImpactRequestValidationError &&
        err.code === "invalid_traversal_options",
    );
  });

  it("rejects invalid direction", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ direction: "diagonal" }),
      (err: unknown) =>
        err instanceof ImpactRequestValidationError &&
        err.code === "invalid_traversal_options",
    );
  });

  it("rejects invalid edge_types", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ edge_types: "CALLS" }),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
    assert.throws(
      () => parseAnalyzeImpactBody({ edge_types: ["UNKNOWN_TYPE"] }),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
  });

  it("rejects invalid node_types", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ node_types: "service" }),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
    assert.throws(
      () => parseAnalyzeImpactBody({ node_types: ["unknown_node"] }),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
  });

  it("rejects invalid decay_factor", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ decay_factor: 1.5 }),
      (err: unknown) =>
        err instanceof ImpactRequestValidationError &&
        err.code === "invalid_traversal_options",
    );
    assert.throws(
      () => parseAnalyzeImpactBody({ decay_factor: -0.1 }),
      (err: unknown) =>
        err instanceof ImpactRequestValidationError &&
        err.code === "invalid_traversal_options",
    );
  });

  it("rejects non-boolean include_evidence", () => {
    assert.throws(
      () => parseAnalyzeImpactBody({ include_evidence: "yes" }),
      (err: unknown) => err instanceof ImpactRequestValidationError,
    );
  });
});

