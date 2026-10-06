import type { GithubAppConfig } from "./config.ts";
import { createGithubAppJwt, GithubAppJwtError } from "./jwt.ts";
import { quoteJsonIntegers } from "./parse-installation.ts";

export type GithubRepositoryRequestFailure =
  | "misconfigured"
  | "not_found"
  | "github_auth"
  | "invalid_ref"
  | "rate_limited"
  | "unavailable";

export class GithubRepositoryRequestError extends Error {
  readonly failure: GithubRepositoryRequestFailure;

  constructor(failure: GithubRepositoryRequestFailure, message: string) {
    super(message);
    this.name = "GithubRepositoryRequestError";
    this.failure = failure;
  }
}

export interface GithubRepositoryInfo {
  githubRepoId: string;
  fullName: string;
  defaultBranch: string;
}

export interface GithubRepositoryCommit {
  sha: string;
}

export interface GithubRepositoryClient {
  getRepositoryAndCommit(
    installationId: string,
    repoFullName: string,
    ref: string,
  ): Promise<{
    repository: GithubRepositoryInfo;
    commit: GithubRepositoryCommit;
  }>;
}

const REPOSITORY_FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const GITHUB_ID = /^[1-9]\d*$/;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

export function createGithubRepositoryClient(input: {
  config: GithubAppConfig;
  fetchImpl?: typeof fetch;
  now?: Date;
}): GithubRepositoryClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiBaseUrl = input.config.apiBaseUrl.replace(/\/$/, "");

  return {
    async getRepositoryAndCommit(installationId, repoFullName, ref) {
      validateGithubId(installationId);

      const accessToken = await mintInstallationToken(
        fetchImpl,
        apiBaseUrl,
        input.config,
        installationId,
        input.now,
      );

      const repository = await fetchRepository(
        fetchImpl,
        apiBaseUrl,
        accessToken,
        repoFullName,
      );

      const commit = await resolveCommit(
        fetchImpl,
        apiBaseUrl,
        accessToken,
        repository.fullName,
        ref,
      );

      return { repository, commit };
    },
  };
}

export function parseRepositoryFullName(value: unknown): {
  owner: string;
  name: string;
} {
  if (typeof value !== "string" || !REPOSITORY_FULL_NAME.test(value)) {
    throw new Error("repo_full_name must use the owner/name format.");
  }

  const slash = value.indexOf("/");
  return {
    owner: value.slice(0, slash),
    name: value.slice(slash + 1),
  };
}

async function mintInstallationToken(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  config: GithubAppConfig,
  installationId: string,
  now: Date | undefined,
): Promise<string> {
  let appJwt: string;

  try {
    appJwt = createGithubAppJwt({
      appId: config.appId,
      privateKeyPem: config.privateKeyPem,
      ...(now === undefined ? {} : { now }),
    });
  } catch (error) {
    if (error instanceof GithubAppJwtError) {
      throw new GithubRepositoryRequestError(
        "misconfigured",
        "GitHub App credentials could not be used.",
      );
    }

    throw error;
  }

  const response = await githubFetch(
    fetchImpl,
    `${apiBaseUrl}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      authorization: `Bearer ${appJwt}`,
      apiBaseUrl,
    },
  );

  const body = await readJson(response);
  const token = body["token"];

  if (typeof token !== "string" || token.length === 0) {
    throw new GithubRepositoryRequestError(
      "unavailable",
      "GitHub installation token response was malformed.",
    );
  }

  return token;
}

async function fetchRepository(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  accessToken: string,
  repoFullName: string,
): Promise<GithubRepositoryInfo> {
  const parsed = parseRepositoryFullName(repoFullName);

  const response = await githubFetch(
    fetchImpl,
    `${apiBaseUrl}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
    {
      method: "GET",
      authorization: `Bearer ${accessToken}`,
      apiBaseUrl,
      notFoundFailure: "not_found",
    },
  );

  const body = await readJson(response);
  const id = body["id"];
  const fullName = body["full_name"];
  const defaultBranch = body["default_branch"];

  if (
    typeof id !== "string" ||
    !isCanonicalGithubId(id) ||
    typeof fullName !== "string" ||
    !REPOSITORY_FULL_NAME.test(fullName) ||
    typeof defaultBranch !== "string" ||
    defaultBranch.length === 0
  ) {
    throw new GithubRepositoryRequestError(
      "unavailable",
      "GitHub repository response was malformed.",
    );
  }

  return {
    githubRepoId: id,
    fullName,
    defaultBranch,
  };
}

async function resolveCommit(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  accessToken: string,
  fullName: string,
  ref: string,
): Promise<GithubRepositoryCommit> {
  const encodedRef = encodeURIComponent(ref).replaceAll("%2F", "/");

  const response = await githubFetch(
    fetchImpl,
    `${apiBaseUrl}/repos/${fullName}/commits/${encodedRef}`,
    {
      method: "GET",
      authorization: `Bearer ${accessToken}`,
      apiBaseUrl,
      notFoundFailure: "invalid_ref",
    },
  );

  const body = await readJson(response);
  const sha = body["sha"];

  if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
    throw new GithubRepositoryRequestError(
      "invalid_ref",
      "GitHub commit response did not include a full SHA.",
    );
  }

  return { sha };
}

async function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    method: string;
    authorization: string;
    apiBaseUrl: string;
    notFoundFailure?: "not_found" | "invalid_ref";
  },
): Promise<Response> {
  let response: Response;

  try {
    response = await fetchImpl(url, {
      method: options.method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        authorization: options.authorization,
        "user-agent": "fluxora",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubRepositoryRequestError(
      "unavailable",
      "GitHub could not be reached.",
    );
  }

  if (response.ok) {
    return response;
  }

  if (isRateLimited(response)) {
    throw new GithubRepositoryRequestError(
      "rate_limited",
      "GitHub rate limit or transient availability error.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new GithubRepositoryRequestError(
      "github_auth",
      "GitHub App installation access was denied.",
    );
  }

  if (response.status === 404) {
    throw new GithubRepositoryRequestError(
      options.notFoundFailure ?? "not_found",
      "GitHub resource was not found.",
    );
  }

  if (response.status >= 500) {
    throw new GithubRepositoryRequestError(
      "unavailable",
      "GitHub is temporarily unavailable.",
    );
  }

  throw new GithubRepositoryRequestError(
    "unavailable",
    "GitHub request failed.",
  );
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }

  if (response.headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }

  const retryAfter = response.headers.get("retry-after");
  return response.status === 403 && retryAfter !== null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();

  try {
    const parsed: unknown = JSON.parse(quoteJsonIntegers(text));
    if (!isRecord(parsed)) {
      throw new Error("not an object");
    }

    return parsed;
  } catch (error) {
    if (error instanceof GithubRepositoryRequestError) {
      throw error;
    }

    throw new GithubRepositoryRequestError(
      "unavailable",
      "GitHub JSON response was malformed.",
    );
  }
}

function validateGithubId(value: string): void {
  if (!isCanonicalGithubId(value)) {
    throw new GithubRepositoryRequestError(
      "unavailable",
      "GitHub identifier is invalid.",
    );
  }
}

function isCanonicalGithubId(value: string): boolean {
  if (!GITHUB_ID.test(value)) {
    return false;
  }

  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
