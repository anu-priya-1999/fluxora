import type {
  RepositoryDatabaseDetectionResult,
  RepositoryDetectorResult,
  RepositoryEventPatternDetectionResult,
  RepositoryModuleGraph,
  RepositoryNormalizedResult,
  RepositoryRouteDetectionResult,
  RepositorySymbolExtractionResult,
  SupportedFramework,
  SupportedLanguage,
  TreeSitterParseResult,
} from "@fluxora/shared-types";

import { detectRepositoryDatabaseReferences } from "../database/detector.ts";
import { detectRepositoryStack, isIgnoredPath } from "../detect/detector.ts";
import { detectRepositoryEventPatterns } from "../events/detector.ts";
import { extractRepositoryModuleGraph, type SnapshotFileMap } from "../modules/graph.ts";
import { normalizeAnalysis } from "../normalizer/normalizer.ts";
import { detectRepositoryRoutes } from "../routes/detector.ts";
import { extractSymbolsFromSource, isSupportedSymbolFile } from "../symbols/extractor.ts";
import { parseTreeSitterFile } from "../tree-sitter/index.ts";

/**
 * Pure deterministic input options passed into the Phase 3 Pipeline Orchestrator.
 */
export interface Phase3PipelineInput {
  /**
   * Snapshot file map: relative POSIX path -> UTF-8 source file text.
   */
  readonly files: SnapshotFileMap;
  /**
   * Optional root path representation (defaults to "/").
   */
  readonly rootDir?: string | undefined;
  /**
   * Optional custom tsconfig path (defaults to "tsconfig.json").
   */
  readonly tsconfigPath?: string | undefined;
}

/**
 * Consolidated pipeline execution summary metrics.
 */
export interface Phase3PipelineSummary {
  readonly filesAnalyzed: number;
  readonly supportedLanguages: readonly SupportedLanguage[];
  readonly supportedFrameworks: readonly SupportedFramework[];
  readonly totalSymbolsExtracted: number;
  readonly totalModuleReferences: number;
  readonly totalModuleInternalEdges: number;
  readonly totalRoutesDetected: number;
  readonly totalEventProducers: number;
  readonly totalEventConsumers: number;
  readonly totalDatabaseReferences: number;
  readonly totalTreeSitterFallbacks: number;
  readonly totalNormalizedSymbols: number;
  readonly totalNormalizedRoutes: number;
  readonly totalNormalizedEvents: number;
  readonly totalNormalizedDatabaseReferences: number;
  readonly totalUnresolved: number;
  readonly totalDiagnostics: number;
  readonly cycleCount: number;
}

/**
 * Consolidated Phase 3 code-intelligence pipeline result.
 */
export interface Phase3PipelineResult {
  readonly detection: RepositoryDetectorResult;
  readonly symbolExtractions: readonly RepositorySymbolExtractionResult[];
  readonly moduleGraph: RepositoryModuleGraph;
  readonly routes: RepositoryRouteDetectionResult;
  readonly events: RepositoryEventPatternDetectionResult;
  readonly databaseReferences: RepositoryDatabaseDetectionResult;
  readonly treeSitterResults: readonly TreeSitterParseResult[];
  readonly normalized: RepositoryNormalizedResult;
  readonly summary: Phase3PipelineSummary;
}

/**
 * Pure, deterministic Phase 3 code-intelligence pipeline orchestrator.
 *
 * Runs Steps 18–25 sequentially over a repository snapshot:
 * Step 18 Stack Detection -> Step 19 Symbol Extraction -> Step 20 Module Graph ->
 * Step 21 Routes -> Step 22 Events -> Step 23 Database -> Step 24 Tree-sitter Fallback ->
 * Step 25 Normalization -> Consolidated Phase 3 Result.
 *
 * No database persistence. No graph storage. No AI calls.
 */
