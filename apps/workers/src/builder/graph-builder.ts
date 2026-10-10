import type {
  CreateEvidenceInput,
  CreateGraphEdgeInput,
  CreateGraphNodeInput,
  GraphEdgeType,
  GraphNodeType,
  GraphBuilderOptions,
  GraphBuilderStatistics,
  GraphProjectionResult,
  PersistedGraphResult,
  SourceLocation,
} from "@fluxora/shared-types";
import { EvidenceWriter, persistGraphBuild } from "@fluxora/db";

/**
 * Deterministically computes a valid UUID v4 formatted string from a seed string using SHA-256.
 */
export function generateDeterministicUuid(seed: string): string {
  return EvidenceWriter.generateDeterministicUuid(seed);
}

/**
 * Pure, deterministic Graph Projection function.
 * Transforms normalized Phase 3 intelligence into GraphNode, GraphEdge, and Evidence inputs.
 * No database dependency. 100% testable in memory.
 */
export function buildGraphProjection(
  options: GraphBuilderOptions,
): GraphProjectionResult {
  const { organizationId, analysisRunId, normalizedResult } = options;

  const nodeMap = new Map<string, CreateGraphNodeInput>();
  const evidence: CreateEvidenceInput[] = [];

  let symbolNodesCount = 0;
  let moduleNodesCount = 0;
  let routeNodesCount = 0;
  let eventNodesCount = 0;
  let databaseNodesCount = 0;

  let importEdgesCount = 0;
  let routeEdgesCount = 0;
  let eventEdgesCount = 0;
  let databaseEdgesCount = 0;
  let resolveEdgesCount = 0;
  let rejectedEdgesCount = 0;

  // Helper to retrieve or create a GraphNode input
  function getOrCreateNode(
    canonicalId: string,
    nodeType: GraphNodeType,
    name: string,
    path: string | null,
    metadata: Record<string, unknown>,
    confidence = 1.0,
  ): CreateGraphNodeInput {
    const existing = nodeMap.get(canonicalId);
    if (existing) {
      return existing;
    }

    const id = EvidenceWriter.generateDeterministicUuid(
      `${analysisRunId}:node:${canonicalId}`,
    );
    const nodeInput: CreateGraphNodeInput = {
      id,
      organizationId,
      analysisRunId,
      canonicalId,
      nodeType,
      name,
      path: path ? path.trim() : null,
      metadata,
      confidence,
    };

    nodeMap.set(canonicalId, nodeInput);

    if (nodeType === "module") moduleNodesCount++;
    else if (nodeType === "symbol") symbolNodesCount++;
    else if (nodeType === "api") routeNodesCount++;
    else if (nodeType === "event") eventNodesCount++;
    else if (nodeType === "database") databaseNodesCount++;

    return nodeInput;
  }

  // Helper to add node evidence via EvidenceWriter
  function addNodeEvidence(
    node: CreateGraphNodeInput,
    filePath: string,
    description: string,
    location?: SourceLocation,
    symbolId?: string | null,
  ) {
    const evRecord = EvidenceWriter.createNodeEvidence(
      organizationId,
      analysisRunId,
      node,
      filePath,
      description,
      location,
      symbolId,
    );
    if (evRecord) {
      evidence.push(evRecord);
    }
  }

  // 1. Collect and create Module Nodes from all file references in normalized result
  const filePathsSet = new Set<string>();
  for (const edge of normalizedResult.moduleEdges) {
    if (edge.sourceFile) filePathsSet.add(edge.sourceFile);
    if (edge.targetFile) filePathsSet.add(edge.targetFile);
  }
  for (const sym of normalizedResult.symbols) {
    if (sym.relativePath) filePathsSet.add(sym.relativePath);
  }
  for (const route of normalizedResult.routes) {
    if (route.filePath) filePathsSet.add(route.filePath);
  }
  for (const ev of normalizedResult.events) {
    if (ev.filePath) filePathsSet.add(ev.filePath);
  }
  for (const dbRef of normalizedResult.databaseReferences) {
    if (dbRef.filePath) filePathsSet.add(dbRef.filePath);
  }

  const sortedFilePaths = Array.from(filePathsSet).sort();
  for (const filePath of sortedFilePaths) {
    const modCanonicalId = `mod:${filePath}`;
    const modNode = getOrCreateNode(
      modCanonicalId,
      "module",
      filePath,
      filePath,
      { path: filePath },
    );
    addNodeEvidence(
      modNode,
      filePath,
      `Module declaration for file ${filePath}`,
    );
  }

  // 2. Create Symbol Nodes
  const sortedSymbols = Array.from(normalizedResult.symbols).sort((a, b) =>
    a.canonicalId.localeCompare(b.canonicalId),
  );
  for (const sym of sortedSymbols) {
    const symNode = getOrCreateNode(
      sym.canonicalId,
      "symbol",
      sym.name,
      sym.relativePath,
      {
        kind: sym.kind,
        exported: sym.exported,
        aliases: sym.aliases,
        provenance: sym.provenance,
        ...(sym.metadata ?? {}),
      },
    );
    addNodeEvidence(
      symNode,
      sym.relativePath,
      `Declared symbol "${sym.name}" of kind "${sym.kind}"`,
      sym.location,
      sym.canonicalId,
    );
  }

  // 3. Create Route Nodes
  const sortedRoutes = Array.from(normalizedResult.routes).sort((a, b) =>
    a.canonicalId.localeCompare(b.canonicalId),
  );
  for (const route of sortedRoutes) {
    const name = `${route.httpMethods.join(",") || "ROUTE"} ${route.routePath}`;
    const routeNode = getOrCreateNode(
      route.canonicalId,
      "api",
      name,
      route.filePath,
      {
        framework: route.framework,
        routeType: route.routeType,
        httpMethods: route.httpMethods,
        routePath: route.routePath,
        canonicalSymbolId: route.canonicalSymbolId ?? null,
      },
    );
    addNodeEvidence(
      routeNode,
      route.filePath,
      `API route handler "${route.routePath}" (${route.httpMethods.join(",")})`,
      route.sourceLocation,
      route.canonicalSymbolId ?? null,
    );
  }

  // 4. Create Event Nodes
  const sortedEvents = Array.from(normalizedResult.events).sort((a, b) =>
    a.canonicalId.localeCompare(b.canonicalId),
  );
  for (const ev of sortedEvents) {
    const name = `${ev.role}:${ev.family}:${ev.details.eventName || ev.methodShape}`;
    const evNode = getOrCreateNode(
      ev.canonicalId,
      "event",
      name,
      ev.filePath,
      {
        role: ev.role,
        family: ev.family,
        methodShape: ev.methodShape,
        details: ev.details,
        canonicalSymbolId: ev.canonicalSymbolId ?? null,
      },
    );
    addNodeEvidence(
      evNode,
      ev.filePath,
      `Event pattern ${ev.role} (${ev.family})`,
      ev.sourceLocation,
      ev.canonicalSymbolId ?? null,
    );
  }

  // 5. Create Database Reference Nodes
  const sortedDbRefs = Array.from(
    normalizedResult.databaseReferences,
  ).sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  for (const dbRef of sortedDbRefs) {
    const name = `${dbRef.family}:${dbRef.operation}:${dbRef.details.resourceName || dbRef.methodShape}`;
    const dbNode = getOrCreateNode(
      dbRef.canonicalId,
      "database",
      name,
      dbRef.filePath,
      {
        family: dbRef.family,
        operation: dbRef.operation,
        methodShape: dbRef.methodShape,
        details: dbRef.details,
        canonicalSymbolId: dbRef.canonicalSymbolId ?? null,
      },
    );
    addNodeEvidence(
      dbNode,
      dbRef.filePath,
      `Database reference ${dbRef.operation} (${dbRef.family})`,
      dbRef.sourceLocation,
      dbRef.canonicalSymbolId ?? null,
    );
  }

  // 6. Build Graph Edges with Invariant Validation
  const edgeMap = new Map<string, CreateGraphEdgeInput>();

  function addEdge(
    sourceCanonicalId: string,
    targetCanonicalId: string,
    edgeType: GraphEdgeType,
    canonicalId: string,
    metadata: Record<string, unknown>,
    location?: SourceLocation,
    filePath?: string,
    description?: string,
  ) {
    const sourceNode = nodeMap.get(sourceCanonicalId);
    const targetNode = nodeMap.get(targetCanonicalId);

    // INVARIANT: both source and target nodes MUST exist in nodeMap!
    if (!sourceNode || !targetNode || !sourceNode.id || !targetNode.id) {
      rejectedEdgesCount++;
      return;
    }

    const edgeKey = `${sourceNode.id}:${targetNode.id}:${edgeType}`;
    if (edgeMap.has(edgeKey)) {
      return;
    }

    const edgeId = generateDeterministicUuid(
      `${analysisRunId}:edge:${sourceCanonicalId}->${targetCanonicalId}:${edgeType}`,
    );
    const edgeInput: CreateGraphEdgeInput = {
      id: edgeId,
      organizationId,
      analysisRunId,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      edgeType,
      canonicalId,
      metadata,
      confidence: 1.0,
      provenance: "static-analysis",
    };

    edgeMap.set(edgeKey, edgeInput);

    if (edgeType === "IMPORTS") importEdgesCount++;
    else if (edgeType === "EXPOSES_ROUTE") routeEdgesCount++;
    else if (edgeType === "EMITS_EVENT" || edgeType === "CONSUMES_EVENT") eventEdgesCount++;
    else if (edgeType === "QUERIES_DB" || edgeType === "WRITES") databaseEdgesCount++;
    else if (edgeType === "RESOLVES_TO") resolveEdgesCount++;

    // Edge Evidence via EvidenceWriter
    const evFilePath = filePath || sourceNode.path || "unknown";
    const evDesc =
      description ||
      `Edge ${edgeType} from ${sourceCanonicalId} to ${targetCanonicalId}`;
    const evSymbolId = sourceCanonicalId.startsWith("sym:")
      ? sourceCanonicalId
      : null;

    const evRecord = EvidenceWriter.createEdgeEvidence(
      organizationId,
      analysisRunId,
      edgeInput,
      evFilePath,
      evDesc,
      location,
      evSymbolId,
    );
    if (evRecord) {
      evidence.push(evRecord);
    }
  }

  // Process Module Edges
  const sortedModuleEdges = Array.from(normalizedResult.moduleEdges).sort(
    (a, b) => a.canonicalId.localeCompare(b.canonicalId),
  );
  for (const edge of sortedModuleEdges) {
    const sourceCanonicalId = `mod:${edge.sourceFile}`;
    if (edge.targetFile) {
      const targetCanonicalId = `mod:${edge.targetFile}`;
      addEdge(
        sourceCanonicalId,
        targetCanonicalId,
        "IMPORTS",
        edge.canonicalId,
        {
          importKind: edge.importKind,
          edgeKind: edge.edgeKind,
          specifier: edge.specifier,
          names: edge.names,
          resolutionStatus: edge.resolutionStatus,
        },
        edge.location,
        edge.sourceFile,
        `Import reference from ${edge.sourceFile} to ${edge.targetFile}`,
      );
    }

    if (edge.resolvedSymbolIds) {
      for (const symId of edge.resolvedSymbolIds) {
        addEdge(
          sourceCanonicalId,
          symId,
          "IMPORTS",
          `edge:sym:${edge.canonicalId}->${symId}`,
          { importKind: edge.importKind, specifier: edge.specifier },
          edge.location,
          edge.sourceFile,
          `Import resolved symbol ${symId}`,
        );
      }
    }
  }

  // Process Symbol Containment & Parent Symbol Edges
  for (const sym of sortedSymbols) {
    const modCanonicalId = `mod:${sym.relativePath}`;
    addEdge(
      modCanonicalId,
      sym.canonicalId,
      "RESOLVES_TO",
      `edge:mod-sym:${sym.canonicalId}`,
      { kind: sym.kind, name: sym.name },
      sym.location,
      sym.relativePath,
      `Module contains symbol ${sym.name}`,
    );

    if (sym.parentSymbolId) {
      addEdge(
        sym.parentSymbolId,
        sym.canonicalId,
        "RESOLVES_TO",
        `edge:parent-sym:${sym.parentSymbolId}->${sym.canonicalId}`,
        { kind: sym.kind, name: sym.name },
        sym.location,
        sym.relativePath,
        `Parent symbol contains ${sym.name}`,
      );
    }
  }

  // Process Route Edges
  for (const route of sortedRoutes) {
    const modCanonicalId = `mod:${route.filePath}`;
    addEdge(
      modCanonicalId,
      route.canonicalId,
      "EXPOSES_ROUTE",
      `edge:route:${route.canonicalId}`,
      { routePath: route.routePath, httpMethods: route.httpMethods },
      route.sourceLocation,
      route.filePath,
      `Module exposes route ${route.routePath}`,
    );

    if (route.canonicalSymbolId) {
      addEdge(
        route.canonicalId,
        route.canonicalSymbolId,
        "RESOLVES_TO",
        `edge:route-handler:${route.canonicalId}->${route.canonicalSymbolId}`,
        { symbolName: route.symbolName },
        route.sourceLocation,
        route.filePath,
        `Route resolves to handler symbol ${route.symbolName}`,
      );
    }
  }

  // Process Event Edges
  for (const ev of sortedEvents) {
    const modCanonicalId = `mod:${ev.filePath}`;
    if (ev.role === "producer") {
      addEdge(
        modCanonicalId,
        ev.canonicalId,
        "EMITS_EVENT",
        `edge:event:${ev.canonicalId}`,
        { family: ev.family, details: ev.details },
        ev.sourceLocation,
        ev.filePath,
        `Module emits event ${ev.details.eventName || ev.methodShape}`,
      );
      if (ev.canonicalSymbolId) {
        addEdge(
          ev.canonicalSymbolId,
          ev.canonicalId,
          "EMITS_EVENT",
          `edge:event-sym:${ev.canonicalId}`,
          { family: ev.family },
          ev.sourceLocation,
          ev.filePath,
          `Symbol emits event ${ev.details.eventName || ev.methodShape}`,
        );
      }
    } else if (ev.role === "consumer") {
      addEdge(
        ev.canonicalId,
        modCanonicalId,
        "CONSUMES_EVENT",
        `edge:event:${ev.canonicalId}`,
        { family: ev.family, details: ev.details },
        ev.sourceLocation,
        ev.filePath,
        `Module consumes event ${ev.details.eventName || ev.methodShape}`,
      );
      if (ev.canonicalSymbolId) {
        addEdge(
          ev.canonicalId,
          ev.canonicalSymbolId,
          "CONSUMES_EVENT",
          `edge:event-sym:${ev.canonicalId}`,
          { family: ev.family },
          ev.sourceLocation,
          ev.filePath,
          `Event invokes handler symbol`,
        );
      }
    }
  }

  // Process Database Reference Edges
  for (const dbRef of sortedDbRefs) {
    const isMutation =
      dbRef.operation === "insert" ||
      dbRef.operation === "update" ||
      dbRef.operation === "delete" ||
      dbRef.operation === "upsert";
    const edgeType: GraphEdgeType = isMutation ? "WRITES" : "QUERIES_DB";
    const sourceCanonicalId =
      dbRef.canonicalSymbolId && nodeMap.has(dbRef.canonicalSymbolId)
        ? dbRef.canonicalSymbolId
        : `mod:${dbRef.filePath}`;

    addEdge(
      sourceCanonicalId,
      dbRef.canonicalId,
      edgeType,
      `edge:db:${dbRef.canonicalId}`,
      { family: dbRef.family, operation: dbRef.operation, details: dbRef.details },
      dbRef.sourceLocation,
      dbRef.filePath,
      `Database ${dbRef.operation} operation on ${dbRef.details.resourceName || dbRef.family}`,
    );
  }

  // Process Export Resolution Edges
  const sortedResolutions = Array.from(
    normalizedResult.exportResolutions,
  ).sort((a, b) => {
    const keyA = `${a.exportingFile}:${a.exportName}`;
    const keyB = `${b.exportingFile}:${b.exportName}`;
    return keyA.localeCompare(keyB);
  });
  for (const res of sortedResolutions) {
    if (res.status === "resolved" && res.canonicalSymbolId) {
      const modCanonicalId = `mod:${res.exportingFile}`;
      addEdge(
        modCanonicalId,
        res.canonicalSymbolId,
        "RESOLVES_TO",
        `edge:export:${res.exportingFile}:${res.exportName}->${res.canonicalSymbolId}`,
        { exportName: res.exportName, isReExport: res.isReExport, chain: res.resolutionChain },
        undefined,
        res.exportingFile,
        `Export "${res.exportName}" resolves to symbol ${res.canonicalSymbolId}`,
      );
    }
  }

  // 7. Sort nodes, edges, and evidence deterministically
  const nodes = Array.from(nodeMap.values()).sort((a, b) =>
    a.canonicalId.localeCompare(b.canonicalId),
  );

  const edges = Array.from(edgeMap.values()).sort((a, b) => {
    const keyA = `${a.sourceNodeId}:${a.targetNodeId}:${a.edgeType}`;
    const keyB = `${b.sourceNodeId}:${b.targetNodeId}:${b.edgeType}`;
    return keyA.localeCompare(keyB);
  });

  evidence.sort((a, b) => {
    const keyA = `${a.subjectType}:${a.subjectId}:${a.filePath}:${a.relationshipDescription}`;
    const keyB = `${b.subjectType}:${b.subjectId}:${b.filePath}:${b.relationshipDescription}`;
    return keyA.localeCompare(keyB);
  });

  const statistics: GraphBuilderStatistics = {
    totalNodes: nodes.length,
    symbolNodes: symbolNodesCount,
    moduleNodes: moduleNodesCount,
    routeNodes: routeNodesCount,
    eventNodes: eventNodesCount,
    databaseNodes: databaseNodesCount,
    totalEdges: edges.length,
    importEdges: importEdgesCount,
    routeEdges: routeEdgesCount,
    eventEdges: eventEdgesCount,
    databaseEdges: databaseEdgesCount,
    resolveEdges: resolveEdgesCount,
    totalEvidenceRecords: evidence.length,
    rejectedEdgesCount,
  };

  return {
    nodes,
    edges,
    evidence,
    statistics,
  };
}

/**
 * Builds and persists the Graph Projection atomically to PostgreSQL inside a single transaction.
 */
export async function buildAndPersistGraph(
  pool: Parameters<typeof persistGraphBuild>[0],
  options: GraphBuilderOptions,
): Promise<PersistedGraphResult> {
  const projection = buildGraphProjection(options);

  const persisted = await persistGraphBuild(pool, {
    organizationId: options.organizationId,
    analysisRunId: options.analysisRunId,
    nodes: projection.nodes,
    edges: projection.edges,
    evidence: projection.evidence,
  });

  return {
    nodes: persisted.nodes,
    edges: persisted.edges,
    evidence: persisted.evidence,
    statistics: projection.statistics,
  };
}

