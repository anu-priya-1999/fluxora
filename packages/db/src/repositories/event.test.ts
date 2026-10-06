import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrganization,
  createEvent,
  getEventById,
  getPool,
  listEvents,
  closePool,
} from "../index.ts";
import { loadRootEnvFile } from "../cli/env.ts";

loadRootEnvFile();
import {
  REPOSITORY_INDEXED_EVENT_TYPE,
  repositoryIndexedIdempotencyKey,
  type RepositoryIndexedPayload,
  parseFluxoraEventEnvelope,
} from "@fluxora/shared-types";

test("event outbox: stores events with RLS, idempotency, and LISTEN/NOTIFY", async (t) => {
  const pool = getPool();

  t.after(async () => {
    await closePool();
  });

  const orgA = await createOrganization(pool, {
    name: "Org A Events Test",
    planTier: "free",
  });

  const orgB = await createOrganization(pool, {
    name: "Org B Events Test",
    planTier: "free",
  });

  const repoId = "33333333-3333-4333-8333-333333333333";
  const snapshotId = "44444444-4444-4444-8444-444444444444";
  const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
  const idempotencyKey = repositoryIndexedIdempotencyKey(repoId, commitSha);

  const payload: RepositoryIndexedPayload = {
    repositoryId: repoId,
    repository_id: repoId,
    snapshotId: snapshotId,
    snapshot_id: snapshotId,
    commitSha: commitSha,
    commit_sha: commitSha,
    ref: "refs/heads/main",
  };

  // 1. Test LISTEN/NOTIFY delivery
  const listenerClient = await pool.connect();
  const notifications: string[] = [];

  try {
    await listenerClient.query("LISTEN fluxora_events");
    listenerClient.on("notification", (msg) => {
      if (msg.channel === "fluxora_events" && msg.payload) {
        notifications.push(msg.payload);
      }
    });

    // 2. Create event
    const event = await createEvent(pool, {
      organizationId: orgA.id,
      type: REPOSITORY_INDEXED_EVENT_TYPE,
      idempotencyKey,
      payload,
    });

    assert.equal(event.organizationId, orgA.id);
    assert.equal(event.type, REPOSITORY_INDEXED_EVENT_TYPE);
    assert.equal(event.idempotencyKey, idempotencyKey);
    assert.deepEqual(event.payload, payload);
    assert.equal(event.schemaVersion, 1);

    // Give notification a moment to arrive
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(notifications.length, 1);
    const parsedNotification =
      parseFluxoraEventEnvelope<RepositoryIndexedPayload>(
        JSON.parse(notifications[0] ?? ""),
      );
    assert.ok(parsedNotification !== null);
    assert.equal(parsedNotification.event_id, event.id);
    assert.equal(parsedNotification.organization_id, orgA.id);
    assert.equal(parsedNotification.event_type, REPOSITORY_INDEXED_EVENT_TYPE);
    assert.equal(parsedNotification.idempotency_key, idempotencyKey);
    assert.equal(parsedNotification.payload.repository_id, repoId);

    // 3. Test Idempotency: duplicate call with same idempotency key returns existing event
    const duplicateEvent = await createEvent(pool, {
      organizationId: orgA.id,
      type: REPOSITORY_INDEXED_EVENT_TYPE,
      idempotencyKey,
      payload: { ...payload, ref: "different-ref-ignored" },
    });

    assert.equal(duplicateEvent.id, event.id);
    // Notification should not have fired a second time because trigger is AFTER INSERT
    assert.equal(notifications.length, 1);

    // 4. Test RLS isolation: Org A can read it, Org B cannot
    const readByOrgA = await getEventById(pool, orgA.id, event.id);
    assert.ok(readByOrgA !== null);
    assert.equal(readByOrgA.id, event.id);

    const readByOrgB = await getEventById(pool, orgB.id, event.id);
    assert.equal(readByOrgB, null);

    const listOrgA = await listEvents(pool, orgA.id, {
      type: REPOSITORY_INDEXED_EVENT_TYPE,
    });
    assert.equal(
      listOrgA.some((e) => e.id === event.id),
      true,
    );

    const listOrgB = await listEvents(pool, orgB.id, {
      type: REPOSITORY_INDEXED_EVENT_TYPE,
    });
    assert.equal(
      listOrgB.some((e) => e.id === event.id),
      false,
    );
  } finally {
    await listenerClient.query("UNLISTEN *").catch(() => undefined);
    listenerClient.release();
  }
});
