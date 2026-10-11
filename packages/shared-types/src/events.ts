/**
 * Typed events and outbox envelope contracts (`08-event-schema.md`).
 */

export const REPOSITORY_INDEXED_EVENT_TYPE = "repository.indexed" as const;
export const GRAPH_UPDATED_EVENT_TYPE = "graph.updated" as const;

export type EventType =
  | typeof REPOSITORY_INDEXED_EVENT_TYPE
  | typeof GRAPH_UPDATED_EVENT_TYPE
  | (string & {});

/**
 * Payload for `repository.indexed` (`08-event-schema.md` §8.2).
 * Supports both camelCase and snake_case properties for compatibility
 * across TypeScript domain models and serialized JSON envelopes.
 */
export type RepositoryIndexedPayload = {
  repositoryId: string;
  repository_id: string;
  snapshotId: string;
  snapshot_id: string;
  commitSha: string;
  commit_sha: string;
  ref?: string;
};

/** Stable idempotency key for one repository commit indexing event. */
export function repositoryIndexedIdempotencyKey(
  repositoryId: string,
  commitSha: string,
): string {
  return `${REPOSITORY_INDEXED_EVENT_TYPE}:${repositoryId}:${commitSha}`;
}

/** Stable idempotency key for graph updated event. */
export function graphUpdatedIdempotencyKey(
  analysisRunId: string,
  previousAnalysisRunId?: string | null,
): string {
  const prev = previousAnalysisRunId ? `:${previousAnalysisRunId}` : "";
  return `${GRAPH_UPDATED_EVENT_TYPE}:${analysisRunId}${prev}`;
}

/**
 * Change classification for graph nodes and edges.
 */
export type GraphChangeType = "added" | "removed" | "changed";

export interface GraphNodeDiffItem {
  readonly canonicalId: string;
  readonly nodeType: string;
  readonly name: string;
  readonly path?: string | null;
  readonly changeType: GraphChangeType;
  readonly changedFields?: readonly string[];
}

export interface GraphEdgeDiffItem {
  readonly canonicalId?: string | null;
  readonly sourceCanonicalId: string;
  readonly targetCanonicalId: string;
  readonly edgeType: string;
  readonly changeType: GraphChangeType;
  readonly changedFields?: readonly string[];
}

export interface GraphDiffSummary {
  readonly nodesAdded: number;
  readonly nodesRemoved: number;
  readonly nodesChanged: number;
  readonly nodesUnchanged: number;
  readonly edgesAdded: number;
  readonly edgesRemoved: number;
  readonly edgesChanged: number;
  readonly edgesUnchanged: number;
  readonly totalNodesBefore: number;
  readonly totalNodesAfter: number;
  readonly totalEdgesBefore: number;
  readonly totalEdgesAfter: number;

  readonly nodes_added: number;
  readonly nodes_removed: number;
  readonly nodes_changed: number;
  readonly nodes_unchanged: number;
  readonly edges_added: number;
  readonly edges_removed: number;
  readonly edges_changed: number;
  readonly edges_unchanged: number;
  readonly node_delta: number;
  readonly edge_delta: number;
  readonly total_nodes_before: number;
  readonly total_nodes_after: number;
  readonly total_edges_before: number;
  readonly total_edges_after: number;
}

export interface GraphDiff {
  readonly summary: GraphDiffSummary;
  readonly addedNodes: readonly GraphNodeDiffItem[];
  readonly removedNodes: readonly GraphNodeDiffItem[];
  readonly changedNodes: readonly GraphNodeDiffItem[];
  readonly addedEdges: readonly GraphEdgeDiffItem[];
  readonly removedEdges: readonly GraphEdgeDiffItem[];
  readonly changedEdges: readonly GraphEdgeDiffItem[];
}

export type GraphUpdatedPayload = {
  readonly organizationId: string;
  readonly organization_id: string;
  readonly analysisRunId: string;
  readonly analysis_run_id: string;
  readonly repositoryId?: string;
  readonly repository_id?: string;
  readonly previousAnalysisRunId?: string | null;
  readonly previous_analysis_run_id?: string | null;
  readonly commitSha?: string;
  readonly commit_sha?: string;
  readonly summary: GraphDiffSummary;
  readonly diff: GraphDiff;
  readonly [key: string]: unknown;
};

/**
 * Durable event entity model (PostgreSQL `events` table).
 */
