import type { SourceLocation } from "./symbols.ts";

/**
 * Supported framework types for detected API routes and routers.
 */
export const RepositoryRouteFrameworks = ["Next.js", "Express"] as const;
export type RepositoryRouteFramework = (typeof RepositoryRouteFrameworks)[number];

/**
 * Route classification types.
 */
export const RepositoryRouteTypes = [
  "app-router-handler",
  "pages-api-route",
  "express-router",
  "express-app-route",
] as const;
export type RepositoryRouteType = (typeof RepositoryRouteTypes)[number];

/**
 * Standard HTTP methods supported in route detection.
 */
export const RepositoryHttpMethods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
] as const;
export type RepositoryHttpMethod = (typeof RepositoryHttpMethods)[number];

/**
 * Individual HTTP API Route detected in a repository source file.
 */
export interface RepositoryApiRoute {
  /**
   * Deterministic unique identifier for the route.
   * Format: `${filePath}#${routeType}:${httpMethods.join(",")}:${routePath}`
   */
  readonly id: string;
  readonly framework: RepositoryRouteFramework;
  readonly routeType: RepositoryRouteType;
  readonly filePath: string;
  readonly routePath: string;
  readonly httpMethods: readonly RepositoryHttpMethod[];
  readonly symbolName?: string;
  readonly sourceLocation: SourceLocation;
  readonly evidence: string;
}

/**
 * Individual Express route registration or middleware mount on a router.
 */
export interface RepositoryExpressRouteEntry {
  readonly method: RepositoryHttpMethod;
  readonly path: string | null;
  readonly sourceLocation: SourceLocation;
  readonly evidence: string;
}

/**
 * Detected Express Router definition or instance within a source file.
 */
export interface RepositoryExpressRouter {
  /**
   * Deterministic unique identifier for the router.
   * Format: `${filePath}#express-router:${routerSymbol ?? "anonymous"}:${sourceLocation.start.offset}`
   */
  readonly id: string;
  readonly filePath: string;
  readonly routerSymbol?: string;
  readonly routes: readonly RepositoryExpressRouteEntry[];
  readonly mountPath: string | null;
  readonly sourceLocation: SourceLocation;
  readonly evidence: string;
}

/**
 * Diagnostic report for route detection warnings or parse anomalies.
 */
export interface RepositoryRouteDiagnostic {
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: "error" | "warning";
}

/**
 * Summary counts for deterministic verification.
 */
export interface RepositoryRouteCounts {
  readonly totalRoutes: number;
  readonly totalRouters: number;
  readonly nextAppRoutes: number;
  readonly nextPagesRoutes: number;
  readonly expressRoutes: number;
  readonly expressRouters: number;
}

/**
 * Complete deterministic result of Step 21 Route and Router detection.
 */
export interface RepositoryRouteDetectionResult {
  readonly routes: readonly RepositoryApiRoute[];
  readonly routers: readonly RepositoryExpressRouter[];
  readonly diagnostics: readonly RepositoryRouteDiagnostic[];
  readonly counts: RepositoryRouteCounts;
}

