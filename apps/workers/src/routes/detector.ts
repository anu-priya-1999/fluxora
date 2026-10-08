import ts from "typescript";
import type {
  RepositoryApiRoute,
  RepositoryExpressRouteEntry,
  RepositoryExpressRouter,
  RepositoryHttpMethod,
  RepositoryRouteCounts,
  RepositoryRouteDetectionResult,
  RepositoryRouteDiagnostic,
  SourceLocation,
} from "@fluxora/shared-types";

import { isIgnoredPath } from "../detect/detector.ts";
import {
  getNodeSourceLocation,
  getScriptKindForPath,
  isSupportedSymbolFile,
} from "../symbols/extractor.ts";
import {
  normalizePosixPath,
  type SnapshotFileMap,
} from "../modules/graph.ts";

/**
 * Standard HTTP methods recognized on Next.js App Router route handlers.
 */
export const NEXT_APP_ROUTER_METHODS = new Set<RepositoryHttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Express routing method names mapping to canonical RepositoryHttpMethod.
 */
export const EXPRESS_ROUTER_METHODS: Readonly<Record<string, RepositoryHttpMethod>> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
  all: "ALL",
};

/**
 * Input for Step 21 Route and Router detection.
 */
export interface RepositoryRouteDetectionInput {
  /**
   * Complete map of relative file path -> content string for the repository snapshot.
   */
  readonly files: SnapshotFileMap;
}

/**
 * Tests whether a relative path represents a Next.js App Router route handler file.
 * Matches: app/**\/route.(ts|tsx|js|jsx) or src/app/**\/route.(ts|tsx|js|jsx)
 */
export function isNextAppRouteFile(relativePath: string): boolean {
  if (isIgnoredPath(relativePath)) {
    return false;
  }
  const normalized = normalizePosixPath(relativePath);
  return /(?:^|\/)(?:src\/)?app\/(?:.+\/)?route\.(?:ts|tsx|js|jsx)$/.test(normalized);
}

/**
 * Tests whether a relative path represents a Next.js Pages Router API route file.
 * Matches: pages/api/**\/*.(ts|tsx|js|jsx) or src/pages/api/**\/*.(ts|tsx|js|jsx)
 */
export function isNextPagesApiRouteFile(relativePath: string): boolean {
  if (isIgnoredPath(relativePath)) {
    return false;
  }
  const normalized = normalizePosixPath(relativePath);
  return /(?:^|\/)(?:src\/)?pages\/api\/.+\.(?:ts|tsx|js|jsx)$/.test(normalized);
}

/**
 * Derives the public HTTP route path deterministically from a Next.js App Router route file path.
 * Examples:
 *   "app/api/users/route.ts" -> "/api/users"
 *   "src/app/api/users/[id]/route.tsx" -> "/api/users/[id]"
 *   "app/route.ts" -> "/"
 *   "app/api/route.js" -> "/api"
 */
export function deriveNextAppRoutePath(filePath: string): string {
  const normalized = normalizePosixPath(filePath);
  // Match prefix up to app/
  const match = normalized.match(/(?:^|\/)(?:src\/)?app\/(.*)\/route\.(?:ts|tsx|js|jsx)$/);
  if (!match || !match[1]) {
    // If route is directly under app/, e.g. app/route.ts
    if (/(?:^|\/)(?:src\/)?app\/route\.(?:ts|tsx|js|jsx)$/.test(normalized)) {
      return "/";
    }
    return "/";
  }
  const segs = match[1].split("/").filter((s) => s.length > 0);
  return "/" + segs.join("/");
}

/**
 * Derives the public HTTP route path deterministically from a Next.js Pages Router API route file path.
 * Examples:
 *   "pages/api/users.ts" -> "/api/users"
 *   "src/pages/api/posts/[id].tsx" -> "/api/posts/[id]"
 *   "pages/api/users/index.ts" -> "/api/users"
 *   "pages/api/index.js" -> "/api"
 */
export function deriveNextPagesApiRoutePath(filePath: string): string {
  const normalized = normalizePosixPath(filePath);
  const match = normalized.match(/(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:ts|tsx|js|jsx)$/);
  if (!match || !match[1]) {
    return "/api";
  }
  let inner = match[1];
  // If filename is index, strip /index or standalone index
  if (inner === "index") {
    return "/api";
  }
  if (inner.endsWith("/index")) {
    inner = inner.slice(0, -"/index".length);
  }
  return `/api/${inner}`;
}

