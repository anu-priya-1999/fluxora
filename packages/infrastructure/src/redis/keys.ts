export function organizationRedisKey(
  organizationId: string,
  namespace: string,
  key: string,
): string {
  if (!organizationId.trim()) {
    throw new Error("organizationId is required");
  }

  if (!namespace.trim()) {
    throw new Error("namespace is required");
  }

  if (!key.trim()) {
    throw new Error("key is required");
  }

  return `org:${organizationId}:${namespace}:${key}`;
}

export function cacheKey(
  organizationId: string,
  key: string,
): string {
  return organizationRedisKey(organizationId, "cache", key);
}

export function lockKey(
  organizationId: string,
  key: string,
): string {
  return organizationRedisKey(organizationId, "lock", key);
}

export function rateLimitKey(
  organizationId: string,
  key: string,
): string {
  return organizationRedisKey(organizationId, "rate-limit", key);
}