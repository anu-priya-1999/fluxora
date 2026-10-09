import assert from "node:assert/strict";
import test from "node:test";

import type {
  RepositoryDatabaseDetectionResult,
  RepositoryEventPatternDetectionResult,
  RepositoryNormalizerInput,
  RepositoryRouteDetectionResult,
  RepositorySymbol,
  TreeSitterParseResult,
} from "@fluxora/shared-types";

import { extractRepositoryModuleGraph } from "../modules/graph.ts";
import { extractSymbolsFromSource } from "../symbols/extractor.ts";
import { normalizeAnalysis } from "./normalizer.ts";

function createDummyLocation(startOffset = 0, line = 1, column = 1) {
  return {
    start: { line, column, offset: startOffset },
    end: { line, column: column + 10, offset: startOffset + 10 },
  };
}

function createDummySymbol(
  relativePath: string,
  name: string,
  kind: RepositorySymbol["kind"] = "function",
  offset = 0,
  isExported = true,
  exportName?: string,
): RepositorySymbol {
  return {
    id: `${relativePath}#${kind}:${name}:${offset}`,
    name,
    kind,
    relativePath,
    location: createDummyLocation(offset),
    exported: {
      isExported,
      isDefaultExport: false,
      ...(exportName ? { exportName } : {}),
    },
  };
}

test("1. direct symbol remains unchanged", () => {
  const symbol = createDummySymbol("math.ts", "add", "function", 10);
  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "math.ts", symbols: [symbol], diagnostics: [] }],
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const normSym = result.symbols[0]!;
  assert.equal(normSym.name, "add");
  assert.equal(normSym.relativePath, "math.ts");
  assert.equal(normSym.canonicalId, "sym:math.ts#function:add:10");
  assert.equal(normSym.aliases.length, 0);
  assert.equal(normSym.provenance.length, 1);
  assert.equal(normSym.provenance[0]!.detector, "step-19-symbols");
});

