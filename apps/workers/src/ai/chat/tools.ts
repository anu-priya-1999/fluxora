/**
 * @file tools.ts
 * Controlled, provider-independent tool definitions and deterministic executors
 * for Phase 9 Step 64 (Tool-Calling Free-Form Architecture Chat).
 *
 * Exposes ONLY three tools:
 * - query_graph(start_node, direction, max_depth, edge_types)
 * - get_evidence(evidence_id)
 * - run_simulation(target_node, failure_type)
 *
 * Security invariants:
 * - Strict schema validation; unknown tools and malformed arguments are rejected.
 * - Tenant (organizationId), repositoryId, and analysisRunId come ONLY from trusted server context.
 * - Never executes model-generated SQL or arbitrary file/shell access.
 * - Enforces HARD_MAX_TRAVERSAL_DEPTH, per-request/per-session simulation limits, and idempotency.
 */

import {
  createScenario,
  createSimulation,
  executeSimulation,
  getEvidenceById,
  getGraphNodeByCanonicalId,
  getGraphNodeById,
  listSimulationEvidence,
  traverseGraph,
} from "@fluxora/db";
import {
  GraphEdgeTypes,
  HARD_MAX_TRAVERSAL_DEPTH,
  type ChatToolName,
  type EvidenceRecord,
  type GraphEdgeType,
  type GraphNode,
  type GraphTraversalResult,
  type TraversalDirection,
} from "@fluxora/shared-types";

import type { ToolDefinition } from "../types.ts";

export type DbPool = Parameters<typeof traverseGraph>[0];
import {
  CHAT_EXECUTION_LIMITS,
  type ExecutedToolResult,
  type ToolExecutionContext,
} from "./types.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set<ChatToolName>([
  "query_graph",
  "get_evidence",
  "run_simulation",
]);

const VALID_EDGE_TYPE_SET: ReadonlySet<string> = new Set(GraphEdgeTypes);

/**
 * Provider-independent tool definitions exposed to the Model Gateway.
 */
export const CHAT_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "query_graph",
    description:
      "Query the deterministic dependency graph starting from a node ID or canonical node ID within the authorized analysis run. Returns nodes, edges, traversal paths, confidence scores, and evidence IDs.",
    inputSchema: {
      type: "object",
      properties: {
        start_node: {
          type: "string",
          description: "Graph node UUID or canonical node ID to start traversal from.",
        },
        direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both", "downstream", "upstream"],
          description: "Traversal direction from start_node (default: outgoing).",
        },
        max_depth: {
          type: "integer",
          minimum: 0,
          maximum: HARD_MAX_TRAVERSAL_DEPTH,
          description: `Maximum traversal depth (0 to ${HARD_MAX_TRAVERSAL_DEPTH}, default: 3).`,
        },
        edge_types: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of edge types to filter traversal (e.g. CALLS, IMPORTS, EMITS_EVENT).",
        },
      },
      required: ["start_node"],
      additionalProperties: false,
    },
  },
  {
    name: "get_evidence",
    description:
      "Fetch a specific verified evidence record by its evidence_id within the authorized organization and analysis run. Returns source file location, line numbers, relationship description, and confidence.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_id: {
          type: "string",
          description: "UUID of the evidence record to retrieve.",
        },
      },
      required: ["evidence_id"],
      additionalProperties: false,
    },
  },
  {
    name: "run_simulation",
    description:
      "Run a bounded, deterministic failure simulation on a target node in the authorized repository and analysis run. Creates a synthetic scenario and returns impacted node states, rules applied, assumptions, and simulation_state evidence IDs.",
    inputSchema: {
      type: "object",
      properties: {
        target_node: {
          type: "string",
          description: "Graph node UUID or canonical node ID to inject the failure into.",
        },
        failure_type: {
          type: "string",
          enum: ["unavailable", "latency"],
          description: "Supported deterministic failure type: 'unavailable' or 'latency'.",
        },
      },
      required: ["target_node", "failure_type"],
      additionalProperties: false,
    },
  },
]);

