import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_ENV_KEYS = [
  "GITHUB_APP_SLUG",
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  "FLUXORA_API_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

let rootEnvLoaded = false;

/**
 * Copies a small allowlist from the repo-root `.env` when the process does not
 * already have the variable. The GitHub App private key is intentionally absent.
 */
export function loadWebRootEnv(): void {
  if (rootEnvLoaded) {
    return;
  }

  rootEnvLoaded = true;
  const envPath = path.resolve(
    fileURLToPath(new URL("../../../../.env", import.meta.url)),
  );

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!isRootEnvKey(key)) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function readGithubAppSlug(): string | undefined {
  loadWebRootEnv();
  return (
    blankToUndefined(process.env.GITHUB_APP_SLUG) ??
    blankToUndefined(process.env.NEXT_PUBLIC_GITHUB_APP_SLUG)
  );
}

export function readFluxoraApiUrl(): string {
  loadWebRootEnv();
  return resolveFluxoraApiUrl(process.env.FLUXORA_API_URL);
}

export function resolveFluxoraApiUrl(value: string | undefined): string {
  const raw = blankToUndefined(value) ?? "http://127.0.0.1:4000";
  return assertPublicHttpUrl(raw, "FLUXORA_API_URL");
}

export function readWebOrigin(): string {
  loadWebRootEnv();
  const configured =
    blankToUndefined(process.env.NEXT_PUBLIC_APP_URL) ??
    blankToUndefined(process.env.VERCEL_URL);

  if (configured === undefined) {
    return "http://localhost:3000";
  }

  const withProtocol = configured.startsWith("http://") || configured.startsWith("https://")
    ? configured
    : `https://${configured}`;

  return assertPublicHttpUrl(withProtocol, "NEXT_PUBLIC_APP_URL");
}

function assertPublicHttpUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${name} must not include credentials.`);
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && local);
  if (!allowed) {
    throw new Error(`${name} must use https, or http on localhost.`);
  }

  return url.origin;
}

function isRootEnvKey(key: string): key is (typeof ROOT_ENV_KEYS)[number] {
  return (ROOT_ENV_KEYS as readonly string[]).includes(key);
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
