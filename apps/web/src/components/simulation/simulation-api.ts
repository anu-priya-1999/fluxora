import {
  GRAPH_QUERY_PATH,
  SCENARIOS_PATH,
  SIMULATIONS_PATH,
  type CreateScenarioRequest,
  type GraphQueryRequest,
  type GraphQueryResponse,
  type RunScenarioRequest,
  type ScenarioResponse,
  type SimulationResponse,
  type SimulationResultsListResponse,
} from "@fluxora/shared-types";
import type { ApiResult, ApiResultReason } from "./simulation-types.ts";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUrl(apiUrl: string, path: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "object" &&
    (payload as { error: unknown }).error !== null &&
    "message" in ((payload as { error: unknown }).error as Record<string, unknown>)
  ) {
    const errorObj = (payload as { error: { message: unknown } }).error;
    if (typeof errorObj.message === "string") {
      return errorObj.message;
    }
  }
  return undefined;
}

function extractErrorCode(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "object" &&
    (payload as { error: unknown }).error !== null &&
    "code" in ((payload as { error: unknown }).error as Record<string, unknown>)
  ) {
    const errorObj = (payload as { error: { code: unknown } }).error;
    if (typeof errorObj.code === "string") {
      return errorObj.code;
    }
  }
  return undefined;
}

function mapStatusToReason(statusCode: number, errorCode?: string): ApiResultReason {
  if (statusCode === 401 || statusCode === 403) {
    return "not_authenticated";
  }
  if (statusCode === 404) {
    return "not_found";
  }
  if (statusCode === 422 || errorCode === "simulation_convergence_failure") {
    return "convergence_failure";
  }
  if (statusCode === 400) {
    if (errorCode === "unsupported_failure_type") {
      return "unsupported_failure_type";
    }
    return "invalid_request";
  }
  return "server_error";
}

/**
 * Executes POST /api/v1/graph/query to load real nodes and edges from an analysis run snapshot.
 */
export async function fetchAnalysisGraph(input: {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly analysisRunId: string;
  readonly startNodeId: string;
  readonly maxDepth?: number | undefined;
  readonly fetchImpl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ApiResult<GraphQueryResponse>> {
  if (!UUID_REGEX.test(input.analysisRunId.trim())) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Invalid analysis run identifier format.",
    };
  }

  if (!UUID_REGEX.test(input.startNodeId.trim())) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Invalid start node identifier format.",
    };
  }

  let token: string | null;
  try {
    token = await input.getToken();
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication token could not be retrieved.",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication required.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const requestBody: GraphQueryRequest = {
    analysis_run_id: input.analysisRunId.trim(),
    start_node_id: input.startNodeId.trim(),
    direction: "both",
    max_depth: input.maxDepth ?? 5,
    include_evidence: true,
  };

  try {
    const response = await fetchImpl(cleanUrl(input.apiUrl, GRAPH_QUERY_PATH), {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = extractErrorCode(payload);
      const reason = mapStatusToReason(response.status, code);
      const message = extractErrorMessage(payload) ?? "Failed to query analysis graph.";
      return {
        ok: false,
        reason,
        message,
        statusCode: response.status,
      };
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("nodes" in payload) ||
      !Array.isArray((payload as { nodes: unknown }).nodes)
    ) {
      return {
        ok: false,
        reason: "invalid_request",
        message: "Malformed graph query response received from server.",
      };
    }

    return {
      ok: true,
      data: payload as unknown as GraphQueryResponse,
    };
  } catch {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: "network_error",
        message: "Graph query request was cancelled.",
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached to query the graph.",
    };
  }
}

/**
 * Executes POST /api/v1/scenarios to create a new failure scenario record.
 * Never includes organization_id in body (derived by server session token).
 */
export async function createScenarioApi(input: {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly request: CreateScenarioRequest;
  readonly fetchImpl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ApiResult<ScenarioResponse>> {
  let token: string | null;
  try {
    token = await input.getToken();
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication token could not be retrieved.",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication required.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(cleanUrl(input.apiUrl, SCENARIOS_PATH), {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.request),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = extractErrorCode(payload);
      const reason = mapStatusToReason(response.status, code);
      const message = extractErrorMessage(payload) ?? "Failed to create scenario.";
      return {
        ok: false,
        reason,
        message,
        statusCode: response.status,
      };
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("id" in payload) ||
      typeof (payload as { id: unknown }).id !== "string"
    ) {
      return {
        ok: false,
        reason: "invalid_request",
        message: "Malformed scenario response received from server.",
      };
    }

    return {
      ok: true,
      data: payload as unknown as ScenarioResponse,
    };
  } catch {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: "network_error",
        message: "Scenario creation request was cancelled.",
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached to create scenario.",
    };
  }
}

