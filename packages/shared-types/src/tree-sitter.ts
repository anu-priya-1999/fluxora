import type { SupportedLanguage } from "./detection.ts";

/**
 * 1-based line/column and 0-based character offset for Tree-sitter ranges.
 */
export interface TreeSitterSourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/**
 * Source range for Tree-sitter AST nodes and extracted structural units.
 */
export interface TreeSitterSourceRange {
  readonly start: TreeSitterSourcePosition;
  readonly end: TreeSitterSourcePosition;
}

/**
 * Diagnostic report for syntax errors or fallback issues.
 */
export interface TreeSitterDiagnostic {
  readonly message: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly severity: "error" | "warning";
}

/**
 * Representative node summary of the Tree-sitter parse tree.
 */
export interface TreeSitterSyntaxNodeInfo {
  readonly type: string;
  readonly textSnippet?: string | undefined;
  readonly range: TreeSitterSourceRange;
  readonly childCount: number;
  readonly isError?: boolean | undefined;
}

/**
 * High-level generic structural element extracted from non-TS/JS or fallback files.
 */
export interface TreeSitterStructuralUnit {
  readonly kind: "json_property" | "css_rule" | "html_element" | "markdown_heading" | "code_block" | "generic_node";
  readonly name: string;
  readonly range: TreeSitterSourceRange;
  readonly detail?: string | undefined;
}

/**
 * High-level generic structure information.
 */
export interface TreeSitterGenericStructure {
  readonly rootNodeType: string;
  readonly totalNodeCount: number;
  readonly structuralUnits: readonly TreeSitterStructuralUnit[];
}

/**
 * Input for the Tree-sitter fallback parser.
 */
export interface TreeSitterParseInput {
  readonly relativePath: string;
  readonly sourceText: string;
  /**
   * Optional explicitly detected language or override.
   */
  readonly language?: SupportedLanguage | undefined;
  /**
   * Optional flag indicating if the primary TS/JS compiler API succeeded for this file.
   * If true and the file is TS/JS, Tree-sitter fallback will NOT run.
   */
  readonly primaryParserSucceeded?: boolean | undefined;
}

/**
 * Strongly typed result model produced by the Tree-sitter fallback parser pass.
 */
export interface TreeSitterParseResult {
  /**
   * Stable deterministic result identifier.
   * Format: `${relativePath}#tree-sitter`
   */
  readonly id: string;
  readonly relativePath: string;
  readonly language: SupportedLanguage | "unsupported";
  readonly parserUsed: string;
  readonly success: boolean;
  readonly usedFallback: boolean;
  readonly diagnostics: readonly TreeSitterDiagnostic[];
  readonly rootNode?: TreeSitterSyntaxNodeInfo | undefined;
  readonly genericStructure?: TreeSitterGenericStructure | undefined;
}

