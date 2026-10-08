import type { SourceLocation } from "./symbols.ts";

/**
 * Event communication role: producer (publishes/emits) vs consumer (subscribes/listens/consumes).
 */
export const RepositoryEventPatternRoles = ["producer", "consumer"] as const;
export type RepositoryEventPatternRole = (typeof RepositoryEventPatternRoles)[number];

/**
 * Supported pub/sub pattern families in Step 22.
 */
export const RepositoryEventPatternFamilies = [
  "node_event_emitter",
  "redis_pubsub",
  "kafkajs",
  "rabbitmq_amqplib",
] as const;
export type RepositoryEventPatternFamily = (typeof RepositoryEventPatternFamilies)[number];

/**
 * Detailed method or call shape recognized by the pattern detector.
 */
export const RepositoryEventMethodShapes = [
  // Node.js EventEmitter
  "emit",
  "on",
  "once",
  "addListener",
  // Redis pub/sub
  "publish",
  "subscribe",
  "pSubscribe",
  // KafkaJS
  "kafka_send",
  "kafka_subscribe",
  "kafka_each_message",
  "kafka_each_batch",
  // RabbitMQ / amqplib
  "amqp_publish",
  "amqp_send_to_queue",
  "amqp_consume",
] as const;
export type RepositoryEventMethodShape = (typeof RepositoryEventMethodShapes)[number];

/**
 * Deterministic status for whether the event / topic / channel / queue name was statically resolved.
 */
export const RepositoryEventIdentifierStatuses = ["resolved", "unresolved"] as const;
export type RepositoryEventIdentifierStatus = (typeof RepositoryEventIdentifierStatuses)[number];

/**
 * Specific semantic parameters extracted for the event pattern.
 */
export interface RepositoryEventPatternDetails {
  /**
   * The primary event, topic, channel, or queue name if statically knowable.
   * If unresolved/dynamic, this will be null.
   */
  readonly eventName: string | null;

  /**
   * Status indicating whether the event identifier was statically resolved or dynamic.
   */
  readonly status: RepositoryEventIdentifierStatus;

  /**
   * For AMQP publish: optional routing key if statically knowable.
   */
  readonly routingKey?: string | null | undefined;

  /**
   * For AMQP publish: optional exchange if statically knowable.
   */
  readonly exchange?: string | null | undefined;

  /**
   * Handler or callback function name or anonymous status if present.
   */
  readonly handlerSymbol?: string | undefined;

  /**
   * Provenance receiver or constructor symbol that identified this call.
   */
  readonly receiverSymbol?: string | undefined;
}

/**
 * Detected event producer or consumer pattern occurrence in a source file.
 */
export interface RepositoryEventPattern {
  /**
   * Deterministic unique identifier for this event pattern occurrence.
   * Format: `${filePath}#${role}:${family}:${methodShape}:${sourceLocation.start.offset}`
   */
  readonly id: string;

  /**
   * Producer vs Consumer.
   */
  readonly role: RepositoryEventPatternRole;

  /**
   * Pattern family / library.
   */
  readonly family: RepositoryEventPatternFamily;

  /**
   * Specific method or invocation shape.
   */
  readonly methodShape: RepositoryEventMethodShape;

  /**
   * Relative POSIX path in the repository snapshot.
   */
  readonly filePath: string;

  /**
   * Event/topic/channel/queue details and resolution status.
   */
  readonly details: RepositoryEventPatternDetails;

  /**
   * Exact source location in the file.
   */
  readonly sourceLocation: SourceLocation;

  /**
   * Deterministic explanatory evidence string.
   */
  readonly evidence: string;
}

/**
 * Diagnostic report for parse anomalies or errors during event pattern detection.
 */
export interface RepositoryEventPatternDiagnostic {
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: "error" | "warning";
}

/**
 * Summary counts for deterministic verification.
 */
export interface RepositoryEventPatternCounts {
  readonly totalProducers: number;
  readonly totalConsumers: number;
  readonly totalResolved: number;
  readonly totalUnresolved: number;
  readonly byFamily: {
    readonly node_event_emitter: number;
    readonly redis_pubsub: number;
    readonly kafkajs: number;
    readonly rabbitmq_amqplib: number;
  };
}

/**
 * Complete deterministic result of Step 22 event producer/consumer detection.
 */
export interface RepositoryEventPatternDetectionResult {
  readonly producers: readonly RepositoryEventPattern[];
  readonly consumers: readonly RepositoryEventPattern[];
  readonly diagnostics: readonly RepositoryEventPatternDiagnostic[];
  readonly counts: RepositoryEventPatternCounts;
}
