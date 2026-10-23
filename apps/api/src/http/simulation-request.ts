import type { ScenarioFailureType } from "@fluxora/shared-types";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SCENARIOS_PATTERN = /^(?:\/api\/v1)?\/scenarios\/?$/;
export const SCENARIO_RUN_PATTERN =
  /^(?:\/api\/v1)?\/scenarios\/([^/]+)\/run\/?$/;
export const SIMULATION_GET_PATTERN =
  /^(?:\/api\/v1)?\/simulations\/([^/]+)\/?$/;
export const SIMULATION_RESULTS_GET_PATTERN =
  /^(?:\/api\/v1)?\/simulations\/([^/]+)\/results\/?$/;

export class SimulationRequestValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    message: string,
    code = "invalid_request",
    statusCode = 400,
    details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "SimulationRequestValidationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

export function isScenariosPath(path: string): boolean {
  return SCENARIOS_PATTERN.test(path);
}

export function matchScenarioRunPath(
  path: string,
): { scenarioId: string } | null {
  const match = SCENARIO_RUN_PATTERN.exec(path);
  if (!match || !match[1]) {
    return null;
  }
  return { scenarioId: match[1] };
}

export function isScenarioRunPath(path: string): boolean {
  return matchScenarioRunPath(path) !== null;
}

export function matchSimulationGetPath(
  path: string,
): { simulationId: string } | null {
  // If path ends with /results, it should be handled by matchSimulationResultsGetPath instead
  if (isSimulationResultsGetPath(path)) {
    return null;
  }
  const match = SIMULATION_GET_PATTERN.exec(path);
  if (!match || !match[1]) {
    return null;
  }
  return { simulationId: match[1] };
}

export function isSimulationGetPath(path: string): boolean {
  return matchSimulationGetPath(path) !== null;
}

export function matchSimulationResultsGetPath(
  path: string,
): { simulationId: string } | null {
  const match = SIMULATION_RESULTS_GET_PATTERN.exec(path);
  if (!match || !match[1]) {
    return null;
  }
  return { simulationId: match[1] };
}

export function isSimulationResultsGetPath(path: string): boolean {
  return matchSimulationResultsGetPath(path) !== null;
}

export interface ParsedCreateScenarioInput {
  readonly name: string;
  readonly targetNodeId: string;
  readonly failureType: ScenarioFailureType;
  readonly repositoryId?: string | undefined;
  readonly analysisRunId?: string | undefined;
  readonly parameters?: Record<string, unknown> | undefined;
}

export function parseCreateScenarioBody(body: unknown): ParsedCreateScenarioInput {
  if (body === undefined || body === null) {
    throw new SimulationRequestValidationError(
      "Request body must be a JSON object.",
      "invalid_request",
      400,
    );
  }

  if (!isRecord(body)) {
    throw new SimulationRequestValidationError(
      "Request body must be a JSON object.",
      "invalid_request",
      400,
    );
  }

  // Reject explicit client tenant specification
  if ("organization_id" in body || "organizationId" in body) {
    throw new SimulationRequestValidationError(
      "Tenant organization cannot be specified in the request body.",
      "invalid_request",
      400,
    );
  }

  // Reject unsupported seed_failures property
  if ("seed_failures" in body || "seedFailures" in body) {
    throw new SimulationRequestValidationError(
      "seed_failures is not supported. Specify a single failure scenario via target_node_id and failure_type.",
      "invalid_request",
      400,
    );
  }

  // Validate name
  const rawName = body["name"];
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new SimulationRequestValidationError(
      "name is required and must be a non-empty string.",
      "invalid_request",
      400,
    );
  }

  // Validate target_node_id
  const rawTargetNodeId = body["target_node_id"] ?? body["targetNodeId"];
  if (typeof rawTargetNodeId !== "string" || !isUuid(rawTargetNodeId)) {
    throw new SimulationRequestValidationError(
      "target_node_id is required and must be a valid UUID string.",
      "invalid_request",
      400,
    );
  }

  // Validate failure_type
  const rawFailureType = body["failure_type"] ?? body["failureType"];
  if (typeof rawFailureType !== "string" || rawFailureType.trim().length === 0) {
    throw new SimulationRequestValidationError(
      "failure_type is required.",
      "invalid_request",
      400,
    );
  }

  const failureType = rawFailureType.trim();
  if (failureType !== "unavailable" && failureType !== "latency") {
    throw new SimulationRequestValidationError(
      `Unsupported scenario failure type: "${failureType}". MVP simulation engine only supports "unavailable" and "latency".`,
      "unsupported_failure_type",
      400,
    );
  }

  // Validate repository_id if present
  let repositoryId: string | undefined;
  const rawRepositoryId = body["repository_id"] ?? body["repositoryId"];
  if (rawRepositoryId !== undefined && rawRepositoryId !== null) {
    if (typeof rawRepositoryId !== "string" || !isUuid(rawRepositoryId)) {
      throw new SimulationRequestValidationError(
        "repository_id must be a valid UUID string.",
        "invalid_request",
        400,
      );
    }
    repositoryId = rawRepositoryId.trim();
  }

  // Validate analysis_run_id if present
  let analysisRunId: string | undefined;
  const rawAnalysisRunId = body["analysis_run_id"] ?? body["analysisRunId"];
  if (rawAnalysisRunId !== undefined && rawAnalysisRunId !== null) {
    if (typeof rawAnalysisRunId !== "string" || !isUuid(rawAnalysisRunId)) {
      throw new SimulationRequestValidationError(
        "analysis_run_id must be a valid UUID string.",
        "invalid_request",
        400,
      );
    }
    analysisRunId = rawAnalysisRunId.trim();
  }

  if (repositoryId === undefined && analysisRunId === undefined) {
    throw new SimulationRequestValidationError(
      "Either repository_id or analysis_run_id is required.",
      "invalid_request",
      400,
    );
  }

  // Validate optional parameters
  let parameters: Record<string, unknown> | undefined;
  const rawParameters = body["parameters"];
  if (rawParameters !== undefined && rawParameters !== null) {
    if (!isRecord(rawParameters)) {
      throw new SimulationRequestValidationError(
        "parameters must be a JSON object.",
        "invalid_request",
        400,
      );
    }
    parameters = rawParameters;
  }

  return {
    name: rawName.trim(),
    targetNodeId: rawTargetNodeId.trim(),
    failureType: failureType as ScenarioFailureType,
    repositoryId,
    analysisRunId,
    parameters,
  };
}

export interface ParsedRunScenarioInput {
  readonly analysisRunId?: string | undefined;
}

export function parseRunScenarioBody(body: unknown): ParsedRunScenarioInput {
  if (body === undefined || body === null) {
    return {};
  }

  if (!isRecord(body)) {
    throw new SimulationRequestValidationError(
      "Request body must be a JSON object.",
      "invalid_request",
      400,
    );
  }

  // Reject explicit client tenant specification
  if ("organization_id" in body || "organizationId" in body) {
    throw new SimulationRequestValidationError(
      "Tenant organization cannot be specified in the request body.",
      "invalid_request",
      400,
    );
  }

  let analysisRunId: string | undefined;
  const rawAnalysisRunId = body["analysis_run_id"] ?? body["analysisRunId"];
  if (rawAnalysisRunId !== undefined && rawAnalysisRunId !== null) {
    if (typeof rawAnalysisRunId !== "string" || !isUuid(rawAnalysisRunId)) {
      throw new SimulationRequestValidationError(
        "analysis_run_id must be a valid UUID string.",
        "invalid_request",
        400,
      );
    }
    analysisRunId = rawAnalysisRunId.trim();
    return { analysisRunId };
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
