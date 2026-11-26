/**
 * @file loader.ts
 * Tenant-scoped context loader for simulation narration (Phase 9 Step 63).
 *
 * Retrieves persisted Simulation, Scenario, SimulationResults, and simulation_state
 * Evidence using tenant-scoped repository functions, verifies completion status,
 * and delegates to the pure context assembler.
 */

import {
  getScenarioById,
  getSimulationById,
  listSimulationEvidence,
  listSimulationResults,
} from "@fluxora/db";
import type {
  EvidenceRecord,
  Scenario,
  Simulation,
  SimulationResult,
} from "@fluxora/shared-types";

import { assembleSimulationNarrationContext } from "./assembler.ts";
import {
  SimulationNarrationContextError,
  type SimulationContextLimits,
  type SimulationNarrationContext,
} from "./types.ts";

import type { DatabasePool } from "../context/index.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SimulationNarrationRepository {
  getSimulationById(
    pool: DatabasePool,
    organizationId: string,
    simulationId: string,
  ): Promise<Simulation | null>;
  getScenarioById(
    pool: DatabasePool,
    organizationId: string,
    scenarioId: string,
  ): Promise<Scenario | null>;
  listSimulationResults(
    pool: DatabasePool,
    organizationId: string,
    simulationId: string,
  ): Promise<SimulationResult[]>;
  listSimulationEvidence(
    pool: DatabasePool,
    organizationId: string,
    simulationId: string,
  ): Promise<EvidenceRecord[]>;
}

export const defaultSimulationNarrationRepository: SimulationNarrationRepository = {
  getSimulationById,
  getScenarioById,
  listSimulationResults,
  listSimulationEvidence,
};

export interface LoadSimulationNarrationContextOptions {
  readonly pool: DatabasePool;
  readonly organizationId: string;
  readonly simulationId: string;
  readonly limits?: Partial<SimulationContextLimits> | undefined;
  readonly repository?: SimulationNarrationRepository | undefined;
}

/**
 * Loads a completed Simulation and its associated scenario, results, and evidence within tenant scope,
 * and produces a minimal, bounded SimulationNarrationContext.
 *
 * Fails safely with not_found if the simulation or scenario does not exist or belongs to another tenant.
 * Fails with not_completed if the simulation is pending, running, or failed.
 */
export async function loadSimulationNarrationContext(
  options: LoadSimulationNarrationContextOptions,
): Promise<SimulationNarrationContext> {
  const { pool, organizationId, simulationId, limits } = options;
  const repo = options.repository ?? defaultSimulationNarrationRepository;

  if (!organizationId || !UUID_REGEX.test(organizationId)) {
    throw SimulationNarrationContextError.invalidInput(
      "organizationId must be a valid UUID string.",
    );
  }

  if (!simulationId || !UUID_REGEX.test(simulationId)) {
    throw SimulationNarrationContextError.invalidInput(
      "simulationId must be a valid UUID string.",
    );
  }

  let simulation: Simulation | null;
  try {
    simulation = await repo.getSimulationById(pool, organizationId, simulationId);
  } catch (error) {
    if (error instanceof SimulationNarrationContextError) {
      throw error;
    }
    throw SimulationNarrationContextError.notFound(
      `Failed to retrieve simulation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!simulation) {
    throw SimulationNarrationContextError.notFound(
      `Simulation ${simulationId} not found or inaccessible.`,
    );
  }

  if (simulation.status !== "completed") {
    throw SimulationNarrationContextError.notCompleted(
      `Simulation ${simulationId} has status '${simulation.status}', but must be 'completed' for narration generation.`,
    );
  }

  let scenario: Scenario | null;
  try {
    scenario = await repo.getScenarioById(pool, organizationId, simulation.scenarioId);
  } catch (error) {
    if (error instanceof SimulationNarrationContextError) {
      throw error;
    }
    throw SimulationNarrationContextError.notFound(
      `Failed to retrieve scenario: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!scenario) {
    throw SimulationNarrationContextError.notFound(
      `Scenario ${simulation.scenarioId} for simulation ${simulationId} not found or inaccessible.`,
    );
  }

  let results: SimulationResult[];
  try {
    results = await repo.listSimulationResults(pool, organizationId, simulationId);
  } catch (error) {
    if (error instanceof SimulationNarrationContextError) {
      throw error;
    }
    throw SimulationNarrationContextError.notFound(
      `Failed to retrieve simulation results: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let evidenceRecords: EvidenceRecord[];
  try {
    evidenceRecords = await repo.listSimulationEvidence(pool, organizationId, simulationId);
  } catch (error) {
    if (error instanceof SimulationNarrationContextError) {
      throw error;
    }
    throw SimulationNarrationContextError.notFound(
      `Failed to retrieve simulation evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return assembleSimulationNarrationContext({
    simulation,
    scenario,
    results,
    evidenceRecords,
    limits,
  });
}
