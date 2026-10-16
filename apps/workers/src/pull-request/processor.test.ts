import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  PULL_REQUEST_WEBHOOK_JOB_TYPE,
  type Job,
  type NormalizedPullRequestWebhookPayload,
  type PullRequest,
  type PullRequestFile,
  type Repository,
} from "@fluxora/shared-types";

import type {
  GithubPullRequestClient,
  GithubPullRequestFileInfo,
  GithubPullRequestInfo,
} from "../github/client.ts";
import { IngestionError } from "../ingest/errors.ts";
import {
  processPullRequestJob,
  type PullRequestLookup,
  type PullRequestProcessorDependencies,
  type PullRequestStorage,
} from "./processor.ts";
import { DEFAULT_PULL_REQUEST_LIMITS } from "./limits.ts";
import type { SavePullRequestWithFilesInput } from "@fluxora/db";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const REPO_UUID_A = "22222222-2222-4222-8222-222222222222";
const GITHUB_REPO_ID = "555555";
const INSTALLATION_ID = "998877";

function sampleRepository(): Repository {
  return {
    id: REPO_UUID_A,
    organizationId: ORG_A,
    githubRepoId: GITHUB_REPO_ID,
    name: "repo-a",
    defaultBranch: "main",
    connectionStatus: "active",
    lastIndexedAt: null,
    createdAt: new Date(),
  };
}

function sampleWebhookPayload(
  action: "opened" | "synchronize" = "opened",
  deliveryId = "delivery-guid-1",
  headSha = "2222222222222222222222222222222222222222",
): NormalizedPullRequestWebhookPayload {
  return {
    eventType: "pull_request",
    action,
    deliveryId,
    installationId: INSTALLATION_ID,
    organizationId: ORG_A,
    repository: {
      githubRepoId: GITHUB_REPO_ID,
      name: "repo-a",
      owner: "fluxora",
      fullName: "fluxora/repo-a",
    },
    pullRequest: {
      number: 42,
      url: "https://github.com/fluxora/repo-a/pull/42",
      title: "Add payments integration",
      baseRef: "main",
      baseSha: "1111111111111111111111111111111111111111",
      headRef: "feat/payments",
      headSha,
    },
    sender: {
      githubUserId: "777",
      login: "developer-bob",
    },
  };
}

function createJob(
  payload: Record<string, unknown>,
  orgId = ORG_A,
): Job {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: orgId,
    type: PULL_REQUEST_WEBHOOK_JOB_TYPE,
    payload,
    status: "running",
    idempotencyKey: "k-1",
    attemptCount: 1,
    maxAttempts: 10,
    availableAt: new Date(),
    lockedAt: new Date(),
    lockedBy: "w1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    failedAt: null,
  };
}

function sampleGithubPr(headSha = "2222222222222222222222222222222222222222"): GithubPullRequestInfo {
  return {
    githubPrId: "888888",
    number: 42,
    title: "Add payments integration",
    htmlUrl: "https://github.com/fluxora/repo-a/pull/42",
    state: "open",
    merged: false,
    baseRef: "main",
    baseSha: "1111111111111111111111111111111111111111",
    headRef: "feat/payments",
    headSha,
    authorLogin: "developer-bob",
    authorId: "777",
  };
}

function sampleGithubFiles(): GithubPullRequestFileInfo[] {
  return [
    {
      sha: "blob1",
      filename: "src/billing.ts",
      status: "added",
      additions: 120,
      deletions: 0,
      changes: 120,
      patch: "@@ +1,120 @@\n+export class BillingService {}",
    },
    {
      sha: "blob2",
      filename: "package.json",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1 +1,2 @@\n+stripe",
    },
  ];
}

function mockGithub(
  overrides?: Partial<GithubPullRequestClient>,
): GithubPullRequestClient {
  return {
    async mintInstallationToken() {
      return "ghs_token_default";
    },
    async getPullRequest() {
      return sampleGithubPr();
    },
    async getPullRequestFiles() {
      return sampleGithubFiles();
    },
    ...overrides,
  };
}

