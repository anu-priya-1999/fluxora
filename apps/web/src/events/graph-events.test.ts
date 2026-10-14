import assert from "node:assert/strict";
import test from "node:test";
import { GRAPH_UPDATED_EVENT_TYPE } from "@fluxora/shared-types";
import {
  handleGraphUpdatedMessage,
  isGraphUpdatedEventRelevant,
} from "./graph-events.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_REPO_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_RUN_ID = "88888888-8888-4888-8888-888888888888";

function createValidEnvelope(payloadOverrides: Record<string, unknown> = {}) {
  return {
    event_id: "44444444-4444-4444-8444-444444444444",
    event_type: GRAPH_UPDATED_EVENT_TYPE,
    organization_id: ORG_ID,
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "graph.updated:run-1",
    payload: {
      organization_id: ORG_ID,
      analysis_run_id: RUN_ID,
      repository_id: REPO_ID,
      summary: {
        nodes_added: 2,
        nodes_removed: 0,
        nodes_changed: 0,
        nodes_unchanged: 5,
        edges_added: 1,
        edges_removed: 0,
        edges_changed: 0,
        edges_unchanged: 3,
        total_nodes_before: 5,
        total_nodes_after: 7,
        total_edges_before: 3,
        total_edges_after: 4,
        node_delta: 2,
        edge_delta: 1,
      },
      diff: {
        addedNodes: [],
        removedNodes: [],
        changedNodes: [],
        addedEdges: [],
        removedEdges: [],
        changedEdges: [],
      },
      ...payloadOverrides,
    },
  };
}

test("handleGraphUpdatedMessage parses valid graph.updated event envelope", () => {
  const envelope = createValidEnvelope();
  const notification = handleGraphUpdatedMessage(JSON.stringify(envelope));

  assert.ok(notification !== null);
  assert.equal(notification.type, GRAPH_UPDATED_EVENT_TYPE);
  assert.equal(notification.eventId, "44444444-4444-4444-8444-444444444444");
  assert.equal(notification.organizationId, ORG_ID);
  assert.equal(notification.payload.repositoryId, REPO_ID);
  assert.equal(notification.payload.analysisRunId, RUN_ID);
  assert.equal(notification.payload.summary.nodesAdded, 2);
});

test("handleGraphUpdatedMessage parses raw object directly without JSON stringifying", () => {
  const envelope = createValidEnvelope();
  const notification = handleGraphUpdatedMessage(envelope);

  assert.ok(notification !== null);
  assert.equal(notification.type, GRAPH_UPDATED_EVENT_TYPE);
  assert.equal(notification.payload.analysisRunId, RUN_ID);
});

test("handleGraphUpdatedMessage ignores non-graph.updated event types safely", () => {
  const envelope = {
    event_id: "55555555-5555-4555-8555-555555555555",
    event_type: "repository.indexed",
    organization_id: ORG_ID,
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "repo.indexed:1",
    payload: {},
  };

  assert.equal(handleGraphUpdatedMessage(envelope), null);
  assert.equal(handleGraphUpdatedMessage(JSON.stringify(envelope)), null);
  assert.equal(handleGraphUpdatedMessage("connection.ready"), null);
});

test("handleGraphUpdatedMessage ignores malformed payloads safely", () => {
  assert.equal(handleGraphUpdatedMessage("invalid-json{"), null);
  assert.equal(handleGraphUpdatedMessage(null), null);
  assert.equal(handleGraphUpdatedMessage(undefined), null);
  assert.equal(handleGraphUpdatedMessage(42), null);
  assert.equal(handleGraphUpdatedMessage({}), null);
  assert.equal(handleGraphUpdatedMessage({ event_type: GRAPH_UPDATED_EVENT_TYPE }), null);

  // Missing summary/diff
  const incomplete = {
    event_id: "44444444-4444-4444-8444-444444444444",
    event_type: GRAPH_UPDATED_EVENT_TYPE,
    organization_id: ORG_ID,
    occurred_at: "2026-10-14T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "key",
    payload: {
      organization_id: ORG_ID,
      analysis_run_id: RUN_ID,
    },
  };
  assert.equal(handleGraphUpdatedMessage(incomplete), null);
});

test("isGraphUpdatedEventRelevant matches exact repository and run", () => {
  const envelope = createValidEnvelope();
  const notification = handleGraphUpdatedMessage(envelope);
  assert.ok(notification !== null);

  const context = { repositoryId: REPO_ID, analysisRunId: RUN_ID };
  assert.equal(isGraphUpdatedEventRelevant(notification.payload, context), true);
});

test("isGraphUpdatedEventRelevant rejects events for different repositories", () => {
  const envelope = createValidEnvelope({ repository_id: OTHER_REPO_ID });
  const notification = handleGraphUpdatedMessage(envelope);
  assert.ok(notification !== null);

  const context = { repositoryId: REPO_ID, analysisRunId: RUN_ID };
  assert.equal(isGraphUpdatedEventRelevant(notification.payload, context), false);
});

test("isGraphUpdatedEventRelevant rejects events for different analysis runs", () => {
  const envelope = createValidEnvelope({ analysis_run_id: OTHER_RUN_ID });
  const notification = handleGraphUpdatedMessage(envelope);
  assert.ok(notification !== null);

  const context = { repositoryId: REPO_ID, analysisRunId: RUN_ID };
  assert.equal(isGraphUpdatedEventRelevant(notification.payload, context), false);
});

