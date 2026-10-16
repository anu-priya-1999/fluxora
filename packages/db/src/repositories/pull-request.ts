import {
  isCanonicalGithubId,
  PullRequestFileStatuses,
  PullRequestStatuses,
  type PullRequest,
  type PullRequestFile,
  type PullRequestFileStatus,
  type PullRequestStatus,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const GIT_SHA = /^[0-9a-f]{40}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PullRequestValidationError extends Error {
  constructor(message = "Pull request fields are invalid.") {
    super(message);
    this.name = "PullRequestValidationError";
  }
}

export class PullRequestConflictError extends Error {
  constructor(message = "A conflict occurred while persisting the pull request.") {
    super(message);
    this.name = "PullRequestConflictError";
  }
}

export interface UpsertPullRequestInput {
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
  status?: PullRequestStatus;
  authorLogin?: string | null;
  authorId?: string | null;
  lastDeliveryId?: string | null;
}

export interface CreatePullRequestFileInput {
  path: string;
  previousPath?: string | null;
  status: PullRequestFileStatus;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string | null;
  patchTruncated?: boolean;
  baseSha?: string | null;
  headSha?: string | null;
}

export interface SavePullRequestWithFilesInput {
  pr: UpsertPullRequestInput;
  files: CreatePullRequestFileInput[];
}

export interface SavePullRequestWithFilesResult {
  pullRequest: PullRequest;
  files: PullRequestFile[];
}

interface PullRequestRow {
  id: string;
  organization_id: string;
  repository_id: string;
  github_pr_id: string;
  number: number;
  title: string;
  url: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  head_sha: string;
  status: string;
  author_login: string | null;
  author_id: string | null;
  last_delivery_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PullRequestFileRow {
  id: string;
  pull_request_id: string;
  path: string;
  previous_path: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  patch_truncated: boolean;
  base_sha: string | null;
  head_sha: string | null;
  created_at: Date;
}

const PULL_REQUEST_COLUMNS = `
  id,
  organization_id,
  repository_id,
  github_pr_id::text AS github_pr_id,
  number,
  title,
  url,
  base_ref,
  base_sha,
  head_ref,
  head_sha,
  status,
  author_login,
  author_id,
  last_delivery_id,
  created_at,
  updated_at
`;

const PULL_REQUEST_FILE_COLUMNS = `
  id,
  pull_request_id,
  path,
  previous_path,
  status,
  additions,
  deletions,
  changes,
  patch,
  patch_truncated,
  base_sha,
  head_sha,
  created_at
`;

export async function upsertPullRequest(
  pool: pg.Pool,
  input: UpsertPullRequestInput,
): Promise<PullRequest> {
  assertUpsertPullRequestInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    return executeUpsertPullRequest(client, input);
  });
}

