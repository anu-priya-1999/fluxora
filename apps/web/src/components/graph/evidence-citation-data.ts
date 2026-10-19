import type {
  GraphQueryResponseEvidence,
  ImpactAnalysisFindingResponse,
} from "@fluxora/shared-types";

export interface BuildSourcePermalinkParams {
  /**
   * Repository full name in owner/repo format (e.g. "shadcn-ui/taxonomy").
   */
  readonly repositoryName?: string | null | undefined;
  /**
   * Pinned, immutable commit SHA (e.g. 40-character or 7-character hex string).
   */
  readonly commitSha?: string | null | undefined;
  /**
   * Branch or ref name (used as fallback when commit SHA is not provided).
   */
  readonly gitRef?: string | null | undefined;
  readonly ref?: string | null | undefined;
  /**
   * Normalized relative file path in repository (e.g. "lib/subscription.ts").
   */
  readonly filePath: string;
  /**
   * 1-based start line number when available from AST / compiler evidence.
   */
  readonly lineStart?: number | null | undefined;
  /**
   * 1-based end line number when available from AST / compiler evidence.
   */
  readonly lineEnd?: number | null | undefined;
}

export interface SourcePermalinkResult {
  /**
   * Whether a valid, safe source permalink could be constructed.
   */
  readonly available: boolean;
  /**
   * The constructed safe external URL (or null if unavailable).
   */
  readonly url: string | null;
  /**
   * Human-readable explanation when direct navigation is unavailable.
   */
  readonly reason: string | null;
}

const REPO_FULL_NAME_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const COMMIT_SHA_REGEX = /^[0-9a-fA-F]{7,40}$/;
const SAFE_REF_REGEX = /^[a-zA-Z0-9_./-]+$/;

/**
 * Constructs a secure, verifiable GitHub source permalink.
 *
 * Rules:
 * 1. Requires valid repositoryName in "owner/repo" format.
 * 2. Requires valid commit SHA or safe Git ref. Prefers immutable commit SHA.
 * 3. Sanitizes filePath: forbids path traversal (".."), absolute paths, or protocol injection.
 * 4. Appends exact line hash (#L{start}-L{end} or #L{start}) ONLY when real numeric lines exist.
 * 5. Never fabricates fake line numbers or synthetic commit SHAs.
 * 6. Returns a clear, honest reason when direct navigation cannot be generated.
 */
