import path from "node:path";
import Parser from "web-tree-sitter";
import type {
  SupportedLanguage,
  TreeSitterDiagnostic,
  TreeSitterParseInput,
  TreeSitterParseResult,
  TreeSitterSourcePosition,
  TreeSitterSourceRange,
  TreeSitterStructuralUnit,
} from "@fluxora/shared-types";
import { isIgnoredPath } from "../detect/detector.ts";
import { detectFileLanguage, getExtension, getWasmFileName } from "./languages.ts";

let isParserInitialized = false;
const loadedLanguages = new Map<string, unknown>();
let sharedParser: Parser | null = null;

/**
 * Initializes web-tree-sitter runtime once deterministically.
 */
async function ensureParserInitialized(): Promise<Parser> {
  if (!isParserInitialized) {
    await Parser.init();
    isParserInitialized = true;
  }
  if (sharedParser === null) {
    sharedParser = new Parser();
  }
  return sharedParser;
}

/**
 * Loads and caches a WASM language grammar by filename.
 */
async function loadWasmLanguage(wasmFile: string): Promise<unknown | null> {
  if (loadedLanguages.has(wasmFile)) {
    return loadedLanguages.get(wasmFile)!;
  }
  try {
    const wasmPath = path.resolve("node_modules/tree-sitter-wasms/out", wasmFile);
    const lang = await Parser.Language.load(wasmPath);
    loadedLanguages.set(wasmFile, lang);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Converts Tree-sitter Point and offset to a 1-based line/col SourcePosition.
 */
function createSourcePosition(point: { row: number; column: number }, offset: number): TreeSitterSourcePosition {
  return {
    line: point.row + 1,
    column: point.column + 1,
    offset,
  };
}

/**
 * Converts Tree-sitter node positions to a SourceRange.
 */
function createSourceRange(node: Parser.SyntaxNode): TreeSitterSourceRange {
  return {
    start: createSourcePosition(node.startPosition, node.startIndex),
    end: createSourcePosition(node.endPosition, node.endIndex),
  };
}

/**
 * Normalizes text line offsets for line/column calculation in manual parsers.
 */
function getLineColFromOffset(sourceText: string, offset: number): TreeSitterSourcePosition {
  const safeOffset = Math.max(0, Math.min(offset, sourceText.length));
  const sub = sourceText.slice(0, safeOffset);
  const lines = sub.split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  return { line, column, offset: safeOffset };
}

/**
 * Extracts generic structural units from a Tree-sitter AST.
 */
function extractAstStructuralUnits(
  root: Parser.SyntaxNode,
  language: SupportedLanguage,
): TreeSitterStructuralUnit[] {
  const units: TreeSitterStructuralUnit[] = [];

  const visit = (node: Parser.SyntaxNode): void => {
    const range = createSourceRange(node);

    if (language === "JSON") {
      if (node.type === "pair") {
        const keyNode = node.childForFieldName("key") ?? node.children[0];
        const valNode = node.childForFieldName("value") ?? node.children[1];
        const keyName = keyNode ? keyNode.text.replace(/^["']|["']$/g, "") : "property";
        const valKind = valNode ? valNode.type : "unknown";
        units.push({
          kind: "json_property",
          name: keyName,
          range,
          detail: `type:${valKind}`,
        });
      }
    } else if (language === "CSS") {
      if (node.type === "rule_set") {
        const selectorNode = node.children.find((c) => c.type === "selectors" || c.type === "class_selector" || c.type === "id_selector" || c.type === "tag_name");
        const selectorText = selectorNode ? selectorNode.text.trim() : node.text.split("{")[0]?.trim() ?? "rule";
        units.push({
          kind: "css_rule",
          name: selectorText,
          range,
          detail: "selector",
        });
      }
    } else if (language === "HTML") {
      if (node.type === "element" || node.type === "script_element" || node.type === "style_element") {
        const startTag = node.children.find((c) => c.type === "start_tag" || c.type === "self_closing_tag");
        const tagNameNode = startTag?.children.find((c) => c.type === "tag_name") ?? node.children.find((c) => c.type === "tag_name");
        const tagName = tagNameNode ? tagNameNode.text.toLowerCase() : "element";
        units.push({
          kind: "html_element",
          name: tagName,
          range,
          detail: `<${tagName}>`,
        });
      }
    } else if (language === "TypeScript" || language === "JavaScript") {
      if (
        node.type === "function_declaration" ||
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "type_alias_declaration" ||
        node.type === "import_statement" ||
        node.type === "export_statement"
      ) {
        const nameNode = node.childForFieldName("name") ?? node.children.find((c) => c.type === "identifier" || c.type === "type_identifier");
        const name = nameNode ? nameNode.text : node.type;
        units.push({
          kind: "code_block",
          name,
          range,
          detail: node.type,
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        visit(child);
      }
    }
  };

  visit(root);
  return units;
}

/**
 * Deterministic AST parser for Markdown files (headings, code blocks, sections).
 */
function parseMarkdownStructure(sourceText: string): {
  rootNodeType: string;
  totalNodeCount: number;
  structuralUnits: TreeSitterStructuralUnit[];
  diagnostics: TreeSitterDiagnostic[];
} {
  const units: TreeSitterStructuralUnit[] = [];
  const diagnostics: TreeSitterDiagnostic[] = [];
  const lines = sourceText.split("\n");

  let nodeCount = 1; // Document root
  let inCodeBlock = false;
  let codeBlockStartLine = 0;
  let codeBlockLang = "";
  let currentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? "";
    const lineStartOffset = currentOffset;
    const lineEndOffset = currentOffset + lineText.length;
    currentOffset += lineText.length + 1; // +1 for newline

    const trimmed = lineText.trim();

    // Check fenced code block
    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockStartLine = i + 1;
        codeBlockLang = trimmed.slice(3).trim();
        nodeCount++;
      } else {
        inCodeBlock = false;
        const startPos = getLineColFromOffset(sourceText, lineStartOffset);
        const endPos = getLineColFromOffset(sourceText, lineEndOffset);
        units.push({
          kind: "code_block",
          name: codeBlockLang.length > 0 ? codeBlockLang : "fenced_code_block",
          range: { start: startPos, end: endPos },
          detail: `lines:${codeBlockStartLine}-${i + 1}`,
        });
        nodeCount++;
      }
      continue;
    }

    if (inCodeBlock) {
      nodeCount++;
      continue;
    }

    // Check ATX headings (# Heading)
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      const startPos = getLineColFromOffset(sourceText, lineStartOffset);
      const endPos = getLineColFromOffset(sourceText, lineEndOffset);
      units.push({
        kind: "markdown_heading",
        name: headingText,
        range: { start: startPos, end: endPos },
        detail: `h${level}`,
      });
      nodeCount += 2;
    } else if (trimmed.length > 0) {
      nodeCount++;
    }
  }

  if (inCodeBlock) {
    diagnostics.push({
      message: "Unclosed markdown fenced code block at end of file",
      line: lines.length,
      severity: "warning",
    });
  }

  return {
    rootNodeType: "document",
    totalNodeCount: nodeCount,
    structuralUnits: units,
    diagnostics,
  };
}

/**
 * Executes Tree-sitter fallback parsing on a source file.
 */
export async function parseTreeSitterFile(input: TreeSitterParseInput): Promise<TreeSitterParseResult> {
  const relativePath = input.relativePath.replace(/\\/g, "/");
  const id = `${relativePath}#tree-sitter`;

  // 1. Check ignored path
  if (isIgnoredPath(relativePath)) {
    return {
      id,
      relativePath,
      language: "unsupported",
      parserUsed: "none",
      success: false,
      usedFallback: false,
      diagnostics: [
        {
          message: `Path '${relativePath}' is in an ignored directory`,
          severity: "warning",
        },
      ],
    };
  }

  // 2. Determine file language
  const language = input.language ?? detectFileLanguage(relativePath);
  if (language === "unsupported") {
    return {
      id,
      relativePath,
      language: "unsupported",
      parserUsed: "none",
      success: false,
      usedFallback: false,
      diagnostics: [
        {
          message: `Unsupported file extension for path '${relativePath}'`,
          severity: "warning",
        },
      ],
    };
  }

  // 3. Primary parser check for TS/JS
  if ((language === "TypeScript" || language === "JavaScript") && input.primaryParserSucceeded === true) {
    return {
      id,
      relativePath,
      language,
      parserUsed: "compiler-primary",
      success: true,
      usedFallback: false,
      diagnostics: [],
    };
  }

  // 4. Handle Markdown parser path
  if (language === "Markdown") {
    const mdResult = parseMarkdownStructure(input.sourceText);
    const startPos = getLineColFromOffset(input.sourceText, 0);
    const endPos = getLineColFromOffset(input.sourceText, input.sourceText.length);

    return {
      id,
      relativePath,
      language: "Markdown",
      parserUsed: "tree-sitter-markdown",
      success: true,
      usedFallback: true,
      diagnostics: mdResult.diagnostics,
      rootNode: {
        type: mdResult.rootNodeType,
        textSnippet: input.sourceText.slice(0, 100),
        range: { start: startPos, end: endPos },
        childCount: mdResult.structuralUnits.length,
      },
      genericStructure: {
        rootNodeType: mdResult.rootNodeType,
        totalNodeCount: mdResult.totalNodeCount,
        structuralUnits: mdResult.structuralUnits,
      },
    };
  }

  // 5. Tree-sitter WASM grammars (JSON, CSS, HTML, TS/JS fallback)
  const ext = getExtension(relativePath);
  const wasmFile = getWasmFileName(language, ext);

  if (!wasmFile) {
    return {
      id,
      relativePath,
      language,
      parserUsed: "none",
      success: false,
      usedFallback: false,
      diagnostics: [
        {
          message: `No Tree-sitter grammar available for language '${language}'`,
          severity: "warning",
        },
      ],
    };
  }

  try {
    const parser = await ensureParserInitialized();
    const langObj = await loadWasmLanguage(wasmFile);

    if (!langObj) {
      return {
        id,
        relativePath,
        language,
        parserUsed: "none",
        success: false,
        usedFallback: false,
        diagnostics: [
          {
            message: `Failed to load Tree-sitter grammar WASM '${wasmFile}'`,
            severity: "error",
          },
        ],
      };
    }

    parser.setLanguage(langObj as Parser.Language);
    const tree = parser.parse(input.sourceText);
    const root = tree.rootNode;

    const diagnostics: TreeSitterDiagnostic[] = [];
    let totalNodeCount = 0;
    let hasErrorNode = root.hasError();

    // Traverse tree to collect node counts and error diagnostics
    const traverse = (node: Parser.SyntaxNode): void => {
      totalNodeCount++;
      if (node.type === "ERROR" || node.isMissing()) {
        hasErrorNode = true;
        const startLine = node.startPosition.row + 1;
        const startCol = node.startPosition.column + 1;
        diagnostics.push({
          message: `Syntax error near '${node.text.slice(0, 40)}'`,
          line: startLine,
          column: startCol,
          severity: "error",
        });
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
          traverse(child);
        }
      }
    };
    traverse(root);

    // Special check for JSON native validation to catch subtle malformed JSON
    if (language === "JSON") {
      try {
        JSON.parse(input.sourceText);
      } catch (e: unknown) {
        hasErrorNode = true;
        const msg = e instanceof Error ? e.message : "Invalid JSON syntax";
        diagnostics.push({
          message: `JSON parse error: ${msg}`,
          severity: "error",
        });
      }
    }

    const structuralUnits = extractAstStructuralUnits(root, language);

    // Sort diagnostics and structural units deterministically
    diagnostics.sort((a, b) => {
      const lineDiff = (a.line ?? 0) - (b.line ?? 0);
      if (lineDiff !== 0) return lineDiff;
      const colDiff = (a.column ?? 0) - (b.column ?? 0);
      if (colDiff !== 0) return colDiff;
      return a.message.localeCompare(b.message);
    });

    structuralUnits.sort((a, b) => {
      const offsetDiff = a.range.start.offset - b.range.start.offset;
      if (offsetDiff !== 0) return offsetDiff;
      return a.name.localeCompare(b.name);
    });

    const parserName = `tree-sitter-${language.toLowerCase()}`;

    return {
      id,
      relativePath,
      language,
      parserUsed: parserName,
      success: !hasErrorNode,
      usedFallback: true,
      diagnostics,
      rootNode: {
        type: root.type,
        textSnippet: input.sourceText.slice(0, 100),
        range: createSourceRange(root),
        childCount: root.childCount,
        isError: hasErrorNode,
      },
      genericStructure: {
        rootNodeType: root.type,
        totalNodeCount,
        structuralUnits,
      },
    };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      id,
      relativePath,
      language,
      parserUsed: `tree-sitter-${language.toLowerCase()}`,
      success: false,
      usedFallback: true,
      diagnostics: [
        {
          message: `Tree-sitter parse failure: ${errorMsg}`,
          severity: "error",
        },
      ],
    };
  }
}
