import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryDetectorInput } from "@fluxora/shared-types";

import {
  detectRepositoryStack,
  isIgnoredPath,
} from "./detector.ts";
import {
  loadGoldenFixtureManifest,
  readGoldenFixtureFileText,
} from "../fixtures/golden.ts";

test("path ignoring logic ignores known build and dependency artifacts", () => {
  assert.equal(isIgnoredPath("node_modules/react/index.js"), true);
  assert.equal(isIgnoredPath(".git/HEAD"), true);
  assert.equal(isIgnoredPath(".next/server/pages/index.js"), true);
  assert.equal(isIgnoredPath("dist/bundle.js"), true);
  assert.equal(isIgnoredPath("build/static/js/main.js"), true);
  assert.equal(isIgnoredPath("out/index.html"), true);
  assert.equal(isIgnoredPath(".turbo/cache/123.json"), true);
  assert.equal(isIgnoredPath(".cache/yarn/v6"), true);
  assert.equal(isIgnoredPath("coverage/lcov.info"), true);

  // Deeply nested ignored path
  assert.equal(isIgnoredPath("packages/foo/node_modules/bar/index.js"), true);

  // Non-ignored paths
  assert.equal(isIgnoredPath("src/index.ts"), false);
  assert.equal(isIgnoredPath("app/page.tsx"), false);
  assert.equal(isIgnoredPath("package.json"), false);
  assert.equal(isIgnoredPath("tsconfig.json"), false);
});

test("detects TypeScript codebase with TSX normalization and tsconfig evidence", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "src/index.ts" },
      { path: "src/components/button.tsx" },
      { path: "src/utils.mts" },
      { path: "src/legacy.cts" },
      { path: "tsconfig.json" },
      { path: "README.md" },
    ],
    readFile: (p) => {
      if (p === "tsconfig.json") return '{"compilerOptions": {}}';
      return null;
    },
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.languages, ["JSON", "Markdown", "TypeScript"]);
  assert.equal(result.primaryLanguage, "TypeScript");
  assert.equal(result.primaryFramework, null);

  const tsEvidence = result.evidence.find((e) => e.target === "TypeScript");
  assert.ok(tsEvidence);
  assert.ok(tsEvidence.reasons.includes("config: tsconfig.json"));
  assert.ok(tsEvidence.reasons.includes("extension: .ts"));
  assert.ok(tsEvidence.reasons.includes("extension: .tsx"));
  assert.ok(tsEvidence.reasons.includes("extension: .mts"));
  assert.ok(tsEvidence.reasons.includes("extension: .cts"));
});

test("detects JavaScript codebase with JSX normalization", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "src/index.js" },
      { path: "src/App.jsx" },
      { path: "src/server.mjs" },
      { path: "src/worker.cjs" },
      { path: "styles/main.css" },
      { path: "public/index.html" },
      { path: "data/config.json" },
    ],
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.languages, [
    "CSS",
    "HTML",
    "JSON",
    "JavaScript",
  ]);
  assert.equal(result.primaryLanguage, "JavaScript");
  assert.equal(result.primaryFramework, null);

  const jsEvidence = result.evidence.find((e) => e.target === "JavaScript");
  assert.ok(jsEvidence);
  assert.ok(jsEvidence.reasons.includes("extension: .js"));
  assert.ok(jsEvidence.reasons.includes("extension: .jsx"));
  assert.ok(jsEvidence.reasons.includes("extension: .mjs"));
  assert.ok(jsEvidence.reasons.includes("extension: .cjs"));
});

test("ignores generated/cache directories and files", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "src/index.ts" },
      { path: "node_modules/typescript/lib/typescript.js" },
      { path: "node_modules/react/index.js" },
      { path: ".next/server/pages/index.js" },
      { path: "dist/bundle.js" },
      { path: "build/app.js" },
    ],
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.languages, ["TypeScript"]);
  assert.equal(result.primaryLanguage, "TypeScript");
  assert.equal(result.totalFilesEvaluated, 6);
  assert.equal(result.ignoredFilesCount, 5);
  assert.equal(result.recognizedFiles.length, 1);
  assert.equal(result.recognizedFiles[0]?.path, "src/index.ts");
});

