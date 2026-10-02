import { GITHUB_INSTALLATION_COMPLETION_PATH } from "@fluxora/shared-types";

export type GithubSetupCompletionResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string };

export async function completeGithubInstallationFromBrowser(input: {
  apiUrl: string;
  installationId: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<GithubSetupCompletionResult> {
  const token = await input.getToken();
  if (!token) {
    return { ok: false, message: "Authentication required." };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;

  try {
    response = await fetchImpl(
      `${input.apiUrl}${GITHUB_INSTALLATION_COMPLETION_PATH}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          github_installation_id: input.installationId,
        }),
      },
    );
  } catch {
    return {
      ok: false,
      message: "GitHub installation could not be completed.",
    };
  }

  let payload: unknown = null;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return { ok: false, message: messageForCode(readErrorCode(payload)) };
  }

  return {
    ok: true,
    created: isRecord(payload) && payload.created === true,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
