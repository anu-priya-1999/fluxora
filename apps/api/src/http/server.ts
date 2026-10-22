import {
  emitDummyTelemetryLog,
  markSpanError,
  markSpanSuccess,
  tracer,
  recordDummyTelemetryCall,
} from "@fluxora/observability";

import http from "node:http";

import {
  getPool,
  getUserById,
  provisionGithubUser,
  UserNotFoundError,
} from "@fluxora/db";
import { isCanonicalGithubId, type User } from "@fluxora/shared-types";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
} from "../auth/clerk.ts";
import { loadGithubAppConfig, type GithubAppConfig } from "../github/config.ts";
import { redactForLog } from "../github/redact.ts";
import {
  corsHeadersForAllowedOrigin,
  githubInstallationPreflight,
  loadAllowedWebOrigins,
  rejectedCorsOriginForLog,
} from "./cors.ts";
import {
  handleCompleteGithubInstallation,
  isGithubInstallationPath,
} from "./github-installations.ts";
import { handleConnectRepository } from "./repositories.ts";
import { isRepositoryConnectPath } from "./repository-request.ts";
import {
  handleGraphQuery,
  type GraphQueryHandlerDependencies,
} from "./graph-query.ts";
import { isGraphQueryPath } from "./graph-query-request.ts";
import {
  handleGithubWebhook,
  isGithubWebhookPath,
  type GithubWebhookHandlerDependencies,
} from "./github-webhooks.ts";
import {
  handleAnalyzePullRequestImpact,
  handleGetImpactAnalysis,
  type ImpactAnalysisHandlerDependencies,
} from "./impact-analysis.ts";
import {
  isImpactAnalysisGetPath,
  isPullRequestAnalyzeImpactPath,
  matchImpactAnalysisGetPath,
  matchPullRequestAnalyzeImpactPath,
} from "./impact-analysis-request.ts";
import {
  handleCreateScenario,
  handleGetSimulation,
  handleGetSimulationResults,
  handleRunScenario,
  type SimulationHandlerDependencies,
} from "./simulation.ts";
import {
  isScenarioRunPath,
  isScenariosPath,
  isSimulationGetPath,
  isSimulationResultsGetPath,
  matchScenarioRunPath,
  matchSimulationGetPath,
  matchSimulationResultsGetPath,
} from "./simulation-request.ts";
import {
  setupWebSocketServer,
  type FluxoraWsServerOptions,
} from "../ws/server.ts";

export interface CreateApiServerOptions {
  wsOptions?: FluxoraWsServerOptions;
  graphQueryDeps?: GraphQueryHandlerDependencies;
  githubWebhookDeps?: GithubWebhookHandlerDependencies;
  impactAnalysisDeps?: ImpactAnalysisHandlerDependencies;
  simulationDeps?: SimulationHandlerDependencies;
}

