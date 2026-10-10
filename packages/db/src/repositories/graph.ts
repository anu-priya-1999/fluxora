import type {
  AnalysisRun,
  AnalysisRunStatus,
  CreateAnalysisRunInput,
  CreateEvidenceInput,
  CreateGraphEdgeInput,
  CreateGraphNodeInput,
  EvidenceRecord,
  EvidenceSubjectType,
  GraphEdge,
  GraphEdgeProvenance,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AnalysisRunValidationError extends Error {
  constructor(message = "Analysis run fields are invalid.") {
    super(message);
    this.name = "AnalysisRunValidationError";
  }
}

export class GraphNodeValidationError extends Error {
  constructor(message = "Graph node fields are invalid.") {
    super(message);
    this.name = "GraphNodeValidationError";
  }
}

export class GraphEdgeValidationError extends Error {
  constructor(message = "Graph edge fields are invalid.") {
    super(message);
    this.name = "GraphEdgeValidationError";
  }
}

export class EvidenceValidationError extends Error {
  constructor(message = "Evidence fields are invalid.") {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

export class GraphStorageConflictError extends Error {
  constructor(message = "Graph storage conflict occurred.") {
    super(message);
    this.name = "GraphStorageConflictError";
  }
}


interface AnalysisRunRow {
  id: string;
  snapshot_id: string;
  status: string;
  parser_versions: Record<string, string>;
  started_at: Date;
  completed_at: Date | null;
  coverage_summary: Record<string, unknown>;
  created_at: Date;
}

interface GraphNodeRow {
  id: string;
  analysis_run_id: string;
  canonical_id: string;
  node_type: string;
  name: string;
  path: string | null;
  metadata: Record<string, unknown>;
  confidence: number;
  created_at: Date;
}

interface GraphEdgeRow {
  id: string;
  analysis_run_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  canonical_id: string | null;
  metadata: Record<string, unknown>;
  confidence: number;
  provenance: string;
  created_at: Date;
}

interface EvidenceRow {
  id: string;
  analysis_run_id: string;
  subject_type: string;
  subject_id: string;
  file_path: string;
  symbol_id: string | null;
  line_start: number | null;
  line_end: number | null;
  column_start: number | null;
  column_end: number | null;
  relationship_description: string;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Analysis Run DB Methods
// ---------------------------------------------------------------------------

export async function createAnalysisRun(
  pool: pg.Pool,
  input: CreateAnalysisRunInput,
): Promise<AnalysisRun> {
  assertAnalysisRunInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    const status = input.status ?? "pending";
    const parserVersions = input.parserVersions ?? {};
    const coverageSummary = input.coverageSummary ?? {};
    const startedAt = input.startedAt ?? new Date();

    const query = input.id === undefined
      ? `INSERT INTO analysis_runs (snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary)
         VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6::jsonb)
         RETURNING id, snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary, created_at`
      : `INSERT INTO analysis_runs (id, snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7::jsonb)
         RETURNING id, snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary, created_at`;

    const params = input.id === undefined
      ? [
          input.snapshotId,
          status,
          JSON.stringify(parserVersions),
          startedAt,
          input.completedAt ?? null,
          JSON.stringify(coverageSummary),
        ]
      : [
          input.id,
          input.snapshotId,
          status,
          JSON.stringify(parserVersions),
          startedAt,
          input.completedAt ?? null,
          JSON.stringify(coverageSummary),
        ];

    try {
      const result = await client.query<AnalysisRunRow>(query, params);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("analysis run insert returned no row");
      }
      return mapAnalysisRunRow(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GraphStorageConflictError("Analysis run with this ID already exists.");
      }
      throw error;
    }
  });
}

export async function getAnalysisRunById(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<AnalysisRun | null> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<AnalysisRunRow>(
      `SELECT id, snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary, created_at
       FROM analysis_runs
       WHERE id = $1::uuid`,
      [analysisRunId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAnalysisRunRow(row);
  });
}

export async function listAnalysisRuns(
  pool: pg.Pool,
  organizationId: string,
  snapshotId: string,
): Promise<AnalysisRun[]> {
  if (!UUID_REGEX.test(snapshotId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<AnalysisRunRow>(
      `SELECT id, snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary, created_at
       FROM analysis_runs
       WHERE snapshot_id = $1::uuid
       ORDER BY created_at DESC, id DESC`,
      [snapshotId],
    );
    return result.rows.map(mapAnalysisRunRow);
  });
}

export async function updateAnalysisRunStatus(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
  status: AnalysisRunStatus,
  completedAt?: Date | null,
  coverageSummary?: Record<string, unknown>,
): Promise<AnalysisRun | null> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<AnalysisRunRow>(
      `UPDATE analysis_runs
       SET status = $2,
           completed_at = COALESCE($3, completed_at),
           coverage_summary = COALESCE($4::jsonb, coverage_summary)
       WHERE id = $1::uuid
       RETURNING id, snapshot_id, status, parser_versions, started_at, completed_at, coverage_summary, created_at`,
      [
        analysisRunId,
        status,
        completedAt ?? null,
        coverageSummary ? JSON.stringify(coverageSummary) : null,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAnalysisRunRow(row);
  });
}

