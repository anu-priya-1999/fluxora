import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Historical Migration 0023 Candidate Provenance & Documentation
 *
 * Source Archive: fluxora-fix2a-review-20261026-162346.zip
 * Archived Review Session: 8f7d1140-dc1c-4e6c-9f9c-0903dc947d11
 * Candidate File: migrations/0023_job_queue_attempt_count_invariant.sql (386 lines)
 *
 * Historical Context:
 * During Fix 2A, this 386-line candidate SQL migration was formulated to enforce the invariant
 * `attempt_count <= max_attempts`, reconcile over-limit pending/running/failed/dead_letter rows,
 * and validate claim parameter bounds.
 *
 * Provenance Caveat & Non-Claim:
 * The precise SQL version originally executed in `fluxora_dev` has not been conclusively established.
 * Treat this archived 386-line version strictly as a historical candidate, not proven provenance.
 * Migration 0024 must be verified to successfully upgrade databases that were migrated using this
 * historical candidate, without modifying migrations 0001-0023 or touching `fluxora_dev`.
 */

export const HISTORICAL_0023_CANDIDATE_PROVENANCE = {
  archiveName: "fluxora-fix2a-review-20261026-162346.zip",
  archivedSessionId: "8f7d1140-dc1c-4e6c-9f9c-0903dc947d11",
  lineCount: 386,
  isProvenProvenance: false,
  status: "historical_candidate",
  description:
    "386-line candidate version of migration 0023 extracted from the Fix 2A review archive. Used as a test fixture for migration 0024 backward-compatibility verification.",
} as const;

export const historical0023CandidatePath = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "historical-0023-candidate.sql",
);

export async function loadHistorical0023CandidateSql(): Promise<string> {
  return readFile(historical0023CandidatePath, "utf8");
}
