/**
 * @file ai-analysis.ts
 * Repository for AIAnalysis records (Phase 9 Step 62).
 *
 * Implements tenant-scoped persistence, idempotency, and retrieval
 * for grounded AI explanations and reasoning outputs.
 */

import type {
  AIAnalysis,
  AIAnalysisStatus,
  AIAnalysisSubjectType,
  AIAnalysisValidationStatus,
  AIExplanationOutputDto,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_SUBJECT_TYPES: ReadonlySet<AIAnalysisSubjectType> = new Set([
  "impact_analysis",
  "simulation",
  "chat_query",
]);

const VALID_STATUSES: ReadonlySet<AIAnalysisStatus> = new Set([
  "pending",
  "completed",
  "rejected",
  "failed",
]);

const VALID_VALIDATION_STATUSES: ReadonlySet<AIAnalysisValidationStatus> =
  new Set(["pending", "passed", "rejected", "fallback"]);

export class AIAnalysisValidationError extends Error {
  readonly code = "invalid_input";
  constructor(message = "AI analysis input fields are invalid.") {
    super(message);
    this.name = "AIAnalysisValidationError";
  }
}

export class AIAnalysisNotFoundError extends Error {
  readonly code = "not_found";
  constructor(message = "AI analysis not found.") {
    super(message);
    this.name = "AIAnalysisNotFoundError";
  }
}

export interface SaveAIAnalysisInput {
  readonly id?: string | undefined;
  readonly organizationId: string;
  readonly subjectType: AIAnalysisSubjectType;
  readonly subjectId: string;
  readonly status?: AIAnalysisStatus | undefined;
  readonly modelUsed?: string | null | undefined;
  readonly promptVersion?: string | null | undefined;
  readonly inputEvidenceIds?: readonly string[] | undefined;
  readonly outputText?: string | null | undefined;
  readonly outputStructured?: AIExplanationOutputDto | null | undefined;
  readonly validationStatus?: AIAnalysisValidationStatus | null | undefined;
  readonly tokenCount?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly latencyMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly errorMessage?: string | null | undefined;
}

interface AIAnalysisRow {
  id: string;
  organization_id: string;
  subject_type: string;
  subject_id: string;
  status: string;
  model_used: string | null;
  prompt_version: string | null;
  input_evidence_ids: string[];
  output_text: string | null;
  output_structured: AIExplanationOutputDto | null;
  validation_status: string | null;
  token_count: number;
  cost_usd: string | number;
  latency_ms: number;
  metadata: Record<string, unknown>;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapAIAnalysisRow(row: AIAnalysisRow): AIAnalysis {
  return {
    id: row.id,
    organizationId: row.organization_id,
    subjectType: row.subject_type as AIAnalysisSubjectType,
    subjectId: row.subject_id,
    status: row.status as AIAnalysisStatus,
    modelUsed: row.model_used,
    promptVersion: row.prompt_version,
    inputEvidenceIds: Array.isArray(row.input_evidence_ids)
      ? Object.freeze([...row.input_evidence_ids])
      : Object.freeze([]),
    outputText: row.output_text,
    outputStructured: row.output_structured,
    validationStatus: (row.validation_status as AIAnalysisValidationStatus) ?? null,
    tokenCount: typeof row.token_count === "number" ? row.token_count : parseInt(String(row.token_count), 10) || 0,
    costUsd: typeof row.cost_usd === "number" ? row.cost_usd : parseFloat(String(row.cost_usd)) || 0,
    latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : parseInt(String(row.latency_ms), 10) || 0,
    metadata: row.metadata ?? {},
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function validateSaveAIAnalysisInput(input: SaveAIAnalysisInput): void {
  if (!input.organizationId || !UUID_REGEX.test(input.organizationId)) {
    throw new AIAnalysisValidationError("Invalid organization ID format. Must be a valid UUID.");
  }

  if (!input.subjectId || !UUID_REGEX.test(input.subjectId)) {
    throw new AIAnalysisValidationError("Invalid subject ID format. Must be a valid UUID.");
  }

  if (!input.subjectType || !VALID_SUBJECT_TYPES.has(input.subjectType)) {
    throw new AIAnalysisValidationError(
      `Invalid subject type '${input.subjectType}'. Must be one of: ${Array.from(VALID_SUBJECT_TYPES).join(", ")}.`,
    );
  }

  if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
    throw new AIAnalysisValidationError(
      `Invalid status '${input.status}'. Must be one of: ${Array.from(VALID_STATUSES).join(", ")}.`,
    );
  }

  if (
    input.validationStatus !== undefined &&
    input.validationStatus !== null &&
    !VALID_VALIDATION_STATUSES.has(input.validationStatus)
  ) {
    throw new AIAnalysisValidationError(
      `Invalid validation status '${input.validationStatus}'. Must be one of: ${Array.from(VALID_VALIDATION_STATUSES).join(", ")}.`,
    );
  }

  if (input.id !== undefined && !UUID_REGEX.test(input.id)) {
    throw new AIAnalysisValidationError("Invalid ID format. Must be a valid UUID.");
  }

  if (input.tokenCount !== undefined && (input.tokenCount < 0 || !Number.isFinite(input.tokenCount))) {
    throw new AIAnalysisValidationError("tokenCount must be a non-negative finite number.");
  }

  if (input.costUsd !== undefined && (input.costUsd < 0 || !Number.isFinite(input.costUsd))) {
    throw new AIAnalysisValidationError("costUsd must be a non-negative finite number.");
  }

  if (input.latencyMs !== undefined && (input.latencyMs < 0 || !Number.isFinite(input.latencyMs))) {
    throw new AIAnalysisValidationError("latencyMs must be a non-negative finite number.");
  }
}

/**
 * Saves or updates an AIAnalysis record under tenant isolation.
 *
 * Enforces idempotency via UNIQUE (organization_id, subject_type, subject_id).
 */
export async function saveAIAnalysis(
  pool: pg.Pool,
  input: SaveAIAnalysisInput,
): Promise<AIAnalysis> {
  validateSaveAIAnalysisInput(input);

  const status = input.status ?? "pending";
  const inputEvidenceIds = input.inputEvidenceIds ? [...input.inputEvidenceIds] : [];
  const tokenCount = Math.max(0, Math.floor(input.tokenCount ?? 0));
  const costUsd = Math.max(0, input.costUsd ?? 0);
  const latencyMs = Math.max(0, Math.floor(input.latencyMs ?? 0));
  const metadata = input.metadata ?? {};

  return withTenant(pool, input.organizationId, async (client) => {
    const query = `
      INSERT INTO ai_analyses (
        id,
        organization_id,
        subject_type,
        subject_id,
        status,
        model_used,
        prompt_version,
        input_evidence_ids,
        output_text,
        output_structured,
        validation_status,
        token_count,
        cost_usd,
        latency_ms,
        metadata,
        error_message,
        created_at,
        updated_at
      )
      VALUES (
        COALESCE($1::uuid, gen_random_uuid()),
        $2::uuid,
        $3,
        $4::uuid,
        $5,
        $6,
        $7,
        $8::text[],
        $9,
        $10::jsonb,
        $11,
        $12,
        $13,
        $14,
        $15::jsonb,
        $16,
        now(),
        now()
      )
      ON CONFLICT (organization_id, subject_type, subject_id)
      DO UPDATE SET
        status = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.status
          ELSE EXCLUDED.status
        END,
        model_used = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.model_used
          ELSE COALESCE(EXCLUDED.model_used, ai_analyses.model_used)
        END,
        prompt_version = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.prompt_version
          ELSE COALESCE(EXCLUDED.prompt_version, ai_analyses.prompt_version)
        END,
        input_evidence_ids = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.input_evidence_ids
          WHEN EXCLUDED.status = 'completed' THEN COALESCE(EXCLUDED.input_evidence_ids, '{}'::text[])
          WHEN cardinality(EXCLUDED.input_evidence_ids) > 0 THEN EXCLUDED.input_evidence_ids
          ELSE ai_analyses.input_evidence_ids
        END,
        output_text = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.output_text
          ELSE EXCLUDED.output_text
        END,
        output_structured = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.output_structured
          ELSE EXCLUDED.output_structured
        END,
        validation_status = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.validation_status
          ELSE EXCLUDED.validation_status
        END,
        token_count = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.token_count
          ELSE EXCLUDED.token_count
        END,
        cost_usd = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.cost_usd
          ELSE EXCLUDED.cost_usd
        END,
        latency_ms = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.latency_ms
          ELSE EXCLUDED.latency_ms
        END,
        metadata = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.metadata
          ELSE ai_analyses.metadata || EXCLUDED.metadata
        END,
        error_message = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.error_message
          ELSE EXCLUDED.error_message
        END,
        updated_at = CASE
          WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.updated_at
          ELSE now()
        END
      RETURNING *;
    `;

    const values = [
      input.id ?? null,
      input.organizationId,
      input.subjectType,
      input.subjectId,
      status,
      input.modelUsed ?? null,
      input.promptVersion ?? null,
      inputEvidenceIds,
      input.outputText ?? null,
      input.outputStructured ? JSON.stringify(input.outputStructured) : null,
      input.validationStatus ?? null,
      tokenCount,
      costUsd,
      latencyMs,
      JSON.stringify(metadata),
      input.errorMessage ?? null,
    ];

    const result = await client.query<AIAnalysisRow>(query, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to persist AIAnalysis record.");
    }

    return mapAIAnalysisRow(row);
  });
}

/**
 * Retrieves an AIAnalysis by ID within tenant scope.
 * Fails safely by returning null if not found or cross-tenant.
 */
export async function getAIAnalysisById(
  pool: pg.Pool,
  organizationId: string,
  id: string,
): Promise<AIAnalysis | null> {
  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new AIAnalysisValidationError("Invalid organization ID format. Must be a valid UUID.");
  }
  if (!id || !UUID_REGEX.test(id)) {
    throw new AIAnalysisValidationError("Invalid AI analysis ID format. Must be a valid UUID.");
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<AIAnalysisRow>(
      `
      SELECT *
      FROM ai_analyses
      WHERE id = $1::uuid AND organization_id = $2::uuid
      LIMIT 1;
      `,
      [id, organizationId],
    );

    const row = result.rows[0];
    return row ? mapAIAnalysisRow(row) : null;
  });
}

/**
 * Retrieves an AIAnalysis by subject within tenant scope.
 * Fails safely by returning null if not found or cross-tenant.
 */
export async function getAIAnalysisBySubject(
  pool: pg.Pool,
  organizationId: string,
  subjectType: AIAnalysisSubjectType,
  subjectId: string,
): Promise<AIAnalysis | null> {
  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw new AIAnalysisValidationError("Invalid organization ID format. Must be a valid UUID.");
  }
  if (!subjectId || !UUID_REGEX.test(subjectId)) {
    throw new AIAnalysisValidationError("Invalid subject ID format. Must be a valid UUID.");
  }
  if (!subjectType || !VALID_SUBJECT_TYPES.has(subjectType)) {
    throw new AIAnalysisValidationError(`Invalid subject type '${subjectType}'.`);
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<AIAnalysisRow>(
      `
      SELECT *
      FROM ai_analyses
      WHERE organization_id = $1::uuid
        AND subject_type = $2
        AND subject_id = $3::uuid
      LIMIT 1;
      `,
      [organizationId, subjectType, subjectId],
    );

    const row = result.rows[0];
    return row ? mapAIAnalysisRow(row) : null;
  });
}
