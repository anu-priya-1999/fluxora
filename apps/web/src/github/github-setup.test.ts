import assert from "node:assert/strict";
import test from "node:test";

import { GITHUB_INSTALLATION_COMPLETION_PATH } from "@fluxora/shared-types";

import { completeGithubInstallationFromBrowser } from "./complete-setup.ts";
import { resolveFluxoraApiUrl } from "./env.ts";
import { githubAppInstallUrl } from "./install-url.ts";

test("Connect GitHub uses the App slug and never an installation id", () => {
  assert.equal(
    githubAppInstallUrl("fluxora-dev"),
    "https://github.com/apps/fluxora-dev/installations/new",
  );
  assert.equal(githubAppInstallUrl(undefined), null);
  assert.equal(githubAppInstallUrl(" ../evil"), null);
  assert.equal(githubAppInstallUrl("fluxora?installation_id=1"), null);
});

test("setup completion only posts the session token to the Fluxora API origin", () => {
  assert.equal(resolveFluxoraApiUrl(undefined), "http://127.0.0.1:4000");
  assert.equal(
    resolveFluxoraApiUrl("https://api.fluxora.example/v1"),
    "https://api.fluxora.example",
  );
  assert.throws(
    () => resolveFluxoraApiUrl("http://evil.example"),
    /https/,
  );
  assert.throws(
    () => resolveFluxoraApiUrl("https://user:secret@api.fluxora.example"),
    /credentials/,
  );
});

test("setup completion posts the browser session token to the Fluxora API", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const result = await completeGithubInstallationFromBrowser({
    apiUrl: "https://api.fluxora.example",
    installationId: "845012345",
    getToken: async () => "session-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ created: true }), { status: 200 });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    `https://api.fluxora.example${GITHUB_INSTALLATION_COMPLETION_PATH}`,
  );
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(calls[0]?.init.headers, {
    accept: "application/json",
    Authorization: "Bearer session-token",
    "content-type": "application/json",
  });
  assert.equal(
    calls[0]?.init.body,
    JSON.stringify({ github_installation_id: "845012345" }),
  );
  assert.deepEqual(result, { ok: true, created: true });
});

test("setup completion does not call the API when the browser session token is missing", async () => {
  let called = false;

  const result = await completeGithubInstallationFromBrowser({
    apiUrl: "https://api.fluxora.example",
    installationId: "845012345",
    getToken: async () => null,
    fetchImpl: async () => {
      called = true;
      return new Response(null, { status: 500 });
    },
  });

  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    message: "Authentication required.",
  });
});