export interface ChatToolDependencies {
  readonly pool: DbPool;
  readonly traverseGraph?: typeof traverseGraph | undefined;
  readonly getGraphNodeById?: typeof getGraphNodeById | undefined;
  readonly getGraphNodeByCanonicalId?: typeof getGraphNodeByCanonicalId | undefined;
  readonly getEvidenceById?: typeof getEvidenceById | undefined;
  readonly createScenario?: typeof createScenario | undefined;
  readonly createSimulation?: typeof createSimulation | undefined;
  readonly executeSimulation?: typeof executeSimulation | undefined;
  readonly listSimulationEvidence?: typeof listSimulationEvidence | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectKeysOutside(
  input: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return `Unrecognized argument '${key}'.`;
    }
  }
  return null;
}

function serializeBoundedToolPayload(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= CHAT_EXECUTION_LIMITS.MAX_TOOL_RESULT_CHARS) {
    return raw;
  }
  return JSON.stringify({
    truncated: true,
    notice: `Tool output exceeded ${CHAT_EXECUTION_LIMITS.MAX_TOOL_RESULT_CHARS} chars and was truncated.`,
    excerpt: raw.slice(0, CHAT_EXECUTION_LIMITS.MAX_TOOL_RESULT_CHARS - 200),
  });
}

function toolErrorResult(
  toolName: string,
  code: string,
  message: string,
  ctx: ToolExecutionContext,
): ExecutedToolResult {
  if (ALLOWED_TOOL_NAMES.has(toolName)) {
    ctx.toolActivity.push({
      tool_name: toolName as ChatToolName,
      status: "failed",
      summary: `${code}: ${message}`,
    });
  }
  return {
    toolName,
    content: JSON.stringify({ error: { code, message } }),
    isError: true,
    addedEvidenceIds: [],
  };
}

async function resolveNodeInRun(
  nodeIdentifier: string,
  ctx: ToolExecutionContext,
  deps: ChatToolDependencies,
): Promise<GraphNode | null> {
  const byId = deps.getGraphNodeById ?? getGraphNodeById;
  const byCanonical = deps.getGraphNodeByCanonicalId ?? getGraphNodeByCanonicalId;
  const { organizationId, analysisRunId } = ctx.trusted;

  if (UUID_REGEX.test(nodeIdentifier)) {
    const node = await byId(deps.pool, organizationId, nodeIdentifier);
    if (node && node.analysisRunId === analysisRunId) {
      return node;
    }
    return null;
  }

  return byCanonical(deps.pool, organizationId, analysisRunId, nodeIdentifier);
}

function normalizeDirection(raw: unknown): TraversalDirection | null {
  if (raw === undefined) {
    return "outgoing";
  }
  if (raw === "outgoing" || raw === "downstream") {
    return "outgoing";
  }
  if (raw === "incoming" || raw === "upstream") {
    return "incoming";
  }
  if (raw === "both") {
    return "both";
  }
  return null;
}