export async function getPullRequestById(
  pool: pg.Pool,
  organizationId: string,
  pullRequestId: string,
): Promise<PullRequest | null> {
  if (!UUID.test(pullRequestId)) {
    return null;
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<PullRequestRow>(
      `SELECT ${PULL_REQUEST_COLUMNS}
       FROM pull_requests
       WHERE id = $1::uuid
         AND organization_id = $2::uuid`,
      [pullRequestId, organizationId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapPullRequestRow(row);
  });
}

export async function getPullRequestByNumber(
  pool: pg.Pool,
  organizationId: string,
  repositoryId: string,
  prNumber: number,
): Promise<PullRequest | null> {
  if (!UUID.test(repositoryId) || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return null;
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<PullRequestRow>(
      `SELECT ${PULL_REQUEST_COLUMNS}
       FROM pull_requests
       WHERE repository_id = $1::uuid
         AND number = $2::integer
         AND organization_id = $3::uuid`,
      [repositoryId, prNumber, organizationId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapPullRequestRow(row);
  });
}

export async function replacePullRequestFiles(
  pool: pg.Pool,
  organizationId: string,
  pullRequestId: string,
  files: CreatePullRequestFileInput[],
): Promise<PullRequestFile[]> {
  if (!UUID.test(pullRequestId)) {
    throw new PullRequestValidationError("Invalid pullRequestId format.");
  }

  for (const file of files) {
    assertCreatePullRequestFileInput(file);
  }

  return withTenant(pool, organizationId, async (client) => {
    await client.query(
      `DELETE FROM pull_request_files WHERE pull_request_id = $1::uuid`,
      [pullRequestId],
    );

    const results: PullRequestFile[] = [];
    for (const file of files) {
      const saved = await executeInsertPullRequestFile(client, pullRequestId, file);
      results.push(saved);
    }

    return results;
  });
}

export async function listPullRequestFiles(
  pool: pg.Pool,
  organizationId: string,
  pullRequestId: string,
): Promise<PullRequestFile[]> {
  if (!UUID.test(pullRequestId)) {
    return [];
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<PullRequestFileRow>(
      `SELECT ${PULL_REQUEST_FILE_COLUMNS}
       FROM pull_request_files
       WHERE pull_request_id = $1::uuid
       ORDER BY path ASC, id ASC`,
      [pullRequestId],
    );

    return result.rows.map(mapPullRequestFileRow);
  });
}

export async function savePullRequestWithFiles(
  pool: pg.Pool,
  input: SavePullRequestWithFilesInput,
): Promise<SavePullRequestWithFilesResult> {
  assertUpsertPullRequestInput(input.pr);
  for (const file of input.files) {
    assertCreatePullRequestFileInput(file);
  }

  return withTenant(pool, input.pr.organizationId, async (client) => {
    const pullRequest = await executeUpsertPullRequest(client, input.pr);

    await client.query(
      `DELETE FROM pull_request_files WHERE pull_request_id = $1::uuid`,
      [pullRequest.id],
    );

    const files: PullRequestFile[] = [];
    for (const file of input.files) {
      const saved = await executeInsertPullRequestFile(client, pullRequest.id, file);
      files.push(saved);
    }

    return { pullRequest, files };
  });
}

async function executeUpsertPullRequest(
  client: pg.PoolClient,
  input: UpsertPullRequestInput,
): Promise<PullRequest> {
  const status = input.status ?? "open";

  const result = await client.query<PullRequestRow>(
    `INSERT INTO pull_requests (
       organization_id,
       repository_id,
       github_pr_id,
       number,
       title,
       url,
       base_ref,
       base_sha,
       head_ref,
       head_sha,
       status,
       author_login,
       author_id,
       last_delivery_id,
       updated_at
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::bigint,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10,
       $11,
       $12,
       $13,
       $14,
       now()
     )
     ON CONFLICT (repository_id, number)
     DO UPDATE SET
       github_pr_id = EXCLUDED.github_pr_id,
       title = EXCLUDED.title,
       url = EXCLUDED.url,
       base_ref = EXCLUDED.base_ref,
       base_sha = EXCLUDED.base_sha,
       head_ref = EXCLUDED.head_ref,
       head_sha = EXCLUDED.head_sha,
       status = EXCLUDED.status,
       author_login = COALESCE(EXCLUDED.author_login, pull_requests.author_login),
       author_id = COALESCE(EXCLUDED.author_id, pull_requests.author_id),
       last_delivery_id = COALESCE(EXCLUDED.last_delivery_id, pull_requests.last_delivery_id),
       updated_at = now()
     RETURNING ${PULL_REQUEST_COLUMNS}`,
    [
      input.organizationId,
      input.repositoryId,
      input.githubPrId,
      input.number,
      input.title.trim(),
      input.url.trim(),
      input.baseRef.trim(),
      input.baseSha.trim(),
      input.headRef.trim(),
      input.headSha.trim(),
      status,
      input.authorLogin?.trim() ?? null,
      input.authorId?.trim() ?? null,
      input.lastDeliveryId?.trim() ?? null,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new PullRequestConflictError("Failed to upsert pull request row.");
  }

  return mapPullRequestRow(row);
}

async function executeInsertPullRequestFile(
  client: pg.PoolClient,
  pullRequestId: string,
  input: CreatePullRequestFileInput,
): Promise<PullRequestFile> {
  const result = await client.query<PullRequestFileRow>(
    `INSERT INTO pull_request_files (
       pull_request_id,
       path,
       previous_path,
       status,
       additions,
       deletions,
       changes,
       patch,
       patch_truncated,
       base_sha,
       head_sha
     )
     VALUES (
       $1::uuid,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10,
       $11
     )
     RETURNING ${PULL_REQUEST_FILE_COLUMNS}`,
    [
      pullRequestId,
      input.path.trim(),
      input.previousPath?.trim() ?? null,
      input.status,
      input.additions ?? 0,
      input.deletions ?? 0,
      input.changes ?? (input.additions ?? 0) + (input.deletions ?? 0),
      input.patch ?? null,
      input.patchTruncated ?? false,
      input.baseSha?.trim() ?? null,
      input.headSha?.trim() ?? null,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new PullRequestConflictError("Failed to insert pull request file row.");
  }

  return mapPullRequestFileRow(row);
}

function mapPullRequestRow(row: PullRequestRow): PullRequest {
  if (!isPullRequestStatus(row.status)) {
    throw new PullRequestValidationError(`Invalid PR status: ${row.status}`);
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    repositoryId: row.repository_id,
    githubPrId: row.github_pr_id,
    number: row.number,
    title: row.title,
    url: row.url,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headRef: row.head_ref,
    headSha: row.head_sha,
    status: row.status,
    authorLogin: row.author_login,
    authorId: row.author_id,
    lastDeliveryId: row.last_delivery_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPullRequestFileRow(row: PullRequestFileRow): PullRequestFile {
  if (!isPullRequestFileStatus(row.status)) {
    throw new PullRequestValidationError(`Invalid PR file status: ${row.status}`);
  }

  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    path: row.path,
    previousPath: row.previous_path,
    status: row.status,
    additions: row.additions,
    deletions: row.deletions,
    changes: row.changes,
    patch: row.patch,
    patchTruncated: row.patch_truncated,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    createdAt: row.created_at,
  };
}

function assertUpsertPullRequestInput(input: UpsertPullRequestInput): void {
  if (
    !UUID.test(input.organizationId) ||
    !UUID.test(input.repositoryId) ||
    !isCanonicalGithubId(input.githubPrId) ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0 ||
    input.url.trim().length === 0 ||
    input.baseRef.trim().length === 0 ||
    !GIT_SHA.test(input.baseSha) ||
    input.headRef.trim().length === 0 ||
    !GIT_SHA.test(input.headSha)
  ) {
    throw new PullRequestValidationError();
  }

  if (input.status !== undefined && !isPullRequestStatus(input.status)) {
    throw new PullRequestValidationError();
  }
}

function assertCreatePullRequestFileInput(input: CreatePullRequestFileInput): void {
  if (
    input.path.trim().length === 0 ||
    !isPullRequestFileStatus(input.status) ||
    (input.additions !== undefined &&
      (!Number.isInteger(input.additions) || input.additions < 0)) ||
    (input.deletions !== undefined &&
      (!Number.isInteger(input.deletions) || input.deletions < 0)) ||
    (input.changes !== undefined &&
      (!Number.isInteger(input.changes) || input.changes < 0))
  ) {
    throw new PullRequestValidationError();
  }
}

function isPullRequestStatus(value: string): value is PullRequestStatus {
  return (PullRequestStatuses as readonly string[]).includes(value);
}

function isPullRequestFileStatus(value: string): value is PullRequestFileStatus {
  return (PullRequestFileStatuses as readonly string[]).includes(value);
}