export interface FluxoraEvent<T = Record<string, unknown>> {
  id: string;
  organizationId: string;
  type: string;
  idempotencyKey: string;
  payload: T;
  schemaVersion: number;
  occurredAt: Date;
  createdAt: Date;
}

/**
 * Full serialized JSON envelope transported via PostgreSQL NOTIFY and WebSocket
 * (`08-event-schema.md` §8.3).
 */
export interface FluxoraEventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  organization_id: string;
  occurred_at: string;
  idempotency_key: string;
  payload: T;
  schema_version: number;
}

export interface CreateEventInput<T = Record<string, unknown>> {
  organizationId: string;
  type: string;
  idempotencyKey: string;
  payload: T;
  schemaVersion?: number;
  occurredAt?: Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function parseRepositoryIndexedPayload(
  raw: unknown,
): RepositoryIndexedPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const repositoryId =
    typeof record["repositoryId"] === "string"
      ? record["repositoryId"]
      : typeof record["repository_id"] === "string"
        ? record["repository_id"]
        : null;

  const snapshotId =
    typeof record["snapshotId"] === "string"
      ? record["snapshotId"]
      : typeof record["snapshot_id"] === "string"
        ? record["snapshot_id"]
        : null;

  const commitSha =
    typeof record["commitSha"] === "string"
      ? record["commitSha"]
      : typeof record["commit_sha"] === "string"
        ? record["commit_sha"]
        : null;

  if (
    repositoryId === null ||
    !UUID_PATTERN.test(repositoryId) ||
    snapshotId === null ||
    !UUID_PATTERN.test(snapshotId) ||
    commitSha === null ||
    !COMMIT_SHA_PATTERN.test(commitSha)
  ) {
    return null;
  }

  const ref = typeof record["ref"] === "string" ? record["ref"] : undefined;

  return {
    repositoryId,
    repository_id: repositoryId,
    snapshotId,
    snapshot_id: snapshotId,
    commitSha,
    commit_sha: commitSha,
    ...(ref !== undefined ? { ref } : {}),
  };
}

export function parseFluxoraEventEnvelope<T = Record<string, unknown>>(
  raw: unknown,
): FluxoraEventEnvelope<T> | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const eventId = record["event_id"];
  const eventType = record["event_type"];
  const organizationId = record["organization_id"];
  const occurredAt = record["occurred_at"];
  const idempotencyKey = record["idempotency_key"];
  const payload = record["payload"];
  const schemaVersion = record["schema_version"];

  if (
    typeof eventId !== "string" ||
    !UUID_PATTERN.test(eventId) ||
    typeof eventType !== "string" ||
    eventType.trim().length === 0 ||
    typeof organizationId !== "string" ||
    !UUID_PATTERN.test(organizationId) ||
    typeof occurredAt !== "string" ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0 ||
    typeof payload !== "object" ||
    payload === null ||
    typeof schemaVersion !== "number" ||
    schemaVersion < 1
  ) {
    return null;
  }

  return {
    event_id: eventId,
    event_type: eventType,
    organization_id: organizationId,
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
    payload: payload as T,
    schema_version: schemaVersion,
  };
}

