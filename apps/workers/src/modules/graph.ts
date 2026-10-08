import ts from "typescript";

import type {
  RepositoryModuleEdge,
  RepositoryModuleGraph,
  RepositoryModuleGraphDiagnostic,
  RepositoryModuleImportedName,
  RepositoryModuleImportKind,
  RepositoryModuleReference,
  RepositoryModuleReferenceKind,
  RepositoryModuleResolutionStatus,
  SourceLocation,
} from "@fluxora/shared-types";

import { isIgnoredPath } from "../detect/detector.ts";
import {
  getNodeSourceLocation,
  getScriptKindForPath,
  isSupportedSymbolFile,
} from "../symbols/extractor.ts";

/**
 * In-memory snapshot files representation.
 * Maps normalized relative POSIX path (e.g. "src/index.ts") to file content string.
 */
export type SnapshotFileMap = ReadonlyMap<string, string>;

/**
 * Input for graph extraction over a repository snapshot.
 */
export interface RepositoryModuleGraphInput {
  /**
   * Complete map of relative file path -> content string for the repository snapshot.
   */
  readonly files: SnapshotFileMap;
  /**
   * Root path representation (defaults to "/" or "repo").
   */
  readonly rootDir?: string;
  /**
   * Optional custom tsconfig path (defaults to "tsconfig.json").
   */
  readonly tsconfigPath?: string;
}

/**
 * Parsed tsconfig compiler options extracted for module resolution.
 */
export interface ParsedTsconfigInfo {
  readonly options: ts.CompilerOptions;
  readonly configFilePath?: string;
}

/**
 * Normalizes any file path to forward slashes with no trailing slash.
 */
export function normalizePosixPath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Converts a relative repository path to a virtual absolute path under rootDir.
 */
function toVirtualAbsolutePath(relativePath: string, rootDir: string): string {
  const normRel = normalizePosixPath(relativePath);
  const normRoot = normalizePosixPath(rootDir);
  if (normRoot.endsWith("/")) {
    return `${normRoot}${normRel}`;
  }
  return `${normRoot}/${normRel}`;
}

/**
 * Converts a virtual absolute path back to a relative repository path.
 */
function toRelativeRepositoryPath(virtualAbsPath: string, rootDir: string): string {
  let normPath = normalizePosixPath(virtualAbsPath);
  let normRoot = normalizePosixPath(rootDir);
  if (!normRoot.endsWith("/")) {
    normRoot = `${normRoot}/`;
  }
  if (normPath.startsWith(normRoot)) {
    normPath = normPath.slice(normRoot.length);
  } else if (normPath.startsWith("/")) {
    normPath = normPath.slice(1);
  }
  return normPath;
}

/**
 * Pure, deterministic parser for repository tsconfig.json (and tsconfig.*.json).
 * Reads from the in-memory SnapshotFileMap without touching disk or network.
 */
export function parseSnapshotTsconfig(
  files: SnapshotFileMap,
  rootDir: string = "/repo",
  tsconfigPath: string = "tsconfig.json",
): ParsedTsconfigInfo {
  const normalizedTsconfig = normalizePosixPath(tsconfigPath);
  const tsconfigContent = files.get(normalizedTsconfig);

  const virtualRootDir = normalizePosixPath(rootDir);

  if (!tsconfigContent) {
    return {
      options: {
        moduleResolution: ts.ModuleResolutionKind.Node10,
      },
    };
  }

  // Parse JSON config with comments support via TypeScript's readConfigFile host
  const parseResult = ts.readConfigFile(
    toVirtualAbsolutePath(normalizedTsconfig, virtualRootDir),
    (filePath: string) => {
      const rel = toRelativeRepositoryPath(filePath, virtualRootDir);
      return files.get(rel);
    },
  );

  if (parseResult.error || !parseResult.config) {
    return {
      options: {
        moduleResolution: ts.ModuleResolutionKind.Node10,
      },
      configFilePath: normalizedTsconfig,
    };
  }

  // Create in-memory ParseConfigHost that resolves extends from files
  const parseConfigHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (filePath: string) => {
      const rel = toRelativeRepositoryPath(filePath, virtualRootDir);
      return files.has(rel);
    },
    readFile: (filePath: string) => {
      const rel = toRelativeRepositoryPath(filePath, virtualRootDir);
      return files.get(rel);
    },
  };

  const parsed = ts.parseJsonConfigFileContent(
    parseResult.config,
    parseConfigHost,
    virtualRootDir,
    undefined,
    toVirtualAbsolutePath(normalizedTsconfig, virtualRootDir),
  );

  return {
    options: parsed.options,
    configFilePath: normalizedTsconfig,
  };
}

