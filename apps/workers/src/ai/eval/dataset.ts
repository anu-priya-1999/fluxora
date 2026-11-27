/**
 * @file dataset.ts
 * Versioned evaluation dataset and adversarial fixture loaders with SHA-256 integrity hashing.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdversarialInjectionFixture,
  AIEvalDataset,
} from "./types.ts";

function findWorkspaceRoot(startDir: string): string {
  let curr = startDir;
  while (true) {
    if (
      existsSync(path.join(curr, "pnpm-workspace.yaml")) ||
      existsSync(path.join(curr, "fixtures", "golden", "manifest.json"))
    ) {
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

export const AI_EVAL_DATASET_PATH = path.resolve(
  workspaceRoot,
  "fixtures/golden/ai-eval-dataset.json",
);
export const ADVERSARIAL_FIXTURE_PATH = path.resolve(
  workspaceRoot,
  "fixtures/golden/adversarial-injection-fixture.json",
);
export const AI_EVAL_BASELINE_PATH = path.resolve(
  workspaceRoot,
  "fixtures/golden/ai-eval-baseline.json",
);

export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function loadAIEvalDataset(datasetPath = AI_EVAL_DATASET_PATH): {
  readonly dataset: AIEvalDataset;
  readonly sha256: string;
} {
  if (!existsSync(datasetPath)) {
    throw new Error(`AI evaluation dataset not found at ${datasetPath}`);
  }
  const raw = readFileSync(datasetPath, "utf8");
  const dataset = JSON.parse(raw) as AIEvalDataset;
  return {
    dataset,
    sha256: computeSha256(raw),
  };
}

export function loadAdversarialInjectionFixture(
  fixturePath = ADVERSARIAL_FIXTURE_PATH,
): {
  readonly fixture: AdversarialInjectionFixture;
  readonly sha256: string;
} {
  if (!existsSync(fixturePath)) {
    throw new Error(`Adversarial injection fixture not found at ${fixturePath}`);
  }
  const raw = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(raw) as AdversarialInjectionFixture;
  return {
    fixture,
    sha256: computeSha256(raw),
  };
}
