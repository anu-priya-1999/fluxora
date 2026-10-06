import test from "node:test";
import assert from "node:assert/strict";
import { REPOSITORY_INDEXED_EVENT_TYPE } from "@fluxora/shared-types";
import { handleRepositoryIndexedMessage } from "./repository-events.ts";

test("handleRepositoryIndexedMessage parses valid repository.indexed envelope", () => {
  const envelope = {
    event_id: "11111111-1111-4111-8111-111111111111",
    event_type: REPOSITORY_INDEXED_EVENT_TYPE,
    organization_id: "org_fluxora_test",
    occurred_at: "2026-10-06T12:00:00.000Z",
    schema_version: 1,
    idempotency_key: "repository.indexed:repo-1:sha-123",
    payload: {
      repository_id: "00000000-0000-4000-8000-000000000001",
      snapshot_id: "00000000-0000-4000-8000-000000000002",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "refs/heads/main",
    },
  };

  const notification = handleRepositoryIndexedMessage(JSON.stringify(envelope));
  assert.ok(notification !== null);
  assert.equal(notification.type, REPOSITORY_INDEXED_EVENT_TYPE);
  assert.equal(notification.eventId, "11111111-1111-4111-8111-111111111111");
  assert.equal(notification.organizationId, "org_fluxora_test");
  assert.equal(notification.repositoryId, "00000000-0000-4000-8000-000000000001");
  assert.equal(notification.snapshotId, "00000000-0000-4000-8000-000000000002");
  assert.equal(notification.commitSha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(notification.ref, "refs/heads/main");
});

test("handleRepositoryIndexedMessage ignores other event types", () => {
  const envelope = {
    event_id: "22222222-2222-4222-8222-222222222222",
    event_type: "connection.ready",
    organization_id: "org_fluxora_test",
  };

  const notification = handleRepositoryIndexedMessage(JSON.stringify(envelope));
  assert.equal(notification, null);
});

test("handleRepositoryIndexedMessage handles malformed json gracefully", () => {
  assert.equal(handleRepositoryIndexedMessage("invalid json"), null);
  assert.equal(handleRepositoryIndexedMessage(null), null);
  assert.equal(handleRepositoryIndexedMessage({}), null);
});
