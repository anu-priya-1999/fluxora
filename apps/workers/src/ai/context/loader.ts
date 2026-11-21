/**
 * @file loader.ts
 * Tenant-scoped context loader for impact explanation.
 *
 * Retrieves persisted ImpactAnalysis and associated Evidence records using
 * existing tenant-scoped repository functions, verifies completion status,
 * and delegates to the pure context assembler.
 */

import {
  getImpactAnalysisById,
  getPool,
  listImpactFindingEvidence,
} from "@fluxora/db";
import type { EvidenceRecord, ImpactAnalysis } from "@fluxora/shared-types";

import { assembleImpactExplanationContext } from "./assembler.ts";
import {
  ImpactExplanationContextError,
  type ContextLimits,
  type ImpactExplanationContext,
} from "./types.ts";

export type DatabasePool = ReturnType<typeof getPool>;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pluggable repository interface enabling offline unit testing without live PostgreSQL.
 */
export interface ImpactExplanationRepository {
  getImpactAnalysisById(
    pool: DatabasePool,
    organizationId: string,
    impactAnalysisId: string,
  ): Promise<ImpactAnalysis | null>;
  listImpactFindingEvidence(
    pool: DatabasePool,
    organizationId: string,
    impactAnalysisId: string,
  ): Promise<EvidenceRecord[]>;
}

export const defaultImpactExplanationRepository: ImpactExplanationRepository = {
  getImpactAnalysisById,
  listImpactFindingEvidence,
};

export interface LoadImpactExplanationContextOptions {
  readonly pool: DatabasePool;
  readonly organizationId: string;
  readonly impactAnalysisId: string;
  readonly limits?: Partial<ContextLimits> | undefined;
  readonly repository?: ImpactExplanationRepository | undefined;
}

/**
 * Loads a completed ImpactAnalysis and its associated evidence records within tenant scope
 * and produces a minimal, bounded ImpactExplanationContext.
 *
 * Fails safely with not_found if the record does not exist or belongs to another tenant.
 * Fails with not_completed if the analysis is pending, running, or failed.
 */
export async function loadImpactExplanationContext(
  options: LoadImpactExplanationContextOptions,
): Promise<ImpactExplanationContext> {
  const { pool, organizationId, impactAnalysisId, limits } = options;
  const repo = options.repository ?? defaultImpactExplanationRepository;

  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw ImpactExplanationContextError.invalidInput(
      "organizationId must be a valid UUID string.",
    );
  }

  if (!impactAnalysisId || !UUID_REGEX.test(impactAnalysisId)) {
    throw ImpactExplanationContextError.invalidInput(
      "impactAnalysisId must be a valid UUID string.",
    );
  }

  let analysis: ImpactAnalysis | null;
  try {
    analysis = await repo.getImpactAnalysisById(
      pool,
      organizationId,
      impactAnalysisId,
    );
  } catch (error) {
    if (error instanceof ImpactExplanationContextError) {
      throw error;
    }
    throw ImpactExplanationContextError.notFound(
      `Failed to retrieve impact analysis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!analysis) {
    // Fail safely without disclosing whether another organization owns this ID
    throw ImpactExplanationContextError.notFound(
      `Impact analysis ${impactAnalysisId} not found or inaccessible.`,
    );
  }

  if (analysis.status !== "completed") {
    throw ImpactExplanationContextError.notCompleted(
      `Impact analysis ${impactAnalysisId} has status '${analysis.status}', but must be 'completed' for explanation generation.`,
    );
  }

  let evidenceRecords: EvidenceRecord[];
  try {
    evidenceRecords = await repo.listImpactFindingEvidence(
      pool,
      organizationId,
      impactAnalysisId,
    );
  } catch (error) {
    if (error instanceof ImpactExplanationContextError) {
      throw error;
    }
    throw ImpactExplanationContextError.notFound(
      `Failed to retrieve impact finding evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return assembleImpactExplanationContext({
    analysis,
    evidenceRecords,
    limits,
  });
}
