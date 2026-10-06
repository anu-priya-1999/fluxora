import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  createGithubRepositoryClient,
  GithubRepositoryRequestError,
} from "./repository-client.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const config = {
  appId: "123456",
  privateKeyPem: privateKey,
  apiBaseUrl: "https://api.github.com",
};

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LARGE_ID = "9223372036854775807";

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("fetches repository metadata and resolves the requested ref with a short-lived installation token", async () => {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
  }> = [];
  const client = createGithubRepositoryClient({
    config,
    now: new Date("2026-01-01T00:00:00.000Z"),
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });

      if (String(input).endsWith("/access_tokens")) {
        return json({ token: "ghs_installation_token" });
      }

      if (String(input).endsWith("/repos/octocat/demo")) {
        return json({
          id: 42,
          full_name: "octocat/demo",
          default_branch: "main",
        });
      }

      assert.equal(
        String(input),
        "https://api.github.com/repos/octocat/demo/commits/main",
      );
      return json({ sha: SHA });
    },
  });

  const result = await client.getRepositoryAndCommit(
    "123",
    "octocat/demo",
    "main",
  );

  assert.deepEqual(result, {
    repository: {
      githubRepoId: "42",
      fullName: "octocat/demo",
      defaultBranch: "main",
    },
    commit: { sha: SHA },
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0]?.authorization ?? "", /^Bearer ey/);
  assert.equal(calls[1]?.authorization, "Bearer ghs_installation_token");
  assert.equal(calls[2]?.authorization, "Bearer ghs_installation_token");
});

test("preserves a large GitHub repository id as a string before persistence", async () => {
  const client = createGithubRepositoryClient({
    config,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return json({ token: "ghs_test" });
      }
      if (url.endsWith("/repos/acme/large")) {
        return json({
          id: LARGE_ID,
          full_name: "acme/large",
          default_branch: "main",
        });
      }
      return json({ sha: SHA });
    },
  });

  const result = await client.getRepositoryAndCommit(
    "999",
    "acme/large",
    "main",
  );

  assert.equal(result.repository.githubRepoId, LARGE_ID);
});

test("classifies a missing ref as invalid_ref without exposing the response body", async () => {
  const client = createGithubRepositoryClient({
    config,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return json({ token: "ghs_test" });
      }
      if (url.includes("/repos/octocat/demo")) {
        return json({
          id: 42,
          full_name: "octocat/demo",
          default_branch: "main",
        });
      }
      return json({ secret: "do not log me" }, 404);
    },
  });

  await assert.rejects(
    () =>
      client.getRepositoryAndCommit("123", "octocat/demo", "does-not-exist"),
    (error: unknown) => {
      assert.ok(error instanceof GithubRepositoryRequestError);
      assert.equal(error.failure, "invalid_ref");
      assert.equal(error.message.includes("do not log me"), false);
      return true;
    },
  );
});

test("classifies GitHub rate limiting as retryable API pressure", async () => {
  const client = createGithubRepositoryClient({
    config,
    fetchImpl: async () =>
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  });

  await assert.rejects(
    () => client.getRepositoryAndCommit("123", "octocat/demo", "main"),
    (error: unknown) => {
      assert.ok(error instanceof GithubRepositoryRequestError);
      assert.equal(error.failure, "rate_limited");
      return true;
    },
  );
});
