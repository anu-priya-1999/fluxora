import test from "node:test";
import assert from "node:assert/strict";

import {
  detectRepositoryEventPatterns,
  type RepositoryEventPatternDetectionInput,
} from "./detector.ts";
import {
  loadGoldenFixtureManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";

test("1. EventEmitter producer: detects emitter.emit('event')", () => {
  const code = `
import { EventEmitter } from "events";
const emitter = new EventEmitter();
emitter.emit("order.created", { id: 123 });
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/events.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  const producer = result.producers[0];
  assert.ok(producer);
  assert.equal(producer.role, "producer");
  assert.equal(producer.family, "node_event_emitter");
  assert.equal(producer.methodShape, "emit");
  assert.equal(producer.details.eventName, "order.created");
  assert.equal(producer.details.status, "resolved");
  assert.equal(producer.details.receiverSymbol, "emitter");
  assert.equal(producer.filePath, "src/events.ts");
});

test("2. EventEmitter consumer via on: detects emitter.on('event', handler)", () => {
  const code = `
import { EventEmitter } from "node:events";
const emitter = new EventEmitter();
function handleOrder(order) {}
emitter.on("order.created", handleOrder);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/subscriber.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "node_event_emitter");
  assert.equal(consumer.methodShape, "on");
  assert.equal(consumer.details.eventName, "order.created");
  assert.equal(consumer.details.status, "resolved");
  assert.equal(consumer.details.handlerSymbol, "handleOrder");
});

test("3. EventEmitter consumer via once: detects emitter.once('event', handler)", () => {
  const code = `
const { EventEmitter } = require("events");
const emitter = new EventEmitter();
emitter.once("init", () => {});
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/init.js", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "node_event_emitter");
  assert.equal(consumer.methodShape, "once");
  assert.equal(consumer.details.eventName, "init");
  assert.equal(consumer.details.status, "resolved");
  assert.equal(consumer.details.handlerSymbol, "anonymous");
});

test("4. EventEmitter consumer via addListener: detects emitter.addListener('event', handler)", () => {
  const code = `
import EventEmitter from "events";
const emitter = new EventEmitter();
emitter.addListener("data", onData);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/listener.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "node_event_emitter");
  assert.equal(consumer.methodShape, "addListener");
  assert.equal(consumer.details.eventName, "data");
  assert.equal(consumer.details.status, "resolved");
  assert.equal(consumer.details.handlerSymbol, "onData");
});

test("5. Redis publish: detects client.publish('channel', ...)", () => {
  const code = `
import { createClient } from "redis";
const client = createClient();
await client.publish("notifications", JSON.stringify({ msg: "hello" }));
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/redis-pub.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  const producer = result.producers[0];
  assert.ok(producer);
  assert.equal(producer.role, "producer");
  assert.equal(producer.family, "redis_pubsub");
  assert.equal(producer.methodShape, "publish");
  assert.equal(producer.details.eventName, "notifications");
  assert.equal(producer.details.status, "resolved");
  assert.equal(producer.details.receiverSymbol, "client");
});

test("6. Redis subscribe: detects client.subscribe('channel', ...)", () => {
  const code = `
import Redis from "ioredis";
const redis = new Redis();
redis.subscribe("chat-room", (err) => {});
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/redis-sub.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "redis_pubsub");
  assert.equal(consumer.methodShape, "subscribe");
  assert.equal(consumer.details.eventName, "chat-room");
  assert.equal(consumer.details.status, "resolved");
});

