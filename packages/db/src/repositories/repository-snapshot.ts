import type { RepositorySnapshot } from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const WRITE_SAVEPOINT = "fluxora_repository_snapshot_write";
const GIT_SHA = /^[0-9a-f]{40}$/;

export class RepositorySnapshotValidationError extends Error {
  constructor() {
    super("Repository snapshot fields are invalid.");
    this.name = "RepositorySnapshotValidationError";
  }
}

export class RepositorySnapshotImmutableError extends Error {
  constructor() {
    super("An existing repository snapshot cannot be overwritten.");
    this.name = "RepositorySnapshotImmutableError";
  }
}

export interface CreateRepositorySnapshotInput {
  organizationId: string;
  repositoryId: string;
  commitSha: string;
  ref: string;
  storageUri: string;
  fileCount: number;
  sizeBytes: string;
}

interface SnapshotRow {
  id: string;
  repository_id: string;
  commit_sha: string;
  ref: string;
  storage_uri: string;
  file_count: number;
  size_bytes: string;
  created_at: Date;
}

const SNAPSHOT_COLUMNS = `
  id,
  repository_id,
  commit_sha,
  ref,
  storage_uri,
  file_count,
  size_bytes::text AS size_bytes,
  created_at
`;

export async function createRepositorySnapshot(
  pool: pg.Pool,
  input: CreateRepositorySnapshotInput,
): Promise<RepositorySnapshot> {
  assertCreateInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    try {
      return await writeWithSavepoint(client, () => insertSnapshot(client, input));
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const existing = await selectSnapshotByCommitSha(
        client,
        input.repositoryId,
        input.commitSha,
      );

      if (existing === null) {
        throw new RepositorySnapshotImmutableError();
      }

      if (!sameSnapshotPayload(existing, input)) {
        throw new RepositorySnapshotImmutableError();
      }

      return existing;
    }
  });
}

export async function getRepositorySnapshotById(
  pool: pg.Pool,
  organizationId: string,
  snapshotId: string,
): Promise<RepositorySnapshot | null> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM repository_snapshots
       WHERE id = $1::uuid`,
      [snapshotId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapSnapshotRow(row);
  });
}

export async function listRepositorySnapshots(
  pool: pg.Pool,
  organizationId: string,
  repositoryId: string,
): Promise<RepositorySnapshot[]> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM repository_snapshots
       WHERE repository_id = $1::uuid
       ORDER BY created_at DESC, id DESC`,
      [repositoryId],
    );

    return result.rows.map(mapSnapshotRow);
  });
}

export async function tryOverwriteRepositorySnapshot(
  pool: pg.Pool,
  organizationId: string,
  snapshotId: string,
  fileCount: number,
): Promise<number> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query(
      `UPDATE repository_snapshots
       SET file_count = $2
       WHERE id = $1::uuid`,
      [snapshotId, fileCount],
    );

    return result.rowCount ?? 0;
  });
}

async function insertSnapshot(
  client: pg.PoolClient,
  input: CreateRepositorySnapshotInput,
): Promise<RepositorySnapshot> {
  const result = await client.query<SnapshotRow>(
    `INSERT INTO repository_snapshots (
       repository_id,
       commit_sha,
       ref,
       storage_uri,
       file_count,
       size_bytes
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6::bigint)
     RETURNING ${SNAPSHOT_COLUMNS}`,
    [
      input.repositoryId,
      input.commitSha,
      input.ref.trim(),
      input.storageUri.trim(),
      input.fileCount,
      input.sizeBytes,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("repository snapshot insert returned no row");
  }

  return mapSnapshotRow(row);
}

async function selectSnapshotByCommitSha(
  client: pg.PoolClient,
  repositoryId: string,
  commitSha: string,
): Promise<RepositorySnapshot | null> {
  const result = await client.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS}
     FROM repository_snapshots
     WHERE repository_id = $1::uuid
       AND commit_sha = $2`,
    [repositoryId, commitSha],
  );

  const row = result.rows[0];
  return row === undefined ? null : mapSnapshotRow(row);
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

function mapSnapshotRow(row: SnapshotRow): RepositorySnapshot {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    ref: row.ref,
    storageUri: row.storage_uri,
    fileCount: row.file_count,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

function sameSnapshotPayload(
  existing: RepositorySnapshot,
  input: CreateRepositorySnapshotInput,
): boolean {
  return (
    existing.ref === input.ref.trim() &&
    existing.storageUri === input.storageUri.trim() &&
    existing.fileCount === input.fileCount &&
    existing.sizeBytes === input.sizeBytes
  );
}

function assertCreateInput(input: CreateRepositorySnapshotInput): void {
  if (
    !GIT_SHA.test(input.commitSha) ||
    input.ref.trim().length === 0 ||
    input.storageUri.trim().length === 0 ||
    !Number.isInteger(input.fileCount) ||
    input.fileCount < 0 ||
    !/^[0-9]+$/.test(input.sizeBytes)
  ) {
    throw new RepositorySnapshotValidationError();
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
