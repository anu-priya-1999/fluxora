import type { IncomingMessage } from "node:http";
import {
  getPool,
  getUserById,
  provisionGithubUser,
  UserNotFoundError,
} from "@fluxora/db";
import { isCanonicalGithubId, type User } from "@fluxora/shared-types";
import type pg from "pg";

import type { ClerkGithubIdentity } from "../auth/clerk.ts";

export interface AuthenticatedWsSession {
  userId: string;
  organizationId: string;
  email: string;
  role: string;
}

export class WsAuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 401) {
    super(message);
    this.name = "WsAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface WsAuthDependencies {
  authenticateClerkToken?: (authorization: string | undefined) => Promise<string>;
  getClerkGithubIdentity?: (clerkUserId: string) => Promise<ClerkGithubIdentity>;
  provisionGithubUser?: typeof provisionGithubUser;
  getUserById?: typeof getUserById;
  pool?: pg.Pool;
}

export function extractWsToken(req: IncomingMessage): string | null {
  // 1. Authorization header: "Bearer <token>"
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.length > 0) {
      return token;
    }
  }

  // 2. sec-websocket-protocol header (e.g. "bearer.<token>" or "token.<token>")
  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (typeof protocolHeader === "string") {
    const parts = protocolHeader.split(",").map((p) => p.trim());
    for (const part of parts) {
      if (part.startsWith("bearer.")) {
        return part.slice("bearer.".length).trim();
      }
      if (part.startsWith("token.")) {
        return part.slice("token.".length).trim();
      }
    }
  }

  return null;
}

export async function authenticateWsRequest(
  req: IncomingMessage,
  deps?: WsAuthDependencies,
): Promise<AuthenticatedWsSession> {
  const token = extractWsToken(req);
  if (token === null) {
    throw new WsAuthError("invalid_session", "Authentication required.", 401);
  }

  let verifyClerk = deps?.authenticateClerkToken;
  let getIdentity = deps?.getClerkGithubIdentity;

  if (verifyClerk === undefined || getIdentity === undefined) {
    const clerk = await import("../auth/clerk.ts");
    verifyClerk ??= clerk.authenticateClerkToken;
    getIdentity ??= clerk.getClerkGithubIdentity;
  }

  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(`Bearer ${token}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Authentication required.";
    throw new WsAuthError("invalid_session", message, 401);
  }

  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    throw new WsAuthError(identity.code, identity.message, 403);
  }

  const githubUserId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(githubUserId)
  ) {
    throw new WsAuthError(
      "github_account_required",
      "A connected GitHub account is required.",
      403,
    );
  }

  const provisioned = await provision(pool, {
    githubUserId,
    email: identity.email,
    organizationName: identity.organizationName,
  });

  let user: User;
  try {
    user = await getUser(pool, provisioned.organizationId, provisioned.id);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      throw new WsAuthError(
        "tenant_session_rejected",
        "The account could not be loaded for this organization.",
        403,
      );
    }
    throw error;
  }

  return {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    role: user.role,
  };
}
