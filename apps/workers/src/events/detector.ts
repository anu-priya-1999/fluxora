import ts from "typescript";
import type {
  RepositoryEventMethodShape,
  RepositoryEventPattern,
  RepositoryEventPatternCounts,
  RepositoryEventPatternDetectionResult,
  RepositoryEventPatternDiagnostic,
} from "@fluxora/shared-types";

import { isIgnoredPath } from "../detect/detector.ts";
import {
  getNodeSourceLocation,
  getScriptKindForPath,
  isSupportedSymbolFile,
} from "../symbols/extractor.ts";
import type { SnapshotFileMap } from "../modules/graph.ts";

/**
 * Input for Step 22 Event Producer/Consumer pattern detection.
 */
export interface RepositoryEventPatternDetectionInput {
  /**
   * Complete map of relative file path -> content string for the repository snapshot.
   */
  readonly files: SnapshotFileMap;
}

/**
 * Statically extracts a string literal from an AST expression if knowable.
 * Supports string literals and simple template literals without expression interpolation.
 */
export function extractStaticEventStringValue(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  // Remove wrapping parentheses or as/satisfies type casts if present
  let expr: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  return null;
}

/**
 * Provenance tracking for EventEmitter, Redis, KafkaJS, and RabbitMQ within a single file.
 */
interface EventProvenanceScope {
  // EventEmitter bindings
  eventEmitterClasses: Set<string>; // Class names extending EventEmitter
  eventEmitterInstances: Set<string>; // Variables instantiated via new EventEmitter() or new EmitterSubclass()

  // Redis bindings
  redisInstances: Set<string>; // Variables instantiated via createClient(), new Redis(), etc.

  // KafkaJS bindings
  kafkaProducers: Set<string>; // Variables assigned from kafka.producer()
  kafkaConsumers: Set<string>; // Variables assigned from kafka.consumer()
  kafkaClients: Set<string>; // Variables assigned from new Kafka()

  // RabbitMQ / amqplib bindings
  amqpChannels: Set<string>; // Variables holding channel (connection.createChannel())
}

/**
 * Scans top-level and inner statements of a SourceFile to establish provenance for event clients.
 */