/**
 * Creates an in-memory ts.ModuleResolutionHost backed strictly by the repository SnapshotFileMap.
 */
export function createSnapshotModuleResolutionHost(
  files: SnapshotFileMap,
  virtualRootDir: string = "/repo",
): ts.ModuleResolutionHost {
  // Pre-compute directory set for fast directoryExists lookups
  const directorySet = new Set<string>();
  directorySet.add(normalizePosixPath(virtualRootDir));

  for (const relativePath of files.keys()) {
    const norm = normalizePosixPath(relativePath);
    const virtualAbs = toVirtualAbsolutePath(norm, virtualRootDir);
    const segments = virtualAbs.split("/").filter((s) => s.length > 0);
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      current += "/" + segments[i];
      directorySet.add(current);
    }
  }

  return {
    fileExists(fileName: string): boolean {
      const rel = toRelativeRepositoryPath(fileName, virtualRootDir);
      return files.has(rel);
    },
    readFile(fileName: string): string | undefined {
      const rel = toRelativeRepositoryPath(fileName, virtualRootDir);
      return files.get(rel);
    },
    directoryExists(directoryName: string): boolean {
      const norm = normalizePosixPath(directoryName);
      return directorySet.has(norm);
    },
    getCurrentDirectory(): string {
      return virtualRootDir;
    },
    getDirectories(): string[] {
      return [];
    },
    useCaseSensitiveFileNames: true,
  };
}

/**
 * Determines whether a module specifier is an internal relative reference.
 */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  );
}

/**
 * Resolves a module specifier against the snapshot using tsconfig options.
 */
export function resolveModuleSpecifier(
  specifier: string,
  sourceFile: string,
  compilerOptions: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
  files: SnapshotFileMap,
  virtualRootDir: string = "/repo",
): {
  status: RepositoryModuleResolutionStatus;
  targetFile?: string;
} {
  const containingVirtualFile = toVirtualAbsolutePath(sourceFile, virtualRootDir);

  // Attempt standard TypeScript module resolution first
  const resolution = ts.resolveModuleName(
    specifier,
    containingVirtualFile,
    compilerOptions,
    host,
  );

  if (resolution.resolvedModule) {
    const target = toRelativeRepositoryPath(
      resolution.resolvedModule.resolvedFileName,
      virtualRootDir,
    );
    if (files.has(target)) {
      return {
        status: "internal",
        targetFile: target,
      };
    }
  }

  // Fallback probing for relative specifiers where ts.resolveModuleName did not resolve
  // (e.g. .cjs, .mjs, or specific extension permutations without full moduleResolution configuration)
  if (isRelativeSpecifier(specifier)) {
    const sourceDir = sourceFile.includes("/")
      ? sourceFile.slice(0, sourceFile.lastIndexOf("/"))
      : "";
    // Resolve relative path against sourceDir
    const combined = sourceDir.length > 0 ? `${sourceDir}/${specifier}` : specifier;
    // Normalize path segments (handle . and ..)
    const segments = combined.split("/").filter((s) => s.length > 0 && s !== ".");
    const resolvedSegments: string[] = [];
    for (const seg of segments) {
      if (seg === "..") {
        resolvedSegments.pop();
      } else {
        resolvedSegments.push(seg);
      }
    }
    const basePath = resolvedSegments.join("/");

    // 1. Direct path check
    if (files.has(basePath)) {
      return { status: "internal", targetFile: basePath };
    }

    // 2. Candidate extensions
    const candidateExtensions = [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mts",
      ".cts",
      ".mjs",
      ".cjs",
    ];

    for (const ext of candidateExtensions) {
      const candidate = `${basePath}${ext}`;
      if (files.has(candidate)) {
        return { status: "internal", targetFile: candidate };
      }
    }

    // 3. Directory index candidates
    for (const ext of candidateExtensions) {
      const indexCandidate = `${basePath}/index${ext}`;
      if (files.has(indexCandidate)) {
        return { status: "internal", targetFile: indexCandidate };
      }
    }

    // Relative specifier that could not be resolved in the repository
    return {
      status: "unresolved",
    };
  }

  // Check if path mapping in compilerOptions matched but destination file is missing
  if (compilerOptions.paths) {
    for (const pattern of Object.keys(compilerOptions.paths)) {
      if (pattern === specifier) {
        return { status: "unresolved" };
      }
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        if (specifier.startsWith(prefix)) {
          // Specifier matches alias pattern, so it was intended as an internal path alias
          return { status: "unresolved" };
        }
      }
    }
  }

  // If specifier is not relative and does not match tsconfig path aliases, it is an external package import
  return {
    status: "external",
  };
}

