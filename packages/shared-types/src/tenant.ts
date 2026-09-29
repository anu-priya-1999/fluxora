/** Organization membership roles (application-layer RBAC; mirrored in Postgres `user_role`). */
export const UserRoles = ["owner", "admin", "member", "viewer"] as const;
export type UserRole = (typeof UserRoles)[number];

/** Billing / capability tier for an organization. */
export const PlanTiers = ["free", "pro", "enterprise"] as const;
export type PlanTier = (typeof PlanTiers)[number];

/** Tenant boundary record (`organizations` table). */
export interface Organization {
  id: string;
  name: string;
  githubOrgId: number | null;
  planTier: PlanTier;
  createdAt: Date;
}

/** User belonging to exactly one organization (`users` table). */
export interface User {
  id: string;
  organizationId: string;
  email: string;
  githubUserId: number | null;
  role: UserRole;
  createdAt: Date;
}

export interface CreateOrganizationInput {
  name: string;
  planTier?: PlanTier;
  githubOrgId?: number | null;
}

export interface CreateUserInput {
  organizationId: string;
  email: string;
  role: UserRole;
  githubUserId?: number | null;
}
