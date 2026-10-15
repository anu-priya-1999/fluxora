import {
  enqueueJob as defaultEnqueueJob,
  getGithubInstallationByInstallationId as defaultGetInstallationByInstallationId,
  getPool,
} from "@fluxora/db";
import {
  markSpanError,
  markSpanSuccess,
  tracer,
} from "@fluxora/observability";
import {
  isCanonicalGithubId,
  PULL_REQUEST_WEBHOOK_JOB_TYPE,
  pullRequestWebhookIdempotencyKey,
  type EnqueueJobInput,
  type GithubInstallation,
  type Job,
  type JobPayload,
  type NormalizedPullRequestWebhookPayload,
  type SupportedPullRequestAction,
} from "@fluxora/shared-types";
import type { IncomingMessage, ServerResponse } from "node:http";

import { loadGithubWebhookSecret } from "../github/config.ts";
import { verifyGithubWebhookSignature } from "../github/webhook-signature.ts";

export const GITHUB_WEBHOOK_PATH = "/api/v1/webhooks/github" as const;
const ALTERNATIVE_GITHUB_WEBHOOK_PATH = "/api/v1/github/webhooks" as const;

export function isGithubWebhookPath(path: string): boolean {
  return (
    path === GITHUB_WEBHOOK_PATH || path === ALTERNATIVE_GITHUB_WEBHOOK_PATH
  );
}

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1MB

export interface GithubWebhookHandlerDependencies {
  readonly getWebhookSecret?: () => string | undefined;
  readonly getInstallationByInstallationId?: (
    installationId: string,
  ) => Promise<GithubInstallation | null>;
  readonly enqueueJob?: (input: EnqueueJobInput) => Promise<Job>;
}

