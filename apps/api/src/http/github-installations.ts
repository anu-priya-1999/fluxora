import {
  getPool,
  getUserById,
  provisionGithubUser,
  saveGithubInstallation,
  UserNotFoundError,
} from "@fluxora/db";
import { GITHUB_INSTALLATION_COMPLETION_PATH } from "@fluxora/shared-types";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  authenticateClerkToken,
  getClerkGithubIdentity,
} from "../auth/clerk.ts";
import type { GithubAppConfig } from "../github/config.ts";
import { completeInstallation } from "../github/complete-installation.ts";
import { githubInstallationHttpError } from "../github/http-error.ts";
import {
  parseClerkGithubUserId,
  readGithubInstallationIdField,
} from "../github/installation-id.ts";
import { redactForLog } from "../github/redact.ts";

const MAX_BODY_BYTES = 4096;

export async function handleCompleteGithubInstallation(
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
  if (contentType === undefined || !contentType.toLowerCase().startsWith("application/json")) {
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
    clerkUserId = await authenticateClerkToken(headerValue(req.headers.authorization));
  } catch (error) {
    logSafe(error);
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

  let githubUserId: { text: string; numeric: number };
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
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, {
        error: {
          code: "payload_too_large",
          message: "Request body is too large.",
        },
      });
      return;
    }

    sendJson(res, 400, {
      error: {
        code: "invalid_json",
        message: "Request body must be JSON.",
      },
    });
    return;
  }

  let installationId: string;
  try {
    installationId = readGithubInstallationIdField(body);
  } catch (error) {
    const mapped = githubInstallationHttpError(error);
    sendJson(res, mapped?.status ?? 400, {
      error: {
        code: mapped?.code ?? "invalid_installation_id",
        message:
          mapped?.message ??
          "github_installation_id must be a positive decimal string.",
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

    if (String(user.githubUserId) !== githubUserId.text) {
      sendJson(res, 403, {
        error: {
          code: "github_account_required",
          message: "A connected GitHub account is required.",
        },
      });
      return;
    }

    const result = await completeInstallation({
      role: user.role,
      organizationId: user.organizationId,
      githubUserId: githubUserId.text,
      githubInstallationId: installationId,
      config: githubAppConfig,
      writer: {
        save: (input) => saveGithubInstallation(getPool(), input),
      },
    });

    sendJson(res, 200, {
      installation: {
        id: result.installation.id,
        organizationId: result.installation.organizationId,
        githubInstallationId: result.installation.githubInstallationId,
        githubAccountId: result.installation.githubAccountId,
        githubAccountLogin: result.installation.githubAccountLogin,
        githubAccountType: result.installation.githubAccountType,
      },
      created: result.created,
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

    const mapped = githubInstallationHttpError(error);
    if (mapped !== null) {
      logSafe(error);
      sendJson(res, mapped.status, {
        error: {
          code: mapped.code,
          message: mapped.message,
        },
      });
      return;
    }

    logSafe(error);
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  }
}

export function isGithubInstallationPath(path: string): boolean {
  return path === GITHUB_INSTALLATION_COMPLETION_PATH;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload too large");
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
    throw new Error("empty");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid json");
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function logSafe(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("github installation error");
    return;
  }

  const message = redactForLog(error.message);
  console.error(message.length === 0 ? error.name : message);
}
