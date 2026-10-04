import type { GithubInstallation } from "@fluxora/shared-types";
import { isCanonicalGithubId } from "@fluxora/shared-types";
import type pg from "pg";

import { withTenant } from "../tenant.ts";

const WRITE_SAVEPOINT = "fluxora_github_installation_write";

export class GithubInstallationValidationError extends Error {
  constructor() {
    super("GitHub installation fields are invalid.");
    this.name = "GithubInstallationValidationError";
  }
}

export class GithubInstallationAccountMismatchError extends Error {
  constructor() {
    super("GitHub installation account does not match the stored installation.");
    this.name = "GithubInstallationAccountMismatchError";
  }
}

export class GithubInstallationConflictError extends Error {
  constructor() {
    super("GitHub installation is already connected to another organization.");
    this.name = "GithubInstallationConflictError";
  }
}

export interface SaveGithubInstallationInput {
  organizationId: string;
  githubInstallationId: string;
  githubAccountId: string;
  githubAccountLogin: string;
  githubAccountType: "User";
}

export interface SaveGithubInstallationResult {
  installation: GithubInstallation;
  created: boolean;
}

interface GithubInstallationRow {
  id: string;
  organization_id: string;
  github_installation_id: string;
  github_account_id: string;
  github_account_login: string;
  github_account_type: string;
  created_at: Date;
  updated_at: Date;
}

type InstallationSnapshot = Pick<
  GithubInstallation,
  | "githubInstallationId"
  | "githubAccountId"
  | "githubAccountLogin"
  | "githubAccountType"
>;

export type InstallationWritePlan =
  | { action: "insert" }
  | { action: "unchanged" }
  | { action: "refresh" }
  | { action: "reject" };

/**
 * Idempotent write decision for one organization.
 * Same installation returns unchanged. A new installation id for the same
 * GitHub account refreshes the row (reinstall). A different account rejects.
 */
export function planGithubInstallationWrite(
  existing: InstallationSnapshot | null,
  incoming: InstallationSnapshot,
): InstallationWritePlan {
  if (existing === null) {
    return { action: "insert" };
  }

  if (existing.githubAccountId !== incoming.githubAccountId) {
    return { action: "reject" };
  }

  if (
    existing.githubInstallationId === incoming.githubInstallationId &&
    existing.githubAccountLogin === incoming.githubAccountLogin &&
    existing.githubAccountType === incoming.githubAccountType
  ) {
    return { action: "unchanged" };
  }

  return { action: "refresh" };
}

export async function getGithubInstallationByOrganizationId(
  pool: pg.Pool,
  organizationId: string,
): Promise<GithubInstallation | null> {
  return withTenant(pool, organizationId, async (client) => {
    return selectInstallation(client, organizationId, false);
  });
}

export async function saveGithubInstallation(
  pool: pg.Pool,
  input: SaveGithubInstallationInput,
): Promise<SaveGithubInstallationResult> {
  assertInput(input);

  return withTenant(pool, input.organizationId, async (client) => {
    const existing = await selectInstallation(client, input.organizationId, true);
    return applyPlan(client, input, existing);
  });
}

