import { auth } from "@clerk/nextjs/server";
import { readFluxoraApiUrl } from "../../github/env";
import { SimulationStudio } from "../../components/simulation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SimulationsPageProps {
  searchParams?: Promise<{
    repository_id?: string | string[];
    repo_id?: string | string[];
    analysis_run_id?: string | string[];
    run_id?: string | string[];
    start_node_id?: string | string[];
    target_node_id?: string | string[];
    node_id?: string | string[];
    scenario_id?: string | string[];
    simulation_id?: string | string[];
  }>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function SimulationsPage({ searchParams }: SimulationsPageProps) {
  const session = await auth();

  if (!session.isAuthenticated || !session.userId) {
    session.redirectToSignIn({
      returnBackUrl: "/simulations",
    });
    return null;
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const repositoryId =
    firstParam(resolvedSearchParams?.repository_id) ??
    firstParam(resolvedSearchParams?.repo_id) ??
    "";

  const analysisRunId =
    firstParam(resolvedSearchParams?.analysis_run_id) ??
    firstParam(resolvedSearchParams?.run_id) ??
    "";

  const startNodeId =
    firstParam(resolvedSearchParams?.start_node_id) ??
    "";

  const targetNodeId =
    firstParam(resolvedSearchParams?.target_node_id) ??
    firstParam(resolvedSearchParams?.node_id) ??
    "";

  const scenarioId =
    firstParam(resolvedSearchParams?.scenario_id) ??
    "";

  const simulationId =
    firstParam(resolvedSearchParams?.simulation_id) ??
    "";

  let apiUrl: string;
  try {
    apiUrl = readFluxoraApiUrl();
  } catch {
    return (
      <main className="p-8 max-w-xl mx-auto text-center">
        <h1 className="text-2xl font-bold mb-4">Configuration Error</h1>
        <p className="text-slate-600 mb-6">Fluxora API URL is not configured.</p>
      </main>
    );
  }

  return (
    <main className="w-full min-h-screen bg-slate-50 py-8">
      <SimulationStudio
        apiUrl={apiUrl}
        initialRepositoryId={repositoryId}
        initialAnalysisRunId={analysisRunId}
        initialStartNodeId={startNodeId}
        initialTargetNodeId={targetNodeId}
        initialScenarioId={scenarioId}
        initialSimulationId={simulationId}
      />
    </main>
  );
}

