import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface EvidenceLintViolation {
  filePath: string;
  functionName: string;
  line: number;
  message: string;
}

export interface EvidenceLintResult {
  success: boolean;
  violations: readonly EvidenceLintViolation[];
  scannedFilesCount: number;
}

const DEFAULT_GRAPH_WRITE_TARGETS = [
  "packages/db/src/repositories/graph.ts",
  "apps/workers/src/builder/graph-builder.ts",
];

/**
 * Static architectural linter for Global Step 29.
 * Inspects graph-write source files to enforce that all graph-write paths
 * pass through or invoke the Evidence Writer abstraction.
 */
export function verifyGraphWritePaths(
  filePaths?: readonly string[],
  rootDirectory: string = process.cwd(),
): EvidenceLintResult {
  const targets = filePaths ?? DEFAULT_GRAPH_WRITE_TARGETS;
  const violations: EvidenceLintViolation[] = [];
  let scannedFilesCount = 0;

  for (const relativePath of targets) {
    const fullPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(rootDirectory, relativePath);

    if (!fs.existsSync(fullPath)) {
      continue;
    }

    scannedFilesCount++;
    const content = fs.readFileSync(fullPath, "utf-8");
    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    inspectSourceFile(sourceFile, relativePath, violations);
  }

  return {
    success: violations.length === 0,
    violations,
    scannedFilesCount,
  };
}

/**
 * Inspects a TypeScript SourceFile AST for graph-write evidence architectural compliance.
 */
export function inspectSourceContent(
  filePath: string,
  content: string,
): readonly EvidenceLintViolation[] {
  const violations: EvidenceLintViolation[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  inspectSourceFile(sourceFile, filePath, violations);
  return violations;
}

function inspectSourceFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: EvidenceLintViolation[],
): void {
  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      checkFunctionForEvidenceCompliance(node, sourceFile, filePath, violations);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
}

function checkFunctionForEvidenceCompliance(
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: EvidenceLintViolation[],
): void {
  let funcName = "anonymous";
  if (ts.isFunctionDeclaration(node) && node.name) {
    funcName = node.name.text;
  } else if (
    node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    funcName = node.parent.name.text;
  }

  const funcText = node.getText(sourceFile);

  const writesGraphNodes =
    funcText.includes("INSERT INTO graph_nodes") ||
    funcText.includes("createGraphNode") ||
    funcText.includes("batchCreateGraphNodes") ||
    funcText.includes("nodeMap.set");

  const writesGraphEdges =
    funcText.includes("INSERT INTO graph_edges") ||
    funcText.includes("createGraphEdge") ||
    funcText.includes("batchCreateGraphEdges") ||
    funcText.includes("edgeMap.set");

  const createsGraphRecords = writesGraphNodes || writesGraphEdges;

  if (!createsGraphRecords) {
    return;
  }

  const usesEvidenceWriter =
    funcText.includes("EvidenceWriter") ||
    funcText.includes("writeEvidence") ||
    funcText.includes("writeEvidenceBatch") ||
    funcText.includes("writeEvidenceBatchTx") ||
    funcText.includes("createNodeEvidence") ||
    funcText.includes("createEdgeEvidence") ||
    funcText.includes("createEvidenceInput");

  if (!usesEvidenceWriter) {
    const lineAndChar = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const line = lineAndChar.line + 1;

    violations.push({
      filePath,
      functionName: funcName,
      line,
      message: `Function "${funcName}" performs graph writes (node/edge creation or persistence) but does not invoke EvidenceWriter. All graph-write paths must use EvidenceWriter to guarantee provenance and atomicity. Fix: Delegate evidence construction or persistence to EvidenceWriter.`,
    });
  }
}
