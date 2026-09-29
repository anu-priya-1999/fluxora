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
import type { User } from "@fluxora/shared-types";
import { createClerkClient, verifyToken } from "@clerk/backend";

import type { AuthConfig } from "../config.ts";

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

if (!clerkSecretKey) {
  throw new Error("CLERK_SECRET_KEY is required.");
}

const clerkClient = createClerkClient({
  secretKey: clerkSecretKey,
});

const authorizedParties = (
  process.env.CLERK_AUTHORIZED_PARTIES ?? "http://localhost:3000"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export function createApiServer(_config: AuthConfig): http.Server {
  void _config;
  return http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
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
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/api/v1/telemetry/dummy" && method === "GET") {
    await dummyTelemetry(req, res);
    return;
  }

  if (path === "/api/v1/auth/me" && method === "GET") {
    await currentUser(req, res);
    return;
  }

  if (isAuthPath(path)) {
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
    const clerkUserId = await authenticateClerkRequest(
      headerValue(req.headers.authorization),
    );

    const clerkUser = await clerkClient.users.getUser(clerkUserId);

    const githubAccount = clerkUser.externalAccounts.find(
      (account) => account.provider === "github",
    );

    if (!githubAccount?.providerUserId) {
      sendJson(res, 403, {
        error: {
          code: "github_account_required",
          message: "A connected GitHub account is required.",
        },
      });
      return;
    }

    const email =
      clerkUser.emailAddresses.find(
        (address) => address.id === clerkUser.primaryEmailAddressId,
      )?.emailAddress ?? githubAccount.emailAddress;

    if (!email) {
      sendJson(res, 403, {
        error: {
          code: "email_required",
          message: "A verified email address is required.",
        },
      });
      return;
    }

    const organizationName =
      (githubAccount.username ??
        clerkUser.username ??
        [clerkUser.firstName, clerkUser.lastName]
          .filter(Boolean)
          .join(" ")
          .trim()) ||
      email.split("@")[0] ||
      "Fluxora Organization";

    const provisioned = await provisionGithubUser(getPool(), {
      githubUserId: Number(githubAccount.providerUserId),
      email,
      organizationName,
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

async function authenticateClerkRequest(
  authorization: string | undefined,
): Promise<string> {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token.");
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    throw new Error("Missing bearer token.");
  }

  const payload = await verifyToken(token, {
    secretKey: clerkSecretKey,
    authorizedParties,
  });

  if (!payload.sub) {
    throw new Error("Clerk token has no subject.");
  }

  return payload.sub;
}

function isAuthPath(path: string): boolean {
  return path === "/api/v1/auth/me" || path === "/api/v1/telemetry/dummy";
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

  if (/bearer\s+\S+/i.test(error.message) || error.message.includes("gho_")) {
    console.error(error.name);
    return;
  }

  console.error(error.message);
}
