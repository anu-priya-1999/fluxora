import {
  DEFAULT_MAX_TRAVERSAL_DEPTH,
  GRAPH_QUERY_PATH,
  GraphEdgeTypes,
  GraphNodeTypes,
  GraphQueryDirections,
  HARD_MAX_TRAVERSAL_DEPTH,
  type GraphEdgeType,
  type GraphNodeType,
  type GraphQueryDirection,
  type GraphTraversalOptions,
  type TraversalDirection,
} from "@fluxora/shared-types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GraphQueryValidationError extends Error {
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
    this.name = "GraphQueryValidationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isGraphQueryPath(path: string): boolean {
  return path === GRAPH_QUERY_PATH;
}

export interface ParsedGraphQueryInput {
  readonly analysisRunId: string;
  readonly startNodeId: string;
  readonly maxDepth: number;
  readonly internalDirection: TraversalDirection;
  readonly publicDirection: GraphQueryDirection;
  readonly edgeTypes?: readonly GraphEdgeType[] | undefined;
  readonly nodeTypes?: readonly GraphNodeType[] | undefined;
  readonly minConfidence?: number | undefined;
  readonly includeEvidence: boolean;
}

export function mapDirectionToInternal(direction: GraphQueryDirection): TraversalDirection {
  switch (direction) {
    case "downstream":
      return "outgoing";
    case "upstream":
      return "incoming";
    case "both":
      return "both";
  }
}