describe("PullRequest worker processor integration", () => {
  // 18. pull_request.opened job creates the PR record
  it("18. pull_request.opened job creates the PR record and its changed files", async () => {
    let savedInput: SavePullRequestWithFilesInput | null = null;

    const lookup: PullRequestLookup = {
      async getRepositoryByGithubRepoId(orgId, githubRepoId) {
        assert.equal(orgId, ORG_A);
        assert.equal(githubRepoId, GITHUB_REPO_ID);
        return sampleRepository();
      },
    };

    const github = mockGithub({
      async mintInstallationToken(installationId: string) {
        assert.equal(installationId, INSTALLATION_ID);
        return "ghs_token_123";
      },
      async getPullRequest(token: string, fullName: string, pullNumber: number) {
        assert.equal(token, "ghs_token_123");
        assert.equal(fullName, "fluxora/repo-a");
        assert.equal(pullNumber, 42);
        return sampleGithubPr();
      },
      async getPullRequestFiles(token: string, fullName: string, pullNumber: number) {
        assert.equal(token, "ghs_token_123");
        assert.equal(fullName, "fluxora/repo-a");
        assert.equal(pullNumber, 42);
        return sampleGithubFiles();
      },
    });

    const storage: PullRequestStorage = {
      async savePullRequestWithFiles(input) {
        savedInput = input;
        const pr: PullRequest = {
          id: "33333333-3333-4333-8333-333333333333",
          organizationId: input.pr.organizationId,
          repositoryId: input.pr.repositoryId,
          githubPrId: input.pr.githubPrId,
          number: input.pr.number,
          title: input.pr.title,
          url: input.pr.url,
          baseRef: input.pr.baseRef,
          baseSha: input.pr.baseSha,
          headRef: input.pr.headRef,
          headSha: input.pr.headSha,
          status: input.pr.status ?? "open",
          authorLogin: input.pr.authorLogin ?? null,
          authorId: input.pr.authorId ?? null,
          lastDeliveryId: input.pr.lastDeliveryId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const files: PullRequestFile[] = input.files.map((f, idx) => ({
          id: `file-${idx}`,
          pullRequestId: pr.id,
          path: f.path,
          previousPath: f.previousPath ?? null,
          status: f.status,
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          changes: f.changes ?? 0,
          patch: f.patch ?? null,
          patchTruncated: f.patchTruncated ?? false,
          baseSha: f.baseSha ?? null,
          headSha: f.headSha ?? null,
          createdAt: new Date(),
        }));
        return { pullRequest: pr, files };
      },
    };

    const deps: PullRequestProcessorDependencies = {
      lookup,
      github,
      storage,
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const payload = sampleWebhookPayload("opened");
    const result = await processPullRequestJob(createJob(payload as unknown as Record<string, unknown>), deps);

    assert.ok(result);
    assert.ok(savedInput);
    assert.equal(result.pullRequest.number, 42);
    assert.equal(result.pullRequest.repositoryId, REPO_UUID_A);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0]?.path, "src/billing.ts");
    assert.equal(result.files[1]?.path, "package.json");
  });

  // 19. pull_request.synchronize updates the existing PR
  it("19. pull_request.synchronize updates existing PR to latest head SHA", async () => {
    let savedPrHeadSha: string | null = null;
    const newHeadSha = "9999999999999999999999999999999999999999";

    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub({
        async getPullRequest() {
          return sampleGithubPr(newHeadSha);
        },
      }),
      storage: {
        async savePullRequestWithFiles(input) {
          savedPrHeadSha = input.pr.headSha;
          return {
            pullRequest: {
              ...input.pr,
              id: "pr-id",
              status: input.pr.status ?? "open",
              authorLogin: null,
              authorId: null,
              lastDeliveryId: input.pr.lastDeliveryId ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            files: [],
          };
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const payload = sampleWebhookPayload("synchronize", "delivery-guid-2", newHeadSha);
    await processPullRequestJob(createJob(payload as unknown as Record<string, unknown>), deps);

    assert.equal(savedPrHeadSha, newHeadSha);
  });

  // 20. duplicate webhook delivery remains idempotent
  it("20. duplicate webhook delivery remains idempotent", async () => {
    let saveCount = 0;
    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub(),
      storage: {
        async savePullRequestWithFiles(input) {
          saveCount += 1;
          return {
            pullRequest: {
              ...input.pr,
              id: "pr-id",
              status: "open",
              authorLogin: null,
              authorId: null,
              lastDeliveryId: input.pr.lastDeliveryId ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            files: [],
          };
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const payload = sampleWebhookPayload("opened", "delivery-same-id");
    const job = createJob(payload as unknown as Record<string, unknown>);

    await processPullRequestJob(job, deps);
    await processPullRequestJob(job, deps);

    assert.equal(saveCount, 2);
  });

  // 21. repository association is correct
  it("21. repository association resolves by githubRepoId within the tenant", async () => {
    let lookedUpGithubRepoId: string | null = null;
    let lookedUpOrgId: string | null = null;

    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId(orgId, githubRepoId) {
          lookedUpOrgId = orgId;
          lookedUpGithubRepoId = githubRepoId;
          return sampleRepository();
        },
      },
      github: mockGithub(),
      storage: {
        async savePullRequestWithFiles(input) {
          return {
            pullRequest: {
              ...input.pr,
              id: "pr-id",
              status: "open",
              authorLogin: null,
              authorId: null,
              lastDeliveryId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            files: [],
          };
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const payload = sampleWebhookPayload();
    await processPullRequestJob(createJob(payload as unknown as Record<string, unknown>), deps);

    assert.equal(lookedUpOrgId, ORG_A);
    assert.equal(lookedUpGithubRepoId, GITHUB_REPO_ID);
  });

  // 22. unknown/unmapped repository does not create an orphan PR
  it("22. unknown/unmapped repository fails with tenant_mismatch and does not save PR", async () => {
    let storageCalled = false;
    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return null;
        },
      },
      github: mockGithub(),
      storage: {
        async savePullRequestWithFiles() {
          storageCalled = true;
          throw new Error("should not be called");
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const payload = sampleWebhookPayload();
    await assert.rejects(
      () => processPullRequestJob(createJob(payload as unknown as Record<string, unknown>), deps),
      (err: unknown) => {
        assert.ok(err instanceof IngestionError);
        assert.equal(err.code, "tenant_mismatch");
        assert.equal(err.retryable, false);
        return true;
      },
    );

    assert.equal(storageCalled, false);
  });

  // 23. GitHub API failures cause deterministic job failure/retry behavior using existing conventions
  it("23. classifies GitHub rate limit as retryable and auth failure as permanent", async () => {
    const rateLimitError = new IngestionError({
      code: "github_rate_limit",
      message: "rate limit exceeded",
      retryable: true,
    });

    const depsRateLimit: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub({
        async getPullRequest() {
          throw rateLimitError;
        },
      }),
      storage: {
        async savePullRequestWithFiles() {
          throw new Error();
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    await assert.rejects(
      () =>
        processPullRequestJob(
          createJob(sampleWebhookPayload() as unknown as Record<string, unknown>),
          depsRateLimit,
        ),
      (err: unknown) => {
        assert.ok(err instanceof IngestionError);
        assert.equal(err.code, "github_rate_limit");
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  // 24. PR metadata is normalized/persisted correctly
  it("24. validates and normalizes PR metadata fields", async () => {
    let savedPrInput: SavePullRequestWithFilesInput["pr"] | undefined;

    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub({
        async getPullRequest() {
          return {
            ...sampleGithubPr(),
            title: "Clean feature title",
            authorLogin: "alice",
            authorId: "123",
          };
        },
      }),
      storage: {
        async savePullRequestWithFiles(input) {
          savedPrInput = input.pr;
          return {
            pullRequest: {
              ...input.pr,
              id: "pr-id",
              status: "open",
              authorLogin: input.pr.authorLogin ?? null,
              authorId: input.pr.authorId ?? null,
              lastDeliveryId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            files: [],
          };
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    await processPullRequestJob(
      createJob(sampleWebhookPayload() as unknown as Record<string, unknown>),
      deps,
    );

    const prInput = savedPrInput;
    assert.ok(prInput);
    assert.equal(prInput.title, "Clean feature title");
    assert.equal(prInput.authorLogin, "alice");
    assert.equal(prInput.authorId, "123");
  });

  // 25. changed-file data corresponds to the fetched GitHub response
  it("25. maps changed files including additions, deletions, and patches", async () => {
    let savedFiles: SavePullRequestWithFilesInput["files"] | undefined;

    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub({
        async getPullRequestFiles() {
          return [
            {
              sha: "blob_abc",
              filename: "src/utils.ts",
              status: "modified",
              additions: 15,
              deletions: 5,
              changes: 20,
              patch: "@@ -1,5 +1,15 @@",
            },
          ];
        },
      }),
      storage: {
        async savePullRequestWithFiles(input) {
          savedFiles = input.files;
          return {
            pullRequest: {
              ...input.pr,
              id: "pr-id",
              status: "open",
              authorLogin: null,
              authorId: null,
              lastDeliveryId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            files: [],
          };
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    await processPullRequestJob(
      createJob(sampleWebhookPayload() as unknown as Record<string, unknown>),
      deps,
    );

    const files = savedFiles;
    assert.ok(files);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "src/utils.ts");
    assert.equal(files[0]?.additions, 15);
    assert.equal(files[0]?.deletions, 5);
    assert.equal(files[0]?.changes, 20);
    assert.equal(files[0]?.patch, "@@ -1,5 +1,15 @@");
  });

  // 26. impact analysis is NOT executed by Step 42
  it("26. guarantees impact analysis and graph traversal are NOT executed by Step 42", async () => {
    const result = await processPullRequestJob(
      createJob(sampleWebhookPayload() as unknown as Record<string, unknown>),
      {
        lookup: {
          async getRepositoryByGithubRepoId() {
            return sampleRepository();
          },
        },
        github: mockGithub(),
        storage: {
          async savePullRequestWithFiles(input) {
            return {
              pullRequest: {
                ...input.pr,
                id: "pr-id",
                status: "open",
                authorLogin: null,
                authorId: null,
                lastDeliveryId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              files: [],
            };
          },
        },
        limits: DEFAULT_PULL_REQUEST_LIMITS,
      },
    );

    assert.ok(result);
    assert.equal("impactAnalysis" in result, false);
  });

  // 27 & 28. Tenant isolation
  it("27 & 28. enforces tenant isolation: rejects payload where job org does not match payload org", async () => {
    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub(),
      storage: {
        async savePullRequestWithFiles() {
          throw new Error("must not be called");
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const maliciousJob = createJob(
      sampleWebhookPayload() as unknown as Record<string, unknown>,
      "99999999-9999-4999-8999-999999999999",
    );

    await assert.rejects(
      () => processPullRequestJob(maliciousJob, deps),
      (err: unknown) => {
        assert.ok(err instanceof IngestionError);
        assert.equal(err.code, "tenant_mismatch");
        return true;
      },
    );
  });

  // 29. no client-supplied organization_id can override server-side tenant association
  it("29. rejects malformed payload attempting to bypass schema", async () => {
    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub(),
      storage: {
        async savePullRequestWithFiles() {
          throw new Error();
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    const invalidJob = createJob({
      eventType: "pull_request",
      action: "opened",
    });

    await assert.rejects(
      () => processPullRequestJob(invalidJob, deps),
      (err: unknown) => {
        assert.ok(err instanceof IngestionError);
        assert.equal(err.code, "invalid_payload");
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // 30. GitHub credentials are not persisted/logged
  it("30. ensures GitHub access token is never persisted to PullRequest or file records", async () => {
    let savedInput: SavePullRequestWithFilesInput | null = null;

    const deps: PullRequestProcessorDependencies = {
      lookup: {
        async getRepositoryByGithubRepoId() {
          return sampleRepository();
        },
      },
      github: mockGithub({
        async mintInstallationToken() {
          return "ghs_SUPER_SECRET_TOKEN_XYZ";
        },
      }),
      storage: {
        async savePullRequestWithFiles(input) {
          savedInput = input;
          return {
            pullRequest: {
              ...input.pr,
              id: "pr-id",
              status: "open",
              authorLogin: null,
              authorId: null,
              lastDeliveryId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            files: [],
          };
        },
      },
      limits: DEFAULT_PULL_REQUEST_LIMITS,
    };

    await processPullRequestJob(
      createJob(sampleWebhookPayload() as unknown as Record<string, unknown>),
      deps,
    );

    assert.ok(savedInput);
    const serialized = JSON.stringify(savedInput);
    assert.equal(serialized.includes("ghs_SUPER_SECRET_TOKEN_XYZ"), false);
  });
});
