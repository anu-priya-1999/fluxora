import ts from "typescript";
import type {
  RepositorySymbol,
  RepositorySymbolDiagnostic,
  RepositorySymbolExportInfo,
  RepositorySymbolExtractionInput,
  RepositorySymbolExtractionResult,
  RepositorySymbolKind,
  RepositorySymbolMetadata,
  SourceLocation,
  SourcePosition,
} from "@fluxora/shared-types";

import { isIgnoredPath } from "../detect/detector.ts";

/**
 * File extensions supported for AST symbol extraction by Step 19.
 */
export const SUPPORTED_SYMBOL_EXTENSIONS = new Set<string>([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

/**
 * Checks whether a given relative file path has a supported extension for symbol extraction.
 */
export function isSupportedSymbolFile(relativePath: string): boolean {
  if (isIgnoredPath(relativePath)) {
    return false;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? "";
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0) {
    return false;
  }
  const ext = basename.slice(lastDot).toLowerCase();
  return SUPPORTED_SYMBOL_EXTENSIONS.has(ext);
}

/**
 * Maps file extension to TypeScript ScriptKind.
 */
export function getScriptKindForPath(filePath: string): ts.ScriptKind {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? "";
  const lastDot = basename.lastIndexOf(".");
  const ext = lastDot > 0 ? basename.slice(lastDot).toLowerCase() : "";

  switch (ext) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".mts":
      return ts.ScriptKind.TS;
    case ".cts":
      return ts.ScriptKind.TS;
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * Computes deterministic SourceLocation from AST node and SourceFile.
 */
export function getNodeSourceLocation(node: ts.Node, sourceFile: ts.SourceFile): SourceLocation {
  const startOffset = node.getStart(sourceFile);
  const endOffset = node.getEnd();

  const startLc = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const endLc = sourceFile.getLineAndCharacterOfPosition(endOffset);

  const start: SourcePosition = {
    line: startLc.line + 1,
    column: startLc.character + 1,
    offset: startOffset,
  };

  const end: SourcePosition = {
    line: endLc.line + 1,
    column: endLc.character + 1,
    offset: endOffset,
  };

  return { start, end };
}

/**
 * Builds deterministic symbol ID.
 */
function buildSymbolId(
  relativePath: string,
  kind: RepositorySymbolKind,
  name: string,
  startOffset: number,
  parentName?: string,
): string {
  const qualifiedName = parentName ? `${parentName}.${name}` : name;
  return `${relativePath}#${kind}:${qualifiedName}:${startOffset}`;
}

/**
 * Checks if AST modifiers contain 'export' and 'default'.
 */
function checkModifiersExport(modifiers: ts.NodeArray<ts.ModifierLike> | undefined): {
  isExported: boolean;
  isDefaultExport: boolean;
} {
  let isExported = false;
  let isDefaultExport = false;

  if (modifiers) {
    for (const mod of modifiers) {
      if (mod.kind === ts.SyntaxKind.ExportKeyword) {
        isExported = true;
      } else if (mod.kind === ts.SyntaxKind.DefaultKeyword) {
        isDefaultExport = true;
      }
    }
  }

  return { isExported, isDefaultExport };
}

/**
 * Extracts accessibility modifier if present.
 */
function getAccessibility(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): "public" | "protected" | "private" | undefined {
  if (!modifiers) return undefined;
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.PublicKeyword) return "public";
    if (mod.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
    if (mod.kind === ts.SyntaxKind.PrivateKeyword) return "private";
  }
  return undefined;
}

/**
 * Checks if modifier contains 'static'.
 */
function isStaticModifier(modifiers: ts.NodeArray<ts.ModifierLike> | undefined): boolean {
  if (!modifiers) return false;
  return modifiers.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * Checks if modifier contains 'abstract'.
 */
function isAbstractModifier(modifiers: ts.NodeArray<ts.ModifierLike> | undefined): boolean {
  if (!modifiers) return false;
  return modifiers.some((mod) => mod.kind === ts.SyntaxKind.AbstractKeyword);
}

/**
 * Checks if modifier contains 'async'.
 */
function isAsyncModifier(modifiers: ts.NodeArray<ts.ModifierLike> | undefined): boolean {
  if (!modifiers) return false;
  return modifiers.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword);
}

/**
 * Pure, deterministic AST-based symbol extractor for source files.
 * Does not execute code or resolve cross-file dependencies.
 */
export function extractSymbolsFromSource(
  input: RepositorySymbolExtractionInput,
): RepositorySymbolExtractionResult {
  const { relativePath, sourceText } = input;

  if (!isSupportedSymbolFile(relativePath)) {
    return {
      relativePath,
      symbols: [],
      diagnostics: [],
    };
  }

  const scriptKind = getScriptKindForPath(relativePath);

  // Parse source text into TypeScript AST SourceFile
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      relativePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true, // setParentNodes
      scriptKind,
    );
  } catch (err) {
    return {
      relativePath,
      symbols: [],
      diagnostics: [
        {
          message: err instanceof Error ? err.message : String(err),
          severity: "error",
        },
      ],
    };
  }

  const diagnostics: RepositorySymbolDiagnostic[] = [];
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;

  if (parseDiagnostics && parseDiagnostics.length > 0) {
    for (const diag of parseDiagnostics) {
      let line: number | undefined;
      let column: number | undefined;
      if (typeof diag.start === "number") {
        const lc = sourceFile.getLineAndCharacterOfPosition(diag.start);
        line = lc.line + 1;
        column = lc.character + 1;
      }
      diagnostics.push({
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        line,
        column,
        code: diag.code,
        severity: diag.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      });
    }
  }

  // First pass: scan top-level export declarations like `export { a, b as c }` and `export default identifier;`
  const namedExports = new Map<string, string>(); // identifierName -> exportedAsName
  let exportDefaultIdentifierName: string | null = null;

  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const propertyName = el.propertyName ? el.propertyName.text : el.name.text;
          const exportAs = el.name.text;
          namedExports.set(propertyName, exportAs);
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      // export default identifier; or export = expr;
      if (!stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
        exportDefaultIdentifierName = stmt.expression.text;
      }
    }
  }

  const symbols: RepositorySymbol[] = [];

  function recordSymbol(
    name: string,
    kind: RepositorySymbolKind,
    node: ts.Node,
    directExport: { isExported: boolean; isDefaultExport: boolean },
    parent?: { id: string; name: string },
    metadata?: RepositorySymbolMetadata,
  ): RepositorySymbol {
    let isExported = directExport.isExported;
    let isDefaultExport = directExport.isDefaultExport;
    let exportName: string | undefined = undefined;

    // Check if exported via export { ... } or export default ...
    if (!parent) {
      if (namedExports.has(name)) {
        isExported = true;
        exportName = namedExports.get(name);
        if (exportName === "default") {
          isDefaultExport = true;
        }
      }
      if (exportDefaultIdentifierName === name) {
        isExported = true;
        isDefaultExport = true;
        exportName = "default";
      }
      if (isDefaultExport && !exportName) {
        exportName = "default";
      } else if (isExported && !exportName) {
        exportName = name;
      }
    }

    const location = getNodeSourceLocation(node, sourceFile);
    const id = buildSymbolId(relativePath, kind, name, location.start.offset, parent?.name);

    const exportInfo: RepositorySymbolExportInfo = {
      isExported,
      isDefaultExport,
      ...(exportName !== undefined ? { exportName } : {}),
    };

    const sym: RepositorySymbol = {
      id,
      name,
      kind,
      relativePath,
      location,
      exported: exportInfo,
      ...(parent ? { parentSymbolId: parent.id, parentName: parent.name } : {}),
      ...(metadata ? { metadata } : {}),
    };

    symbols.push(sym);
    return sym;
  }

  function processClassMembers(
    classDeclaration: ts.ClassDeclaration | ts.ClassExpression,
    parentClassSymbol: RepositorySymbol,
  ): void {
    for (const member of classDeclaration.members) {
      if (ts.isMethodDeclaration(member)) {
        const methodName = member.name ? member.name.getText(sourceFile) : undefined;
        if (!methodName) continue;

        const isStatic = isStaticModifier(member.modifiers);
        const isAbstract = isAbstractModifier(member.modifiers);
        const isAsync = isAsyncModifier(member.modifiers);
        const accessibility = getAccessibility(member.modifiers);
        const isGenerator = member.asteriskToken !== undefined;

        const metadata: RepositorySymbolMetadata = {
          ...(isAsync ? { isAsync: true } : {}),
          ...(isGenerator ? { isGenerator: true } : {}),
          ...(isStatic ? { isStatic: true } : {}),
          ...(isAbstract ? { isAbstract: true } : {}),
          ...(accessibility ? { accessibility } : {}),
          ...(member.type ? { returnType: member.type.getText(sourceFile) } : {}),
        };

        recordSymbol(
          methodName,
          "method",
          member,
          { isExported: false, isDefaultExport: false },
          { id: parentClassSymbol.id, name: parentClassSymbol.name },
          metadata,
        );
      }
    }
  }

  // Iterate top-level statements
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      const { isExported, isDefaultExport } = checkModifiersExport(stmt.modifiers);
      const name = stmt.name ? stmt.name.text : isDefaultExport ? "default" : undefined;
      if (!name) continue;

      const isAsync = isAsyncModifier(stmt.modifiers);
      const isGenerator = stmt.asteriskToken !== undefined;

      const metadata: RepositorySymbolMetadata = {
        ...(isAsync ? { isAsync: true } : {}),
        ...(isGenerator ? { isGenerator: true } : {}),
        ...(stmt.type ? { returnType: stmt.type.getText(sourceFile) } : {}),
      };

      recordSymbol(name, "function", stmt, { isExported, isDefaultExport }, undefined, metadata);
    } else if (ts.isClassDeclaration(stmt)) {
      const { isExported, isDefaultExport } = checkModifiersExport(stmt.modifiers);
      const name = stmt.name ? stmt.name.text : isDefaultExport ? "default" : undefined;
      if (!name) continue;

      const isAbstract = isAbstractModifier(stmt.modifiers);
      const metadata: RepositorySymbolMetadata = {
        ...(isAbstract ? { isAbstract: true } : {}),
      };

      const classSym = recordSymbol(
        name,
        "class",
        stmt,
        { isExported, isDefaultExport },
        undefined,
        metadata,
      );

      processClassMembers(stmt, classSym);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const { isExported, isDefaultExport } = checkModifiersExport(stmt.modifiers);
      const name = stmt.name.text;
      recordSymbol(name, "interface", stmt, { isExported, isDefaultExport });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      const { isExported, isDefaultExport } = checkModifiersExport(stmt.modifiers);
      const name = stmt.name.text;
      recordSymbol(name, "type_alias", stmt, { isExported, isDefaultExport });
    } else if (ts.isEnumDeclaration(stmt)) {
      const { isExported, isDefaultExport } = checkModifiersExport(stmt.modifiers);
      const name = stmt.name.text;
      const isConst = (stmt.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ConstKeyword);
      recordSymbol(name, "enum", stmt, { isExported, isDefaultExport }, undefined, {
        ...(isConst ? { isConst: true } : {}),
      });
    } else if (ts.isVariableStatement(stmt)) {
      const { isExported } = checkModifiersExport(stmt.modifiers);
      const isConstFlag = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);

      for (const decl of stmt.declarationList.declarations) {
        const initializer = decl.initializer;
        const isArrowOrFuncExpr =
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));

        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;

          // Check if initializer is function expression or arrow function
          if (isArrowOrFuncExpr && initializer) {
            const isAsync = isAsyncModifier(initializer.modifiers);
            const isGenerator =
              ts.isFunctionExpression(initializer) && initializer.asteriskToken !== undefined;

            const metadata: RepositorySymbolMetadata = {
              ...(isAsync ? { isAsync: true } : {}),
              ...(isGenerator ? { isGenerator: true } : {}),
              ...(initializer.type ? { returnType: initializer.type.getText(sourceFile) } : {}),
              ...(decl.type ? { typeAnnotation: decl.type.getText(sourceFile) } : {}),
              isConst: isConstFlag,
            };

            recordSymbol(
              name,
              "function",
              decl,
              { isExported, isDefaultExport: false },
              undefined,
              metadata,
            );
          } else {
            const kind: RepositorySymbolKind = isConstFlag ? "constant" : "variable";
            const metadata: RepositorySymbolMetadata = {
              isConst: isConstFlag,
              ...(decl.type ? { typeAnnotation: decl.type.getText(sourceFile) } : {}),
            };

            recordSymbol(
              name,
              kind,
              decl,
              { isExported, isDefaultExport: false },
              undefined,
              metadata,
            );
          }
        } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          // Binding pattern (e.g. const { a, b: aliasB } = obj; or const [x, y] = arr;)
          for (const element of decl.name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
              const name = element.name.text;
              const kind: RepositorySymbolKind = isConstFlag ? "constant" : "variable";
              const metadata: RepositorySymbolMetadata = {
                isConst: isConstFlag,
              };

              recordSymbol(
                name,
                kind,
                element,
                { isExported, isDefaultExport: false },
                undefined,
                metadata,
              );
            }
          }
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      // export default function() {} or export default class {} or export default (...) => {}
      if (!stmt.isExportEquals) {
        const expr = stmt.expression;
        if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
          const name = ts.isFunctionExpression(expr) && expr.name ? expr.name.text : "default";
          const isAsync = isAsyncModifier(expr.modifiers);
          const metadata: RepositorySymbolMetadata = {
            ...(isAsync ? { isAsync: true } : {}),
            ...(expr.type ? { returnType: expr.type.getText(sourceFile) } : {}),
          };
          recordSymbol(
            name,
            "function",
            stmt,
            { isExported: true, isDefaultExport: true },
            undefined,
            metadata,
          );
        } else if (ts.isClassExpression(expr)) {
          const name = expr.name ? expr.name.text : "default";
          const classSym = recordSymbol(
            name,
            "class",
            stmt,
            { isExported: true, isDefaultExport: true },
          );
          processClassMembers(expr, classSym);
        }
      }
    }
  }

  return {
    relativePath,
    symbols,
    diagnostics,
  };
}

