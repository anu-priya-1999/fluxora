# 8. Event Schema

## 8.1 Transport decision

**MVP: Postgres-backed outbox table + `LISTEN`/`NOTIFY` for in-process fanout, consumed by the same job-queue worker fleet.** Not Kafka on day one. Kafka/managed pub-sub (SNS/SQS, Google Pub/Sub) becomes justified once: (a) event volume exceeds what a single Postgres instance's `NOTIFY` channel can comfortably fan out, or (b) external consumers outside Fluxora's own services need to subscribe (e.g., a customer's own Slack/webhook integration listening for `impact.analysis.completed`), which argues for a durable, replayable, externally-exposed event log rather than transient Postgres notifications.

Every event is also written durably to an `events` table (the outbox) regardless of transport, so replay/audit is always possible even before a dedicated bus is introduced.

## 8.2 Event catalog

| Event | Producer | Payload (key fields) | Consumers |
|---|---|---|---|
| `repository.connected` | API | `repository_id, organization_id, connected_by_user_id` | Audit log, onboarding analytics |
| `repository.indexed` | Ingestion Worker | `repository_id, snapshot_id, commit_sha` | Triggers `analysis.started`, WS→UI |
| `snapshot.created` | Ingestion Worker | `snapshot_id, repository_id, file_count, size_bytes` | Analysis scheduler |
| `analysis.started` | Analysis Worker | `analysis_run_id, snapshot_id` | WS→UI (progress) |
| `analysis.completed` | Analysis Worker | `analysis_run_id, status, coverage_summary, graph_summary` | Triggers `graph.updated`, WS→UI |
| `analysis.failed` | Analysis Worker | `analysis_run_id, error_code, error_message` | Alerting, WS→UI |
| `graph.updated` | Graph Builder | `analysis_run_id, repository_id, node_delta, edge_delta` | Search reindex, WS→UI, cache invalidation |
| `pr.created` | GitHub Webhook Handler | `pull_request_id, repository_id, changed_files` | Triggers `impact.analysis.started` |
| `pr.updated` | GitHub Webhook Handler | `pull_request_id, changed_files` | Triggers re-run of impact analysis |
| `impact.analysis.started` | API/Impact Worker | `impact_analysis_id, pull_request_id, analysis_run_id` | WS→UI |
| `impact.analysis.completed` | Impact Worker | `impact_analysis_id, direct_count, downstream_count, truncated` | Triggers `ai.analysis.started`, WS→UI, (future) webhook to customer's Slack/GitHub-check |
| `simulation.started` | API/Simulation Worker | `simulation_id, scenario_id` | WS→UI |
| `simulation.completed` | Simulation Worker | `simulation_id, node_states_summary` | Triggers `ai.analysis.started`, WS→UI |
| `ai.analysis.started` | AI Worker | `ai_analysis_id, subject_type, subject_id, model` | WS→UI |
| `ai.analysis.completed` | AI Worker | `ai_analysis_id, validation_status, token_count, cost_usd, latency_ms` | WS→UI, cost dashboards |
| `ai.analysis.failed` | AI Worker | `ai_analysis_id, error_code` | Alerting, WS→UI ("explanation unavailable") |

## 8.3 Example payload (full envelope)

```json
{
  "event_id": "evt_a91f...",
  "event_type": "impact.analysis.completed",
  "organization_id": "org_112...",
  "occurred_at": "2026-09-25T09:14:02Z",
  "idempotency_key": "impact_analysis_id:impact_44a1...:completed",
  "payload": {
    "impact_analysis_id": "impact_44a1...",
    "pull_request_id": "pr_7781...",
    "direct_count": 1,
    "downstream_count": 3,
    "truncated": false
  },
  "schema_version": 1
}
```

## 8.4 Delivery semantics

- **Ordering:** Guaranteed only *within* a single entity's lifecycle (e.g., `analysis.started` always precedes `analysis.completed` for the same `analysis_run_id`), enforced by the producing worker emitting events strictly after the corresponding state transition commits — not by a global ordering guarantee across all events, which the outbox model doesn't provide and the product doesn't need.
- **Delivery guarantee:** At-least-once. All consumers must be idempotent — enforced via `idempotency_key` uniqueness constraint on the consumer side (e.g., a WS-fanout consumer dedupes on `event_id`; a job-triggering consumer dedupes on `idempotency_key`).
- **Retries:** Consumer-side processing failures retry with exponential backoff (base 1s, cap 60s, max 5 attempts) before dead-lettering to a `failed_events` table with an alert.
- **Dead-letter handling:** Dead-lettered events are visible in an internal admin view; manual or scripted replay is supported by re-inserting into the outbox with a fresh `event_id` but the same `idempotency_key`.
- **Consistency model:** Outbox write happens in the *same database transaction* as the state change it describes (classic transactional outbox pattern) — this is what prevents the "job succeeded but event never fired" class of bug.
- **Deduplication:** Every consumer table that reacts to events has a unique constraint on `(idempotency_key, consumer_name)` so replays and at-least-once redelivery are safe no-ops on the second delivery.

## 8.5 Future: external event delivery

When customer-facing webhooks or a real message bus are introduced (Phase 10+), the outbox table becomes the natural source for a Kafka Connect / Debezium-style CDC pipeline, or a scheduled outbox-relay worker publishing to SNS/SQS — the schema above does not change, only the transport layer underneath the existing `events` table does.