/**
 * Executes POST /api/v1/scenarios/:id/run to run the deterministic simulation engine.
 */
export async function runScenarioApi(input: {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly scenarioId: string;
  readonly request?: RunScenarioRequest | undefined;
  readonly fetchImpl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ApiResult<SimulationResponse>> {
  const scenarioId = input.scenarioId.trim();
  if (!UUID_REGEX.test(scenarioId)) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Invalid scenario identifier format. Must be a UUID.",
    };
  }

  let token: string | null;
  try {
    token = await input.getToken();
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication token could not be retrieved.",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication required.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = cleanUrl(input.apiUrl, `${SCENARIOS_PATH}/${scenarioId}/run`);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: input.request ? JSON.stringify(input.request) : "{}",
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = extractErrorCode(payload);
      const reason = mapStatusToReason(response.status, code);
      const message = extractErrorMessage(payload) ?? "Failed to run simulation.";
      return {
        ok: false,
        reason,
        message,
        statusCode: response.status,
      };
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("id" in payload) ||
      typeof (payload as { id: unknown }).id !== "string"
    ) {
      return {
        ok: false,
        reason: "invalid_request",
        message: "Malformed simulation execution response received from server.",
      };
    }

    return {
      ok: true,
      data: payload as unknown as SimulationResponse,
    };
  } catch {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: "network_error",
        message: "Simulation run request was cancelled.",
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached to run the simulation.",
    };
  }
}

/**
 * Executes GET /api/v1/simulations/:id to retrieve simulation execution metadata.
 */
export async function getSimulationApi(input: {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly simulationId: string;
  readonly fetchImpl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ApiResult<SimulationResponse>> {
  const simulationId = input.simulationId.trim();
  if (!UUID_REGEX.test(simulationId)) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Invalid simulation identifier format. Must be a UUID.",
    };
  }

  let token: string | null;
  try {
    token = await input.getToken();
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication token could not be retrieved.",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication required.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = cleanUrl(input.apiUrl, `${SIMULATIONS_PATH}/${simulationId}`);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = extractErrorCode(payload);
      const reason = mapStatusToReason(response.status, code);
      const message = extractErrorMessage(payload) ?? "Failed to retrieve simulation.";
      return {
        ok: false,
        reason,
        message,
        statusCode: response.status,
      };
    }

    return {
      ok: true,
      data: payload as unknown as SimulationResponse,
    };
  } catch {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: "network_error",
        message: "Simulation request was cancelled.",
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached to retrieve simulation.",
    };
  }
}

/**
 * Executes GET /api/v1/simulations/:id/results to retrieve persisted simulation node results.
 */
export async function getSimulationResultsApi(input: {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly simulationId: string;
  readonly fetchImpl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ApiResult<SimulationResultsListResponse>> {
  const simulationId = input.simulationId.trim();
  if (!UUID_REGEX.test(simulationId)) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Invalid simulation identifier format. Must be a UUID.",
    };
  }

  let token: string | null;
  try {
    token = await input.getToken();
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication token could not be retrieved.",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication required.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = cleanUrl(input.apiUrl, `${SIMULATIONS_PATH}/${simulationId}/results`);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const code = extractErrorCode(payload);
      const reason = mapStatusToReason(response.status, code);
      const message = extractErrorMessage(payload) ?? "Failed to retrieve simulation results.";
      return {
        ok: false,
        reason,
        message,
        statusCode: response.status,
      };
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("results" in payload) ||
      !Array.isArray((payload as { results: unknown }).results)
    ) {
      return {
        ok: false,
        reason: "invalid_request",
        message: "Malformed simulation results response received from server.",
      };
    }

    return {
      ok: true,
      data: payload as unknown as SimulationResultsListResponse,
    };
  } catch {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: "network_error",
        message: "Simulation results request was cancelled.",
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached to retrieve simulation results.",
    };
  }
}

