import { Readable } from "node:stream";

import type { GithubAppConfig } from "./config.ts";
import { createGithubAppJwt, GithubAppJwtError } from "./jwt.ts";
import {
  permanentIngestionError,
  retryableIngestionError,
  type IngestionError,
} from "../ingest/errors.ts";
import type { IngestLimits } from "../ingest/limits.ts";

export interface GithubCommitInfo {
  sha: string;
  author: string;
  message: string;
  committedAt: Date;
  parentShas: string[];
}

export interface GithubRepoInfo {
  fullName: string;
  defaultBranch: string;
}

export interface GithubIngestClient {
  mintInstallationToken(installationId: string): Promise<string>;
  getRepository(token: string, githubRepoId: string): Promise<GithubRepoInfo>;
  resolveCommit(
    token: string,
    fullName: string,
    ref: string,
  ): Promise<GithubCommitInfo>;
  downloadTarball(
    token: string,
    fullName: string,
    commitSha: string,
    limits: IngestLimits,
    signal: AbortSignal,
  ): Promise<Readable>;
}

export function createGithubIngestClient(input: {
  config: GithubAppConfig;
  fetchImpl?: typeof fetch;
  now?: Date;
}): GithubIngestClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiBaseUrl = input.config.apiBaseUrl.replace(/\/$/, "");

  return {
    async mintInstallationToken(installationId: string): Promise<string> {
      let appJwt: string;
      try {
        appJwt = createGithubAppJwt({
          appId: input.config.appId,
          privateKeyPem: input.config.privateKeyPem,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
      } catch (error) {
        if (error instanceof GithubAppJwtError) {
          throw retryableIngestionError(
            "misconfigured",
            "GitHub App credentials could not be used",
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
        throw retryableIngestionError(
          "github_unavailable",
          "GitHub installation token response was malformed",
        );
      }

      return token;
    },

    async getRepository(
      token: string,
      githubRepoId: string,
    ): Promise<GithubRepoInfo> {
      const response = await githubFetch(
        fetchImpl,
        `${apiBaseUrl}/repositories/${githubRepoId}`,
        {
          method: "GET",
          authorization: `Bearer ${token}`,
          apiBaseUrl,
        },
      );

      const body = await readJson(response);
      const fullName = body["full_name"];
      const defaultBranch = body["default_branch"];
      if (typeof fullName !== "string" || typeof defaultBranch !== "string") {
        throw retryableIngestionError(
          "github_unavailable",
          "GitHub repository response was malformed",
        );
      }

      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
        throw permanentIngestionError(
          "unsafe_archive",
          "GitHub repository full_name is not a valid owner/name pair",
          { repositoryStatus: "error" },
        );
      }

      return { fullName, defaultBranch };
    },

    async resolveCommit(
      token: string,
      fullName: string,
      ref: string,
    ): Promise<GithubCommitInfo> {
      const encodedRef = encodeURIComponent(ref).replaceAll("%2F", "/");
      const response = await githubFetch(
        fetchImpl,
        `${apiBaseUrl}/repos/${fullName}/commits/${encodedRef}`,
        {
          method: "GET",
          authorization: `Bearer ${token}`,
          apiBaseUrl,
          notFoundCode: "invalid_ref",
        },
      );

      const body = await readJson(response);
      const sha = body["sha"];
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw permanentIngestionError(
          "invalid_ref",
          "GitHub commit response did not include a full SHA",
          { repositoryStatus: "error" },
        );
      }

      const commit = isRecord(body["commit"]) ? body["commit"] : {};
      const authorRecord = isRecord(commit["author"]) ? commit["author"] : {};
      const author =
        typeof authorRecord["name"] === "string" ? authorRecord["name"] : "unknown";
      const message =
        typeof commit["message"] === "string" ? commit["message"] : "";
      const dateValue = authorRecord["date"];
      const committedAt =
        typeof dateValue === "string" && !Number.isNaN(Date.parse(dateValue))
          ? new Date(dateValue)
          : new Date();
      const parents = Array.isArray(body["parents"]) ? body["parents"] : [];
      const parentShas = parents.flatMap((parent) => {
        if (isRecord(parent) && typeof parent["sha"] === "string") {
          return [parent["sha"]];
        }
        return [];
      });

      return { sha, author, message, committedAt, parentShas };
    },

    async downloadTarball(
      token: string,
      fullName: string,
      commitSha: string,
      limits: IngestLimits,
      signal: AbortSignal,
    ): Promise<Readable> {
      const first = await githubFetch(
        fetchImpl,
        `${apiBaseUrl}/repos/${fullName}/tarball/${commitSha}`,
        {
          method: "GET",
          authorization: `Bearer ${token}`,
          apiBaseUrl,
          redirect: "manual",
          signal,
          notFoundCode: "invalid_ref",
        },
      );

      let archiveResponse = first;
      if (first.status === 301 || first.status === 302 || first.status === 307) {
        const location = first.headers.get("location");
        if (location === null || !isAllowedArchiveRedirect(apiBaseUrl, location)) {
          throw permanentIngestionError(
            "unsafe_archive",
            "GitHub archive redirect host is not allowed",
            { repositoryStatus: "error" },
          );
        }

        archiveResponse = await githubFetch(fetchImpl, location, {
          method: "GET",
          authorization: null,
          apiBaseUrl,
          redirect: "follow",
          signal,
        });
      }

      if (archiveResponse.body === null) {
        throw retryableIngestionError(
          "github_unavailable",
          "GitHub archive response had no body",
        );
      }

      const contentLength = archiveResponse.headers.get("content-length");
      if (contentLength !== null) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > limits.maxArchiveBytes) {
          throw permanentIngestionError(
            "repository_too_large",
            "repository archive exceeds the configured compressed size limit",
            {
              repositoryStatus: "error",
              details: {
                sizeBytes: declared,
                maxTotalBytes: limits.maxTotalBytes,
              },
            },
          );
        }
      }

      return Readable.from(
        boundCompressedBytes(archiveResponse.body, limits.maxArchiveBytes, signal),
      );
    },
  };
}

