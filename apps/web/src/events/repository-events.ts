import {
  REPOSITORY_INDEXED_EVENT_TYPE,
  type FluxoraEventEnvelope,
  parseRepositoryIndexedPayload,
} from "@fluxora/shared-types";

export interface RepositoryIndexedUiNotification {
  type: typeof REPOSITORY_INDEXED_EVENT_TYPE;
  eventId: string;
  organizationId: string;
  repositoryId: string;
  snapshotId: string;
  commitSha: string;
  ref?: string | undefined;
  occurredAt: string;
}

/**
 * Parses raw WebSocket message string or object into a typed repository.indexed event notification,
 * or returns null if the message is unrelated or malformed.
 */
export function handleRepositoryIndexedMessage(
  data: unknown,
): RepositoryIndexedUiNotification | null {
  try {
    let raw: unknown = data;
    if (typeof data === "string") {
      raw = JSON.parse(data);
    }

    if (!raw || typeof raw !== "object") {
      return null;
    }

    const envelope = raw as Partial<FluxoraEventEnvelope<unknown>>;
    if (envelope.event_type !== REPOSITORY_INDEXED_EVENT_TYPE) {
      return null;
    }

    if (
      typeof envelope.event_id !== "string" ||
      typeof envelope.organization_id !== "string" ||
      typeof envelope.occurred_at !== "string" ||
      !envelope.payload
    ) {
      return null;
    }

    const payload = parseRepositoryIndexedPayload(envelope.payload);
    if (!payload) {
      return null;
    }

    return {
      type: REPOSITORY_INDEXED_EVENT_TYPE,
      eventId: envelope.event_id,
      organizationId: envelope.organization_id,
      repositoryId: payload.repositoryId,
      snapshotId: payload.snapshotId,
      commitSha: payload.commitSha,
      ref: payload.ref,
      occurredAt: envelope.occurred_at,
    };
  } catch {
    return null;
  }
}
