import {
  GRAPH_UPDATED_EVENT_TYPE,
  type GraphUpdatedPayload,
  parseFluxoraEventEnvelope,
  parseGraphUpdatedPayload,
} from "@fluxora/shared-types";

export interface GraphUpdatedUiNotification {
  readonly type: typeof GRAPH_UPDATED_EVENT_TYPE;
  readonly eventId: string;
  readonly organizationId: string;
  readonly occurredAt: string;
  readonly payload: GraphUpdatedPayload;
}

export interface ExplorerAnalysisContextMatch {
  readonly repositoryId: string;
  readonly analysisRunId: string;
}

/**
 * Parses raw WebSocket message string or object into a typed graph.updated event notification,
 * or returns null if the message is unrelated, unparseable, or malformed.
 */
export function handleGraphUpdatedMessage(
  data: unknown,
): GraphUpdatedUiNotification | null {
  try {
    let raw: unknown = data;
    if (typeof data === "string") {
      raw = JSON.parse(data);
    }

    if (!raw || typeof raw !== "object") {
      return null;
    }

    const envelope = parseFluxoraEventEnvelope(raw);
    if (!envelope || envelope.event_type !== GRAPH_UPDATED_EVENT_TYPE) {
      return null;
    }

    const payload = parseGraphUpdatedPayload(envelope.payload);
    if (!payload) {
      return null;
    }

    return {
      type: GRAPH_UPDATED_EVENT_TYPE,
      eventId: envelope.event_id,
      organizationId: envelope.organization_id,
      occurredAt: envelope.occurred_at,
      payload,
    };
  } catch {
    return null;
  }
}

/**
 * Checks whether a validated graph.updated payload is relevant to the currently viewed explorer context.
 * Returns false if the event is for a different repository or analysis run.
 */
export function isGraphUpdatedEventRelevant(
  payload: GraphUpdatedPayload,
  context: ExplorerAnalysisContextMatch,
): boolean {
  if (
    payload.repositoryId !== undefined &&
    payload.repositoryId !== context.repositoryId
  ) {
    return false;
  }

  if (
    payload.analysisRunId !== undefined &&
    payload.analysisRunId !== context.analysisRunId
  ) {
    return false;
  }

  return true;
}
