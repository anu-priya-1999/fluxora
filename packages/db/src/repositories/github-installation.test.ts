import assert from "node:assert/strict";
import test from "node:test";

import { planGithubInstallationWrite } from "./github-installation.ts";

const account = {
  githubAccountId: "4242",
  githubAccountLogin: "octocat",
  githubAccountType: "User" as const,
};

test("installation write plan inserts when the organization has no row", () => {
  assert.deepEqual(
    planGithubInstallationWrite(null, {
      githubInstallationId: "9007199254740993",
      ...account,
    }),
    { action: "insert" },
  );
});

test("installation write plan is unchanged for the same installation", () => {
  const existing = {
    githubInstallationId: "100",
    ...account,
  };

  assert.deepEqual(planGithubInstallationWrite(existing, existing), {
    action: "unchanged",
  });
});

test("installation write plan refreshes a reinstall for the same GitHub account", () => {
  assert.deepEqual(
    planGithubInstallationWrite(
      {
        githubInstallationId: "100",
        ...account,
      },
      {
        githubInstallationId: "200",
        githubAccountId: account.githubAccountId,
        githubAccountLogin: "octocat",
        githubAccountType: "User",
      },
    ),
    { action: "refresh" },
  );
});

test("installation write plan rejects a different GitHub account", () => {
  assert.deepEqual(
    planGithubInstallationWrite(
      {
        githubInstallationId: "100",
        ...account,
      },
      {
        githubInstallationId: "100",
        githubAccountId: "999",
        githubAccountLogin: "other",
        githubAccountType: "User",
      },
    ),
    { action: "reject" },
  );
});
