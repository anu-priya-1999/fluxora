# Step 22 — Event Producer / Consumer Pattern Detection

## Objective

Implement **Fluxora Global Step 22: Event Producer / Consumer Pattern Detection** (`docs/architecture/05-component-responsibilities.md §5.5`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 5`).

While prior milestones established:
- **Step 18**: *"What programming languages and frameworks exist?"*
- **Step 19**: *"What symbols exist in individual files?"*
- **Step 20**: *"How are modules statically connected through imports and exports?"*
- **Step 21**: *"What HTTP API routes and Express routers are defined?"*

Step 22 answers:
> *"Where are event producers (publish/emit) and consumers (subscribe/on/consume) invoked across the codebase, and what event/topic/channel/queue identifiers do they target?"*

Given an immutable repository snapshot, Step 22 statically, safely, and deterministically:
1. Inspects source files using TypeScript Compiler API AST traversal.
2. Identifies pub/sub patterns across 4 initial, deliberately small ecosystems:
   - **Node.js EventEmitter** (`emit`, `on`, `once`, `addListener`, including subclassed `this.emit`).
   - **Redis Pub/Sub** (`publish`, `subscribe`, `pSubscribe`).
   - **KafkaJS** (`producer.send`, `consumer.subscribe`, `consumer.run({ eachMessage })`, `consumer.run({ eachBatch })`).
   - **RabbitMQ / amqplib** (`channel.publish`, `channel.sendToQueue`, `channel.consume`).
3. Enforces strict provenance tracking to prevent false positives from arbitrary user objects named `emitter`, `client`, `publisher`, `socket`, etc.
4. Statically extracts string literals and no-substitution template literals.
5. Safely marks dynamic, computed, or non-literal expressions as `unresolved` (`null` eventName) without executing customer code.
6. Emits deterministic, reproducible results with stable IDs, source locations, and explanatory evidence strings.

Step 22 is **extraction only**. It does not construct graph edges, build GraphNode/GraphEdge database rows, or persist to PostgreSQL (Phase 4).

---

## 1. Architectural Position & Invariants

### Deterministic Core vs. Probabilistic AI Edge
Event pattern detection is a deterministic code intelligence pass:
- **Zero LLM Dependency**: Event detection, role classification, and topic extraction never invoke an LLM.
- **Untrusted Input Guarantee**: Customer repository code is untrusted. Handlers, brokers, emitters, and connectors are **never executed, evaluated, or imported**.
- **Pure AST Provenance**: Call sites are only matched when their variable or class provenance is proven to originate from known library imports or class extensions.
- **Strict Evidence Trail**: Every detected pattern includes 1-based line/column numbers, 0-based character offsets, and an explanatory human-readable evidence sentence.

### Strict Scope Boundary
- **Step 22** is strictly limited to the 4 explicit ecosystems above.
- **Step 23** will implement database/ORM reference detection.
- **Step 24** will implement tree-sitter fallback parsing.
- **Step 25** will implement symbol normalization and barrel collapsing.
- **Phase 4** persists nodes, edges, and evidence to PostgreSQL (`GraphNode`, `GraphEdge`, `Evidence`). Step 22 produces pure in-memory contracts.

---

## 2. Shared Type Contracts (`@fluxora/shared-types`)

Event pattern contracts are defined in `packages/shared-types/src/event-patterns.ts` (keeping Fluxora's own event envelope contracts in `events.ts` untouched):

- `RepositoryEventPatternRole`: `"producer" | "consumer"`
- `RepositoryEventPatternFamily`:
  - `"node_event_emitter"`
  - `"redis_pubsub"`
  - `"kafkajs"`
  - `"rabbitmq_amqplib"`
- `RepositoryEventMethodShape`:
  - `"emit" | "on" | "once" | "addListener"`
  - `"publish" | "subscribe" | "pSubscribe"`
  - `"kafka_send" | "kafka_subscribe" | "kafka_each_message" | "kafka_each_batch"`
  - `"amqp_publish" | "amqp_send_to_queue" | "amqp_consume"`
- `RepositoryEventIdentifierStatus`: `"resolved" | "unresolved"`
- `RepositoryEventPatternDetails`:
  - `eventName`: `string | null`
  - `status`: `RepositoryEventIdentifierStatus`
  - `exchange?`: `string | null | undefined`
  - `routingKey?`: `string | null | undefined`
  - `handlerSymbol?`: `string | undefined`
  - `receiverSymbol?`: `string | undefined`
- `RepositoryEventPattern`:
  - `id`: `${filePath}#${role}:${family}:${methodShape}:${sourceLocation.start.offset}`
  - `role`: `RepositoryEventPatternRole`
  - `family`: `RepositoryEventPatternFamily`
  - `methodShape`: `RepositoryEventMethodShape`
  - `filePath`: relative path in repository
  - `details`: `RepositoryEventPatternDetails`
  - `sourceLocation`: `SourceLocation`
  - `evidence`: `string`
- `RepositoryEventPatternDetectionResult`:
  - `producers`: `readonly RepositoryEventPattern[]`
  - `consumers`: `readonly RepositoryEventPattern[]`
  - `diagnostics`: `readonly RepositoryEventPatternDiagnostic[]`
  - `counts`: `RepositoryEventPatternCounts`

---

## 3. Supported Patterns & Ecosystem Rules

### 1. Node.js EventEmitter
- **Provenance**:
  - `import { EventEmitter } from "events"`, `import { EventEmitter } from "node:events"`, or `require("events")`.
  - Instances: `const emitter = new EventEmitter()`.
  - Subclasses: `class OrderBus extends EventEmitter { ... }`.
- **Producers**:
  - `emitter.emit("event", ...)` or `this.emit("event", ...)` inside subclass.
- **Consumers**:
  - `emitter.on("event", handler)`
  - `emitter.once("event", handler)`
  - `emitter.addListener("event", handler)`

### 2. Redis Pub/Sub
- **Provenance**:
  - `import { createClient } from "redis"`, `import Redis from "ioredis"`, or `require("redis")`.
  - Instances: `createClient()`, `new Redis()`.
- **Producers**:
  - `client.publish("channel", message)`
- **Consumers**:
  - `client.subscribe("channel", handler)`
  - `client.pSubscribe("pattern", handler)`

### 3. KafkaJS
- **Provenance**:
  - `import { Kafka } from "kafkajs"` or `require("kafkajs")`.
  - Clients: `const kafka = new Kafka(...)`.
  - Producers: `kafka.producer()`.
  - Consumers: `kafka.consumer(...)`.
- **Producers**:
  - `producer.send({ topic: "...", messages: [...] })` (extracts literal topic).
- **Consumers**:
  - `consumer.subscribe({ topic: "..." })` (extracts literal topic).
  - `consumer.run({ eachMessage: ... })` (marks consumer handler).
  - `consumer.run({ eachBatch: ... })` (marks batch consumer handler).

### 4. RabbitMQ / amqplib
- **Provenance**:
  - `import amqp from "amqplib"` or `require("amqplib")`.
  - Connections: `amqp.connect(...)`.
  - Channels: `conn.createChannel()`.
- **Producers**:
  - `channel.publish(exchange, routingKey, content)` (extracts exchange and routing key).
  - `channel.sendToQueue(queue, content)` (extracts queue name).
- **Consumers**:
  - `channel.consume(queue, handler)` (extracts queue name and handler callback).

---

## 4. Provenance Rules & False-Positive Prevention

In modern JavaScript/TypeScript codebases, common identifiers such as `socket.emit()`, `blog.publish()`, or `queue.consume()` are pervasive across unrelated modules (web sockets, UI components, CMS platforms, generators).

Fluxora prevents false positives through a two-pass AST approach:
1. **Pass 1 — Scope & Provenance Discovery**: Scans imports, `require()` calls, class inheritance clauses, variable instantiations, and method factory chains to populate confirmed variable sets.
2. **Pass 2 — Call Site Inspection**: Inspects method calls against proven variables. Unrelated calls (e.g. `socket.emit("chat")` without EventEmitter provenance, `post.publish()` without Redis provenance) are strictly ignored.
3. **No Execution Guarantee**: Identifiers are resolved statically without runtime evaluation or `eval()`. Non-literal or dynamically calculated event expressions safely become `null` (`status: "unresolved"`).

---

## 5. Verification & Testing

The implementation was validated against:
- **Focused Unit Tests (`apps/workers/src/events/detector.test.ts`)**: 25 tests covering all 4 ecosystems, literal string extractions, template literals, dynamic expression handling, false-positive rejections, deterministic ordering/IDs, class inheritance, synthetic multi-file repositories, and the shadcn taxonomy golden fixture.
- **Golden Fixture Scan**: 0 false positives across the real-world Next.js taxonomy codebase.
- **Repository-Wide Verification**:
  - `pnpm lint`: Pass (0 errors).
  - `pnpm typecheck`: Pass (all workspace projects clean).
  - `pnpm test`: Pass (145 tests passing).
  - `pnpm build`: Pass (production build successful).