test("detects Next.js and React from package.json manifest and configuration", async () => {
  const packageJson = JSON.stringify({
    name: "my-next-app",
    dependencies: {
      next: "^13.4.0",
      react: "^18.2.0",
      "react-dom": "^18.2.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  });

  const input: RepositoryDetectorInput = {
    files: [
      { path: "package.json" },
      { path: "next.config.mjs" },
      { path: "app/layout.tsx" },
      { path: "app/page.tsx" },
      { path: "tsconfig.json" },
    ],
    readFile: (p) => {
      if (p === "package.json") return packageJson;
      return null;
    },
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.frameworks, ["Next.js", "Node.js", "React"]);
  assert.equal(result.primaryFramework, "Next.js");
  assert.equal(result.primaryLanguage, "TypeScript");

  const nextEvidence = result.evidence.find((e) => e.target === "Next.js");
  assert.ok(nextEvidence);
  assert.ok(nextEvidence.reasons.includes("package.json: dependency 'next'"));
  assert.ok(nextEvidence.reasons.includes("config: next.config.mjs"));
  assert.ok(nextEvidence.reasons.includes("directory: app router structure"));

  const reactEvidence = result.evidence.find((e) => e.target === "React");
  assert.ok(reactEvidence);
  assert.ok(reactEvidence.reasons.includes("package.json: dependency 'react'"));
  assert.ok(reactEvidence.reasons.includes("package.json: dependency 'react-dom'"));
  assert.ok(reactEvidence.reasons.includes("source: JSX/TSX components present"));

  const nodeEvidence = result.evidence.find((e) => e.target === "Node.js");
  assert.ok(nodeEvidence);
  assert.ok(nodeEvidence.reasons.includes("manifest: package.json"));
});

test("detects Node.js ecosystem with lockfile and @types/node", async () => {
  const packageJson = JSON.stringify({
    name: "node-cli",
    devDependencies: {
      "@types/node": "^20.0.0",
    },
  });

  const input: RepositoryDetectorInput = {
    files: [
      { path: "package.json" },
      { path: "pnpm-lock.yaml" },
      { path: "src/cli.ts" },
    ],
    readFile: (p) => {
      if (p === "package.json") return packageJson;
      return null;
    },
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.frameworks, ["Node.js"]);
  assert.equal(result.primaryFramework, "Node.js");

  const nodeEvidence = result.evidence.find((e) => e.target === "Node.js");
  assert.ok(nodeEvidence);
  assert.ok(nodeEvidence.reasons.includes("manifest: package.json"));
  assert.ok(nodeEvidence.reasons.includes("lockfile: pnpm-lock.yaml"));
  assert.ok(nodeEvidence.reasons.includes("dependency: @types/node"));
});

test("handles unknown and unsupported extensions safely", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "Makefile" },
      { path: "docker-compose.yml" },
      { path: "archive.tar.gz" },
      { path: "LICENSE" },
      { path: "binary.dat" },
    ],
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.languages, []);
  assert.deepEqual(result.frameworks, []);
  assert.equal(result.primaryLanguage, null);
  assert.equal(result.primaryFramework, null);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.recognizedFiles.length, 0);
  assert.equal(result.totalFilesEvaluated, 5);
  assert.equal(result.ignoredFilesCount, 0);
});

test("empty or minimal repository returns explicit unknown/empty results", async () => {
  const input: RepositoryDetectorInput = {
    files: [],
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.languages, []);
  assert.deepEqual(result.frameworks, []);
  assert.equal(result.primaryLanguage, null);
  assert.equal(result.primaryFramework, null);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.recognizedFiles.length, 0);
  assert.equal(result.totalFilesEvaluated, 0);
  assert.equal(result.ignoredFilesCount, 0);
});

