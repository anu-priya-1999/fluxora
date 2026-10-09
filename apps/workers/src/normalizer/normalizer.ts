import type {
  NormalizedAlias,
  NormalizedDatabaseReference,
  NormalizedDiagnostic,
  NormalizedEventPattern,
  NormalizedExportResolution,
  NormalizedModuleEdge,
  NormalizedProvenance,
  NormalizedRoute,
  NormalizedSymbol,
  NormalizedUnresolvedReference,
  NormalizerStatistics,
  RepositoryNormalizerInput,
  RepositoryNormalizedResult,
  SourceLocation,
} from "@fluxora/shared-types";

/**
 * Mutable internal view of normalized symbol used during resolution.
 */
interface MutableNormalizedSymbol {
  readonly canonicalId: string;
  readonly name: string;
  readonly kind: NormalizedSymbol["kind"];
  readonly relativePath: string;
  readonly location: SourceLocation;
  readonly exported: NormalizedSymbol["exported"];
  readonly parentSymbolId?: string | undefined;
  readonly parentName?: string | undefined;
  readonly metadata?: NormalizedSymbol["metadata"] | undefined;
  readonly aliases: NormalizedAlias[];
  readonly provenance: NormalizedProvenance[];
}

/**
 * Internal representation of a re-export declaration from a source file.
 */
interface ReExportItem {
  readonly sourceFile: string;
  readonly targetFile?: string | undefined;
  readonly exportName: string; // Name exported from sourceFile
  readonly importedName: string; // Name imported from targetFile ("*" for star re-export)
  readonly importKind: "named_re_export" | "star_re_export" | "namespace_re_export";
  readonly location: SourceLocation;
}

/**
 * Build a stable, deterministic canonical symbol ID.
 */
export function buildCanonicalSymbolId(
  relativePath: string,
  kind: string,
  name: string,
  startOffset: number,
  parentName?: string,
): string {
  const parentPrefix = parentName ? `${parentName}.` : "";
  return `sym:${relativePath}#${kind}:${parentPrefix}${name}:${startOffset}`;
}

/**
 * Pure, deterministic Step 25 Normalizer.
 *
 * Takes raw outputs produced by existing code-intelligence detectors (Steps 18–24)
 * and produces a canonical, deterministic representation for Step 26 and Phase 4.
 */
