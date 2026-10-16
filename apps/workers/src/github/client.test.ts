import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "vitest";

import { createGithubIngestClient } from "./client.ts";
import { IngestionError } from "../ingest/errors.ts";
import { gzipTar } from "../ingest/tar-fixture.ts";

const config = {
  appId: "1",
  privateKeyPem: "unused-in-these-tests",
  apiBaseUrl: "https://api.github.com",
};

test("GitHub 403 with remaining=0 is classified as retryable rate limiting", async () => {
  const client = createGithubIngestClient({
    config,
    fetchImpl: async () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  });

  await assert.rejects(
    () => client.getRepository("ghs_test", "1"),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "github_rate_limit");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("GitHub 401 is classified as needs_reauth and is permanent", async () => {
  const client = createGithubIngestClient({
    config,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });

  await assert.rejects(
    () => client.getRepository("ghs_test", "1"),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "github_auth");
      assert.equal(error.repositoryStatus, "needs_reauth");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("GitHub 404 for inaccessible repository is classified as needs_reauth and is permanent", async () => {
  const client = createGithubIngestClient({
    config,
    fetchImpl: async () => new Response("{}", { status: 404 }),
  });

  await assert.rejects(
    () => client.getRepository("ghs_test", "1"),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "github_auth");
      assert.equal(error.repositoryStatus, "needs_reauth");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("temporary GitHub 503 outage is classified as retryable without changing repository status", async () => {
  const client = createGithubIngestClient({
    config,
    fetchImpl: async () => new Response("{}", { status: 503 }),
  });

  await assert.rejects(
    () => client.getRepository("ghs_test", "1"),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "github_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.repositoryStatus, null);
      return true;
    },
  );
});

test("temporary GitHub timeout is classified as retryable timeout without changing repository status", async () => {
  const client = createGithubIngestClient({
    config,
    fetchImpl: async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      throw abortError;
    },
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      client.downloadTarball(
        "ghs_test",
        "octocat/demo",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        {
          maxFileCount: 10,
          maxTotalBytes: 1000,
          maxArchiveBytes: 10_000,
          timeoutMs: 5_000,
        },
        controller.signal,
      ),
    (error: unknown) => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
      assert.equal(error.repositoryStatus, null);
      return true;
    },
  );
});

test("archive download follows GitHub redirects without forwarding the installation token", async () => {
  const seenAuth: Array<string | null> = [];
  const archive = gzipTar([
    { name: "repo-sha/a.txt", body: Buffer.from("a", "utf8") },
  ]);
  const client = createGithubIngestClient({
    config,
    fetchImpl: async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      seenAuth.push(authorization);
      const href = String(url);
      if (href.startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://codeload.github.com/tarball/abc" },
        });
      }
      return new Response(archive, { status: 200 });
    },
  });

  const stream = await client.downloadTarball(
    "ghs_secret",
    "octocat/demo",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    {
      maxFileCount: 10,
      maxTotalBytes: 1000,
      maxArchiveBytes: 10_000,
      timeoutMs: 5_000,
    },
    AbortSignal.timeout(5_000),
  );
  assert.ok(stream instanceof Readable);
  assert.deepEqual(seenAuth, ["Bearer ghs_secret", null]);
});

test("getPullRequest retrieves PR metadata and maps fields accurately", async () => {
  const client = createGithubIngestClient({
    config,
    fetchImpl: async (url, init) => {
      assert.equal(
        String(url),
        "https://api.github.com/repos/octocat/demo/pulls/42",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer ghs_test_token",
      );
      return new Response(
        JSON.stringify({
          id: 12345678,
          number: 42,
          title: "Feature branch update",
          html_url: "https://github.com/octocat/demo/pull/42",
          state: "open",
          merged: false,
          base: {
            ref: "main",
            sha: "1111111111111111111111111111111111111111",
          },
          head: {
            ref: "feat",
            sha: "2222222222222222222222222222222222222222",
          },
          user: {
            id: 999,
            login: "mona",
          },
        }),
        { status: 200 },
      );
    },
  });

  const pr = await client.getPullRequest("ghs_test_token", "octocat/demo", 42);
  assert.equal(pr.githubPrId, "12345678");
  assert.equal(pr.number, 42);
  assert.equal(pr.title, "Feature branch update");
  assert.equal(pr.state, "open");
  assert.equal(pr.merged, false);
  assert.equal(pr.baseRef, "main");
  assert.equal(pr.baseSha, "1111111111111111111111111111111111111111");
  assert.equal(pr.headRef, "feat");
  assert.equal(pr.headSha, "2222222222222222222222222222222222222222");
  assert.equal(pr.authorLogin, "mona");
  assert.equal(pr.authorId, "999");
});

test("getPullRequestFiles fetches files across pages and parses patches", async () => {
  const seenPages: string[] = [];
  const client = createGithubIngestClient({
    config,
    fetchImpl: async (url) => {
      const urlStr = String(url);
      seenPages.push(urlStr);
      if (urlStr.includes("page=1")) {
        return new Response(
          JSON.stringify([
            {
              sha: "aaaa",
              filename: "src/file1.ts",
              status: "added",
              additions: 10,
              deletions: 0,
              changes: 10,
              patch: "@@ +1 @@",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });

  const files = await client.getPullRequestFiles("ghs_token", "octocat/demo", 42);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.filename, "src/file1.ts");
  assert.equal(files[0]?.status, "added");
  assert.equal(files[0]?.patch, "@@ +1 @@");
});