// ---------------------------------------------------------------------------
// GraphNode DB Methods
// ---------------------------------------------------------------------------

export async function createGraphNode(
  pool: pg.Pool,
  input: CreateGraphNodeInput,
): Promise<GraphNode> {
  assertGraphNodeInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    const metadata = input.metadata ?? {};
    const confidence = input.confidence ?? 1.0;

    const query = input.id === undefined
      ? `INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at`
      : `INSERT INTO graph_nodes (id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at`;

    const params = input.id === undefined
      ? [
          input.analysisRunId,
          input.canonicalId.trim(),
          input.nodeType.trim(),
          input.name.trim(),
          input.path ? input.path.trim() : null,
          JSON.stringify(metadata),
          confidence,
        ]
      : [
          input.id,
          input.analysisRunId,
          input.canonicalId.trim(),
          input.nodeType.trim(),
          input.name.trim(),
          input.path ? input.path.trim() : null,
          JSON.stringify(metadata),
          confidence,
        ];

    try {
      const result = await client.query<GraphNodeRow>(query, params);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("graph node insert returned no row");
      }
      return mapGraphNodeRow(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GraphStorageConflictError("Graph node canonical_id conflict within analysis run.");
      }
      throw error;
    }
  });
}

export async function batchCreateGraphNodes(
  pool: pg.Pool,
  organizationId: string,
  nodes: readonly CreateGraphNodeInput[],
): Promise<GraphNode[]> {
  if (nodes.length === 0) {
    return [];
  }

  for (const n of nodes) {
    assertGraphNodeInput(n);
  }

  return withTenant(pool, organizationId, async (client) => {
    const created: GraphNode[] = [];
    for (const input of nodes) {
      const metadata = input.metadata ?? {};
      const confidence = input.confidence ?? 1.0;

      const query = input.id === undefined
        ? `INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
           VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (analysis_run_id, canonical_id) DO UPDATE
             SET name = EXCLUDED.name, metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence
           RETURNING id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at`
        : `INSERT INTO graph_nodes (id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
           ON CONFLICT (analysis_run_id, canonical_id) DO UPDATE
             SET name = EXCLUDED.name, metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence
           RETURNING id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at`;

      const params = input.id === undefined
        ? [
            input.analysisRunId,
            input.canonicalId.trim(),
            input.nodeType.trim(),
            input.name.trim(),
            input.path ? input.path.trim() : null,
            JSON.stringify(metadata),
            confidence,
          ]
        : [
            input.id,
            input.analysisRunId,
            input.canonicalId.trim(),
            input.nodeType.trim(),
            input.name.trim(),
            input.path ? input.path.trim() : null,
            JSON.stringify(metadata),
            confidence,
          ];

      const res = await client.query<GraphNodeRow>(query, params);
      if (res.rows[0]) {
        created.push(mapGraphNodeRow(res.rows[0]));
      }
    }
    return created;
  });
}

