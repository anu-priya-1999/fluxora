/** Wire path for GitHub App installation completion. */
export const GITHUB_INSTALLATION_COMPLETION_PATH =
  "/api/v1/github/installations" as const;

/**
 * GitHub App installation persisted for one Fluxora organization.
 * GitHub numeric ids stay strings so values above `Number.MAX_SAFE_INTEGER`
 * are not rounded before they reach PostgreSQL `bigint`.
 */
export interface GithubInstallation {
  id: string;
  organizationId: string;
  githubInstallationId: string;
  githubAccountId: string;
  githubAccountLogin: string;
  githubAccountType: "User";
  createdAt: Date;
  updatedAt: Date;
}

/** JSON request body. `github_installation_id` is a decimal string, never a JSON number. */
export interface CompleteGithubInstallationRequest {
  github_installation_id: string;
}

/** Largest signed 64-bit integer PostgreSQL `bigint` can store. */
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

/**
 * Canonical GitHub / PostgreSQL bigint id: decimal digits, no sign, no leading zero.
 * Returns false for JSON numbers, blanks, and values that do not fit in `bigint`.
 */
export function isCanonicalGithubId(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) {
    return false;
  }

  return BigInt(value) <= POSTGRES_BIGINT_MAX;
}
