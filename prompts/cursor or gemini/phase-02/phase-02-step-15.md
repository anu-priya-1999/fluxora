Implement Fluxora Global Step 15 only.

Scope:
`repository.indexed` event + authenticated WebSocket push to the frontend.

First inspect the current Step 13/14 implementation and the relevant Phase 2/event/API architecture docs.

Implement only:
- typed `repository.indexed` event
- durable tenant-scoped PostgreSQL events/outbox with RLS + idempotency
- emit event after successful snapshot persistence and repository activation
- PostgreSQL LISTEN/NOTIFY delivery
- authenticated `/api/v1/ws` using the existing Clerk auth model
- organization-scoped event delivery
- minimal frontend handling of `repository.indexed`
- focused Node `node:test` coverage

Do NOT:
- implement Step 16 failure paths
- migrate tests to Vitest
- add Kafka, Redis, Socket.IO
- implement graph/analysis/AI events
- refactor unrelated code

Learning/documentation is REQUIRED:
- add Step 15 learning notes in `learning/`
- update the Fluxora DESIGN documentation for Step 15
- add concise Step 15 implementation/interview notes following the existing documentation pattern

After implementation:
- run only the focused Step 15 tests
- fix failures
- do NOT run the full repository verification yet

Report:
- exact files changed
- migration name
- event flow
- WebSocket/auth flow
- tests run/results
- learning/design/interview files added or updated