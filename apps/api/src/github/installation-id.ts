import { isCanonicalGithubId } from "@fluxora/shared-types";

export class GithubInstallationIdError extends Error {
  constructor() {
    super("github_installation_id must be a positive decimal string.");
    this.name = "GithubInstallationIdError";
  }
}

/** Accepts only a JSON string. JSON numbers are rejected so precision cannot be lost. */
export function parseGithubInstallationId(value: unknown): string {
  if (typeof value !== "string" || !isCanonicalGithubId(value)) {
    throw new GithubInstallationIdError();
  }

  return value;
}

export function readGithubInstallationIdField(body: unknown): string {
  if (!isRecord(body) || !Object.hasOwn(body, "github_installation_id")) {
    throw new GithubInstallationIdError();
  }

  return parseGithubInstallationId(body.github_installation_id);
}

export function parseClerkGithubUserId(value: string): {
  text: string;
  numeric: number;
} {
  if (!isCanonicalGithubId(value)) {
    throw new GithubInstallationIdError();
  }

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new GithubInstallationIdError();
  }

  return { text: value, numeric };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
