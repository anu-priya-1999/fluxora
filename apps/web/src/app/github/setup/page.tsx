import { auth } from "@clerk/nextjs/server";
import {
  GITHUB_INSTALLATION_COMPLETION_PATH,
  isCanonicalGithubId,
} from "@fluxora/shared-types";
import Link from "next/link";

import { readFluxoraApiUrl, readWebOrigin } from "../../../github/env";

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

  const token = await session.getToken();
  if (!token) {
    return (
      <main>
        <h1>GitHub setup</h1>
        <p>Authentication required.</p>
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

  const response = await fetch(
    `${apiUrl}${GITHUB_INSTALLATION_COMPLETION_PATH}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ github_installation_id: installationId }),
    },
  );

  let payload: unknown = null;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return (
      <main>
        <h1>GitHub setup</h1>
        <p>{messageForCode(readErrorCode(payload))}</p>
        <p>
          <Link href="/dashboard">Back to dashboard</Link>
        </p>
      </main>
    );
  }

  const created = isRecord(payload) && payload.created === true;

  return (
    <main>
      <h1>GitHub setup</h1>
      <p>
        {created
          ? "GitHub installation connected."
          : "GitHub installation already connected."}
      </p>
      <p>
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </main>
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

function messageForCode(code: string | undefined): string {
  switch (code) {
    case "installation_account_mismatch":
      return "That GitHub installation does not belong to the GitHub account you used to sign in.";
    case "installation_not_found":
      return "GitHub could not find that installation.";
    case "installation_conflict":
      return "That GitHub installation is already connected.";
    case "github_app_not_configured":
    case "github_app_misconfigured":
      return "The GitHub App is not configured on the API.";
    case "invalid_session":
      return "Authentication required.";
    case "github_account_required":
    case "email_required":
      return "Sign in with the GitHub account that owns the installation.";
    default:
      return "GitHub installation could not be completed.";
  }
}

function readErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return undefined;
  }

  return typeof payload.error.code === "string"
    ? payload.error.code
    : undefined;
}

function oneParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
