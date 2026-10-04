/** Repository GitHub App connection state (`06-database-schema.md` Repository). */
export const RepositoryConnectionStatuses = [
  "pending",
  "active",
  "needs_reauth",
  "error",
] as const;

export type RepositoryConnectionStatus =
  (typeof RepositoryConnectionStatuses)[number];

/**
 * Tenant-owned GitHub repository metadata.
 * `githubRepoId` stays a decimal string so values above `Number.MAX_SAFE_INTEGER`
 * are not rounded before they reach PostgreSQL `bigint`.
 */
export interface Repository {
  id: string;
  organizationId: string;
  githubRepoId: string;
  name: string;
  defaultBranch: string;
  connectionStatus: RepositoryConnectionStatus;
  lastIndexedAt: Date | null;
  createdAt: Date;
}

/**
 * Immutable snapshot of one repository commit's tree.
 * File bytes live at `storageUri` (object storage in later steps), not in PostgreSQL.
 */
export interface RepositorySnapshot {
  id: string;
  repositoryId: string;
  commitSha: string;
  ref: string;
  storageUri: string;
  fileCount: number;
  sizeBytes: string;
  createdAt: Date;
}

/** Git commit metadata belonging to a repository. Distinct from a snapshot. */
export interface Commit {
  id: string;
  repositoryId: string;
  sha: string;
  author: string;
  message: string;
  committedAt: Date;
  parentShas: string[];
}
