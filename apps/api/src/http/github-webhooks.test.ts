import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, it } from "vitest";

import type {
  EnqueueJobInput,
  GithubInstallation,
  Job,
  NormalizedPullRequestWebhookPayload,
} from "@fluxora/shared-types";
import {
  PULL_REQUEST_WEBHOOK_JOB_TYPE,
  pullRequestWebhookIdempotencyKey,
} from "@fluxora/shared-types";

import { computeGithubWebhookSignature } from "../github/webhook-signature.ts";
import { createApiServer } from "./server.ts";
import type { GithubWebhookHandlerDependencies } from "./github-webhooks.ts";

const TEST_SECRET = "super-secret-fluxora-webhook-key-42";
const TEST_ORG_ID = "11111111-1111-4111-8111-111111111111";
const TEST_INSTALLATION_ID = "12345678";
const KNOWN_INSTALLATION: GithubInstallation = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: TEST_ORG_ID,
  githubInstallationId: TEST_INSTALLATION_ID,
  githubAccountId: "98765",
  githubAccountLogin: "acme-corp",
  githubAccountType: "User",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function validPullRequestPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      html_url: "https://github.com/acme-corp/service/pull/42",
      title: "Add checkout feature",
      base: {
        ref: "main",
        sha: "1111111111111111111111111111111111111111",
      },
      head: {
        ref: "feat/checkout",
        sha: "2222222222222222222222222222222222222222",
      },
    },
    repository: {
      id: 99887766,
      name: "service",
      full_name: "acme-corp/service",
      owner: {
        id: 98765,
        login: "acme-corp",
      },
    },
    installation: {
      id: Number(TEST_INSTALLATION_ID),
    },
    sender: {
      id: 54321,
      login: "developer-bob",
    },
    ...overrides,
  };
}