export async function getGraphNodeById(
  pool: pg.Pool,
  organizationId: string,
  nodeId: string,
): Promise<GraphNode | null> {
  if (!UUID_REGEX.test(nodeId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<GraphNodeRow>(
      `SELECT id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at
       FROM graph_nodes
       WHERE id = $1::uuid`,
      [nodeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapGraphNodeRow(row);
  });
}

export async function getGraphNodeByCanonicalId(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
  canonicalId: string,
): Promise<GraphNode | null> {
  if (!UUID_REGEX.test(analysisRunId) || canonicalId.trim().length === 0) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<GraphNodeRow>(
      `SELECT id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at
       FROM graph_nodes
       WHERE analysis_run_id = $1::uuid
         AND canonical_id = $2`,
      [analysisRunId, canonicalId.trim()],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapGraphNodeRow(row);
  });
}

export async function listGraphNodes(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<GraphNode[]> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<GraphNodeRow>(
      `SELECT id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at
       FROM graph_nodes
       WHERE analysis_run_id = $1::uuid
       ORDER BY created_at ASC, id ASC`,
      [analysisRunId],
    );
    return result.rows.map(mapGraphNodeRow);
  });
}

// ---------------------------------------------------------------------------
// GraphEdge DB Methods
// ---------------------------------------------------------------------------

export async function createGraphEdge(
  pool: pg.Pool,
  input: CreateGraphEdgeInput,
): Promise<GraphEdge> {
  assertGraphEdgeInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    const metadata = input.metadata ?? {};
    const confidence = input.confidence ?? 1.0;
    const provenance = input.provenance ?? "static-analysis";

    const query = input.id === undefined
      ? `INSERT INTO graph_edges (analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8)
         RETURNING id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at`
      : `INSERT INTO graph_edges (id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9)
         RETURNING id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at`;

    const params = input.id === undefined
      ? [
          input.analysisRunId,
          input.sourceNodeId,
          input.targetNodeId,
          input.edgeType.trim(),
          input.canonicalId ? input.canonicalId.trim() : null,
          JSON.stringify(metadata),
          confidence,
          provenance,
        ]
      : [
          input.id,
          input.analysisRunId,
          input.sourceNodeId,
          input.targetNodeId,
          input.edgeType.trim(),
          input.canonicalId ? input.canonicalId.trim() : null,
          JSON.stringify(metadata),
          confidence,
          provenance,
        ];

    try {
      const result = await client.query<GraphEdgeRow>(query, params);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("graph edge insert returned no row");
      }
      return mapGraphEdgeRow(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GraphStorageConflictError("Graph edge already exists between source and target for this edge_type.");
      }
      throw error;
    }
  });
}

export async function batchCreateGraphEdges(
  pool: pg.Pool,
  organizationId: string,
  edges: readonly CreateGraphEdgeInput[],
): Promise<GraphEdge[]> {
  if (edges.length === 0) {
    return [];
  }

  for (const e of edges) {
    assertGraphEdgeInput(e);
  }

  return withTenant(pool, organizationId, async (client) => {
    const created: GraphEdge[] = [];
    for (const input of edges) {
      const metadata = input.metadata ?? {};
      const confidence = input.confidence ?? 1.0;
      const provenance = input.provenance ?? "static-analysis";

      const query = input.id === undefined
        ? `INSERT INTO graph_edges (analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (analysis_run_id, source_node_id, target_node_id, edge_type) DO UPDATE
             SET metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence, provenance = EXCLUDED.provenance
           RETURNING id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at`
        : `INSERT INTO graph_edges (id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9)
           ON CONFLICT (analysis_run_id, source_node_id, target_node_id, edge_type) DO UPDATE
             SET metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence, provenance = EXCLUDED.provenance
           RETURNING id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at`;

      const params = input.id === undefined
        ? [
            input.analysisRunId,
            input.sourceNodeId,
            input.targetNodeId,
            input.edgeType.trim(),
            input.canonicalId ? input.canonicalId.trim() : null,
            JSON.stringify(metadata),
            confidence,
            provenance,
          ]
        : [
            input.id,
            input.analysisRunId,
            input.sourceNodeId,
            input.targetNodeId,
            input.edgeType.trim(),
            input.canonicalId ? input.canonicalId.trim() : null,
            JSON.stringify(metadata),
            confidence,
            provenance,
          ];

      const res = await client.query<GraphEdgeRow>(query, params);
      if (res.rows[0]) {
        created.push(mapGraphEdgeRow(res.rows[0]));
      }
    }
    return created;
  });
}

