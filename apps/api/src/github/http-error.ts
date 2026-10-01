import {
  GithubInstallationAccountMismatchError,
  GithubInstallationConflictError,
  GithubInstallationValidationError,
} from "@fluxora/db";

import {
  GithubAppMisconfiguredError,
  GithubInstallationRoleError,
} from "./complete-installation.ts";
import { GithubInstallationIdError } from "./installation-id.ts";
import { GithubInstallationResponseError } from "./parse-installation.ts";
import {
  GithubAppRequestError,
  InstallationOwnershipError,
} from "./verify-installation.ts";

export interface GithubInstallationHttpError {
  status: number;
  code: string;
  message: string;
}

export function githubInstallationHttpError(
  error: unknown,
): GithubInstallationHttpError | null {
  if (error instanceof GithubInstallationIdError) {
    return {
      status: 400,
      code: "invalid_installation_id",
      message: "github_installation_id must be a positive decimal string.",
    };
  }

  if (error instanceof GithubInstallationRoleError) {
    return {
      status: 403,
      code: "insufficient_role",
      message: "Only an owner or admin can connect a GitHub installation.",
    };
  }

  if (
    error instanceof InstallationOwnershipError ||
    error instanceof GithubInstallationAccountMismatchError
  ) {
    return {
      status: 403,
      code: "installation_account_mismatch",
      message:
        "The GitHub App installation must belong to the same personal GitHub account used to sign in.",
    };
  }

  if (error instanceof GithubAppRequestError && error.status === "not_found") {
    return {
      status: 404,
      code: "installation_not_found",
      message: "GitHub installation was not found.",
    };
  }

  if (error instanceof GithubInstallationConflictError) {
    return {
      status: 409,
      code: "installation_conflict",
      message: "That GitHub installation is already connected.",
    };
  }

  if (
    error instanceof GithubAppMisconfiguredError ||
    (error instanceof GithubAppRequestError && error.status === "misconfigured")
  ) {
    return {
      status: 503,
      code: "github_app_misconfigured",
      message: "GitHub App credentials are not usable.",
    };
  }

  if (
    error instanceof GithubInstallationResponseError ||
    error instanceof GithubInstallationValidationError ||
    (error instanceof GithubAppRequestError && error.status === "unavailable")
  ) {
    return {
      status: 502,
      code: "github_unavailable",
      message: "GitHub could not be reached to verify the installation.",
    };
  }

  return null;
}
