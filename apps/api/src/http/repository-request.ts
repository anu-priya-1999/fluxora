import { parseRepositoryFullName } from "../github/repository-client.ts";

export const REPOSITORY_CONNECT_PATH = "/api/v1/repositories/connect";

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function isRepositoryConnectPath(path: string): boolean {
  return path === REPOSITORY_CONNECT_PATH;
}

export function parseConnectBody(body: unknown): {
  githubInstallationId: string;
  repoFullName: string;
  ref: string;
} {
  if (!isRecord(body)) {
    throw new RequestValidationError("Request body must be a JSON object.");
  }

  const githubInstallationId = body["github_installation_id"];
  const repoFullName = body["repo_full_name"];
  const ref = body["branch"];

  if (
    typeof githubInstallationId !== "string" ||
    !/^[1-9]\d*$/.test(githubInstallationId)
  ) {
    throw new RequestValidationError(
      "github_installation_id must be a positive decimal string.",
    );
  }

  if (typeof repoFullName !== "string") {
    throw new RequestValidationError("repo_full_name must be a string.");
  }

  try {
    parseRepositoryFullName(repoFullName);
  } catch {
    throw new RequestValidationError(
      "repo_full_name must use the owner/name format.",
    );
  }

  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 255 ||
    [...ref].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new RequestValidationError(
      "branch must be a non-empty Git ref without control characters.",
    );
  }

  return {
    githubInstallationId,
    repoFullName,
    ref,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}