export async function getGraphEdgeById(
  pool: pg.Pool,
  organizationId: string,
  edgeId: string,
): Promise<GraphEdge | null> {
  if (!UUID_REGEX.test(edgeId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<GraphEdgeRow>(
      `SELECT id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at
       FROM graph_edges
       WHERE id = $1::uuid`,
      [edgeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapGraphEdgeRow(row);
  });
}

export async function listGraphEdges(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<GraphEdge[]> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<GraphEdgeRow>(
      `SELECT id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at
       FROM graph_edges
       WHERE analysis_run_id = $1::uuid
       ORDER BY created_at ASC, id ASC`,
      [analysisRunId],
    );
    return result.rows.map(mapGraphEdgeRow);
  });
}

// ---------------------------------------------------------------------------
// Evidence DB Methods
// ---------------------------------------------------------------------------

export async function createEvidence(
  pool: pg.Pool,
  input: CreateEvidenceInput,
): Promise<EvidenceRecord> {
  assertEvidenceInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    const metadata = input.metadata ?? {};
    const confidence = input.confidence ?? 1.0;

    const query = input.id === undefined
      ? `INSERT INTO evidence (
           analysis_run_id, subject_type, subject_id, file_path, symbol_id,
           line_start, line_end, column_start, column_end, relationship_description, confidence, metadata
         )
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                   line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`
      : `INSERT INTO evidence (
           id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
           line_start, line_end, column_start, column_end, relationship_description, confidence, metadata
         )
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                   line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`;

    const params = input.id === undefined
      ? [
          input.analysisRunId,
          input.subjectType.trim(),
          input.subjectId,
          input.filePath.trim(),
          input.symbolId ? input.symbolId.trim() : null,
          input.lineStart ?? null,
          input.lineEnd ?? null,
          input.columnStart ?? null,
          input.columnEnd ?? null,
          input.relationshipDescription.trim(),
          confidence,
          JSON.stringify(metadata),
        ]
      : [
          input.id,
          input.analysisRunId,
          input.subjectType.trim(),
          input.subjectId,
          input.filePath.trim(),
          input.symbolId ? input.symbolId.trim() : null,
          input.lineStart ?? null,
          input.lineEnd ?? null,
          input.columnStart ?? null,
          input.columnEnd ?? null,
          input.relationshipDescription.trim(),
          confidence,
          JSON.stringify(metadata),
        ];

    const result = await client.query<EvidenceRow>(query, params);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("evidence insert returned no row");
    }
    return mapEvidenceRow(row);
  });
}

export async function batchCreateEvidence(
  pool: pg.Pool,
  organizationId: string,
  records: readonly CreateEvidenceInput[],
): Promise<EvidenceRecord[]> {
  if (records.length === 0) {
    return [];
  }

  for (const r of records) {
    assertEvidenceInput(r);
  }

  return withTenant(pool, organizationId, async (client) => {
    const created: EvidenceRecord[] = [];
    for (const input of records) {
      const metadata = input.metadata ?? {};
      const confidence = input.confidence ?? 1.0;

      const query = input.id === undefined
        ? `INSERT INTO evidence (
             analysis_run_id, subject_type, subject_id, file_path, symbol_id,
             line_start, line_end, column_start, column_end, relationship_description, confidence, metadata
           )
           VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                     line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`
        : `INSERT INTO evidence (
             id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
             line_start, line_end, column_start, column_end, relationship_description, confidence, metadata
           )
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
           RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                     line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`;

      const params = input.id === undefined
        ? [
            input.analysisRunId,
            input.subjectType.trim(),
            input.subjectId,
            input.filePath.trim(),
            input.symbolId ? input.symbolId.trim() : null,
            input.lineStart ?? null,
            input.lineEnd ?? null,
            input.columnStart ?? null,
            input.columnEnd ?? null,
            input.relationshipDescription.trim(),
            confidence,
            JSON.stringify(metadata),
          ]
        : [
            input.id,
            input.analysisRunId,
            input.subjectType.trim(),
            input.subjectId,
            input.filePath.trim(),
            input.symbolId ? input.symbolId.trim() : null,
            input.lineStart ?? null,
            input.lineEnd ?? null,
            input.columnStart ?? null,
            input.columnEnd ?? null,
            input.relationshipDescription.trim(),
            confidence,
            JSON.stringify(metadata),
          ];

      const res = await client.query<EvidenceRow>(query, params);
      if (res.rows[0]) {
        created.push(mapEvidenceRow(res.rows[0]));
      }
    }
    return created;
  });
}

