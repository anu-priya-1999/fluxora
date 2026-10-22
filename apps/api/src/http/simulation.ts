import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import {
  createScenario,
  createSimulation,
  executeSimulation,
  getPool,
  getScenarioById,
  getSimulationById,
  getUserById,
  listSimulationResults,
  provisionGithubUser,
  ScenarioNotFoundError,
  SimulationConvergenceError,
  SimulationEngineValidationError,
  SimulationNotFoundError,
  SimulationPersistenceValidationError,
  UnsupportedScenarioFailureTypeError,
  UserNotFoundError,
  withTenant,
} from "@fluxora/db";
import {
  isCanonicalGithubId,
  type Scenario,
  type Simulation,
  type User,
} from "@fluxora/shared-types";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
  type ClerkGithubIdentity,
} from "../auth/clerk.ts";
import { redactForLog } from "../github/redact.ts";
import {
  isUuid,
  parseCreateScenarioBody,
  parseRunScenarioBody,
  SimulationRequestValidationError,
} from "./simulation-request.ts";
import {
  formatScenarioResponse,
  formatSimulationResponse,
  formatSimulationResultsResponse,
} from "./simulation-response.ts";

const MAX_BODY_BYTES = 16384; // 16KB

export interface SimulationHandlerDependencies {
  authenticateClerkToken?: (authorization: string | undefined) => Promise<string>;
  getClerkGithubIdentity?: (clerkUserId: string) => Promise<ClerkGithubIdentity>;
  provisionGithubUser?: typeof provisionGithubUser;
  getUserById?: typeof getUserById;
  createScenario?: typeof createScenario;
  getScenarioById?: typeof getScenarioById;
  createSimulation?: typeof createSimulation;
  getSimulationById?: typeof getSimulationById;
  executeSimulation?: typeof executeSimulation;
  listSimulationResults?: typeof listSimulationResults;
  resolveAnalysisRunAndRepo?: (
    pool: pg.Pool,
    organizationId: string,
    analysisRunId: string,
  ) => Promise<{ repositoryId: string } | null>;
  verifyTargetNodeInAnalysisRun?: (
    pool: pg.Pool,
    organizationId: string,
    analysisRunId: string,
    targetNodeId: string,
  ) => Promise<boolean>;
  resolveTargetNodeAnalysisRun?: (
    pool: pg.Pool,
    organizationId: string,
    repositoryId: string,
    targetNodeId: string,
  ) => Promise<{ analysisRunId: string } | null>;
  pool?: pg.Pool;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "PayloadTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Default Database Resolvers
// ---------------------------------------------------------------------------

export async function defaultResolveAnalysisRunAndRepo(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
): Promise<{ repositoryId: string } | null> {
  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<{ repository_id: string }>(
      `SELECT rs.repository_id
       FROM analysis_runs ar
       JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
       JOIN repositories r ON r.id = rs.repository_id
       WHERE ar.id = $1::uuid AND r.organization_id = $2::uuid`,
      [analysisRunId, organizationId],
    );
    const row = res.rows[0];
    return row ? { repositoryId: row.repository_id } : null;
  });
}