test("7. Redis pSubscribe: detects client.pSubscribe('pattern', ...)", () => {
  const code = `
import { createClient } from "redis";
const client = createClient();
await client.pSubscribe("user.*", onMessage);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/redis-psub.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "redis_pubsub");
  assert.equal(consumer.methodShape, "pSubscribe");
  assert.equal(consumer.details.eventName, "user.*");
  assert.equal(consumer.details.status, "resolved");
  assert.equal(consumer.details.handlerSymbol, "onMessage");
});

test("8. KafkaJS producer: detects producer.send({ topic: '...', messages: [...] })", () => {
  const code = `
import { Kafka } from "kafkajs";
const kafka = new Kafka({ clientId: "my-app", brokers: ["localhost:9092"] });
const producer = kafka.producer();
await producer.send({
  topic: "telemetry",
  messages: [{ value: "ping" }]
});
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/kafka-producer.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  const producer = result.producers[0];
  assert.ok(producer);
  assert.equal(producer.role, "producer");
  assert.equal(producer.family, "kafkajs");
  assert.equal(producer.methodShape, "kafka_send");
  assert.equal(producer.details.eventName, "telemetry");
  assert.equal(producer.details.status, "resolved");
});

test("9. KafkaJS consumer subscribe: detects consumer.subscribe({ topic: '...' })", () => {
  const code = `
import { Kafka } from "kafkajs";
const kafka = new Kafka({ clientId: "my-app", brokers: ["localhost:9092"] });
const consumer = kafka.consumer({ groupId: "test-group" });
await consumer.subscribe({ topic: "events-stream" });
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/kafka-sub.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "kafkajs");
  assert.equal(consumer.methodShape, "kafka_subscribe");
  assert.equal(consumer.details.eventName, "events-stream");
  assert.equal(consumer.details.status, "resolved");
});

test("10. KafkaJS eachMessage / eachBatch consumer: detects consumer.run({ eachMessage: ... })", () => {
  const code = `
import { Kafka } from "kafkajs";
const kafka = new Kafka({ clientId: "my-app", brokers: ["localhost:9092"] });
const consumer = kafka.consumer({ groupId: "workers" });
await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {}
});
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/kafka-run.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "kafkajs");
  assert.equal(consumer.methodShape, "kafka_each_message");
  assert.equal(consumer.details.status, "unresolved");
  assert.equal(consumer.details.handlerSymbol, "anonymous");
});

test("11. RabbitMQ publish: detects channel.publish(exchange, routingKey, ...)", () => {
  const code = `
import amqp from "amqplib";
const conn = await amqp.connect("amqp://localhost");
const channel = await conn.createChannel();
channel.publish("amq.topic", "orders.eu.created", Buffer.from("data"));
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/amqp-pub.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  const producer = result.producers[0];
  assert.ok(producer);
  assert.equal(producer.role, "producer");
  assert.equal(producer.family, "rabbitmq_amqplib");
  assert.equal(producer.methodShape, "amqp_publish");
  assert.equal(producer.details.eventName, "orders.eu.created");
  assert.equal(producer.details.exchange, "amq.topic");
  assert.equal(producer.details.routingKey, "orders.eu.created");
  assert.equal(producer.details.status, "resolved");
});

test("12. RabbitMQ sendToQueue: detects channel.sendToQueue(queue, ...)", () => {
  const code = `
import amqp from "amqplib";
const connection = await amqp.connect("amqp://localhost");
const ch = await connection.createChannel();
ch.sendToQueue("task_queue", Buffer.from("work"));
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/amqp-send.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  const producer = result.producers[0];
  assert.ok(producer);
  assert.equal(producer.role, "producer");
  assert.equal(producer.family, "rabbitmq_amqplib");
  assert.equal(producer.methodShape, "amqp_send_to_queue");
  assert.equal(producer.details.eventName, "task_queue");
  assert.equal(producer.details.status, "resolved");
});

test("13. RabbitMQ consume: detects channel.consume(queue, handler)", () => {
  const code = `
import amqp from "amqplib";
const conn = await amqp.connect("amqp://localhost");
const channel = await conn.createChannel();
channel.consume("task_queue", processTask);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/amqp-consume.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.consumers.length, 1);
  const consumer = result.consumers[0];
  assert.ok(consumer);
  assert.equal(consumer.role, "consumer");
  assert.equal(consumer.family, "rabbitmq_amqplib");
  assert.equal(consumer.methodShape, "amqp_consume");
  assert.equal(consumer.details.eventName, "task_queue");
  assert.equal(consumer.details.status, "resolved");
  assert.equal(consumer.details.handlerSymbol, "processTask");
});

test("14. Static literal event/topic/channel/queue extraction", () => {
  const code = `
import { EventEmitter } from "events";
const emitter = new EventEmitter();
emitter.emit("exact-literal-name");
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/literal.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  assert.equal(result.producers[0]?.details.eventName, "exact-literal-name");
  assert.equal(result.producers[0]?.details.status, "resolved");
});

