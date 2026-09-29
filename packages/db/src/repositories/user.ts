import type { CreateUserInput, User } from "@fluxora/shared-types";
import type pg from "pg";

import { mapUserRow, type UserRow } from "../mappers.ts";
import { withTenant } from "../tenant.ts";

export class UserNotFoundError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(`user not found: ${userId}`);
    this.name = "UserNotFoundError";
    this.userId = userId;
  }
}

export async function createUser(
  pool: pg.Pool,
  input: CreateUserInput,
): Promise<User> {
  const githubUserId = input.githubUserId ?? null;

  const result = await pool.query<{ fluxora_create_user: string }>(
    `SELECT fluxora_create_user($1::uuid, $2::text, $3::user_role, $4::bigint) AS fluxora_create_user`,
    [input.organizationId, input.email, input.role, githubUserId],
  );

  const id = result.rows[0]?.fluxora_create_user;
  if (id === undefined) {
    throw new Error("fluxora_create_user returned no id");
  }

  return getUserById(pool, input.organizationId, id);
}

export async function provisionGithubUser(
  pool: pg.Pool,
  input: {
    githubUserId: number;
    email: string;
    organizationName: string;
  },
): Promise<User> {
  const result = await pool.query<{
    user_id: string;
    organization_id: string;
  }>(
    `SELECT user_id, organization_id
     FROM fluxora_provision_github_user($1::bigint, $2::text, $3::text)`,
    [input.githubUserId, input.email, input.organizationName],
  );

  const row = result.rows[0];

  if (row === undefined) {
    throw new Error("fluxora_provision_github_user returned no user");
  }

  return getUserById(pool, row.organization_id, row.user_id);
}

export async function getUserById(
  pool: pg.Pool,
  organizationId: string,
  userId: string,
): Promise<User> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<UserRow>(
      `SELECT id, organization_id, email, github_user_id, role, created_at
       FROM users
       WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new UserNotFoundError(userId);
    }
    return mapUserRow(row);
  });
}

export async function listUsersInOrganization(
  pool: pg.Pool,
  organizationId: string,
): Promise<User[]> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<UserRow>(
      `SELECT id, organization_id, email, github_user_id, role, created_at
       FROM users
       WHERE organization_id = $1
       ORDER BY created_at ASC`,
      [organizationId],
    );
    return result.rows.map((row) => mapUserRow(row));
  });
}
