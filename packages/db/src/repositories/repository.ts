import {
  RepositoryConnectionStatuses,
  isCanonicalGithubId,
  type Repository,
  type RepositoryConnectionStatus,
} from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const WRITE_SAVEPOINT = "fluxora_repository_write";

export class RepositoryValidationError extends Error {
  constructor() {
    super("Repository fields are invalid.");
    this.name = "RepositoryValidationError";
  }
}

export class RepositoryConflictError extends Error {
  constructor() {
    super("A repository with this GitHub id already exists in the organization.");
    this.name = "RepositoryConflictError";
  }
}

export interface CreateRepositoryInput {
  organizationId: string;
  githubRepoId: string;
  name: string;
  defaultBranch: string;
  connectionStatus?: RepositoryConnectionStatus;
}

export interface UpdateRepositoryInput {
  name?: string;
  defaultBranch?: string;
  connectionStatus?: RepositoryConnectionStatus;
  lastIndexedAt?: Date | null;
}

interface RepositoryRow {
  id: string;
  organization_id: string;
  github_repo_id: string;
  name: string;
  default_branch: string;
  connection_status: string;
  last_indexed_at: Date | null;
  created_at: Date;
}

const REPOSITORY_COLUMNS = `
  id,
  organization_id,
  github_repo_id::text AS github_repo_id,
  name,
  default_branch,
  connection_status::text AS connection_status,
  last_indexed_at,
  created_at
`;

export async function createRepository(
  pool: pg.Pool,
  input: CreateRepositoryInput,
): Promise<Repository> {
  assertCreateInput(input);
  const connectionStatus = input.connectionStatus ?? "pending";

  return withTenant(pool, input.organizationId, async (client) => {
    try {
      return await writeWithSavepoint(client, () =>
        insertRepository(client, input, connectionStatus),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      throw new RepositoryConflictError();
    }
  });
}

export async function getRepositoryById(
  pool: pg.Pool,
  organizationId: string,
  repositoryId: string,
): Promise<Repository | null> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<RepositoryRow>(
      `SELECT ${REPOSITORY_COLUMNS}
       FROM repositories
       WHERE id = $1::uuid`,
      [repositoryId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapRepositoryRow(row);
  });
}

export async function getRepositoryByGithubRepoId(
  pool: pg.Pool,
  organizationId: string,
  githubRepoId: string,
): Promise<Repository | null> {
  if (!isCanonicalGithubId(githubRepoId)) {
    throw new RepositoryValidationError();
  }

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<RepositoryRow>(
      `SELECT ${REPOSITORY_COLUMNS}
       FROM repositories
       WHERE github_repo_id = $1::bigint`,
      [githubRepoId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapRepositoryRow(row);
  });
}

export async function listRepositories(
  pool: pg.Pool,
  organizationId: string,
): Promise<Repository[]> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<RepositoryRow>(
      `SELECT ${REPOSITORY_COLUMNS}
       FROM repositories
       ORDER BY created_at DESC, id DESC`,
    );

    return result.rows.map(mapRepositoryRow);
  });
}

export async function updateRepository(
  pool: pg.Pool,
  organizationId: string,
  repositoryId: string,
  patch: UpdateRepositoryInput,
): Promise<Repository | null> {
  assertUpdateInput(patch);

  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<RepositoryRow>(
      `UPDATE repositories
       SET
         name = COALESCE($3, name),
         default_branch = COALESCE($4, default_branch),
         connection_status = COALESCE($5::repository_connection_status, connection_status),
         last_indexed_at = CASE
           WHEN $6::boolean THEN $7::timestamptz
           ELSE last_indexed_at
         END
       WHERE id = $1::uuid
         AND organization_id = $2::uuid
       RETURNING ${REPOSITORY_COLUMNS}`,
      [
        repositoryId,
        organizationId,
        patch.name ?? null,
        patch.defaultBranch ?? null,
        patch.connectionStatus ?? null,
        Object.hasOwn(patch, "lastIndexedAt"),
        patch.lastIndexedAt ?? null,
      ],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapRepositoryRow(row);
  });
}

async function insertRepository(
  client: pg.PoolClient,
  input: CreateRepositoryInput,
  connectionStatus: RepositoryConnectionStatus,
): Promise<Repository> {
  const result = await client.query<RepositoryRow>(
    `INSERT INTO repositories (
       organization_id,
       github_repo_id,
       name,
       default_branch,
       connection_status
     )
     VALUES ($1::uuid, $2::bigint, $3, $4, $5::repository_connection_status)
     RETURNING ${REPOSITORY_COLUMNS}`,
    [
      input.organizationId,
      input.githubRepoId,
      input.name.trim(),
      input.defaultBranch.trim(),
      connectionStatus,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("repository insert returned no row");
  }

  return mapRepositoryRow(row);
}

async function writeWithSavepoint<T>(
  client: pg.PoolClient,
  write: () => Promise<T>,
): Promise<T> {
  await client.query(`SAVEPOINT ${WRITE_SAVEPOINT}`);

  try {
    const result = await write();
    await client.query(`RELEASE SAVEPOINT ${WRITE_SAVEPOINT}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${WRITE_SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${WRITE_SAVEPOINT}`);
    throw error;
  }
}

function mapRepositoryRow(row: RepositoryRow): Repository {
  if (!isCanonicalGithubId(row.github_repo_id)) {
    throw new RepositoryValidationError();
  }

  if (!isConnectionStatus(row.connection_status)) {
    throw new RepositoryValidationError();
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    githubRepoId: row.github_repo_id,
    name: row.name,
    defaultBranch: row.default_branch,
    connectionStatus: row.connection_status,
    lastIndexedAt: row.last_indexed_at,
    createdAt: row.created_at,
  };
}

function assertCreateInput(input: CreateRepositoryInput): void {
  if (
    !isCanonicalGithubId(input.githubRepoId) ||
    input.name.trim().length === 0 ||
    input.defaultBranch.trim().length === 0
  ) {
    throw new RepositoryValidationError();
  }

  if (
    input.connectionStatus !== undefined &&
    !isConnectionStatus(input.connectionStatus)
  ) {
    throw new RepositoryValidationError();
  }
}

function assertUpdateInput(patch: UpdateRepositoryInput): void {
  if (
    patch.name !== undefined &&
    patch.name.trim().length === 0
  ) {
    throw new RepositoryValidationError();
  }

  if (
    patch.defaultBranch !== undefined &&
    patch.defaultBranch.trim().length === 0
  ) {
    throw new RepositoryValidationError();
  }

  if (
    patch.connectionStatus !== undefined &&
    !isConnectionStatus(patch.connectionStatus)
  ) {
    throw new RepositoryValidationError();
  }
}

function isConnectionStatus(
  value: string,
): value is RepositoryConnectionStatus {
  return (RepositoryConnectionStatuses as readonly string[]).includes(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
