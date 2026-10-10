import { verifyGraphWritePaths } from "../packages/db/src/repositories/evidence-lint.ts";

function main() {
  console.log("🔍 Running Step 29 CI Evidence Lint...");
  const result = verifyGraphWritePaths();

  console.log(`Scanned ${result.scannedFilesCount} graph-write target file(s).`);

  if (result.success) {
    console.log("✅ Evidence Lint PASSED: All graph-write paths invoke EvidenceWriter.");
    process.exit(0);
  } else {
    console.error(`❌ Evidence Lint FAILED: Found ${result.violations.length} architectural violation(s):\n`);
    for (const v of result.violations) {
      console.error(`  - ${v.filePath}:${v.line} (${v.functionName}): ${v.message}`);
    }
    process.exit(1);
  }
}

main();