async function executeQueryGraph(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
  deps: ChatToolDependencies,
): Promise<ExecutedToolResult> {
  const extraKeyError = rejectKeysOutside(input, [
    "start_node",
    "direction",
    "max_depth",
    "edge_types",
  ]);
  if (extraKeyError) {
    return toolErrorResult("query_graph", "invalid_arguments", extraKeyError, ctx);
  }

  const startNodeRaw = input["start_node"];
  if (typeof startNodeRaw !== "string" || startNodeRaw.trim().length === 0 || startNodeRaw.length > 512) {
    return toolErrorResult(
      "query_graph",
      "invalid_arguments",
      "start_node must be a non-empty string.",
      ctx,
    );
  }

  const direction = normalizeDirection(input["direction"]);
  if (direction === null) {
    return toolErrorResult(
      "query_graph",
      "invalid_arguments",
      "direction must be one of: outgoing, incoming, both, downstream, upstream.",
      ctx,
    );
  }

  const rawMaxDepth = input["max_depth"];
  let maxDepth = 3;
  if (rawMaxDepth !== undefined) {
    if (
      typeof rawMaxDepth !== "number" ||
      !Number.isInteger(rawMaxDepth) ||
      rawMaxDepth < 0 ||
      rawMaxDepth > HARD_MAX_TRAVERSAL_DEPTH
    ) {
      return toolErrorResult(
        "query_graph",
        "invalid_arguments",
        `max_depth must be an integer between 0 and ${HARD_MAX_TRAVERSAL_DEPTH}.`,
        ctx,
      );
    }
    maxDepth = rawMaxDepth;
  }

  const rawEdgeTypes = input["edge_types"];
  let edgeTypes: GraphEdgeType[] | undefined;
  if (rawEdgeTypes !== undefined) {
    if (!Array.isArray(rawEdgeTypes) || rawEdgeTypes.length > 20) {
      return toolErrorResult(
        "query_graph",
        "invalid_arguments",
        "edge_types must be an array of at most 20 edge type strings.",
        ctx,
      );
    }
    const validated: GraphEdgeType[] = [];
    for (const et of rawEdgeTypes) {
      if (typeof et !== "string" || !VALID_EDGE_TYPE_SET.has(et.trim())) {
        return toolErrorResult(
          "query_graph",
          "invalid_arguments",
          `Unsupported edge_type '${String(et)}'.`,
          ctx,
        );
      }
      validated.push(et.trim() as GraphEdgeType);
    }
    if (validated.length > 0) {
      edgeTypes = validated;
    }
  }

  const resolvedNode = await resolveNodeInRun(startNodeRaw.trim(), ctx, deps);
  if (!resolvedNode) {
    return toolErrorResult(
      "query_graph",
      "node_not_found",
      "Start node was not found in the authorized analysis run.",
      ctx,
    );
  }

  const runTraverse = deps.traverseGraph ?? traverseGraph;
  const traversal: GraphTraversalResult = await runTraverse(deps.pool, {
    organizationId: ctx.trusted.organizationId,
    analysisRunId: ctx.trusted.analysisRunId,
    startNodeId: resolvedNode.id,
    maxDepth,
    direction,
    ...(edgeTypes ? { edgeTypes } : {}),
    includeEvidence: true,
  });

  const evidenceList = traversal.evidence ?? [];
  const addedEvidenceIds: string[] = [];
  for (const ev of evidenceList) {
    if (!ctx.allowedEvidenceIds.has(ev.id)) {
      ctx.allowedEvidenceIds.add(ev.id);
      addedEvidenceIds.push(ev.id);
    }
  }

  const evidenceBySubject = new Map<string, string[]>();
  for (const ev of evidenceList) {
    const existing = evidenceBySubject.get(ev.subjectId) ?? [];
    existing.push(ev.id);
    evidenceBySubject.set(ev.subjectId, existing);
  }

  const payload = {
    start_node: {
      id: resolvedNode.id,
      canonical_id: resolvedNode.canonicalId,
      name: resolvedNode.name,
      node_type: resolvedNode.nodeType,
    },
    direction,
    max_depth: maxDepth,
    max_depth_reached: traversal.maxDepthReached,
    nodes: traversal.nodes.map((item) => ({
      id: item.node.id,
      canonical_id: item.node.canonicalId,
      name: item.node.name,
      node_type: item.node.nodeType,
      depth: item.depth,
      path: item.path,
      confidence: item.node.confidence,
      evidence_ids: evidenceBySubject.get(item.node.id) ?? [],
    })),
    edges: traversal.edges.map((edge) => ({
      id: edge.id,
      source_node_id: edge.sourceNodeId,
      target_node_id: edge.targetNodeId,
      edge_type: edge.edgeType,
      confidence: edge.confidence,
      provenance: edge.provenance,
      evidence_ids: evidenceBySubject.get(edge.id) ?? [],
    })),
    evidence_ids: evidenceList.map((e) => e.id),
  };

  ctx.toolActivity.push({
    tool_name: "query_graph",
    status: "completed",
    summary: `Traversed ${traversal.nodes.length} nodes and ${traversal.edges.length} edges from ${resolvedNode.name}.`,
  });

  return {
    toolName: "query_graph",
    content: serializeBoundedToolPayload(payload),
    isError: false,
    addedEvidenceIds,
  };
}

