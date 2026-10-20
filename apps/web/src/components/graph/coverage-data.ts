import type {
  GraphQueryResponseEdge,
  GraphQueryResponseNode,
  ImpactAnalysisFindingResponse,
} from "@fluxora/shared-types";
import type { NormalizedChangeModeState } from "./change-mode-data.ts";

export type CoverageSubjectType = "graph_edge" | "impact_finding";

export type CoverageFilter = "all" | "covered" | "uncovered";

export type CoverageStateKind =
  | "no_analysis"
  | "analysis_not_ready"
  | "loading"
  | "available"
  | "unavailable"
  | "stale";

export interface AnalysisCoverageCategory {
  readonly id: string;
  readonly name: string;
  readonly total: number;
  readonly covered: number;
  readonly uncovered: number;
  readonly percentage: number;
  readonly formattedPercentage: string;
  readonly accessibleLabel: string;
}

export interface UncoveredGraphEdgeItem {
  readonly id: string;
  readonly edgeType: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly confidence: number;
  readonly provenance: string;
}

export interface CoveredGraphEdgeItem {
  readonly id: string;
  readonly edgeType: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly confidence: number;
  readonly provenance: string;
  readonly evidenceId: string;
}

export interface UncoveredImpactFindingItem {
  readonly nodeId: string;
  readonly name: string;
  readonly type: string;
  readonly category: "direct" | "downstream" | "api" | "event" | "service";
  readonly categoryLabel: string;
  readonly confidence: number;
  readonly hopDistance: number;
}

export interface CoveredImpactFindingItem {
  readonly nodeId: string;
  readonly name: string;
  readonly type: string;
  readonly category: "direct" | "downstream" | "api" | "event" | "service";
  readonly categoryLabel: string;
  readonly confidence: number;
  readonly hopDistance: number;
  readonly evidenceIds: readonly string[];
}

export interface AnalysisCoverageSummary {
  readonly kind: CoverageStateKind;
  readonly subjectType: CoverageSubjectType;
  readonly analysisRunId: string | null;
  readonly scopeLabel: string;
  readonly repositoryName?: string | undefined;
  readonly commitSha?: string | undefined;
  readonly gitRef?: string | undefined;
  readonly total: number;
  readonly covered: number;
  readonly uncovered: number;
  readonly percentage: number;
  readonly formattedPercentage: string;
  readonly accessibleLabel: string;
  readonly categories: readonly AnalysisCoverageCategory[];
  readonly uncoveredEdges: readonly UncoveredGraphEdgeItem[];
  readonly coveredEdges: readonly CoveredGraphEdgeItem[];
  readonly uncoveredFindings: readonly UncoveredImpactFindingItem[];
  readonly coveredFindings: readonly CoveredImpactFindingItem[];
  readonly unresolvedFilesCount: number;
  readonly isFullCoverage: boolean;
  readonly isZeroCoverage: boolean;
  readonly isEmptyScope: boolean;
  readonly errorMessage?: string | undefined;
}

/**
 * Checks whether a graph edge is evidence-backed.
 * Authoritative: requires a non-empty string in evidence_id.
 */
export function isGraphEdgeCovered(edge: GraphQueryResponseEdge): boolean {
  return typeof edge.evidence_id === "string" && edge.evidence_id.trim().length > 0;
}

/**
 * Checks whether an impact finding is evidence-backed.
 * Authoritative: requires at least one evidence ID in evidence_ids or a non-empty evidence_id.
 */
export function isImpactFindingCovered(finding: ImpactAnalysisFindingResponse): boolean {
  if (Array.isArray(finding.evidence_ids) && finding.evidence_ids.length > 0) {
    return true;
  }
  return typeof finding.evidence_id === "string" && finding.evidence_id.trim().length > 0;
}

/**
 * Formats a ratio as a deterministic percentage string with up to 1 decimal place.
 * Examples: 1.0 -> "100%", 0.9654 -> "96.5%", 0.0 -> "0%".
 */
export function formatCoveragePercentage(covered: number, total: number): {
  percentage: number;
  formattedPercentage: string;
} {
  if (total <= 0) {
    return { percentage: 0, formattedPercentage: "N/A" };
  }
  const ratio = covered / total;
  // Round to 1 decimal place deterministically
  const pct = Math.round(ratio * 1000) / 10;
  return {
    percentage: pct,
    formattedPercentage: `${pct}%`,
  };
}