/**
 * Deterministically extracts a string literal from an AST expression if statically known.
 * Supports string literals and simple template literals without expressions.
 */
export function extractStaticStringValue(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/**
 * Internal state for tracking Express identifiers in a single SourceFile.
 */
interface ExpressFileScope {
  // Names bound to express module (e.g. import express from "express", const express = require("express"))
  readonly expressModuleBindings: Set<string>;
  // Names bound to Router imported directly (e.g. import { Router } from "express")
  readonly routerFactoryBindings: Set<string>;
  // Variable names holding an Express application instance (e.g. const app = express())
  readonly expressAppVariables: Set<string>;
  // Variable names holding an Express Router instance (e.g. const router = express.Router(), const router = Router())
  readonly expressRouterVariables: Set<string>;
}

/**
 * Scans a SourceFile to identify whether Express is imported/required, and which variables are Express instances.
 */
function analyzeExpressScope(sourceFile: ts.SourceFile): ExpressFileScope {
  const expressModuleBindings = new Set<string>();
  const routerFactoryBindings = new Set<string>();
  const expressAppVariables = new Set<string>();
  const expressRouterVariables = new Set<string>();

  // Pass 1: Identify imports and require calls of "express"
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "express"
      ) {
        const importClause = statement.importClause;
        if (importClause) {
          // Default import: import express from "express";
          if (importClause.name) {
            expressModuleBindings.add(importClause.name.text);
          }
          // Named bindings: import { Router } from "express";
          if (importClause.namedBindings) {
            if (ts.isNamespaceImport(importClause.namedBindings)) {
              expressModuleBindings.add(importClause.namedBindings.name.text);
            } else if (ts.isNamedImports(importClause.namedBindings)) {
              for (const element of importClause.namedBindings.elements) {
                const importedName = element.propertyName
                  ? element.propertyName.text
                  : element.name.text;
                if (importedName === "Router") {
                  routerFactoryBindings.add(element.name.text);
                } else if (importedName === "express") {
                  expressModuleBindings.add(element.name.text);
                }
              }
            }
          }
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (decl.initializer && ts.isIdentifier(decl.name)) {
          // const express = require("express");
          if (
            ts.isCallExpression(decl.initializer) &&
            ts.isIdentifier(decl.initializer.expression) &&
            decl.initializer.expression.text === "require" &&
            decl.initializer.arguments.length > 0
          ) {
            const firstArg = decl.initializer.arguments[0];
            if (firstArg && ts.isStringLiteral(firstArg) && firstArg.text === "express") {
              expressModuleBindings.add(decl.name.text);
            }
          }
        } else if (
          decl.initializer &&
          ts.isObjectBindingPattern(decl.name) &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "require" &&
          decl.initializer.arguments.length > 0
        ) {
          // const { Router } = require("express");
          const firstArg = decl.initializer.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg) && firstArg.text === "express") {
            for (const elem of decl.name.elements) {
              if (ts.isIdentifier(elem.name)) {
                const propName = elem.propertyName && ts.isIdentifier(elem.propertyName)
                  ? elem.propertyName.text
                  : elem.name.text;
                if (propName === "Router") {
                  routerFactoryBindings.add(elem.name.text);
                }
              }
            }
          }
        }
      }
    }
  }

  // If "express" wasn't imported or required at all, there can be no proven Express routers/apps in this file.
  if (expressModuleBindings.size === 0 && routerFactoryBindings.size === 0) {
    return {
      expressModuleBindings,
      routerFactoryBindings,
      expressAppVariables,
      expressRouterVariables,
    };
  }

  // Pass 2: Identify variable declarations initializing an Express App or Express Router
  function inspectVariableDeclaration(decl: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) {
      return;
    }
    const varName = decl.name.text;
    const init = decl.initializer;

    if (ts.isCallExpression(init)) {
      // Case 1: const app = express();
      if (
        ts.isIdentifier(init.expression) &&
        expressModuleBindings.has(init.expression.text)
      ) {
        expressAppVariables.add(varName);
        return;
      }

      // Case 2: const router = express.Router();
      if (
        ts.isPropertyAccessExpression(init.expression) &&
        ts.isIdentifier(init.expression.expression) &&
        expressModuleBindings.has(init.expression.expression.text) &&
        init.expression.name.text === "Router"
      ) {
        expressRouterVariables.add(varName);
        return;
      }

      // Case 3: const router = Router(); where Router is imported from "express"
      if (
        ts.isIdentifier(init.expression) &&
        routerFactoryBindings.has(init.expression.text)
      ) {
        expressRouterVariables.add(varName);
        return;
      }
    }
  }

  function walk(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      inspectVariableDeclaration(node);
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);

  return {
    expressModuleBindings,
    routerFactoryBindings,
    expressAppVariables,
    expressRouterVariables,
  };
}

