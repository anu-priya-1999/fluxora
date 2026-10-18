import {
  GraphEdgeTypes,
  GraphNodeTypes,
  GraphQueryDirections,
  HARD_MAX_IMPACT_DEPTH,
  type GraphEdgeType,
  type GraphNodeType,
  type GraphQueryDirection,
  type TraversalDirection,
} from "@fluxora/shared-types";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PULL_REQUEST_ANALYZE_IMPACT_PATTERN =
  /^\/api\/v1\/pull-requests\/([^/]+)\/analyze-impact\/?$/;

export const IMPACT_ANALYSIS_GET_PATTERN =
  /^\/api\/v1\/impact-analyses\/([^/]+)\/?$/;

export class ImpactRequestValidationError extends Error {
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
    this.name = "ImpactRequestValidationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

export function matchPullRequestAnalyzeImpactPath(
  path: string,
): { pullRequestId: string } | null {
  const match = PULL_REQUEST_ANALYZE_IMPACT_PATTERN.exec(path);
  if (!match || !match[1]) {
    return null;
  }
  return { pullRequestId: match[1] };
}

export function isPullRequestAnalyzeImpactPath(path: string): boolean {
  return matchPullRequestAnalyzeImpactPath(path) !== null;
}

export function matchImpactAnalysisGetPath(
  path: string,
): { impactAnalysisId: string } | null {
  const match = IMPACT_ANALYSIS_GET_PATTERN.exec(path);
  if (!match || !match[1]) {
    return null;
  }
  return { impactAnalysisId: match[1] };
}

export function isImpactAnalysisGetPath(path: string): boolean {
  return matchImpactAnalysisGetPath(path) !== null;
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

export interface ParsedAnalyzeImpactInput {
  readonly analysisRunId?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly internalDirection?: TraversalDirection | undefined;
  readonly publicDirection?: GraphQueryDirection | undefined;
  readonly edgeTypes?: readonly GraphEdgeType[] | undefined;
  readonly nodeTypes?: readonly GraphNodeType[] | undefined;
  readonly decayFactor?: number | undefined;
  readonly includeEvidence?: boolean | undefined;
}

export function parseAnalyzeImpactBody(body: unknown): ParsedAnalyzeImpactInput {
  if (body === undefined || body === null) {
    return {};
  }

  if (!isRecord(body)) {
    throw new ImpactRequestValidationError(
      "Request body must be a JSON object.",
      "invalid_request",
      400,
    );
  }

  // Reject explicit client tenant specification
  if ("organization_id" in body || "organizationId" in body) {
    throw new ImpactRequestValidationError(
      "Tenant organization cannot be specified in the request body.",
      "invalid_request",
      400,
    );
  }

  let analysisRunId: string | undefined;
  const rawRunId = body["analysis_run_id"];
  if (rawRunId !== undefined) {
    if (typeof rawRunId !== "string" || !isUuid(rawRunId)) {
      throw new ImpactRequestValidationError(
        "analysis_run_id must be a valid UUID string.",
        "invalid_request",
        400,
      );
    }
    analysisRunId = rawRunId.trim();
  }

  let maxDepth: number | undefined;
  const rawMaxDepth = body["max_depth"];
  if (rawMaxDepth !== undefined) {
    if (
      typeof rawMaxDepth !== "number" ||
      !Number.isInteger(rawMaxDepth) ||
      rawMaxDepth < 0 ||
      rawMaxDepth > HARD_MAX_IMPACT_DEPTH
    ) {
      throw new ImpactRequestValidationError(
        `max_depth must be an integer between 0 and ${HARD_MAX_IMPACT_DEPTH}. Received: ${String(rawMaxDepth)}`,
        "invalid_traversal_options",
        400,
      );
    }
    maxDepth = rawMaxDepth;
  }

  let publicDirection: GraphQueryDirection | undefined;
  let internalDirection: TraversalDirection | undefined;
  const rawDirection = body["direction"];
  if (rawDirection !== undefined) {
    if (
      typeof rawDirection !== "string" ||
      !(GraphQueryDirections as readonly string[]).includes(rawDirection)
    ) {
      throw new ImpactRequestValidationError(
        `direction must be one of: ${GraphQueryDirections.join(", ")}. Received: ${String(rawDirection)}`,
        "invalid_traversal_options",
        400,
      );
    }
    publicDirection = rawDirection as GraphQueryDirection;
    internalDirection = mapDirectionToInternal(publicDirection);
  }

  let edgeTypes: GraphEdgeType[] | undefined;
  const rawEdgeTypes = body["edge_types"];
  if (rawEdgeTypes !== undefined) {
    if (!Array.isArray(rawEdgeTypes)) {
      throw new ImpactRequestValidationError(
        "edge_types must be an array of strings.",
        "invalid_request",
        400,
      );
    }
    const validatedEdges: GraphEdgeType[] = [];
    for (const item of rawEdgeTypes) {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new ImpactRequestValidationError(
          "Each edge_type must be a non-empty string.",
          "invalid_request",
          400,
        );
      }
      const trimmed = item.trim();
      if (!(GraphEdgeTypes as readonly string[]).includes(trimmed)) {
        throw new ImpactRequestValidationError(
          `Unknown edge type: "${trimmed}". Valid types: ${GraphEdgeTypes.join(", ")}`,
          "invalid_request",
          400,
        );
      }
      validatedEdges.push(trimmed as GraphEdgeType);
    }
    edgeTypes = validatedEdges;
  }

  let nodeTypes: GraphNodeType[] | undefined;
  const rawNodeTypes = body["node_types"];
  if (rawNodeTypes !== undefined) {
    if (!Array.isArray(rawNodeTypes)) {
      throw new ImpactRequestValidationError(
        "node_types must be an array of strings.",
        "invalid_request",
        400,
      );
    }
    const validatedNodes: GraphNodeType[] = [];
    for (const item of rawNodeTypes) {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new ImpactRequestValidationError(
          "Each node_type must be a non-empty string.",
          "invalid_request",
          400,
        );
      }
      const trimmed = item.trim();
      if (!(GraphNodeTypes as readonly string[]).includes(trimmed)) {
        throw new ImpactRequestValidationError(
          `Unknown node type: "${trimmed}". Valid types: ${GraphNodeTypes.join(", ")}`,
          "invalid_request",
          400,
        );
      }
      validatedNodes.push(trimmed as GraphNodeType);
    }
    nodeTypes = validatedNodes;
  }