test("15. No-substitution template literal extraction", () => {
  const code = `
import { EventEmitter } from "events";
const emitter = new EventEmitter();
emitter.emit(\`template-literal-event\`);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/template.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  assert.equal(result.producers[0]?.details.eventName, "template-literal-event");
  assert.equal(result.producers[0]?.details.status, "resolved");
});

test("16. Dynamic identifier marked unresolved", () => {
  const code = `
import { EventEmitter } from "events";
const emitter = new EventEmitter();
const eventName = getDynamicName();
emitter.emit(eventName);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/dynamic.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  assert.equal(result.producers[0]?.details.eventName, null);
  assert.equal(result.producers[0]?.details.status, "unresolved");
});

test("17. Unrelated .emit() false positive rejection", () => {
  const code = `
// Arbitrary object with emit method, no EventEmitter imported
const socket = {
  emit: (event, data) => {}
};
socket.emit("chat", "hello");

const customObj = new CustomClass();
customObj.emit("custom", 123);
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/fake-emitter.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 0);
  assert.equal(result.consumers.length, 0);
});

test("18. Unrelated .publish() false positive rejection", () => {
  const code = `
// Arbitrary blog/content publisher, no redis or pubsub imported
const postPublisher = {
  publish: (articleId) => console.log(articleId)
};
postPublisher.publish("my-first-post");
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/fake-publish.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 0);
  assert.equal(result.consumers.length, 0);
});

test("19. Unrelated .consume() false positive rejection", () => {
  const code = `
// Arbitrary iterator consumer, no amqplib imported
const iterator = {
  consume: (source) => source()
};
iterator.consume(() => "done");
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/fake-consume.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 0);
  assert.equal(result.consumers.length, 0);
});

test("20. Deterministic ordering and deterministic IDs", () => {
  const file1 = `
import { EventEmitter } from "events";
const emitter = new EventEmitter();
emitter.emit("b_event");
emitter.emit("a_event");
`;
  const file2 = `
import { createClient } from "redis";
const client = createClient();
client.publish("alpha", "1");
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([
      ["src/z_file.ts", file1],
      ["src/a_file.ts", file2],
    ]),
  };

  const result1 = detectRepositoryEventPatterns(input);
  const result2 = detectRepositoryEventPatterns(input);

  // Deep equality verification
  assert.deepEqual(result1, result2);

  // Verifies sorting: a_file.ts comes before z_file.ts
  assert.equal(result1.producers.length, 3);
  assert.equal(result1.producers[0]?.filePath, "src/a_file.ts");
  assert.equal(result1.producers[1]?.filePath, "src/z_file.ts");
  assert.equal(result1.producers[2]?.filePath, "src/z_file.ts");

  // Offset ordering within file
  assert.ok(
    (result1.producers[1]?.sourceLocation.start.offset ?? 0) <
      (result1.producers[2]?.sourceLocation.start.offset ?? 0),
  );

  // Verified deterministic ID format
  assert.ok(result1.producers[0]?.id.startsWith("src/a_file.ts#producer:redis_pubsub:publish:"));
});

test("21. EventEmitter class inheritance: detects this.emit in subclass", () => {
  const code = `
import { EventEmitter } from "events";

class OrderBus extends EventEmitter {
  processOrder(orderId: string) {
    this.emit("order.processed", orderId);
  }
}
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/bus.ts", code]]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 1);
  const producer = result.producers[0];
  assert.ok(producer);
  assert.equal(producer.role, "producer");
  assert.equal(producer.family, "node_event_emitter");
  assert.equal(producer.details.eventName, "order.processed");
  assert.equal(producer.details.status, "resolved");
});

test("22. Ignored paths are skipped", () => {
  const code = `
import { EventEmitter } from "events";
const emitter = new EventEmitter();
emitter.emit("ignored.event");
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([
      ["node_modules/pkg/index.ts", code],
      [".next/types/route.ts", code],
    ]),
  };
  const result = detectRepositoryEventPatterns(input);

  assert.equal(result.producers.length, 0);
  assert.equal(result.consumers.length, 0);
});