/**
 * Detects Next.js API Routes and Express Routers statically and deterministically across a snapshot.
 */
export function detectRepositoryRoutes(
  input: RepositoryRouteDetectionInput,
): RepositoryRouteDetectionResult {
  const routes: RepositoryApiRoute[] = [];
  const routers: RepositoryExpressRouter[] = [];
  const diagnostics: RepositoryRouteDiagnostic[] = [];

  // Deterministically sort file paths
  const sortedFilePaths = Array.from(input.files.keys()).sort();

  for (const relativePath of sortedFilePaths) {
    if (isIgnoredPath(relativePath) || !isSupportedSymbolFile(relativePath)) {
      continue;
    }

    const sourceText = input.files.get(relativePath) ?? "";
    const scriptKind = getScriptKindForPath(relativePath);

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        filePath: relativePath,
        message: `Failed to parse AST for route detection: ${message}`,
        severity: "error",
      });
      continue;
    }

    // 1. Next.js App Router detection
    if (isNextAppRouteFile(relativePath)) {
      detectNextAppRoute(relativePath, sourceFile, routes);
    }

    // 2. Next.js Pages Router API route detection
    if (isNextPagesApiRouteFile(relativePath)) {
      detectNextPagesApiRoute(relativePath, sourceFile, routes);
    }

    // 3. Express Router & App detection
    detectExpressRoutesAndRouters(relativePath, sourceFile, routes, routers);
  }

  // Sort routes deterministically: by filePath, then routePath, then HTTP method
  routes.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    if (a.routePath !== b.routePath) {
      return a.routePath.localeCompare(b.routePath);
    }
    return a.id.localeCompare(b.id);
  });

  // Sort routers deterministically: by filePath, then offset
  routers.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    return a.sourceLocation.start.offset - b.sourceLocation.start.offset;
  });

  // Sort diagnostics deterministically
  diagnostics.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    return a.message.localeCompare(b.message);
  });

  // Compute counts
  let nextAppRoutes = 0;
  let nextPagesRoutes = 0;
  let expressRoutes = 0;

  for (const r of routes) {
    if (r.routeType === "app-router-handler") {
      nextAppRoutes++;
    } else if (r.routeType === "pages-api-route") {
      nextPagesRoutes++;
    } else if (r.routeType === "express-app-route" || r.routeType === "express-router") {
      expressRoutes++;
    }
  }

  const counts: RepositoryRouteCounts = {
    totalRoutes: routes.length,
    totalRouters: routers.length,
    nextAppRoutes,
    nextPagesRoutes,
    expressRoutes,
    expressRouters: routers.length,
  };

  return {
    routes,
    routers,
    diagnostics,
    counts,
  };
}

/**
 * Detects App Router route handlers in app/**\/route.(ts|tsx|js|jsx).
 */
