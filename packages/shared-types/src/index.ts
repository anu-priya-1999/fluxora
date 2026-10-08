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
export {
  GITHUB_INSTALLATION_COMPLETION_PATH,
  isCanonicalGithubId,
  type CompleteGithubInstallationRequest,
  type GithubInstallation,
} from "./github.ts";

export * from "./jobs.ts";
export * from "./events.ts";
export {
  RepositoryConnectionStatuses,
  type Commit,
  type Repository,
  type RepositoryConnectionStatus,
  type RepositorySnapshot,
} from "./repository.ts";
export * from "./fixtures.ts";
export * from "./detection.ts";
export * from "./symbols.ts";
export * from "./modules.ts";
export * from "./routes.ts";
export * from "./event-patterns.ts";

