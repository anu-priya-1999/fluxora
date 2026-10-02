import { auth } from "@clerk/nextjs/server";
import { isCanonicalGithubId } from "@fluxora/shared-types";
import Link from "next/link";

import { readFluxoraApiUrl, readWebOrigin } from "../../../github/env";
import { GithubSetupCompletion } from "./github-setup-completion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function GithubSetupPage({
  searchParams,
}: {
  searchParams: Promise<{
    installation_id?: string | string[];
    setup_action?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const installationId = oneParam(params.installation_id);
  const setupAction = oneParam(params.setup_action);
  const session = await auth();

  if (!session.isAuthenticated) {
    session.redirectToSignIn({
      returnBackUrl: returnPath(installationId, setupAction),
    });
    return null;
  }

  if (installationId === undefined || !isCanonicalGithubId(installationId)) {
    return (
      <main>
        <h1>GitHub setup</h1>
        <p>GitHub did not return an installation id.</p>
        <p>
          <Link href="/dashboard">Back to dashboard</Link>
        </p>
      </main>
    );
  }

  if (
    setupAction !== undefined &&
    setupAction !== "install" &&
    setupAction !== "update"
  ) {
    return (
      <main>
        <h1>GitHub setup</h1>
        <p>GitHub returned an unsupported setup action.</p>
        <p>
          <Link href="/dashboard">Back to dashboard</Link>
        </p>
      </main>
    );
  }

  let apiUrl: string;
  try {
    apiUrl = readFluxoraApiUrl();
  } catch {
    return (
      <main>
        <h1>GitHub setup</h1>
        <p>Fluxora API URL is not configured.</p>
      </main>
    );
  }

  return (
    <GithubSetupCompletion apiUrl={apiUrl} installationId={installationId} />
  );
}

function returnPath(
  installationId: string | undefined,
  setupAction: string | undefined,
): string {
  if (installationId === undefined || !isCanonicalGithubId(installationId)) {
    return `${readWebOrigin()}/github/setup`;
  }

  const action =
    setupAction === "install" || setupAction === "update"
      ? `&setup_action=${setupAction}`
      : "";

  return `${readWebOrigin()}/github/setup?installation_id=${installationId}${action}`;
}

function oneParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