function detectNextAppRoute(
  filePath: string,
  sourceFile: ts.SourceFile,
  routes: RepositoryApiRoute[],
): void {
  const routePath = deriveNextAppRoutePath(filePath);
  const detectedHandlers: Array<{
    method: RepositoryHttpMethod;
    symbolName: string;
    location: ts.Node;
  }> = [];

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

    // Pattern A: export function GET() {} or export async function GET() {}
    if (ts.isFunctionDeclaration(statement) && isExported && !isDefault) {
      const funcName = statement.name?.text;
      if (funcName && NEXT_APP_ROUTER_METHODS.has(funcName as RepositoryHttpMethod)) {
        detectedHandlers.push({
          method: funcName as RepositoryHttpMethod,
          symbolName: funcName,
          location: statement,
        });
      }
    }

    // Pattern B: export const GET = ... or export const GET = async () => {}
    if (ts.isVariableStatement(statement) && isExported) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varName = decl.name.text;
          if (NEXT_APP_ROUTER_METHODS.has(varName as RepositoryHttpMethod)) {
            detectedHandlers.push({
              method: varName as RepositoryHttpMethod,
              symbolName: varName,
              location: decl,
            });
          }
        }
      }
    }

    // Pattern C: export { GET, POST }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const elem of statement.exportClause.elements) {
          const exportedName = elem.name.text;
          if (NEXT_APP_ROUTER_METHODS.has(exportedName as RepositoryHttpMethod)) {
            detectedHandlers.push({
              method: exportedName as RepositoryHttpMethod,
              symbolName: elem.propertyName ? elem.propertyName.text : exportedName,
              location: elem,
            });
          }
        }
      }
    }
  }

  // Deduplicate handlers per HTTP method (preserve first occurrence in file)
  const seenMethods = new Set<RepositoryHttpMethod>();
  for (const handler of detectedHandlers) {
    if (seenMethods.has(handler.method)) {
      continue;
    }
    seenMethods.add(handler.method);

    const sourceLocation = getNodeSourceLocation(handler.location, sourceFile);
    routes.push({
      id: `${filePath}#app-router-handler:${handler.method}:${routePath}`,
      framework: "Next.js",
      routeType: "app-router-handler",
      filePath,
      routePath,
      httpMethods: [handler.method],
      symbolName: handler.symbolName,
      sourceLocation,
      evidence: `Next.js App Router route handler file ${filePath} exporting HTTP method ${handler.method} mapped to route path ${routePath}`,
    });
  }
}

/**
 * Detects Pages Router API routes in pages/api/**\/*.(ts|tsx|js|jsx).
 */
function detectNextPagesApiRoute(
  filePath: string,
  sourceFile: ts.SourceFile,
  routes: RepositoryApiRoute[],
): void {
  const routePath = deriveNextPagesApiRoutePath(filePath);

  let defaultExportNode: ts.Node | null = null;
  let symbolName: string | undefined = undefined;

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

    if (isExported && isDefault) {
      if (ts.isFunctionDeclaration(statement)) {
        defaultExportNode = statement;
        symbolName = statement.name?.text ?? "default";
        break;
      } else if (ts.isClassDeclaration(statement)) {
        defaultExportNode = statement;
        symbolName = statement.name?.text ?? "default";
        break;
      }
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      defaultExportNode = statement;
      if (ts.isIdentifier(statement.expression)) {
        symbolName = statement.expression.text;
      } else {
        symbolName = "default";
      }
      break;
    }
  }

  const targetNode = defaultExportNode ?? sourceFile;
  const sourceLocation = getNodeSourceLocation(targetNode, sourceFile);

  routes.push({
    id: `${filePath}#pages-api-route:ALL:${routePath}`,
    framework: "Next.js",
    routeType: "pages-api-route",
    filePath,
    routePath,
    httpMethods: ["ALL"],
    ...(symbolName !== undefined ? { symbolName } : {}),
    sourceLocation,
    evidence: `Next.js Pages Router API route file ${filePath}${symbolName ? ` with default handler ${symbolName}` : ""} mapped to route path ${routePath}`,
  });
}

/**
 * Detects Express Router definitions, router registrations, and app route registrations.
 */
