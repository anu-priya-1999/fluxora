/** Pull request status values (`06-database-schema.md` PullRequest). */
export const PullRequestStatuses = ["open", "closed", "merged"] as const;
export type PullRequestStatus = (typeof PullRequestStatuses)[number];

/** Changed file git status values. */
export const PullRequestFileStatuses = [
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;
export type PullRequestFileStatus = (typeof PullRequestFileStatuses)[number];

/**
 * Tenant-scoped GitHub pull request record.
 */
export interface PullRequest {
  id: string;
  organizationId: string;
  repositoryId: string;
  githubPrId: string;
  number: number;
  title: string;
  url: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  status: PullRequestStatus;
  authorLogin: string | null;
  authorId: string | null;
  lastDeliveryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenant-scoped pull request changed file and patch data.
 */
export interface PullRequestFile {
  id: string;
  pullRequestId: string;
  path: string;
  previousPath: string | null;
  status: PullRequestFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  patchTruncated: boolean;
  baseSha: string | null;
  headSha: string | null;
  createdAt: Date;
}

