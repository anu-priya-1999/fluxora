import { redirect } from "next/navigation";

export const runtime = "nodejs";

interface RepoSimulationRedirectPageProps {
  params: Promise<{
    repoId: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RepoSimulationRedirectPage({
  params,
  searchParams,
}: RepoSimulationRedirectPageProps) {
  const { repoId } = await params;
  const resolved = searchParams ? await searchParams : {};
  const queryParams = new URLSearchParams();

  queryParams.set("repository_id", repoId);

  for (const [key, value] of Object.entries(resolved)) {
    if (key !== "repository_id" && key !== "repo_id") {
      if (typeof value === "string") {
        queryParams.set(key, value);
      } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
        queryParams.set(key, value[0]);
      }
    }
  }

  redirect(`/simulations?${queryParams.toString()}`);
}