test("2. named barrel re-export resolves to canonical symbol", () => {
  const files = new Map<string, string>([
    ["math.ts", "export function add(a: number, b: number) { return a + b; }"],
    ["index.ts", 'export { add } from "./math";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symbolsMath = extractSymbolsFromSource({ relativePath: "math.ts", sourceText: files.get("math.ts")! });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symbolsMath],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const mathSym = result.symbols[0]!;
  assert.equal(mathSym.canonicalId, "sym:math.ts#function:add:0");

  assert.equal(mathSym.aliases.length, 1);
  assert.equal(mathSym.aliases[0]!.exportingFile, "index.ts");
  assert.equal(mathSym.aliases[0]!.exportName, "add");

  const expRes = result.exportResolutions.find((r) => r.exportingFile === "index.ts" && r.exportName === "add");
  assert.ok(expRes);
  assert.equal(expRes.status, "resolved");
  assert.equal(expRes.canonicalSymbolId, mathSym.canonicalId);
});

test("3. aliased re-export preserves alias + canonical target", () => {
  const files = new Map<string, string>([
    ["math.ts", "export function add(a: number, b: number) { return a + b; }"],
    ["index.ts", 'export { add as sum } from "./math";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symbolsMath = extractSymbolsFromSource({ relativePath: "math.ts", sourceText: files.get("math.ts")! });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symbolsMath],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const mathSym = result.symbols[0]!;
  assert.equal(mathSym.name, "add");
  assert.equal(mathSym.aliases.length, 1);
  assert.equal(mathSym.aliases[0]!.exportingFile, "index.ts");
  assert.equal(mathSym.aliases[0]!.exportName, "sum");

  const expRes = result.exportResolutions.find((r) => r.exportingFile === "index.ts" && r.exportName === "sum");
  assert.ok(expRes);
  assert.equal(expRes.status, "resolved");
  assert.equal(expRes.canonicalSymbolId, mathSym.canonicalId);
});

test("4. export * barrel resolution", () => {
  const files = new Map<string, string>([
    ["math.ts", "export function add(a: number, b: number) { return a + b; }"],
    ["index.ts", 'export * from "./math";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symbolsMath = extractSymbolsFromSource({ relativePath: "math.ts", sourceText: files.get("math.ts")! });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symbolsMath],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const mathSym = result.symbols[0]!;

  assert.equal(mathSym.aliases.length, 1);
  assert.equal(mathSym.aliases[0]!.exportingFile, "index.ts");
  assert.equal(mathSym.aliases[0]!.exportName, "add");
});

test("5. nested barrel chain", () => {
  const files = new Map<string, string>([
    ["math.ts", "export function add(a: number, b: number) { return a + b; }"],
    ["barrel.ts", 'export { add } from "./math";'],
    ["index.ts", 'export { add } from "./barrel";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symbolsMath = extractSymbolsFromSource({ relativePath: "math.ts", sourceText: files.get("math.ts")! });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symbolsMath],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const mathSym = result.symbols[0]!;

  assert.equal(mathSym.aliases.length, 2);
  const indexAlias = mathSym.aliases.find((a) => a.exportingFile === "index.ts");
  const barrelAlias = mathSym.aliases.find((a) => a.exportingFile === "barrel.ts");
  assert.ok(indexAlias);
  assert.ok(barrelAlias);
});

test("6. index.ts barrel chain", () => {
  const files = new Map<string, string>([
    ["utils/helper.ts", "export function helper() { return true; }"],
    ["utils/index.ts", 'export * from "./helper";'],
    ["index.ts", 'export { helper } from "./utils";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symbolsHelper = extractSymbolsFromSource({
    relativePath: "utils/helper.ts",
    sourceText: files.get("utils/helper.ts")!,
  });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symbolsHelper],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const sym = result.symbols[0]!;
  assert.equal(sym.relativePath, "utils/helper.ts");

  const resIndex = result.exportResolutions.find((r) => r.exportingFile === "index.ts" && r.exportName === "helper");
  assert.ok(resIndex);
  assert.equal(resIndex.status, "resolved");
  assert.equal(resIndex.canonicalSymbolId, sym.canonicalId);
});

test("7. multiple aliases to the same symbol deduplicate correctly", () => {
  const files = new Map<string, string>([
    ["target.ts", "export function foo() {}"],
    ["a.ts", 'export { foo as alpha } from "./target";'],
    ["b.ts", 'export { foo as beta } from "./target";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symbolsTarget = extractSymbolsFromSource({
    relativePath: "target.ts",
    sourceText: files.get("target.ts")!,
  });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symbolsTarget],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  const sym = result.symbols[0]!;

  assert.equal(sym.aliases.length, 2);
  assert.ok(sym.aliases.some((a) => a.exportingFile === "a.ts" && a.exportName === "alpha"));
  assert.ok(sym.aliases.some((a) => a.exportingFile === "b.ts" && a.exportName === "beta"));
});

test("8. same symbol name in different files does NOT deduplicate", () => {
  const userSym = createDummySymbol("users.ts", "createUser", "function", 10);
  const orderSym = createDummySymbol("orders.ts", "createUser", "function", 20);

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [
      { relativePath: "users.ts", symbols: [userSym], diagnostics: [] },
      { relativePath: "orders.ts", symbols: [orderSym], diagnostics: [] },
    ],
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 2);
  assert.notEqual(result.symbols[0]!.canonicalId, result.symbols[1]!.canonicalId);
});

test("9. multiple declarations in one file remain distinct", () => {
  const fn1 = createDummySymbol("file.ts", "processItem", "function", 10);
  const fn2 = createDummySymbol("file.ts", "processItem", "function", 100);

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "file.ts", symbols: [fn1, fn2], diagnostics: [] }],
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 2);
  assert.equal(result.symbols[0]!.canonicalId, "sym:file.ts#function:processItem:10");
  assert.equal(result.symbols[1]!.canonicalId, "sym:file.ts#function:processItem:100");
});

test("10. deterministic canonical IDs", () => {
  const sym = createDummySymbol("service.ts", "getData", "function", 50);
  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "service.ts", symbols: [sym], diagnostics: [] }],
  };

  const res1 = normalizeAnalysis(input);
  const res2 = normalizeAnalysis(input);

  assert.equal(res1.symbols[0]!.canonicalId, res2.symbols[0]!.canonicalId);
  assert.equal(res1.symbols[0]!.canonicalId, "sym:service.ts#function:getData:50");
});

test("11. canonical IDs unaffected by input ordering", () => {
  const symA = createDummySymbol("a.ts", "alpha", "function", 10);
  const symB = createDummySymbol("b.ts", "beta", "function", 20);

  const input1: RepositoryNormalizerInput = {
    symbolExtractions: [
      { relativePath: "a.ts", symbols: [symA], diagnostics: [] },
      { relativePath: "b.ts", symbols: [symB], diagnostics: [] },
    ],
  };

  const input2: RepositoryNormalizerInput = {
    symbolExtractions: [
      { relativePath: "b.ts", symbols: [symB], diagnostics: [] },
      { relativePath: "a.ts", symbols: [symA], diagnostics: [] },
    ],
  };

  const res1 = normalizeAnalysis(input1);
  const res2 = normalizeAnalysis(input2);

  assert.deepStrictEqual(res1.symbols.map((s) => s.canonicalId), res2.symbols.map((s) => s.canonicalId));
});

test("12. deterministic output ordering", () => {
  const symZ = createDummySymbol("z.ts", "zebra", "function", 5);
  const symA = createDummySymbol("a.ts", "apple", "function", 15);

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [
      { relativePath: "z.ts", symbols: [symZ], diagnostics: [] },
      { relativePath: "a.ts", symbols: [symA], diagnostics: [] },
    ],
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols[0]!.canonicalId, "sym:a.ts#function:apple:15");
  assert.equal(result.symbols[1]!.canonicalId, "sym:z.ts#function:zebra:5");
});

test("13. cycle-safe barrel resolution", () => {
  const files = new Map<string, string>([
    ["a.ts", 'export * from "./b";'],
    ["b.ts", 'export * from "./a";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const input: RepositoryNormalizerInput = { moduleGraph };

  const result = normalizeAnalysis(input);
  assert.ok(result.statistics.cycleCount >= 0);
  assert.equal(result.symbols.length, 0);
});

test("14. unresolved export remains unresolved", () => {
  const files = new Map<string, string>([
    ["index.ts", 'export { missing } from "./non-existent";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const input: RepositoryNormalizerInput = { moduleGraph };

  const result = normalizeAnalysis(input);
  const expRes = result.exportResolutions.find((r) => r.exportName === "missing");
  assert.ok(expRes);
  assert.equal(expRes.status, "unresolved");
  assert.equal(result.unresolved.length > 0, true);
});

test("15. ambiguous resolution remains unresolved", () => {
  const files = new Map<string, string>([
    ["a.ts", "export function foo() { return 1; }"],
    ["b.ts", "export function foo() { return 2; }"],
    ["index.ts", 'export * from "./a"; export * from "./b";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symA = extractSymbolsFromSource({ relativePath: "a.ts", sourceText: files.get("a.ts")! });
  const symB = extractSymbolsFromSource({ relativePath: "b.ts", sourceText: files.get("b.ts")! });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symA, symB],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);
  const expRes = result.exportResolutions.find((r) => r.exportingFile === "index.ts" && r.exportName === "foo");
  assert.ok(expRes);
  assert.equal(expRes.status, "ambiguous");
});

test("16. source/provenance evidence is preserved", () => {
  const sym = createDummySymbol("app.ts", "main", "function", 1);
  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "app.ts", symbols: [sym], diagnostics: [] }],
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols[0]!.provenance.length, 1);
  assert.equal(result.symbols[0]!.provenance[0]!.detector, "step-19-symbols");
  assert.equal(result.symbols[0]!.provenance[0]!.sourceId, sym.id);
});

test("17. raw detector inputs are not mutated", () => {
  const sym = createDummySymbol("app.ts", "main", "function", 1);
  const originalSymCopy = JSON.parse(JSON.stringify(sym));
  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "app.ts", symbols: [sym], diagnostics: [] }],
  };

  normalizeAnalysis(input);
  assert.deepStrictEqual(sym, originalSymCopy);
});

test("18. repeated normalization of identical input produces identical output", () => {
  const sym = createDummySymbol("app.ts", "main", "function", 1);
  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "app.ts", symbols: [sym], diagnostics: [] }],
  };

  const res1 = normalizeAnalysis(input);
  const res2 = normalizeAnalysis(input);
  assert.deepStrictEqual(res1, res2);
});

test("19. normalization of empty input is deterministic", () => {
  const result = normalizeAnalysis({});
  assert.equal(result.symbols.length, 0);
  assert.equal(result.exportResolutions.length, 0);
  assert.equal(result.moduleEdges.length, 0);
  assert.equal(result.routes.length, 0);
  assert.equal(result.events.length, 0);
  assert.equal(result.databaseReferences.length, 0);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.statistics.totalSymbolsInput, 0);
  assert.equal(result.statistics.totalNormalizedSymbols, 0);
});

test("20. mixed Step 18–24 outputs normalize safely without dropping supported data", () => {
  const sym = createDummySymbol("app.ts", "handler", "function", 100);
  const dummyRouteResult: RepositoryRouteDetectionResult = {
    routes: [
      {
        id: "app.ts#app-router-handler:GET:/api/test",
        framework: "Next.js",
        routeType: "app-router-handler",
        filePath: "app.ts",
        routePath: "/api/test",
        httpMethods: ["GET"],
        symbolName: "handler",
        sourceLocation: createDummyLocation(100),
        evidence: "export async function GET",
      },
    ],
    routers: [],
    diagnostics: [],
    counts: {
      totalRoutes: 1,
      totalRouters: 0,
      nextAppRoutes: 1,
      nextPagesRoutes: 0,
      expressRoutes: 0,
      expressRouters: 0,
    },
  };

  const dummyEventResult: RepositoryEventPatternDetectionResult = {
    producers: [
      {
        id: "app.ts#producer:node_event_emitter:emit:200",
        role: "producer",
        family: "node_event_emitter",
        methodShape: "emit",
        filePath: "app.ts",
        details: { eventName: "user.created", status: "resolved", handlerSymbol: "handler" },
        sourceLocation: createDummyLocation(200),
        evidence: "emitter.emit('user.created')",
      },
    ],
    consumers: [],
    diagnostics: [],
    counts: {
      totalProducers: 1,
      totalConsumers: 0,
      totalResolved: 1,
      totalUnresolved: 0,
      byFamily: { node_event_emitter: 1, redis_pubsub: 0, kafkajs: 0, rabbitmq_amqplib: 0 },
    },
  };

  const dummyDbResult: RepositoryDatabaseDetectionResult = {
    references: [
      {
        id: "app.ts#db:prisma:read:findMany:300",
        family: "prisma",
        operation: "read",
        methodShape: "findMany",
        filePath: "app.ts",
        details: { resourceName: "user", status: "resolved", receiverSymbol: "handler" },
        sourceLocation: createDummyLocation(300),
        evidence: "prisma.user.findMany()",
      },
    ],
    diagnostics: [],
    counts: {
      totalReferences: 1,
      totalResolved: 1,
      totalUnresolved: 0,
      byFamily: { prisma: 1, drizzle: 0, typeorm: 0, sequelize: 0 },
      byOperation: { read: 1, insert: 0, update: 0, delete: 0, upsert: 0, query: 0, execute: 0, transaction: 0 },
    },
  };

  const dummyTreeSitter: TreeSitterParseResult = {
    id: "styles.css#tree-sitter",
    relativePath: "styles.css",
    language: "CSS",
    parserUsed: "tree-sitter-css",
    success: true,
    usedFallback: true,
    diagnostics: [],
  };

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [{ relativePath: "app.ts", symbols: [sym], diagnostics: [] }],
    routeResult: dummyRouteResult,
    eventResult: dummyEventResult,
    databaseResult: dummyDbResult,
    treeSitterResults: [dummyTreeSitter],
  };

  const result = normalizeAnalysis(input);
  assert.equal(result.symbols.length, 1);
  assert.equal(result.routes.length, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.databaseReferences.length, 1);

  assert.equal(result.routes[0]!.canonicalSymbolId, "sym:app.ts#function:handler:100");
  assert.equal(result.events[0]!.canonicalSymbolId, "sym:app.ts#function:handler:100");
  assert.equal(result.databaseReferences[0]!.canonicalSymbolId, "sym:app.ts#function:handler:100");
});