export async function getEvidenceById(
  pool: pg.Pool,
  organizationId: string,
  evidenceId: string,
): Promise<EvidenceRecord | null> {
  if (!UUID_REGEX.test(evidenceId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<EvidenceRow>(
      `SELECT id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
              line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at
       FROM evidence
       WHERE id = $1::uuid`,
      [evidenceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapEvidenceRow(row);
  });
}

export async function listEvidenceForSubject(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
  subjectType: EvidenceSubjectType,
  subjectId: string,
): Promise<EvidenceRecord[]> {
  if (!UUID_REGEX.test(analysisRunId) || !UUID_REGEX.test(subjectId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<EvidenceRow>(
      `SELECT id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
              line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at
       FROM evidence
       WHERE analysis_run_id = $1::uuid
         AND subject_type = $2
         AND subject_id = $3::uuid
       ORDER BY created_at ASC, id ASC`,
      [analysisRunId, subjectType.trim(), subjectId],
    );
    return result.rows.map(mapEvidenceRow);
  });
}

export async function listEvidenceForAnalysisRun(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<EvidenceRecord[]> {
  if (!UUID_REGEX.test(analysisRunId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<EvidenceRow>(
      `SELECT id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
              line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at
       FROM evidence
       WHERE analysis_run_id = $1::uuid
       ORDER BY created_at ASC, id ASC`,
      [analysisRunId],
    );
    return result.rows.map(mapEvidenceRow);
  });
}

export interface PersistGraphBuildInput {
  organizationId: string;
  analysisRunId: string;
  nodes: readonly CreateGraphNodeInput[];
  edges: readonly CreateGraphEdgeInput[];
  evidence: readonly CreateEvidenceInput[];
}

/**
 * Atomically persists nodes, edges, and evidence inside a single database transaction.
 */
export async function persistGraphBuild(
  pool: pg.Pool,
  input: PersistGraphBuildInput,
): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: EvidenceRecord[];
}> {
  if (
    !UUID_REGEX.test(input.organizationId) ||
    !UUID_REGEX.test(input.analysisRunId)
  ) {
    throw new AnalysisRunValidationError("Invalid organizationId or analysisRunId");
  }

  for (const n of input.nodes) {
    assertGraphNodeInput(n);
  }
  for (const e of input.edges) {
    assertGraphEdgeInput(e);
  }
  for (const ev of input.evidence) {
    assertEvidenceInput(ev);
  }

  return withTenant(pool, input.organizationId, async (client) => {
    // 1. Insert Nodes
    const nodes: GraphNode[] = [];
    for (const nodeInput of input.nodes) {
      const metadata = nodeInput.metadata ?? {};
      const confidence = nodeInput.confidence ?? 1.0;

      const query = nodeInput.id === undefined
        ? `INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
           VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (analysis_run_id, canonical_id) DO UPDATE
             SET name = EXCLUDED.name, metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence
           RETURNING id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at`
        : `INSERT INTO graph_nodes (id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
           ON CONFLICT (analysis_run_id, canonical_id) DO UPDATE
             SET name = EXCLUDED.name, metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence
           RETURNING id, analysis_run_id, canonical_id, node_type, name, path, metadata, confidence, created_at`;

      const params = nodeInput.id === undefined
        ? [
            nodeInput.analysisRunId,
            nodeInput.canonicalId.trim(),
            nodeInput.nodeType.trim(),
            nodeInput.name.trim(),
            nodeInput.path ? nodeInput.path.trim() : null,
            JSON.stringify(metadata),
            confidence,
          ]
        : [
            nodeInput.id,
            nodeInput.analysisRunId,
            nodeInput.canonicalId.trim(),
            nodeInput.nodeType.trim(),
            nodeInput.name.trim(),
            nodeInput.path ? nodeInput.path.trim() : null,
            JSON.stringify(metadata),
            confidence,
          ];

      const res = await client.query<GraphNodeRow>(query, params);
      if (res.rows[0]) {
        nodes.push(mapGraphNodeRow(res.rows[0]));
      }
    }

    // 2. Insert Edges
    const edges: GraphEdge[] = [];
    for (const edgeInput of input.edges) {
      const metadata = edgeInput.metadata ?? {};
      const confidence = edgeInput.confidence ?? 1.0;
      const provenance = edgeInput.provenance ?? "static-analysis";

      const query = edgeInput.id === undefined
        ? `INSERT INTO graph_edges (analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (analysis_run_id, source_node_id, target_node_id, edge_type) DO UPDATE
             SET metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence, provenance = EXCLUDED.provenance
           RETURNING id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at`
        : `INSERT INTO graph_edges (id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9)
           ON CONFLICT (analysis_run_id, source_node_id, target_node_id, edge_type) DO UPDATE
             SET metadata = EXCLUDED.metadata, confidence = EXCLUDED.confidence, provenance = EXCLUDED.provenance
           RETURNING id, analysis_run_id, source_node_id, target_node_id, edge_type, canonical_id, metadata, confidence, provenance, created_at`;

      const params = edgeInput.id === undefined
        ? [
            edgeInput.analysisRunId,
            edgeInput.sourceNodeId,
            edgeInput.targetNodeId,
            edgeInput.edgeType.trim(),
            edgeInput.canonicalId ? edgeInput.canonicalId.trim() : null,
            JSON.stringify(metadata),
            confidence,
            provenance,
          ]
        : [
            edgeInput.id,
            edgeInput.analysisRunId,
            edgeInput.sourceNodeId,
            edgeInput.targetNodeId,
            edgeInput.edgeType.trim(),
            edgeInput.canonicalId ? edgeInput.canonicalId.trim() : null,
            JSON.stringify(metadata),
            confidence,
            provenance,
          ];

      const res = await client.query<GraphEdgeRow>(query, params);
      if (res.rows[0]) {
        edges.push(mapGraphEdgeRow(res.rows[0]));
      }
    }

    // 3. Insert Evidence
    const evidence: EvidenceRecord[] = [];
    for (const evInput of input.evidence) {
      const metadata = evInput.metadata ?? {};
      const confidence = evInput.confidence ?? 1.0;

      const query = evInput.id === undefined
        ? `INSERT INTO evidence (
             analysis_run_id, subject_type, subject_id, file_path, symbol_id,
             line_start, line_end, column_start, column_end, relationship_description, confidence, metadata
           )
           VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                     line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`
        : `INSERT INTO evidence (
             id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
             line_start, line_end, column_start, column_end, relationship_description, confidence, metadata
           )
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
           RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                     line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`;

      const params = evInput.id === undefined
        ? [
            evInput.analysisRunId,
            evInput.subjectType.trim(),
            evInput.subjectId,
            evInput.filePath.trim(),
            evInput.symbolId ? evInput.symbolId.trim() : null,
            evInput.lineStart ?? null,
            evInput.lineEnd ?? null,
            evInput.columnStart ?? null,
            evInput.columnEnd ?? null,
            evInput.relationshipDescription.trim(),
            confidence,
            JSON.stringify(metadata),
          ]
        : [
            evInput.id,
            evInput.analysisRunId,
            evInput.subjectType.trim(),
            evInput.subjectId,
            evInput.filePath.trim(),
            evInput.symbolId ? evInput.symbolId.trim() : null,
            evInput.lineStart ?? null,
            evInput.lineEnd ?? null,
            evInput.columnStart ?? null,
            evInput.columnEnd ?? null,
            evInput.relationshipDescription.trim(),
            confidence,
            JSON.stringify(metadata),
          ];

      const res = await client.query<EvidenceRow>(query, params);
      if (res.rows[0]) {
        evidence.push(mapEvidenceRow(res.rows[0]));
      }
    }

    return { nodes, edges, evidence };
  });
}

// ---------------------------------------------------------------------------
// Helpers & Mapping
// ---------------------------------------------------------------------------

function mapAnalysisRunRow(row: AnalysisRunRow): AnalysisRun {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    status: row.status as AnalysisRunStatus,
    parserVersions: row.parser_versions ?? {},
    startedAt: row.started_at,
    completedAt: row.completed_at,
    coverageSummary: row.coverage_summary ?? {},
    createdAt: row.created_at,
  };
}

function mapGraphNodeRow(row: GraphNodeRow): GraphNode {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    canonicalId: row.canonical_id,
    nodeType: row.node_type as GraphNodeType,
    name: row.name,
    path: row.path,
    metadata: row.metadata ?? {},
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function mapGraphEdgeRow(row: GraphEdgeRow): GraphEdge {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    edgeType: row.edge_type as GraphEdgeType,
    canonicalId: row.canonical_id,
    metadata: row.metadata ?? {},
    confidence: row.confidence,
    provenance: row.provenance as GraphEdgeProvenance,
    createdAt: row.created_at,
  };
}

function mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    analysisRunId: row.analysis_run_id,
    subjectType: row.subject_type as EvidenceSubjectType,
    subjectId: row.subject_id,
    filePath: row.file_path,
    symbolId: row.symbol_id,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    columnStart: row.column_start,
    columnEnd: row.column_end,
    relationshipDescription: row.relationship_description,
    confidence: row.confidence,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function assertAnalysisRunInput(input: CreateAnalysisRunInput): void {
  if (
    (input.id !== undefined && !UUID_REGEX.test(input.id)) ||
    !UUID_REGEX.test(input.snapshotId) ||
    !UUID_REGEX.test(input.organizationId)
  ) {
    throw new AnalysisRunValidationError();
  }
}

function assertGraphNodeInput(input: CreateGraphNodeInput): void {
  if (
    (input.id !== undefined && !UUID_REGEX.test(input.id)) ||
    !UUID_REGEX.test(input.analysisRunId) ||
    !UUID_REGEX.test(input.organizationId) ||
    input.canonicalId.trim().length === 0 ||
    input.nodeType.trim().length === 0 ||
    input.name.trim().length === 0 ||
    (input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1))
  ) {
    throw new GraphNodeValidationError();
  }
}