/**
 * Raw extracted syntactic reference before cross-file resolution.
 */
interface RawModuleReference {
  readonly specifier: string | null; // null if dynamic expression cannot be statically resolved
  readonly referenceKind: RepositoryModuleReferenceKind;
  readonly importKind: RepositoryModuleImportKind;
  readonly names: readonly RepositoryModuleImportedName[];
  readonly location: SourceLocation;
  readonly isTypeOnly?: boolean;
}

/**
 * Extracts raw syntactic import/export statements from an AST SourceFile.
 */
function extractRawModuleReferences(
  sourceFile: ts.SourceFile,
  sourcePath: string,
): {
  references: RawModuleReference[];
  diagnostics: RepositoryModuleGraphDiagnostic[];
} {
  const references: RawModuleReference[] = [];
  const diagnostics: RepositoryModuleGraphDiagnostic[] = [];

  // Parse diagnostics from TypeScript parser
  const parseDiagnostics = (
    sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;

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
        file: sourcePath,
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(diag.code !== undefined ? { code: diag.code } : {}),
        severity: diag.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      });
    }
  }

  // Visitor to traverse AST statements and expressions
  function visit(node: ts.Node): void {
    // 1. Static Import Declaration: import ... from "..."
    if (ts.isImportDeclaration(node)) {
      const isTypeOnly = node.importClause?.isTypeOnly ?? false;
      const location = getNodeSourceLocation(node, sourceFile);

      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;

        if (!node.importClause) {
          // Side-effect import: import "./setup"
          references.push({
            specifier,
            referenceKind: "import",
            importKind: "side_effect_import",
            names: [],
            location,
            ...(isTypeOnly ? { isTypeOnly: true } : {}),
          });
        } else {
          const names: RepositoryModuleImportedName[] = [];
          let importKind: RepositoryModuleImportKind = "named_import";

          // Default import: import Foo from "./foo"
          if (node.importClause.name) {
            names.push({
              name: "default",
              alias: node.importClause.name.text,
              ...(isTypeOnly ? { isTypeOnly: true } : {}),
            });
            importKind = "default_import";
          }

          // Named or Namespace imports: import { a, b as c } or import * as Utils
          if (node.importClause.namedBindings) {
            if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              names.push({
                name: "*",
                alias: node.importClause.namedBindings.name.text,
                ...(isTypeOnly ? { isTypeOnly: true } : {}),
              });
              importKind = "namespace_import";
            } else if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const elem of node.importClause.namedBindings.elements) {
                const elemTypeOnly = isTypeOnly || elem.isTypeOnly;
                const origName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                const aliasName = elem.propertyName ? elem.name.text : undefined;
                names.push({
                  name: origName,
                  ...(aliasName !== undefined ? { alias: aliasName } : {}),
                  ...(elemTypeOnly ? { isTypeOnly: true } : {}),
                });
              }
              if (!node.importClause.name) {
                importKind = "named_import";
              }
            }
          }

          references.push({
            specifier,
            referenceKind: "import",
            importKind,
            names,
            location,
            ...(isTypeOnly ? { isTypeOnly: true } : {}),
          });
        }
      }
      return; // No need to visit children of static import
    }

    // 2. Export Declarations with moduleSpecifier: export ... from "./utils"
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const isTypeOnly = node.isTypeOnly;
        const location = getNodeSourceLocation(node, sourceFile);
        const names: RepositoryModuleImportedName[] = [];

        if (!node.exportClause) {
          // export * from "./utils"
          references.push({
            specifier,
            referenceKind: "re_export",
            importKind: "star_re_export",
            names: [{ name: "*", ...(isTypeOnly ? { isTypeOnly: true } : {}) }],
            location,
            ...(isTypeOnly ? { isTypeOnly: true } : {}),
          });
        } else if (ts.isNamespaceExport(node.exportClause)) {
          // export * as utils from "./utils"
          references.push({
            specifier,
            referenceKind: "re_export",
            importKind: "namespace_re_export",
            names: [
              {
                name: "*",
                alias: node.exportClause.name.text,
                ...(isTypeOnly ? { isTypeOnly: true } : {}),
              },
            ],
            location,
            ...(isTypeOnly ? { isTypeOnly: true } : {}),
          });
        } else if (ts.isNamedExports(node.exportClause)) {
          // export { a, b as c } from "./utils"
          for (const elem of node.exportClause.elements) {
            const elemTypeOnly = isTypeOnly || elem.isTypeOnly;
            const origName = elem.propertyName ? elem.propertyName.text : elem.name.text;
            const aliasName = elem.propertyName ? elem.name.text : undefined;
            names.push({
              name: origName,
              ...(aliasName !== undefined ? { alias: aliasName } : {}),
              ...(elemTypeOnly ? { isTypeOnly: true } : {}),
            });
          }
          references.push({
            specifier,
            referenceKind: "re_export",
            importKind: "named_re_export",
            names,
            location,
            ...(isTypeOnly ? { isTypeOnly: true } : {}),
          });
        }
        return; // Don't visit children
      }
    }

    // 3. Dynamic import: import("./foo") or import(expr)
    if (node.kind === ts.SyntaxKind.CallExpression) {
      const call = node as ts.CallExpression;
      if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const location = getNodeSourceLocation(call, sourceFile);
        if (call.arguments.length > 0) {
          const arg = call.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            references.push({
              specifier: arg.text,
              referenceKind: "dynamic_import",
              importKind: "dynamic_import",
              names: [],
              location,
            });
          } else {
            // Dynamic import with non-static argument (e.g. import(variable))
            references.push({
              specifier: null,
              referenceKind: "dynamic_import",
              importKind: "dynamic_import",
              names: [],
              location,
            });
          }
        }
      }
    }

    // 4. CommonJS require: require("./foo") or require(expr)
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1
      ) {
        const location = getNodeSourceLocation(node, sourceFile);
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          references.push({
            specifier: arg.text,
            referenceKind: "require",
            importKind: "require",
            names: [],
            location,
          });
        } else {
          // require with non-static argument (e.g. require(pathVar))
          references.push({
            specifier: null,
            referenceKind: "require",
            importKind: "require",
            names: [],
            location,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { references, diagnostics };
}

/**
 * Builds deterministic reference ID.
 */
function buildReferenceId(
  sourceFile: string,
  referenceKind: RepositoryModuleReferenceKind,
  offset: number,
): string {
  return `${sourceFile}#ref:${referenceKind}:${offset}`;
}

/**
 * Builds deterministic edge ID.
 */
function buildEdgeId(
  sourceFile: string,
  targetOrSpecifier: string,
  edgeKind: RepositoryModuleReferenceKind,
  offset: number,
): string {
  return `${sourceFile}->${targetOrSpecifier}#${edgeKind}:${offset}`;
}

/**
 * Extracts the full import/export graph for a repository snapshot.
 *
 * Deterministic, reproducible, static-analysis-only, non-evaluating.
 */
export function extractRepositoryModuleGraph(
  input: RepositoryModuleGraphInput,
): RepositoryModuleGraph {
  const { files, rootDir = "/repo", tsconfigPath = "tsconfig.json" } = input;

  const virtualRootDir = normalizePosixPath(rootDir);

  // 1. Discover all candidate source files deterministically
  const filesAnalyzed: string[] = [];
  for (const filePath of files.keys()) {
    const norm = normalizePosixPath(filePath);
    if (!isIgnoredPath(norm) && isSupportedSymbolFile(norm)) {
      filesAnalyzed.push(norm);
    }
  }
  filesAnalyzed.sort();

  // 2. Parse tsconfig options from snapshot
  const tsconfigInfo = parseSnapshotTsconfig(files, virtualRootDir, tsconfigPath);
  const host = createSnapshotModuleResolutionHost(files, virtualRootDir);

  const allReferences: RepositoryModuleReference[] = [];
  const internalEdges: RepositoryModuleEdge[] = [];
  const externalReferences: RepositoryModuleReference[] = [];
  const unresolvedReferences: RepositoryModuleReference[] = [];
  const unsupportedDynamicReferences: RepositoryModuleReference[] = [];
  const diagnostics: RepositoryModuleGraphDiagnostic[] = [];

  // 3. Analyze each source file
  for (const filePath of filesAnalyzed) {
    const sourceText = files.get(filePath);
    if (typeof sourceText !== "string") {
      continue;
    }

    const scriptKind = getScriptKindForPath(filePath);
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
    } catch (err) {
      diagnostics.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
        severity: "error",
      });
      continue;
    }

    const { references: rawRefs, diagnostics: parseDiags } =
      extractRawModuleReferences(sourceFile, filePath);
    diagnostics.push(...parseDiags);

    for (const raw of rawRefs) {
      if (raw.specifier === null) {
        // Non-static dynamic import or require
        const refId = buildReferenceId(
          filePath,
          raw.referenceKind,
          raw.location.start.offset,
        );
        const ref: RepositoryModuleReference = {
          id: refId,
          sourceFile: filePath,
          specifier: "<dynamic>",
          referenceKind: raw.referenceKind,
          importKind: raw.importKind,
          names: raw.names,
          location: raw.location,
          resolutionStatus: "unsupported_dynamic",
          ...(raw.isTypeOnly ? { isTypeOnly: true } : {}),
        };
        allReferences.push(ref);
        unsupportedDynamicReferences.push(ref);
        continue;
      }

      // Resolve module specifier
      const resolution = resolveModuleSpecifier(
        raw.specifier,
        filePath,
        tsconfigInfo.options,
        host,
        files,
        virtualRootDir,
      );

      const refId = buildReferenceId(
        filePath,
        raw.referenceKind,
        raw.location.start.offset,
      );

      const ref: RepositoryModuleReference = {
        id: refId,
        sourceFile: filePath,
        specifier: raw.specifier,
        referenceKind: raw.referenceKind,
        importKind: raw.importKind,
        names: raw.names,
        location: raw.location,
        resolutionStatus: resolution.status,
        ...(resolution.targetFile !== undefined ? { targetFile: resolution.targetFile } : {}),
        ...(raw.isTypeOnly ? { isTypeOnly: true } : {}),
      };

      allReferences.push(ref);

      if (resolution.status === "internal" && resolution.targetFile) {
        const edgeId = buildEdgeId(
          filePath,
          resolution.targetFile,
          raw.referenceKind,
          raw.location.start.offset,
        );
        const edge: RepositoryModuleEdge = {
          id: edgeId,
          sourceFile: filePath,
          targetFile: resolution.targetFile,
          edgeKind: raw.referenceKind,
          importKind: raw.importKind,
          specifier: raw.specifier,
          names: raw.names,
          location: raw.location,
          resolutionStatus: "internal",
          ...(raw.isTypeOnly ? { isTypeOnly: true } : {}),
        };
        internalEdges.push(edge);
      } else if (resolution.status === "external") {
        externalReferences.push(ref);
      } else if (resolution.status === "unresolved") {
        unresolvedReferences.push(ref);
      }
    }
  }

  // Deterministic sorting of results
  allReferences.sort((a, b) => a.id.localeCompare(b.id));
  internalEdges.sort((a, b) => a.id.localeCompare(b.id));
  externalReferences.sort((a, b) => a.id.localeCompare(b.id));
  unresolvedReferences.sort((a, b) => a.id.localeCompare(b.id));
  unsupportedDynamicReferences.sort((a, b) => a.id.localeCompare(b.id));
  diagnostics.sort((a, b) => {
    const fileComp = a.file.localeCompare(b.file);
    if (fileComp !== 0) return fileComp;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  return {
    filesAnalyzed,
    references: allReferences,
    internalEdges,
    externalReferences,
    unresolvedReferences,
    unsupportedDynamicReferences,
    diagnostics,
  };
}