async function* boundCompressedBytes(
  body: ReadableStream<Uint8Array>,
  maxArchiveBytes: number,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let total = 0;

  try {
    while (true) {
      if (signal.aborted) {
        throw retryableIngestionError(
          "timeout",
          "repository archive download exceeded the configured time limit",
        );
      }

      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      if (value === undefined) {
        continue;
      }

      total += value.byteLength;
      if (total > maxArchiveBytes) {
        throw permanentIngestionError(
          "repository_too_large",
          "repository archive exceeds the configured compressed size limit",
          {
            repositoryStatus: "error",
            details: {
              sizeBytes: total,
              maxTotalBytes: maxArchiveBytes,
            },
          },
        );
      }

      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function isAllowedArchiveRedirect(apiBaseUrl: string, location: string): boolean {
  let url: URL;
  try {
    url = new URL(location, apiBaseUrl);
  } catch {
    return false;
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return false;
  }

  const api = new URL(apiBaseUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.hostname === api.hostname) {
    return true;
  }

  if (url.hostname === "codeload.github.com") {
    return url.protocol === "https:";
  }

  return local && (url.protocol === "http:" || url.protocol === "https:");
}

async function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    method: string;
    authorization: string | null;
    apiBaseUrl: string;
    redirect?: "error" | "follow" | "manual";
    signal?: AbortSignal;
    notFoundCode?: "invalid_ref" | "github_auth";
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "fluxora",
    "x-github-api-version": "2022-11-28",
  };
  if (options.authorization !== null) {
    headers.authorization = options.authorization;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method,
      redirect: options.redirect ?? "error",
      headers,
      ...(options.signal === undefined ? { signal: AbortSignal.timeout(10_000) } : { signal: options.signal }),
    });
  } catch {
    if (options.signal?.aborted === true) {
      throw retryableIngestionError(
        "timeout",
        "GitHub request exceeded the configured time limit",
      );
    }

    throw retryableIngestionError(
      "github_unavailable",
      "GitHub could not be reached",
    );
  }

  if (response.status === 301 || response.status === 302 || response.status === 307) {
    return response;
  }

  if (response.ok) {
    return response;
  }

  throw classifyGithubFailure(response, options.notFoundCode);
}

function classifyGithubFailure(
  response: Response,
  notFoundCode: "invalid_ref" | "github_auth" | undefined,
): IngestionError {
  if (isRateLimited(response)) {
    return retryableIngestionError(
      "github_rate_limit",
      "GitHub rate limit or transient availability error",
    );
  }

  if (response.status === 401 || response.status === 403) {
    return permanentIngestionError(
      "github_auth",
      "GitHub App installation access was denied",
      { repositoryStatus: "needs_reauth" },
    );
  }

  if (response.status === 404) {
    if (notFoundCode === "invalid_ref") {
      return permanentIngestionError(
        "invalid_ref",
        "GitHub ref was not found",
        { repositoryStatus: "error" },
      );
    }

    return permanentIngestionError(
      "github_auth",
      "GitHub repository is not accessible with this installation",
      { repositoryStatus: "needs_reauth" },
    );
  }

  if (response.status >= 500) {
    return retryableIngestionError(
      "github_unavailable",
      "GitHub is temporarily unavailable",
    );
  }

  return retryableIngestionError(
    "github_unavailable",
    "GitHub request failed",
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
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw retryableIngestionError(
      "github_unavailable",
      "GitHub JSON response was malformed",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
