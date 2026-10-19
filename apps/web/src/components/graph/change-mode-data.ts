import type {
  GraphQueryResponseEvidence,
  ImpactAnalysisFindingResponse,
  ImpactAnalysisResponse,
  ImpactAnalysisStatus,
  ImpactAnalysisUnresolvedFileResponse,
} from "@fluxora/shared-types";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChangeModeStatus = "idle" | "loading" | "ready" | "empty" | "error";

export type ImpactFindingRole = "direct" | "downstream" | "unaffected";

/**
 * Normalized, performance-optimized in-memory representation of an active change mode (Step 46).
 *
 * Uses Sets and Maps to provide O(1) lookups during React Flow graph rendering,
 * avoiding O(nodes * findings) iteration on every render, pan, or zoom frame.
 */
export interface NormalizedChangeModeState {
  readonly enabled: boolean;
  readonly pullRequestId: string | null;
  readonly impactAnalysisId: string | null;
  readonly headCommit?: string | null | undefined;
  readonly status: ChangeModeStatus;
  readonly executionStatus?: ImpactAnalysisStatus | undefined;
  readonly directNodeIds: ReadonlySet<string>;
  readonly downstreamNodeIds: ReadonlySet<string>;
  readonly affectedApiNodeIds: ReadonlySet<string>;
  readonly affectedEventNodeIds: ReadonlySet<string>;
  readonly hopDistanceByNodeId: ReadonlyMap<string, number>;
  readonly confidenceByNodeId: ReadonlyMap<string, number>;
  readonly evidenceIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  readonly evidence?: readonly GraphQueryResponseEvidence[] | undefined;
  readonly evidenceById: ReadonlyMap<string, GraphQueryResponseEvidence>;
  readonly directImpactFindings: readonly ImpactAnalysisFindingResponse[];
  readonly downstreamImpactFindings: readonly ImpactAnalysisFindingResponse[];
  readonly affectedApiFindings: readonly ImpactAnalysisFindingResponse[];
  readonly affectedEventFindings: readonly ImpactAnalysisFindingResponse[];
  readonly affectedServiceFindings: readonly ImpactAnalysisFindingResponse[];
  readonly directCount: number;
  readonly downstreamCount: number;
  readonly affectedApiCount: number;
  readonly affectedEventCount: number;
  readonly unresolvedFiles: readonly ImpactAnalysisUnresolvedFileResponse[];
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  readonly maxDepthReached: number;
  readonly errorMessage: string | null;
}

export const DEFAULT_CHANGE_MODE_STATE: NormalizedChangeModeState = {
  enabled: false,
  pullRequestId: null,
  impactAnalysisId: null,
  headCommit: null,
  status: "idle",
  directNodeIds: new Set(),
  downstreamNodeIds: new Set(),
  affectedApiNodeIds: new Set(),
  affectedEventNodeIds: new Set(),
  hopDistanceByNodeId: new Map(),
  confidenceByNodeId: new Map(),
  evidenceIdsByNodeId: new Map(),
  evidence: [],
  evidenceById: new Map(),
  directImpactFindings: [],
  downstreamImpactFindings: [],
  affectedApiFindings: [],
  affectedEventFindings: [],
  affectedServiceFindings: [],
  directCount: 0,
  downstreamCount: 0,
  affectedApiCount: 0,
  affectedEventCount: 0,
  unresolvedFiles: [],
  truncated: false,
  truncationReason: null,
  maxDepthReached: 0,
  errorMessage: null,
};

/**
 * Metrics tracking how many impacted nodes from the analysis result are present
 * in the currently loaded graph slice (LOD / filter slice).
 */
export interface ImpactSliceMetrics {
  readonly totalImpactedNodes: number;
  readonly visibleImpactedNodes: number;
  readonly hiddenImpactedNodes: number;
  readonly missingFromSliceCount: number;
}

/**
 * Computes visibility metrics between normalized change-mode findings and visible graph nodes.
 *
 * Deterministic: Does not fabricate synthetic nodes.
 */
export function computeImpactSliceMetrics(
  changeMode: NormalizedChangeModeState,
  visibleNodes: readonly { id: string }[],
): ImpactSliceMetrics {
  if (!changeMode.enabled || changeMode.status !== "ready") {
    return {
      totalImpactedNodes: 0,
      visibleImpactedNodes: 0,
      hiddenImpactedNodes: 0,
      missingFromSliceCount: 0,
    };
  }

  const visibleIdSet = new Set(visibleNodes.map((n) => n.id));
  const allImpactedIds = new Set<string>([
    ...changeMode.directNodeIds,
    ...changeMode.downstreamNodeIds,
  ]);

  let visibleCount = 0;
  for (const id of allImpactedIds) {
    if (visibleIdSet.has(id)) {
      visibleCount += 1;
    }
  }

  const total = allImpactedIds.size;
  const missing = Math.max(0, total - visibleCount);

  return {
    totalImpactedNodes: total,
    visibleImpactedNodes: visibleCount,
    hiddenImpactedNodes: missing,
    missingFromSliceCount: missing,
  };
}

