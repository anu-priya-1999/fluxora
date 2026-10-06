import assert from "node:assert/strict";
import test from "node:test";

import {
  isRepositoryConnectPath,
  parseConnectBody,
  REPOSITORY_CONNECT_PATH,
} from "./repository-request.ts";

test("recognizes the repository connect endpoint", () => {
  assert.equal(REPOSITORY_CONNECT_PATH, "/api/v1/repositories/connect");
  assert.equal(isRepositoryConnectPath(REPOSITORY_CONNECT_PATH), true);
  assert.equal(isRepositoryConnectPath("/api/v1/repositories"), false);
});

test("parses the documented repository connect request", () => {
  assert.deepEqual(
    parseConnectBody({
      github_installation_id: "12345678",
      repo_full_name: "acme-corp/checkout-service",
      branch: "main",
    }),
    {
      githubInstallationId: "12345678",
      repoFullName: "acme-corp/checkout-service",
      ref: "main",
    },
  );
});

test("rejects a numeric installation id to avoid integer precision loss", () => {
  assert.throws(() =>
    parseConnectBody({
      github_installation_id: 12345678,
      repo_full_name: "acme-corp/checkout-service",
      branch: "main",
    }),
  );
});

test("rejects malformed repository names", () => {
  assert.throws(() =>
    parseConnectBody({
      github_installation_id: "12345678",
      repo_full_name: "acme-corp",
      branch: "main",
    }),
  );
});

test("rejects control characters and empty refs", () => {
  assert.throws(() =>
    parseConnectBody({
      github_installation_id: "12345678",
      repo_full_name: "acme-corp/checkout-service",
      branch: "",
    }),
  );

  assert.throws(() =>
    parseConnectBody({
      github_installation_id: "12345678",
      repo_full_name: "acme-corp/checkout-service",
      branch: "refs/heads/main\nAuthorization: Bearer secret",
    }),
  );
});