function analyzeEventProvenance(sourceFile: ts.SourceFile): EventProvenanceScope {
  // 1. Identify module imports and requires
  const eventEmitterImportNames = new Set<string>();
  const redisImportNames = new Set<string>();
  const kafkaImportNames = new Set<string>();
  const amqpImportNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const importClause = statement.importClause;

        // "events" or "node:events"
        if (specifier === "events" || specifier === "node:events") {
          if (importClause) {
            if (importClause.name) {
              eventEmitterImportNames.add(importClause.name.text);
            }
            if (importClause.namedBindings) {
              if (ts.isNamespaceImport(importClause.namedBindings)) {
                eventEmitterImportNames.add(importClause.namedBindings.name.text);
              } else if (ts.isNamedImports(importClause.namedBindings)) {
                for (const element of importClause.namedBindings.elements) {
                  const importedName = element.propertyName
                    ? element.propertyName.text
                    : element.name.text;
                  if (importedName === "EventEmitter") {
                    eventEmitterImportNames.add(element.name.text);
                  }
                }
              }
            }
          }
        }
        // "redis", "ioredis"
        else if (specifier === "redis" || specifier === "ioredis") {
          if (importClause) {
            if (importClause.name) {
              redisImportNames.add(importClause.name.text);
            }
            if (importClause.namedBindings) {
              if (ts.isNamespaceImport(importClause.namedBindings)) {
                redisImportNames.add(importClause.namedBindings.name.text);
              } else if (ts.isNamedImports(importClause.namedBindings)) {
                for (const element of importClause.namedBindings.elements) {
                  const importedName = element.propertyName
                    ? element.propertyName.text
                    : element.name.text;
                  if (importedName === "createClient" || importedName === "Redis") {
                    redisImportNames.add(element.name.text);
                  }
                }
              }
            }
          }
        }
        // "kafkajs"
        else if (specifier === "kafkajs") {
          if (importClause) {
            if (importClause.name) {
              kafkaImportNames.add(importClause.name.text);
            }
            if (importClause.namedBindings) {
              if (ts.isNamespaceImport(importClause.namedBindings)) {
                kafkaImportNames.add(importClause.namedBindings.name.text);
              } else if (ts.isNamedImports(importClause.namedBindings)) {
                for (const element of importClause.namedBindings.elements) {
                  const importedName = element.propertyName
                    ? element.propertyName.text
                    : element.name.text;
                  if (importedName === "Kafka") {
                    kafkaImportNames.add(element.name.text);
                  }
                }
              }
            }
          }
        }
        // "amqplib"
        else if (specifier === "amqplib" || specifier === "amqplib/callback_api") {
          if (importClause) {
            if (importClause.name) {
              amqpImportNames.add(importClause.name.text);
            }
            if (importClause.namedBindings) {
              if (ts.isNamespaceImport(importClause.namedBindings)) {
                amqpImportNames.add(importClause.namedBindings.name.text);
              } else if (ts.isNamedImports(importClause.namedBindings)) {
                for (const element of importClause.namedBindings.elements) {
                  const importedName = element.propertyName
                    ? element.propertyName.text
                    : element.name.text;
                  if (importedName === "connect") {
                    amqpImportNames.add(element.name.text);
                  }
                }
              }
            }
          }
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      // Check for const events = require("events") / const { EventEmitter } = require("events"), etc.
      for (const decl of statement.declarationList.declarations) {
        if (
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "require" &&
          decl.initializer.arguments.length > 0
        ) {
          const firstArg = decl.initializer.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const specifier = firstArg.text;
            if (specifier === "events" || specifier === "node:events") {
              if (ts.isIdentifier(decl.name)) {
                eventEmitterImportNames.add(decl.name.text);
              } else if (ts.isObjectBindingPattern(decl.name)) {
                for (const elem of decl.name.elements) {
                  if (ts.isIdentifier(elem.name)) {
                    const prop = elem.propertyName && ts.isIdentifier(elem.propertyName)
                      ? elem.propertyName.text
                      : elem.name.text;
                    if (prop === "EventEmitter") {
                      eventEmitterImportNames.add(elem.name.text);
                    }
                  }
                }
              }
            } else if (specifier === "redis" || specifier === "ioredis") {
              if (ts.isIdentifier(decl.name)) {
                redisImportNames.add(decl.name.text);
              } else if (ts.isObjectBindingPattern(decl.name)) {
                for (const elem of decl.name.elements) {
                  if (ts.isIdentifier(elem.name)) {
                    const prop = elem.propertyName && ts.isIdentifier(elem.propertyName)
                      ? elem.propertyName.text
                      : elem.name.text;
                    if (prop === "createClient" || prop === "Redis") {
                      redisImportNames.add(elem.name.text);
                    }
                  }
                }
              }
            } else if (specifier === "kafkajs") {
              if (ts.isIdentifier(decl.name)) {
                kafkaImportNames.add(decl.name.text);
              } else if (ts.isObjectBindingPattern(decl.name)) {
                for (const elem of decl.name.elements) {
                  if (ts.isIdentifier(elem.name)) {
                    const prop = elem.propertyName && ts.isIdentifier(elem.propertyName)
                      ? elem.propertyName.text
                      : elem.name.text;
                    if (prop === "Kafka") {
                      kafkaImportNames.add(elem.name.text);
                    }
                  }
                }
              }
            } else if (specifier === "amqplib" || specifier === "amqplib/callback_api") {
              if (ts.isIdentifier(decl.name)) {
                amqpImportNames.add(decl.name.text);
              } else if (ts.isObjectBindingPattern(decl.name)) {
                for (const elem of decl.name.elements) {
                  if (ts.isIdentifier(elem.name)) {
                    const prop = elem.propertyName && ts.isIdentifier(elem.propertyName)
                      ? elem.propertyName.text
                      : elem.name.text;
                    if (prop === "connect") {
                      amqpImportNames.add(elem.name.text);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const eventEmitterClasses = new Set<string>();
  const eventEmitterInstances = new Set<string>();
  const redisInstances = new Set<string>();
  const kafkaClients = new Set<string>();
  const kafkaProducers = new Set<string>();
  const kafkaConsumers = new Set<string>();
  const amqpChannels = new Set<string>();
  const amqpConnections = new Set<string>();

  // 2. Identify classes extending EventEmitter
  function inspectClassDeclaration(node: ts.ClassDeclaration | ts.ClassExpression): void {
    const className = node.name?.text;
    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const typeNode of clause.types) {
            const expr = typeNode.expression;
            let extendsName: string | null = null;
            if (ts.isIdentifier(expr)) {
              extendsName = expr.text;
            } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
              if (ts.isIdentifier(expr.expression) && eventEmitterImportNames.has(expr.expression.text)) {
                extendsName = expr.name.text;
              } else if (expr.name.text === "EventEmitter") {
                extendsName = "EventEmitter";
              }
            }
            if (
              extendsName === "EventEmitter" ||
              (extendsName && eventEmitterImportNames.has(extendsName)) ||
              (extendsName && eventEmitterClasses.has(extendsName))
            ) {
              if (className) {
                eventEmitterClasses.add(className);
              }
            }
          }
        }
      }
    }
  }

  // 3. Scan AST to find instantiations and factory calls
  function scanDeclarationsAndAssignments(node: ts.Node): void {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      inspectClassDeclaration(node);
    }

    // Variable declarations: const x = ...
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const varName = node.name.text;
      const init = node.initializer;
      classifyExpressionAssignment(varName, init);
    }

    // Binary assignment: x = ...
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const varName = node.left.text;
      classifyExpressionAssignment(varName, node.right);
    }

    ts.forEachChild(node, scanDeclarationsAndAssignments);
  }

  function classifyExpressionAssignment(varName: string, exprNode: ts.Expression): void {
    let expr = exprNode;
    // Unwrap await
    if (ts.isAwaitExpression(expr)) {
      expr = expr.expression;
    }

    // Check `new ...`
    if (ts.isNewExpression(expr)) {
      const targetExpr = expr.expression;
      let targetName: string | null = null;

      if (ts.isIdentifier(targetExpr)) {
        targetName = targetExpr.text;
      } else if (ts.isPropertyAccessExpression(targetExpr) && ts.isIdentifier(targetExpr.name)) {
        targetName = targetExpr.name.text;
      }

      // Check EventEmitter: new EventEmitter() or new MyEmitter()
      if (
        targetName === "EventEmitter" ||
        (targetName && eventEmitterImportNames.has(targetName)) ||
        (targetName && eventEmitterClasses.has(targetName))
      ) {
        eventEmitterInstances.add(varName);
        return;
      }

      // Check Redis: new Redis() or new ioredis()
      if (
        (targetName === "Redis" && (redisImportNames.size > 0 || redisImportNames.has("Redis"))) ||
        (targetName && redisImportNames.has(targetName))
      ) {
        redisInstances.add(varName);
        return;
      }

      // Check Kafka: new Kafka({ ... })
      if (
        (targetName === "Kafka" && (kafkaImportNames.size > 0 || kafkaImportNames.has("Kafka"))) ||
        (targetName && kafkaImportNames.has(targetName))
      ) {
        kafkaClients.add(varName);
        return;
      }
    }

    // Check Call Expressions: `createClient()`, `kafka.producer()`, `connection.createChannel()`, etc.
    if (ts.isCallExpression(expr)) {
      const callTarget = expr.expression;

      // 1. Redis `createClient()` or `redis.createClient()`
      if (ts.isIdentifier(callTarget) && callTarget.text === "createClient" && redisImportNames.size > 0) {
        redisInstances.add(varName);
        return;
      }
      if (
        ts.isPropertyAccessExpression(callTarget) &&
        ts.isIdentifier(callTarget.name) &&
        callTarget.name.text === "createClient" &&
        ts.isIdentifier(callTarget.expression) &&
        redisImportNames.has(callTarget.expression.text)
      ) {
        redisInstances.add(varName);
        return;
      }

      // 2. KafkaJS: `kafka.producer()` and `kafka.consumer()`
      if (ts.isPropertyAccessExpression(callTarget) && ts.isIdentifier(callTarget.name)) {
        const method = callTarget.name.text;
        let callerName: string | null = null;
        if (ts.isIdentifier(callTarget.expression)) {
          callerName = callTarget.expression.text;
        }

        if (callerName && (kafkaClients.has(callerName) || kafkaImportNames.has(callerName))) {
          if (method === "producer") {
            kafkaProducers.add(varName);
            return;
          }
          if (method === "consumer") {
            kafkaConsumers.add(varName);
            return;
          }
        }
      }

      // 3. RabbitMQ: `amqp.connect()` -> connection, `conn.createChannel()` -> channel
      if (ts.isPropertyAccessExpression(callTarget) && ts.isIdentifier(callTarget.name)) {
        const method = callTarget.name.text;
        let callerName: string | null = null;
        if (ts.isIdentifier(callTarget.expression)) {
          callerName = callTarget.expression.text;
        }

        if (method === "connect" && callerName && amqpImportNames.has(callerName)) {
          amqpConnections.add(varName);
          return;
        }

        if (
          (method === "createChannel" || method === "createConfirmChannel") &&
          callerName &&
          (amqpConnections.has(callerName) || /conn(?:ection)?/i.test(callerName))
        ) {
          amqpChannels.add(varName);
          return;
        }
      }

      if (ts.isIdentifier(callTarget) && callTarget.text === "connect" && amqpImportNames.has("connect")) {
        amqpConnections.add(varName);
        return;
      }
    }
  }

  scanDeclarationsAndAssignments(sourceFile);

  return {
    eventEmitterClasses,
    eventEmitterInstances,
    redisInstances,
    kafkaClients,
    kafkaProducers,
    kafkaConsumers,
    amqpChannels,
  };
}

