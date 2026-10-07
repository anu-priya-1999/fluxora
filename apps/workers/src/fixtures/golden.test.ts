import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  GOLDEN_FIXTURE_DIR,
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_MANIFEST_PATH,
  GOLDEN_FIXTURE_PINNED_SHA,
  GOLDEN_FIXTURE_REPO_FULL_NAME,
  GOLDEN_FIXTURE_REPO_NAME,
  GOLDEN_FIXTURE_REPO_URL,
  GOLDEN_FIXTURE_SOURCE_BRANCH,
  getGoldenFixtureRootPath,
  loadGoldenFixtureManifest,
  readGoldenFixtureFile,
  readGoldenFixtureFileText,
} from "./golden.ts";

test("golden fixture metadata constants exist and conform to canonical specification", () => {
  assert.equal(GOLDEN_FIXTURE_ID, "golden-taxonomy-v1");
  assert.equal(GOLDEN_FIXTURE_REPO_URL, "https://github.com/shadcn-ui/taxonomy");
  assert.equal(GOLDEN_FIXTURE_REPO_FULL_NAME, "shadcn-ui/taxonomy");
  assert.equal(GOLDEN_FIXTURE_REPO_NAME, "taxonomy");
  assert.equal(GOLDEN_FIXTURE_SOURCE_BRANCH, "main");

  // Pinned commit must be a valid 40-character hexadecimal SHA-1 string
  assert.equal(typeof GOLDEN_FIXTURE_PINNED_SHA, "string");
  assert.equal(GOLDEN_FIXTURE_PINNED_SHA.length, 40);
  assert.match(GOLDEN_FIXTURE_PINNED_SHA, /^[0-9a-f]{40}$/);
});

test("golden fixture manifest exists, can be loaded, and matches pinned identity", () => {
  assert.ok(existsSync(GOLDEN_FIXTURE_MANIFEST_PATH), "manifest file must exist on disk");
  const manifest = loadGoldenFixtureManifest();

  assert.equal(manifest.fixtureId, GOLDEN_FIXTURE_ID);
  assert.equal(manifest.repositoryFullName, GOLDEN_FIXTURE_REPO_FULL_NAME);
  assert.equal(manifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);
  assert.equal(manifest.repositoryUrl, GOLDEN_FIXTURE_REPO_URL);
  assert.equal(manifest.repositoryName, GOLDEN_FIXTURE_REPO_NAME);
  assert.equal(manifest.sourceBranch, GOLDEN_FIXTURE_SOURCE_BRANCH);

  // Framework characteristics verification
  assert.equal(manifest.frameworkCharacteristics.framework, "Next.js");
  assert.equal(manifest.frameworkCharacteristics.language, "TypeScript");
  assert.equal(manifest.frameworkCharacteristics.router, "app");
  assert.equal(manifest.frameworkCharacteristics.hasServerComponents, true);
  assert.equal(manifest.frameworkCharacteristics.hasApiRoutes, true);
  assert.equal(manifest.frameworkCharacteristics.hasPrisma, true);
  assert.equal(manifest.frameworkCharacteristics.hasTailwind, true);
  assert.equal(manifest.frameworkCharacteristics.hasTsconfigPaths, true);

  // Integrity metrics
  assert.ok(manifest.fileCount > 100, "golden fixture must have realistic file count (>100 files)");
  assert.equal(manifest.files.length, manifest.fileCount);
  assert.ok(manifest.totalSizeBytes > 500_000, "golden fixture must have realistic total size (>500KB)");
});