export function parseGraphUpdatedPayload(
  raw: unknown,
): GraphUpdatedPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const orgId =
    typeof record["organizationId"] === "string"
      ? record["organizationId"]
      : typeof record["organization_id"] === "string"
        ? record["organization_id"]
        : null;

  const analysisRunId =
    typeof record["analysisRunId"] === "string"
      ? record["analysisRunId"]
      : typeof record["analysis_run_id"] === "string"
        ? record["analysis_run_id"]
        : null;

  if (
    orgId === null ||
    !UUID_PATTERN.test(orgId) ||
    analysisRunId === null ||
    !UUID_PATTERN.test(analysisRunId)
  ) {
    return null;
  }

  const rawSummary = record["summary"];
  const rawDiff = record["diff"];
  if (
    typeof rawSummary !== "object" ||
    rawSummary === null ||
    typeof rawDiff !== "object" ||
    rawDiff === null
  ) {
    return null;
  }

  const s = rawSummary as Record<string, unknown>;
  const nodesAdded = Number(s["nodesAdded"] ?? s["nodes_added"] ?? 0);
  const nodesRemoved = Number(s["nodesRemoved"] ?? s["nodes_removed"] ?? 0);
  const nodesChanged = Number(s["nodesChanged"] ?? s["nodes_changed"] ?? 0);
  const nodesUnchanged = Number(s["nodesUnchanged"] ?? s["nodes_unchanged"] ?? 0);
  const edgesAdded = Number(s["edgesAdded"] ?? s["edges_added"] ?? 0);
  const edgesRemoved = Number(s["edgesRemoved"] ?? s["edges_removed"] ?? 0);
  const edgesChanged = Number(s["edgesChanged"] ?? s["edges_changed"] ?? 0);
  const edgesUnchanged = Number(s["edgesUnchanged"] ?? s["edges_unchanged"] ?? 0);
  const totalNodesBefore = Number(s["totalNodesBefore"] ?? s["total_nodes_before"] ?? 0);
  const totalNodesAfter = Number(s["totalNodesAfter"] ?? s["total_nodes_after"] ?? 0);
  const totalEdgesBefore = Number(s["totalEdgesBefore"] ?? s["total_edges_before"] ?? 0);
  const totalEdgesAfter = Number(s["totalEdgesAfter"] ?? s["total_edges_after"] ?? 0);
  const nodeDelta = Number(s["node_delta"] ?? (totalNodesAfter - totalNodesBefore));
  const edgeDelta = Number(s["edge_delta"] ?? (totalEdgesAfter - totalEdgesBefore));

  const summary: GraphDiffSummary = {
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    nodesUnchanged,
    edgesAdded,
    edgesRemoved,
    edgesChanged,
    edgesUnchanged,
    totalNodesBefore,
    totalNodesAfter,
    totalEdgesBefore,
    totalEdgesAfter,
    nodes_added: nodesAdded,
    nodes_removed: nodesRemoved,
    nodes_changed: nodesChanged,
    nodes_unchanged: nodesUnchanged,
    edges_added: edgesAdded,
    edges_removed: edgesRemoved,
    edges_changed: edgesChanged,
    edges_unchanged: edgesUnchanged,
    node_delta: nodeDelta,
    edge_delta: edgeDelta,
    total_nodes_before: totalNodesBefore,
    total_nodes_after: totalNodesAfter,
    total_edges_before: totalEdgesBefore,
    total_edges_after: totalEdgesAfter,
  };

  const d = rawDiff as Record<string, unknown>;
  const addedNodes = Array.isArray(d["addedNodes"]) ? (d["addedNodes"] as GraphNodeDiffItem[]) : [];
  const removedNodes = Array.isArray(d["removedNodes"]) ? (d["removedNodes"] as GraphNodeDiffItem[]) : [];
  const changedNodes = Array.isArray(d["changedNodes"]) ? (d["changedNodes"] as GraphNodeDiffItem[]) : [];
  const addedEdges = Array.isArray(d["addedEdges"]) ? (d["addedEdges"] as GraphEdgeDiffItem[]) : [];
  const removedEdges = Array.isArray(d["removedEdges"]) ? (d["removedEdges"] as GraphEdgeDiffItem[]) : [];
  const changedEdges = Array.isArray(d["changedEdges"]) ? (d["changedEdges"] as GraphEdgeDiffItem[]) : [];

  const diff: GraphDiff = {
    summary,
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
  };

  const repositoryId =
    typeof record["repositoryId"] === "string"
      ? record["repositoryId"]
      : typeof record["repository_id"] === "string"
        ? record["repository_id"]
        : undefined;

  const previousAnalysisRunId =
    typeof record["previousAnalysisRunId"] === "string"
      ? record["previousAnalysisRunId"]
      : typeof record["previous_analysis_run_id"] === "string"
        ? record["previous_analysis_run_id"]
        : record["previousAnalysisRunId"] === null || record["previous_analysis_run_id"] === null
          ? null
          : undefined;

  const commitSha =
    typeof record["commitSha"] === "string"
      ? record["commitSha"]
      : typeof record["commit_sha"] === "string"
        ? record["commit_sha"]
        : undefined;

  return {
    organizationId: orgId,
    organization_id: orgId,
    analysisRunId,
    analysis_run_id: analysisRunId,
    ...(repositoryId !== undefined
      ? { repositoryId, repository_id: repositoryId }
      : {}),
    ...(previousAnalysisRunId !== undefined
      ? {
          previousAnalysisRunId,
          previous_analysis_run_id: previousAnalysisRunId,
        }
      : {}),
    ...(commitSha !== undefined ? { commitSha, commit_sha: commitSha } : {}),
    summary,
    diff,
  };
}
