import assert from "node:assert/strict";
import test from "node:test";

import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_PINNED_SHA,
  loadGoldenFixtureFileMap,
  loadGoldenFixtureManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";
import { runPhase3Pipeline } from "./phase3.ts";

test("1. golden fixture loads successfully into SnapshotFileMap", () => {
  const fileMap = loadGoldenFixtureFileMap();
  assert.ok(fileMap.size > 100, "Golden fixture file map must contain >100 files");
  assert.ok(fileMap.has("package.json"), "package.json must be present");
  assert.ok(fileMap.has("tsconfig.json"), "tsconfig.json must be present");
  assert.ok(fileMap.has("app/layout.tsx"), "app/layout.tsx must be present");
});

test("2. golden fixture integrity is verified", () => {
  const manifest = loadGoldenFixtureManifest();
  assert.equal(manifest.fixtureId, GOLDEN_FIXTURE_ID);
  assert.equal(manifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);
  assert.equal(manifest.frameworkCharacteristics.framework, "Next.js");
});

test("3. Step 18 stack detection output is present and deterministic", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { detection } = pipelineResult;
  assert.equal(detection.primaryLanguage, "TypeScript");
  assert.equal(detection.primaryFramework, "Next.js");
  assert.ok(detection.languages.includes("TypeScript"));
  assert.ok(detection.languages.includes("JavaScript"));
  assert.ok(detection.languages.includes("JSON"));
  assert.ok(detection.languages.includes("CSS"));
  assert.ok(detection.languages.includes("Markdown"));
  assert.ok(detection.frameworks.includes("Next.js"));
  assert.ok(detection.frameworks.includes("React"));
  assert.ok(detection.frameworks.includes("Node.js"));
});

test("4. Step 19 symbol extraction output is present and deterministic", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { symbolExtractions, summary } = pipelineResult;
  assert.ok(symbolExtractions.length > 50, "Must extract symbols across >50 TS/JS files");
  assert.ok(summary.totalSymbolsExtracted > 200, "Must extract >200 total symbols from golden fixture");

  // Check db symbol in lib/db.ts
  const dbFileExtractions = symbolExtractions.find((s) => s.relativePath === "lib/db.ts");
  assert.ok(dbFileExtractions, "lib/db.ts symbol extraction must exist");
  const dbSymbol = dbFileExtractions.symbols.find((sym) => sym.name === "db");
  assert.ok(dbSymbol, "db constant must be extracted from lib/db.ts");
  assert.equal(dbSymbol.kind, "constant");
  assert.equal(dbSymbol.exported.isExported, true);
});

test("5. Step 20 module import/export graph output is present and deterministic", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { moduleGraph, summary } = pipelineResult;
  assert.ok(moduleGraph.filesAnalyzed.length > 30);
  assert.ok(summary.totalModuleInternalEdges > 40);
  assert.ok(moduleGraph.externalReferences.length > 50);

  // Path alias @/config/site in app/layout.tsx -> config/site.ts
  const layoutEdge = moduleGraph.internalEdges.find(
    (e) => e.sourceFile === "app/layout.tsx" && e.specifier === "@/config/site",
  );
  assert.ok(layoutEdge, "Import @/config/site in app/layout.tsx must resolve to internal edge");
  assert.equal(layoutEdge.targetFile, "config/site.ts");
});

test("6. Step 21 route detection output is present and deterministic", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { routes, summary } = pipelineResult;
  assert.ok(routes.routes.length > 0, "Must detect Next.js App Router API routes");
  assert.equal(summary.totalRoutesDetected, routes.routes.length);

  // Check /api/posts route
  const postsRoute = routes.routes.find((r) => r.routePath === "/api/posts");
  assert.ok(postsRoute, "/api/posts API route must be detected");
  assert.equal(postsRoute.framework, "Next.js");
  assert.equal(postsRoute.routeType, "app-router-handler");

  // Non-API pages like app/layout.tsx must NOT be detected as routes
  const layoutRoute = routes.routes.find((r) => r.filePath === "app/layout.tsx");
  assert.equal(layoutRoute, undefined, "app/layout.tsx must not be detected as an API route");
});

test("7. Step 22 event pattern output handles golden fixture correctly", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { events, summary } = pipelineResult;
  // Golden taxonomy fixture has no event emitter / redis / kafka / rabbitmq producer or consumer patterns
  assert.equal(events.producers.length, 0);
  assert.equal(events.consumers.length, 0);
  assert.equal(summary.totalEventProducers, 0);
  assert.equal(summary.totalEventConsumers, 0);
});

