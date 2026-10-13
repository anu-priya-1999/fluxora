import {
  getPool,
  getRepositoryById,
  getUserById,
  listAnalysisRuns,
  listGraphNodes,
  listRepositorySnapshots,
  provisionGithubUser,
} from "@fluxora/db";
import type { AnalysisRun, GraphNode, GraphNodeType } from "@fluxora/shared-types";
import type { ResolvedAnalysisContext, ResolveAnalysisContextResult } from "./explorer-data";

export interface ClerkUserServerIdentity {
  readonly clerkUserId: string;
  readonly numericGithubId?: number | undefined;
  readonly email?: string | undefined;
  readonly organizationName?: string | undefined;
}

export interface ResolveAnalysisContextServerDependencies {
  readonly getPool?: typeof getPool;
  readonly provisionGithubUser?: typeof provisionGithubUser;
  readonly getUserById?: typeof getUserById;
  readonly getRepositoryById?: typeof getRepositoryById;
  readonly listRepositorySnapshots?: typeof listRepositorySnapshots;
  readonly listAnalysisRuns?: typeof listAnalysisRuns;
  readonly listGraphNodes?: typeof listGraphNodes;
}

const ROOT_PREFERRED_NODE_TYPES: readonly GraphNodeType[] = [
  "application",
  "service",
  "package",
  "module",
];

/**
 * Resolves repository and latest usable analysis context on the server using existing DB repositories and tenant RLS.
 */
export async function resolveRepositoryAnalysisContextServer(
  identity: ClerkUserServerIdentity,
  repositoryId: string,
  deps: ResolveAnalysisContextServerDependencies = {},
): Promise<ResolveAnalysisContextResult> {
  const pool = (deps.getPool ?? getPool)();
  const provision = deps.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps.getUserById ?? getUserById;
  const getRepo = deps.getRepositoryById ?? getRepositoryById;
  const listSnapshots = deps.listRepositorySnapshots ?? listRepositorySnapshots;
  const listRuns = deps.listAnalysisRuns ?? listAnalysisRuns;
  const listNodes = deps.listGraphNodes ?? listGraphNodes;

  if (identity.numericGithubId === undefined || !Number.isSafeInteger(identity.numericGithubId)) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "A connected GitHub account is required.",
    };
  }

  let organizationId: string;
  try {
    const provisioned = await provision(pool, {
      githubUserId: identity.numericGithubId,
      email: identity.email ?? "user@fluxora.internal",
      organizationName: identity.organizationName ?? "Fluxora Organization",
    });

    const user = await getUser(pool, provisioned.organizationId, provisioned.id);
    organizationId = user.organizationId;
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "The account could not be loaded for this organization.",
    };
  }

  // 1. Resolve repository
  const repository = await getRepo(pool, organizationId, repositoryId);
  if (!repository) {
    return {
      ok: false,
      reason: "repository_not_found",
      message: "Repository not found or access denied.",
    };
  }

  // 2. Resolve snapshots ordered by created_at DESC
  const snapshots = await listSnapshots(pool, organizationId, repository.id);
  if (snapshots.length === 0) {
    return {
      ok: false,
      reason: "analysis_not_ready",
      message: "No snapshots or analysis runs found for this repository. Analysis is not ready yet.",
    };
  }

  // 3. Find latest usable (completed) analysis run across snapshots
  let targetAnalysisRunId: string | null = null;
  for (const snapshot of snapshots) {
    const runs = await listRuns(pool, organizationId, snapshot.id);
    const completedRun = runs.find((r: AnalysisRun) => r.status === "completed");
    if (completedRun) {
      targetAnalysisRunId = completedRun.id;
      break;
    }
  }

  if (!targetAnalysisRunId) {
    return {
      ok: false,
      reason: "analysis_not_ready",
      message: "Graph analysis is not completed yet for this repository.",
    };
  }

  // 4. Resolve a deterministic start node from existing graph nodes
  const nodes = await listNodes(pool, organizationId, targetAnalysisRunId);
  if (nodes.length === 0) {
    return {
      ok: false,
      reason: "analysis_not_ready",
      message: "The analysis run contains no graph nodes.",
    };
  }

  // Find preferred top-level node type (application -> service -> package -> module) or first node
  let startNode = nodes[0];
  for (const preferredType of ROOT_PREFERRED_NODE_TYPES) {
    const candidate = nodes.find((n: GraphNode) => n.nodeType === preferredType);
    if (candidate) {
      startNode = candidate;
      break;
    }
  }

  const context: ResolvedAnalysisContext = {
    repositoryId: repository.id,
    repositoryName: repository.name,
    analysisRunId: targetAnalysisRunId,
    defaultStartNodeId: startNode!.id,
  };

  return {
    ok: true,
    context,
  };
}
