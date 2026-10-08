Implement ONLY Fluxora Global Step 22 — Event Producer / Consumer Pattern Detection.

Repository:
anu-priya-1999/fluxora

Current Phase:
Phase 3 — Code Intelligence

Previous completed steps:
18 — language/framework detection
19 — per-file symbol extraction
20 — import/export graph extraction + tsconfig path aliases
21 — Next.js API route + Express router detection

Roadmap definition for Step 22:
“Implement event producer/consumer pattern detection (common pub/sub client call shapes) — start with a small, explicit pattern library, expand iteratively.”

IMPORTANT:
Before editing anything, inspect the current repository implementation, especially:
- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- packages/shared-types/src/index.ts
- packages/shared-types/src/modules.ts
- packages/shared-types/src/routes.ts
- apps/workers/src/modules/*
- apps/workers/src/routes/*
- the existing golden fixture and its manifest
- existing tests and naming conventions from Steps 18–21

Preserve the existing architecture and result shapes where appropriate.

## Goal

Add a deterministic, static AST-based event producer/consumer detector for TypeScript/JavaScript source files.

This is CODE INTELLIGENCE over a target repository snapshot.

It must:
- inspect source code statically
- never execute target code
- produce deterministic results
- include source/evidence locations
- distinguish producer vs consumer
- capture the event/topic/channel/queue name when statically knowable
- represent dynamic/unknown names explicitly rather than guessing

## Initial pattern library

Keep the pattern library intentionally SMALL and explicit.

Support these initial ecosystems:

### 1. Node.js EventEmitter-style patterns
Producer:
- `emitter.emit("event")`

Consumers:
- `emitter.on("event", handler)`
- `emitter.once("event", handler)`
- `emitter.addListener("event", handler)`

Also support statically identifiable imported/class-based EventEmitter usage where provenance can be established without executing code.

### 2. Redis pub/sub
Producer:
- `publish("channel", ...)`

Consumer:
- `subscribe("channel", ...)`
- `pSubscribe("pattern", ...)`

Recognize common Redis client call shapes only when the receiver/import provenance is reasonably identifiable.

### 3. KafkaJS
Producer:
- `producer.send({ topic: "...", ... })`
- relevant clearly static producer send shape

Consumer:
- `consumer.subscribe({ topic: "..." })`
- `consumer.run({ eachMessage: ... })`
- `consumer.run({ eachBatch: ... })`

Capture topic when statically available.

### 4. RabbitMQ / amqplib
Producer:
- `channel.publish(exchange, routingKey, ...)`
- `channel.sendToQueue(queue, ...)`

Consumer:
- `channel.consume(queue, ...)`

Capture exchange/routing key/queue when statically available.

Do NOT add a large framework matrix.
Do NOT add AWS SNS/SQS, Google Pub/Sub, BullMQ, NATS, Socket.io, custom event buses, etc. in this step unless the existing architecture already requires one of them. Keep Step 22 deliberately small.

## Detection model

Create a new shared contract file, preferably:

packages/shared-types/src/event-patterns.ts

Do NOT repurpose packages/shared-types/src/events.ts because that file already defines Fluxora's own durable application event envelope/contracts.

Define a deterministic result model containing enough information for later graph construction, for example:

- kind: producer | consumer
- library/pattern family
- event/topic/channel/queue identifier when statically known
- source file
- line / column or source range consistent with existing detectors
- stable deterministic id
- confidence/status for static certainty if consistent with existing result conventions
- useful metadata such as method/call shape

Use the naming and structural conventions already established by Steps 19–21 rather than inventing an unrelated data model.

## Static provenance / false-positive rules

Be conservative.

Do NOT label arbitrary calls such as:

`foo.emit("x")`
`client.publish("x")`
`channel.sendToQueue("jobs")`

as supported event infrastructure merely because the method name matches.

Where possible, require provenance from:
- known imports
- known constructors/classes
- recognizable library module names
- known local aliases derived from those imports

For plain generic EventEmitter-style objects, only infer when there is enough static evidence.

Never execute imports, resolve runtime values, evaluate arbitrary expressions, or run the target repository.

## Static event names

Resolve only values that are statically safe and deterministic, such as:
- string literals
- no-substitution template literals
- simple const bindings when already supported by the repository's existing static-analysis conventions

For dynamic expressions such as:

emit(eventName)
publish(channel)
sendToQueue(getQueueName())

do not guess.

Represent the identifier as unresolved/dynamic according to the chosen contract.

## Output requirements

The detector should return:
- deterministic ordering
- deterministic IDs
- producers and consumers separately identifiable
- event/topic/channel/queue identity when known
- unresolved identity when dynamic
- source evidence sufficient for debugging and future graph edges

Do not build a graph database.
Do not create GraphNode/GraphEdge tables.
Do not connect producer and consumer nodes across the repository yet.

Step 22 is extraction only.

## Integration

Add the detector to the existing worker/code-intelligence structure consistently with:
- detect/
- symbols/
- modules/
- routes/

Update exports through the existing package indexes.

Do not break the existing internal Fluxora event contracts in packages/shared-types/src/events.ts.

## Tests

Add focused unit tests covering at minimum:

1. EventEmitter producer
2. EventEmitter consumer via `on`
3. EventEmitter consumer via `once`
4. EventEmitter consumer via `addListener`
5. Redis publish
6. Redis subscribe
7. Redis pSubscribe
8. KafkaJS producer
9. KafkaJS consumer subscribe
10. KafkaJS eachMessage / eachBatch consumer
11. RabbitMQ publish
12. RabbitMQ sendToQueue
13. RabbitMQ consume
14. static literal event/topic/channel/queue extraction
15. no-substitution template literal extraction
16. dynamic identifier marked unresolved
17. unrelated `.emit()` false positive rejection
18. unrelated `.publish()` false positive rejection
19. unrelated `.consume()` false positive rejection
20. deterministic ordering / deterministic IDs

Add representative Step 22 fixtures without modifying the semantics of previous fixtures.

If the existing golden repository does not naturally contain enough event patterns, create a small dedicated synthetic event fixture rather than fabricating detections in the real golden repo.

## Verification

Run and report:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run the focused event-pattern tests explicitly.

Do not modify unrelated files.

## Documentation

Create:

learning/implementations/phase-03/step-22-event-producer-consumer-detection.md
learning/notes/21. Event Producer and Consumer Pattern Detection.md
learning/interviews/22. Step 22 Event Producer Consumer Detection Interview CheatSheet.md

Update docs/DESIGN.md by adding the Step 22 architecture/details without deleting existing content.

Documentation must clearly state:
- supported event systems
- producer vs consumer semantics
- provenance rules
- static-only analysis
- unresolved dynamic identifiers
- false-positive strategy
- deterministic output
- explicit Step 23+ boundary

## Strict scope boundary

DO NOT implement:
- database/ORM detection (Step 23)
- tree-sitter fallback (Step 24)
- normalization/barrel resolution/dedup (Step 25)
- full Phase 3 pipeline verification (Step 26)
- GraphNode/GraphEdge/Evidence database work (Phase 4 / Step 27+)
- AI/LLM analysis
- UI work
- runtime instrumentation
- event execution or simulation
- cross-language event analysis beyond what the existing TypeScript/JavaScript analysis architecture supports

At the end, provide:
1. files created
2. files modified
3. supported detection patterns
4. test counts/results
5. lint/typecheck/test/build results
6. any limitations
7. exact recommended commit message

Do not refactor unrelated code.
Do not broaden Step 22 beyond the explicit event-pattern library above.