export async function defaultVerifyTargetNodeInAnalysisRun(
  pool: pg.Pool,
  organizationId: string,
  analysisRunId: string,
  targetNodeId: string,
): Promise<boolean> {
  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT gn.id
       FROM graph_nodes gn
       JOIN analysis_runs ar ON ar.id = gn.analysis_run_id
       JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
       JOIN repositories r ON r.id = rs.repository_id
       WHERE gn.id = $1::uuid AND ar.id = $2::uuid AND r.organization_id = $3::uuid`,
      [targetNodeId, analysisRunId, organizationId],
    );
    return res.rows.length > 0;
  });
}

export async function defaultResolveTargetNodeAnalysisRun(
  pool: pg.Pool,
  organizationId: string,
  repositoryId: string,
  targetNodeId: string,
): Promise<{ analysisRunId: string } | null> {
  return withTenant(pool, organizationId, async (client) => {
    const res = await client.query<{ analysis_run_id: string }>(
      `SELECT ar.id AS analysis_run_id
       FROM graph_nodes gn
       JOIN analysis_runs ar ON ar.id = gn.analysis_run_id
       JOIN repository_snapshots rs ON rs.id = ar.snapshot_id
       JOIN repositories r ON r.id = rs.repository_id
       WHERE gn.id = $1::uuid AND r.id = $2::uuid AND r.organization_id = $3::uuid
       ORDER BY ar.created_at DESC
       LIMIT 1`,
      [targetNodeId, repositoryId, organizationId],
    );
    const row = res.rows[0];
    return row ? { analysisRunId: row.analysis_run_id } : null;
  });
}

// ---------------------------------------------------------------------------
// Endpoint A — Create a Scenario (POST /scenarios)
// ---------------------------------------------------------------------------

export async function handleCreateScenario(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: SimulationHandlerDependencies,
): Promise<void> {
  // 1. Content-Type check
  const contentType = headerValue(req.headers["content-type"]);
  const hasContentType =
    contentType !== undefined && contentType.trim().length > 0;
  if (
    hasContentType &&
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    sendJson(res, 415, {
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
    });
    return;
  }

  // 2. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 3. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 4. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      sendJson(res, 403, {
        error: {
          code: "tenant_session_rejected",
          message: "The account could not be loaded for this organization.",
        },
      });
      return;
    }
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 5. Read and parse request body
  let parsedInput: ReturnType<typeof parseCreateScenarioBody>;
  try {
    const rawBody = await readJsonBody(req);
    parsedInput = parseCreateScenarioBody(rawBody);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, {
        error: {
          code: "payload_too_large",
          message: "Request body is too large.",
        },
      });
      return;
    }

    if (error instanceof SimulationRequestValidationError) {
      sendJson(res, error.statusCode, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    sendJson(res, 400, {
      error: {
        code: "invalid_json",
        message:
          error instanceof Error ? error.message : "Request body must be JSON.",
      },
    });
    return;
  }

  // 6. Tenant-scoping, analysis run, and repository resolution
  const resolveRunRepo =
    deps?.resolveAnalysisRunAndRepo ?? defaultResolveAnalysisRunAndRepo;
  const verifyNodeInRun =
    deps?.verifyTargetNodeInAnalysisRun ?? defaultVerifyTargetNodeInAnalysisRun;
  const resolveTargetRun =
    deps?.resolveTargetNodeAnalysisRun ?? defaultResolveTargetNodeAnalysisRun;
  const createScen = deps?.createScenario ?? createScenario;

  let effectiveRepositoryId = parsedInput.repositoryId;

  try {
    if (parsedInput.analysisRunId !== undefined) {
      const resolved = await resolveRunRepo(
        pool,
        user.organizationId,
        parsedInput.analysisRunId,
      );

      if (resolved === null) {
        sendJson(res, 404, {
          error: {
            code: "analysis_snapshot_unavailable",
            message:
              "Analysis run not found or does not belong to this organization.",
          },
        });
        return;
      }

      if (
        effectiveRepositoryId !== undefined &&
        effectiveRepositoryId !== resolved.repositoryId
      ) {
        sendJson(res, 400, {
          error: {
            code: "invalid_request",
            message:
              "Specified repository_id does not match the analysis run repository.",
          },
        });
        return;
      }

      effectiveRepositoryId = resolved.repositoryId;

      // Verify target node belongs to this specific analysis run
      const nodeInRun = await verifyNodeInRun(
        pool,
        user.organizationId,
        parsedInput.analysisRunId,
        parsedInput.targetNodeId,
      );

      if (!nodeInRun) {
        sendJson(res, 400, {
          error: {
            code: "invalid_request",
            message:
              "Target node does not belong to the specified analysis run.",
          },
        });
        return;
      }
    } else if (effectiveRepositoryId !== undefined) {
      // Verify target node exists in this repository
      const resolvedRun = await resolveTargetRun(
        pool,
        user.organizationId,
        effectiveRepositoryId,
        parsedInput.targetNodeId,
      );

      if (resolvedRun === null) {
        sendJson(res, 400, {
          error: {
            code: "invalid_request",
            message: "Target node does not exist in the specified repository.",
          },
        });
        return;
      }
    }

    if (!effectiveRepositoryId) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: "Either repository_id or analysis_run_id is required.",
        },
      });
      return;
    }

    // Preserve analysis_run_id in scenario parameters if provided
    const parameters = {
      ...(parsedInput.parameters ?? {}),
      ...(parsedInput.analysisRunId !== undefined
        ? { analysis_run_id: parsedInput.analysisRunId }
        : {}),
    };

    const scenario = await createScen(pool, {
      organizationId: user.organizationId,
      repositoryId: effectiveRepositoryId,
      name: parsedInput.name,
      targetNodeId: parsedInput.targetNodeId,
      failureType: parsedInput.failureType,
      parameters,
      createdBy: user.id,
    });

    sendJson(res, 201, formatScenarioResponse(scenario));
  } catch (error) {
    if (error instanceof SimulationPersistenceValidationError) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof UnsupportedScenarioFailureTypeError) {
      sendJson(res, 400, {
        error: {
          code: "unsupported_failure_type",
          message: error.message,
        },
      });
      return;
    }

    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Endpoint B — Run a Scenario (POST /scenarios/:id/run)
// ---------------------------------------------------------------------------

export async function handleRunScenario(
  req: IncomingMessage,
  res: ServerResponse,
  scenarioId: string,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: SimulationHandlerDependencies,
): Promise<void> {
  // 1. Content-Type check (if body is provided)
  const contentType = headerValue(req.headers["content-type"]);
  const hasContentType =
    contentType !== undefined && contentType.trim().length > 0;
  if (
    hasContentType &&
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    sendJson(res, 415, {
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
    });
    return;
  }

  // 2. Validate scenarioId format
  if (!isUuid(scenarioId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Invalid scenario ID format. Must be a valid UUID.",
      },
    });
    return;
  }

  // 3. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 4. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 5. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      sendJson(res, 403, {
        error: {
          code: "tenant_session_rejected",
          message: "The account could not be loaded for this organization.",
        },
      });
      return;
    }
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 6. Read optional request body
  let parsedInput: ReturnType<typeof parseRunScenarioBody> = {};
  try {
    const rawBody = await readOptionalJsonBody(req);
    parsedInput = parseRunScenarioBody(rawBody);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, {
        error: {
          code: "payload_too_large",
          message: "Request body is too large.",
        },
      });
      return;
    }

    if (error instanceof SimulationRequestValidationError) {
      sendJson(res, error.statusCode, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    sendJson(res, 400, {
      error: {
        code: "invalid_json",
        message:
          error instanceof Error ? error.message : "Request body must be JSON.",
      },
    });
    return;
  }

  // 7. Load scenario within tenant boundary
  const getScen = deps?.getScenarioById ?? getScenarioById;
  const resolveRunRepo =
    deps?.resolveAnalysisRunAndRepo ?? defaultResolveAnalysisRunAndRepo;
  const verifyNodeInRun =
    deps?.verifyTargetNodeInAnalysisRun ?? defaultVerifyTargetNodeInAnalysisRun;
  const resolveTargetRun =
    deps?.resolveTargetNodeAnalysisRun ?? defaultResolveTargetNodeAnalysisRun;
  const createSim = deps?.createSimulation ?? createSimulation;
  const execSim = deps?.executeSimulation ?? executeSimulation;

  let scenario: Scenario | null;
  try {
    scenario = await getScen(pool, user.organizationId, scenarioId);
  } catch (error) {
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  if (scenario === null) {
    sendJson(res, 404, {
      error: {
        code: "not_found",
        message: "Scenario not found.",
      },
    });
    return;
  }

  // 8. Validate MVP supported failure types (unavailable | latency)
  if (
    scenario.failureType !== "unavailable" &&
    scenario.failureType !== "latency"
  ) {
    sendJson(res, 400, {
      error: {
        code: "unsupported_failure_type",
        message: `Unsupported scenario failure type: "${scenario.failureType}". MVP simulation engine only supports "unavailable" and "latency".`,
      },
    });
    return;
  }

  // 9. Resolve target analysis run ID
  let targetAnalysisRunId = parsedInput.analysisRunId;

  if (targetAnalysisRunId !== undefined) {
    // Validate that caller-supplied analysis run belongs to the scenario's repository
    const runRepo = await resolveRunRepo(
      pool,
      user.organizationId,
      targetAnalysisRunId,
    );
    if (runRepo === null || runRepo.repositoryId !== scenario.repositoryId) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: "Analysis run does not belong to the scenario's repository.",
        },
      });
      return;
    }

    // Verify target node belongs to this specific analysis run
    const nodeInRun = await verifyNodeInRun(
      pool,
      user.organizationId,
      targetAnalysisRunId,
      scenario.targetNodeId,
    );
    if (!nodeInRun) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message:
            "Scenario target node does not belong to the specified analysis run.",
        },
      });
      return;
    }
  } else {
    // Try scenario.parameters.analysis_run_id first
    const paramRunId =
      scenario.parameters["analysis_run_id"] ??
      scenario.parameters["analysisRunId"];
    if (typeof paramRunId === "string" && isUuid(paramRunId)) {
      const nodeInRun = await verifyNodeInRun(
        pool,
        user.organizationId,
        paramRunId,
        scenario.targetNodeId,
      );
      if (nodeInRun) {
        targetAnalysisRunId = paramRunId;
      }
    }

    // If not found in parameters, resolve the target node's latest analysis run
    if (targetAnalysisRunId === undefined) {
      const resolved = await resolveTargetRun(
        pool,
        user.organizationId,
        scenario.repositoryId,
        scenario.targetNodeId,
      );
      if (resolved === null) {
        sendJson(res, 404, {
          error: {
            code: "analysis_snapshot_unavailable",
            message:
              "Analysis run not found for the scenario's target node in this repository.",
          },
        });
        return;
      }
      targetAnalysisRunId = resolved.analysisRunId;
    }
  }

  // 10. Create simulation record and execute synchronously
  let simulation: Simulation;
  try {
    simulation = await createSim(pool, user.organizationId, {
      scenarioId,
      analysisRunId: targetAnalysisRunId,
      status: "pending",
    });
  } catch (error) {
    if (error instanceof ScenarioNotFoundError) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Scenario not found.",
        },
      });
      return;
    }

    if (error instanceof SimulationPersistenceValidationError) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }

    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 11. Execute Simulation Engine
  try {
    const execResult = await execSim(pool, user.organizationId, simulation.id);

    sendJson(
      res,
      200,
      formatSimulationResponse(
        execResult.simulation,
        execResult.savedResults,
        {
          converged: execResult.engineResult.converged,
          iterations: execResult.engineResult.iterations,
        },
      ),
    );
  } catch (error) {
    if (error instanceof ScenarioNotFoundError) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Scenario not found.",
        },
      });
      return;
    }

    if (error instanceof SimulationNotFoundError) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Simulation not found.",
        },
      });
      return;
    }

    if (error instanceof UnsupportedScenarioFailureTypeError) {
      sendJson(res, 400, {
        error: {
          code: "unsupported_failure_type",
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof SimulationEngineValidationError) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof SimulationPersistenceValidationError) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof SimulationConvergenceError) {
      sendJson(res, 422, {
        error: {
          code: "simulation_convergence_failure",
          message: error.message,
        },
      });
      return;
    }

    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Endpoint C — Retrieve a Simulation (GET /simulations/:id)
// ---------------------------------------------------------------------------

export async function handleGetSimulation(
  req: IncomingMessage,
  res: ServerResponse,
  simulationId: string,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: SimulationHandlerDependencies,
): Promise<void> {
  // 1. Validate simulationId format
  if (!isUuid(simulationId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Invalid simulation ID format. Must be a valid UUID.",
      },
    });
    return;
  }

  // 2. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 3. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 4. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      sendJson(res, 403, {
        error: {
          code: "tenant_session_rejected",
          message: "The account could not be loaded for this organization.",
        },
      });
      return;
    }
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 5. Look up persisted Simulation (tenant-scoped)
  const getSim = deps?.getSimulationById ?? getSimulationById;
  const listResults = deps?.listSimulationResults ?? listSimulationResults;

  try {
    const simulation = await getSim(pool, user.organizationId, simulationId);

    if (simulation === null) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Simulation not found.",
        },
      });
      return;
    }

    const results = await listResults(pool, user.organizationId, simulationId);
    sendJson(res, 200, formatSimulationResponse(simulation, results));
  } catch (error) {
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Endpoint D — Retrieve Simulation Results (GET /simulations/:id/results)
// ---------------------------------------------------------------------------

export async function handleGetSimulationResults(
  req: IncomingMessage,
  res: ServerResponse,
  simulationId: string,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: SimulationHandlerDependencies,
): Promise<void> {
  // 1. Validate simulationId format
  if (!isUuid(simulationId)) {
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: "Invalid simulation ID format. Must be a valid UUID.",
      },
    });
    return;
  }

  // 2. Authenticate request using Bearer JWT
  const verifyClerk = deps?.authenticateClerkToken ?? authenticateClerkToken;
  const getIdentity = deps?.getClerkGithubIdentity ?? getClerkGithubIdentity;
  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 3. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 4. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      sendJson(res, 403, {
        error: {
          code: "tenant_session_rejected",
          message: "The account could not be loaded for this organization.",
        },
      });
      return;
    }
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 5. Verify simulation exists within tenant boundary
  const getSim = deps?.getSimulationById ?? getSimulationById;
  const listResults = deps?.listSimulationResults ?? listSimulationResults;

  try {
    const simulation = await getSim(pool, user.organizationId, simulationId);

    if (simulation === null) {
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Simulation not found.",
        },
      });
      return;
    }

    const results = await listResults(pool, user.organizationId, simulationId);

    sendJson(
      res,
      200,
      formatSimulationResultsResponse(simulationId, results),
    );
  } catch (error) {
    logUnexpectedSimulationError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Body Readers and Helpers
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new SimulationRequestValidationError(
      "Request body is required.",
      "invalid_request",
      400,
    );
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    throw new SimulationRequestValidationError(
      "Request body is required.",
      "invalid_request",
      400,
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SimulationRequestValidationError(
      "Request body must be valid JSON.",
      "invalid_json",
      400,
    );
  }
}

async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SimulationRequestValidationError(
      "Request body must be valid JSON.",
      "invalid_json",
      400,
    );
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function logUnexpectedSimulationError(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("simulation api error");
    return;
  }

  const message = redactForLog(error.message);
  console.error(message.length === 0 ? error.name : message);
}