export function createApiServer(
  optionsOrWs?: FluxoraWsServerOptions | CreateApiServerOptions,
): http.Server {
  const wsOptions =
    optionsOrWs && "wsOptions" in optionsOrWs
      ? optionsOrWs.wsOptions
      : (optionsOrWs as FluxoraWsServerOptions | undefined);
  const graphQueryDeps =
    optionsOrWs && "graphQueryDeps" in optionsOrWs
      ? optionsOrWs.graphQueryDeps
      : undefined;
  const githubWebhookDeps =
    optionsOrWs && "githubWebhookDeps" in optionsOrWs
      ? optionsOrWs.githubWebhookDeps
      : undefined;
  const impactAnalysisDeps =
    optionsOrWs && "impactAnalysisDeps" in optionsOrWs
      ? optionsOrWs.impactAnalysisDeps
      : undefined;
  const simulationDeps =
    optionsOrWs && "simulationDeps" in optionsOrWs
      ? optionsOrWs.simulationDeps
      : undefined;

  const githubAppConfig = loadGithubAppConfig();
  const allowedWebOrigins = loadAllowedWebOrigins();

  const server = http.createServer((req, res) => {
    void handleRequest(
      req,
      res,
      githubAppConfig,
      allowedWebOrigins,
      graphQueryDeps,
      githubWebhookDeps,
      impactAnalysisDeps,
      simulationDeps,
    ).catch(
      (error: unknown) => {
        if (res.headersSent) {
          return;
        }

        logUnexpected(error);

        sendJson(res, 500, {
          error: {
            code: "internal_error",
            message: "Internal server error.",
          },
        });
      },
    );
  });

  setupWebSocketServer(server, wsOptions);

  return server;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  githubAppConfig: GithubAppConfig | null,
  allowedWebOrigins: readonly string[],
  graphQueryDeps?: GraphQueryHandlerDependencies,
  githubWebhookDeps?: GithubWebhookHandlerDependencies,
  impactAnalysisDeps?: ImpactAnalysisHandlerDependencies,
  simulationDeps?: SimulationHandlerDependencies,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/healthz" && method === "GET") {
    await healthCheck(res);
    return;
  }

  if (path === "/api/v1/telemetry/dummy" && method === "GET") {
    await dummyTelemetry(req, res);
    return;
  }

  if (path === "/api/v1/auth/me" && method === "GET") {
    await currentUser(req, res);
    return;
  }

  if (isGraphQueryPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "POST") {
      await handleGraphQuery(req, res, sendJson, graphQueryDeps);
      return;
    }
  }

  if (isGithubInstallationPath(path) || isRepositoryConnectPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);
    const rejectedOrigin = rejectedCorsOriginForLog(origin, allowedWebOrigins);
    if (rejectedOrigin !== undefined) {
      console.error(`github installation origin rejected: ${rejectedOrigin}`);
    }

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "POST") {
      if (isGithubInstallationPath(path)) {
        await handleCompleteGithubInstallation(
          req,
          res,
          githubAppConfig,
          sendJson,
        );
        return;
      }

      await handleConnectRepository(req, res, githubAppConfig, sendJson);
      return;
    }
  }

  if (isGithubWebhookPath(path)) {
    if (method === "POST") {
      await handleGithubWebhook(req, res, sendJson, githubWebhookDeps);
      return;
    }
  }

  if (isPullRequestAnalyzeImpactPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "POST") {
      const match = matchPullRequestAnalyzeImpactPath(path);
      if (match !== null) {
        await handleAnalyzePullRequestImpact(
          req,
          res,
          match.pullRequestId,
          sendJson,
          impactAnalysisDeps,
        );
        return;
      }
    }
  }

  if (isImpactAnalysisGetPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "GET") {
      const match = matchImpactAnalysisGetPath(path);
      if (match !== null) {
        await handleGetImpactAnalysis(
          req,
          res,
          match.impactAnalysisId,
          sendJson,
          impactAnalysisDeps,
        );
        return;
      }
    }
  }

  if (isScenariosPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "POST") {
      await handleCreateScenario(req, res, sendJson, simulationDeps);
      return;
    }
  }

  if (isScenarioRunPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "POST") {
      const match = matchScenarioRunPath(path);
      if (match !== null) {
        await handleRunScenario(
          req,
          res,
          match.scenarioId,
          sendJson,
          simulationDeps,
        );
        return;
      }
    }
  }

  if (isSimulationResultsGetPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "GET") {
      const match = matchSimulationResultsGetPath(path);
      if (match !== null) {
        await handleGetSimulationResults(
          req,
          res,
          match.simulationId,
          sendJson,
          simulationDeps,
        );
        return;
      }
    }
  }

  if (isSimulationGetPath(path)) {
    const origin = headerValue(req.headers.origin);
    const corsHeaders = corsHeadersForAllowedOrigin(origin, allowedWebOrigins);

    if (method === "OPTIONS") {
      const preflight = githubInstallationPreflight(origin, allowedWebOrigins);
      applyCorsHeaders(res, preflight.headers);
      res.writeHead(preflight.status, responseHeaders({}));
      res.end();
      return;
    }

    applyCorsHeaders(res, corsHeaders);

    if (method === "GET") {
      const match = matchSimulationGetPath(path);
      if (match !== null) {
        await handleGetSimulation(
          req,
          res,
          match.simulationId,
          sendJson,
          simulationDeps,
        );
        return;
      }
    }
  }

  if (isKnownPath(path)) {
    sendJson(res, 405, {
      error: {
        code: "method_not_allowed",
        message: "Method not allowed.",
      },
    });
    return;
  }

  sendJson(res, 404, {
    error: {
      code: "not_found",
      message: "Not found.",
    },
  });
}

