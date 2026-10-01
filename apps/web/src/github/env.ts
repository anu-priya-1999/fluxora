const ROOT_ENV_KEYS = [
  "GITHUB_APP_SLUG",
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  "FLUXORA_API_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

void ROOT_ENV_KEYS;

/**
 * Next.js/Vercel loads environment variables itself.
 * Local web-specific variables should live in apps/web/.env.local.
 */
export function loadWebRootEnv(): void {
  // Intentionally empty.
}

export function readGithubAppSlug(): string | undefined {
  return (
    blankToUndefined(process.env.GITHUB_APP_SLUG) ??
    blankToUndefined(process.env.NEXT_PUBLIC_GITHUB_APP_SLUG)
  );
}

export function readFluxoraApiUrl(): string {
  return resolveFluxoraApiUrl(process.env.FLUXORA_API_URL);
}

export function resolveFluxoraApiUrl(value: string | undefined): string {
  const raw = blankToUndefined(value) ?? "http://127.0.0.1:4000";
  return assertPublicHttpUrl(raw, "FLUXORA_API_URL");
}

export function readWebOrigin(): string {
  const configured =
    blankToUndefined(process.env.NEXT_PUBLIC_APP_URL) ??
    blankToUndefined(process.env.VERCEL_URL);

  if (configured === undefined) {
    return "http://localhost:3000";
  }

  const withProtocol =
    configured.startsWith("http://") || configured.startsWith("https://")
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

  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && local);

  if (!allowed) {
    throw new Error(`${name} must use https, or http on localhost.`);
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