/**
 * Transforms an API ImpactAnalysisResponse into a normalized, lookup-optimized view model.
 *
 * Guarantees:
 * - Deterministic output.
 * - Handles duplicate node IDs:
 *   - Direct impact takes precedence over downstream.
 *   - For multiple downstream paths to the same node, the shallowest hop distance is retained.
 *   - Lowest hop distance wins; on tie, highest confidence wins.
 *   - Evidence IDs are combined, deduplicated, and sorted lexicographically.
 * - Categorizes affected APIs and events into distinct Sets.
 * - Never fabricates fake graph nodes.
 */
export function normalizeImpactAnalysisResponse(
  response: ImpactAnalysisResponse,
  options: { enabled?: boolean } = {},
): NormalizedChangeModeState {
  const enabled = options.enabled ?? true;

  const directNodeIds = new Set<string>();
  const downstreamNodeIds = new Set<string>();
  const affectedApiNodeIds = new Set<string>();
  const affectedEventNodeIds = new Set<string>();

  const hopDistanceByNodeId = new Map<string, number>();
  const confidenceByNodeId = new Map<string, number>();
  const evidenceMap = new Map<string, Set<string>>();

  function addEvidence(nodeId: string, finding: ImpactAnalysisFindingResponse): void {
    let set = evidenceMap.get(nodeId);
    if (!set) {
      set = new Set<string>();
      evidenceMap.set(nodeId, set);
    }
    if (finding.evidence_ids && Array.isArray(finding.evidence_ids)) {
      for (const ev of finding.evidence_ids) {
        if (ev && typeof ev === "string") {
          set.add(ev);
        }
      }
    }
    if (finding.evidence_id && typeof finding.evidence_id === "string") {
      set.add(finding.evidence_id);
    }
  }

  // 1. Process direct impacts first (highest priority)
  // Sort direct findings deterministically by node_id
  const sortedDirect = (response.direct_impact ?? [])
    .slice()
    .sort((a, b) => a.node_id.localeCompare(b.node_id));

  for (const finding of sortedDirect) {
    const nodeId = finding.node_id;
    directNodeIds.add(nodeId);
    hopDistanceByNodeId.set(nodeId, 0);

    const existingConf = confidenceByNodeId.get(nodeId);
    const newConf = typeof finding.confidence === "number" ? finding.confidence : 1.0;
    confidenceByNodeId.set(
      nodeId,
      existingConf !== undefined ? Math.max(existingConf, newConf) : newConf,
    );

    addEvidence(nodeId, finding);
  }

  // 2. Process downstream impacts
  // Sort downstream findings deterministically by depth ASC, confidence DESC, node_id ASC
  const sortedDownstream = (response.downstream_impact ?? [])
    .slice()
    .sort((a, b) => {
      const depthA = a.hop_distance ?? a.depth ?? 1;
      const depthB = b.hop_distance ?? b.depth ?? 1;
      if (depthA !== depthB) return depthA - depthB;
      const confA = a.confidence ?? 1.0;
      const confB = b.confidence ?? 1.0;
      if (confA !== confB) return confB - confA;
      return a.node_id.localeCompare(b.node_id);
    });

  for (const finding of sortedDownstream) {
    const nodeId = finding.node_id;
    addEvidence(nodeId, finding);

    // If node is already in direct impacts, direct classification takes precedence
    if (directNodeIds.has(nodeId)) {
      continue;
    }

    downstreamNodeIds.add(nodeId);

    const hop = finding.hop_distance ?? finding.depth ?? 1;
    const existingHop = hopDistanceByNodeId.get(nodeId);
    const existingConf = confidenceByNodeId.get(nodeId);
    const conf = typeof finding.confidence === "number" ? finding.confidence : 1.0;

    if (existingHop === undefined || hop < existingHop) {
      // Shallower path found
      hopDistanceByNodeId.set(nodeId, hop);
      confidenceByNodeId.set(nodeId, conf);
    } else if (hop === existingHop) {
      // Same hop distance: preserve highest confidence
      if (existingConf === undefined || conf > existingConf) {
        confidenceByNodeId.set(nodeId, conf);
      }
    }
  }

  // 3. Process affected APIs
  for (const api of response.affected_apis ?? []) {
    affectedApiNodeIds.add(api.node_id);
    addEvidence(api.node_id, api);
  }

  // 4. Process affected Events
  for (const ev of response.affected_events ?? []) {
    affectedEventNodeIds.add(ev.node_id);
    addEvidence(ev.node_id, ev);
  }

  // Freeze evidence lists deterministically
  const evidenceIdsByNodeId = new Map<string, readonly string[]>();
  for (const [nodeId, set] of evidenceMap.entries()) {
    const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));
    evidenceIdsByNodeId.set(nodeId, Object.freeze(sorted));
  }

  // Index evidence records by ID
  const evidenceList = response.evidence ?? [];
  const evidenceById = new Map<string, GraphQueryResponseEvidence>();
  for (const ev of evidenceList) {
    if (ev && ev.id) {
      evidenceById.set(ev.id, ev);
    }
  }

  // 5. Determine status
  let status: ChangeModeStatus = "ready";
  let errorMessage: string | null = null;

  if (response.status === "failed") {
    status = "error";
    errorMessage = "Impact analysis run failed on the server.";
  } else if (response.status === "pending" || response.status === "running") {
    status = "loading";
  } else if (directNodeIds.size === 0 && downstreamNodeIds.size === 0) {
    status = "empty";
  }

  const rawResponse = response as unknown as Record<string, unknown>;
  const headCommitVal =
    (typeof rawResponse.head_commit_sha === "string" ? rawResponse.head_commit_sha : null) ??
    (typeof rawResponse.headCommit === "string" ? rawResponse.headCommit : null);

  return {
    enabled,
    pullRequestId: response.pull_request_id,
    impactAnalysisId: response.id,
    headCommit: headCommitVal,
    status,
    executionStatus: response.status,
    directNodeIds,
    downstreamNodeIds,
    affectedApiNodeIds,
    affectedEventNodeIds,
    hopDistanceByNodeId,
    confidenceByNodeId,
    evidenceIdsByNodeId,
    evidence: evidenceList,
    evidenceById,
    directImpactFindings: sortedDirect,
    downstreamImpactFindings: sortedDownstream,
    affectedApiFindings: response.affected_apis ?? [],
    affectedEventFindings: response.affected_events ?? [],
    affectedServiceFindings: response.affected_services ?? [],
    directCount: directNodeIds.size,
    downstreamCount: downstreamNodeIds.size,
    affectedApiCount: affectedApiNodeIds.size,
    affectedEventCount: affectedEventNodeIds.size,
    unresolvedFiles: response.unresolved_files ?? [],
    truncated: response.truncated ?? false,
    truncationReason: response.truncation_reason ?? null,
    maxDepthReached: response.max_depth_reached ?? 0,
    errorMessage,
  };
}