async function executeGetEvidence(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
  deps: ChatToolDependencies,
): Promise<ExecutedToolResult> {
  const extraKeyError = rejectKeysOutside(input, ["evidence_id"]);
  if (extraKeyError) {
    return toolErrorResult("get_evidence", "invalid_arguments", extraKeyError, ctx);
  }

  const evidenceId = input["evidence_id"];
  if (typeof evidenceId !== "string" || !UUID_REGEX.test(evidenceId.trim())) {
    return toolErrorResult(
      "get_evidence",
      "invalid_arguments",
      "evidence_id must be a valid UUID.",
      ctx,
    );
  }

  const fetchEvidence = deps.getEvidenceById ?? getEvidenceById;
  const record: EvidenceRecord | null = await fetchEvidence(
    deps.pool,
    ctx.trusted.organizationId,
    evidenceId.trim(),
  );

  // Enforce strict analysis-run and tenant isolation
  if (!record || record.analysisRunId !== ctx.trusted.analysisRunId) {
    return toolErrorResult(
      "get_evidence",
      "evidence_not_found",
      "Evidence record was not found in the authorized analysis run.",
      ctx,
    );
  }

  const addedEvidenceIds: string[] = [];
  if (!ctx.allowedEvidenceIds.has(record.id)) {
    ctx.allowedEvidenceIds.add(record.id);
    addedEvidenceIds.push(record.id);
  }

  const payload = {
    evidence_id: record.id,
    analysis_run_id: record.analysisRunId,
    subject_type: record.subjectType,
    subject_id: record.subjectId,
    file_path: record.filePath,
    symbol_id: record.symbolId ?? null,
    line_start: record.lineStart ?? null,
    line_end: record.lineEnd ?? null,
    column_start: record.columnStart ?? null,
    column_end: record.columnEnd ?? null,
    relationship_description: record.relationshipDescription,
    confidence: record.confidence,
  };

  ctx.toolActivity.push({
    tool_name: "get_evidence",
    status: "completed",
    summary: `Retrieved evidence ${record.id} (${record.filePath}).`,
  });

  return {
    toolName: "get_evidence",
    content: serializeBoundedToolPayload(payload),
    isError: false,
    addedEvidenceIds,
  };
}