export function normalizeAnalysis(
  input: RepositoryNormalizerInput,
): RepositoryNormalizedResult {
  const symbolExtractions = input.symbolExtractions ?? [];
  const moduleGraph = input.moduleGraph;
  const routeResult = input.routeResult;
  const eventResult = input.eventResult;
  const databaseResult = input.databaseResult;
  const treeSitterResults = input.treeSitterResults ?? [];

  // 1. Index all input symbols by file and location/name
  let totalSymbolsInput = 0;
  const symbolMap = new Map<string, MutableNormalizedSymbol>();
  const fileExportedSymbolsMap = new Map<string, Map<string, MutableNormalizedSymbol>>();
  const fileAllSymbolsMap = new Map<string, Map<string, MutableNormalizedSymbol>>();

  for (const extraction of symbolExtractions) {
    totalSymbolsInput += extraction.symbols.length;
    const file = extraction.relativePath;

    if (!fileExportedSymbolsMap.has(file)) {
      fileExportedSymbolsMap.set(file, new Map());
    }
    if (!fileAllSymbolsMap.has(file)) {
      fileAllSymbolsMap.set(file, new Map());
    }

    const exportedMap = fileExportedSymbolsMap.get(file)!;
    const allMap = fileAllSymbolsMap.get(file)!;

    for (const sym of extraction.symbols) {
      const canonicalId = buildCanonicalSymbolId(
        sym.relativePath,
        sym.kind,
        sym.name,
        sym.location.start.offset,
        sym.parentName,
      );

      let normSym = symbolMap.get(canonicalId);
      if (!normSym) {
        normSym = {
          canonicalId,
          name: sym.name,
          kind: sym.kind,
          relativePath: sym.relativePath,
          location: sym.location,
          exported: sym.exported,
          parentSymbolId: sym.parentSymbolId,
          parentName: sym.parentName,
          metadata: sym.metadata,
          aliases: [],
          provenance: [
            {
              detector: "step-19-symbols",
              sourceId: sym.id,
              sourceFile: sym.relativePath,
            },
          ],
        };
        symbolMap.set(canonicalId, normSym);
      } else {
        normSym.provenance.push({
          detector: "step-19-symbols",
          sourceId: sym.id,
          sourceFile: sym.relativePath,
        });
      }

      allMap.set(sym.name, normSym);

      if (sym.exported.isExported) {
        const expName = sym.exported.isDefaultExport
          ? "default"
          : sym.exported.exportName ?? sym.name;
        exportedMap.set(expName, normSym);
      }
    }
  }

  // 2. Extract re-export items from module graph
  const fileReExportsMap = new Map<string, ReExportItem[]>();

  if (moduleGraph) {
    for (const edge of moduleGraph.internalEdges) {
      if (edge.edgeKind === "re_export") {
        const sourceFile = edge.sourceFile;
        if (!fileReExportsMap.has(sourceFile)) {
          fileReExportsMap.set(sourceFile, []);
        }
        const items = fileReExportsMap.get(sourceFile)!;

        if (edge.importKind === "star_re_export") {
          items.push({
            sourceFile,
            targetFile: edge.targetFile,
            exportName: "*",
            importedName: "*",
            importKind: "star_re_export",
            location: edge.location,
          });
        } else if (edge.importKind === "namespace_re_export") {
          for (const nameItem of edge.names) {
            items.push({
              sourceFile,
              targetFile: edge.targetFile,
              exportName: nameItem.alias ?? nameItem.name,
              importedName: "*",
              importKind: "namespace_re_export",
              location: edge.location,
            });
          }
        } else if (edge.importKind === "named_re_export") {
          for (const nameItem of edge.names) {
            items.push({
              sourceFile,
              targetFile: edge.targetFile,
              exportName: nameItem.alias ?? nameItem.name,
              importedName: nameItem.name,
              importKind: "named_re_export",
              location: edge.location,
            });
          }
        }
      }
    }

    for (const ref of moduleGraph.references) {
      if (ref.referenceKind === "re_export" && ref.resolutionStatus !== "internal") {
        const sourceFile = ref.sourceFile;
        if (!fileReExportsMap.has(sourceFile)) {
          fileReExportsMap.set(sourceFile, []);
        }
        const items = fileReExportsMap.get(sourceFile)!;
        if (ref.importKind === "star_re_export") {
          items.push({
            sourceFile,
            targetFile: ref.targetFile,
            exportName: "*",
            importedName: "*",
            importKind: "star_re_export",
            location: ref.location,
          });
        } else {
          for (const nameItem of ref.names) {
            items.push({
              sourceFile,
              targetFile: ref.targetFile,
              exportName: nameItem.alias ?? nameItem.name,
              importedName: nameItem.name,
              importKind: "named_re_export",
              location: ref.location,
            });
          }
        }
      }
    }
  }

  // 3. Re-export and Barrel-File Resolution Engine
  const exportResolutions: NormalizedExportResolution[] = [];
  const unresolvedList: NormalizedUnresolvedReference[] = [];
  let totalReExportsResolved = 0;
  let cycleCount = 0;

  interface ResolutionInternalResult {
    readonly status: "resolved" | "unresolved" | "ambiguous" | "cyclic";
    readonly symbol?: MutableNormalizedSymbol | undefined;
    readonly chain: readonly string[];
    readonly reason?: string | undefined;
    readonly targetFile?: string | undefined;
  }

  function resolveExportChain(
    file: string,
    exportName: string,
    visited: Set<string>,
    depth: number,
  ): ResolutionInternalResult {
    const currentKey = `${file}:${exportName}`;
    if (depth > 100) {
      return {
        status: "unresolved",
        chain: [currentKey],
        reason: `Maximum re-export resolution depth (100) exceeded at ${currentKey}`,
      };
    }

    if (visited.has(currentKey)) {
      return {
        status: "cyclic",
        chain: [...Array.from(visited), currentKey],
        reason: `Cyclic re-export chain detected: ${Array.from(visited).join(" -> ")} -> ${currentKey}`,
      };
    }

    const nextVisited = new Set(visited);
    nextVisited.add(currentKey);

    // A. Check direct declared exports in `file`
    const directExport = fileExportedSymbolsMap.get(file)?.get(exportName);
    if (directExport) {
      return {
        status: "resolved",
        symbol: directExport,
        chain: [currentKey],
        targetFile: file,
      };
    }

    // B. Check named re-exports in `file`
    const reExports = fileReExportsMap.get(file) ?? [];
    const namedMatches = reExports.filter(
      (r) => r.exportName === exportName && r.importKind !== "star_re_export",
    );

    if (namedMatches.length > 0) {
      const match = namedMatches[0];
      if (!match || !match.targetFile) {
        return {
          status: "unresolved",
          chain: [currentKey],
          reason: `Re-export of "${exportName}" in "${file}" points to an external or unresolved module`,
        };
      }
      const targetName = match.importedName === "*" ? exportName : match.importedName;
      const subRes = resolveExportChain(match.targetFile, targetName, nextVisited, depth + 1);
      return {
        status: subRes.status,
        symbol: subRes.symbol,
        reason: subRes.reason,
        targetFile: subRes.targetFile,
        chain: [currentKey, ...subRes.chain],
      };
    }

    // C. Check star re-exports (`export * from "./target"`)
    const starMatches = reExports.filter((r) => r.exportName === "*" || r.importKind === "star_re_export");
    if (starMatches.length > 0) {
      const resolvedFromStars: ResolutionInternalResult[] = [];
      let foundCycle = false;

      for (const star of starMatches) {
        if (!star.targetFile) continue;
        const subRes = resolveExportChain(star.targetFile, exportName, nextVisited, depth + 1);
        if (subRes.status === "resolved") {
          resolvedFromStars.push(subRes);
        } else if (subRes.status === "cyclic") {
          foundCycle = true;
        }
      }

      if (resolvedFromStars.length === 1 && resolvedFromStars[0]) {
        const first = resolvedFromStars[0];
        return {
          status: first.status,
          symbol: first.symbol,
          reason: first.reason,
          targetFile: first.targetFile,
          chain: [currentKey, ...first.chain],
        };
      }

      if (resolvedFromStars.length > 1) {
        const firstSymId = resolvedFromStars[0]?.symbol?.canonicalId;
        const allSame = resolvedFromStars.every((r) => r.symbol?.canonicalId === firstSymId);
        if (allSame && resolvedFromStars[0]?.symbol) {
          const first = resolvedFromStars[0];
          return {
            status: first.status,
            symbol: first.symbol,
            reason: first.reason,
            targetFile: first.targetFile,
            chain: [currentKey, ...first.chain],
          };
        }
        return {
          status: "ambiguous",
          chain: [currentKey],
          reason: `Ambiguous export "${exportName}" in "${file}" matches multiple conflicting star re-exports`,
        };
      }

      if (foundCycle) {
        return {
          status: "cyclic",
          chain: [currentKey],
          reason: `Cyclic re-export encountered during star re-export resolution of "${exportName}" in "${file}"`,
        };
      }
    }

    return {
      status: "unresolved",
      chain: [currentKey],
      reason: `Export "${exportName}" in "${file}" could not be resolved to a symbol declaration`,
    };
  }

  // Execute barrel resolution across all recorded re-exports
  for (const [exportingFile, items] of fileReExportsMap.entries()) {
    for (const item of items) {
      if (item.exportName === "*") {
        if (item.targetFile) {
          const targetExports = fileExportedSymbolsMap.get(item.targetFile);
          if (targetExports) {
            for (const expName of targetExports.keys()) {
              const res = resolveExportChain(exportingFile, expName, new Set(), 0);
              recordExportResolution(exportingFile, expName, res, item);
            }
          }
        }
      } else {
        const res = resolveExportChain(exportingFile, item.exportName, new Set(), 0);
        recordExportResolution(exportingFile, item.exportName, res, item);
      }
    }
  }

  function recordExportResolution(
    exportingFile: string,
    exportName: string,
    res: ResolutionInternalResult,
    item: ReExportItem,
  ): void {
    if (res.status === "resolved" && res.symbol) {
      totalReExportsResolved++;
      const existingAlias = res.symbol.aliases.find(
        (a) => a.exportingFile === exportingFile && a.exportName === exportName,
      );
      if (!existingAlias) {
        res.symbol.aliases.push({
          exportName,
          exportingFile,
          importKind: item.importKind,
          location: item.location,
        });
      }
      exportResolutions.push({
        exportingFile,
        exportName,
        canonicalSymbolId: res.symbol.canonicalId,
        canonicalFile: res.symbol.relativePath,
        isReExport: true,
        status: "resolved",
        resolutionChain: res.chain,
      });
    } else if (res.status === "cyclic") {
      cycleCount++;
      exportResolutions.push({
        exportingFile,
        exportName,
        isReExport: true,
        status: "cyclic",
        resolutionChain: res.chain,
        reason: res.reason,
      });
      unresolvedList.push({
        canonicalId: `unresolved:${exportingFile}:export:${exportName}:${item.location.start.offset}`,
        sourceFile: exportingFile,
        category: "export",
        targetSpecifierOrName: exportName,
        reason: res.reason ?? "Cyclic re-export",
        location: item.location,
      });
    } else if (res.status === "ambiguous") {
      exportResolutions.push({
        exportingFile,
        exportName,
        isReExport: true,
        status: "ambiguous",
        resolutionChain: res.chain,
        reason: res.reason,
      });
      unresolvedList.push({
        canonicalId: `unresolved:${exportingFile}:export:${exportName}:${item.location.start.offset}`,
        sourceFile: exportingFile,
        category: "export",
        targetSpecifierOrName: exportName,
        reason: res.reason ?? "Ambiguous re-export",
        location: item.location,
      });
    } else {
      exportResolutions.push({
        exportingFile,
        exportName,
        isReExport: true,
        status: "unresolved",
        resolutionChain: res.chain,
        reason: res.reason,
      });
      unresolvedList.push({
        canonicalId: `unresolved:${exportingFile}:export:${exportName}:${item.location.start.offset}`,
        sourceFile: exportingFile,
        category: "export",
        targetSpecifierOrName: exportName,
        reason: res.reason ?? "Unresolved re-export",
        location: item.location,
      });
    }
  }

  // 4. Normalize Module Edges
  const moduleEdges: NormalizedModuleEdge[] = [];
  if (moduleGraph) {
    for (const edge of moduleGraph.internalEdges) {
      const canonicalId = `edge:${edge.sourceFile}->${edge.targetFile ?? edge.specifier}#${edge.edgeKind}:${edge.location.start.offset}`;
      
      const resolvedSymbolIds: string[] = [];
      if (edge.targetFile && edge.names.length > 0) {
        for (const nameItem of edge.names) {
          if (nameItem.name !== "*") {
            const sym = fileExportedSymbolsMap.get(edge.targetFile)?.get(nameItem.name);
            if (sym) {
              resolvedSymbolIds.push(sym.canonicalId);
            }
          }
        }
      }

      moduleEdges.push({
        canonicalId,
        sourceFile: edge.sourceFile,
        targetFile: edge.targetFile,
        edgeKind: edge.edgeKind,
        importKind: edge.importKind,
        specifier: edge.specifier,
        names: edge.names,
        location: edge.location,
        resolutionStatus: edge.resolutionStatus,
        ...(edge.isTypeOnly ? { isTypeOnly: true } : {}),
        ...(resolvedSymbolIds.length > 0 ? { resolvedSymbolIds } : {}),
      });
    }

    for (const ref of moduleGraph.unresolvedReferences) {
      unresolvedList.push({
        canonicalId: `unresolved:${ref.sourceFile}:module:${ref.specifier}:${ref.location.start.offset}`,
        sourceFile: ref.sourceFile,
        category: "module",
        targetSpecifierOrName: ref.specifier,
        reason: "Unresolved internal or path-aliased module import",
        location: ref.location,
        originalId: ref.id,
      });
    }

    for (const ref of moduleGraph.unsupportedDynamicReferences) {
      unresolvedList.push({
        canonicalId: `unresolved:${ref.sourceFile}:module:${ref.specifier}:${ref.location.start.offset}`,
        sourceFile: ref.sourceFile,
        category: "module",
        targetSpecifierOrName: ref.specifier,
        reason: "Unsupported dynamic import or require expression",
        location: ref.location,
        originalId: ref.id,
      });
    }
  }

  // 5. Normalize Routes & Symbol Linkage
  const normalizedRoutes: NormalizedRoute[] = [];
  if (routeResult) {
    for (const route of routeResult.routes) {
      const canonicalId = `route:${route.filePath}#${route.routeType}:${route.httpMethods.join(",")}:${route.routePath}:${route.sourceLocation.start.offset}`;
      let canonicalSymbolId: string | undefined;

      if (route.symbolName) {
        const matchedSym =
          fileExportedSymbolsMap.get(route.filePath)?.get(route.symbolName) ??
          fileAllSymbolsMap.get(route.filePath)?.get(route.symbolName);
        if (matchedSym) {
          canonicalSymbolId = matchedSym.canonicalId;
        }
      }

      normalizedRoutes.push({
        canonicalId,
        framework: route.framework,
        routeType: route.routeType,
        filePath: route.filePath,
        routePath: route.routePath,
        httpMethods: route.httpMethods,
        symbolName: route.symbolName,
        canonicalSymbolId,
        sourceLocation: route.sourceLocation,
        evidence: route.evidence,
      });
    }
  }

  // 6. Normalize Events & Symbol Linkage
  const normalizedEvents: NormalizedEventPattern[] = [];
  if (eventResult) {
    const allEvents = [...eventResult.producers, ...eventResult.consumers];
    for (const ev of allEvents) {
      const canonicalId = `event:${ev.filePath}#${ev.role}:${ev.family}:${ev.methodShape}:${ev.sourceLocation.start.offset}`;
      let canonicalSymbolId: string | undefined;

      const symbolSearchName = ev.details.handlerSymbol ?? ev.details.receiverSymbol;
      if (symbolSearchName) {
        const matchedSym =
          fileAllSymbolsMap.get(ev.filePath)?.get(symbolSearchName) ??
          fileExportedSymbolsMap.get(ev.filePath)?.get(symbolSearchName);
        if (matchedSym) {
          canonicalSymbolId = matchedSym.canonicalId;
        }
      }

      normalizedEvents.push({
        canonicalId,
        role: ev.role,
        family: ev.family,
        methodShape: ev.methodShape,
        filePath: ev.filePath,
        details: ev.details,
        canonicalSymbolId,
        sourceLocation: ev.sourceLocation,
        evidence: ev.evidence,
      });

      if (ev.details.status === "unresolved") {
        unresolvedList.push({
          canonicalId: `unresolved:${ev.filePath}:event:${ev.id}`,
          sourceFile: ev.filePath,
          category: "event",
          targetSpecifierOrName: ev.methodShape,
          reason: "Event pattern identifier could not be statically resolved",
          location: ev.sourceLocation,
          originalId: ev.id,
        });
      }
    }
  }

  // 7. Normalize Database References & Symbol Linkage
  const normalizedDbRefs: NormalizedDatabaseReference[] = [];
  if (databaseResult) {
    for (const dbRef of databaseResult.references) {
      const canonicalId = `db:${dbRef.filePath}#${dbRef.family}:${dbRef.operation}:${dbRef.methodShape}:${dbRef.sourceLocation.start.offset}`;
      let canonicalSymbolId: string | undefined;

      if (dbRef.details.receiverSymbol) {
        const matchedSym =
          fileAllSymbolsMap.get(dbRef.filePath)?.get(dbRef.details.receiverSymbol) ??
          fileExportedSymbolsMap.get(dbRef.filePath)?.get(dbRef.details.receiverSymbol);
        if (matchedSym) {
          canonicalSymbolId = matchedSym.canonicalId;
        }
      }

      normalizedDbRefs.push({
        canonicalId,
        family: dbRef.family,
        operation: dbRef.operation,
        methodShape: dbRef.methodShape,
        filePath: dbRef.filePath,
        details: dbRef.details,
        canonicalSymbolId,
        sourceLocation: dbRef.sourceLocation,
        evidence: dbRef.evidence,
      });

      if (dbRef.details.status === "unresolved") {
        unresolvedList.push({
          canonicalId: `unresolved:${dbRef.filePath}:database:${dbRef.id}`,
          sourceFile: dbRef.filePath,
          category: "database",
          targetSpecifierOrName: dbRef.details.resourceName ?? dbRef.methodShape,
          reason: "Database resource identifier could not be statically resolved",
          location: dbRef.sourceLocation,
          originalId: dbRef.id,
        });
      }
    }
  }

  // 8. Collect and Normalize Diagnostics
  const diagnostics: NormalizedDiagnostic[] = [];

  for (const ext of symbolExtractions) {
    for (const d of ext.diagnostics) {
      diagnostics.push({
        file: ext.relativePath,
        message: d.message,
        line: d.line,
        column: d.column,
        severity: d.severity,
        sourceDetector: "step-19-symbols",
      });
    }
  }

  if (moduleGraph) {
    for (const d of moduleGraph.diagnostics) {
      diagnostics.push({
        file: d.file,
        message: d.message,
        line: d.line,
        column: d.column,
        severity: d.severity,
        sourceDetector: "step-20-modules",
      });
    }
  }

  if (routeResult) {
    for (const d of routeResult.diagnostics) {
      diagnostics.push({
        file: d.filePath,
        message: d.message,
        line: d.line,
        column: d.column,
        severity: d.severity,
        sourceDetector: "step-21-routes",
      });
    }
  }

  if (eventResult) {
    for (const d of eventResult.diagnostics) {
      diagnostics.push({
        file: d.filePath,
        message: d.message,
        line: d.line,
        column: d.column,
        severity: d.severity,
        sourceDetector: "step-22-events",
      });
    }
  }

  if (databaseResult) {
    for (const d of databaseResult.diagnostics) {
      diagnostics.push({
        file: d.filePath,
        message: d.message,
        line: d.line,
        column: d.column,
        severity: d.severity,
        sourceDetector: "step-23-database",
      });
    }
  }

  for (const tsRes of treeSitterResults) {
    for (const d of tsRes.diagnostics) {
      diagnostics.push({
        file: tsRes.relativePath,
        message: d.message,
        line: d.line,
        column: d.column,
        severity: d.severity,
        sourceDetector: "step-24-tree-sitter",
      });
    }
  }

  const normalizedSymbols: NormalizedSymbol[] = Array.from(symbolMap.values()).map((sym) => {
    const sortedAliases = [...sym.aliases].sort((a, b) => {
      const fileComp = a.exportingFile.localeCompare(b.exportingFile);
      if (fileComp !== 0) return fileComp;
      return a.exportName.localeCompare(b.exportName);
    });

    const sortedProvenance = [...sym.provenance].sort((a, b) => {
      const detComp = a.detector.localeCompare(b.detector);
      if (detComp !== 0) return detComp;
      return a.sourceId.localeCompare(b.sourceId);
    });

    return {
      canonicalId: sym.canonicalId,
      name: sym.name,
      kind: sym.kind,
      relativePath: sym.relativePath,
      location: sym.location,
      exported: sym.exported,
      ...(sym.parentSymbolId ? { parentSymbolId: sym.parentSymbolId } : {}),
      ...(sym.parentName ? { parentName: sym.parentName } : {}),
      ...(sym.metadata ? { metadata: sym.metadata } : {}),
      aliases: sortedAliases,
      provenance: sortedProvenance,
    };
  });

  // 9. Deterministic Sorting of Output Arrays
  normalizedSymbols.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  exportResolutions.sort((a, b) => {
    const fileComp = a.exportingFile.localeCompare(b.exportingFile);
    if (fileComp !== 0) return fileComp;
    const nameComp = a.exportName.localeCompare(b.exportName);
    if (nameComp !== 0) return nameComp;
    return a.status.localeCompare(b.status);
  });

  moduleEdges.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  normalizedRoutes.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  normalizedEvents.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
  normalizedDbRefs.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  const unresolvedMap = new Map<string, NormalizedUnresolvedReference>();
  for (const unres of unresolvedList) {
    if (!unresolvedMap.has(unres.canonicalId)) {
      unresolvedMap.set(unres.canonicalId, unres);
    }
  }
  const sortedUnresolved = Array.from(unresolvedMap.values()).sort((a, b) =>
    a.canonicalId.localeCompare(b.canonicalId),
  );

  diagnostics.sort((a, b) => {
    const fileComp = (a.file ?? "").localeCompare(b.file ?? "");
    if (fileComp !== 0) return fileComp;
    const lineComp = (a.line ?? 0) - (b.line ?? 0);
    if (lineComp !== 0) return lineComp;
    const colComp = (a.column ?? 0) - (b.column ?? 0);
    if (colComp !== 0) return colComp;
    return a.message.localeCompare(b.message);
  });

  const statistics: NormalizerStatistics = {
    totalSymbolsInput,
    totalNormalizedSymbols: normalizedSymbols.length,
    totalReExportsResolved,
    totalModuleEdgesNormalized: moduleEdges.length,
    totalRoutesNormalized: normalizedRoutes.length,
    totalEventsNormalized: normalizedEvents.length,
    totalDatabaseReferencesNormalized: normalizedDbRefs.length,
    totalUnresolved: sortedUnresolved.length,
    totalDiagnostics: diagnostics.length,
    cycleCount,
  };

  return {
    symbols: normalizedSymbols,
    exportResolutions,
    moduleEdges,
    routes: normalizedRoutes,
    events: normalizedEvents,
    databaseReferences: normalizedDbRefs,
    unresolved: sortedUnresolved,
    diagnostics,
    statistics,
  };
}

