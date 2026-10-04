import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

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