export function buildSourcePermalink(
  params: BuildSourcePermalinkParams,
): SourcePermalinkResult {
  const { repositoryName, commitSha, gitRef, ref, filePath, lineStart, lineEnd } = params;
  const candidateRef = gitRef ?? ref;

  // 1. Validate repository name
  if (!repositoryName || typeof repositoryName !== "string") {
    return {
      available: false,
      url: null,
      reason: "Repository name is not available",
    };
  }

  const cleanRepo = repositoryName.trim();
  if (!REPO_FULL_NAME_REGEX.test(cleanRepo)) {
    return {
      available: false,
      url: null,
      reason: "Repository name is not in a valid owner/repo format",
    };
  }

  // 2. Validate commit SHA or safe ref (prefer immutable commit SHA)
  let cleanRef: string | null = null;
  if (commitSha && typeof commitSha === "string" && commitSha.trim()) {
    const trimmed = commitSha.trim();
    if (COMMIT_SHA_REGEX.test(trimmed) || (SAFE_REF_REGEX.test(trimmed) && !trimmed.includes(".."))) {
      cleanRef = trimmed;
    }
  } else if (candidateRef && typeof candidateRef === "string" && SAFE_REF_REGEX.test(candidateRef.trim()) && !candidateRef.includes("..")) {
    cleanRef = candidateRef.trim();
  }

  if (!cleanRef) {
    return {
      available: false,
      url: null,
      reason: "Commit reference is not resolved",
    };
  }

  // 3. Validate and sanitize file path
  if (!filePath || typeof filePath !== "string") {
    return {
      available: false,
      url: null,
      reason: "File path is missing",
    };
  }

  const normalizedPath = filePath.replace(/\\/g, "/").trim();
  if (
    normalizedPath.length === 0 ||
    normalizedPath.includes("..") ||
    normalizedPath.startsWith("/") ||
    normalizedPath.includes("://") ||
    normalizedPath.includes(":") ||
    /[<>"|?*()]/.test(normalizedPath)
  ) {
    return {
      available: false,
      url: null,
      reason: "Invalid or unsafe file path",
    };
  }

  // 4. Construct anchor for line / range
  let anchor = "";
  if (typeof lineStart === "number" && Number.isInteger(lineStart) && lineStart > 0) {
    if (
      typeof lineEnd === "number" &&
      Number.isInteger(lineEnd) &&
      lineEnd > lineStart
    ) {
      anchor = `#L${lineStart}-L${lineEnd}`;
    } else {
      anchor = `#L${lineStart}`;
    }
  }

  const url = `https://github.com/${cleanRepo}/blob/${cleanRef}/${normalizedPath}${anchor}`;
  return {
    available: true,
    url,
    reason: null,
  };
}

/**
 * Formats a 1-based line or line range into a readable badge string (e.g. "L10–L18" or "L10").
 * Returns null when real line metadata is not present.
 */
export function formatLineRange(
  lineStart?: number | null | undefined,
  lineEnd?: number | null | undefined,
): string | null {
  if (typeof lineStart !== "number" || lineStart < 1) {
    return null;
  }

  if (typeof lineEnd === "number" && lineEnd > lineStart) {
    return `L${lineStart}–L${lineEnd}`;
  }

  return `L${lineStart}`;
}

/**
 * Deduplicates and deterministically sorts evidence records.
 *
 * Rules:
 * 1. Deduplicates strictly by evidence `id`.
 * 2. Deterministic sort order:
 *    a. file_path (lexicographical)
 *    b. line_start (numerical ascending; nulls last)
 *    c. line_end (numerical ascending; nulls last)
 *    d. relationship_description (lexicographical)
 *    e. id (lexicographical)
 */
export function deduplicateAndSortEvidence(
  records: readonly GraphQueryResponseEvidence[] | undefined,
): GraphQueryResponseEvidence[] {
  if (!records || !Array.isArray(records) || records.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const unique: GraphQueryResponseEvidence[] = [];

  for (const item of records) {
    if (!item || !item.id || seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    unique.push(item);
  }

  return unique.sort((a, b) => {
    // 1. file_path
    const pathA = a.file_path ?? "";
    const pathB = b.file_path ?? "";
    const pathCmp = pathA.localeCompare(pathB);
    if (pathCmp !== 0) return pathCmp;

    // 2. line_start
    const startA = typeof a.line_start === "number" ? a.line_start : Number.MAX_SAFE_INTEGER;
    const startB = typeof b.line_start === "number" ? b.line_start : Number.MAX_SAFE_INTEGER;
    if (startA !== startB) return startA - startB;

    // 3. line_end
    const endA = typeof a.line_end === "number" ? a.line_end : Number.MAX_SAFE_INTEGER;
    const endB = typeof b.line_end === "number" ? b.line_end : Number.MAX_SAFE_INTEGER;
    if (endA !== endB) return endA - endB;

    // 4. relationship_description
    const descA = a.relationship_description ?? "";
    const descB = b.relationship_description ?? "";
    const descCmp = descA.localeCompare(descB);
    if (descCmp !== 0) return descCmp;

    // 5. id
    return a.id.localeCompare(b.id);
  });
}

/**
 * Resolves all evidence records linked to an ImpactAnalysisFindingResponse from an available evidence pool.
 *
 * Checks:
 * 1. finding.evidence_ids (array) and finding.evidence_id (singular fallback)
 * 2. Matches records in evidencePool by id === evId OR (subject_type === "impact_finding" && subject_id === finding.node_id)
 * 3. Deduplicates and deterministically sorts results.
 */
export function resolveEvidenceForFinding(
  finding: ImpactAnalysisFindingResponse,
  evidencePool?: readonly GraphQueryResponseEvidence[] | undefined,
): GraphQueryResponseEvidence[] {
  if (!evidencePool || !Array.isArray(evidencePool) || evidencePool.length === 0) {
    return [];
  }

  const targetIdSet = new Set<string>();
  if (finding.evidence_ids && Array.isArray(finding.evidence_ids)) {
    for (const id of finding.evidence_ids) {
      if (id && typeof id === "string") {
        targetIdSet.add(id);
      }
    }
  }
  if (finding.evidence_id && typeof finding.evidence_id === "string") {
    targetIdSet.add(finding.evidence_id);
  }

  const matched: GraphQueryResponseEvidence[] = [];

  for (const ev of evidencePool) {
    if (targetIdSet.has(ev.id)) {
      matched.push(ev);
    } else if (
      (ev.subject_type === "impact_finding" || ev.subject_type === "graph_node") &&
      ev.subject_id === finding.node_id
    ) {
      matched.push(ev);
    }
  }

  return deduplicateAndSortEvidence(matched);
}
