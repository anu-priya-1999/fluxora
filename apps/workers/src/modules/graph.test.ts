import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRepositoryModuleGraph,
  type SnapshotFileMap,
} from "./graph.ts";
import {
  loadGoldenFixtureManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";

test("1. named imports: extracts named imports and bindings", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `import { foo, bar as baz } from "./utils";\nconst x = foo + baz;`,
    ],
    [
      "src/utils.ts",
      `export const foo = 1;\nexport const bar = 2;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.diagnostics.length, 0);
  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.sourceFile, "src/index.ts");
  assert.equal(edge.targetFile, "src/utils.ts");
  assert.equal(edge.edgeKind, "import");
  assert.equal(edge.importKind, "named_import");
  assert.equal(edge.names.length, 2);
  assert.equal(edge.names[0]?.name, "foo");
  assert.equal(edge.names[0]?.alias, undefined);
  assert.equal(edge.names[1]?.name, "bar");
  assert.equal(edge.names[1]?.alias, "baz");
});

test("2. default imports: extracts default import correctly", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/app.ts",
      `import Header from "./Header";\nHeader();`,
    ],
    [
      "src/Header.ts",
      `export default function Header() {}`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.sourceFile, "src/app.ts");
  assert.equal(edge.targetFile, "src/Header.ts");
  assert.equal(edge.importKind, "default_import");
  assert.equal(edge.names.length, 1);
  assert.equal(edge.names[0]?.name, "default");
  assert.equal(edge.names[0]?.alias, "Header");
});

test("3. namespace imports: extracts import * as Namespace", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `import * as MathUtils from "./math";`,
    ],
    [
      "src/math.ts",
      `export function add(a: number, b: number) { return a + b; }`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.importKind, "namespace_import");
  assert.equal(edge.names.length, 1);
  assert.equal(edge.names[0]?.name, "*");
  assert.equal(edge.names[0]?.alias, "MathUtils");
});

test("4. side-effect imports: extracts import './setup'", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `import "./setup";`,
    ],
    [
      "src/setup.ts",
      `console.log("initialized");`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.importKind, "side_effect_import");
  assert.equal(edge.names.length, 0);
  assert.equal(edge.targetFile, "src/setup.ts");
});

test("5. static dynamic imports: extracts import('./foo')", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/loader.ts",
      `async function load() { const mod = await import("./heavy"); return mod; }`,
    ],
    [
      "src/heavy.ts",
      `export const payload = 42;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.edgeKind, "dynamic_import");
  assert.equal(edge.importKind, "dynamic_import");
  assert.equal(edge.targetFile, "src/heavy.ts");
});

test("6. CommonJS require detection: extracts require('./foo')", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/server.cjs",
      `const config = require("./config");`,
    ],
    [
      "src/config.cjs",
      `module.exports = { port: 3000 };`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.edgeKind, "require");
  assert.equal(edge.importKind, "require");
  assert.equal(edge.targetFile, "src/config.cjs");
});

test("7. named exports: extracts export { foo, bar }", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/declarations.ts",
      `export function foo() {}\nexport class Bar {}\nexport const baz = 1;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });
  // Local declarations without from-clause are not module-to-module references
  assert.equal(graph.internalEdges.length, 0);
  assert.equal(graph.references.length, 0);
});

test("8. star re-exports: extracts export * from './utils'", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `export * from "./utils";`,
    ],
    [
      "src/utils.ts",
      `export const a = 1;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.sourceFile, "src/index.ts");
  assert.equal(edge.targetFile, "src/utils.ts");
  assert.equal(edge.edgeKind, "re_export");
  assert.equal(edge.importKind, "star_re_export");
  assert.equal(edge.names.length, 1);
  assert.equal(edge.names[0]?.name, "*");
});

test("9. named re-exports: extracts export { foo } from './utils'", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `export { foo } from "./utils";`,
    ],
    [
      "src/utils.ts",
      `export const foo = "test";`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.edgeKind, "re_export");
  assert.equal(edge.importKind, "named_re_export");
  assert.equal(edge.names[0]?.name, "foo");
  assert.equal(edge.names[0]?.alias, undefined);
});

test("10. aliased re-exports: extracts export { foo as bar } from './utils'", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `export { foo as bar } from "./utils";`,
    ],
    [
      "src/utils.ts",
      `export const foo = 123;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.edgeKind, "re_export");
  assert.equal(edge.importKind, "named_re_export");
  assert.equal(edge.names[0]?.name, "foo");
  assert.equal(edge.names[0]?.alias, "bar");
});

test("11. namespace re-exports: extracts export * as utils from './utils'", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `export * as utils from "./utils";`,
    ],
    [
      "src/utils.ts",
      `export const ok = true;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.edgeKind, "re_export");
  assert.equal(edge.importKind, "namespace_re_export");
  assert.equal(edge.names[0]?.name, "*");
  assert.equal(edge.names[0]?.alias, "utils");
});

