import type { UserRole } from "./tenant.ts";

/**
 * Caller identity after session middleware.
 * `organizationId` comes from the access token, then is confirmed against `users` under RLS.
 */
export interface AuthenticatedPrincipal {
  userId: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

/** JSON body returned by login and refresh. The refresh token is only set as an HttpOnly cookie. */
export interface AuthSessionResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: AuthenticatedPrincipal;
}