export type FetchImpactAnalysisResult =
  | { readonly ok: true; readonly data: ImpactAnalysisResponse }
  | {
      readonly ok: false;
      readonly reason:
        | "not_authenticated"
        | "invalid_request"
        | "not_found"
        | "network_error";
      readonly message: string;
    };

/**
 * Fetches an ImpactAnalysis by ID using the authenticated session token (Step 45 API).
 *
 * Calls: GET /api/v1/impact-analyses/:id
 * Does NOT query the database or invoke the backend engine directly.
 */
export async function fetchImpactAnalysis(input: {
  readonly apiUrl: string;
  readonly impactAnalysisId: string;
  readonly getToken: () => Promise<string | null>;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal | undefined;
}): Promise<FetchImpactAnalysisResult> {
  const id = input.impactAnalysisId.trim();
  if (!UUID_REGEX.test(id)) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Invalid impact analysis ID format. Must be a valid UUID.",
    };
  }

  let token: string | null;
  try {
    token = await input.getToken();
  } catch {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication token could not be retrieved.",
    };
  }

  if (!token) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: "Authentication required.",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${input.apiUrl.replace(/\/+$/, "")}/api/v1/impact-analyses/${id}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: "network_error",
        message: "Impact analysis request was cancelled.",
      };
    }
    return {
      ok: false,
      reason: "network_error",
      message: "The Fluxora API could not be reached for impact analysis.",
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "not_authenticated",
        message: "You are not authorized to view this impact analysis.",
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        reason: "not_found",
        message: "The requested impact analysis was not found.",
      };
    }

    const message = extractErrorMessage(payload) ?? "Failed to fetch impact analysis.";
    return {
      ok: false,
      reason: "invalid_request",
      message,
    };
  }

  if (!isValidImpactAnalysisResponse(payload)) {
    return {
      ok: false,
      reason: "invalid_request",
      message: "Malformed impact analysis response received from server.",
    };
  }

  return {
    ok: true,
    data: payload as ImpactAnalysisResponse,
  };
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (
    isRecord(payload) &&
    isRecord(payload.error) &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return undefined;
}

function isValidImpactAnalysisResponse(payload: unknown): payload is ImpactAnalysisResponse {
  if (!isRecord(payload)) return false;
  if (typeof payload.id !== "string" || typeof payload.pull_request_id !== "string") {
    return false;
  }
  if (!Array.isArray(payload.direct_impact) || !Array.isArray(payload.downstream_impact)) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