export function parseGraphQueryBody(body: unknown): ParsedGraphQueryInput {
  if (!isRecord(body)) {
    throw new GraphQueryValidationError(
      "Request body must be a JSON object.",
      "invalid_request",
      400,
    );
  }

  // Reject unexpected or prohibited fields such as organization_id
  if ("organization_id" in body || "organizationId" in body) {
    throw new GraphQueryValidationError(
      "Tenant organization cannot be specified in the request body.",
      "invalid_request",
      400,
    );
  }

  const analysisRunId = body["analysis_run_id"];
  if (typeof analysisRunId !== "string" || !UUID_REGEX.test(analysisRunId.trim())) {
    throw new GraphQueryValidationError(
      "analysis_run_id must be a valid UUID string.",
      "invalid_request",
      400,
    );
  }

  const startNodeId = body["start_node_id"];
  if (typeof startNodeId !== "string" || !UUID_REGEX.test(startNodeId.trim())) {
    throw new GraphQueryValidationError(
      "start_node_id must be a valid UUID string.",
      "invalid_request",
      400,
    );
  }

  // Validate direction
  const rawDirection = body["direction"];
  let publicDirection: GraphQueryDirection = "downstream";
  if (rawDirection !== undefined) {
    if (
      typeof rawDirection !== "string" ||
      !(GraphQueryDirections as readonly string[]).includes(rawDirection)
    ) {
      throw new GraphQueryValidationError(
        `direction must be one of: ${GraphQueryDirections.join(", ")}. Received: ${String(rawDirection)}`,
        "invalid_traversal_options",
        400,
      );
    }
    publicDirection = rawDirection as GraphQueryDirection;
  }

  // Validate max_depth
  const rawMaxDepth = body["max_depth"];
  let maxDepth = DEFAULT_MAX_TRAVERSAL_DEPTH;
  if (rawMaxDepth !== undefined) {
    if (
      typeof rawMaxDepth !== "number" ||
      !Number.isInteger(rawMaxDepth) ||
      rawMaxDepth < 0 ||
      rawMaxDepth > HARD_MAX_TRAVERSAL_DEPTH
    ) {
      throw new GraphQueryValidationError(
        `max_depth must be an integer between 0 and ${HARD_MAX_TRAVERSAL_DEPTH}. Received: ${String(rawMaxDepth)}`,
        "invalid_traversal_options",
        400,
      );
    }
    maxDepth = rawMaxDepth;
  }

  // Validate edge_types
  const rawEdgeTypes = body["edge_types"];
  let edgeTypes: GraphEdgeType[] | undefined;
  if (rawEdgeTypes !== undefined) {
    if (!Array.isArray(rawEdgeTypes)) {
      throw new GraphQueryValidationError(
        "edge_types must be an array of strings.",
        "invalid_request",
        400,
      );
    }
    const validatedEdges: GraphEdgeType[] = [];
    for (const item of rawEdgeTypes) {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new GraphQueryValidationError(
          "edge_types elements must be non-empty strings.",
          "invalid_request",
          400,
        );
      }
      const trimmed = item.trim();
      if (!(GraphEdgeTypes as readonly string[]).includes(trimmed)) {
        throw new GraphQueryValidationError(
          `Unknown edge_type: ${trimmed}. Allowed types: ${GraphEdgeTypes.join(", ")}`,
          "invalid_request",
          400,
        );
      }
      validatedEdges.push(trimmed as GraphEdgeType);
    }
    edgeTypes = validatedEdges;
  }

  // Validate node_types
  const rawNodeTypes = body["node_types"];
  let nodeTypes: GraphNodeType[] | undefined;
  if (rawNodeTypes !== undefined) {
    if (!Array.isArray(rawNodeTypes)) {
      throw new GraphQueryValidationError(
        "node_types must be an array of strings.",
        "invalid_request",
        400,
      );
    }
    const validatedNodes: GraphNodeType[] = [];
    for (const item of rawNodeTypes) {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new GraphQueryValidationError(
          "node_types elements must be non-empty strings.",
          "invalid_request",
          400,
        );
      }
      const trimmed = item.trim();
      if (!(GraphNodeTypes as readonly string[]).includes(trimmed)) {
        throw new GraphQueryValidationError(
          `Unknown node_type: ${trimmed}. Allowed types: ${GraphNodeTypes.join(", ")}`,
          "invalid_request",
          400,
        );
      }
      validatedNodes.push(trimmed as GraphNodeType);
    }
    nodeTypes = validatedNodes;
  }

  // Validate min_confidence
  const rawMinConfidence = body["min_confidence"];
  let minConfidence: number | undefined;
  if (rawMinConfidence !== undefined) {
    if (
      typeof rawMinConfidence !== "number" ||
      !Number.isFinite(rawMinConfidence) ||
      rawMinConfidence < 0 ||
      rawMinConfidence > 1
    ) {
      throw new GraphQueryValidationError(
        "min_confidence must be a number between 0 and 1.",
        "invalid_request",
        400,
      );
    }
    minConfidence = rawMinConfidence;
  }

  // Validate include_evidence
  const rawIncludeEvidence = body["include_evidence"];
  let includeEvidence = true;
  if (rawIncludeEvidence !== undefined) {
    if (typeof rawIncludeEvidence !== "boolean") {
      throw new GraphQueryValidationError(
        "include_evidence must be a boolean.",
        "invalid_request",
        400,
      );
    }
    includeEvidence = rawIncludeEvidence;
  }

  return {
    analysisRunId: analysisRunId.trim(),
    startNodeId: startNodeId.trim(),
    maxDepth,
    internalDirection: mapDirectionToInternal(publicDirection),
    publicDirection,
    edgeTypes,
    nodeTypes,
    minConfidence,
    includeEvidence,
  };
}

export function toGraphTraversalOptions(
  organizationId: string,
  input: ParsedGraphQueryInput,
): GraphTraversalOptions {
  const options: GraphTraversalOptions = {
    organizationId,
    analysisRunId: input.analysisRunId,
    startNodeId: input.startNodeId,
    maxDepth: input.maxDepth,
    direction: input.internalDirection,
    includeEvidence: input.includeEvidence,
  };

  if (input.edgeTypes !== undefined) {
    (options as { edgeTypes?: readonly GraphEdgeType[] }).edgeTypes = input.edgeTypes;
  }
  if (input.nodeTypes !== undefined) {
    (options as { nodeTypes?: readonly GraphNodeType[] }).nodeTypes = input.nodeTypes;
  }

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
