import type { GithubAppConfig } from "./config.ts";
import {
  parseGithubInstallationResponse,
  type ParsedGithubInstallation,
} from "./parse-installation.ts";

export class InstallationOwnershipError extends Error {
  constructor() {
    super("GitHub installation does not belong to the signed-in GitHub account.");
    this.name = "InstallationOwnershipError";
  }
}

export class GithubAppRequestError extends Error {
  readonly status: "not_found" | "misconfigured" | "unavailable";

  constructor(status: "not_found" | "misconfigured" | "unavailable") {
    super("GitHub installation request failed.");
    this.name = "GithubAppRequestError";
    this.status = status;
  }
}

export interface FetchGithubInstallationInput {
  config: GithubAppConfig;
  installationId: string;
  appJwt: string;
  fetchImpl?: typeof fetch;
}

/**
 * Loads the installation with the App JWT and checks it belongs to the
 * Clerk user's GitHub account. Organization installations are rejected:
 * their account id is the org id, not the signed-in user.
 */
export async function verifyGithubInstallationOwnership(
  input: FetchGithubInstallationInput & { githubUserId: string },
): Promise<ParsedGithubInstallation & { accountType: "User" }> {
  const installation = await fetchGithubInstallation(input);

  if (
    installation.accountType !== "User" ||
    installation.accountId !== input.githubUserId ||
    installation.installationId !== input.installationId
  ) {
    throw new InstallationOwnershipError();
  }

  return {
    installationId: installation.installationId,
    accountId: installation.accountId,
    accountLogin: installation.accountLogin,
    accountType: "User",
  };
}

export async function fetchGithubInstallation(
  input: FetchGithubInstallationInput,
): Promise<ParsedGithubInstallation> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${input.config.apiBaseUrl}/app/installations/${input.installationId}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.appJwt}`,
        "user-agent": "fluxora",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubAppRequestError("unavailable");
  }

  if (response.status === 404) {
    throw new GithubAppRequestError("not_found");
  }

  if (response.status === 401) {
    throw new GithubAppRequestError("misconfigured");
  }

  if (!response.ok) {
    throw new GithubAppRequestError("unavailable");
  }

  const body = await response.text();
  return parseGithubInstallationResponse(body);
}
