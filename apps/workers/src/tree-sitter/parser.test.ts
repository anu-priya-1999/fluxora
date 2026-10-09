import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateFallbackDecision, runTreeSitterFallbackPass } from "./result.ts";
import { parseTreeSitterFile } from "./parser.ts";

describe("Step 24 — Tree-sitter Fallback Pass", () => {
  it("1. JSON parses through Tree-sitter", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "package.json",
      sourceText: '{"name": "fluxora", "version": "1.0.0", "private": true}',
    });

    assert.equal(result.success, true);
    assert.equal(result.language, "JSON");
    assert.equal(result.parserUsed, "tree-sitter-json");
    assert.equal(result.usedFallback, true);
    assert.equal(result.id, "package.json#tree-sitter");
    assert.ok(result.rootNode);
    assert.equal(result.rootNode.type, "document");
    assert.ok(result.genericStructure);
    assert.ok(result.genericStructure.structuralUnits.length >= 3);
    assert.equal(result.genericStructure.structuralUnits[0]?.name, "name");
  });

  it("2. CSS parses through Tree-sitter", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "styles/globals.css",
      sourceText: ".container { display: flex; color: blue; } h1 { font-size: 24px; }",
    });

    assert.equal(result.success, true);
    assert.equal(result.language, "CSS");
    assert.equal(result.parserUsed, "tree-sitter-css");
    assert.equal(result.usedFallback, true);
    assert.ok(result.genericStructure);
    assert.ok(result.genericStructure.structuralUnits.length >= 2);
    assert.equal(result.genericStructure.structuralUnits[0]?.kind, "css_rule");
  });

  it("3. HTML parses through Tree-sitter", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "public/index.html",
      sourceText: '<!DOCTYPE html><html><head><title>App</title></head><body><div id="root"></div></body></html>',
    });

    assert.equal(result.success, true);
    assert.equal(result.language, "HTML");
    assert.equal(result.parserUsed, "tree-sitter-html");
    assert.equal(result.usedFallback, true);
    assert.ok(result.genericStructure);
    assert.ok(result.genericStructure.structuralUnits.length >= 1);
  });

  it("4. Markdown parses through Tree-sitter", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "README.md",
      sourceText: "# Fluxora\n\nAI Software Digital Twin\n\n## Features\n\n- Architecture Map\n- Impact Analysis\n\n```ts\nconst x = 1;\n```\n",
    });

    assert.equal(result.success, true);
    assert.equal(result.language, "Markdown");
    assert.equal(result.parserUsed, "tree-sitter-markdown");
    assert.equal(result.usedFallback, true);
    assert.ok(result.genericStructure);
    assert.equal(result.genericStructure.rootNodeType, "document");
    assert.ok(result.genericStructure.structuralUnits.length >= 3);
    const headingUnit = result.genericStructure.structuralUnits.find((u) => u.kind === "markdown_heading");
    assert.ok(headingUnit);
    assert.equal(headingUnit.name, "Fluxora");
  });

  it("5. unknown extension returns unsupported safely", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "binary.bin",
      sourceText: "\x00\x01\x02\x03",
    });

    assert.equal(result.success, false);
    assert.equal(result.language, "unsupported");
    assert.equal(result.parserUsed, "none");
    assert.equal(result.usedFallback, false);
    assert.ok(result.diagnostics.length > 0);
  });

  it("6. valid non-TS/JS file reports fallback parser usage", async () => {
    const result = await runTreeSitterFallbackPass({
      relativePath: "config.json",
      sourceText: '{"key": "value"}',
    });

    assert.equal(result.usedFallback, true);
    assert.equal(result.parserUsed, "tree-sitter-json");
  });

  it("7. supported TS/JS file continues using existing compiler pipeline", async () => {
    const result = await runTreeSitterFallbackPass({
      relativePath: "src/index.ts",
      sourceText: "export const x: number = 42;",
      primaryParserSucceeded: true,
    });

    assert.equal(result.usedFallback, false);
    assert.equal(result.parserUsed, "compiler-primary");
    assert.equal(result.success, true);
  });

  it("8. TS/JS file is not double-parsed by fallback after successful primary parsing", async () => {
    const decision = evaluateFallbackDecision({
      relativePath: "src/utils.js",
      sourceText: "function foo() {}",
      primaryParserSucceeded: true,
    });

    assert.equal(decision.shouldRunTreeSitter, false);
    assert.equal(decision.reason, "primary_compiler_succeeded");
  });

  it("9. malformed JSON does not crash analysis", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "invalid.json",
      sourceText: '{"name": "broken", "unclosed: }',
    });

    assert.equal(result.success, false);
    assert.equal(result.language, "JSON");
    assert.equal(result.usedFallback, true);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.rootNode);
  });

  it("10. malformed CSS does not crash analysis", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "invalid.css",
      sourceText: ".broken { color: ; font-size }",
    });

    assert.equal(result.language, "CSS");
    assert.equal(result.usedFallback, true);
    assert.ok(result.rootNode);
  });

  it("11. malformed HTML does not crash analysis", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "invalid.html",
      sourceText: "<div class='unclosed'><h1>Broken</div>",
    });

    assert.equal(result.language, "HTML");
    assert.equal(result.usedFallback, true);
    assert.ok(result.rootNode);
  });

  it("12. malformed Markdown does not crash analysis", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "invalid.md",
      sourceText: "# Heading\n\n```ts\nconst x = 1;\n",
    });

    assert.equal(result.language, "Markdown");
    assert.equal(result.usedFallback, true);
    assert.ok(result.diagnostics.length > 0);
  });

  it("13. deterministic diagnostics", async () => {
    const res1 = await parseTreeSitterFile({
      relativePath: "bad.json",
      sourceText: "{ bad: json }",
    });
    const res2 = await parseTreeSitterFile({
      relativePath: "bad.json",
      sourceText: "{ bad: json }",
    });

    assert.deepEqual(res1.diagnostics, res2.diagnostics);
  });

  it("14. deterministic output ordering", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "app.json",
      sourceText: '{"b": 2, "a": 1, "c": 3}',
    });

    assert.ok(result.genericStructure);
    const offsets = result.genericStructure.structuralUnits.map((u) => u.range.start.offset);
    const sortedOffsets = [...offsets].sort((a, b) => a - b);
    assert.deepEqual(offsets, sortedOffsets);
  });

  it("15. deterministic result identifiers", async () => {
    const result = await parseTreeSitterFile({
      relativePath: "src/types.json",
      sourceText: "{}",
    });

    assert.equal(result.id, "src/types.json#tree-sitter");
  });

  it("16. ignored paths remain ignored", async () => {
    const result = await runTreeSitterFallbackPass({
      relativePath: "node_modules/package/index.json",
      sourceText: "{}",
    });

    assert.equal(result.usedFallback, false);
    assert.equal(result.success, false);
    assert.equal(result.language, "unsupported");
    assert.equal(result.parserUsed, "none");
    assert.ok(result.diagnostics.some((d) => d.message.includes("ignored directory")));
  });

  it("17. mixed repository containing TS/JS + fallback languages chooses correct parser per file", async () => {
    const files = [
      { relativePath: "src/app.ts", sourceText: "const a = 1;", primaryParserSucceeded: true },
      { relativePath: "package.json", sourceText: '{"name": "app"}' },
      { relativePath: "styles.css", sourceText: "body { margin: 0; }" },
      { relativePath: "README.md", sourceText: "# App" },
    ];

    const results = await Promise.all(files.map((f) => runTreeSitterFallbackPass(f)));

    assert.equal(results[0]?.parserUsed, "compiler-primary");
    assert.equal(results[0]?.usedFallback, false);

    assert.equal(results[1]?.parserUsed, "tree-sitter-json");
    assert.equal(results[1]?.usedFallback, true);

    assert.equal(results[2]?.parserUsed, "tree-sitter-css");
    assert.equal(results[2]?.usedFallback, true);

    assert.equal(results[3]?.parserUsed, "tree-sitter-markdown");
    assert.equal(results[3]?.usedFallback, true);
  });

  it("18. synthetic multi-language repository fixture verifies fallback coverage", async () => {
    const syntheticFiles = [
      { path: "src/index.ts", text: "export const greeting = 'hello';", primary: true },
      { path: "src/components/button.tsx", text: "export function Button() { return null; }", primary: true },
      { path: "config/settings.json", text: '{"theme": "dark", "retries": 3}' },
      { path: "public/theme.css", text: ":root { --primary: #0070f3; }" },
      { path: "public/index.html", text: "<!DOCTYPE html><html><body><h1>App</h1></body></html>" },
      { path: "docs/GUIDE.md", text: "# Guide\n\n## Setup\n\nRun pnpm install" },
      { path: "unsupported.xyz", text: "unknown content" },
    ];

    const processed = await Promise.all(
      syntheticFiles.map((f) =>
        runTreeSitterFallbackPass({
          relativePath: f.path,
          sourceText: f.text,
          primaryParserSucceeded: f.primary,
        }),
      ),
    );

    const fallbackCount = processed.filter((p) => p.usedFallback).length;
    const primaryCount = processed.filter((p) => p.parserUsed === "compiler-primary").length;
    const unsupportedCount = processed.filter((p) => p.language === "unsupported").length;

    assert.equal(primaryCount, 2);
    assert.equal(fallbackCount, 4); // json, css, html, md
    assert.equal(unsupportedCount, 1);
  });
});

