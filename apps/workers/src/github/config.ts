import { readFileSync } from "node:fs";

export interface GithubAppConfig {
  appId: string;
  privateKeyPem: string;
  apiBaseUrl: string;
}

/**
 * Loads GitHub App credentials for the ingestion worker.
 * Returns null when the App is not configured.
 * Thrown messages do not include key material.
 */
export function loadGithubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubAppConfig | null {
  const appId = blankToUndefined(env.GITHUB_APP_ID);
  const inlineKey = blankToUndefined(env.GITHUB_APP_PRIVATE_KEY);
  const keyFile = blankToUndefined(env.GITHUB_APP_PRIVATE_KEY_FILE);

  if (appId === undefined && inlineKey === undefined && keyFile === undefined) {
    return null;
  }

  if (appId === undefined || (inlineKey === undefined && keyFile === undefined)) {
    throw new Error(
      "GITHUB_APP_ID and one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE must be set together.",
    );
  }

  if (inlineKey !== undefined && keyFile !== undefined) {
    throw new Error(
      "Set only one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE.",
    );
  }

  if (!/^[1-9]\d*$/.test(appId)) {
    throw new Error("GITHUB_APP_ID must be a positive decimal GitHub App ID.");
  }

  const privateKeyPem =
    inlineKey !== undefined
      ? normalizePrivateKeyPem(inlineKey)
      : readPrivateKeyFile(keyFile ?? "");

  return {
    appId,
    privateKeyPem,
    apiBaseUrl: githubApiBaseUrl(env.GITHUB_API_BASE_URL),
  };
}

export function normalizePrivateKeyPem(value: string): string {
  const normalized = canonicalizePrivateKeyPem(value);

  if (
    !normalized.includes("BEGIN") ||
    !normalized.includes("PRIVATE KEY") ||
    !normalized.includes("END")
  ) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be a PEM private key.");
  }

  return normalized;
}

function canonicalizePrivateKeyPem(value: string): string {
  let text = value.replace(/^\uFEFF/, "").trim();
  text = unwrapMatchingQuotes(text);
  text = text.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  text = unwrapMatchingQuotes(text);

  const match = text.match(
    /^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----\s*([\s\S]+?)\s*-----END \1-----$/,
  );
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return text;
  }

  const label = match[1];
  const body = match[2].replace(/\s+/g, "");
  if (body.length === 0) {
    return text;
  }

  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}

function unwrapMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const start = value[0];
  const end = value[value.length - 1];
  if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function readPrivateKeyFile(filePath: string): string {
  try {
    return normalizePrivateKeyPem(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "GITHUB_APP_PRIVATE_KEY must be a PEM private key."
    ) {
      throw error;
    }

    throw new Error("GITHUB_APP_PRIVATE_KEY_FILE could not be read.");
  }
}

export function githubApiBaseUrl(value: string | undefined): string {
  const raw = blankToUndefined(value) ?? "https://api.github.com";
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("GITHUB_API_BASE_URL is not a valid URL.");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("GITHUB_API_BASE_URL must not include credentials.");
  }

  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && local);

  if (!allowed) {
    throw new Error(
      "GITHUB_API_BASE_URL must use https, or http on localhost.",
    );
  }

  return url.origin;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