test("12. relative path resolution across nested directories", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/services/billing/payment.ts",
      `import { helper } from "../../utils/helpers";`,
    ],
    [
      "src/utils/helpers.ts",
      `export function helper() {}`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  assert.equal(graph.internalEdges[0]?.sourceFile, "src/services/billing/payment.ts");
  assert.equal(graph.internalEdges[0]?.targetFile, "src/utils/helpers.ts");
});

test("13. extension resolution: resolves without .ts / .tsx in specifier", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/app.tsx",
      `import { Button } from "./components/Button";\nimport { util } from "./util";`,
    ],
    [
      "src/components/Button.tsx",
      `export function Button() { return null; }`,
    ],
    [
      "src/util.ts",
      `export const util = 1;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 2);
  const targets = graph.internalEdges.map((e) => e.targetFile).sort();
  assert.deepEqual(targets, ["src/components/Button.tsx", "src/util.ts"]);
});

test("14. directory/index resolution: resolves directory path to index file", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/app.ts",
      `import { API } from "./api";`,
    ],
    [
      "src/api/index.ts",
      `export const API = 1;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  assert.equal(graph.internalEdges[0]?.targetFile, "src/api/index.ts");
});

test("15. tsconfig paths alias resolution: resolves @/* aliases to repository files", () => {
  const tsconfig = `{
    "compilerOptions": {
      "baseUrl": ".",
      "paths": {
        "@/*": ["./src/*"]
      }
    }
  }`;

  const files: SnapshotFileMap = new Map([
    ["tsconfig.json", tsconfig],
    [
      "src/components/Button.tsx",
      `export function Button() { return null; }`,
    ],
    [
      "src/pages/index.tsx",
      `import { Button } from "@/components/Button";`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 1);
  const edge = graph.internalEdges[0];
  assert.ok(edge);
  assert.equal(edge.sourceFile, "src/pages/index.tsx");
  assert.equal(edge.targetFile, "src/components/Button.tsx");
  assert.equal(edge.specifier, "@/components/Button");
});

test("16. external package imports: classifies non-repository imports as external", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `import React from "react";\nimport { z } from "zod";`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 0);
  assert.equal(graph.externalReferences.length, 2);
  const specifiers = graph.externalReferences.map((r) => r.specifier).sort();
  assert.deepEqual(specifiers, ["react", "zod"]);
});

test("17. unresolved internal imports: distinguishes relative missing modules", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `import { missing } from "./non-existent";`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 0);
  assert.equal(graph.unresolvedReferences.length, 1);
  assert.equal(graph.unresolvedReferences[0]?.specifier, "./non-existent");
  assert.equal(graph.unresolvedReferences[0]?.resolutionStatus, "unresolved");
});

test("18. unsupported dynamic resolution: non-literal dynamic import", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/plugin.ts",
      `const modPath = getDynamicPath();\nimport(modPath);\nconst r = require(modPath);`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.unsupportedDynamicReferences.length, 2);
  for (const ref of graph.unsupportedDynamicReferences) {
    assert.equal(ref.resolutionStatus, "unsupported_dynamic");
    assert.equal(ref.specifier, "<dynamic>");
  }
});

test("19. deterministic edge IDs and results across multiple runs", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/a.ts",
      `import { b } from "./b";\nexport const a = 1;`,
    ],
    [
      "src/b.ts",
      `import { c } from "./c";\nexport const b = 2;`,
    ],
    [
      "src/c.ts",
      `export const c = 3;`,
    ],
  ]);

  const run1 = extractRepositoryModuleGraph({ files });
  const run2 = extractRepositoryModuleGraph({ files });

  assert.deepEqual(run1, run2);
  assert.equal(run1.internalEdges[0]?.id, "src/a.ts->src/b.ts#import:0");
  assert.equal(run1.internalEdges[1]?.id, "src/b.ts->src/c.ts#import:0");
});

test("20. cyclic imports: gracefully handles and records cyclic module dependencies", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/alpha.ts",
      `import { beta } from "./beta";\nexport const alpha = () => beta();`,
    ],
    [
      "src/beta.ts",
      `import { alpha } from "./alpha";\nexport const beta = () => alpha();`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 2);
  const edgeAlphaToBeta = graph.internalEdges.find((e) => e.sourceFile === "src/alpha.ts");
  const edgeBetaToAlpha = graph.internalEdges.find((e) => e.sourceFile === "src/beta.ts");
  assert.ok(edgeAlphaToBeta);
  assert.ok(edgeBetaToAlpha);
  assert.equal(edgeAlphaToBeta.targetFile, "src/beta.ts");
  assert.equal(edgeBetaToAlpha.targetFile, "src/alpha.ts");
});

