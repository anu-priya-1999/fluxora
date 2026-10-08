import type { SourceLocation } from "./symbols.ts";

/**
 * Resolution status for a module reference.
 */
export const RepositoryModuleResolutionStatuses = [
  "internal",
  "external",
  "unresolved",
  "unsupported_dynamic",
] as const;

export type RepositoryModuleResolutionStatus =
  (typeof RepositoryModuleResolutionStatuses)[number];

/**
 * Reference kind classifying how a module specifier was referenced.
 */
export const RepositoryModuleReferenceKinds = [
  "import",
  "re_export",
  "dynamic_import",
  "require",
] as const;

export type RepositoryModuleReferenceKind =
  (typeof RepositoryModuleReferenceKinds)[number];

/**
 * Detailed syntactic kind of import or export statement.
 */
export const RepositoryModuleImportKinds = [
  "named_import",
  "default_import",
  "namespace_import",
  "side_effect_import",
  "dynamic_import",
  "require",
  "named_re_export",
  "star_re_export",
  "namespace_re_export",
] as const;

export type RepositoryModuleImportKind =
  (typeof RepositoryModuleImportKinds)[number];

/**
 * Individual imported or exported item identifier and alias binding.
 */
export interface RepositoryModuleImportedName {
  readonly name: string;
  readonly alias?: string;
  readonly isTypeOnly?: boolean;
}

/**
 * Deterministic extracted module reference in a source file.
 */
export interface RepositoryModuleReference {
  /**
   * Deterministic unique identifier for this reference in the file.
   * Format: `${sourceFile}#ref:${referenceKind}:${start.offset}`
   */
  readonly id: string;
  readonly sourceFile: string;
  readonly specifier: string;
  readonly referenceKind: RepositoryModuleReferenceKind;
  readonly importKind: RepositoryModuleImportKind;
  readonly names: readonly RepositoryModuleImportedName[];
  readonly location: SourceLocation;
  readonly resolutionStatus: RepositoryModuleResolutionStatus;
  readonly targetFile?: string;
  readonly isTypeOnly?: boolean;
}

/**
 * Deterministic directed edge representing a dependency relationship between repository modules.
 */
export interface RepositoryModuleEdge {
  /**
   * Stable deterministic edge ID.
   * Format: `${sourceFile}->${targetFile ?? specifier}#${edgeKind}:${start.offset}`
   */
  readonly id: string;
  readonly sourceFile: string;
  readonly targetFile?: string;
  readonly edgeKind: RepositoryModuleReferenceKind;
  readonly importKind: RepositoryModuleImportKind;
  readonly specifier: string;
  readonly names: readonly RepositoryModuleImportedName[];
  readonly location: SourceLocation;
  readonly resolutionStatus: RepositoryModuleResolutionStatus;
  readonly isTypeOnly?: boolean;
}

/**
 * Diagnostic report for syntax, parsing, or resolution issues during graph extraction.
 */
export interface RepositoryModuleGraphDiagnostic {
  readonly file: string;
  readonly message: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly code?: number | undefined;
  readonly severity: "error" | "warning";
}

/**
 * Comprehensive result of module reference and graph extraction over a repository snapshot.
 */
export interface RepositoryModuleGraph {
  readonly filesAnalyzed: readonly string[];
  readonly references: readonly RepositoryModuleReference[];
  readonly internalEdges: readonly RepositoryModuleEdge[];
  readonly externalReferences: readonly RepositoryModuleReference[];
  readonly unresolvedReferences: readonly RepositoryModuleReference[];
  readonly unsupportedDynamicReferences: readonly RepositoryModuleReference[];
  readonly diagnostics: readonly RepositoryModuleGraphDiagnostic[];
}

