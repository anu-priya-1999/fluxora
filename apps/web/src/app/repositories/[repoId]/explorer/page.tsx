import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { readFluxoraApiUrl } from "../../../../github/env";
import { ArchitectureExplorerClient } from "./explorer-client";
import { resolveRepositoryAnalysisContext } from "./explorer-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExplorerPageProps {
  params: Promise<{
    repoId: string;
  }>;
  searchParams?: Promise<{
    analysis_run_id?: string | string[];
    start_node_id?: string | string[];
    run_id?: string | string[];
    node_id?: string | string[];
  }>;
}

export default async function ExplorerPage({ params, searchParams }: ExplorerPageProps) {
  const { repoId } = await params;
  const session = await auth();

  if (!session.isAuthenticated || !session.userId) {
    session.redirectToSignIn({
      returnBackUrl: `/repositories/${repoId}/explorer`,
    });
    return null;
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const contextResult = resolveRepositoryAnalysisContext({
    repoId,
    searchParams: resolvedSearchParams,
  });

  if (!contextResult.ok) {
    if (contextResult.reason === "repository_not_found") {
      return (
        <main className="p-8 max-w-xl mx-auto text-center" data-testid="explorer-not-found">
          <h1 className="text-2xl font-bold mb-4">Repository Not Found</h1>
          <p className="text-slate-600 mb-6">{contextResult.message}</p>
          <Link href="/dashboard" className="text-blue-600 hover:underline">
            Back to Dashboard
          </Link>
        </main>
      );
    }

    // analysis_not_ready or error
    return (
      <main className="p-8 max-w-xl mx-auto text-center" data-testid="explorer-empty-state">
        <h1 className="text-2xl font-bold mb-4">Graph Analysis Not Ready</h1>
        <p className="text-slate-600 mb-6">{contextResult.message}</p>
        <Link href="/dashboard" className="text-blue-600 hover:underline">
          Back to Dashboard
        </Link>
      </main>
    );
  }

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
    <main className="w-full h-screen flex flex-col">
      <ArchitectureExplorerClient apiUrl={apiUrl} context={contextResult.context} />
    </main>
  );
}