export async function runPhase3Pipeline(
  input: Phase3PipelineInput,
): Promise<Phase3PipelineResult> {
  const { files, rootDir, tsconfigPath } = input;

  // 1. Step 18: Stack Detection
  const detectorFiles = Array.from(files.keys()).map((path) => ({
    path,
    size: files.get(path)?.length ?? 0,
  }));

  const detection = await detectRepositoryStack({
    files: detectorFiles,
    readFile: async (relativePath: string) => {
      return files.get(relativePath) ?? null;
    },
  });

  // 2. Step 19: Symbol Extraction
  const symbolExtractions: RepositorySymbolExtractionResult[] = [];
  const sortedFilePaths = Array.from(files.keys()).sort();

  for (const relativePath of sortedFilePaths) {
    if (isIgnoredPath(relativePath)) {
      continue;
    }
    if (isSupportedSymbolFile(relativePath)) {
      const sourceText = files.get(relativePath) ?? "";
      const result = extractSymbolsFromSource({ relativePath, sourceText });
      symbolExtractions.push(result);
    }
  }

  // 3. Step 20: Import/Export Module Graph Extraction
  const moduleGraph = extractRepositoryModuleGraph({
    files,
    ...(rootDir !== undefined ? { rootDir } : {}),
    ...(tsconfigPath !== undefined ? { tsconfigPath } : {}),
  });

  // 4. Step 21: Route Detection
  const routes = detectRepositoryRoutes({ files });

  // 5. Step 22: Event Pattern Detection
  const events = detectRepositoryEventPatterns({ files });

  // 6. Step 23: Database Reference Detection
  const databaseReferences = detectRepositoryDatabaseReferences({ files });

  // 7. Step 24: Tree-sitter Fallback Pass
  const treeSitterResults: TreeSitterParseResult[] = [];
  const symbolExtractedFiles = new Set(symbolExtractions.map((s) => s.relativePath));

  for (const relativePath of sortedFilePaths) {
    if (isIgnoredPath(relativePath)) {
      continue;
    }
    const sourceText = files.get(relativePath) ?? "";
    const primaryParserSucceeded = symbolExtractedFiles.has(relativePath);

    const tsResult = await parseTreeSitterFile({
      relativePath,
      sourceText,
      primaryParserSucceeded,
    });
    treeSitterResults.push(tsResult);
  }

  // 8. Step 25: Normalization
  const normalized = normalizeAnalysis({
    detectionResult: detection,
    symbolExtractions,
    moduleGraph,
    routeResult: routes,
    eventResult: events,
    databaseResult: databaseReferences,
    treeSitterResults,
  });

  // 9. Derive consolidated summary statistics
  const totalSymbolsExtracted = symbolExtractions.reduce(
    (acc, curr) => acc + curr.symbols.length,
    0,
  );
  const totalTreeSitterFallbacks = treeSitterResults.filter(
    (r) => r.usedFallback && r.success,
  ).length;

  const summary: Phase3PipelineSummary = {
    filesAnalyzed: files.size,
    supportedLanguages: detection.languages,
    supportedFrameworks: detection.frameworks,
    totalSymbolsExtracted,
    totalModuleReferences: moduleGraph.references.length,
    totalModuleInternalEdges: moduleGraph.internalEdges.length,
    totalRoutesDetected: routes.routes.length,
    totalEventProducers: events.producers.length,
    totalEventConsumers: events.consumers.length,
    totalDatabaseReferences: databaseReferences.references.length,
    totalTreeSitterFallbacks,
    totalNormalizedSymbols: normalized.symbols.length,
    totalNormalizedRoutes: normalized.routes.length,
    totalNormalizedEvents: normalized.events.length,
    totalNormalizedDatabaseReferences: normalized.databaseReferences.length,
    totalUnresolved: normalized.unresolved.length,
    totalDiagnostics: normalized.diagnostics.length,
    cycleCount: normalized.statistics.cycleCount,
  };

  return {
    detection,
    symbolExtractions,
    moduleGraph,
    routes,
    events,
    databaseReferences,
    treeSitterResults,
    normalized,
    summary,
  };
}
