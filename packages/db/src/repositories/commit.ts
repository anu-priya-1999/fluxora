import type { Commit } from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const WRITE_SAVEPOINT = "fluxora_commit_write";
const GIT_SHA = /^[0-9a-f]{40}$/;

export class CommitValidationError extends Error {
  constructor() {
    super("Commit fields are invalid.");
    this.name = "CommitValidationError";
  }
}

export class CommitConflictError extends Error {
  constructor() {
    super("A commit with this SHA already exists in the repository.");
    this.name = "CommitConflictError";
  }
}

export interface CreateCommitInput {
  organizationId: string;
  repositoryId: string;
  sha: string;
  author: string;
  message: string;
  committedAt: Date;
  parentShas?: string[];
}

interface CommitRow {
  id: string;
  repository_id: string;
  sha: string;
  author: string;
  message: string;
  committed_at: Date;
  parent_shas: string[];
}

const COMMIT_COLUMNS = `
  id,
  repository_id,
  sha,
  author,
  message,
  committed_at,
  parent_shas
`;

export async function createCommit(
  pool: pg.Pool,
  input: CreateCommitInput,
): Promise<Commit> {
  assertCreateInput(input);
  const parentShas = input.parentShas ?? [];

  return withTenant(pool, input.organizationId, async (client) => {
    try {
      return await writeWithSavepoint(client, () =>
        insertCommit(client, input, parentShas),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const existing = await selectCommitBySha(client, input.repositoryId, input.sha);
      if (existing === null) {
        throw new CommitConflictError();
      }

      if (!sameCommitPayload(existing, input, parentShas)) {
        throw new CommitConflictError();
      }

      return existing;
    }
  });
}

export async function getCommitById(
  pool: pg.Pool,
  organizationId: string,
  commitId: string,
): Promise<Commit | null> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<CommitRow>(
      `SELECT ${COMMIT_COLUMNS}
       FROM commits
       WHERE id = $1::uuid`,
      [commitId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapCommitRow(row);
  });
}

export async function listCommits(
  pool: pg.Pool,
  organizationId: string,
  repositoryId: string,
): Promise<Commit[]> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<CommitRow>(
      `SELECT ${COMMIT_COLUMNS}
       FROM commits
       WHERE repository_id = $1::uuid
       ORDER BY committed_at DESC, id DESC`,
      [repositoryId],
    );

    return result.rows.map(mapCommitRow);
  });
}

async function insertCommit(
  client: pg.PoolClient,
  input: CreateCommitInput,
  parentShas: string[],
): Promise<Commit> {
  const result = await client.query<CommitRow>(
    `INSERT INTO commits (
       repository_id,
       sha,
       author,
       message,
       committed_at,
       parent_shas
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6::text[])
     RETURNING ${COMMIT_COLUMNS}`,
    [
      input.repositoryId,
      input.sha,
      input.author.trim(),
      input.message,
      input.committedAt,
      parentShas,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("commit insert returned no row");
  }

  return mapCommitRow(row);
}

async function selectCommitBySha(
  client: pg.PoolClient,
  repositoryId: string,
  sha: string,
): Promise<Commit | null> {
  const result = await client.query<CommitRow>(
    `SELECT ${COMMIT_COLUMNS}
     FROM commits
     WHERE repository_id = $1::uuid
       AND sha = $2`,
    [repositoryId, sha],
  );

  const row = result.rows[0];
  return row === undefined ? null : mapCommitRow(row);
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

function mapCommitRow(row: CommitRow): Commit {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sha: row.sha,
    author: row.author,
    message: row.message,
    committedAt: row.committed_at,
    parentShas: row.parent_shas,
  };
}

function sameCommitPayload(
  existing: Commit,
  input: CreateCommitInput,
  parentShas: string[],
): boolean {
  return (
    existing.author === input.author.trim() &&
    existing.message === input.message &&
    existing.committedAt.getTime() === input.committedAt.getTime() &&
    existing.parentShas.length === parentShas.length &&
    existing.parentShas.every((sha, index) => sha === parentShas[index])
  );
}

function assertCreateInput(input: CreateCommitInput): void {
  const parentShas = input.parentShas ?? [];

  if (
    !GIT_SHA.test(input.sha) ||
    input.author.trim().length === 0 ||
    !parentShas.every((sha) => GIT_SHA.test(sha))
  ) {
    throw new CommitValidationError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
