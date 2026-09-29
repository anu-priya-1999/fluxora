import type {
  CreateOrganizationInput,
  Organization,
  PlanTier,
} from "@fluxora/shared-types";
import type pg from "pg";

import { mapOrganizationRow, type OrganizationRow } from "../mappers.ts";
import { withTenant } from "../tenant.ts";

export async function createOrganization(
  pool: pg.Pool,
  input: CreateOrganizationInput,
): Promise<Organization> {
  const planTier: PlanTier = input.planTier ?? "free";
  const githubOrgId = input.githubOrgId ?? null;

  const result = await pool.query<{ fluxora_create_organization: string }>(
    `SELECT fluxora_create_organization($1::text, $2::plan_tier, $3::bigint) AS fluxora_create_organization`,
    [input.name, planTier, githubOrgId],
  );

  const id = result.rows[0]?.fluxora_create_organization;
  if (id === undefined) {
    throw new Error("fluxora_create_organization returned no id");
  }

  return getOrganizationById(pool, id);
}

export async function getOrganizationById(
  pool: pg.Pool,
  organizationId: string,
): Promise<Organization> {
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<OrganizationRow>(
      `SELECT id, name, github_org_id, plan_tier, created_at
       FROM organizations
       WHERE id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`organization not found: ${organizationId}`);
    }
    return mapOrganizationRow(row);
  });
}
