import crypto from "node:crypto";
import type {
  CreateEvidenceInput,
  EvidenceRecord,
  EvidenceSubjectType,
  ImpactAnalysis,
  ImpactAnalysisExecutionMetrics,
  ImpactAnalysisStatus,
  ImpactFinding,
  PersistImpactAnalysisResult,
  PersistPullRequestImpactAnalysisOptions,
  SaveImpactAnalysisInput,
  SaveImpactAnalysisResult,
  UnresolvedChangedFile,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";
import { EvidenceWriter } from "./evidence-writer.ts";
import {
  analyzePullRequestImpact,
  PullRequestNotFoundError,
} from "./impact-analysis-engine.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Error Hierarchy for Step 44
// ---------------------------------------------------------------------------

export class ImpactAnalysisPersistenceValidationError extends Error {
  readonly code = "invalid_input";
  constructor(message = "Impact analysis persistence fields are invalid.") {
    super(message);
    this.name = "ImpactAnalysisPersistenceValidationError";
  }
}

export class ImpactAnalysisNotFoundError extends Error {
  readonly code = "impact_analysis_not_found";
  constructor(message = "Impact analysis not found or inaccessible for this organization.") {
    super(message);
    this.name = "ImpactAnalysisNotFoundError";
  }
}

export class ImpactAnalysisConflictError extends Error {
  readonly code = "conflict";
  constructor(message = "Impact analysis storage conflict occurred.") {
    super(message);
    this.name = "ImpactAnalysisConflictError";
  }
}

// ---------------------------------------------------------------------------
// Row Interfaces & Mappers
// ---------------------------------------------------------------------------

interface ImpactAnalysisRow {
  id: string;
  pull_request_id: string;
  analysis_run_id: string;
  status: string;
  direct_impact: ImpactFinding[];
  downstream_impact: ImpactFinding[];
  affected_apis: ImpactFinding[];
  affected_events: ImpactFinding[];
  affected_services: ImpactFinding[];
  workflow_impact_summary: string[];
  unresolved_files: UnresolvedChangedFile[];
  truncated: boolean;
  truncation_reason: string | null;
  max_depth_reached: number;
  execution_metrics: ImpactAnalysisExecutionMetrics;
  metadata: Record<string, unknown>;
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

function mapImpactAnalysisRow(row: ImpactAnalysisRow): ImpactAnalysis {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    analysisRunId: row.analysis_run_id,
    status: row.status as ImpactAnalysisStatus,
    directImpact: row.direct_impact ?? [],
    downstreamImpact: row.downstream_impact ?? [],
    affectedApis: row.affected_apis ?? [],
    affectedEvents: row.affected_events ?? [],
    affectedServices: row.affected_services ?? [],
    workflowImpactSummary: row.workflow_impact_summary ?? [],
    unresolvedFiles: row.unresolved_files ?? [],
    truncated: row.truncated,
    truncationReason: row.truncation_reason,
    maxDepthReached: row.max_depth_reached,
    executionMetrics: row.execution_metrics ?? {
      totalSeedNodes: 0,
      totalAffectedNodes: 0,
      totalEdgesTraversed: 0,
      durationMs: 0,
    },
    metadata: row.metadata ?? {},
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

// ---------------------------------------------------------------------------
// Transactional Persistence (saveImpactAnalysisTx)
// ---------------------------------------------------------------------------

/**
 * Saves an ImpactAnalysis record and all corresponding impact_finding evidence records
 * within an active client transaction.
 */
export async function saveImpactAnalysisTx(
  client: pg.PoolClient,
  input: SaveImpactAnalysisInput,
): Promise<SaveImpactAnalysisResult> {
  const organizationId = input.organizationId;
  const pullRequestId = input.pullRequestId ?? input.result?.pullRequestId;
  const analysisRunId = input.analysisRunId ?? input.result?.analysisRunId;

  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "organizationId must be a valid UUID string.",
    );
  }
  if (!pullRequestId || !UUID_REGEX.test(pullRequestId)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "pullRequestId must be a valid UUID string.",
    );
  }
  if (!analysisRunId || !UUID_REGEX.test(analysisRunId)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "analysisRunId must be a valid UUID string.",
    );
  }
  if (input.id !== undefined && !UUID_REGEX.test(input.id)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "id must be a valid UUID string.",
    );
  }

  // 1. Verify PR exists within tenant
  const prRes = await client.query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM pull_requests WHERE id = $1::uuid AND organization_id = $2::uuid`,
    [pullRequestId, organizationId],
  );
  if (!prRes.rows[0]) {
    throw new PullRequestNotFoundError(
      `Pull request ${pullRequestId} not found or inaccessible for organization ${organizationId}.`,
    );
  }

  // 2. Resolve findings lists
  const directImpactRaw = input.directImpact ?? input.result?.directImpacts ?? [];
  const downstreamImpactRaw =
    input.downstreamImpact ?? input.result?.downstreamImpacts ?? [];
  const affectedApis = input.affectedApis ?? input.result?.affectedApis ?? [];
  const affectedEvents =
    input.affectedEvents ?? input.result?.affectedEvents ?? [];
  const affectedServices =
    input.affectedServices ?? input.result?.affectedServices ?? [];
  const workflowImpactSummary =
    input.workflowImpactSummary ?? input.result?.workflowImpactSummary ?? [];
  const unresolvedFiles =
    input.unresolvedFiles ?? input.result?.unresolvedFiles ?? [];
  const truncated = input.truncated ?? input.result?.truncated ?? false;
  const truncationReason =
    input.truncationReason ?? input.result?.truncationReason ?? null;
  const maxDepthReached =
    input.maxDepthReached ?? input.result?.maxDepthReached ?? 0;
  const executionMetrics = input.executionMetrics ??
    input.result?.executionMetrics ?? {
      totalSeedNodes: input.result?.seedNodes.length ?? 0,
      totalAffectedNodes: directImpactRaw.length + downstreamImpactRaw.length,
      totalEdgesTraversed: 0,
      durationMs: 0,
    };
  const status = input.status ?? "completed";
  const metadata = input.metadata ?? {};

  const impactAnalysisId = input.id ?? crypto.randomUUID();

  // 3. Construct impact_finding evidence inputs using EvidenceWriter
  const evidenceInputs: CreateEvidenceInput[] = [];

  const directImpact: ImpactFinding[] = [];
  for (const finding of directImpactRaw) {
    const evInput = EvidenceWriter.createImpactFindingEvidence({
      organizationId,
      analysisRunId,
      impactAnalysisId,
      pullRequestId,
      finding,
    });
    evidenceInputs.push(evInput);
    directImpact.push({
      ...finding,
      evidenceIds: Array.from(
        new Set([...(finding.evidenceIds ?? []), evInput.id!]),
      ).sort(),
    });
  }

  const downstreamImpact: ImpactFinding[] = [];
  for (const finding of downstreamImpactRaw) {
    const evInput = EvidenceWriter.createImpactFindingEvidence({
      organizationId,
      analysisRunId,
      impactAnalysisId,
      pullRequestId,
      finding,
    });
    evidenceInputs.push(evInput);
    downstreamImpact.push({
      ...finding,
      evidenceIds: Array.from(
        new Set([...(finding.evidenceIds ?? []), evInput.id!]),
      ).sort(),
    });
  }

  // 4. Insert or update impact_analyses row
  const query = `
    INSERT INTO impact_analyses (
      id, pull_request_id, analysis_run_id, status,
      direct_impact, downstream_impact, affected_apis, affected_events, affected_services,
      workflow_impact_summary, unresolved_files, truncated, truncation_reason,
      max_depth_reached, execution_metrics, metadata
    )
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET status = EXCLUDED.status,
          direct_impact = EXCLUDED.direct_impact,
          downstream_impact = EXCLUDED.downstream_impact,
          affected_apis = EXCLUDED.affected_apis,
          affected_events = EXCLUDED.affected_events,
          affected_services = EXCLUDED.affected_services,
          workflow_impact_summary = EXCLUDED.workflow_impact_summary,
          unresolved_files = EXCLUDED.unresolved_files,
          truncated = EXCLUDED.truncated,
          truncation_reason = EXCLUDED.truncation_reason,
          max_depth_reached = EXCLUDED.max_depth_reached,
          execution_metrics = EXCLUDED.execution_metrics,
          metadata = EXCLUDED.metadata
    RETURNING id, pull_request_id, analysis_run_id, status,
              direct_impact, downstream_impact, affected_apis, affected_events, affected_services,
              workflow_impact_summary, unresolved_files, truncated, truncation_reason,
              max_depth_reached, execution_metrics, metadata, created_at;
  `;

  const params = [
    impactAnalysisId,
    pullRequestId,
    analysisRunId,
    status,
    JSON.stringify(directImpact),
    JSON.stringify(downstreamImpact),
    JSON.stringify(affectedApis),
    JSON.stringify(affectedEvents),
    JSON.stringify(affectedServices),
    JSON.stringify(workflowImpactSummary),
    JSON.stringify(unresolvedFiles),
    truncated,
    truncationReason,
    maxDepthReached,
    JSON.stringify(executionMetrics),
    JSON.stringify(metadata),
  ];

  const res = await client.query<ImpactAnalysisRow>(query, params);
  const row = res.rows[0];
  if (!row) {
    throw new ImpactAnalysisConflictError(
      "Failed to persist impact analysis record.",
    );
  }

  // 5. Persist evidence batch via EvidenceWriter
  const writtenEvidence = await EvidenceWriter.writeEvidenceBatchTx(
    client,
    evidenceInputs,
  );

  return {
    impactAnalysis: mapImpactAnalysisRow(row),
    evidenceRecords: writtenEvidence,
  };
}

// ---------------------------------------------------------------------------
// High-Level Persistence Functions
// ---------------------------------------------------------------------------

/**
 * Persists an impact analysis result and all finding evidence records inside a tenant transaction.
 */
export async function saveImpactAnalysis(
  pool: pg.Pool,
  input: SaveImpactAnalysisInput,
): Promise<SaveImpactAnalysisResult> {
  const organizationId = input.organizationId;
  const pullRequestId = input.pullRequestId ?? input.result?.pullRequestId;
  const analysisRunId = input.analysisRunId ?? input.result?.analysisRunId;

  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "organizationId must be a valid UUID string.",
    );
  }
  if (!pullRequestId || !UUID_REGEX.test(pullRequestId)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "pullRequestId must be a valid UUID string.",
    );
  }
  if (!analysisRunId || !UUID_REGEX.test(analysisRunId)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "analysisRunId must be a valid UUID string.",
    );
  }
  if (input.id !== undefined && !UUID_REGEX.test(input.id)) {
    throw new ImpactAnalysisPersistenceValidationError(
      "id must be a valid UUID string.",
    );
  }

  return withTenant(pool, input.organizationId, async (client) => {
    return saveImpactAnalysisTx(client, input);
  });
}

/**
 * Executes the Step 43 Impact Analysis Engine and persists the resulting ImpactAnalysis
 * and Evidence records into PostgreSQL within a single tenant scope.
 */
export async function persistPullRequestImpactAnalysis(
  pool: pg.Pool,
  options: PersistPullRequestImpactAnalysisOptions,
): Promise<PersistImpactAnalysisResult> {
  const result = await analyzePullRequestImpact(pool, options);
  return saveImpactAnalysis(pool, {
    ...(options.id !== undefined ? { id: options.id } : {}),
    organizationId: options.organizationId,
    pullRequestId: options.pullRequestId,
    analysisRunId: result.analysisRunId,
    result,
    metadata: options.metadata,
  });
}

// ---------------------------------------------------------------------------
// Query Methods
// ---------------------------------------------------------------------------

/**
 * Retrieves a single persisted ImpactAnalysis record by its ID within the tenant scope.
 */
export async function getImpactAnalysisById(
  pool: pg.Pool,
  organizationId: string,
  impactAnalysisId: string,
): Promise<ImpactAnalysis | null> {
  if (!UUID_REGEX.test(impactAnalysisId) || !UUID_REGEX.test(organizationId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<ImpactAnalysisRow>(
      `SELECT id, pull_request_id, analysis_run_id, status,
              direct_impact, downstream_impact, affected_apis, affected_events, affected_services,
              workflow_impact_summary, unresolved_files, truncated, truncation_reason,
              max_depth_reached, execution_metrics, metadata, created_at
       FROM impact_analyses
       WHERE id = $1::uuid`,
      [impactAnalysisId],
    );
    const row = res.rows[0];
    return row ? mapImpactAnalysisRow(row) : null;
  });
}

/**
 * Retrieves the latest completed impact analysis record for a given pull request.
 */
export async function getLatestImpactAnalysisForPullRequest(
  pool: pg.Pool,
  organizationId: string,
  pullRequestId: string,
): Promise<ImpactAnalysis | null> {
  if (!UUID_REGEX.test(pullRequestId) || !UUID_REGEX.test(organizationId)) {
    return null;
  }
  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<ImpactAnalysisRow>(
      `SELECT id, pull_request_id, analysis_run_id, status,
              direct_impact, downstream_impact, affected_apis, affected_events, affected_services,
              workflow_impact_summary, unresolved_files, truncated, truncation_reason,
              max_depth_reached, execution_metrics, metadata, created_at
       FROM impact_analyses
       WHERE pull_request_id = $1::uuid
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [pullRequestId],
    );
    const row = res.rows[0];
    return row ? mapImpactAnalysisRow(row) : null;
  });
}