async function executeRunSimulation(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
  deps: ChatToolDependencies,
): Promise<ExecutedToolResult> {
  const extraKeyError = rejectKeysOutside(input, ["target_node", "failure_type"]);
  if (extraKeyError) {
    return toolErrorResult("run_simulation", "invalid_arguments", extraKeyError, ctx);
  }

  const targetNodeRaw = input["target_node"];
  if (typeof targetNodeRaw !== "string" || targetNodeRaw.trim().length === 0 || targetNodeRaw.length > 512) {
    return toolErrorResult(
      "run_simulation",
      "invalid_arguments",
      "target_node must be a non-empty string.",
      ctx,
    );
  }

  const failureType = input["failure_type"];
  if (failureType !== "unavailable" && failureType !== "latency") {
    return toolErrorResult(
      "run_simulation",
      "invalid_arguments",
      "failure_type must be 'unavailable' or 'latency'.",
      ctx,
    );
  }

  const resolvedNode = await resolveNodeInRun(targetNodeRaw.trim(), ctx, deps);
  if (!resolvedNode) {
    return toolErrorResult(
      "run_simulation",
      "node_not_found",
      "Target node was not found in the authorized analysis run.",
      ctx,
    );
  }

  const cacheKey = `${resolvedNode.id}:${failureType}`;
  const cached = ctx.simulationCache.get(cacheKey);
  if (cached) {
    ctx.toolActivity.push({
      tool_name: "run_simulation",
      status: "completed",
      summary: `Reused idempotent simulation for ${resolvedNode.name} (${failureType}).`,
    });
    return {
      toolName: "run_simulation",
      content: serializeBoundedToolPayload(cached),
      isError: false,
      addedEvidenceIds: [],
    };
  }

  if (ctx.simulationCountInRequest.count >= CHAT_EXECUTION_LIMITS.MAX_SIMULATIONS_PER_REQUEST) {
    return toolErrorResult(
      "run_simulation",
      "simulation_limit_exceeded",
      `Per-request simulation limit (${CHAT_EXECUTION_LIMITS.MAX_SIMULATIONS_PER_REQUEST}) exceeded.`,
      ctx,
    );
  }

  if (ctx.simulationCountInSession.count >= CHAT_EXECUTION_LIMITS.MAX_SIMULATIONS_PER_SESSION) {
    return toolErrorResult(
      "run_simulation",
      "session_simulation_limit_exceeded",
      `Per-session simulation limit (${CHAT_EXECUTION_LIMITS.MAX_SIMULATIONS_PER_SESSION}) exceeded.`,
      ctx,
    );
  }

  const createScen = deps.createScenario ?? createScenario;
  const createSim = deps.createSimulation ?? createSimulation;
  const execSim = deps.executeSimulation ?? executeSimulation;
  const listSimEvidence = deps.listSimulationEvidence ?? listSimulationEvidence;

  const scenario = await createScen(deps.pool, {
    organizationId: ctx.trusted.organizationId,
    repositoryId: ctx.trusted.repositoryId,
    name: `Chat synthetic ${failureType}: ${resolvedNode.name}`.slice(0, 120),
    targetNodeId: resolvedNode.id,
    failureType,
    parameters: {
      source: "chat_query",
      chatQueryId: ctx.trusted.chatQueryId,
      ...(ctx.trusted.sessionId ? { sessionId: ctx.trusted.sessionId } : {}),
    },
  });

  const simulation = await createSim(deps.pool, ctx.trusted.organizationId, {
    scenarioId: scenario.id,
    analysisRunId: ctx.trusted.analysisRunId,
  });

  const execResult = await execSim(deps.pool, ctx.trusted.organizationId, simulation.id, {
    enqueueNarrationJob: false,
  });

  ctx.simulationCountInRequest.count += 1;
  ctx.simulationCountInSession.count += 1;

  const simEvidence =
    execResult.evidence.length > 0
      ? execResult.evidence
      : await listSimEvidence(
          deps.pool,
          ctx.trusted.organizationId,
          simulation.id,
        );

  const addedEvidenceIds: string[] = [];
  for (const ev of simEvidence) {
    if (!ctx.allowedEvidenceIds.has(ev.id)) {
      ctx.allowedEvidenceIds.add(ev.id);
      addedEvidenceIds.push(ev.id);
    }
  }

  const evidenceByNode = new Map<string, string[]>();
  for (const ev of simEvidence) {
    const existing = evidenceByNode.get(ev.subjectId) ?? [];
    existing.push(ev.id);
    evidenceByNode.set(ev.subjectId, existing);
  }

  const payload: Record<string, unknown> = {
    simulation_id: execResult.simulation.id,
    scenario_id: scenario.id,
    synthetic: true,
    target_node: {
      id: resolvedNode.id,
      canonical_id: resolvedNode.canonicalId,
      name: resolvedNode.name,
    },
    failure_type: failureType,
    converged: execResult.engineResult.converged,
    iterations: execResult.engineResult.iterations,
    results: execResult.savedResults.map((r) => ({
      node_id: r.nodeId,
      resulting_state: r.resultingState,
      rule_applied: r.ruleApplied,
      hop_distance: r.propagationPath.length,
      assumptions: r.assumptions,
      confidence: r.confidence,
      evidence_ids: evidenceByNode.get(r.nodeId) ?? [],
    })),
    evidence_ids: simEvidence.map((e) => e.id),
  };

  ctx.simulationCache.set(cacheKey, payload);

  ctx.toolActivity.push({
    tool_name: "run_simulation",
    status: "completed",
    summary: `Simulated ${failureType} on ${resolvedNode.name} (${execResult.savedResults.length} node states).`,
  });

  return {
    toolName: "run_simulation",
    content: serializeBoundedToolPayload(payload),
    isError: false,
    addedEvidenceIds,
  };
}

/**
 * Dispatches a single model tool call to one of the three controlled tools.
 * Rejects unknown tools and malformed arguments safely.
 */
export async function executeControlledChatTool(
  toolName: string,
  rawInput: unknown,
  ctx: ToolExecutionContext,
  deps: ChatToolDependencies,
): Promise<ExecutedToolResult> {
  if (!ALLOWED_TOOL_NAMES.has(toolName)) {
    return toolErrorResult(
      toolName,
      "unknown_tool",
      `Tool '${toolName}' is not registered. Only query_graph, get_evidence, and run_simulation are permitted.`,
      ctx,
    );
  }

  if (!isPlainObject(rawInput)) {
    return toolErrorResult(
      toolName,
      "invalid_arguments",
      "Tool input must be a JSON object.",
      ctx,
    );
  }

  try {
    switch (toolName as ChatToolName) {
      case "query_graph":
        return await executeQueryGraph(rawInput, ctx, deps);
      case "get_evidence":
        return await executeGetEvidence(rawInput, ctx, deps);
      case "run_simulation":
        return await executeRunSimulation(rawInput, ctx, deps);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Tool execution failed.";
    return toolErrorResult(toolName, "tool_execution_error", message, ctx);
  }
}
