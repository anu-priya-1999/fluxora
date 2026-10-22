import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  isScenarioRunPath,
  isScenariosPath,
  isSimulationGetPath,
  isSimulationResultsGetPath,
  matchScenarioRunPath,
  matchSimulationGetPath,
  matchSimulationResultsGetPath,
  parseCreateScenarioBody,
  parseRunScenarioBody,
  SimulationRequestValidationError,
} from "./simulation-request.ts";

const VALID_UUID_1 = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_2 = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_3 = "33333333-3333-4333-8333-333333333333";

describe("Simulation Request Routing and Matchers", () => {
  it("matches scenarios collection path with and without /api/v1 prefix", () => {
    assert.equal(isScenariosPath("/scenarios"), true);
    assert.equal(isScenariosPath("/scenarios/"), true);
    assert.equal(isScenariosPath("/api/v1/scenarios"), true);
    assert.equal(isScenariosPath("/api/v1/scenarios/"), true);
    assert.equal(isScenariosPath("/other"), false);
    assert.equal(isScenariosPath(`/scenarios/${VALID_UUID_1}`), false);
  });

  it("matches scenario run path and extracts scenarioId", () => {
    assert.equal(isScenarioRunPath(`/scenarios/${VALID_UUID_1}/run`), true);
    assert.equal(isScenarioRunPath(`/api/v1/scenarios/${VALID_UUID_1}/run`), true);
    assert.equal(isScenarioRunPath(`/scenarios/${VALID_UUID_1}/run/`), true);

    const match1 = matchScenarioRunPath(`/scenarios/${VALID_UUID_1}/run`);
    assert.ok(match1);
    assert.equal(match1.scenarioId, VALID_UUID_1);

    const match2 = matchScenarioRunPath(`/api/v1/scenarios/${VALID_UUID_2}/run`);
    assert.ok(match2);
    assert.equal(match2.scenarioId, VALID_UUID_2);

    assert.equal(matchScenarioRunPath("/scenarios/run"), null);
    assert.equal(matchScenarioRunPath("/scenarios"), null);
  });

  it("matches simulation get path and excludes results subpath", () => {
    assert.equal(isSimulationGetPath(`/simulations/${VALID_UUID_1}`), true);
    assert.equal(isSimulationGetPath(`/api/v1/simulations/${VALID_UUID_1}`), true);
    assert.equal(isSimulationGetPath(`/simulations/${VALID_UUID_1}/`), true);

    const match = matchSimulationGetPath(`/simulations/${VALID_UUID_1}`);
    assert.ok(match);
    assert.equal(match.simulationId, VALID_UUID_1);

    // Results path must not match simulation get
    assert.equal(isSimulationGetPath(`/simulations/${VALID_UUID_1}/results`), false);
    assert.equal(matchSimulationGetPath(`/simulations/${VALID_UUID_1}/results`), null);
  });

  it("matches simulation results get path", () => {
    assert.equal(isSimulationResultsGetPath(`/simulations/${VALID_UUID_1}/results`), true);
    assert.equal(isSimulationResultsGetPath(`/api/v1/simulations/${VALID_UUID_1}/results`), true);
    assert.equal(isSimulationResultsGetPath(`/simulations/${VALID_UUID_1}/results/`), true);

    const match = matchSimulationResultsGetPath(`/simulations/${VALID_UUID_1}/results`);
    assert.ok(match);
    assert.equal(match.simulationId, VALID_UUID_1);

    assert.equal(isSimulationResultsGetPath(`/simulations/${VALID_UUID_1}`), false);
  });
});

