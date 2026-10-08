/**
 * Supported symbol kinds extracted from source files in Fluxora.
 * Corresponds to Step 19 AST symbol extraction specification and
 * database schema Symbol entity (`docs/architecture/06-database-schema.md §6.3`).
 */
export const RepositorySymbolKinds = [
  "function",
  "class",
  "method",
  "interface",
  "type_alias",
  "enum",
  "variable",
  "constant",
] as const;

export type RepositorySymbolKind = (typeof RepositorySymbolKinds)[number];

/**
 * Source position representing 1-based line and column, and 0-based character offset.
 */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/**
 * Deterministic source location range within a source file.
 */
export interface SourceLocation {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/**
 * Deterministic export status and declaration metadata for a symbol.
 */
export interface RepositorySymbolExportInfo {
  readonly isExported: boolean;
  readonly isDefaultExport: boolean;
  readonly exportName?: string;
}

/**
 * Specific metadata associated with a symbol declaration depending on its kind.
 */
export interface RepositorySymbolMetadata {
  readonly isAsync?: boolean;
  readonly isGenerator?: boolean;
  readonly isStatic?: boolean;
  readonly isAbstract?: boolean;
  readonly accessibility?: "public" | "protected" | "private";
  readonly returnType?: string;
  readonly typeAnnotation?: string;
  readonly isConst?: boolean;
  readonly docComment?: string;
}

/**
 * Extracted code entity / symbol in a source file.
 */
export interface RepositorySymbol {
  /**
   * Deterministic unique identifier for the symbol within the file / snapshot.
   * Format: `${relativePath}#${kind}:${parentName ? parentName + "." : ""}${name}:${start.offset}`
   */
  readonly id: string;
  readonly name: string;
  readonly kind: RepositorySymbolKind;
  readonly relativePath: string;
  readonly location: SourceLocation;
  readonly exported: RepositorySymbolExportInfo;
  readonly parentSymbolId?: string;
  readonly parentName?: string;
  readonly metadata?: RepositorySymbolMetadata;
}

/**
 * Diagnostic report for syntax or parse errors encountered during symbol extraction.
 */
export interface RepositorySymbolDiagnostic {
  readonly message: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly code?: number | undefined;
  readonly severity: "error" | "warning";
}

/**
 * Pure deterministic input representing a single source file to extract symbols from.
 */
export interface RepositorySymbolExtractionInput {
  readonly relativePath: string;
  readonly sourceText: string;
  /**
   * Optional language or script kind override. If omitted, determined by file extension.
   */
  readonly language?: "TypeScript" | "JavaScript";
}

/**
 * Result of symbol extraction for a single source file.
 */
export interface RepositorySymbolExtractionResult {
  readonly relativePath: string;
  readonly symbols: readonly RepositorySymbol[];
  readonly diagnostics: readonly RepositorySymbolDiagnostic[];
}

