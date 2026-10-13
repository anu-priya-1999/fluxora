import { GRAPH_QUERY_PATH, type GraphQueryRequest, type GraphQueryResponse } from "@fluxora/shared-types";
import { mapDomainGraphToFlow, type FluxoraFlowEdge, type FluxoraFlowNode } from "../../../../components/graph/graph-mapping.ts";

export interface ResolvedAnalysisContext {
  readonly repositoryId: string;
  readonly repositoryName?: string;
  readonly analysisRunId: string;
  readonly defaultStartNodeId: string;
}

export type ResolveAnalysisContextResult =
  | { readonly ok: true; readonly context: ResolvedAnalysisContext }
  | { readonly ok: false; readonly reason: "not_authenticated" | "repository_not_found" | "analysis_not_ready" | "error"; readonly message: string };

export type FetchGraphQueryResult =
  | { readonly ok: true; readonly data: GraphQueryResponse }
  | { readonly ok: false; readonly reason: "not_authenticated" | "invalid_request" | "not_found" | "network_error"; readonly message: string };

export type ExplorerState =
  | { readonly status: "loading" }
  | { readonly status: "not_ready"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly analysisRunId: string;
      readonly repositoryId: string;
      readonly graph: GraphQueryResponse;
      readonly flowNodes: readonly FluxoraFlowNode[];
      readonly flowEdges: readonly FluxoraFlowEdge[];
    };

/**
 * Executes POST /api/v1/graph/query from the browser using the session token.
 * Never sends organization_id.
 */
export async function fetchGraphQuery(input: {
  readonly apiUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly request: GraphQueryRequest;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<FetchGraphQueryResult> {
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
  let response: Response;

  try {
    response = await fetchImpl(`${input.apiUrl}${GRAPH_QUERY_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.request),
    });
  } catch {
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached from this page.",
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "not_authenticated",
        message: "You are not authorized to access this graph.",
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        reason: "not_found",
        message: "The requested graph node or analysis run was not found.",
      };
    }

    const errorMessage = extractErrorMessage(payload) ?? "Graph query failed.";
    return {
      ok: false,
      reason: "invalid_request",
      message: errorMessage,
    };
  }

  if (!isRecord(payload) || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Malformed graph response received from server.",
    };
  }

  return {
    ok: true,
    data: payload as unknown as GraphQueryResponse,
  };
}

/**
 * Builds a typed GraphQueryRequest from analysis context and user filter state.
 * Never includes organization_id (handled by session auth).
 * Omits empty arrays / default unconstrained values to keep query clean and deterministic.
 */
export function buildGraphQueryRequest(input: {
  readonly context: ResolvedAnalysisContext;
  readonly filters?: import("../../../../components/graph/GraphFilters.tsx").GraphFilterState | undefined;
  readonly direction?: import("@fluxora/shared-types").GraphQueryDirection | undefined;
  readonly includeEvidence?: boolean | undefined;
}): GraphQueryRequest {
  const { context, filters, direction = "both", includeEvidence = true } = input;
  const request: {
    analysis_run_id: string;
    start_node_id: string;
    direction?: import("@fluxora/shared-types").GraphQueryDirection;
    max_depth?: number;
    edge_types?: readonly string[];
    node_types?: readonly string[];
    min_confidence?: number;
    include_evidence?: boolean;
  } = {
    analysis_run_id: context.analysisRunId,
    start_node_id: context.defaultStartNodeId,
    direction,
    include_evidence: includeEvidence,
  };

  if (filters) {
    if (filters.nodeTypes.length > 0) {
      request.node_types = filters.nodeTypes;
    }
    if (filters.edgeTypes.length > 0) {
      request.edge_types = filters.edgeTypes;
    }
    if (filters.minConfidence > 0) {
      request.min_confidence = filters.minConfidence;
    }
    if (filters.maxDepth > 0) {
      request.max_depth = filters.maxDepth;
    }
  }

  return request;
}

/**
 * Transforms a GraphQueryResponse into mapped React Flow nodes and edges using Step 34 graph mapping.
 */
export function transformGraphResponseToFlow(response: GraphQueryResponse): {
  nodes: FluxoraFlowNode[];
  edges: FluxoraFlowEdge[];
} {
  return mapDomainGraphToFlow(response.nodes, response.edges);
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolveAnalysisContextInput {
  readonly repoId: string;
  readonly searchParams?: {
    readonly analysis_run_id?: string | string[] | undefined;
    readonly start_node_id?: string | string[] | undefined;
    readonly run_id?: string | string[] | undefined;
    readonly node_id?: string | string[] | undefined;
  } | undefined;
}

/**
 * Resolves repository and analysis context from route params and search params.
 * Does not communicate directly with the database.
 */
export function resolveRepositoryAnalysisContext(
  input: ResolveAnalysisContextInput,
): ResolveAnalysisContextResult {
  const repoId = input.repoId.trim();
  if (!UUID_REGEX.test(repoId)) {
    return {
      ok: false,
      reason: "repository_not_found",
      message: "Invalid repository identifier.",
    };
  }

  const rawRunId =
    firstParam(input.searchParams?.analysis_run_id) ??
    firstParam(input.searchParams?.run_id);

  if (!rawRunId || !UUID_REGEX.test(rawRunId.trim())) {
    return {
      ok: false,
      reason: "analysis_not_ready",
      message: "No usable analysis run found for this repository. Graph analysis is not ready yet.",
    };
  }

  const rawStartNodeId =
    firstParam(input.searchParams?.start_node_id) ??
    firstParam(input.searchParams?.node_id);

  if (!rawStartNodeId || !UUID_REGEX.test(rawStartNodeId.trim())) {
    return {
      ok: false,
      reason: "analysis_not_ready",
      message: "No start node specified for the analysis run.",
    };
  }

  return {
    ok: true,
    context: {
      repositoryId: repoId,
      analysisRunId: rawRunId.trim(),
      defaultStartNodeId: rawStartNodeId.trim(),
    },
  };
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