export interface CalculateGraphEdgeCoverageOptions {
  readonly edges?: readonly GraphQueryResponseEdge[] | undefined;
  readonly nodes?: readonly GraphQueryResponseNode[] | undefined;
  readonly analysisRunId?: string | null | undefined;
  readonly repositoryName?: string | undefined;
  readonly commitSha?: string | undefined;
  readonly gitRef?: string | undefined;
  readonly isLoading?: boolean | undefined;
  readonly isStale?: boolean | undefined;
  readonly errorMessage?: string | null | undefined;
}

/**
 * Calculates authoritative Evidence Coverage for the Graph Analysis surface (Graph Edges).
 *
 * Deterministic formula:
 * Evidence Coverage = evidence-backed graph edges / analyzed graph edges in scope
 */
export function calculateGraphEdgeCoverage(
  options: CalculateGraphEdgeCoverageOptions,
): AnalysisCoverageSummary {
  const {
    edges = [],
    nodes = [],
    analysisRunId,
    repositoryName,
    commitSha,
    gitRef,
    isLoading = false,
    isStale = false,
    errorMessage,
  } = options;

  const baseScopeLabel = analysisRunId
    ? `Analysis Run: ${analysisRunId.slice(0, 8)}...`
    : "No Analysis Run";

  if (errorMessage) {
    return {
      kind: "unavailable",
      subjectType: "graph_edge",
      analysisRunId: analysisRunId ?? null,
      scopeLabel: baseScopeLabel,
      ...(repositoryName ? { repositoryName } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(gitRef ? { gitRef } : {}),
      total: 0,
      covered: 0,
      uncovered: 0,
      percentage: 0,
      formattedPercentage: "N/A",
      accessibleLabel: `Coverage data unavailable: ${errorMessage}`,
      categories: [],
      uncoveredEdges: [],
      coveredEdges: [],
      uncoveredFindings: [],
      coveredFindings: [],
      unresolvedFilesCount: 0,
      isFullCoverage: false,
      isZeroCoverage: false,
      isEmptyScope: true,
      errorMessage,
    };
  }

  if (isLoading) {
    return {
      kind: "loading",
      subjectType: "graph_edge",
      analysisRunId: analysisRunId ?? null,
      scopeLabel: baseScopeLabel,
      ...(repositoryName ? { repositoryName } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(gitRef ? { gitRef } : {}),
      total: 0,
      covered: 0,
      uncovered: 0,
      percentage: 0,
      formattedPercentage: "Loading...",
      accessibleLabel: "Loading analysis evidence coverage...",
      categories: [],
      uncoveredEdges: [],
      coveredEdges: [],
      uncoveredFindings: [],
      coveredFindings: [],
      unresolvedFilesCount: 0,
      isFullCoverage: false,
      isZeroCoverage: false,
      isEmptyScope: true,
    };
  }

  if (!analysisRunId) {
    return {
      kind: "no_analysis",
      subjectType: "graph_edge",
      analysisRunId: null,
      scopeLabel: "No Analysis Run Selected",
      ...(repositoryName ? { repositoryName } : {}),
      total: 0,
      covered: 0,
      uncovered: 0,
      percentage: 0,
      formattedPercentage: "N/A",
      accessibleLabel: "No analysis run selected.",
      categories: [],
      uncoveredEdges: [],
      coveredEdges: [],
      uncoveredFindings: [],
      coveredFindings: [],
      unresolvedFilesCount: 0,
      isFullCoverage: false,
      isZeroCoverage: false,
      isEmptyScope: true,
    };
  }

  // Node name lookup map for readable edge summaries
  const nodeNameById = new Map<string, string>();
  for (const node of nodes) {
    nodeNameById.set(node.id, node.name || node.canonical_id || node.id);
  }

  const total = edges.length;
  let coveredCount = 0;
  const coveredEdgesList: CoveredGraphEdgeItem[] = [];
  const uncoveredEdgesList: UncoveredGraphEdgeItem[] = [];

  // Category counts by edge type
  const categoryCounts = new Map<string, { total: number; covered: number }>();

  for (const edge of edges) {
    const covered = isGraphEdgeCovered(edge);
    const typeKey = edge.type || "UNKNOWN";

    const currentCat = categoryCounts.get(typeKey) ?? { total: 0, covered: 0 };
    currentCat.total += 1;
    if (covered) {
      currentCat.covered += 1;
    }
    categoryCounts.set(typeKey, currentCat);

    const sourceName = nodeNameById.get(edge.source) ?? edge.source;
    const targetName = nodeNameById.get(edge.target) ?? edge.target;

    if (covered) {
      coveredCount += 1;
      coveredEdgesList.push({
        id: edge.id,
        edgeType: edge.type,
        sourceId: edge.source,
        sourceName,
        targetId: edge.target,
        targetName,
        confidence: edge.confidence,
        provenance: edge.provenance,
        evidenceId: edge.evidence_id!,
      });
    } else {
      uncoveredEdgesList.push({
        id: edge.id,
        edgeType: edge.type,
        sourceId: edge.source,
        sourceName,
        targetId: edge.target,
        targetName,
        confidence: edge.confidence,
        provenance: edge.provenance,
      });
    }
  }

  const uncoveredCount = total - coveredCount;
  const { percentage, formattedPercentage } = formatCoveragePercentage(coveredCount, total);

  // Deterministic sorting of categories (alphabetical by type)
  const sortedTypeKeys = Array.from(categoryCounts.keys()).sort();
  const categories: AnalysisCoverageCategory[] = sortedTypeKeys.map((typeKey) => {
    const counts = categoryCounts.get(typeKey)!;
    const catCoverage = formatCoveragePercentage(counts.covered, counts.total);
    const catUncovered = counts.total - counts.covered;
    return {
      id: typeKey,
      name: typeKey,
      total: counts.total,
      covered: counts.covered,
      uncovered: catUncovered,
      percentage: catCoverage.percentage,
      formattedPercentage: catCoverage.formattedPercentage,
      accessibleLabel: `${typeKey}: ${catCoverage.formattedPercentage}, ${counts.covered} of ${counts.total} edges covered`,
    };
  });

  // Deterministic sorting of uncovered edges (by type, sourceName, targetName, id)
  uncoveredEdgesList.sort((a, b) => {
    if (a.edgeType !== b.edgeType) return a.edgeType.localeCompare(b.edgeType);
    if (a.sourceName !== b.sourceName) return a.sourceName.localeCompare(b.sourceName);
    if (a.targetName !== b.targetName) return a.targetName.localeCompare(b.targetName);
    return a.id.localeCompare(b.id);
  });

  // Deterministic sorting of covered edges
  coveredEdgesList.sort((a, b) => {
    if (a.edgeType !== b.edgeType) return a.edgeType.localeCompare(b.edgeType);
    if (a.sourceName !== b.sourceName) return a.sourceName.localeCompare(b.sourceName);
    if (a.targetName !== b.targetName) return a.targetName.localeCompare(b.targetName);
    return a.id.localeCompare(b.id);
  });

  const isEmpty = total === 0;
  const isFull = total > 0 && coveredCount === total;
  const isZero = total > 0 && coveredCount === 0;

  const accessibleLabel = isEmpty
    ? "Evidence coverage: 0 analyzed graph edges in scope."
    : `Evidence coverage: ${formattedPercentage}, ${coveredCount} of ${total} analyzed conclusions have evidence.`;

  return {
    kind: isStale ? "stale" : "available",
    subjectType: "graph_edge",
    analysisRunId,
    scopeLabel: baseScopeLabel,
    ...(repositoryName ? { repositoryName } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(gitRef ? { gitRef } : {}),
    total,
    covered: coveredCount,
    uncovered: uncoveredCount,
    percentage,
    formattedPercentage,
    accessibleLabel,
    categories,
    uncoveredEdges: uncoveredEdgesList,
    coveredEdges: coveredEdgesList,
    uncoveredFindings: [],
    coveredFindings: [],
    unresolvedFilesCount: 0,
    isFullCoverage: isFull,
    isZeroCoverage: isZero,
    isEmptyScope: isEmpty,
  };
}

export interface CalculateImpactFindingCoverageOptions {
  readonly changeModeState: NormalizedChangeModeState;
  readonly analysisRunId?: string | null | undefined;
  readonly repositoryName?: string | undefined;
  readonly commitSha?: string | undefined;
  readonly gitRef?: string | undefined;
}

/**
 * Calculates authoritative Evidence Coverage for the PR Change-Impact surface (Impact Findings).
 *
 * Deterministic formula:
 * Evidence Coverage = evidence-backed impact findings / analyzed impact findings in PR blast radius
 */
export function calculateImpactFindingCoverage(
  options: CalculateImpactFindingCoverageOptions,
): AnalysisCoverageSummary {
  const { changeModeState, analysisRunId, repositoryName, commitSha, gitRef } = options;

  const baseScopeLabel = changeModeState.impactAnalysisId
    ? `Impact Analysis: ${changeModeState.impactAnalysisId.slice(0, 8)}...`
    : "No Impact Analysis";

  if (!changeModeState.enabled || !changeModeState.impactAnalysisId) {
    return {
      kind: "no_analysis",
      subjectType: "impact_finding",
      analysisRunId: analysisRunId ?? null,
      scopeLabel: "Change Mode Disabled",
      ...(repositoryName ? { repositoryName } : {}),
      total: 0,
      covered: 0,
      uncovered: 0,
      percentage: 0,
      formattedPercentage: "N/A",
      accessibleLabel: "Change Mode is disabled.",
      categories: [],
      uncoveredEdges: [],
      coveredEdges: [],
      uncoveredFindings: [],
      coveredFindings: [],
      unresolvedFilesCount: 0,
      isFullCoverage: false,
      isZeroCoverage: false,
      isEmptyScope: true,
    };
  }

  if (changeModeState.status === "loading") {
    return {
      kind: "loading",
      subjectType: "impact_finding",
      analysisRunId: analysisRunId ?? null,
      scopeLabel: baseScopeLabel,
      ...(repositoryName ? { repositoryName } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(gitRef ? { gitRef } : {}),
      total: 0,
      covered: 0,
      uncovered: 0,
      percentage: 0,
      formattedPercentage: "Loading...",
      accessibleLabel: "Loading impact analysis coverage...",
      categories: [],
      uncoveredEdges: [],
      coveredEdges: [],
      uncoveredFindings: [],
      coveredFindings: [],
      unresolvedFilesCount: 0,
      isFullCoverage: false,
      isZeroCoverage: false,
      isEmptyScope: true,
    };
  }

  if (changeModeState.status === "error") {
    const errorMsg = changeModeState.errorMessage ?? "Failed to load impact analysis.";
    return {
      kind: "unavailable",
      subjectType: "impact_finding",
      analysisRunId: analysisRunId ?? null,
      scopeLabel: baseScopeLabel,
      ...(repositoryName ? { repositoryName } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(gitRef ? { gitRef } : {}),
      total: 0,
      covered: 0,
      uncovered: 0,
      percentage: 0,
      formattedPercentage: "N/A",
      accessibleLabel: `Impact coverage unavailable: ${errorMsg}`,
      categories: [],
      uncoveredEdges: [],
      coveredEdges: [],
      uncoveredFindings: [],
      coveredFindings: [],
      unresolvedFilesCount: 0,
      isFullCoverage: false,
      isZeroCoverage: false,
      isEmptyScope: true,
      errorMessage: errorMsg,
    };
  }

  const directList = changeModeState.directImpactFindings ?? [];
  const downstreamList = changeModeState.downstreamImpactFindings ?? [];
  const apiList = changeModeState.affectedApiFindings ?? [];
  const eventList = changeModeState.affectedEventFindings ?? [];
  const serviceList = changeModeState.affectedServiceFindings ?? [];

  const rawGroups: Array<{
    id: string;
    label: string;
    category: "direct" | "downstream" | "api" | "event" | "service";
    items: readonly ImpactAnalysisFindingResponse[];
  }> = [
    { id: "direct", label: "Direct impact", category: "direct", items: directList },
    { id: "downstream", label: "Downstream impact", category: "downstream", items: downstreamList },
    { id: "affected_apis", label: "Affected APIs", category: "api", items: apiList },
    { id: "affected_events", label: "Affected events", category: "event", items: eventList },
    { id: "affected_services", label: "Affected services", category: "service", items: serviceList },
  ];

  let totalFindings = 0;
  let coveredFindingsCount = 0;
  const uncoveredFindingsList: UncoveredImpactFindingItem[] = [];
  const coveredFindingsList: CoveredImpactFindingItem[] = [];
  const categories: AnalysisCoverageCategory[] = [];

  for (const group of rawGroups) {
    if (group.items.length === 0) continue;

    let groupCovered = 0;
    for (const finding of group.items) {
      totalFindings += 1;
      const covered = isImpactFindingCovered(finding);
      if (covered) {
        coveredFindingsCount += 1;
        groupCovered += 1;
        coveredFindingsList.push({
          nodeId: finding.node_id,
          name: finding.name,
          type: finding.type,
          category: group.category,
          categoryLabel: group.label,
          confidence: finding.confidence,
          hopDistance: finding.hop_distance,
          evidenceIds: finding.evidence_ids ?? (finding.evidence_id ? [finding.evidence_id] : []),
        });
      } else {
        uncoveredFindingsList.push({
          nodeId: finding.node_id,
          name: finding.name,
          type: finding.type,
          category: group.category,
          categoryLabel: group.label,
          confidence: finding.confidence,
          hopDistance: finding.hop_distance,
        });
      }
    }

    const catCoverage = formatCoveragePercentage(groupCovered, group.items.length);
    categories.push({
      id: group.id,
      name: group.label,
      total: group.items.length,
      covered: groupCovered,
      uncovered: group.items.length - groupCovered,
      percentage: catCoverage.percentage,
      formattedPercentage: catCoverage.formattedPercentage,
      accessibleLabel: `${group.label}: ${catCoverage.formattedPercentage}, ${groupCovered} of ${group.items.length} findings covered`,
    });
  }

  // Deterministic sorting of uncovered impact findings:
  // Sort by category order, then hopDistance, then name, then nodeId
  const categoryOrder: Record<string, number> = {
    direct: 0,
    downstream: 1,
    api: 2,
    event: 3,
    service: 4,
  };

  uncoveredFindingsList.sort((a, b) => {
    const orderA = categoryOrder[a.category] ?? 99;
    const orderB = categoryOrder[b.category] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    if (a.hopDistance !== b.hopDistance) return a.hopDistance - b.hopDistance;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.nodeId.localeCompare(b.nodeId);
  });

  coveredFindingsList.sort((a, b) => {
    const orderA = categoryOrder[a.category] ?? 99;
    const orderB = categoryOrder[b.category] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    if (a.hopDistance !== b.hopDistance) return a.hopDistance - b.hopDistance;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.nodeId.localeCompare(b.nodeId);
  });

  const uncoveredCount = totalFindings - coveredFindingsCount;
  const { percentage, formattedPercentage } = formatCoveragePercentage(
    coveredFindingsCount,
    totalFindings,
  );

  const isEmpty = totalFindings === 0;
  const isFull = totalFindings > 0 && coveredFindingsCount === totalFindings;
  const isZero = totalFindings > 0 && coveredFindingsCount === 0;

  const accessibleLabel = isEmpty
    ? "Evidence coverage: 0 analyzed impact findings in blast radius."
    : `Impact evidence coverage: ${formattedPercentage}, ${coveredFindingsCount} of ${totalFindings} analyzed findings have evidence.`;

  return {
    kind: "available",
    subjectType: "impact_finding",
    analysisRunId: analysisRunId ?? null,
    scopeLabel: baseScopeLabel,
    ...(repositoryName ? { repositoryName } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(gitRef ? { gitRef } : {}),
    total: totalFindings,
    covered: coveredFindingsCount,
    uncovered: uncoveredCount,
    percentage,
    formattedPercentage,
    accessibleLabel,
    categories,
    uncoveredEdges: [],
    coveredEdges: [],
    uncoveredFindings: uncoveredFindingsList,
    coveredFindings: coveredFindingsList,
    unresolvedFilesCount: changeModeState.unresolvedFiles?.length ?? 0,
    isFullCoverage: isFull,
    isZeroCoverage: isZero,
    isEmptyScope: isEmpty,
  };
}