test("duplicate extensions and evidences are deduplicated and normalized", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "a.ts" },
      { path: "b.ts" },
      { path: "c.ts" },
      { path: "d.tsx" },
      { path: "e.tsx" },
    ],
  };

  const result = await detectRepositoryStack(input);

  assert.deepEqual(result.languages, ["TypeScript"]);
  const tsEvidence = result.evidence.find((e) => e.target === "TypeScript");
  assert.ok(tsEvidence);
  assert.deepEqual(tsEvidence.reasons, ["extension: .ts", "extension: .tsx"]);
});

test("does NOT infer a framework merely from a filename without valid evidence (avoid false positive)", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "src/next-utils.ts" },
      { path: "src/react-helpers.ts" },
      { path: "docs/next-guide.md" },
    ],
  };

  const result = await detectRepositoryStack(input);

  // Frameworks should be empty because filenames with 'next' or 'react' are not valid framework evidence
  assert.deepEqual(result.frameworks, []);
  assert.equal(result.primaryFramework, null);
});

test("guarantees deterministic repeated execution", async () => {
  const input: RepositoryDetectorInput = {
    files: [
      { path: "src/b.ts" },
      { path: "src/a.js" },
      { path: "package.json" },
      { path: "README.md" },
    ],
    readFile: () => JSON.stringify({ dependencies: { react: "^18.0.0" } }),
  };

  const run1 = await detectRepositoryStack(input);
  const run2 = await detectRepositoryStack(input);

  assert.deepEqual(run1, run2);
});

test("runs detector against golden fixture repository and validates characteristics", async () => {
  const manifest = loadGoldenFixtureManifest();

  const input: RepositoryDetectorInput = {
    files: manifest.files.map((f) => ({ path: f.path, size: f.size })),
    readFile: (relPath: string) => {
      try {
        return readGoldenFixtureFileText(relPath);
      } catch {
        return null;
      }
    },
  };

  const result = await detectRepositoryStack(input);

  // 1. Validates languages
  assert.ok(result.languages.includes("TypeScript"), "must detect TypeScript");
  assert.ok(result.languages.includes("JavaScript"), "must detect JavaScript");
  assert.ok(result.languages.includes("JSON"), "must detect JSON");
  assert.ok(result.languages.includes("CSS"), "must detect CSS");
  assert.ok(result.languages.includes("Markdown"), "must detect Markdown");
  assert.equal(result.primaryLanguage, "TypeScript");

  // 2. Validates frameworks
  assert.ok(result.frameworks.includes("Next.js"), "must detect Next.js");
  assert.ok(result.frameworks.includes("React"), "must detect React");
  assert.ok(result.frameworks.includes("Node.js"), "must detect Node.js");
  assert.equal(result.primaryFramework, "Next.js");

  // 3. Validates evidence
  const nextEv = result.evidence.find((e) => e.target === "Next.js");
  assert.ok(nextEv);
  assert.ok(nextEv.reasons.some((r) => r.includes("dependency 'next'")));
  assert.ok(nextEv.reasons.some((r) => r.includes("next.config.mjs")));
  assert.ok(nextEv.reasons.some((r) => r.includes("app router structure")));

  const reactEv = result.evidence.find((e) => e.target === "React");
  assert.ok(reactEv);
  assert.ok(reactEv.reasons.some((r) => r.includes("dependency 'react'")));

  const nodeEv = result.evidence.find((e) => e.target === "Node.js");
  assert.ok(nodeEv);
  assert.ok(nodeEv.reasons.some((r) => r.includes("package.json")));

  // 4. File evaluation counts
  assert.equal(result.totalFilesEvaluated, manifest.fileCount);
  assert.ok(result.recognizedFiles.length > 100);
});
