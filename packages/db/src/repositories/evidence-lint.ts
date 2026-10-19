import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface EvidenceLintViolation {
  filePath: string;
  functionName: string;
  line: number;
  message: string;
  conclusionType?: "graph_node" | "graph_edge" | "impact_finding" | "composite";
}

export interface EvidenceLintResult {
  success: boolean;
  violations: readonly EvidenceLintViolation[];
  scannedFilesCount: number;
}

export const DEFAULT_CONCLUSION_WRITE_TARGETS = [
  "packages/db/src/repositories/graph.ts",
  "packages/db/src/repositories/impact-analysis.ts",
  "apps/workers/src/builder/graph-builder.ts",
  "apps/workers/src/pull-request/impact-handler.ts",
];

export const DEFAULT_GRAPH_WRITE_TARGETS = DEFAULT_CONCLUSION_WRITE_TARGETS;

function findWorkspaceRoot(startDir: string): string {
  let curr = path.resolve(startDir);
  while (curr && curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return startDir;
}

/**
 * Static architectural linter for Fluxora Evidence Completeness (Global Step 29 & Step 48).
 * Inspects all conclusion-producing source files to enforce that all graph and impact write paths
 * pass through or invoke the Evidence Writer abstraction.
 */
export function verifyGraphWritePaths(
  filePaths?: readonly string[],
  rootDirectory: string = process.cwd(),
): EvidenceLintResult {
  const resolvedRoot = findWorkspaceRoot(rootDirectory);
  const targets = filePaths ?? DEFAULT_CONCLUSION_WRITE_TARGETS;
  const violations: EvidenceLintViolation[] = [];
  let scannedFilesCount = 0;

  for (const relativePath of targets) {
    const fullPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(resolvedRoot, relativePath);

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
 * Inspects a TypeScript SourceFile AST for evidence architectural compliance.
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
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      checkFunctionForEvidenceCompliance(node, sourceFile, filePath, violations);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
}

function checkFunctionForEvidenceCompliance(
  node:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: EvidenceLintViolation[],
): void {
  let funcName = "anonymous";
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    funcName = node.name.text;
  } else if (
    node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    funcName = node.parent.name.text;
  } else if (
    node.parent &&
    ts.isPropertyAssignment(node.parent) &&
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

  const writesImpactAnalyses =
    funcText.includes("INSERT INTO impact_analyses") ||
    funcText.includes("saveImpactAnalysis") ||
    funcText.includes("saveImpactAnalysisTx") ||
    funcText.includes("persistPullRequestImpactAnalysis");

  const createsGraphRecords = writesGraphNodes || writesGraphEdges;
  const createsImpactRecords = writesImpactAnalyses;

  if (!createsGraphRecords && !createsImpactRecords) {
    return;
  }

  const usesEvidenceWriter =
    funcText.includes("EvidenceWriter") ||
    funcText.includes("writeEvidence") ||
    funcText.includes("writeEvidenceBatch") ||
    funcText.includes("writeEvidenceBatchTx") ||
    funcText.includes("writeEvidenceSingleTx") ||
    funcText.includes("createNodeEvidence") ||
    funcText.includes("createEdgeEvidence") ||
    funcText.includes("createImpactFindingEvidence") ||
    funcText.includes("createEvidenceInput") ||
    funcText.includes("persistGraphBuild") ||
    funcText.includes("buildAndPersistGraph") ||
    funcText.includes("buildGraphProjection") ||
    funcText.includes("saveImpactAnalysis") ||
    funcText.includes("saveImpactAnalysisTx") ||
    funcText.includes("persistPullRequestImpactAnalysis") ||
    funcText.includes("deps.persistAnalysis") ||
    funcText.includes("persistAnalysis");

  if (!usesEvidenceWriter) {
    const lineAndChar = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const line = lineAndChar.line + 1;

    let conclusionType: EvidenceLintViolation["conclusionType"] = "composite";
    let typeDescription = "conclusion";
    if (createsImpactRecords && !createsGraphRecords) {
      conclusionType = "impact_finding";
      typeDescription = "impact analysis conclusions (impact findings)";
    } else if (writesGraphEdges && !writesGraphNodes) {
      conclusionType = "graph_edge";
      typeDescription = "graph edges";
    } else if (writesGraphNodes && !writesGraphEdges) {
      conclusionType = "graph_node";
      typeDescription = "graph nodes";
    } else {
      conclusionType = "composite";
      typeDescription = "graph / impact conclusions";
    }

    violations.push({
      filePath,
      functionName: funcName,
      line,
      conclusionType,
      message: `Function "${funcName}" in ${filePath}:${line} performs ${typeDescription} writes but does not invoke EvidenceWriter. All conclusion-write paths must use EvidenceWriter to guarantee provenance and atomicity. Fix: Delegate evidence construction or persistence to EvidenceWriter (e.g. EvidenceWriter.createNodeEvidence, EvidenceWriter.createEdgeEvidence, EvidenceWriter.createImpactFindingEvidence).`,
    });
  }
}
