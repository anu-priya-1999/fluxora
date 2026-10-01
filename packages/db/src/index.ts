export { getDatabaseUrl } from "./config.ts";
export { closePool, getPool } from "./pool.ts";
export {
  setTenantOnClient,
  TENANT_SESSION_VARIABLE,
  withTenant,
  type TenantScopedCallback,
} from "./tenant.ts";
export { runMigrations, type RunMigrationsResult } from "./migrate/runner.ts";
export {
  createOrganization,
  getOrganizationById,
} from "./repositories/organization.ts";
export {
  createUser,
  getUserById,
  listUsersInOrganization,
  UserNotFoundError,
  provisionGithubUser,
} from "./repositories/user.ts";
export {
  GithubInstallationAccountMismatchError,
  GithubInstallationConflictError,
  GithubInstallationValidationError,
  planGithubInstallationWrite,
  saveGithubInstallation,
  type InstallationWritePlan,
  type SaveGithubInstallationInput,
  type SaveGithubInstallationResult,
} from "./repositories/github-installation.ts";
/** Workspace package identifier. */
export const packageName = "@fluxora/db" as const;
export * from "./repositories/job.ts";