async function applyPlan(
  client: pg.PoolClient,
  input: SaveGithubInstallationInput,
  existing: GithubInstallation | null,
): Promise<SaveGithubInstallationResult> {
  const plan = planGithubInstallationWrite(existing, input);

  if (plan.action === "reject") {
    throw new GithubInstallationAccountMismatchError();
  }

  if (plan.action === "unchanged" && existing !== null) {
    return { installation: existing, created: false };
  }

  if (plan.action === "refresh" && existing !== null) {
    try {
      const updated = await writeWithSavepoint(client, () =>
        updateInstallation(client, existing.id, input),
      );
      return { installation: updated, created: false };
    } catch (error) {
      throw asInstallationConflict(error);
    }
  }

  try {
    const inserted = await writeWithSavepoint(client, () =>
      insertInstallation(client, input),
    );
    return { installation: inserted, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const raced = await selectInstallation(client, input.organizationId, true);
    if (raced === null) {
      throw new GithubInstallationConflictError();
    }

    const racedPlan = planGithubInstallationWrite(raced, input);
    if (racedPlan.action === "unchanged") {
      return { installation: raced, created: false };
    }

    if (racedPlan.action === "refresh") {
      try {
        const updated = await writeWithSavepoint(client, () =>
          updateInstallation(client, raced.id, input),
        );
        return { installation: updated, created: false };
      } catch (refreshError) {
        throw asInstallationConflict(refreshError);
      }
    }

    throw new GithubInstallationConflictError();
  }
}

/**
 * A unique violation aborts the surrounding transaction unless it is caught
 * with a savepoint. RLS hides the other tenant's row, so the unique index is
 * the cross-tenant backstop and this savepoint lets the request continue.
 */
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

async function selectInstallation(
  client: pg.PoolClient,
  organizationId: string,
  forUpdate: boolean,
): Promise<GithubInstallation | null> {
  const result = await client.query<GithubInstallationRow>(
    `SELECT
       id,
       organization_id,
       github_installation_id::text AS github_installation_id,
       github_account_id::text AS github_account_id,
       github_account_login,
       github_account_type,
       created_at,
       updated_at
     FROM github_installations
     WHERE organization_id = $1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }

  return mapInstallationRow(row);
}

async function insertInstallation(
  client: pg.PoolClient,
  input: SaveGithubInstallationInput,
): Promise<GithubInstallation> {
  const result = await client.query<GithubInstallationRow>(
    `INSERT INTO github_installations (
       organization_id,
       github_installation_id,
       github_account_id,
       github_account_login,
       github_account_type
     )
     VALUES ($1::uuid, $2::bigint, $3::bigint, $4, $5)
     RETURNING
       id,
       organization_id,
       github_installation_id::text AS github_installation_id,
       github_account_id::text AS github_account_id,
       github_account_login,
       github_account_type,
       created_at,
       updated_at`,
    [
      input.organizationId,
      input.githubInstallationId,
      input.githubAccountId,
      input.githubAccountLogin,
      input.githubAccountType,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("github installation insert returned no row");
  }

  return mapInstallationRow(row);
}

async function updateInstallation(
  client: pg.PoolClient,
  id: string,
  input: SaveGithubInstallationInput,
): Promise<GithubInstallation> {
  const result = await client.query<GithubInstallationRow>(
    `UPDATE github_installations
     SET github_installation_id = $3::bigint,
         github_account_login = $4,
         github_account_type = $5,
         updated_at = now()
     WHERE id = $1::uuid
       AND organization_id = $2::uuid
       AND github_account_id = $6::bigint
     RETURNING
       id,
       organization_id,
       github_installation_id::text AS github_installation_id,
       github_account_id::text AS github_account_id,
       github_account_login,
       github_account_type,
       created_at,
       updated_at`,
    [
      id,
      input.organizationId,
      input.githubInstallationId,
      input.githubAccountLogin,
      input.githubAccountType,
      input.githubAccountId,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new GithubInstallationConflictError();
  }

  return mapInstallationRow(row);
}

function mapInstallationRow(row: GithubInstallationRow): GithubInstallation {
  if (row.github_account_type !== "User") {
    throw new GithubInstallationValidationError();
  }

  if (
    !isCanonicalGithubId(row.github_installation_id) ||
    !isCanonicalGithubId(row.github_account_id)
  ) {
    throw new GithubInstallationValidationError();
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    githubInstallationId: row.github_installation_id,
    githubAccountId: row.github_account_id,
    githubAccountLogin: row.github_account_login,
    githubAccountType: "User",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertInput(input: SaveGithubInstallationInput): void {
  if (
    !isCanonicalGithubId(input.githubInstallationId) ||
    !isCanonicalGithubId(input.githubAccountId) ||
    !isGithubLogin(input.githubAccountLogin) ||
    input.githubAccountType !== "User"
  ) {
    throw new GithubInstallationValidationError();
  }
}

function isGithubLogin(value: string): boolean {
  return /^[A-Za-z0-9-]{1,39}$/.test(value);
}

function asInstallationConflict(error: unknown): Error {
  if (
    isUniqueViolation(error) ||
    error instanceof GithubInstallationConflictError
  ) {
    return new GithubInstallationConflictError();
  }

  return error instanceof Error ? error : new Error("github installation write failed");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