describe("Global Step 41 — GitHub Pull Request Webhook Handling", () => {
  let server: http.Server;
  let baseUrl: string;
  let enqueuedJobs: Job[];
  const jobStore = new Map<string, Job>();
  let loggedMessages: string[];

  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleLog = console.log;

  beforeAll(async () => {
    enqueuedJobs = [];
    jobStore.clear();
    loggedMessages = [];

    console.error = (...args: unknown[]) => {
      loggedMessages.push(args.map(String).join(" "));
      originalConsoleError(...args);
    };
    console.warn = (...args: unknown[]) => {
      loggedMessages.push(args.map(String).join(" "));
      originalConsoleWarn(...args);
    };
    console.log = (...args: unknown[]) => {
      loggedMessages.push(args.map(String).join(" "));
      originalConsoleLog(...args);
    };

    const webhookDeps: GithubWebhookHandlerDependencies = {
      getWebhookSecret: () => TEST_SECRET,
      getInstallationByInstallationId: async (installationId: string) => {
        if (installationId === TEST_INSTALLATION_ID) {
          return KNOWN_INSTALLATION;
        }
        return null;
      },
      enqueueJob: async (input: EnqueueJobInput) => {
        const storeKey = `${input.organizationId}:${input.idempotencyKey}`;
        const existing = jobStore.get(storeKey);
        if (existing !== undefined) {
          return existing;
        }

        const newJob: Job = {
          id: `job-${jobStore.size + 1}`,
          organizationId: input.organizationId,
          type: input.type,
          payload: input.payload ?? {},
          status: "pending",
          idempotencyKey: input.idempotencyKey,
          attemptCount: 0,
          maxAttempts: input.maxAttempts ?? 3,
          availableAt: input.availableAt ?? new Date(),
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          lastError: null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
          failedAt: null,
        };

        jobStore.set(storeKey, newJob);
        enqueuedJobs.push(newJob);
        return newJob;
      },
    };

    server = createApiServer({
      wsOptions: { autoStartListener: false },
      githubWebhookDeps: webhookDeps,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;

    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  async function postWebhook(options: {
    path?: string;
    body: string | Buffer;
    event?: string;
    signature?: string;
    delivery?: string;
    contentType?: string;
  }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
    const rawBody = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, "utf8");
    const path = options.path ?? "/api/v1/webhooks/github";

    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {
        "content-type": options.contentType ?? "application/json",
        "content-length": rawBody.length,
      };

      if (options.event !== undefined) {
        headers["x-github-event"] = options.event;
      }
      if (options.signature !== undefined) {
        headers["x-hub-signature-256"] = options.signature;
      }
      if (options.delivery !== undefined) {
        headers["x-github-delivery"] = options.delivery;
      }

      const req = http.request(
        `${baseUrl}${path}`,
        {
          method: "POST",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: Record<string, unknown> = {};
            try {
              json = JSON.parse(text) as Record<string, unknown>;
            } catch {
              json = { raw: text };
            }
            resolve({
              status: res.statusCode ?? 500,
              headers: res.headers,
              body: json,
            });
          });
        },
      );

      req.on("error", reject);
      req.write(rawBody);
      req.end();
    });
  }

  it("1. valid pull_request.opened webhook is accepted", async () => {
    const payload = validPullRequestPayload({ action: "opened" });
    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-1",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body["ok"], true);
    assert.equal(res.body["status"], "accepted");
    assert.ok(typeof res.body["jobId"] === "string");
  });

  it("2. valid pull_request.synchronize webhook is accepted", async () => {
    const payload = validPullRequestPayload({ action: "synchronize" });
    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-2",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body["ok"], true);
    assert.equal(res.body["status"], "accepted");
    assert.ok(typeof res.body["jobId"] === "string");
  });

  it("3. invalid signature is rejected", async () => {
    const payload = validPullRequestPayload();
    const raw = JSON.stringify(payload);
    const badSignature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";

    const initialJobs = enqueuedJobs.length;
    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature: badSignature,
      delivery: "delivery-bad-sig",
    });

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      error: {
        code: "invalid_signature",
        message: "Signature verification failed.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("4. missing signature is rejected", async () => {
    const payload = validPullRequestPayload();
    const raw = JSON.stringify(payload);

    const initialJobs = enqueuedJobs.length;
    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      delivery: "delivery-no-sig",
    });

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      error: {
        code: "missing_signature",
        message: "Signature verification failed.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("5. tampered payload fails verification", async () => {
    const originalPayload = validPullRequestPayload();
    const originalRaw = JSON.stringify(originalPayload);
    const signature = computeGithubWebhookSignature(originalRaw, TEST_SECRET);

    const tamperedPayload = { ...originalPayload, number: 999 };
    const tamperedRaw = JSON.stringify(tamperedPayload);

    const initialJobs = enqueuedJobs.length;
    const res = await postWebhook({
      body: tamperedRaw,
      event: "pull_request",
      signature,
      delivery: "delivery-tampered",
    });

    assert.equal(res.status, 401);
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("6. unsupported pull-request actions are safely ignored", async () => {
    const initialJobs = enqueuedJobs.length;
    const unsupportedActions = ["closed", "reopened", "labeled", "assigned", "review_requested"];

    for (const action of unsupportedActions) {
      const payload = validPullRequestPayload({ action });
      const raw = JSON.stringify(payload);
      const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

      const res = await postWebhook({
        body: raw,
        event: "pull_request",
        signature,
        delivery: `delivery-action-${action}`,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body["ok"], true);
      assert.equal(res.body["status"], "ignored");
      assert.equal(res.body["reason"], "unsupported_action");
      assert.equal(res.body["action"], action);
    }

    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("7. unrelated GitHub webhook event types are ignored", async () => {
    const initialJobs = enqueuedJobs.length;
    const unrelatedEvents = ["push", "issues", "installation", "pull_request_review", "ping"];

    for (const event of unrelatedEvents) {
      const payload = { zen: "Design for failure.", hook_id: 12345 };
      const raw = JSON.stringify(payload);
      const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

      const res = await postWebhook({
        body: raw,
        event,
        signature,
        delivery: `delivery-event-${event}`,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body["ok"], true);
      assert.equal(res.body["status"], "ignored");
      assert.equal(res.body["reason"], "unsupported_event");
      assert.equal(res.body["event"], event);
    }

    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("8. malformed pull-request payload is rejected", async () => {
    const initialJobs = enqueuedJobs.length;
    const raw = "not a valid json string {[]";
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-malformed-json",
    });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: {
        code: "invalid_payload",
        message: "Request body must be valid JSON.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("9. missing repository identity is rejected", async () => {
    const initialJobs = enqueuedJobs.length;
    const payload = validPullRequestPayload();
    delete payload["repository"];

    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-missing-repo",
    });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: {
        code: "missing_repository_identity",
        message: "Repository identity is required.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("10. missing pull request number is rejected", async () => {
    const initialJobs = enqueuedJobs.length;
    const payload = validPullRequestPayload();
    delete payload["number"];
    const prObj = payload["pull_request"] as Record<string, unknown>;
    delete prObj["number"];

    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-missing-pr-num",
    });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: {
        code: "missing_pull_request_number",
        message: "Pull request number is required.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("11. missing installation identity is rejected", async () => {
    const initialJobs = enqueuedJobs.length;
    const payload = validPullRequestPayload();
    delete payload["installation"];

    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-missing-inst",
    });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: {
        code: "missing_installation_identity",
        message: "Installation identity is required.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("12. unknown/unmapped installation does not create tenant-scoped work", async () => {
    const initialJobs = enqueuedJobs.length;
    const payload = validPullRequestPayload({
      installation: { id: 999999999 },
    });

    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-unknown-inst",
    });

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: {
        code: "unknown_installation",
        message: "GitHub App installation is not registered.",
      },
    });
    assert.equal(enqueuedJobs.length, initialJobs);
  });

  it("13. verified event is normalized correctly", async () => {
    const deliveryId = "unique-delivery-step-41-norm";
    const payload = validPullRequestPayload({
      action: "opened",
      number: 84,
      pull_request: {
        number: 84,
        html_url: "https://github.com/acme-corp/service/pull/84",
        title: "Test PR Normalization",
        base: { ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        head: { ref: "feature/step-41", sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      },
      sender: { id: 777, login: "alice" },
    });

    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: deliveryId,
    });

    assert.equal(res.status, 200);

    const job = enqueuedJobs.find((j) => (j.payload as unknown as NormalizedPullRequestWebhookPayload).deliveryId === deliveryId);
    assert.ok(job !== undefined, "Expected enqueued job to exist");

    const normalized = job.payload as unknown as NormalizedPullRequestWebhookPayload;
    assert.equal(normalized.eventType, "pull_request");
    assert.equal(normalized.action, "opened");
    assert.equal(normalized.deliveryId, deliveryId);
    assert.equal(normalized.installationId, TEST_INSTALLATION_ID);
    assert.equal(normalized.repository.githubRepoId, "99887766");
    assert.equal(normalized.repository.name, "service");
    assert.equal(normalized.repository.owner, "acme-corp");
    assert.equal(normalized.repository.fullName, "acme-corp/service");
    assert.equal(normalized.pullRequest.number, 84);
    assert.equal(normalized.pullRequest.url, "https://github.com/acme-corp/service/pull/84");
    assert.equal(normalized.pullRequest.title, "Test PR Normalization");
    assert.equal(normalized.pullRequest.baseRef, "main");
    assert.equal(normalized.pullRequest.baseSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(normalized.pullRequest.headRef, "feature/step-41");
    assert.equal(normalized.pullRequest.headSha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.deepEqual(normalized.sender, { githubUserId: "777", login: "alice" });
  });

  it("14. normalized event contains server-derived tenant association", async () => {
    // Attempt spoofing tenant by injecting organizationId in payload
    const deliveryId = "delivery-tenant-isolation-check";
    const payload = validPullRequestPayload({
      organization_id: "99999999-9999-4999-8999-999999999999",
      organizationId: "99999999-9999-4999-8999-999999999999",
    });

    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: deliveryId,
    });

    assert.equal(res.status, 200);

    const job = enqueuedJobs.find((j) => (j.payload as unknown as NormalizedPullRequestWebhookPayload).deliveryId === deliveryId);
    assert.ok(job !== undefined);
    // Server-derived tenant MUST match known installation's organizationId, NOT the payload
    assert.equal(job.organizationId, TEST_ORG_ID);
    assert.equal((job.payload as unknown as NormalizedPullRequestWebhookPayload).organizationId, TEST_ORG_ID);
  });

  it("15. webhook processing uses the existing queue/job mechanism", async () => {
    const deliveryId = "delivery-existing-queue-check";
    const payload = validPullRequestPayload();
    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: deliveryId,
    });

    const job = enqueuedJobs.find((j) => (j.payload as unknown as NormalizedPullRequestWebhookPayload).deliveryId === deliveryId);
    assert.ok(job);
    assert.equal(job.type, PULL_REQUEST_WEBHOOK_JOB_TYPE);
    assert.equal(job.type, "pull_request.webhook");
    assert.equal(job.idempotencyKey, pullRequestWebhookIdempotencyKey(deliveryId));
    assert.equal(job.status, "pending");
  });

  it("16. duplicate delivery does not create duplicate downstream work when existing idempotency is applied", async () => {
    const deliveryId = "delivery-idempotency-dedup-100";
    const payload = validPullRequestPayload();
    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const initialJobsCount = enqueuedJobs.length;

    // First delivery
    const res1 = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: deliveryId,
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body["status"], "accepted");
    const firstJobId = res1.body["jobId"];

    assert.equal(enqueuedJobs.length, initialJobsCount + 1);

    // Second delivery of the exact same event / delivery ID
    const res2 = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: deliveryId,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body["status"], "accepted");
    assert.equal(res2.body["jobId"], firstJobId);

    // Zero duplicate jobs created!
    assert.equal(enqueuedJobs.length, initialJobsCount + 1);
  });

  it("17. webhook handling does not execute impact analysis synchronously", async () => {
    const deliveryId = "delivery-perf-sync-check";
    const payload = validPullRequestPayload();
    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const start = performance.now();
    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature,
      delivery: deliveryId,
    });
    const duration = performance.now() - start;

    assert.equal(res.status, 200);
    assert.equal(res.body["status"], "accepted");
    // Webhook should acknowledge fast (well under 500ms) without doing heavy impact traversal
    assert.ok(duration < 1000, `Webhook took ${duration}ms, should be fast`);
    assert.equal(res.body["impact"], undefined);
    assert.equal(res.body["blastRadius"], undefined);
  });

  it("18. secrets are never included in logs or responses", async () => {
    const payload = validPullRequestPayload();
    const raw = JSON.stringify(payload);
    const badSignature = "sha256=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    const res = await postWebhook({
      body: raw,
      event: "pull_request",
      signature: badSignature,
      delivery: "delivery-secret-check",
    });

    const responseText = JSON.stringify(res.body);
    assert.equal(responseText.includes(TEST_SECRET), false, "Response must never leak secret");

    const allLogs = loggedMessages.join("\n");
    assert.equal(allLogs.includes(TEST_SECRET), false, "Logs must never leak secret");
  });

  it("19. unsupported HTTP methods return 405 Method Not Allowed", async () => {
    const getRes = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/webhooks/github`,
        { method: "GET" },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(text) });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(getRes.status, 405);
    assert.deepEqual(getRes.body, {
      error: {
        code: "method_not_allowed",
        message: "Method not allowed.",
      },
    });
  });

  it("20. alternative path /api/v1/github/webhooks is also routed to the webhook handler", async () => {
    const payload = validPullRequestPayload({ action: "opened" });
    const raw = JSON.stringify(payload);
    const signature = computeGithubWebhookSignature(raw, TEST_SECRET);

    const res = await postWebhook({
      path: "/api/v1/github/webhooks",
      body: raw,
      event: "pull_request",
      signature,
      delivery: "delivery-alt-path",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body["ok"], true);
    assert.equal(res.body["status"], "accepted");
  });
});

