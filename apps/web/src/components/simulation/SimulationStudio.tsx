"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import {
  createScenarioApi,
  fetchAnalysisGraph,
  getSimulationApi,
  getSimulationResultsApi,
  runScenarioApi,
  UUID_REGEX,
} from "./simulation-api.ts";
import {
  calculateSimulationImpact,
  extractCausalSteps,
  filterAndSortSimulationResults,
  formatConfidence,
  getStateBadgeColors,
  validateScenarioInput,
} from "./simulation-helpers.ts";
import {
  DEFAULT_STUDIO_FILTERS,
  SUPPORTED_FAILURE_TYPES,
  type GraphQueryResponseNode,
  type ScenarioResponse,
  type SimulationResponse,
  type SimulationResultResponse,
  type StudioFilterState,
  type SupportedFailureType,
} from "./simulation-types.ts";

export interface SimulationStudioProps {
  readonly apiUrl: string;
  readonly initialRepositoryId?: string | undefined;
  readonly initialAnalysisRunId?: string | undefined;
  readonly initialStartNodeId?: string | undefined;
  readonly initialTargetNodeId?: string | undefined;
  readonly initialScenarioId?: string | undefined;
  readonly initialSimulationId?: string | undefined;
  readonly fetchImpl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
}

export function SimulationStudio({
  apiUrl,
  initialRepositoryId = "",
  initialAnalysisRunId = "",
  initialStartNodeId = "",
  initialTargetNodeId = "",
  initialScenarioId = "",
  initialSimulationId = "",
  fetchImpl,
}: SimulationStudioProps): React.JSX.Element {
  const { getToken } = useAuth();

  // Inputs
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId);
  const [analysisRunId, setAnalysisRunId] = useState(initialAnalysisRunId);
  const [startNodeId, setStartNodeId] = useState(initialStartNodeId);
  const [targetNodeId, setTargetNodeId] = useState(initialTargetNodeId);
  const [scenarioName, setScenarioName] = useState("");
  const [failureType, setFailureType] = useState<SupportedFailureType>("unavailable");

  // Graph state
  const [graphNodes, setGraphNodes] = useState<readonly GraphQueryResponseNode[]>([]);
  const [graphStatus, setGraphStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [graphError, setGraphError] = useState<string | null>(null);
  const [nodeFilterQuery, setNodeFilterQuery] = useState("");

  // Scenario creation state
  const [createdScenario, setCreatedScenario] = useState<ScenarioResponse | null>(null);
  const [isCreatingScenario, setIsCreatingScenario] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);

  // Simulation execution state
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [simulationResults, setSimulationResults] = useState<readonly SimulationResultResponse[]>([]);
  const [isRunningSimulation, setIsRunningSimulation] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  // Results & inspector state
  const [selectedResultNodeId, setSelectedResultNodeId] = useState<string | null>(null);
  const [filters, setFilters] = useState<StudioFilterState>(DEFAULT_STUDIO_FILTERS);

  // Node name mapping
  const nodeMap = useMemo(() => {
    const map = new Map<string, { name: string; type: string; canonicalId?: string }>();
    for (const node of graphNodes) {
      map.set(node.id, {
        name: node.name,
        type: node.type,
        canonicalId: node.canonical_id,
      });
    }
    return map;
  }, [graphNodes]);

  const nodeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graphNodes) {
      map.set(node.id, node.name);
    }
    return map;
  }, [graphNodes]);

  // Form validation
  const validation = useMemo(() => {
    return validateScenarioInput({
      name: scenarioName,
      targetNodeId,
      failureType,
      repositoryId: repositoryId.trim() || undefined,
      analysisRunId: analysisRunId.trim() || undefined,
    });
  }, [scenarioName, targetNodeId, failureType, repositoryId, analysisRunId]);

  // Dependent selection invalidations
  const handleRepositoryChange = useCallback((newRepoId: string) => {
    setRepositoryId(newRepoId);
    // Invalidate dependent selections if repository changed
    setTargetNodeId("");
    setCreatedScenario(null);
    setSimulation(null);
    setSimulationResults([]);
    setSelectedResultNodeId(null);
    setScenarioError(null);
    setSimulationError(null);
  }, []);

  const handleAnalysisRunChange = useCallback((newRunId: string) => {
    setAnalysisRunId(newRunId);
    // Invalidate dependent selections if analysis run changed
    setGraphNodes([]);
    setGraphStatus("idle");
    setTargetNodeId("");
    setCreatedScenario(null);
    setSimulation(null);
    setSimulationResults([]);
    setSelectedResultNodeId(null);
    setScenarioError(null);
    setSimulationError(null);
  }, []);

  // Fetch graph nodes for target-node selection
  const handleLoadGraph = useCallback(async () => {
    const effectiveRunId = analysisRunId.trim();
    if (!UUID_REGEX.test(effectiveRunId)) {
      setGraphError("A valid Analysis Run UUID is required to query the graph.");
      return;
    }

    const effectiveStartNode = startNodeId.trim() || targetNodeId.trim();
    if (!effectiveStartNode || !UUID_REGEX.test(effectiveStartNode)) {
      setGraphError(
        "A valid start node UUID is required to query graph nodes (enter a start node ID or target node ID).",
      );
      return;
    }

    setGraphStatus("loading");
    setGraphError(null);

    const result = await fetchAnalysisGraph({
      apiUrl,
      getToken,
      analysisRunId: effectiveRunId,
      startNodeId: effectiveStartNode,
      fetchImpl,
    });

    if (!result.ok) {
      setGraphStatus("error");
      setGraphError(result.message);
      return;
    }

    setGraphNodes(result.data.nodes);
    setGraphStatus("ready");
    if (!targetNodeId && result.data.nodes.length > 0) {
      const firstNode = result.data.nodes[0];
      if (firstNode) {
        setTargetNodeId(firstNode.id);
      }
    }
  }, [analysisRunId, startNodeId, targetNodeId, apiUrl, getToken, fetchImpl]);

  // Initial load if initial IDs provided
  useEffect(() => {
    if (!initialAnalysisRunId || !initialStartNodeId) {
      return;
    }

    let isCancelled = false;

    async function loadInitialGraph() {
      const result = await fetchAnalysisGraph({
        apiUrl,
        getToken,
        analysisRunId: initialAnalysisRunId.trim(),
        startNodeId: initialStartNodeId.trim(),
        fetchImpl,
      });

      if (isCancelled) return;

      if (!result.ok) {
        setGraphStatus("error");
        setGraphError(result.message);
        return;
      }

      setGraphNodes(result.data.nodes);
      setGraphStatus("ready");
      if (!initialTargetNodeId && result.data.nodes.length > 0) {
        const firstNode = result.data.nodes[0];
        if (firstNode) {
          setTargetNodeId(firstNode.id);
        }
      }
    }

    void loadInitialGraph();

    return () => {
      isCancelled = true;
    };
  }, [initialAnalysisRunId, initialStartNodeId, initialTargetNodeId, apiUrl, getToken, fetchImpl]);

  // Initial scenario / simulation load if provided
  useEffect(() => {
    if (!initialSimulationId || !UUID_REGEX.test(initialSimulationId.trim())) {
      return;
    }

    let cancelled = false;

    async function loadExistingSimulation(simId: string) {
      const simResult = await getSimulationApi({
        apiUrl,
        getToken,
        simulationId: simId,
        fetchImpl,
      });

      if (cancelled) return;

      if (!simResult.ok) {
        setIsRunningSimulation(false);
        setSimulationError(simResult.message);
        return;
      }

      setSimulation(simResult.data);

      const resultsRes = await getSimulationResultsApi({
        apiUrl,
        getToken,
        simulationId: simId,
        fetchImpl,
      });

      if (cancelled) return;
      setIsRunningSimulation(false);

      if (resultsRes.ok) {
        setSimulationResults(resultsRes.data.results);
        if (resultsRes.data.results.length > 0) {
          const first = resultsRes.data.results[0];
          if (first) {
            setSelectedResultNodeId(first.node_id);
          }
        }
      } else {
        setSimulationError(resultsRes.message);
      }
    }

    void loadExistingSimulation(initialSimulationId.trim());

    return () => {
      cancelled = true;
    };
  }, [initialSimulationId, apiUrl, getToken, fetchImpl]);

  // Action 1: Create Scenario
  const handleCreateScenario = useCallback(async () => {
    if (!validation.valid) {
      setScenarioError("Please correct form errors before creating a scenario.");
      return;
    }

    setIsCreatingScenario(true);
    setScenarioError(null);

    const result = await createScenarioApi({
      apiUrl,
      getToken,
      request: {
        name: scenarioName.trim(),
        target_node_id: targetNodeId.trim(),
        failure_type: failureType,
        ...(repositoryId.trim() ? { repository_id: repositoryId.trim() } : {}),
        ...(analysisRunId.trim() ? { analysis_run_id: analysisRunId.trim() } : {}),
      },
      fetchImpl,
    });

    setIsCreatingScenario(false);

    if (!result.ok) {
      setScenarioError(result.message);
      return;
    }

    setCreatedScenario(result.data);
  }, [
    validation.valid,
    scenarioName,
    targetNodeId,
    failureType,
    repositoryId,
    analysisRunId,
    apiUrl,
    getToken,
    fetchImpl,
  ]);

  // Action 2: Run Simulation
  const handleRunSimulation = useCallback(async () => {
    const scenarioId = createdScenario?.id ?? initialScenarioId.trim();
    if (!scenarioId || !UUID_REGEX.test(scenarioId)) {
      setSimulationError("A valid created scenario is required to run a simulation.");
      return;
    }

    setIsRunningSimulation(true);
    setSimulationError(null);

    const runResult = await runScenarioApi({
      apiUrl,
      getToken,
      scenarioId,
      request: analysisRunId.trim() ? { analysis_run_id: analysisRunId.trim() } : {},
      fetchImpl,
    });

    if (!runResult.ok) {
      setIsRunningSimulation(false);
      setSimulationError(runResult.message);
      return;
    }

    setSimulation(runResult.data);

    // If results were included directly in the response
    if (runResult.data.results && runResult.data.results.length > 0) {
      setSimulationResults(runResult.data.results);
      setIsRunningSimulation(false);
      const first = runResult.data.results[0];
      if (first) {
        setSelectedResultNodeId(first.node_id);
      }
      return;
    }

    // Otherwise fetch persisted simulation results
    const resultsResult = await getSimulationResultsApi({
      apiUrl,
      getToken,
      simulationId: runResult.data.id,
      fetchImpl,
    });

    setIsRunningSimulation(false);

    if (!resultsResult.ok) {
      setSimulationError(resultsResult.message);
      return;
    }

    setSimulationResults(resultsResult.data.results);
    if (resultsResult.data.results.length > 0) {
      const first = resultsResult.data.results[0];
      if (first) {
        setSelectedResultNodeId(first.node_id);
      }
    }
  }, [createdScenario, initialScenarioId, analysisRunId, apiUrl, getToken, fetchImpl]);

  // Impact summary
  const impactSummary = useMemo(() => {
    return calculateSimulationImpact(simulationResults, simulation);
  }, [simulationResults, simulation]);

  // Filtered and sorted results
  const displayedResults = useMemo(() => {
    return filterAndSortSimulationResults(simulationResults, filters, nodeNameMap);
  }, [simulationResults, filters, nodeNameMap]);

  // Selected result node for causal path inspector
  const selectedResult = useMemo(() => {
    if (!selectedResultNodeId) {
      return simulationResults.length > 0 ? simulationResults[0] ?? null : null;
    }
    return simulationResults.find((r) => r.node_id === selectedResultNodeId) ?? null;
  }, [selectedResultNodeId, simulationResults]);

  const causalSteps = useMemo(() => {
    if (!selectedResult) return [];
    return extractCausalSteps(selectedResult);
  }, [selectedResult]);

  // Filtered graph nodes for target selection
  const selectableNodes = useMemo(() => {
    if (!nodeFilterQuery.trim()) return graphNodes;
    const q = nodeFilterQuery.trim().toLowerCase();
    return graphNodes.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q),
    );
  }, [graphNodes, nodeFilterQuery]);

  return (
    <div className="w-full max-w-7xl mx-auto p-4 flex flex-col gap-6" data-testid="simulation-studio">
      {/* Navigation Header */}
      <header className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
            <Link href="/dashboard" className="text-blue-600 hover:underline">
              Dashboard
            </Link>
            <span>/</span>
            {repositoryId.trim() ? (
              <>
                <Link
                  href={`/repositories/${repositoryId}/explorer${
                    analysisRunId ? `?analysis_run_id=${analysisRunId}` : ""
                  }`}
                  className="text-blue-600 hover:underline"
                >
                  Explorer
                </Link>
                <span>/</span>
              </>
            ) : null}
            <span className="text-slate-800 font-semibold">Simulation Studio</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Simulation Studio</h1>
          <p className="text-sm text-slate-600">
            Deterministic failure modeling, scenario propagation, and causal path analysis.
          </p>
        </div>

        {simulation?.status ? (
          <div className="flex items-center gap-2" data-testid="studio-status-badge">
            <span className="text-xs uppercase tracking-wide font-medium text-slate-500">
              Execution Status:
            </span>
            <span
              className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${
                simulation.status === "completed"
                  ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                  : simulation.status === "failed"
                    ? "bg-red-50 text-red-800 border-red-300"
                    : "bg-blue-50 text-blue-800 border-blue-300"
              }`}
            >
              {simulation.status}
            </span>
          </div>
        ) : null}
      </header>

      {/* Main Workbench Layout: 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Configuration & Controls (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* Section 1: Repository & Analysis Run Selection */}
          <section
            className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-4"
            aria-label="Repository and Graph Selection"
          >
            <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-2">
              1. Repository & Graph Snapshot
            </h2>

            <div>
              <label htmlFor="repo-input" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Repository Identifier (UUID)
              </label>
              <input
                id="repo-input"
                data-testid="studio-repository-input"
                type="text"
                value={repositoryId}
                onChange={(e) => handleRepositoryChange(e.target.value)}
                placeholder="e.g. 11111111-1111-4111-8111-111111111111"
                className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              {validation.errors.repositoryId ? (
                <p className="text-xs text-red-600 mt-1">{validation.errors.repositoryId}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="run-input" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Analysis Run Identifier (UUID)
              </label>
              <input
                id="run-input"
                data-testid="studio-analysis-run-input"
                type="text"
                value={analysisRunId}
                onChange={(e) => handleAnalysisRunChange(e.target.value)}
                placeholder="e.g. 33333333-3333-4333-8333-333333333333"
                className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              {validation.errors.analysisRunId ? (
                <p className="text-xs text-red-600 mt-1">{validation.errors.analysisRunId}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="start-node-input" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Graph Query Start Node (UUID)
              </label>
              <input
                id="start-node-input"
                data-testid="studio-start-node-input"
                type="text"
                value={startNodeId}
                onChange={(e) => setStartNodeId(e.target.value)}
                placeholder="Start node for querying snapshot nodes"
                className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <button
              type="button"
              data-testid="studio-load-graph-btn"
              onClick={handleLoadGraph}
              disabled={graphStatus === "loading" || !analysisRunId.trim()}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 text-xs font-semibold py-2 px-3 rounded transition-colors disabled:opacity-50"
            >
              {graphStatus === "loading" ? "Querying Snapshot Graph..." : "Load Snapshot Nodes"}
            </button>

            {graphStatus === "ready" ? (
              <p className="text-xs text-emerald-700 font-medium">
                Loaded {graphNodes.length} graph nodes from analysis run snapshot.
              </p>
            ) : null}

            {graphError ? (
              <div
                data-testid="studio-graph-error"
                className="text-xs text-red-700 bg-red-50 p-2.5 rounded border border-red-200"
              >
                {graphError}
              </div>
            ) : null}
          </section>

          {/* Section 2: Failure Scenario Definition */}
          <section
            className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-4"
            aria-label="Scenario Definition"
          >
            <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-2">
              2. Scenario Definition
            </h2>

            {/* Target Node Selection */}
            <div>
              <label htmlFor="target-node-select" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Target Node (Failure Seed) <span className="text-red-500">*</span>
              </label>

              {graphNodes.length > 0 ? (
                <>
                  <input
                    type="text"
                    value={nodeFilterQuery}
                    onChange={(e) => setNodeFilterQuery(e.target.value)}
                    placeholder="Search node by name or type..."
                    className="w-full text-xs border border-slate-200 rounded px-2.5 py-1 mb-1.5"
                  />
                  <select
                    id="target-node-select"
                    data-testid="studio-target-node-select"
                    value={targetNodeId}
                    onChange={(e) => setTargetNodeId(e.target.value)}
                    className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  >
                    <option value="">-- Select a target node from graph --</option>
                    {selectableNodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        [{n.type}] {n.name} ({n.id.slice(0, 8)}...)
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <input
                  id="target-node-select"
                  data-testid="studio-target-node-manual-input"
                  type="text"
                  value={targetNodeId}
                  onChange={(e) => setTargetNodeId(e.target.value)}
                  placeholder="Enter target node UUID or load graph nodes above"
                  className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              )}

              {validation.errors.targetNodeId ? (
                <p className="text-xs text-red-600 mt-1" data-testid="target-node-error">
                  {validation.errors.targetNodeId}
                </p>
              ) : null}
            </div>

            {/* Scenario Name */}
            <div>
              <label htmlFor="scenario-name-input" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Scenario Name <span className="text-red-500">*</span>
              </label>
              <input
                id="scenario-name-input"
                data-testid="studio-scenario-name-input"
                type="text"
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                placeholder="e.g. Payment Gateway Failure"
                className="w-full text-sm border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {validation.errors.name ? (
                <p className="text-xs text-red-600 mt-1" data-testid="scenario-name-error">
                  {validation.errors.name}
                </p>
              ) : null}
            </div>

            {/* Failure Type */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1.5">
                Failure Type <span className="text-red-500">*</span>
              </label>
              <div className="flex flex-col gap-2">
                {SUPPORTED_FAILURE_TYPES.map((type) => (
                  <label
                    key={type}
                    className={`flex items-start gap-2.5 p-2.5 rounded border text-sm cursor-pointer transition-colors ${
                      failureType === type
                        ? "border-blue-500 bg-blue-50/50 text-slate-900"
                        : "border-slate-200 hover:bg-slate-50 text-slate-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name="failureType"
                      value={type}
                      checked={failureType === type}
                      onChange={() => setFailureType(type)}
                      data-testid={`studio-failure-type-${type}`}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="font-semibold capitalize">{type}</span>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {type === "unavailable"
                          ? "Target component completely fails or crashes; upstream calls fail."
                          : "Target component experiences severe latency; cascades timeout risk."}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2 italic">
                Note: Latency modeling in Fluxora is qualitative dependency propagation (at-risk degradation), not numerical millisecond queuing simulation.
              </p>
            </div>

            {/* Action 1: Create Scenario Button */}
            <button
              type="button"
              data-testid="studio-create-scenario-btn"
              onClick={handleCreateScenario}
              disabled={isCreatingScenario || !validation.valid}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm py-2 px-4 rounded shadow-sm transition-colors disabled:opacity-50"
            >
              {isCreatingScenario ? "Creating Scenario..." : "Create Scenario"}
            </button>

            {createdScenario ? (
              <div
                data-testid="studio-scenario-success"
                className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs"
              >
                <div className="font-semibold">Scenario Created Successfully</div>
                <div className="mt-1 font-mono text-[11px] text-emerald-900">
                  ID: {createdScenario.id}
                </div>
                <div className="mt-0.5 text-emerald-700">
                  Target: {nodeNameMap.get(createdScenario.target_node_id) ?? createdScenario.target_node_id}
                </div>
              </div>
            ) : null}

            {scenarioError ? (
              <div
                data-testid="studio-scenario-error"
                className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-xs"
              >
                {scenarioError}
              </div>
            ) : null}
          </section>

          {/* Section 3: Separate Execution Action */}
          <section
            className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-3"
            aria-label="Simulation Execution"
          >
            <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-2">
              3. Simulation Execution
            </h2>
            <p className="text-xs text-slate-600">
              Execute deterministic rule propagation across the analysis graph.
            </p>

            <button
              type="button"
              data-testid="studio-run-simulation-btn"
              onClick={handleRunSimulation}
              disabled={isRunningSimulation || (!createdScenario && !initialScenarioId.trim())}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm py-2.5 px-4 rounded shadow transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isRunningSimulation ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Running Simulation Engine...</span>
                </>
              ) : (
                "Run Simulation"
              )}
            </button>

            {simulationError ? (
              <div
                data-testid="studio-simulation-error"
                className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-xs"
              >
                <div className="font-semibold">Simulation Failed</div>
                <div className="mt-1">{simulationError}</div>
                <button
                  type="button"
                  data-testid="studio-retry-simulation-btn"
                  onClick={handleRunSimulation}
                  className="mt-2 text-xs font-semibold underline text-red-800 hover:text-red-900"
                >
                  Retry Execution
                </button>
              </div>
            ) : null}
          </section>
        </div>

        {/* Right Column: Outcomes, Impact Summary, Causal Inspector (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          {/* Simulation Impact Summary */}
          {simulationResults.length > 0 ? (
            <section
              className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-4"
              data-testid="studio-impact-summary"
              aria-label="Impact Summary"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <h2 className="text-base font-semibold text-slate-900">Deterministic Impact Summary</h2>
                <span className="text-xs font-mono text-slate-500">
                  {impactSummary.ruleTableVersion ? `Rule Table v${impactSummary.ruleTableVersion}` : "Rule Table: Active"}
                  {impactSummary.iterations !== undefined ? ` · ${impactSummary.iterations} iteration${impactSummary.iterations === 1 ? "" : "s"}` : ""}
                  {impactSummary.converged !== undefined ? ` · ${impactSummary.converged ? "Converged" : "Unconverged"}` : ""}
                </span>
              </div>

              {/* Metric Chips */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded p-3 text-center">
                  <span className="block text-2xl font-bold text-slate-800" data-testid="metric-total-affected">
                    {impactSummary.totalAffected}
                  </span>
                  <span className="text-xs text-slate-500 uppercase font-semibold">Total Affected</span>
                </div>
                <div className="bg-red-50 border border-red-200 rounded p-3 text-center">
                  <span className="block text-2xl font-bold text-red-700" data-testid="metric-failed">
                    {impactSummary.failedCount}
                  </span>
                  <span className="text-xs text-red-700 uppercase font-semibold">Failed</span>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded p-3 text-center">
                  <span className="block text-2xl font-bold text-amber-700" data-testid="metric-degraded">
                    {impactSummary.degradedCount}
                  </span>
                  <span className="text-xs text-amber-700 uppercase font-semibold">Degraded</span>
                </div>
                <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-center">
                  <span className="block text-2xl font-bold text-yellow-700" data-testid="metric-at-risk">
                    {impactSummary.atRiskCount}
                  </span>
                  <span className="text-xs text-yellow-700 uppercase font-semibold">At Risk</span>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-center">
                  <span className="block text-2xl font-bold text-emerald-700" data-testid="metric-healthy">
                    {impactSummary.healthyCount}
                  </span>
                  <span className="text-xs text-emerald-700 uppercase font-semibold">Healthy</span>
                </div>
                <div className="bg-indigo-50 border border-indigo-200 rounded p-3 text-center">
                  <span className="block text-2xl font-bold text-indigo-700" data-testid="metric-capped">
                    {impactSummary.cappedCount}
                  </span>
                  <span className="text-xs text-indigo-700 uppercase font-semibold">Capped (Breaker)</span>
                </div>
              </div>

              <p className="text-xs text-slate-500 italic">
                Notice: Simulation confidence values reflect static analysis completeness and rule assumptions. They do not represent real-world statistical failure probabilities or uptime metrics.
              </p>
            </section>
          ) : isRunningSimulation ? (
            <div className="bg-white border border-slate-200 rounded-lg p-12 text-center text-slate-500 shadow-sm flex flex-col items-center justify-center gap-3">
              <span className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium text-slate-700">Evaluating failure propagation across graph...</p>
            </div>
          ) : (
            <div
              className="bg-white border border-dashed border-slate-300 rounded-lg p-12 text-center text-slate-500 shadow-sm"
              data-testid="studio-empty-prompt"
            >
              <h3 className="text-base font-semibold text-slate-700 mb-1">No Simulation Executed</h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Configure your repository and snapshot, choose a target failure seed node, and click Run Simulation to inspect affected components and causal chains.
              </p>
            </div>
          )}

          {/* Section 4: Affected Node Table with Filtering & Sorting */}
          {simulationResults.length > 0 ? (
            <section
              className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-4"
              aria-label="Affected Nodes Table"
              data-testid="studio-affected-nodes-section"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <h3 className="text-base font-semibold text-slate-900">
                  Affected Graph Nodes ({displayedResults.length} / {simulationResults.length})
                </h3>

                {/* State Filters */}
                <div className="flex items-center gap-1.5 text-xs">
                  {(["all", "failed", "degraded", "at_risk", "healthy"] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      data-testid={`studio-filter-${st}`}
                      onClick={() => setFilters((prev) => ({ ...prev, stateFilter: st }))}
                      className={`px-2 py-1 rounded capitalize font-medium transition-colors ${
                        filters.stateFilter === st
                          ? "bg-slate-800 text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {st === "all" ? "All" : st.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search & Sort Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <input
                  type="text"
                  data-testid="studio-results-search"
                  value={filters.searchQuery}
                  onChange={(e) => setFilters((prev) => ({ ...prev, searchQuery: e.target.value }))}
                  placeholder="Filter by node name, ID, or rule..."
                  className="text-xs border border-slate-300 rounded px-2.5 py-1.5 w-64 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />

                <div className="flex items-center gap-2">
                  <span className="text-slate-500">Sort by:</span>
                  <select
                    data-testid="studio-sort-select"
                    value={filters.sortBy}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, sortBy: e.target.value as StudioFilterState["sortBy"] }))
                    }
                    className="border border-slate-300 rounded px-2 py-1 bg-white text-slate-700"
                  >
                    <option value="state">Resulting State</option>
                    <option value="name">Node Name</option>
                    <option value="confidence">Confidence</option>
                    <option value="steps">Causal Path Length</option>
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setFilters((prev) => ({
                        ...prev,
                        sortDirection: prev.sortDirection === "asc" ? "desc" : "asc",
                      }))
                    }
                    className="border border-slate-300 rounded px-2 py-1 hover:bg-slate-100 font-semibold"
                    title="Toggle Sort Direction"
                  >
                    {filters.sortDirection === "asc" ? "↑ Asc" : "↓ Desc"}
                  </button>
                </div>
              </div>

              {/* Table */}
              <div className="overflow-x-auto border border-slate-200 rounded">
                <table className="min-w-full text-left text-xs divide-y divide-slate-200">
                  <thead className="bg-slate-50 font-semibold text-slate-700">
                    <tr>
                      <th className="px-3 py-2">Node</th>
                      <th className="px-3 py-2">Resulting State</th>
                      <th className="px-3 py-2">Rule Applied</th>
                      <th className="px-3 py-2">Confidence</th>
                      <th className="px-3 py-2">Capped</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {displayedResults.map((r) => {
                      const state = r.resulting_state ?? r.state;
                      const colors = getStateBadgeColors(state);
                      const isSelected = selectedResult?.node_id === r.node_id;
                      const steps = extractCausalSteps(r);
                      const isCapped = steps.some((s) => s.capped === true);
                      const nodeInfo = nodeMap.get(r.node_id);

                      return (
                        <tr
                          key={r.id || r.node_id}
                          data-testid={`studio-result-row-${r.node_id}`}
                          onClick={() => setSelectedResultNodeId(r.node_id)}
                          className={`cursor-pointer transition-colors ${
                            isSelected ? "bg-blue-50/70" : "hover:bg-slate-50"
                          }`}
                        >
                          <td className="px-3 py-2">
                            <div className="font-semibold text-slate-900">
                              {nodeInfo?.name ?? r.node_id.slice(0, 12)}
                            </div>
                            <div className="text-[10px] font-mono text-slate-500">
                              {nodeInfo?.type ? `[${nodeInfo.type}] ` : ""}
                              {r.node_id}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold border ${colors.bg} ${colors.text} ${colors.border}`}
                            >
                              {colors.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                            {r.rule_applied}
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                            {formatConfidence(r.confidence)}
                          </td>
                          <td className="px-3 py-2">
                            {isCapped ? (
                              <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 rounded">
                                Capped
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              className="text-blue-600 hover:underline font-semibold"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedResultNodeId(r.node_id);
                              }}
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* Section 5: Causal Path Inspector */}
          {selectedResult ? (
            <section
              className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-4"
              data-testid="studio-causal-inspector"
              aria-label="Causal Path Inspector"
            >
              <div className="border-b border-slate-100 pb-2">
                <span className="text-xs font-semibold uppercase text-slate-500 tracking-wider">
                  Causal Path Inspector
                </span>
                <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                  {nodeNameMap.get(selectedResult.node_id) ?? selectedResult.node_id}
                </h3>
                <p className="text-xs text-slate-600 font-mono mt-0.5">Node ID: {selectedResult.node_id}</p>
              </div>

              {causalSteps.length > 0 ? (
                <div className="flex flex-col gap-3" data-testid="causal-steps-list">
                  {causalSteps.map((step, idx) => {
                    const isSeed = !step.edgeId || step.ruleId === "target_failure";
                    const resultingColors = getStateBadgeColors(step.resultingState);
                    const previousColors = getStateBadgeColors(step.previousState);

                    return (
                      <div
                        key={`${step.nodeId}-${step.ruleId}-${idx}`}
                        data-testid={`causal-step-${idx}`}
                        className="border border-slate-200 rounded-lg p-3 bg-slate-50/50 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-700">
                            Step {idx + 1}: {isSeed ? "Target Failure Seed" : "Propagation Decision"}
                          </span>
                          <span className="text-xs font-mono text-slate-500">
                            Confidence: {formatConfidence(step.confidence)}
                          </span>
                        </div>

                        {/* State Transition */}
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-500">Transition:</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${previousColors.bg} ${previousColors.text} ${previousColors.border}`}
                          >
                            {previousColors.label}
                          </span>
                          <span className="text-slate-400 font-bold">→</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${resultingColors.bg} ${resultingColors.text} ${resultingColors.border}`}
                          >
                            {resultingColors.label}
                          </span>
                          {step.capped ? (
                            <span className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-100 text-indigo-800 rounded border border-indigo-300">
                              Propagation Capped (Circuit Breaker)
                            </span>
                          ) : null}
                        </div>

                        {/* Rule & Edge Identity */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono pt-1 border-t border-slate-200/60">
                          <div>
                            <span className="text-slate-500">Rule ID: </span>
                            <span className="font-semibold text-slate-800">{step.ruleId}</span>
                            <span className="text-slate-400"> (v{step.ruleVersion})</span>
                          </div>
                          <div>
                            <span className="text-slate-500">Edge ID: </span>
                            <span className="text-slate-800">
                              {step.edgeId ? step.edgeId : "None (Seed target failure)"}
                            </span>
                          </div>
                        </div>

                        {/* Assumptions */}
                        <div className="pt-1 text-xs">
                          <span className="font-semibold text-slate-700">Assumptions: </span>
                          {step.assumptions && step.assumptions.length > 0 ? (
                            <ul className="list-disc list-inside mt-1 text-slate-600 space-y-0.5 pl-1">
                              {step.assumptions.map((asm, aIdx) => (
                                <li key={aIdx}>{asm}</li>
                              ))}
                            </ul>
                          ) : (
                            <span className="text-slate-500 italic">None (verified deterministic rule)</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-500 italic">No causal propagation steps recorded.</p>
              )}
            </section>
          ) : null}

          {/* Section 6: Details & Limitations */}
          <section
            className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm flex flex-col gap-3 text-xs"
            aria-label="Simulation Environment and Limitations"
            data-testid="studio-details-section"
          >
            <h3 className="text-sm font-semibold text-slate-900 border-b border-slate-100 pb-2">
              Simulation Environment & Limitations
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono">
              <div>
                <span className="text-slate-500">Repository ID: </span>
                <span className="text-slate-800">{repositoryId || "None"}</span>
              </div>
              <div>
                <span className="text-slate-500">Analysis Run ID: </span>
                <span className="text-slate-800">{analysisRunId || "None"}</span>
              </div>
              <div>
                <span className="text-slate-500">Scenario ID: </span>
                <span className="text-slate-800">{(createdScenario?.id ?? initialScenarioId) || "None"}</span>
              </div>
              <div>
                <span className="text-slate-500">Simulation ID: </span>
                <span className="text-slate-800">{(simulation?.id ?? initialSimulationId) || "None"}</span>
              </div>
              <div>
                <span className="text-slate-500">Rule Table Version: </span>
                <span className="text-slate-800">
                  {impactSummary.ruleTableVersion ?? "1.0.0 (rule table default)"}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Engine Convergence: </span>
                <span className="text-slate-800">
                  {simulation?.converged !== undefined
                    ? simulation.converged
                      ? "Converged"
                      : "Failed to converge"
                    : "Not reported by server"}
                </span>
              </div>
            </div>

            <div className="mt-2 pt-2 border-t border-slate-100 text-slate-600 space-y-1">
              <p>
                <strong>Repository & Analysis Context:</strong> Repository and analysis run identities are supplied via route context or query parameters. Graph target nodes are scoped strictly to the selected analysis run snapshot via <code>POST /api/v1/graph/query</code>.
              </p>
              <p>
                <strong>Deterministic Core:</strong> Graph traversal and failure propagation follow strict architectural rules. No probabilistic AI guessing is involved in constructing these paths.
              </p>
              <p>
                <strong>Qualitative Latency:</strong> In Step 53–56, latency degradation propagates as an at-risk state through synchronous dependency chains without numerical queueing or telemetry simulation.
              </p>
              <p>
                <strong>Evidence-Backed Assumptions:</strong> When edge metadata is missing or unknown, conservative defaults apply and are explicitly cited in the causal steps above.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