export async function handleGithubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void,
  deps?: GithubWebhookHandlerDependencies,
): Promise<void> {
  return tracer.startActiveSpan("fluxora.github.webhook", async (span) => {
    try {
      // 1. Read raw request body
      let rawBody: Buffer;
      try {
        rawBody = await readRawBody(req, MAX_WEBHOOK_BODY_BYTES);
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
            code: "bad_request",
            message: "Failed to read request body.",
          },
        });
        return;
      }

      // 2. Verify signature
      const getSecret = deps?.getWebhookSecret ?? loadGithubWebhookSecret;
      const secret = getSecret();

      if (secret === undefined || secret.trim().length === 0) {
        console.error("GitHub webhook secret is not configured on server.");
        sendJson(res, 500, {
          error: {
            code: "webhook_not_configured",
            message: "Webhook processing is not configured.",
          },
        });
        return;
      }

      const signatureHeader = headerValue(req.headers["x-hub-signature-256"]);
      const verification = verifyGithubWebhookSignature(
        rawBody,
        signatureHeader,
        secret,
      );

      if (!verification.valid) {
        if (verification.reason === "missing_signature") {
          sendJson(res, 401, {
            error: {
              code: "missing_signature",
              message: "Signature verification failed.",
            },
          });
          return;
        }

        sendJson(res, 401, {
          error: {
            code: "invalid_signature",
            message: "Signature verification failed.",
          },
        });
        return;
      }

      // 3. Inspect event header
      const eventHeader = headerValue(req.headers["x-github-event"]);
      const deliveryId = headerValue(req.headers["x-github-delivery"]);

      if (eventHeader !== "pull_request") {
        sendJson(res, 200, {
          ok: true,
          status: "ignored",
          reason: "unsupported_event",
          event: eventHeader ?? "unknown",
        });
        return;
      }

      // 4. Parse payload JSON
      let payloadJson: unknown;
      try {
        payloadJson = JSON.parse(rawBody.toString("utf8"));
      } catch {
        sendJson(res, 400, {
          error: {
            code: "invalid_payload",
            message: "Request body must be valid JSON.",
          },
        });
        return;
      }

      if (
        typeof payloadJson !== "object" ||
        payloadJson === null ||
        Array.isArray(payloadJson)
      ) {
        sendJson(res, 400, {
          error: {
            code: "invalid_payload",
            message: "Payload must be a JSON object.",
          },
        });
        return;
      }

      const payload = payloadJson as Record<string, unknown>;

      // 5. Inspect and filter action
      const actionRaw = payload["action"];
      if (typeof actionRaw !== "string") {
        sendJson(res, 400, {
          error: {
            code: "missing_action",
            message: "Payload action is required.",
          },
        });
        return;
      }

      if (actionRaw !== "opened" && actionRaw !== "synchronize") {
        sendJson(res, 200, {
          ok: true,
          status: "ignored",
          reason: "unsupported_action",
          action: actionRaw,
        });
        return;
      }

      const action = actionRaw as SupportedPullRequestAction;

      // 6. Validate minimum required fields
      // 6a. Repository identity
      const repositoryRaw = payload["repository"];
      if (
        typeof repositoryRaw !== "object" ||
        repositoryRaw === null ||
        Array.isArray(repositoryRaw)
      ) {
        sendJson(res, 400, {
          error: {
            code: "missing_repository_identity",
            message: "Repository identity is required.",
          },
        });
        return;
      }

      const repoObj = repositoryRaw as Record<string, unknown>;
      const rawRepoId = repoObj["id"];
      const repoIdStr =
        typeof rawRepoId === "number" || typeof rawRepoId === "string"
          ? String(rawRepoId).trim()
          : "";

      if (!isCanonicalGithubId(repoIdStr)) {
        sendJson(res, 400, {
          error: {
            code: "missing_repository_identity",
            message: "Repository identity is required.",
          },
        });
        return;
      }

      const repoFullName =
        typeof repoObj["full_name"] === "string" ? repoObj["full_name"].trim() : "";
      const repoName =
        typeof repoObj["name"] === "string"
          ? repoObj["name"].trim()
          : repoFullName.includes("/")
            ? repoFullName.slice(repoFullName.indexOf("/") + 1)
            : repoFullName;
      const ownerObj = repoObj["owner"] as Record<string, unknown> | undefined;
      const repoOwner =
        typeof ownerObj === "object" &&
        ownerObj !== null &&
        typeof ownerObj["login"] === "string"
          ? ownerObj["login"].trim()
          : repoFullName.includes("/")
            ? repoFullName.slice(0, repoFullName.indexOf("/"))
            : "";

      // 6b. Pull request number
      const prNumberRaw = payload["number"] ?? (payload["pull_request"] as Record<string, unknown> | undefined)?.["number"];
      const prNumber =
        typeof prNumberRaw === "number" && Number.isSafeInteger(prNumberRaw) && prNumberRaw > 0
          ? prNumberRaw
          : undefined;

      if (prNumber === undefined) {
        sendJson(res, 400, {
          error: {
            code: "missing_pull_request_number",
            message: "Pull request number is required.",
          },
        });
        return;
      }

      // 6c. Installation identity
      const installationRaw = payload["installation"];
      if (
        typeof installationRaw !== "object" ||
        installationRaw === null ||
        Array.isArray(installationRaw)
      ) {
        sendJson(res, 400, {
          error: {
            code: "missing_installation_identity",
            message: "Installation identity is required.",
          },
        });
        return;
      }

      const instObj = installationRaw as Record<string, unknown>;
      const rawInstId = instObj["id"];
      const installationIdStr =
        typeof rawInstId === "number" || typeof rawInstId === "string"
          ? String(rawInstId).trim()
          : "";

      if (!isCanonicalGithubId(installationIdStr)) {
        sendJson(res, 400, {
          error: {
            code: "missing_installation_identity",
            message: "Installation identity is required.",
          },
        });
        return;
      }

      // 6d. Pull request details (base/head ref and sha)
      const prRaw = payload["pull_request"];
      if (typeof prRaw !== "object" || prRaw === null || Array.isArray(prRaw)) {
        sendJson(res, 400, {
          error: {
            code: "missing_pull_request_details",
            message: "Pull request details are required.",
          },
        });
        return;
      }

      const prObj = prRaw as Record<string, unknown>;
      const prUrl =
        typeof prObj["html_url"] === "string" && prObj["html_url"].trim().length > 0
          ? prObj["html_url"].trim()
          : typeof prObj["url"] === "string"
            ? prObj["url"].trim()
            : `https://github.com/${repoFullName}/pull/${prNumber}`;
      const prTitle =
        typeof prObj["title"] === "string" && prObj["title"].trim().length > 0
          ? prObj["title"].trim()
          : undefined;

      const baseObj = prObj["base"] as Record<string, unknown> | undefined;
      const headObj = prObj["head"] as Record<string, unknown> | undefined;

      const baseRef = typeof baseObj?.["ref"] === "string" ? baseObj["ref"].trim() : "";
      const baseSha = typeof baseObj?.["sha"] === "string" ? baseObj["sha"].trim() : "";
      const headRef = typeof headObj?.["ref"] === "string" ? headObj["ref"].trim() : "";
      const headSha = typeof headObj?.["sha"] === "string" ? headObj["sha"].trim() : "";

      if (
        baseRef.length === 0 ||
        baseSha.length === 0 ||
        headRef.length === 0 ||
        headSha.length === 0
      ) {
        sendJson(res, 400, {
          error: {
            code: "missing_pull_request_details",
            message: "Pull request base and head ref/sha details are required.",
          },
        });
        return;
      }

      // Sender details (optional)
      const senderRaw = payload["sender"] as Record<string, unknown> | undefined;
      const senderUserId =
        senderRaw && (typeof senderRaw["id"] === "number" || typeof senderRaw["id"] === "string")
          ? String(senderRaw["id"]).trim()
          : undefined;
      const senderLogin =
        senderRaw && typeof senderRaw["login"] === "string"
          ? senderRaw["login"].trim()
          : undefined;

      // 7. Tenant / installation association
      const getInstallation =
        deps?.getInstallationByInstallationId ??
        ((id: string) =>
          defaultGetInstallationByInstallationId(getPool(), id));

      const installation = await getInstallation(installationIdStr);

      if (installation === null) {
        // Unknown / unmapped installation: reject safely without enqueueing work
        sendJson(res, 404, {
          error: {
            code: "unknown_installation",
            message: "GitHub App installation is not registered.",
          },
        });
        return;
      }

      const organizationId = installation.organizationId;

      // 8. Normalization
      const normalized: NormalizedPullRequestWebhookPayload = {
        eventType: "pull_request",
        action,
        ...(deliveryId ? { deliveryId } : {}),
        installationId: installation.githubInstallationId,
        organizationId,
        repository: {
          githubRepoId: repoIdStr,
          name: repoName,
          owner: repoOwner,
          fullName: repoFullName,
        },
        pullRequest: {
          number: prNumber,
          url: prUrl,
          ...(prTitle !== undefined ? { title: prTitle } : {}),
          baseRef,
          baseSha,
          headRef,
          headSha,
        },
        ...(senderUserId && senderLogin
          ? { sender: { githubUserId: senderUserId, login: senderLogin } }
          : {}),
      };

      // 9. Enqueue job with idempotency key
      const idempotencyKey = deliveryId
        ? pullRequestWebhookIdempotencyKey(deliveryId)
        : pullRequestWebhookIdempotencyKey(
            `${repoIdStr}:${prNumber}:${headSha}:${action}`,
          );

      const enqueue = deps?.enqueueJob ?? defaultEnqueueJob;
      const job = await enqueue({
        organizationId,
        type: PULL_REQUEST_WEBHOOK_JOB_TYPE,
        payload: normalized as unknown as JobPayload,
        idempotencyKey,
      });

      // 10. Telemetry and deterministic response
      span.setAttribute("fluxora.github.event", "pull_request");
      span.setAttribute("fluxora.github.action", action);
      if (deliveryId) {
        span.setAttribute("fluxora.github.delivery", deliveryId);
      }
      span.setAttribute("fluxora.github.pr_number", prNumber);
      span.setAttribute("fluxora.github.repo", repoFullName);
      span.setAttribute("fluxora.organization_id", organizationId);
      span.setAttribute("fluxora.job.id", job.id);

      markSpanSuccess(span);

      sendJson(res, 200, {
        ok: true,
        status: "accepted",
        jobId: job.id,
        deliveryId: deliveryId ?? null,
        pullRequest: {
          number: prNumber,
        },
      });
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload too large");
    this.name = "PayloadTooLargeError";
  }
}

async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

