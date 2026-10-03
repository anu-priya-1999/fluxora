import assert from "node:assert/strict";
import test from "node:test";

import { GITHUB_INSTALLATION_COMPLETION_PATH } from "@fluxora/shared-types";

import { completeGithubInstallationFromBrowser } from "./complete-setup.ts";
import {
  githubSetupOriginRedirect,
  readRequestPublicOrigin,
  readWebOrigin,
  resolveFluxoraApiUrl,
} from "./env.ts";
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

test("web origin ignores the per-deployment Vercel hostname", () => {
  const production = readWebOrigin({
    NEXT_PUBLIC_APP_URL: "",
    VERCEL_URL: "fluxora-9yp7s70sy-mera-baba.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "fluxora-rho-cyan.vercel.app",
  });

  assert.equal(production, "https://fluxora-rho-cyan.vercel.app");
  assert.equal(
    readWebOrigin({
      VERCEL_URL: "fluxora-9yp7s70sy-mera-baba.vercel.app",
    }),
    "http://localhost:3000",
  );
  assert.equal(
    readWebOrigin({
      NEXT_PUBLIC_APP_URL: "https://fluxora-rho-cyan.vercel.app",
      VERCEL_URL: "fluxora-9yp7s70sy-mera-baba.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "other.example",
    }),
    "https://fluxora-rho-cyan.vercel.app",
  );
});

test("GitHub setup on a deployment host redirects to the production origin before posting", () => {
  const requestOrigin = readRequestPublicOrigin({
    get(name: string) {
      if (name === "x-forwarded-host") {
        return "fluxora-9yp7s70sy-mera-baba.vercel.app";
      }
      if (name === "x-forwarded-proto") {
        return "https";
      }
      return null;
    },
  });

  assert.equal(
    requestOrigin,
    "https://fluxora-9yp7s70sy-mera-baba.vercel.app",
  );

  const decision = githubSetupOriginRedirect({
    requestOrigin,
    installationId: "845012345",
    setupAction: "install",
    env: {
      VERCEL_URL: "fluxora-9yp7s70sy-mera-baba.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "fluxora-rho-cyan.vercel.app",
    },
  });

  assert.deepEqual(decision, {
    type: "redirect",
    url: "https://fluxora-rho-cyan.vercel.app/github/setup?installation_id=845012345&setup_action=install",
  });

  assert.deepEqual(
    githubSetupOriginRedirect({
      requestOrigin: "https://fluxora-rho-cyan.vercel.app",
      installationId: "845012345",
      setupAction: "install",
      env: {
        VERCEL_PROJECT_PRODUCTION_URL: "fluxora-rho-cyan.vercel.app",
      },
    }),
    { type: "stay" },
  );

  assert.deepEqual(
    githubSetupOriginRedirect({
      requestOrigin: "https://fluxora-9yp7s70sy-mera-baba.vercel.app",
      installationId: "845012345",
      setupAction: "install",
      env: {
        VERCEL_URL: "fluxora-9yp7s70sy-mera-baba.vercel.app",
      },
    }),
    { type: "misconfigured" },
  );
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

test("setup completion distinguishes an unreachable API from a GitHub verification failure", async () => {
  const unreachable = await completeGithubInstallationFromBrowser({
    apiUrl: "https://api.fluxora.example",
    installationId: "845012345",
    getToken: async () => "session-token",
    fetchImpl: async () => {
      throw new Error("Failed to fetch");
    },
  });
  assert.deepEqual(unreachable, {
    ok: false,
    message: "The Fluxora API could not be reached from this page.",
  });

  const unavailable = await completeGithubInstallationFromBrowser({
    apiUrl: "https://api.fluxora.example",
    installationId: "845012345",
    getToken: async () => "session-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "github_unavailable",
            message: "GitHub could not be reached to verify the installation.",
          },
        }),
        { status: 502 },
      ),
  });
  assert.deepEqual(unavailable, {
    ok: false,
    message: "GitHub could not be reached to verify the installation.",
  });

  const unknown = await completeGithubInstallationFromBrowser({
    apiUrl: "https://api.fluxora.example",
    installationId: "845012345",
    getToken: async () => "session-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
      }),
  });
  assert.deepEqual(unknown, {
    ok: false,
    message: "GitHub installation could not be completed.",
  });
});