test("21. synthetic repository fixture containing direct module, barrel file, nested barrel, alias re-export, duplicate symbol names, and cyclic barrels", () => {
  const files = new Map<string, string>([
    ["lib/user.ts", "export function createUser() { return 'user'; }"],
    ["lib/order.ts", "export function createUser() { return 'order_user'; }"],
    ["lib/barrel.ts", 'export { createUser as createNewUser } from "./user";'],
    ["lib/index.ts", 'export * from "./barrel";'],
    ["cycle/a.ts", 'export * from "./b";'],
    ["cycle/b.ts", 'export * from "./a";'],
  ]);

  const moduleGraph = extractRepositoryModuleGraph({ files });
  const symUser = extractSymbolsFromSource({ relativePath: "lib/user.ts", sourceText: files.get("lib/user.ts")! });
  const symOrder = extractSymbolsFromSource({ relativePath: "lib/order.ts", sourceText: files.get("lib/order.ts")! });

  const input: RepositoryNormalizerInput = {
    symbolExtractions: [symUser, symOrder],
    moduleGraph,
  };

  const result = normalizeAnalysis(input);

  assert.equal(result.symbols.length, 2);
  const userSym = result.symbols.find((s) => s.relativePath === "lib/user.ts");
  const orderSym = result.symbols.find((s) => s.relativePath === "lib/order.ts");
  assert.ok(userSym);
  assert.ok(orderSym);

  const resBarrel = result.exportResolutions.find((r) => r.exportingFile === "lib/barrel.ts" && r.exportName === "createNewUser");
  assert.ok(resBarrel);
  assert.equal(resBarrel.status, "resolved");
  assert.equal(resBarrel.canonicalSymbolId, userSym.canonicalId);

  assert.equal(result.statistics.totalNormalizedSymbols, 2);
  assert.equal(typeof result.statistics.cycleCount, "number");
});

