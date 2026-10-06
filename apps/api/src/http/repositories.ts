import {
  parseConnectBody,
  RequestValidationError,
} from "./repository-request.ts";
import {
  getPool,
  getUserById,
  provisionGithubUser,
  UserNotFoundError,
} from "@fluxora/db";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
} from "../auth/clerk.ts";
import type { GithubAppConfig } from "../github/config.ts";
import { GithubRepositoryRequestError } from "../github/repository-client.ts";
import { parseClerkGithubUserId } from "../github/installation-id.ts";
import { redactForLog } from "../github/redact.ts";
import {
  connectRepository,
  GithubInstallationMismatchError,
  GithubInstallationNotConnectedError,
} from "../repositories/connect.ts";

const MAX_BODY_BYTES = 8192;

export async function handleConnectRepository(
  req: IncomingMessage,
  res: ServerResponse,
  githubAppConfig: GithubAppConfig | null,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
): Promise<void> {
  if (githubAppConfig === null) {
    sendJson(res, 503, {
      error: {
        code: "github_app_not_configured",
        message: "GitHub App is not configured.",
      },
    });
    return;
  }

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

  let clerkUserId: string;
  try {
    clerkUserId = await authenticateClerkToken(
      headerValue(req.headers.authorization),
    );
  } catch {
    sendJson(res, 401, {
      error: {
        code: "invalid_session",
        message: "Authentication required.",
      },
    });
    return;
  }

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

  let githubUserId: { numeric: number };
  try {
    githubUserId = parseClerkGithubUserId(identity.githubUserId);
  } catch {
    sendJson(res, 403, {
      error: {
        code: "github_account_required",
        message: "A connected GitHub account is required.",
      },
    });
    return;
  }

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

  try {
    const provisioned = await provisionGithubUser(getPool(), {
      githubUserId: githubUserId.numeric,
      email: identity.email,
      organizationName: identity.organizationName,
    });

    const user = await getUserById(
      getPool(),
      provisioned.organizationId,
      provisioned.id,
    );

    const input = parseConnectBody(body);
    const result = await connectRepository({
      organizationId: user.organizationId,
      githubInstallationId: input.githubInstallationId,
      repoFullName: input.repoFullName,
      ref: input.ref,
      config: githubAppConfig,
    });

    sendJson(res, 202, {
      repository_id: result.repository.id,
      status: result.repository.connectionStatus,
      job_id: result.job.id,
      ref: input.ref,
      commit_sha: result.commitSha,
    });
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

    if (error instanceof RequestValidationError) {
      sendJson(res, 400, {
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof GithubInstallationNotConnectedError) {
      sendJson(res, 409, {
        error: {
          code: "github_installation_required",
          message:
            "Connect the Fluxora GitHub App before connecting a repository.",
        },
      });
      return;
    }

    if (error instanceof GithubInstallationMismatchError) {
      sendJson(res, 403, {
        error: {
          code: "github_installation_mismatch",
          message:
            "The requested GitHub installation is not connected to this organization.",
        },
      });
      return;
    }

    if (error instanceof GithubRepositoryRequestError) {
      sendGithubRepositoryError(res, error, sendJson);
      return;
    }

    logUnexpectedRepositoryError(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "PayloadTooLargeError";
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
    throw new RequestValidationError("Request body must not be empty.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestValidationError("Request body must be valid JSON.");
  }
}

function sendGithubRepositoryError(
  res: ServerResponse,
  error: GithubRepositoryRequestError,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
): void {
  switch (error.failure) {
    case "not_found":
      sendJson(res, 404, {
        error: {
          code: "repository_not_accessible",
          message:
            "Repository is not accessible through the connected GitHub App.",
        },
      });
      return;
    case "invalid_ref":
      sendJson(res, 422, {
        error: {
          code: "invalid_ref",
          message: "The requested branch or ref was not found.",
        },
      });
      return;
    case "github_auth":
      sendJson(res, 409, {
        error: {
          code: "github_reauth_required",
          message:
            "The GitHub App installation can no longer access repositories.",
        },
      });
      return;
    case "rate_limited":
      sendJson(res, 503, {
        error: {
          code: "github_rate_limited",
          message: "GitHub is rate limiting requests. Please retry.",
        },
      });
      return;
    case "misconfigured":
      sendJson(res, 503, {
        error: {
          code: "github_app_misconfigured",
          message: "GitHub App credentials are not usable.",
        },
      });
      return;
    case "unavailable":
      sendJson(res, 503, {
        error: {
          code: "github_unavailable",
          message: "GitHub is temporarily unavailable.",
        },
      });
      return;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function logUnexpectedRepositoryError(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("repository connect error");
    return;
  }

  const message = redactForLog(error.message);
  console.error(message.length === 0 ? error.name : message);
}
