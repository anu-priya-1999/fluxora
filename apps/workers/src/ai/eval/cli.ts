/**
 * @file cli.ts
 * CLI entrypoint for running the Fluxora AI Evaluation Suite (`pnpm eval:ai`).
 *
 * Modes:
 * - Default (`--mode=ci_mock`): Offline deterministic CI evaluation using MockModelProvider.
 * - Opt-in live (`--mode=live`): Requires USE_REAL_LLM=true and ANTHROPIC_API_KEY.
 */

import { writeFileSync } from "node:fs";

import { buildBaselineFromReport, saveAIEvalBaseline } from "./baseline.ts";
import { runAIEvaluationSuite } from "./runner.ts";
import type { EvaluationMode } from "./types.ts";

function parseArgs(argv: readonly string[]): {
  mode: EvaluationMode;
  outPath?: string | undefined;
  updateBaseline: boolean;
} {
  let mode: EvaluationMode = "ci_mock";
  let outPath: string | undefined;
  let updateBaseline = false;

  for (const arg of argv) {
    if (arg === "--mode=live" || arg === "--live") {
      mode = "live";
    } else if (arg === "--mode=ci_mock" || arg === "--ci") {
      mode = "ci_mock";
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
    } else if (arg === "--update-baseline") {
      updateBaseline = true;
    }
  }

  return { mode, outPath, updateBaseline };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAIEvaluationSuite({ mode: args.mode });

  if (args.outPath) {
    writeFileSync(args.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (args.updateBaseline) {
    const baseline = buildBaselineFromReport(
      report,
      args.mode === "live"
        ? "Live model baseline recorded via --update-baseline."
        : "Deterministic CI mock harness baseline recorded via --update-baseline (not a live Claude quality baseline).",
    );
    saveAIEvalBaseline(baseline, { approved: true });
    console.log("Updated AI evaluation baseline.");
  }

  console.log(
    JSON.stringify(
      {
        reportVersion: report.reportVersion,
        mode: report.mode,
        modelIdentity: report.modelIdentity,
        datasetVersion: report.datasetVersion,
        totalCases: report.totalCases,
        overallGateStatus: report.overallGateStatus,
        overallMetrics: report.overallMetrics,
        adversarialAllPassed: report.adversarialSummary.allPassed,
        releaseGates: report.releaseGates,
      },
      null,
      2,
    ),
  );

  if (report.overallGateStatus === "fail") {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const sanitized = msg
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");
  console.error(`[eval:ai] Evaluation failed: ${sanitized}`);
  process.exitCode = 1;
});