/**
 * Lists all impact analyses for a pull request, sorted by creation date descending.
 */
export async function listImpactAnalysesForPullRequest(
  pool: pg.Pool,
  organizationId: string,
  pullRequestId: string,
): Promise<ImpactAnalysis[]> {
  if (!UUID_REGEX.test(pullRequestId) || !UUID_REGEX.test(organizationId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<ImpactAnalysisRow>(
      `SELECT id, pull_request_id, analysis_run_id, status,
              direct_impact, downstream_impact, affected_apis, affected_events, affected_services,
              workflow_impact_summary, unresolved_files, truncated, truncation_reason,
              max_depth_reached, execution_metrics, metadata, created_at
       FROM impact_analyses
       WHERE pull_request_id = $1::uuid
       ORDER BY created_at DESC, id DESC`,
      [pullRequestId],
    );
    return res.rows.map(mapImpactAnalysisRow);
  });
}

/**
 * Retrieves all impact_finding evidence records associated with a specific impact analysis.
 */
export async function listImpactFindingEvidence(
  pool: pg.Pool,
  organizationId: string,
  impactAnalysisId: string,
): Promise<EvidenceRecord[]> {
  if (!UUID_REGEX.test(impactAnalysisId) || !UUID_REGEX.test(organizationId)) {
    return [];
  }
  return withTenant(pool, organizationId, async (client) => {
    const checkRes = await client.query<{ id: string }>(
      `SELECT id FROM impact_analyses WHERE id = $1::uuid`,
      [impactAnalysisId],
    );
    if (!checkRes.rows[0]) {
      return [];
    }

    const res = await client.query<EvidenceRow>(
      `SELECT id, analysis_run_id, subject_type, subject_id, file_path, symbol_id,
              line_start, line_end, column_start, column_end, relationship_description,
              confidence, metadata, created_at
       FROM evidence
       WHERE subject_type = 'impact_finding'
         AND metadata->>'impactAnalysisId' = $1
       ORDER BY created_at ASC, id ASC`,
      [impactAnalysisId],
    );
    return res.rows.map(mapEvidenceRow);
  });
}