describe("parseCreateScenarioBody", () => {
  it("parses valid body with repository_id", () => {
    const input = parseCreateScenarioBody({
      name: "Payment Gateway Down",
      target_node_id: VALID_UUID_1,
      failure_type: "unavailable",
      repository_id: VALID_UUID_2,
      parameters: { timeout_ms: 5000 },
    });

    assert.equal(input.name, "Payment Gateway Down");
    assert.equal(input.targetNodeId, VALID_UUID_1);
    assert.equal(input.failureType, "unavailable");
    assert.equal(input.repositoryId, VALID_UUID_2);
    assert.deepEqual(input.parameters, { timeout_ms: 5000 });
  });

  it("parses valid body with latency failure type and analysis_run_id", () => {
    const input = parseCreateScenarioBody({
      name: "Slow Cache",
      targetNodeId: VALID_UUID_1,
      failureType: "latency",
      analysis_run_id: VALID_UUID_3,
    });

    assert.equal(input.name, "Slow Cache");
    assert.equal(input.targetNodeId, VALID_UUID_1);
    assert.equal(input.failureType, "latency");
    assert.equal(input.analysisRunId, VALID_UUID_3);
  });

  it("rejects non-object bodies", () => {
    assert.throws(
      () => parseCreateScenarioBody(null),
      (err: unknown) => err instanceof SimulationRequestValidationError && err.statusCode === 400,
    );
    assert.throws(
      () => parseCreateScenarioBody("string"),
      (err: unknown) => err instanceof SimulationRequestValidationError && err.statusCode === 400,
    );
    assert.throws(
      () => parseCreateScenarioBody([1, 2, 3]),
      (err: unknown) => err instanceof SimulationRequestValidationError && err.statusCode === 400,
    );
  });

  it("rejects caller-specified organization_id", () => {
    assert.throws(
      () =>
        parseCreateScenarioBody({
          organization_id: VALID_UUID_1,
          name: "Test",
          target_node_id: VALID_UUID_2,
          failure_type: "unavailable",
          repository_id: VALID_UUID_3,
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.message.includes("Tenant organization cannot be specified"),
    );
  });

  it("rejects missing or empty name", () => {
    assert.throws(
      () =>
        parseCreateScenarioBody({
          name: "   ",
          target_node_id: VALID_UUID_1,
          failure_type: "unavailable",
          repository_id: VALID_UUID_2,
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError && err.message.includes("name is required"),
    );
  });

  it("rejects invalid target_node_id", () => {
    assert.throws(
      () =>
        parseCreateScenarioBody({
          name: "Test",
          target_node_id: "not-a-uuid",
          failure_type: "unavailable",
          repository_id: VALID_UUID_2,
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.message.includes("target_node_id is required"),
    );
  });

  it("rejects unsupported failure types such as capacity and removal", () => {
    assert.throws(
      () =>
        parseCreateScenarioBody({
          name: "Test",
          target_node_id: VALID_UUID_1,
          failure_type: "capacity",
          repository_id: VALID_UUID_2,
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.code === "unsupported_failure_type" &&
        err.message.includes("capacity"),
    );

    assert.throws(
      () =>
        parseCreateScenarioBody({
          name: "Test",
          target_node_id: VALID_UUID_1,
          failure_type: "removal",
          repository_id: VALID_UUID_2,
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.code === "unsupported_failure_type" &&
        err.message.includes("removal"),
    );
  });

  it("rejects when neither repository_id nor analysis_run_id is supplied", () => {
    assert.throws(
      () =>
        parseCreateScenarioBody({
          name: "Test",
          target_node_id: VALID_UUID_1,
          failure_type: "unavailable",
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.message.includes("Either repository_id or analysis_run_id is required"),
    );
  });

  it("rejects invalid parameters type", () => {
    assert.throws(
      () =>
        parseCreateScenarioBody({
          name: "Test",
          target_node_id: VALID_UUID_1,
          failure_type: "unavailable",
          repository_id: VALID_UUID_2,
          parameters: "not-an-object",
        }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.message.includes("parameters must be a JSON object"),
    );
  });
});

describe("parseRunScenarioBody", () => {
  it("allows undefined or empty body", () => {
    assert.deepEqual(parseRunScenarioBody(undefined), {});
    assert.deepEqual(parseRunScenarioBody({}), {});
  });

  it("parses valid optional analysis_run_id", () => {
    const input = parseRunScenarioBody({
      analysis_run_id: VALID_UUID_1,
    });
    assert.equal(input.analysisRunId, VALID_UUID_1);
  });

  it("rejects tenant organization_id in body", () => {
    assert.throws(
      () => parseRunScenarioBody({ organization_id: VALID_UUID_1 }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.message.includes("Tenant organization cannot be specified"),
    );
  });

  it("rejects invalid analysis_run_id format", () => {
    assert.throws(
      () => parseRunScenarioBody({ analysis_run_id: "not-a-uuid" }),
      (err: unknown) =>
        err instanceof SimulationRequestValidationError &&
        err.message.includes("analysis_run_id must be a valid UUID"),
    );
  });
});

