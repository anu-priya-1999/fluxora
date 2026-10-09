import type { RepositoryDatabaseFamily, RepositoryDatabaseOperation, RepositoryDatabaseReferenceDetails } from "./database-references.ts";
import type { RepositoryDetectorResult } from "./detection.ts";
import type { RepositoryEventMethodShape, RepositoryEventPatternDetails, RepositoryEventPatternFamily, RepositoryEventPatternRole } from "./event-patterns.ts";
import type { RepositoryModuleImportedName, RepositoryModuleImportKind, RepositoryModuleReferenceKind, RepositoryModuleResolutionStatus, RepositoryModuleGraph } from "./modules.ts";
import type { RepositoryHttpMethod, RepositoryRouteFramework, RepositoryRouteType, RepositoryRouteDetectionResult } from "./routes.ts";
import type { RepositorySymbolExportInfo, RepositorySymbolKind, RepositorySymbolMetadata, SourceLocation, RepositorySymbolExtractionResult } from "./symbols.ts";
import type { TreeSitterParseResult } from "./tree-sitter.ts";
import type { RepositoryEventPatternDetectionResult } from "./event-patterns.ts";
import type { RepositoryDatabaseDetectionResult } from "./database-references.ts";

/**
 * Pure deterministic input options passed into the normalizer.
 * Consumes raw outputs from Steps 18-24.
 */
export interface RepositoryNormalizerInput {
  readonly detectionResult?: RepositoryDetectorResult | undefined;
  readonly symbolExtractions?: readonly RepositorySymbolExtractionResult[] | undefined;
  readonly moduleGraph?: RepositoryModuleGraph | undefined;
  readonly routeResult?: RepositoryRouteDetectionResult | undefined;
  readonly eventResult?: RepositoryEventPatternDetectionResult | undefined;
  readonly databaseResult?: RepositoryDatabaseDetectionResult | undefined;
  readonly treeSitterResults?: readonly TreeSitterParseResult[] | undefined;
}

/**
 * Record of an export alias or re-export alias pointing to a canonical symbol declaration.
 */
export interface NormalizedAlias {
  readonly exportName: string;
  readonly exportingFile: string;
  readonly importKind?: RepositoryModuleImportKind | undefined;
  readonly location?: SourceLocation | undefined;
}

/**
 * Traceable origin metadata for a normalized entity.
 */
export interface NormalizedProvenance {
  readonly detector: string;
  readonly sourceId: string;
  readonly sourceFile: string;
}

/**
 * Canonical normalized symbol entity after deduplication and barrel file resolution.
 */
export interface NormalizedSymbol {
  /**
   * Stable deterministic canonical symbol identifier.
   * Format: `sym:${relativePath}#${kind}:${parentName ? parentName + "." : ""}${name}:${location.start.offset}`
   */
  readonly canonicalId: string;
  readonly name: string;
  readonly kind: RepositorySymbolKind;
  readonly relativePath: string;
  readonly location: SourceLocation;
  readonly exported: RepositorySymbolExportInfo;
  readonly parentSymbolId?: string | undefined;
  readonly parentName?: string | undefined;
  readonly metadata?: RepositorySymbolMetadata | undefined;
  readonly aliases: readonly NormalizedAlias[];
  readonly provenance: readonly NormalizedProvenance[];
}

/**
 * Resolution status for re-exported names and barrel file resolution.
 */
export const NormalizedExportResolutionStatuses = [
  "resolved",
  "unresolved",
  "ambiguous",
  "cyclic",
] as const;

export type NormalizedExportResolutionStatus =
  (typeof NormalizedExportResolutionStatuses)[number];

/**
 * Resolution result mapping an exported symbol/alias in a file to its canonical declaration.
 */
export interface NormalizedExportResolution {
  readonly exportingFile: string;
  readonly exportName: string;
  readonly canonicalSymbolId?: string | undefined;
  readonly canonicalFile?: string | undefined;
  readonly isReExport: boolean;
  readonly status: NormalizedExportResolutionStatus;
  readonly resolutionChain: readonly string[];
  readonly reason?: string | undefined;
}

/**
 * Normalized module dependency edge between files.
 */
export interface NormalizedModuleEdge {
  /**
   * Stable deterministic edge ID.
   * Format: `edge:${sourceFile}->${targetFile ?? specifier}#${edgeKind}:${location.start.offset}`
   */
  readonly canonicalId: string;
  readonly sourceFile: string;
  readonly targetFile?: string | undefined;
  readonly edgeKind: RepositoryModuleReferenceKind;
  readonly importKind: RepositoryModuleImportKind;
  readonly specifier: string;
  readonly names: readonly RepositoryModuleImportedName[];
  readonly location: SourceLocation;
  readonly resolutionStatus: RepositoryModuleResolutionStatus;
  readonly isTypeOnly?: boolean | undefined;
  readonly resolvedSymbolIds?: readonly string[] | undefined;
}