function assertGraphEdgeInput(input: CreateGraphEdgeInput): void {
  if (
    (input.id !== undefined && !UUID_REGEX.test(input.id)) ||
    !UUID_REGEX.test(input.analysisRunId) ||
    !UUID_REGEX.test(input.sourceNodeId) ||
    !UUID_REGEX.test(input.targetNodeId) ||
    !UUID_REGEX.test(input.organizationId) ||
    input.edgeType.trim().length === 0 ||
    (input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1))
  ) {
    throw new GraphEdgeValidationError();
  }
}

function assertEvidenceInput(input: CreateEvidenceInput): void {
  if (
    (input.id !== undefined && !UUID_REGEX.test(input.id)) ||
    !UUID_REGEX.test(input.analysisRunId) ||
    !UUID_REGEX.test(input.subjectId) ||
    !UUID_REGEX.test(input.organizationId) ||
    input.subjectType.trim().length === 0 ||
    input.filePath.trim().length === 0 ||
    input.relationshipDescription.trim().length === 0 ||
    (input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) ||
    (input.lineStart !== undefined && input.lineStart !== null && input.lineStart < 1) ||
    (input.lineEnd !== undefined &&
      input.lineEnd !== null &&
      input.lineStart !== undefined &&
      input.lineStart !== null &&
      input.lineEnd < input.lineStart)
  ) {
    throw new EvidenceValidationError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