/**
 * Detects event producer and consumer patterns across the files of a repository snapshot.
 */
export function detectRepositoryEventPatterns(
  input: RepositoryEventPatternDetectionInput,
): RepositoryEventPatternDetectionResult {
  const producers: RepositoryEventPattern[] = [];
  const consumers: RepositoryEventPattern[] = [];
  const diagnostics: RepositoryEventPatternDiagnostic[] = [];

  const sortedFilePaths = Array.from(input.files.keys()).sort();

  for (const relativePath of sortedFilePaths) {
    if (isIgnoredPath(relativePath) || !isSupportedSymbolFile(relativePath)) {
      continue;
    }

    const sourceText = input.files.get(relativePath) ?? "";
    const scriptKind = getScriptKindForPath(relativePath);

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        filePath: relativePath,
        message: `Failed to parse AST for event pattern detection: ${message}`,
        severity: "error",
      });
      continue;
    }

    // Extract provenance for this file
    const provenance = analyzeEventProvenance(sourceFile);

    // Inspect all call expressions in the source file
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        inspectCall(node, relativePath, sourceFile, provenance, producers, consumers);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Deterministically sort producers and consumers by filePath, then start offset, then id
  producers.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    if (a.sourceLocation.start.offset !== b.sourceLocation.start.offset) {
      return a.sourceLocation.start.offset - b.sourceLocation.start.offset;
    }
    return a.id.localeCompare(b.id);
  });

  consumers.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    if (a.sourceLocation.start.offset !== b.sourceLocation.start.offset) {
      return a.sourceLocation.start.offset - b.sourceLocation.start.offset;
    }
    return a.id.localeCompare(b.id);
  });

  diagnostics.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    return a.message.localeCompare(b.message);
  });

  // Calculate summary counts
  let totalResolved = 0;
  let totalUnresolved = 0;

  const byFamily = {
    node_event_emitter: 0,
    redis_pubsub: 0,
    kafkajs: 0,
    rabbitmq_amqplib: 0,
  };

  for (const item of [...producers, ...consumers]) {
    if (item.details.status === "resolved") {
      totalResolved++;
    } else {
      totalUnresolved++;
    }
    byFamily[item.family]++;
  }

  const counts: RepositoryEventPatternCounts = {
    totalProducers: producers.length,
    totalConsumers: consumers.length,
    totalResolved,
    totalUnresolved,
    byFamily,
  };

  return {
    producers,
    consumers,
    diagnostics,
    counts,
  };
}