function detectExpressRoutesAndRouters(
  filePath: string,
  sourceFile: ts.SourceFile,
  routes: RepositoryApiRoute[],
  routers: RepositoryExpressRouter[],
): void {
  const scope = analyzeExpressScope(sourceFile);

  // If no express module or router factory was imported/required, skip entirely.
  if (scope.expressModuleBindings.size === 0 && scope.routerFactoryBindings.size === 0) {
    return;
  }

  // Map to collect route entries registered on each router variable
  const routerRegistrations = new Map<string, RepositoryExpressRouteEntry[]>();
  for (const rVar of scope.expressRouterVariables) {
    routerRegistrations.set(rVar, []);
  }

  // Track location of router variable definitions
  const routerDefinitions = new Map<
    string,
    { location: SourceLocation; mountPath: string | null }
  >();

  // Helper to extract router / app route calls
  function inspectCallExpression(call: ts.CallExpression): void {
    if (!ts.isPropertyAccessExpression(call.expression)) {
      return;
    }

    const propAccess = call.expression;
    if (!ts.isIdentifier(propAccess.expression)) {
      return;
    }

    const calleeObj = propAccess.expression.text;
    const methodName = propAccess.name.text.toLowerCase();

    const isApp = scope.expressAppVariables.has(calleeObj);
    const isRouter = scope.expressRouterVariables.has(calleeObj);

    if (!isApp && !isRouter) {
      return;
    }

    // Check if methodName is an HTTP method or "use"
    const isHttpMethod = methodName in EXPRESS_ROUTER_METHODS;
    const isUse = methodName === "use";

    if (!isHttpMethod && !isUse) {
      return;
    }

    const firstArg = call.arguments[0];
    const pathString = extractStaticStringValue(firstArg);

    const callLocation = getNodeSourceLocation(call, sourceFile);

    if (isApp) {
      if (isHttpMethod) {
        const httpMethod = EXPRESS_ROUTER_METHODS[methodName] ?? "GET";
        const routePath = pathString ?? "(unresolved)";
        routes.push({
          id: `${filePath}#express-app-route:${httpMethod}:${routePath}:${callLocation.start.offset}`,
          framework: "Express",
          routeType: "express-app-route",
          filePath,
          routePath,
          httpMethods: [httpMethod],
          symbolName: calleeObj,
          sourceLocation: callLocation,
          evidence: `Express application instance '${calleeObj}' registered ${httpMethod} route '${routePath}'`,
        });
      } else if (isUse && pathString) {
        // app.use("/api", childRouter) -> captures mounted router or middleware
        routes.push({
          id: `${filePath}#express-app-route:ALL:${pathString}:${callLocation.start.offset}`,
          framework: "Express",
          routeType: "express-app-route",
          filePath,
          routePath: pathString,
          httpMethods: ["ALL"],
          symbolName: calleeObj,
          sourceLocation: callLocation,
          evidence: `Express application instance '${calleeObj}' mounted middleware / child router at '${pathString}'`,
        });
      }
    } else if (isRouter) {
      const entries = routerRegistrations.get(calleeObj);
      if (entries) {
        if (isHttpMethod) {
          const httpMethod = EXPRESS_ROUTER_METHODS[methodName] ?? "GET";
          const routePath = pathString;
          entries.push({
            method: httpMethod,
            path: routePath,
            sourceLocation: callLocation,
            evidence: `Router '${calleeObj}.${methodName}' registration at path ${routePath ?? "(unresolved)"}`,
          });

          // Also register in top-level routes collection for unified queryability
          routes.push({
            id: `${filePath}#express-router:${calleeObj}:${httpMethod}:${routePath ?? "(unresolved)"}:${callLocation.start.offset}`,
            framework: "Express",
            routeType: "express-router",
            filePath,
            routePath: routePath ?? "(unresolved)",
            httpMethods: [httpMethod],
            symbolName: calleeObj,
            sourceLocation: callLocation,
            evidence: `Express router '${calleeObj}' registered route ${httpMethod} at path ${routePath ?? "(unresolved)"}`,
          });
        } else if (isUse) {
          entries.push({
            method: "ALL",
            path: pathString,
            sourceLocation: callLocation,
            evidence: `Router '${calleeObj}.use' mounted at path ${pathString ?? "(unresolved)"}`,
          });
        }
      }
    }
  }

  // Find router declaration locations
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && scope.expressRouterVariables.has(decl.name.text)) {
          const loc = getNodeSourceLocation(decl, sourceFile);
          routerDefinitions.set(decl.name.text, {
            location: loc,
            mountPath: null,
          });
        }
      }
    }
  }

  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      inspectCallExpression(node);
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);

  // Construct RepositoryExpressRouter records
  for (const [routerVar, entries] of routerRegistrations.entries()) {
    const defInfo = routerDefinitions.get(routerVar);
    const loc = defInfo?.location ?? getNodeSourceLocation(sourceFile, sourceFile);

    routers.push({
      id: `${filePath}#express-router:${routerVar}:${loc.start.offset}`,
      filePath,
      routerSymbol: routerVar,
      routes: entries,
      mountPath: defInfo?.mountPath ?? null,
      sourceLocation: loc,
      evidence: `Express Router instance '${routerVar}' defined with ${entries.length} registered route(s)`,
    });
  }
}
