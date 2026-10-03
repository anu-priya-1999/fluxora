import type { GithubInstallation, UserRole } from "@fluxora/shared-types";

import type { GithubAppConfig } from "./config.ts";
import { createGithubAppJwt, GithubAppJwtError } from "./jwt.ts";
import { parseGithubInstallationId } from "./installation-id.ts";
import {
  GithubAppRequestError,
  InstallationOwnershipError,
  verifyGithubInstallationOwnership,
} from "./verify-installation.ts";

export interface GithubInstallationWriter {
  save(input: {
    organizationId: string;
    githubInstallationId: string;
    githubAccountId: string;
    githubAccountLogin: string;
    githubAccountType: "User";
  }): Promise<{ installation: GithubInstallation; created: boolean }>;
}

export class GithubInstallationRoleError extends Error {
  constructor() {
    super("GitHub installation requires an owner or admin.");
    this.name = "GithubInstallationRoleError";
  }
}

export class GithubAppMisconfiguredError extends Error {
  constructor() {
    super("GitHub App credentials could not be used.");
    this.name = "GithubAppMisconfiguredError";
  }
}

export interface CompleteInstallationInput {
  role: UserRole;
  organizationId: string;
  githubUserId: string;
  githubInstallationId: unknown;
  config: GithubAppConfig;
  writer: GithubInstallationWriter;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function completeInstallation(
  input: CompleteInstallationInput,
): Promise<{ installation: GithubInstallation; created: boolean }> {
  if (input.role !== "owner" && input.role !== "admin") {
    throw new GithubInstallationRoleError();
  }

  const installationId = parseGithubInstallationId(input.githubInstallationId);

  let appJwt: string;
  try {
    appJwt = createGithubAppJwt({
      appId: input.config.appId,
      privateKeyPem: input.config.privateKeyPem,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch (error) {
    const reason =
      error instanceof GithubAppJwtError
        ? error.reason
        : "crypto_signing_failure";
    console.error(`GitHub App JWT could not be created: ${reason}`);
    throw new GithubAppMisconfiguredError();
  }

  const verified = await verifyGithubInstallationOwnership({
    config: input.config,
    installationId,
    appJwt,
    githubUserId: input.githubUserId,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });

  return input.writer.save({
    organizationId: input.organizationId,
    githubInstallationId: verified.installationId,
    githubAccountId: verified.accountId,
    githubAccountLogin: verified.accountLogin,
    githubAccountType: "User",
  });
}

export { GithubAppRequestError, InstallationOwnershipError };
