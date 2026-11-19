import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "vitest";

import {
  GOLDEN_FIXTURE_DIR,
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_MANIFEST_PATH,
  GOLDEN_PR_FIXTURE_MANIFEST_PATH,
  GOLDEN_PR_FIXTURE_ID,
  GOLDEN_SIMULATION_FIXTURE_ID,
  GOLDEN_SIMULATION_FIXTURE_MANIFEST_PATH,
  GOLDEN_FIXTURE_PINNED_SHA,
  GOLDEN_FIXTURE_REPO_FULL_NAME,
  GOLDEN_FIXTURE_REPO_NAME,
  GOLDEN_FIXTURE_REPO_URL,
  GOLDEN_FIXTURE_SOURCE_BRANCH,
  getGoldenFixtureRootPath,
  loadGoldenFixtureManifest,
  loadGoldenPullRequestManifest,
  loadGoldenSimulationExpectationManifest,
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

test("golden PR impact manifest exists, can be loaded, and matches canonical PR fixture schema", () => {
  assert.ok(existsSync(GOLDEN_PR_FIXTURE_MANIFEST_PATH), "PR manifest file must exist on disk");
  const prManifest = loadGoldenPullRequestManifest();

  assert.equal(prManifest.fixtureId, GOLDEN_PR_FIXTURE_ID);
  assert.equal(prManifest.pullRequestNumber, 42);
  assert.equal(prManifest.analysisRunCommitSha, GOLDEN_FIXTURE_PINNED_SHA);
  assert.equal(prManifest.traversalDirection, "both");
  assert.equal(prManifest.maxDepth, 2);
  assert.equal(prManifest.decayFactor, 0.9);

  // Assert expected changed files
  assert.deepEqual(prManifest.expectedChangedFiles, [
    "content/docs/billing.mdx",
    "lib/subscription.ts",
  ]);

  // Assert unresolved files
  assert.deepEqual(prManifest.expectedUnresolvedFiles, [
    "content/docs/billing.mdx",
  ]);

  // Assert seed node canonical IDs
  assert.deepEqual(prManifest.expectedSeedCanonicalIds, [
    "sym:lib/subscription.ts#function:getUserSubscriptionPlan:197",
  ]);

  // Assert direct impact canonical IDs (4 modules)
  assert.equal(prManifest.expectedDirectImpactCanonicalIds.length, 4);
  assert.deepEqual(prManifest.expectedDirectImpactCanonicalIds, [
    "mod:app/(dashboard)/dashboard/billing/page.tsx",
    "mod:app/api/posts/route.ts",
    "mod:app/api/users/stripe/route.ts",
    "mod:lib/subscription.ts",
  ]);

  // Assert one-hop downstream impact canonical IDs (45 nodes)
  assert.equal(prManifest.expectedOneHopDownstreamCanonicalIds.length, 45);

  // Assert affected APIs (3 routes)
  assert.deepEqual(prManifest.expectedAffectedApiNames, [
    "GET /api/posts",
    "GET /api/users/stripe",
    "POST /api/posts",
  ]);

  // Assert unaffected canonical IDs
  assert.ok(prManifest.expectedUnaffectedCanonicalIds.length > 0);
  assert.ok(prManifest.expectedUnaffectedCanonicalIds.includes("route:app/api/og/route.tsx#app-router-handler:GET:/api/og:238"));
  assert.ok(prManifest.expectedUnaffectedCanonicalIds.includes("mod:components/site-footer.tsx"));

  // Assert PR fixture payload structure
  const { prFixture } = prManifest;
  assert.equal(prFixture.repositoryFullName, GOLDEN_FIXTURE_REPO_FULL_NAME);
  assert.equal(prFixture.repositoryName, GOLDEN_FIXTURE_REPO_NAME);
  assert.equal(prFixture.baseSha, GOLDEN_FIXTURE_PINNED_SHA);
  assert.equal(prFixture.changedFiles.length, 2);
  assert.ok(prFixture.provenance.sourceRepo.length > 0);
  assert.ok(prFixture.provenance.derivedFrom.length > 0);
  assert.ok(prFixture.provenance.verificationMethod.length > 0);
});

test("golden simulation expectation manifest exists, can be loaded, and matches canonical simulation schema", () => {
  assert.ok(
    existsSync(GOLDEN_SIMULATION_FIXTURE_MANIFEST_PATH),
    "simulation manifest file must exist on disk",
  );
  const simManifest = loadGoldenSimulationExpectationManifest();

  // Fixture identity & pinned commit
  assert.equal(simManifest.fixtureId, GOLDEN_SIMULATION_FIXTURE_ID);
  assert.equal(simManifest.repositoryFullName, GOLDEN_FIXTURE_REPO_FULL_NAME);
  assert.equal(simManifest.repositoryName, GOLDEN_FIXTURE_REPO_NAME);
  assert.equal(simManifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);
  assert.ok(simManifest.description.length > 0);

  // Scenario definition
  const { scenario } = simManifest;
  assert.equal(scenario.name, "Taxonomy subscription helper unavailable");
  assert.equal(scenario.failureType, "unavailable");
  assert.equal(scenario.targetCanonicalId, "mod:lib/subscription.ts");
  assert.ok(scenario.description.length > 0);

  // Manually verified call relationship
  const rel = simManifest.manuallyVerifiedCallRelationship;
  assert.ok(rel.edgeId.length > 0);
  assert.equal(rel.callerCanonicalId, "mod:app/api/users/stripe/route.ts");
  assert.equal(rel.calleeCanonicalId, "mod:lib/subscription.ts");
  assert.equal(rel.edgeType, "CALLS");
  assert.equal(rel.invokedSymbol, "getUserSubscriptionPlan");
  assert.equal(rel.sourceFile, "app/api/users/stripe/route.ts");
  assert.equal(rel.sourceLine, 20);
  assert.equal(rel.isTestOnly, true, "Must explicitly declare test-only relationship");
  assert.equal(rel.provenance, "test-fixture-manual-verification");
  assert.equal(rel.metadata.sync, true);
  assert.equal(rel.metadata.hasFallback, "unknown");
  assert.equal(rel.metadata.hasCircuitBreaker, "unknown");

  // Verify source file exists and contains the exact snippet at the verified line
  const callerFileText = readGoldenFixtureFileText(rel.sourceFile);
  const callerLines = callerFileText.split("\n");
  assert.ok(
    callerLines.length >= rel.sourceLine,
    `Source file ${rel.sourceFile} must contain at least ${rel.sourceLine} lines`,
  );
  const actualLine = callerLines[rel.sourceLine - 1]!.trim();
  assert.equal(
    actualLine,
    rel.sourceSnippet,
    `Source snippet at line ${rel.sourceLine} does not match fixture source`,
  );
  assert.ok(
    actualLine.includes(rel.invokedSymbol),
    `Call site line must reference invoked symbol "${rel.invokedSymbol}"`,
  );

  // Verify callee file exists in golden fixture and exports invoked symbol
  const calleeFileText = readGoldenFixtureFileText("lib/subscription.ts");
  assert.ok(
    calleeFileText.includes("export async function getUserSubscriptionPlan"),
    "lib/subscription.ts must export function getUserSubscriptionPlan",
  );

  // Expected simulation results verification
  assert.equal(simManifest.expectedResults.length, 2);

  // Seed node expectation
  const seedResult = simManifest.expectedResults.find(
    (r) => r.canonicalId === "mod:lib/subscription.ts",
  );
  assert.ok(seedResult, "Expected seed result for mod:lib/subscription.ts must exist");
  assert.equal(seedResult.expectedState, "failed");
  assert.equal(seedResult.ruleApplied, "target_failure");
  assert.equal(seedResult.ruleVersion, "1.0.0");
  assert.equal(seedResult.confidence, 1.0);
  assert.equal(seedResult.capped, false);
  assert.equal(seedResult.causalPath.length, 1);
  assert.equal(seedResult.causalPath[0]!.edgeId, null);
  assert.equal(seedResult.causalPath[0]!.ruleId, "target_failure");
  assert.equal(seedResult.causalPath[0]!.previousState, "healthy");
  assert.equal(seedResult.causalPath[0]!.resultingState, "failed");

  // Propagated caller node expectation
  const callerResult = simManifest.expectedResults.find(
    (r) => r.canonicalId === "mod:app/api/users/stripe/route.ts",
  );
  assert.ok(callerResult, "Expected caller result for mod:app/api/users/stripe/route.ts must exist");
  assert.equal(callerResult.expectedState, "degraded");
  assert.equal(callerResult.ruleApplied, "CALLS+sync+no_fallback");
  assert.equal(callerResult.ruleVersion, "1.0.0");
  assert.equal(callerResult.confidence, 0.9);
  assert.equal(callerResult.capped, false);
  assert.equal(callerResult.causalPath.length, 2);
  assert.equal(callerResult.causalPath[0]!.canonicalId, "mod:lib/subscription.ts");
  assert.equal(callerResult.causalPath[1]!.canonicalId, "mod:app/api/users/stripe/route.ts");
  assert.equal(callerResult.causalPath[1]!.edgeId, rel.edgeId);
  assert.equal(callerResult.causalPath[1]!.ruleId, "CALLS+sync+no_fallback");
  assert.equal(callerResult.causalPath[1]!.previousState, "healthy");
  assert.equal(callerResult.causalPath[1]!.resultingState, "degraded");

  // Negative control verification
  assert.ok(
    simManifest.expectedUnaffectedCanonicalIds.includes("mod:components/site-footer.tsx"),
    "mod:components/site-footer.tsx must be listed as unaffected negative control",
  );
  const footerText = readGoldenFixtureFileText("components/site-footer.tsx");
  assert.ok(!footerText.includes("subscription"), "site-footer.tsx must not reference subscription");
});
