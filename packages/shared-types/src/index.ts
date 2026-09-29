/** Workspace package identifier. Domain, API, and event contracts grow in later phases. */
export const packageName = "@fluxora/shared-types" as const;

export type { PlanTier, UserRole } from "./tenant.ts";
export {
  PlanTiers,
  UserRoles,
  type CreateOrganizationInput,
  type CreateUserInput,
  type Organization,
  type User,
} from "./tenant.ts";
export type { AuthSessionResponse, AuthenticatedPrincipal } from "./auth.ts";

export * from "./jobs.ts";
