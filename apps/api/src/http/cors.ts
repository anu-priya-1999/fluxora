const DEFAULT_WEB_ORIGINS = "http://localhost:3000";

export function loadAllowedWebOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.CLERK_AUTHORIZED_PARTIES ?? DEFAULT_WEB_ORIGINS)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function corsHeadersForAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> | undefined {
  if (origin === undefined || origin.length === 0) {
    return undefined;
  }

  if (!allowedOrigins.includes(origin)) {
    return undefined;
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    vary: "Origin",
  };
}

/**
 * Origin the API will not allow, safe to log.
 * Returns undefined when the origin is missing or allowed.
 */
export function rejectedCorsOriginForLog(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): string | undefined {
  if (origin === undefined || origin.length === 0) {
    return undefined;
  }

  if (allowedOrigins.includes(origin)) {
    return undefined;
  }

  try {
    const url = new URL(origin);
    if (url.username.length > 0 || url.password.length > 0) {
      return "rejected";
    }

    if (url.origin.length > 200 || /[\r\n]/.test(url.origin)) {
      return "rejected";
    }

    return url.origin;
  } catch {
    return "rejected";
  }
}

export function githubInstallationPreflight(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): { status: 204; headers: Record<string, string> } {
  return {
    status: 204,
    headers: corsHeadersForAllowedOrigin(origin, allowedOrigins) ?? {},
  };
}
