/**
 * Typed events and outbox envelope contracts (`08-event-schema.md`).
 */

export const REPOSITORY_INDEXED_EVENT_TYPE = "repository.indexed" as const;

export type EventType = typeof REPOSITORY_INDEXED_EVENT_TYPE | (string & {});

/**
 * Payload for `repository.indexed` (`08-event-schema.md` §8.2).
 * Supports both camelCase and snake_case properties for compatibility
 * across TypeScript domain models and serialized JSON envelopes.
 */
export type RepositoryIndexedPayload = {
  repositoryId: string;
  repository_id: string;
  snapshotId: string;
  snapshot_id: string;
  commitSha: string;
  commit_sha: string;
  ref?: string;
};

/** Stable idempotency key for one repository commit indexing event. */
export function repositoryIndexedIdempotencyKey(
  repositoryId: string,
  commitSha: string,
): string {
  return `${REPOSITORY_INDEXED_EVENT_TYPE}:${repositoryId}:${commitSha}`;
}

/**
 * Durable event entity model (PostgreSQL `events` table).
 */
export interface FluxoraEvent<T = Record<string, unknown>> {
  id: string;
  organizationId: string;
  type: string;
  idempotencyKey: string;
  payload: T;
  schemaVersion: number;
  occurredAt: Date;
  createdAt: Date;
}

/**
 * Full serialized JSON envelope transported via PostgreSQL NOTIFY and WebSocket
 * (`08-event-schema.md` §8.3).
 */
export interface FluxoraEventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  organization_id: string;
  occurred_at: string;
  idempotency_key: string;
  payload: T;
  schema_version: number;
}

export interface CreateEventInput<T = Record<string, unknown>> {
  organizationId: string;
  type: string;
  idempotencyKey: string;
  payload: T;
  schemaVersion?: number;
  occurredAt?: Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function parseRepositoryIndexedPayload(
  raw: unknown,
): RepositoryIndexedPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const repositoryId =
    typeof record["repositoryId"] === "string"
      ? record["repositoryId"]
      : typeof record["repository_id"] === "string"
        ? record["repository_id"]
        : null;

  const snapshotId =
    typeof record["snapshotId"] === "string"
      ? record["snapshotId"]
      : typeof record["snapshot_id"] === "string"
        ? record["snapshot_id"]
        : null;

  const commitSha =
    typeof record["commitSha"] === "string"
      ? record["commitSha"]
      : typeof record["commit_sha"] === "string"
        ? record["commit_sha"]
        : null;

  if (
    repositoryId === null ||
    !UUID_PATTERN.test(repositoryId) ||
    snapshotId === null ||
    !UUID_PATTERN.test(snapshotId) ||
    commitSha === null ||
    !COMMIT_SHA_PATTERN.test(commitSha)
  ) {
    return null;
  }

  const ref = typeof record["ref"] === "string" ? record["ref"] : undefined;

  return {
    repositoryId,
    repository_id: repositoryId,
    snapshotId,
    snapshot_id: snapshotId,
    commitSha,
    commit_sha: commitSha,
    ...(ref !== undefined ? { ref } : {}),
  };
}

export function parseFluxoraEventEnvelope<T = Record<string, unknown>>(
  raw: unknown,
): FluxoraEventEnvelope<T> | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const eventId = record["event_id"];
  const eventType = record["event_type"];
  const organizationId = record["organization_id"];
  const occurredAt = record["occurred_at"];
  const idempotencyKey = record["idempotency_key"];
  const payload = record["payload"];
  const schemaVersion = record["schema_version"];

  if (
    typeof eventId !== "string" ||
    !UUID_PATTERN.test(eventId) ||
    typeof eventType !== "string" ||
    eventType.trim().length === 0 ||
    typeof organizationId !== "string" ||
    !UUID_PATTERN.test(organizationId) ||
    typeof occurredAt !== "string" ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0 ||
    typeof payload !== "object" ||
    payload === null ||
    typeof schemaVersion !== "number" ||
    schemaVersion < 1
  ) {
    return null;
  }

  return {
    event_id: eventId,
    event_type: eventType,
    organization_id: organizationId,
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
    payload: payload as T,
    schema_version: schemaVersion,
  };
}