  let decayFactor: number | undefined;
  const rawDecayFactor = body["decay_factor"];
  if (rawDecayFactor !== undefined) {
    if (
      typeof rawDecayFactor !== "number" ||
      !Number.isFinite(rawDecayFactor) ||
      rawDecayFactor <= 0 ||
      rawDecayFactor > 1
    ) {
      throw new ImpactRequestValidationError(
        `decay_factor must be a number between 0 and 1. Received: ${String(rawDecayFactor)}`,
        "invalid_traversal_options",
        400,
      );
    }
    decayFactor = rawDecayFactor;
  }

  let includeEvidence: boolean | undefined;
  const rawIncludeEvidence = body["include_evidence"];
  if (rawIncludeEvidence !== undefined) {
    if (typeof rawIncludeEvidence !== "boolean") {
      throw new ImpactRequestValidationError(
        "include_evidence must be a boolean.",
        "invalid_request",
        400,
      );
    }
    includeEvidence = rawIncludeEvidence;
  }

  return {
    ...(analysisRunId ? { analysisRunId } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(internalDirection ? { internalDirection } : {}),
    ...(publicDirection ? { publicDirection } : {}),
    ...(edgeTypes ? { edgeTypes } : {}),
    ...(nodeTypes ? { nodeTypes } : {}),
    ...(decayFactor !== undefined ? { decayFactor } : {}),
    ...(includeEvidence !== undefined ? { includeEvidence } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