test("golden fixture directory exists and key reference files can be loaded deterministically", () => {
  const rootPath = getGoldenFixtureRootPath();
  assert.ok(existsSync(rootPath), "root directory must exist");
  assert.equal(rootPath, GOLDEN_FIXTURE_DIR);

  // Read package.json
  const packageJsonText = readGoldenFixtureFileText("package.json");
  const parsedPackageJson = JSON.parse(packageJsonText);
  assert.equal(parsedPackageJson.name, "taxonomy");
  assert.ok(parsedPackageJson.dependencies.next, "next must be in dependencies");
  assert.ok(parsedPackageJson.dependencies.react, "react must be in dependencies");
  assert.ok(parsedPackageJson.devDependencies.typescript, "typescript must be in devDependencies");

  // Read tsconfig.json
  const tsconfigText = readGoldenFixtureFileText("tsconfig.json");
  const parsedTsconfig = JSON.parse(tsconfigText);
  assert.ok(parsedTsconfig.compilerOptions.paths["@/*"], "paths alias @/* must be configured in tsconfig");

  // Read Next.js route file
  const appLayout = readGoldenFixtureFileText("app/layout.tsx");
  assert.ok(appLayout.includes("RootLayout"), "app/layout.tsx must contain RootLayout");

  // Read API route
  const postsRoute = readGoldenFixtureFileText("app/api/posts/route.ts");
  assert.ok(postsRoute.includes("export async function GET"), "app/api/posts/route.ts must expose GET");
  assert.ok(postsRoute.includes("export async function POST"), "app/api/posts/route.ts must expose POST");

  // Read Prisma schema
  const prismaSchema = readGoldenFixtureFileText("prisma/schema.prisma");
  assert.ok(prismaSchema.includes("datasource db"), "prisma/schema.prisma must define datasource");
  assert.ok(prismaSchema.includes("model Post"), "prisma/schema.prisma must define Post model");
});

test("golden fixture file hashes match recorded manifest hashes without network access", () => {
  const manifest = loadGoldenFixtureManifest();

  // Test deterministic checksums on sample representative files across different categories
  const testPaths = [
    "package.json",
    "tsconfig.json",
    "next.config.mjs",
    "prisma/schema.prisma",
    "app/layout.tsx",
    "app/api/posts/route.ts",
    "components/site-footer.tsx",
    "lib/auth.ts",
    "lib/db.ts",
  ];

  for (const relativePath of testPaths) {
    const fileEntry = manifest.files.find((f) => f.path === relativePath);
    assert.ok(fileEntry, `Manifest entry must exist for ${relativePath}`);

    const buffer = readGoldenFixtureFile(relativePath);
    assert.equal(buffer.length, fileEntry.size, `Size mismatch for ${relativePath}`);

    const calculatedSha = createHash("sha256").update(buffer).digest("hex");
    assert.equal(calculatedSha, fileEntry.sha256, `SHA-256 hash mismatch for ${relativePath}`);
  }
});

test("all golden fixture files match recorded manifest size and sha256 checksums", () => {
  const manifest = loadGoldenFixtureManifest();

  for (const fileEntry of manifest.files) {
    const buffer = readGoldenFixtureFile(fileEntry.path);
    assert.equal(
      buffer.length,
      fileEntry.size,
      `Size mismatch for ${fileEntry.path}: expected ${fileEntry.size}, got ${buffer.length}`,
    );

    const calculatedSha = createHash("sha256").update(buffer).digest("hex");
    assert.equal(
      calculatedSha,
      fileEntry.sha256,
      `SHA-256 hash mismatch for ${fileEntry.path}: expected ${fileEntry.sha256}, got ${calculatedSha}`,
    );
  }
});

test("golden fixture text files use normalized LF line endings across all platforms", () => {
  const manifest = loadGoldenFixtureManifest();
  const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".ico", ".ttf", ".woff", ".woff2"]);

  for (const fileEntry of manifest.files) {
    const dotIndex = fileEntry.path.lastIndexOf(".");
    const ext = dotIndex !== -1 ? fileEntry.path.slice(dotIndex).toLowerCase() : "";
    if (binaryExtensions.has(ext)) {
      continue;
    }

    const buffer = readGoldenFixtureFile(fileEntry.path);
    assert.equal(
      buffer.includes("\r\n"),
      false,
      `Fixture text file ${fileEntry.path} contains CRLF (\\r\\n). Must be normalized to LF (\\n).`,
    );
  }
});

test("readGoldenFixtureFile prevents directory traversal attempts", () => {
  assert.throws(
    () => readGoldenFixtureFile("../manifest.json"),
    /Attempted path traversal outside golden fixture directory/,
  );
  assert.throws(
    () => readGoldenFixtureFile("../../package.json"),
    /Attempted path traversal outside golden fixture directory/,
  );
});

test("accidental mutations to pinned commit SHA are detected", () => {
  const manifest = loadGoldenFixtureManifest();
  const alteredCommit = "1111111111111111111111111111111111111111";

  assert.notEqual(
    manifest.pinnedCommitSha,
    alteredCommit,
    "Altered commit SHA must not equal the pinned commit",
  );
  assert.equal(
    manifest.pinnedCommitSha === GOLDEN_FIXTURE_PINNED_SHA,
    true,
    "Manifest pinned commit SHA must match GOLDEN_FIXTURE_PINNED_SHA constant exactly",
  );
});