/**
 * Normalized API route with resolved symbol linkage.
 */
export interface NormalizedRoute {
  /**
   * Stable deterministic route ID.
   * Format: `route:${filePath}#${routeType}:${httpMethods.join(",")}:${routePath}:${sourceLocation.start.offset}`
   */
  readonly canonicalId: string;
  readonly framework: RepositoryRouteFramework;
  readonly routeType: RepositoryRouteType;
  readonly filePath: string;
  readonly routePath: string;
  readonly httpMethods: readonly RepositoryHttpMethod[];
  readonly symbolName?: string | undefined;
  readonly canonicalSymbolId?: string | undefined;
  readonly sourceLocation: SourceLocation;
  readonly evidence: string;
}

/**
 * Normalized event producer or consumer pattern occurrence with resolved handler/receiver symbol linkage.
 */
export interface NormalizedEventPattern {
  /**
   * Stable deterministic event pattern ID.
   * Format: `event:${filePath}#${role}:${family}:${methodShape}:${sourceLocation.start.offset}`
   */
  readonly canonicalId: string;
  readonly role: RepositoryEventPatternRole;
  readonly family: RepositoryEventPatternFamily;
  readonly methodShape: RepositoryEventMethodShape;
  readonly filePath: string;
  readonly details: RepositoryEventPatternDetails;
  readonly canonicalSymbolId?: string | undefined;
  readonly sourceLocation: SourceLocation;
  readonly evidence: string;
}

/**
 * Normalized database/ORM interaction point with resolved receiver symbol linkage.
 */
export interface NormalizedDatabaseReference {
  /**
   * Stable deterministic database reference ID.
   * Format: `db:${filePath}#${family}:${operation}:${methodShape}:${sourceLocation.start.offset}`
   */
  readonly canonicalId: string;
  readonly family: RepositoryDatabaseFamily;
  readonly operation: RepositoryDatabaseOperation;
  readonly methodShape: string;
  readonly filePath: string;
  readonly details: RepositoryDatabaseReferenceDetails;
  readonly canonicalSymbolId?: string | undefined;
  readonly sourceLocation: SourceLocation;
  readonly evidence: string;
}

/**
 * Category of unresolved reference recorded by the normalizer.
 */
export const NormalizedUnresolvedReferenceCategories = [
  "module",
  "export",
  "symbol",
  "route",
  "event",
  "database",
] as const;

export type NormalizedUnresolvedReferenceCategory =
  (typeof NormalizedUnresolvedReferenceCategories)[number];

/**
 * Explicit record of an unresolved reference or ambiguous export relationship.
 */
export interface NormalizedUnresolvedReference {
  /**
   * Stable deterministic unresolved reference ID.
   * Format: `unresolved:${sourceFile}:${category}:${targetSpecifierOrName ?? "anonymous"}`
   */
  readonly canonicalId: string;
  readonly sourceFile: string;
  readonly category: NormalizedUnresolvedReferenceCategory;
  readonly targetSpecifierOrName?: string | undefined;
  readonly reason: string;
  readonly location?: SourceLocation | undefined;
  readonly originalId?: string | undefined;
}

/**
 * Unified normalized diagnostic report aggregated from detectors.
 */
export interface NormalizedDiagnostic {
  readonly file?: string | undefined;
  readonly message: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly severity: "error" | "warning";
  readonly sourceDetector: string;
}

/**
 * Summary counts for deterministic verification of normalized output.
 */
export interface NormalizerStatistics {
  readonly totalSymbolsInput: number;
  readonly totalNormalizedSymbols: number;
  readonly totalReExportsResolved: number;
  readonly totalModuleEdgesNormalized: number;
  readonly totalRoutesNormalized: number;
  readonly totalEventsNormalized: number;
  readonly totalDatabaseReferencesNormalized: number;
  readonly totalUnresolved: number;
  readonly totalDiagnostics: number;
  readonly cycleCount: number;
}

/**
 * Complete deterministic result of Step 25 Normalization.
 */
export interface RepositoryNormalizedResult {
  readonly symbols: readonly NormalizedSymbol[];
  readonly exportResolutions: readonly NormalizedExportResolution[];
  readonly moduleEdges: readonly NormalizedModuleEdge[];
  readonly routes: readonly NormalizedRoute[];
  readonly events: readonly NormalizedEventPattern[];
  readonly databaseReferences: readonly NormalizedDatabaseReference[];
  readonly unresolved: readonly NormalizedUnresolvedReference[];
  readonly diagnostics: readonly NormalizedDiagnostic[];
  readonly statistics: NormalizerStatistics;
}

