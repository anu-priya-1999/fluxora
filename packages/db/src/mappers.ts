import type { Organization, PlanTier, User, UserRole } from "@fluxora/shared-types";
import { PlanTiers, UserRoles } from "@fluxora/shared-types";

export interface OrganizationRow {
  id: string;
  name: string;
  github_org_id: string | null;
  plan_tier: string;
  created_at: Date;
}

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  github_user_id: string | null;
  role: string;
  created_at: Date;
}

function assertUserRole(value: string): UserRole {
  if ((UserRoles as readonly string[]).includes(value)) {
    return value as UserRole;
  }
  throw new Error(`unexpected user_role value from database: ${value}`);
}

function assertPlanTier(value: string): PlanTier {
  if ((PlanTiers as readonly string[]).includes(value)) {
    return value as PlanTier;
  }
  throw new Error(`unexpected plan_tier value from database: ${value}`);
}

function parseBigintColumn(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`bigint column value is outside safe integer range: ${value}`);
  }
  return parsed;
}

export function mapOrganizationRow(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    githubOrgId: parseBigintColumn(row.github_org_id),
    planTier: assertPlanTier(row.plan_tier),
    createdAt: row.created_at,
  };
}

export function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    githubUserId: parseBigintColumn(row.github_user_id),
    role: assertUserRole(row.role),
    createdAt: row.created_at,
  };
}
