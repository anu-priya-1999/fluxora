# Step 15 — Repository Indexed Event & WebSocket Push

## Objective

Implement Fluxora Global Step 15:
1. Emit a durable, tenant-scoped, idempotent `repository.indexed` event upon successful snapshot persistence and repository activation.
2. Deliver the event from PostgreSQL to connected API listeners using PostgreSQL `LISTEN`/`NOTIFY`.
3. Provide an authenticated WebSocket endpoint at `/api/v1/ws` authenticating clients via Clerk session tokens.
4. Maintain tenant isolation by routing event broadcasts strictly to WebSocket clients belonging to the event's organization.
5. Provide a minimal frontend event consumer and activity feed in the Next.js dashboard.

---

## Architecture Alignment

Following `docs/architecture/08-event-schema.md` and `docs/architecture/04-api-design.md`:

```text
Worker (Ingestion Pipeline)
  ↓
1. persistSnapshot (Step 13)
2. updateConnectionStatus('active')
3. createEvent('repository.indexed') with idempotency key
  ↓
PostgreSQL `events` table (RLS + unique idempotency)
  ↓ Trigger `events_notify_trigger`
`pg_notify('fluxora_events', payload)`
  ↓
PostgreSQL LISTEN (`PostgresEventListener` in apps/api)
  ↓
`WebSocketHub` (in-memory tenant-partitioned connection registry)
  ↓ Broadcast strictly to org connections
WebSocket Clients at `/api/v1/ws` (Clerk-authenticated)
  ↓
Frontend Dashboard (`handleRepositoryIndexedMessage`)
```

---

## 1. Typed Event Definition (`packages/shared-types`)

- **Event type constant**: `REPOSITORY_INDEXED_EVENT_TYPE = "repository.indexed"`
- **Schema version**: `1`
- **Payload interface**: `RepositoryIndexedPayload`:
  - `repositoryId` / `repository_id`: string (UUID)
  - `snapshotId` / `snapshot_id`: string (UUID)
  - `commitSha` / `commit_sha`: string (40-char SHA)
  - `ref`: optional string
- **Idempotency key generator**:
  - `repositoryIndexedIdempotencyKey(repositoryId, commitSha)` -> `"repository.indexed:<repositoryId>:<commitSha>"`
- **Envelope structure**: `FluxoraEventEnvelope<T>` matching Section 8.3 of `08-event-schema.md`:
  - `event_id`: UUID
  - `event_type`: string
  - `organization_id`: string
  - `occurred_at`: ISO timestamp string
  - `idempotency_key`: string
  - `payload`: T
  - `schema_version`: number

---

## 2. PostgreSQL Events Outbox & LISTEN/NOTIFY (`packages/db`)

### Migration: `0013_events_outbox.sql`
- Table: `events`
  - `id`: UUID PRIMARY KEY DEFAULT gen_random_uuid()
  - `organization_id`: VARCHAR(255) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
  - `type`: VARCHAR(128) NOT NULL
  - `idempotency_key`: VARCHAR(255) NOT NULL
  - `payload`: JSONB NOT NULL
  - `schema_version`: INTEGER NOT NULL DEFAULT 1
  - `occurred_at`: TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  - `created_at`: TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  - Constraint: `CONSTRAINT uq_events_org_idempotency UNIQUE (organization_id, idempotency_key)`
- Row-Level Security (RLS):
  - Enabled on `events`.
  - Tenant policy checks `organization_id = current_setting('app.current_organization_id', true)`.
  - Service role bypasses RLS for system workers/listeners when `app.is_service_role = 'true'`.
- Database Trigger & Function:
  - Function: `fluxora_notify_event()`
  - Trigger: `events_notify_trigger` AFTER INSERT ON `events`
  - Calls `PERFORM pg_notify('fluxora_events', envelope_json)`.

### Event Repository: `packages/db/src/repositories/event.ts`
- `createEvent`: Inserts into `events` table with RLS context, returns persisted event. On duplicate idempotency key violation, returns existing event.

---

## 3. Worker Event Emission (`apps/workers`)

In `apps/workers/src/ingest/ingest.ts`:
- Emits `repository.indexed` immediately following successful snapshot persistence and repository activation (`updateConnectionStatus(..., 'active')`).
- Constructs payload with `repositoryId`, `snapshotId`, `commitSha`, and `ref`.
- Generates deterministic idempotency key via `repositoryIndexedIdempotencyKey(repositoryId, commitSha)`.
- Wired into `apps/workers/src/ingest/handler.ts` using `createEvent` from `@fluxora/db`.

---

## 4. API WebSocket Server & Tenant-Scoped Push (`apps/api`)

- **Route**: `GET /api/v1/ws` (Upgrade: websocket).
- **Authentication**: `apps/api/src/ws/auth.ts`:
  - Extracts Bearer token from:
    1. `Authorization: Bearer <token>` header
    2. Query param: `?token=<token>` or `?authorization=Bearer%20<token>`
    3. `Sec-WebSocket-Protocol: bearer.<token>`
  - Authenticates via Clerk (`authenticateClerkToken`).
  - Rejects unauthenticated connections or invalid sessions with HTTP 401 before completing WebSocket handshake.
- **Connection Hub**: `apps/api/src/ws/hub.ts` (`WebSocketHub`):
  - Maintains `Map<organizationId, Set<ClientConnection>>`.
  - Strict isolation: `broadcast(envelope)` only sends the event to sockets registered under `envelope.organization_id`.
- **Database Listener**: `apps/api/src/ws/listener.ts` (`PostgresEventListener`):
  - Uses `pg.Client` to issue `LISTEN fluxora_events`.
  - Parses notification payload and invokes `WebSocketHub.broadcast(envelope)`.
- **Server Integration**: `apps/api/src/http/server.ts`:
  - Hooks `setupWebSocketServer` onto the API HTTP server.

---

## 5. Minimal Frontend Handling (`apps/web`)

- `apps/web/src/events/repository-events.ts`:
  - Pure function `handleRepositoryIndexedMessage(data)` that safely parses incoming JSON and validates `event_type === "repository.indexed"` with payload schema checks.
- `apps/web/src/app/dashboard/repository-indexed-feed.tsx`:
  - Client component establishing authenticated WebSocket connection to `/api/v1/ws` with Clerk `getToken()`.
  - Appends incoming `repository.indexed` events to a live activity feed.
- Mounted in `apps/web/src/app/dashboard/page.tsx`.

---

## 6. Verification & Test Coverage

- `packages/db/src/repositories/event.test.ts`:
  - Validates RLS tenant isolation on `events` table.
  - Validates event creation and idempotency key deduplication.
  - Validates real PostgreSQL `LISTEN`/`NOTIFY` trigger firing and reception.
- `apps/workers/src/ingest/ingest.test.ts`:
  - Validates worker emits `repository.indexed` event with correct payload and idempotency key on success.
- `apps/api/src/ws/ws.test.ts`:
  - Validates token extraction from headers, queries, and protocols.
  - Validates WebSocketHub tenant isolation.
  - Integration test: unauthenticated handshake rejected (401), invalid token rejected (401), valid clients connect, receive initial `connection.ready`, ping-pong responds, and org-isolated `repository.indexed` event broadcast delivers to tenant client only.
- `apps/web/src/events/repository-events.test.ts`:
  - Validates parsing valid envelopes, rejecting non-indexed events, and gracefully handling malformed JSON.