test("21. malformed source tolerance: records diagnostics without throwing", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/broken.ts",
      `import { foo from "./missing; // missing brace and quote\nconst x = ;`,
    ],
    [
      "src/valid.ts",
      `export const ok = 1;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.ok(graph.diagnostics.length > 0);
  assert.equal(graph.diagnostics[0]?.file, "src/broken.ts");
  assert.equal(graph.filesAnalyzed.length, 2);
});

test("22. ignored directories: ignores node_modules and .next", () => {
  const files: SnapshotFileMap = new Map([
    [
      "node_modules/pkg/index.ts",
      `export const vendor = true;`,
    ],
    [
      ".next/types/routes.ts",
      `export const route = "/";`,
    ],
    [
      "src/index.ts",
      `export const app = 1;`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.deepEqual(graph.filesAnalyzed, ["src/index.ts"]);
});

test("23. barrel re-export remains explicit edge and is NOT normalized away", () => {
  const files: SnapshotFileMap = new Map([
    [
      "src/index.ts",
      `export { chargePayment } from "./services/payment";`,
    ],
    [
      "src/services/payment.ts",
      `export function chargePayment() {}`,
    ],
    [
      "src/app.ts",
      `import { chargePayment } from "./index";`,
    ],
  ]);

  const graph = extractRepositoryModuleGraph({ files });

  assert.equal(graph.internalEdges.length, 2);

  const barrelEdge = graph.internalEdges.find((e) => e.sourceFile === "src/index.ts");
  assert.ok(barrelEdge);
  assert.equal(barrelEdge.targetFile, "src/services/payment.ts");
  assert.equal(barrelEdge.edgeKind, "re_export");

  const appEdge = graph.internalEdges.find((e) => e.sourceFile === "src/app.ts");
  assert.ok(appEdge);
  assert.equal(appEdge.targetFile, "src/index.ts");
  assert.equal(appEdge.edgeKind, "import");
});

test("24. golden fixture real-world relationships: extracts graph from taxonomy golden fixture", () => {
  const manifest = loadGoldenFixtureManifest();

  // Build SnapshotFileMap from taxonomy golden fixture
  const files = new Map<string, string>();
  for (const entry of manifest.files) {
    if (
      entry.path.endsWith(".ts") ||
      entry.path.endsWith(".tsx") ||
      entry.path.endsWith(".js") ||
      entry.path.endsWith(".jsx") ||
      entry.path.endsWith(".mjs") ||
      entry.path.endsWith(".cjs") ||
      entry.path === "tsconfig.json" ||
      entry.path === "package.json"
    ) {
      files.set(entry.path, readGoldenFixtureFileText(entry.path));
    }
  }

  const graph = extractRepositoryModuleGraph({
    files,
    tsconfigPath: "tsconfig.json",
  });

  assert.ok(graph.filesAnalyzed.length > 30);
  assert.ok(graph.internalEdges.length > 40);
  assert.ok(graph.externalReferences.length > 50);

  // Check alias resolution in app/layout.tsx: import { siteConfig } from "@/config/site"
  const layoutEdge = graph.internalEdges.find(
    (e) => e.sourceFile === "app/layout.tsx" && e.specifier === "@/config/site",
  );
  assert.ok(layoutEdge, "layoutEdge for @/config/site must be found");
  assert.equal(layoutEdge.targetFile, "config/site.ts");
  assert.equal(layoutEdge.resolutionStatus, "internal");

  // Check alias resolution in app/layout.tsx: import { absoluteUrl, cn } from "@/lib/utils"
  const utilsEdge = graph.internalEdges.find(
    (e) => e.sourceFile === "app/layout.tsx" && e.specifier === "@/lib/utils",
  );
  assert.ok(utilsEdge, "utilsEdge for @/lib/utils must be found");
  assert.equal(utilsEdge.targetFile, "lib/utils.ts");
  assert.equal(utilsEdge.resolutionStatus, "internal");

  // Check external reference in app/layout.tsx: import { Inter as FontSans } from "next/font/google"
  const extRef = graph.externalReferences.find(
    (r) => r.sourceFile === "app/layout.tsx" && r.specifier === "next/font/google",
  );
  assert.ok(extRef, "external reference to next/font/google must be found");
  assert.equal(extRef.resolutionStatus, "external");
});
