import { isCanonicalGithubId } from "@fluxora/shared-types";

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

/**
 * Public browser origin for Clerk return URLs and the GitHub setup handoff.
 * `VERCEL_URL` is the current deployment hostname and changes on every deploy,
 * so it is not a stable origin the API can allow. Prefer the configured app
 * URL, then Vercel's production domain.
 */
export function readWebOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = blankToUndefined(env.NEXT_PUBLIC_APP_URL);
  if (configured !== undefined) {
    return assertPublicHttpUrl(withProtocol(configured), "NEXT_PUBLIC_APP_URL");
  }

  const production = blankToUndefined(env.VERCEL_PROJECT_PRODUCTION_URL);
  if (production !== undefined) {
    return assertPublicHttpUrl(
      withProtocol(production),
      "VERCEL_PROJECT_PRODUCTION_URL",
    );
  }

  return "http://localhost:3000";
}

export interface RequestOriginHeaders {
  get(name: string): string | null;
}

/** Browser origin from the incoming request. Not used as a redirect target. */
export function readRequestPublicOrigin(
  headerList: RequestOriginHeaders,
): string | undefined {
  const host =
    firstHeader(headerList.get("x-forwarded-host")) ??
    firstHeader(headerList.get("host"));
  if (host === undefined) {
    return undefined;
  }

  const forwardedProto = firstHeader(headerList.get("x-forwarded-proto"));
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : local
        ? "http"
        : "https";

  try {
    return assertPublicHttpUrl(`${proto}://${host}`, "request host");
  } catch {
    return undefined;
  }
}

export type GithubSetupOriginDecision =
  | { type: "stay" }
  | { type: "misconfigured" }
  | { type: "redirect"; url: string };

/**
 * Completion must run on the origin the API allows. A per-deployment host
 * is redirected to that origin before the browser POSTs the installation.
 */
export function githubSetupOriginRedirect(input: {
  requestOrigin: string | undefined;
  installationId: string | undefined;
  setupAction: string | undefined;
  env?: Record<string, string | undefined>;
}): GithubSetupOriginDecision {
  if (
    input.setupAction !== undefined &&
    input.setupAction !== "install" &&
    input.setupAction !== "update"
  ) {
    return { type: "stay" };
  }

  if (
    input.installationId === undefined ||
    !isCanonicalGithubId(input.installationId)
  ) {
    return { type: "stay" };
  }

  let canonical: string;
  try {
    canonical = readWebOrigin(input.env);
  } catch {
    return { type: "misconfigured" };
  }

  if (input.requestOrigin === undefined || input.requestOrigin === canonical) {
    return { type: "stay" };
  }

  if (isLoopbackOrigin(canonical) && !isLoopbackOrigin(input.requestOrigin)) {
    return { type: "misconfigured" };
  }

  const action =
    input.setupAction === "install" || input.setupAction === "update"
      ? `&setup_action=${input.setupAction}`
      : "";

  return {
    type: "redirect",
    url: `${canonical}/github/setup?installation_id=${input.installationId}${action}`,
  };
}

function withProtocol(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return `https://${value}`;
}

function isLoopbackOrigin(origin: string): boolean {
  return (
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1")
  );
}

function firstHeader(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
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