test("23. Malformed syntax handling records diagnostic gracefully", () => {
  const malformed = `
import { EventEmitter } from "events"
const emitter = new EventEmitter(
`;
  const input: RepositoryEventPatternDetectionInput = {
    files: new Map([["src/malformed.ts", malformed]]),
  };
  // Should not throw
  const result = detectRepositoryEventPatterns(input);
  assert.ok(result);
});

test("24. Synthetic multi-file event repository fixture detects all pattern families", () => {
  const syntheticRepoFiles = new Map<string, string>([
    [
      "src/bus/emitter.ts",
      `import { EventEmitter } from "events";
export const bus = new EventEmitter();
bus.emit("user.signup", { userId: "u1" });
`,
    ],
    [
      "src/bus/listener.ts",
      `import { bus } from "./emitter";
import { EventEmitter } from "events";
const localEmitter = new EventEmitter();
localEmitter.on("user.signup", (payload) => console.log(payload));
`,
    ],
    [
      "src/queue/redis.ts",
      `import { createClient } from "redis";
const client = createClient();
await client.publish("jobs.high", "data");
await client.subscribe("jobs.high", (msg) => {});
`,
    ],
    [
      "src/streaming/kafka.ts",
      `import { Kafka } from "kafkajs";
const kafka = new Kafka({ clientId: "analytics", brokers: ["localhost:9092"] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "workers" });
await producer.send({ topic: "pageviews", messages: [{ value: "1" }] });
await consumer.subscribe({ topic: "pageviews" });
await consumer.run({ eachMessage: async ({ message }) => {} });
`,
    ],
    [
      "src/broker/rabbitmq.ts",
      `import amqp from "amqplib";
const connection = await amqp.connect("amqp://localhost");
const channel = await connection.createChannel();
channel.publish("events.exchange", "order.completed", Buffer.from("{}"));
channel.sendToQueue("audit_queue", Buffer.from("{}"));
channel.consume("audit_queue", (msg) => {});
`,
    ],
  ]);

  const result = detectRepositoryEventPatterns({ files: syntheticRepoFiles });

  assert.equal(result.counts.totalProducers, 5); // bus.emit, redis.publish, kafka.send, channel.publish, channel.sendToQueue
  assert.equal(result.counts.totalConsumers, 5); // localEmitter.on, redis.subscribe, kafka.subscribe, kafka.run(eachMessage), channel.consume
  assert.equal(result.counts.byFamily.node_event_emitter, 2);
  assert.equal(result.counts.byFamily.redis_pubsub, 2);
  assert.equal(result.counts.byFamily.kafkajs, 3);
  assert.equal(result.counts.byFamily.rabbitmq_amqplib, 3);
  assert.equal(result.diagnostics.length, 0);
});

test("25. Golden fixture scan safely runs and confirms zero false positives on Next.js taxonomy codebase", () => {
  const manifest = loadGoldenFixtureManifest();
  const files = new Map<string, string>();

  for (const entry of manifest.files) {
    if (
      entry.path.endsWith(".ts") ||
      entry.path.endsWith(".tsx") ||
      entry.path.endsWith(".js") ||
      entry.path.endsWith(".jsx")
    ) {
      files.set(entry.path, readGoldenFixtureFileText(entry.path));
    }
  }

  const result = detectRepositoryEventPatterns({ files });

  // Shadcn Taxonomy is a standard Next.js web application with no Kafka, Redis pubsub, RabbitMQ, or Node EventEmitter instances
  // Verifies that ordinary web app code does not trigger false positive event patterns
  assert.equal(result.producers.length, 0);
  assert.equal(result.consumers.length, 0);
  assert.equal(result.diagnostics.length, 0);
});
