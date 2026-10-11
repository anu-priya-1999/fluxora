import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import {
  getPool,
  getUserById,
  GraphTraversalValidationError,
  provisionGithubUser,
  traverseGraph,
  UserNotFoundError,
} from "@fluxora/db";
import { isCanonicalGithubId, type User } from "@fluxora/shared-types";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
  type ClerkGithubIdentity,
} from "../auth/clerk.ts";
import { redactForLog } from "../github/redact.ts";
import {
  GraphQueryValidationError,
  parseGraphQueryBody,
  toGraphTraversalOptions,
  type ParsedGraphQueryInput,
} from "./graph-query-request.ts";
import { formatGraphQueryResponse } from "./graph-query-response.ts";

const MAX_BODY_BYTES = 16384; // 16KB

export interface GraphQueryHandlerDependencies {
  authenticateClerkToken?: (authorization: string | undefined) => Promise<string>;
  getClerkGithubIdentity?: (clerkUserId: string) => Promise<ClerkGithubIdentity>;
  provisionGithubUser?: typeof provisionGithubUser;
  getUserById?: typeof getUserById;
  traverseGraph?: typeof traverseGraph;
  pool?: pg.Pool;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "PayloadTooLargeError";
  }
}

export async function handleGraphQuery(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: GraphQueryHandlerDependencies,
): Promise<void> {
  const contentType = headerValue(req.headers["content-type"]);
  if (
    contentType === undefined ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    sendJson(res, 415, {
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json.",
      },
    });
    return;
  }

  // 1. Authenticate request using Bearer JWT
  let verifyClerk = deps?.authenticateClerkToken;
  let getIdentity = deps?.getClerkGithubIdentity;

  if (verifyClerk === undefined || getIdentity === undefined) {
    verifyClerk ??= authenticateClerkToken;
    getIdentity ??= getClerkGithubIdentity;
  }

  const provision = deps?.provisionGithubUser ?? provisionGithubUser;
  const getUser = deps?.getUserById ?? getUserById;
  const pool = deps?.pool ?? getPool();
  const executeTraversal = deps?.traverseGraph ?? traverseGraph;

  let clerkUserId: string;
  try {
    clerkUserId = await verifyClerk(headerValue(req.headers.authorization));
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

  // 2. Resolve identity and verify GitHub account
  const identity = await getIdentity(clerkUserId);
  if (!identity.ok) {
    sendJson(res, 403, {
      error: {
        code: identity.code,
        message: identity.message,
      },
    });
    return;
  }

  const numericGithubId = Number(identity.githubUserId);
  if (
    !isCanonicalGithubId(identity.githubUserId) ||
    !Number.isSafeInteger(numericGithubId)
  ) {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

  // 3. Read and parse JSON request body
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error instanceof PayloadTooLargeError ? 413 : 400, {
      error: {
        code:
          error instanceof PayloadTooLargeError
            ? "payload_too_large"
            : "invalid_json",
        message:
          error instanceof PayloadTooLargeError
            ? "Request body is too large."
            : error instanceof Error
              ? error.message
              : "Request body must be JSON.",
      },
    });
    return;
  }

  // 4. Validate request DSL
  let parsedInput: ParsedGraphQueryInput;
  try {
    parsedInput = parseGraphQueryBody(body);
  } catch (error) {
    if (error instanceof GraphQueryValidationError) {
      sendJson(res, error.statusCode, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    throw error;
  }

  // 5. Derive authenticated tenant / organization
  let user: User;
  try {
    const provisioned = await provision(pool, {
      githubUserId: numericGithubId,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    user = await getUser(pool, provisioned.organizationId, provisioned.id);
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
    logUnexpectedGraphQueryError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    return;
  }

  // 6. Execute bounded-depth graph traversal
  try {
    const traversalOptions = toGraphTraversalOptions(
      user.organizationId,
      parsedInput,
    );
    const traversalResult = await executeTraversal(pool, traversalOptions);

    if (traversalResult.startNode === null) {
      sendJson(res, 404, {
        error: {
          code: "start_node_not_found",
          message:
            "Start node was not found within the requested analysis run.",
        },
      });
      return;
    }

    const responseData = formatGraphQueryResponse(
      traversalResult,
      parsedInput.minConfidence !== undefined
        ? { minConfidence: parsedInput.minConfidence }
        : {},
    );

    sendJson(res, 200, responseData);
  } catch (error) {
    if (error instanceof GraphTraversalValidationError) {
      sendJson(res, 400, {
        error: {
          code: "invalid_traversal_options",
          message: error.message,
        },
      });
      return;
    }

    logUnexpectedGraphQueryError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new GraphQueryValidationError(
      "Request body must not be empty.",
      "invalid_request",
      400,
    );
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GraphQueryValidationError(
      "Request body must be valid JSON.",
      "invalid_json",
      400,
    );
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function logUnexpectedGraphQueryError(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("graph query error");
    return;
  }

  const message = redactForLog(error.message);
  console.error(message.length === 0 ? error.name : message);
}
