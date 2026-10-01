import assert from "node:assert/strict";
import test from "node:test";

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