async function dummyTelemetry(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  return tracer.startActiveSpan("fluxora.telemetry.dummy", async (span) => {
    try {
      recordDummyTelemetryCall({
        "fluxora.endpoint": "/api/v1/telemetry/dummy",
      });

      emitDummyTelemetryLog("Fluxora dummy telemetry endpoint invoked.", {
        "fluxora.endpoint": "/api/v1/telemetry/dummy",
      });

      sendJson(res, 200, {
        ok: true,
        service: "fluxora-api",
      });

      markSpanSuccess(span);
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

async function currentUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const clerkUserId = await authenticateClerkToken(
      headerValue(req.headers.authorization),
    );

    const identity = await getClerkGithubIdentity(clerkUserId);

    if (!identity.ok) {
      sendJson(res, 403, {
        error: {
          code: identity.code,
          message: identity.message,
        },
      });
      return;
    }

    const githubUserId = Number(identity.githubUserId);
    if (
      !isCanonicalGithubId(identity.githubUserId) ||
      !Number.isSafeInteger(githubUserId)
    ) {
      sendJson(res, 403, {
        error: {
          code: "github_account_required",
          message: "A connected GitHub account is required.",
        },
      });
      return;
    }

    const provisioned = await provisionGithubUser(getPool(), {
      githubUserId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    let user: User;

    try {
      user = await getUserById(
        getPool(),
        provisioned.organizationId,
        provisioned.id,
      );
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        sendJson(res, 403, {
          error: {
            code: "tenant_session_rejected",
            message: "The account could not be loaded for this organization.",
          },
        });
        return;
      }

      throw error;
    }

    sendJson(res, 200, {
      user: {
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    logUnexpected(error);

    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
  }
}

function isKnownPath(path: string): boolean {
  return (
    path === "/api/v1/auth/me" ||
    path === "/api/v1/telemetry/dummy" ||
    isGraphQueryPath(path) ||
    isGithubInstallationPath(path) ||
    isRepositoryConnectPath(path) ||
    isGithubWebhookPath(path) ||
    isPullRequestAnalyzeImpactPath(path) ||
    isImpactAnalysisGetPath(path) ||
    isScenariosPath(path) ||
    isScenarioRunPath(path) ||
    isSimulationGetPath(path) ||
    isSimulationResultsGetPath(path)
  );
}

function applyCorsHeaders(
  res: http.ServerResponse,
  headers: Record<string, string> | undefined,
): void {
  if (headers === undefined) {
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const headers: http.OutgoingHttpHeaders = {
    "content-type": "application/json; charset=utf-8",
  };

  if (statusCode === 401) {
    headers["www-authenticate"] = "Bearer";
  }

  res.writeHead(statusCode, responseHeaders(headers));
  res.end(JSON.stringify(body));
}

function responseHeaders(
  extra: http.OutgoingHttpHeaders,
): http.OutgoingHttpHeaders {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function logUnexpected(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("unexpected error");
    return;
  }

  const message = redactForLog(error.message);

  if (message.includes("gho_") || message.length === 0) {
    console.error(error.name);
    return;
  }

  console.error(message);
}

async function healthCheck(res: http.ServerResponse): Promise<void> {
  try {
    await getPool().query("SELECT 1");

    sendJson(res, 200, {
      status: "ok",
      service: "fluxora-api",
    });
  } catch (error) {
    logUnexpected(error);

    sendJson(res, 503, {
      status: "unhealthy",
      service: "fluxora-api",
    });
  }
}