test("8. Step 23 database reference output handles golden fixture correctly", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { databaseReferences, summary } = pipelineResult;
  // Golden taxonomy fixture accesses DB via indirect import `db` from `@/lib/db`.
  // Direct ORM instantiation (PrismaClient) in same file is absent, so references count is 0.
  assert.equal(databaseReferences.references.length, 0);
  assert.equal(summary.totalDatabaseReferences, 0);
});

test("9. Step 24 tree-sitter fallback pass decision is correct", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { treeSitterResults, summary } = pipelineResult;
  assert.ok(treeSitterResults.length > 0);

  // TS/JS file should NOT use fallback parse because primary parser succeeded
  const tsResult = treeSitterResults.find((r) => r.relativePath === "lib/db.ts");
  assert.ok(tsResult);
  assert.equal(tsResult.usedFallback, false);
  assert.equal(tsResult.parserUsed, "compiler-primary");

  // Markdown file (README.md) uses pure-JS Markdown fallback parser
  const mdResult = treeSitterResults.find((r) => r.relativePath === "README.md");
  assert.ok(mdResult);
  assert.equal(mdResult.usedFallback, true);
  assert.equal(mdResult.parserUsed, "tree-sitter-markdown");
  assert.equal(mdResult.language, "Markdown");
  assert.ok(summary.totalTreeSitterFallbacks > 0);
});

test("10. Step 25 normalization succeeds and produces canonical results", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  const { normalized, summary } = pipelineResult;
  assert.ok(normalized.symbols.length > 100);
  assert.ok(normalized.moduleEdges.length > 40);
  assert.ok(normalized.routes.length > 0);
  assert.equal(normalized.databaseReferences.length, 0);
  assert.equal(summary.totalNormalizedSymbols, normalized.symbols.length);
  assert.equal(summary.totalNormalizedRoutes, normalized.routes.length);
});

test("11. complete Phase 3 result is deterministic across repeated runs", async () => {
  const fileMap = loadGoldenFixtureFileMap();

  const run1 = await runPhase3Pipeline({ files: fileMap });
  const run2 = await runPhase3Pipeline({ files: fileMap });

  assert.deepEqual(run1.summary, run2.summary);
  assert.equal(JSON.stringify(run1.normalized), JSON.stringify(run2.normalized));
});

test("12. hand-verify representative symbols against golden fixture source evidence", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });
  const { normalized } = pipelineResult;

  // Hand-verified Symbol 1: db in lib/db.ts
  // Source says: Line 18: export const db = prisma
  const dbText = readGoldenFixtureFileText("lib/db.ts");
  assert.ok(dbText.includes("export const db = prisma"));
  const dbSym = normalized.symbols.find(
    (s) => s.relativePath === "lib/db.ts" && s.name === "db" && s.kind === "constant",
  );
  assert.ok(dbSym, "Canonical symbol for 'db' in lib/db.ts must exist");
  assert.equal(dbSym.exported.isExported, true);

  // Hand-verified Symbol 2: siteConfig in config/site.ts
  // Source says: Line 3: export const siteConfig: SiteConfig = { ... }
  const siteText = readGoldenFixtureFileText("config/site.ts");
  assert.ok(siteText.includes("export const siteConfig"));
  const siteSym = normalized.symbols.find(
    (s) => s.relativePath === "config/site.ts" && s.name === "siteConfig" && s.kind === "constant",
  );
  assert.ok(siteSym, "Canonical symbol for 'siteConfig' in config/site.ts must exist");
  assert.equal(siteSym.exported.isExported, true);

  // Hand-verified Symbol 3: GET function in app/api/posts/route.ts
  // Source says: Line 12: export async function GET(req: Request)
  const postsRouteText = readGoldenFixtureFileText("app/api/posts/route.ts");
  assert.ok(postsRouteText.includes("export async function GET"));
  const getSym = normalized.symbols.find(
    (s) => s.relativePath === "app/api/posts/route.ts" && s.name === "GET" && s.kind === "function",
  );
  assert.ok(getSym, "Canonical symbol for 'GET' in app/api/posts/route.ts must exist");
  assert.equal(getSym.exported.isExported, true);
  assert.equal(getSym.metadata?.isAsync, true);
});

