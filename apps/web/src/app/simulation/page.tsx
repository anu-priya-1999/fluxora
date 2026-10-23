import { redirect } from "next/navigation";

export const runtime = "nodejs";

interface SimulationRedirectPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SimulationRedirectPage({ searchParams }: SimulationRedirectPageProps) {
  const resolved = searchParams ? await searchParams : {};
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
      params.set(key, value[0]);
    }
  }

  const query = params.toString();
  redirect(`/simulations${query ? `?${query}` : ""}`);
}

