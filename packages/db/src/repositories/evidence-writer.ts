import { createHash } from "node:crypto";
import type {
  CreateEvidenceInput,
  CreateGraphEdgeInput,
  CreateGraphNodeInput,
  EvidenceRecord,
  EvidenceSubjectType,
  SourceLocation,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";
import { EvidenceValidationError } from "./graph.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BuildEvidenceParams {
  id?: string;
  organizationId: string;
  analysisRunId: string;
  subjectType: EvidenceSubjectType;
  subjectId: string;
  filePath: string;
  symbolId?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  columnStart?: number | null;
  columnEnd?: number | null;
  relationshipDescription: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
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

/**
 * Evidence Writer abstraction providing deterministic evidence creation,
 * strict validation, single/batch database persistence, and transaction support.
 */
export class EvidenceWriter {
  private pool: pg.Pool | undefined;

  constructor(pool?: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Deterministically derives a UUID v4 string from a seed using SHA-256.
   */
  static generateDeterministicUuid(seed: string): string {
    const hash = createHash("sha256").update(seed).digest("hex");
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      `4${hash.slice(13, 16)}`,
      `${((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
      hash.slice(20, 32),
    ].join("-");
  }

  /**
   * Deterministically computes an evidence UUID based on semantic properties.
   */
  static generateEvidenceId(params: {
    analysisRunId: string;
    subjectType: EvidenceSubjectType;
    subjectId: string;
    filePath: string;
    relationshipDescription: string;
  }): string {
    const seed = `${params.analysisRunId}:evidence:${params.subjectType.trim()}:${params.subjectId}:${params.filePath.trim()}:${params.relationshipDescription.trim()}`;
    return EvidenceWriter.generateDeterministicUuid(seed);
  }

  /**
   * Constructs and validates a CreateEvidenceInput record with deterministic identity.
   */
  static createEvidenceInput(params: BuildEvidenceParams): CreateEvidenceInput {
    const filePath = params.filePath.trim();
    const relationshipDescription = params.relationshipDescription.trim();
    const subjectType = params.subjectType.trim() as EvidenceSubjectType;
    const confidence = params.confidence ?? 1.0;

    const id =
      params.id ??
      EvidenceWriter.generateEvidenceId({
        analysisRunId: params.analysisRunId,
        subjectType,
        subjectId: params.subjectId,
        filePath,
        relationshipDescription,
      });

    const input: CreateEvidenceInput = {
      id,
      organizationId: params.organizationId,
      analysisRunId: params.analysisRunId,
      subjectType,
      subjectId: params.subjectId,
      filePath,
      symbolId: params.symbolId ? params.symbolId.trim() : null,
      lineStart: params.lineStart ?? null,
      lineEnd: params.lineEnd ?? null,
      columnStart: params.columnStart ?? null,
      columnEnd: params.columnEnd ?? null,
      relationshipDescription,
      confidence,
      metadata: params.metadata ?? {},
    };

    EvidenceWriter.assertEvidenceInput(input);
    return input;
  }

  /**
   * Constructs Evidence for a GraphNode record.
   */
  static createNodeEvidence(
    organizationId: string,
    analysisRunId: string,
    node: CreateGraphNodeInput,
    filePath: string,
    description: string,
    location?: SourceLocation,
    symbolId?: string | null,
  ): CreateEvidenceInput | null {
    if (!node.id) return null;

    return EvidenceWriter.createEvidenceInput({
      organizationId,
      analysisRunId,
      subjectType: "graph_node",
      subjectId: node.id,
      filePath,
      symbolId: symbolId ?? null,
      lineStart: location?.start.line ?? null,
      lineEnd: location?.end.line ?? null,
      columnStart: location?.start.column ?? null,
      columnEnd: location?.end.column ?? null,
      relationshipDescription: description,
      confidence: node.confidence ?? 1.0,
      metadata: { canonicalId: node.canonicalId, nodeType: node.nodeType },
    });
  }

  /**
   * Constructs Evidence for a GraphEdge record.
   */
  static createEdgeEvidence(
    organizationId: string,
    analysisRunId: string,
    edge: CreateGraphEdgeInput,
    filePath: string,
    description: string,
    location?: SourceLocation,
    symbolId?: string | null,
  ): CreateEvidenceInput | null {
    if (!edge.id) return null;

    return EvidenceWriter.createEvidenceInput({
      organizationId,
      analysisRunId,
      subjectType: "graph_edge",
      subjectId: edge.id,
      filePath,
      symbolId: symbolId ?? null,
      lineStart: location?.start.line ?? null,
      lineEnd: location?.end.line ?? null,
      columnStart: location?.start.column ?? null,
      columnEnd: location?.end.column ?? null,
      relationshipDescription: description,
      confidence: edge.confidence ?? 1.0,
      metadata: { canonicalId: edge.canonicalId ?? null, edgeType: edge.edgeType },
    });
  }

  /**
   * Validates structural and semantic invariants of a CreateEvidenceInput object.
   */
  static assertEvidenceInput(input: CreateEvidenceInput): void {
    if (
      (input.id !== undefined && !UUID_REGEX.test(input.id)) ||
      !UUID_REGEX.test(input.analysisRunId) ||
      !UUID_REGEX.test(input.subjectId) ||
      !UUID_REGEX.test(input.organizationId) ||
      input.subjectType.trim().length === 0 ||
      input.filePath.trim().length === 0 ||
      input.relationshipDescription.trim().length === 0 ||
      (input.confidence !== undefined &&
        (!Number.isFinite(input.confidence) ||
          input.confidence < 0 ||
          input.confidence > 1)) ||
      (input.lineStart !== undefined &&
        input.lineStart !== null &&
        input.lineStart < 1) ||
      (input.lineEnd !== undefined &&
        input.lineEnd !== null &&
        input.lineStart !== undefined &&
        input.lineStart !== null &&
        input.lineEnd < input.lineStart) ||
      (input.columnStart !== undefined &&
        input.columnStart !== null &&
        input.columnStart < 1) ||
      (input.columnEnd !== undefined &&
        input.columnEnd !== null &&
        input.columnStart !== undefined &&
        input.columnStart !== null &&
        input.columnEnd < input.columnStart)
    ) {
      throw new EvidenceValidationError(
        "Invalid Evidence input: missing or malformed fields or invalid coordinates.",
      );
    }
  }

  /**
   * Writes a single evidence record inside a database connection pool.
   */
  static async writeEvidence(
    pool: pg.Pool,
    input: CreateEvidenceInput | BuildEvidenceParams,
  ): Promise<EvidenceRecord> {
    const formatted =
      "id" in input && input.id !== undefined
        ? (input as CreateEvidenceInput)
        : EvidenceWriter.createEvidenceInput(input as BuildEvidenceParams);

    EvidenceWriter.assertEvidenceInput(formatted);

    return withTenant(pool, formatted.organizationId, async (client) => {
      return EvidenceWriter.writeEvidenceSingleTx(client, formatted);
    });
  }

  /**
   * Writes a batch of evidence records inside a database pool with tenant isolation.
   */
  static async writeEvidenceBatch(
    pool: pg.Pool,
    organizationId: string,
    records: readonly CreateEvidenceInput[],
  ): Promise<EvidenceRecord[]> {
    if (records.length === 0) return [];

    for (const r of records) {
      EvidenceWriter.assertEvidenceInput(r);
    }

    return withTenant(pool, organizationId, async (client) => {
      return EvidenceWriter.writeEvidenceBatchTx(client, records);
    });
  }

  /**
   * Writes a single evidence row using an active PoolClient inside a transaction.
   */
  static async writeEvidenceSingleTx(
    client: pg.PoolClient,
    input: CreateEvidenceInput,
  ): Promise<EvidenceRecord> {
    const metadata = input.metadata ?? {};
    const confidence = input.confidence ?? 1.0;

    const query =
      input.id === undefined
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
         ON CONFLICT (id) DO UPDATE
           SET subject_type = EXCLUDED.subject_type,
               subject_id = EXCLUDED.subject_id,
               file_path = EXCLUDED.file_path,
               symbol_id = EXCLUDED.symbol_id,
               line_start = EXCLUDED.line_start,
               line_end = EXCLUDED.line_end,
               column_start = EXCLUDED.column_start,
               column_end = EXCLUDED.column_end,
               relationship_description = EXCLUDED.relationship_description,
               confidence = EXCLUDED.confidence,
               metadata = EXCLUDED.metadata
         RETURNING id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
                   line_start, line_end, column_start, column_end, relationship_description, confidence, metadata, created_at`;

    const params =
      input.id === undefined
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
    const row = res.rows[0];
    if (!row) {
      throw new Error("Evidence write returned no row");
    }
    return EvidenceWriter.mapEvidenceRow(row);
  }

  /**
   * Writes a batch of evidence records inside an active PoolClient transaction.
   */
  static async writeEvidenceBatchTx(
    client: pg.PoolClient,
    records: readonly CreateEvidenceInput[],
  ): Promise<EvidenceRecord[]> {
    const written: EvidenceRecord[] = [];
    for (const input of records) {
      const row = await EvidenceWriter.writeEvidenceSingleTx(client, input);
      written.push(row);
    }
    return written;
  }

  /**
   * Instance method: Write a single evidence record using constructor pool.
   */
  async write(
    input: CreateEvidenceInput | BuildEvidenceParams,
  ): Promise<EvidenceRecord> {
    if (!this.pool) {
      throw new Error("EvidenceWriter instance requires a pg.Pool parameter");
    }
    return EvidenceWriter.writeEvidence(this.pool, input);
  }

  /**
   * Instance method: Write a batch of evidence records using constructor pool.
   */
  async writeBatch(
    organizationId: string,
    records: readonly CreateEvidenceInput[],
  ): Promise<EvidenceRecord[]> {
    if (!this.pool) {
      throw new Error("EvidenceWriter instance requires a pg.Pool parameter");
    }
    return EvidenceWriter.writeEvidenceBatch(this.pool, organizationId, records);
  }

  private static mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
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
}