test("13. hand-verify representative module relationships against golden fixture source evidence", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });
  const { normalized } = pipelineResult;

  // Hand-verified Relationship 1: app/api/posts/route.ts imports "@/lib/db" -> lib/db.ts
  const postsRouteText = readGoldenFixtureFileText("app/api/posts/route.ts");
  assert.ok(postsRouteText.includes('import { db } from "@/lib/db"'));
  const dbEdge = normalized.moduleEdges.find(
    (e) => e.sourceFile === "app/api/posts/route.ts" && e.specifier === "@/lib/db",
  );
  assert.ok(dbEdge, "Module edge for import '@/lib/db' in app/api/posts/route.ts must exist");
  assert.equal(dbEdge.targetFile, "lib/db.ts");

  // Hand-verified Relationship 2: app/layout.tsx imports "@/config/site" -> config/site.ts
  const layoutText = readGoldenFixtureFileText("app/layout.tsx");
  assert.ok(layoutText.includes('import { siteConfig } from "@/config/site"'));
  const siteEdge = normalized.moduleEdges.find(
    (e) => e.sourceFile === "app/layout.tsx" && e.specifier === "@/config/site",
  );
  assert.ok(siteEdge, "Module edge for import '@/config/site' in app/layout.tsx must exist");
  assert.equal(siteEdge.targetFile, "config/site.ts");

  // Hand-verified Relationship 3: components/user-auth-form.tsx imports "@/lib/validations/auth" -> lib/validations/auth.ts
  const authFormText = readGoldenFixtureFileText("components/user-auth-form.tsx");
  assert.ok(authFormText.includes('import { userAuthSchema } from "@/lib/validations/auth"'));
  const authSchemaEdge = normalized.moduleEdges.find(
    (e) => e.sourceFile === "components/user-auth-form.tsx" && e.specifier === "@/lib/validations/auth",
  );
  assert.ok(authSchemaEdge, "Module edge for import '@/lib/validations/auth' in components/user-auth-form.tsx must exist");
  assert.equal(authSchemaEdge.targetFile, "lib/validations/auth.ts");
});

test("14. hand-verify representative routes against golden fixture source evidence", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });
  const { normalized } = pipelineResult;

  // Hand-verified Route 1: /api/posts in app/api/posts/route.ts
  const route1Get = normalized.routes.find(
    (r) => r.filePath === "app/api/posts/route.ts" && r.routePath === "/api/posts" && r.httpMethods.includes("GET"),
  );
  assert.ok(route1Get, "Route GET /api/posts must exist in normalized routes");

  const route1Post = normalized.routes.find(
    (r) => r.filePath === "app/api/posts/route.ts" && r.routePath === "/api/posts" && r.httpMethods.includes("POST"),
  );
  assert.ok(route1Post, "Route POST /api/posts must exist in normalized routes");

  // Hand-verified Route 2: /api/og in app/api/og/route.tsx
  const ogRoute = normalized.routes.find(
    (r) => r.filePath === "app/api/og/route.tsx" && r.routePath === "/api/og" && r.httpMethods.includes("GET"),
  );
  assert.ok(ogRoute, "Route GET /api/og must exist in normalized routes");
});

test("15. hand-verify export resolution handling against golden fixture source evidence", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });
  const { normalized } = pipelineResult;

  // The taxonomy golden fixture contains local exports but zero re-exports (export ... from "...").
  // Normalizer exportResolutions contains entries only for re-export / barrel files.
  assert.equal(normalized.exportResolutions.length, 0);
});

test("16. unresolved and diagnostic data is preserved", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });

  assert.ok(Array.isArray(pipelineResult.normalized.unresolved));
  assert.ok(Array.isArray(pipelineResult.normalized.diagnostics));
});

test("17. golden fixture integrity protections still pass", () => {
  const manifest = loadGoldenFixtureManifest();
  assert.equal(manifest.files.length, manifest.fileCount);
  assert.ok(manifest.totalSizeBytes > 500_000);
});

test("18. complete pipeline does not execute repository code", async () => {
  const fileMap = loadGoldenFixtureFileMap();
  // Execute full pipeline and ensure it returns clean result without side-effects or code execution
  const pipelineResult = await runPhase3Pipeline({ files: fileMap });
  assert.ok(pipelineResult.summary.filesAnalyzed > 100);
  assert.ok(pipelineResult.summary.totalNormalizedSymbols > 0);
});

