import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { GoldenFixtureManifest } from "@fluxora/shared-types";

export const GOLDEN_FIXTURE_ID = "golden-taxonomy-v1" as const;
export const GOLDEN_FIXTURE_REPO_URL = "https://github.com/shadcn-ui/taxonomy" as const;
export const GOLDEN_FIXTURE_REPO_FULL_NAME = "shadcn-ui/taxonomy" as const;
export const GOLDEN_FIXTURE_REPO_NAME = "taxonomy" as const;
export const GOLDEN_FIXTURE_PINNED_SHA = "298a8857c7128a0d121e7f699dfd729f23b3966d" as const;
export const GOLDEN_FIXTURE_SOURCE_BRANCH = "main" as const;

/**
 * Resolves path to the golden fixture root directory and manifest.json.
 */
function findWorkspaceRoot(startDir: string): string {
  let curr = startDir;
  while (true) {
    if (existsSync(path.join(curr, "pnpm-workspace.yaml")) || existsSync(path.join(curr, "fixtures", "golden", "manifest.json"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      break;
    }
    curr = parent;
  }
  return startDir;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = findWorkspaceRoot(moduleDir);

export const GOLDEN_FIXTURE_DIR = path.resolve(workspaceRoot, "fixtures/golden/taxonomy");
export const GOLDEN_FIXTURE_MANIFEST_PATH = path.resolve(workspaceRoot, "fixtures/golden/manifest.json");

export function loadGoldenFixtureManifest(): GoldenFixtureManifest {
  if (!existsSync(GOLDEN_FIXTURE_MANIFEST_PATH)) {
    throw new Error(`Golden fixture manifest not found at ${GOLDEN_FIXTURE_MANIFEST_PATH}`);
  }
  const raw = readFileSync(GOLDEN_FIXTURE_MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as GoldenFixtureManifest;
}

export function getGoldenFixtureRootPath(): string {
  if (!existsSync(GOLDEN_FIXTURE_DIR)) {
    throw new Error(`Golden fixture root directory not found at ${GOLDEN_FIXTURE_DIR}`);
  }
  return GOLDEN_FIXTURE_DIR;
}

export function readGoldenFixtureFile(relativePath: string): Buffer {
  const normalized = relativePath.replace(/\\/g, "/");
  const fullPath = path.resolve(GOLDEN_FIXTURE_DIR, normalized);
  if (!fullPath.startsWith(GOLDEN_FIXTURE_DIR)) {
    throw new Error(`Attempted path traversal outside golden fixture directory: ${relativePath}`);
  }
  if (!existsSync(fullPath)) {
    throw new Error(`Golden fixture file not found: ${relativePath}`);
  }
  return readFileSync(fullPath);
}

export function readGoldenFixtureFileText(relativePath: string): string {
  return readGoldenFixtureFile(relativePath).toString("utf8");
}