/**
 * Inspects a CallExpression for recognized pub/sub call shapes.
 */
function inspectCall(
  call: ts.CallExpression,
  filePath: string,
  sourceFile: ts.SourceFile,
  scope: EventProvenanceScope,
  producers: RepositoryEventPattern[],
  consumers: RepositoryEventPattern[],
): void {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    return;
  }

  const propAccess = call.expression;
  const methodName = propAccess.name.text;
  const targetExpr = propAccess.expression;

  // Extract caller identifier name or expression
  let receiverName: string | null = null;
  let isThis = false;

  if (ts.isIdentifier(targetExpr)) {
    receiverName = targetExpr.text;
  } else if (targetExpr.kind === ts.SyntaxKind.ThisKeyword) {
    isThis = true;
    receiverName = "this";
  }

  // 1. Node.js EventEmitter patterns
  // Producer: emitter.emit("event", ...), this.emit("event", ...)
  // Consumers: emitter.on("event", fn), emitter.once("event", fn), emitter.addListener("event", fn)
  if (
    methodName === "emit" ||
    methodName === "on" ||
    methodName === "once" ||
    methodName === "addListener"
  ) {
    const isProvenEventEmitter =
      (receiverName && scope.eventEmitterInstances.has(receiverName)) ||
      (isThis && scope.eventEmitterClasses.size > 0 && isInsideEventEmitterClass(call, scope.eventEmitterClasses)) ||
      // Fallback: If variable name is explicitly 'emitter' or 'eventEmitter' and there is at least some EventEmitter usage/class in file
      (receiverName && (receiverName === "emitter" || receiverName === "eventEmitter") && (scope.eventEmitterClasses.size > 0 || scope.eventEmitterInstances.size > 0));

    if (isProvenEventEmitter) {
      const firstArg = call.arguments[0];
      const eventName = extractStaticEventStringValue(firstArg);
      const isResolved = eventName !== null;
      const location = getNodeSourceLocation(call, sourceFile);

      if (methodName === "emit") {
        producers.push({
          id: `${filePath}#producer:node_event_emitter:emit:${location.start.offset}`,
          role: "producer",
          family: "node_event_emitter",
          methodShape: "emit",
          filePath,
          details: {
            eventName,
            status: isResolved ? "resolved" : "unresolved",
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `Node.js EventEmitter producer '${receiverName ?? "this"}.emit' with ${
            isResolved ? `event '${eventName}'` : "dynamic event"
          }`,
        });
      } else {
        const methodShape: RepositoryEventMethodShape =
          methodName === "on" ? "on" : methodName === "once" ? "once" : "addListener";

        const handlerArg = call.arguments[1];
        const handlerSymbol = extractHandlerSymbol(handlerArg);

        consumers.push({
          id: `${filePath}#consumer:node_event_emitter:${methodShape}:${location.start.offset}`,
          role: "consumer",
          family: "node_event_emitter",
          methodShape,
          filePath,
          details: {
            eventName,
            status: isResolved ? "resolved" : "unresolved",
            handlerSymbol,
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `Node.js EventEmitter consumer '${receiverName ?? "this"}.${methodName}' with ${
            isResolved ? `event '${eventName}'` : "dynamic event"
          }`,
        });
      }
      return;
    }
  }

  // 2. Redis pub/sub
  // Producer: publish("channel", message)
  // Consumer: subscribe("channel", handler), pSubscribe("pattern", handler)
  if (methodName === "publish" || methodName === "subscribe" || methodName === "pSubscribe") {
    const isProvenRedis =
      receiverName &&
      (scope.redisInstances.has(receiverName) ||
        (scope.redisInstances.size > 0 && (/redis/i.test(receiverName) || receiverName === "client" || receiverName === "pubClient" || receiverName === "subClient")));

    if (isProvenRedis) {
      const firstArg = call.arguments[0];
      const channelName = extractStaticEventStringValue(firstArg);
      const isResolved = channelName !== null;
      const location = getNodeSourceLocation(call, sourceFile);

      if (methodName === "publish") {
        producers.push({
          id: `${filePath}#producer:redis_pubsub:publish:${location.start.offset}`,
          role: "producer",
          family: "redis_pubsub",
          methodShape: "publish",
          filePath,
          details: {
            eventName: channelName,
            status: isResolved ? "resolved" : "unresolved",
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `Redis pub/sub producer '${receiverName}.publish' on channel ${
            isResolved ? `'${channelName}'` : "(unresolved)"
          }`,
        });
        return;
      } else {
        const methodShape: RepositoryEventMethodShape =
          methodName === "subscribe" ? "subscribe" : "pSubscribe";
        const handlerArg = call.arguments[1];
        const handlerSymbol = extractHandlerSymbol(handlerArg);

        consumers.push({
          id: `${filePath}#consumer:redis_pubsub:${methodShape}:${location.start.offset}`,
          role: "consumer",
          family: "redis_pubsub",
          methodShape,
          filePath,
          details: {
            eventName: channelName,
            status: isResolved ? "resolved" : "unresolved",
            handlerSymbol,
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `Redis pub/sub consumer '${receiverName}.${methodName}' on channel ${
            isResolved ? `'${channelName}'` : "(unresolved)"
          }`,
        });
        return;
      }
    }
  }

  // 3. KafkaJS
  // Producer: producer.send({ topic: "...", messages: [...] })
  // Consumer: consumer.subscribe({ topic: "..." }), consumer.run({ eachMessage: ... }), consumer.run({ eachBatch: ... })
  if (receiverName && (scope.kafkaProducers.has(receiverName) || scope.kafkaConsumers.has(receiverName) || /^(producer|consumer)$/.test(receiverName) && (scope.kafkaProducers.size > 0 || scope.kafkaConsumers.size > 0 || scope.kafkaClients.size > 0))) {
    const isKafkaProducer = scope.kafkaProducers.has(receiverName) || (receiverName === "producer" && scope.kafkaClients.size > 0);
    const isKafkaConsumer = scope.kafkaConsumers.has(receiverName) || (receiverName === "consumer" && scope.kafkaClients.size > 0);

    // Kafka Producer: producer.send({ topic: "..." })
    if (isKafkaProducer && methodName === "send") {
      const firstArg = call.arguments[0];
      let topic: string | null = null;
      let isResolved = false;

      if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
        for (const prop of firstArg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ((ts.isIdentifier(prop.name) && prop.name.text === "topic") ||
              (ts.isStringLiteral(prop.name) && prop.name.text === "topic"))
          ) {
            topic = extractStaticEventStringValue(prop.initializer);
            isResolved = topic !== null;
            break;
          }
        }
      }

      const location = getNodeSourceLocation(call, sourceFile);
      producers.push({
        id: `${filePath}#producer:kafkajs:kafka_send:${location.start.offset}`,
        role: "producer",
        family: "kafkajs",
        methodShape: "kafka_send",
        filePath,
        details: {
          eventName: topic,
          status: isResolved ? "resolved" : "unresolved",
          receiverSymbol: receiverName,
        },
        sourceLocation: location,
        evidence: `KafkaJS producer '${receiverName}.send' with topic ${
          isResolved ? `'${topic}'` : "(unresolved)"
        }`,
      });
      return;
    }

    // Kafka Consumer: consumer.subscribe({ topic: "..." })
    if (isKafkaConsumer && methodName === "subscribe") {
      const firstArg = call.arguments[0];
      let topic: string | null = null;
      let isResolved = false;

      if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
        for (const prop of firstArg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ((ts.isIdentifier(prop.name) && prop.name.text === "topic") ||
              (ts.isStringLiteral(prop.name) && prop.name.text === "topic"))
          ) {
            topic = extractStaticEventStringValue(prop.initializer);
            isResolved = topic !== null;
            break;
          }
        }
      }

      const location = getNodeSourceLocation(call, sourceFile);
      consumers.push({
        id: `${filePath}#consumer:kafkajs:kafka_subscribe:${location.start.offset}`,
        role: "consumer",
        family: "kafkajs",
        methodShape: "kafka_subscribe",
        filePath,
        details: {
          eventName: topic,
          status: isResolved ? "resolved" : "unresolved",
          receiverSymbol: receiverName,
        },
        sourceLocation: location,
        evidence: `KafkaJS consumer subscribe '${receiverName}.subscribe' on topic ${
          isResolved ? `'${topic}'` : "(unresolved)"
        }`,
      });
      return;
    }

    // Kafka Consumer: consumer.run({ eachMessage: ... }) or consumer.run({ eachBatch: ... })
    if (isKafkaConsumer && methodName === "run") {
      const firstArg = call.arguments[0];
      if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
        let hasEachMessage = false;
        let hasEachBatch = false;
        let handlerSymbol: string | undefined = undefined;

        for (const prop of firstArg.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const propName = ts.isIdentifier(prop.name)
              ? prop.name.text
              : ts.isStringLiteral(prop.name)
                ? prop.name.text
                : "";

            if (propName === "eachMessage") {
              hasEachMessage = true;
              handlerSymbol = extractHandlerSymbol(prop.initializer);
            } else if (propName === "eachBatch") {
              hasEachBatch = true;
              handlerSymbol = extractHandlerSymbol(prop.initializer);
            }
          }
        }

        const location = getNodeSourceLocation(call, sourceFile);
        if (hasEachMessage) {
          consumers.push({
            id: `${filePath}#consumer:kafkajs:kafka_each_message:${location.start.offset}`,
            role: "consumer",
            family: "kafkajs",
            methodShape: "kafka_each_message",
            filePath,
            details: {
              eventName: null, // Topic is registered via consumer.subscribe
              status: "unresolved",
              handlerSymbol,
              receiverSymbol: receiverName,
            },
            sourceLocation: location,
            evidence: `KafkaJS consumer handler '${receiverName}.run({ eachMessage })'`,
          });
          return;
        }

        if (hasEachBatch) {
          consumers.push({
            id: `${filePath}#consumer:kafkajs:kafka_each_batch:${location.start.offset}`,
            role: "consumer",
            family: "kafkajs",
            methodShape: "kafka_each_batch",
            filePath,
            details: {
              eventName: null,
              status: "unresolved",
              handlerSymbol,
              receiverSymbol: receiverName,
            },
            sourceLocation: location,
            evidence: `KafkaJS consumer batch handler '${receiverName}.run({ eachBatch })'`,
          });
          return;
        }
      }
    }
  }

  // 4. RabbitMQ / amqplib
  // Producer: channel.publish(exchange, routingKey, content), channel.sendToQueue(queue, content)
  // Consumer: channel.consume(queue, handler)
  if (
    methodName === "publish" ||
    methodName === "sendToQueue" ||
    methodName === "consume"
  ) {
    const isProvenAmqp =
      receiverName &&
      (scope.amqpChannels.has(receiverName) ||
        (scope.amqpChannels.size > 0 && (/channel/i.test(receiverName) || receiverName === "ch")));

    if (isProvenAmqp) {
      const location = getNodeSourceLocation(call, sourceFile);

      if (methodName === "publish") {
        // channel.publish(exchange, routingKey, ...)
        const exchangeArg = call.arguments[0];
        const routingKeyArg = call.arguments[1];
        const exchange = extractStaticEventStringValue(exchangeArg);
        const routingKey = extractStaticEventStringValue(routingKeyArg);

        // In AMQP, the routingKey or exchange is the topic/channel identifier
        const primaryIdentifier = routingKey ?? exchange;
        const isResolved = primaryIdentifier !== null;

        producers.push({
          id: `${filePath}#producer:rabbitmq_amqplib:amqp_publish:${location.start.offset}`,
          role: "producer",
          family: "rabbitmq_amqplib",
          methodShape: "amqp_publish",
          filePath,
          details: {
            eventName: primaryIdentifier,
            status: isResolved ? "resolved" : "unresolved",
            exchange,
            routingKey,
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `RabbitMQ amqplib producer '${receiverName}.publish' on exchange '${
            exchange ?? "(unresolved)"
          }' with routing key '${routingKey ?? "(unresolved)"}'`,
        });
        return;
      }

      if (methodName === "sendToQueue") {
        // channel.sendToQueue(queue, content)
        const queueArg = call.arguments[0];
        const queue = extractStaticEventStringValue(queueArg);
        const isResolved = queue !== null;

        producers.push({
          id: `${filePath}#producer:rabbitmq_amqplib:amqp_send_to_queue:${location.start.offset}`,
          role: "producer",
          family: "rabbitmq_amqplib",
          methodShape: "amqp_send_to_queue",
          filePath,
          details: {
            eventName: queue,
            status: isResolved ? "resolved" : "unresolved",
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `RabbitMQ amqplib queue producer '${receiverName}.sendToQueue' to queue '${
            queue ?? "(unresolved)"
          }'`,
        });
        return;
      }

      if (methodName === "consume") {
        // channel.consume(queue, handler)
        const queueArg = call.arguments[0];
        const handlerArg = call.arguments[1];
        const queue = extractStaticEventStringValue(queueArg);
        const isResolved = queue !== null;
        const handlerSymbol = extractHandlerSymbol(handlerArg);

        consumers.push({
          id: `${filePath}#consumer:rabbitmq_amqplib:amqp_consume:${location.start.offset}`,
          role: "consumer",
          family: "rabbitmq_amqplib",
          methodShape: "amqp_consume",
          filePath,
          details: {
            eventName: queue,
            status: isResolved ? "resolved" : "unresolved",
            handlerSymbol,
            receiverSymbol: receiverName ?? undefined,
          },
          sourceLocation: location,
          evidence: `RabbitMQ amqplib queue consumer '${receiverName}.consume' on queue '${
            queue ?? "(unresolved)"
          }'`,
        });
        return;
      }
    }
  }
}

/**
 * Checks whether an AST node is located inside a class that extends EventEmitter.
 */
function isInsideEventEmitterClass(node: ts.Node, eventEmitterClasses: Set<string>): boolean {
  let curr: ts.Node | undefined = node.parent;
  while (curr) {
    if (ts.isClassDeclaration(curr) || ts.isClassExpression(curr)) {
      if (curr.name && eventEmitterClasses.has(curr.name.text)) {
        return true;
      }
    }
    curr = curr.parent;
  }
  return false;
}

/**
 * Extracts the function or identifier name for a callback handler if statically knowable.
 */
function extractHandlerSymbol(node: ts.Expression | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isFunctionExpression(node)) {
    return node.name ? node.name.text : "anonymous";
  }
  if (ts.isArrowFunction(node)) {
    return "anonymous";
  }
  return undefined;
}
