import {
  createRepository,
  enqueueJob,
  getGithubInstallationByOrganizationId,
  getPool,
  getRepositoryByGithubRepoId,
  RepositoryConflictError,
  updateRepository,
} from "@fluxora/db";
import {
  REPOSITORY_INGEST_JOB_TYPE,
  repositoryIngestIdempotencyKey,
  type EnqueueJobInput,
  type GithubInstallation,
  type Job,
  type Repository,
} from "@fluxora/shared-types";

import type { GithubAppConfig } from "../github/config.ts";
import {
  createGithubRepositoryClient,
  type GithubRepositoryClient,
} from "../github/repository-client.ts";

export class GithubInstallationNotConnectedError extends Error {
  constructor() {
    super("GitHub App installation is not connected for this organization.");
    this.name = "GithubInstallationNotConnectedError";
  }
}

export class GithubInstallationMismatchError extends Error {
  constructor() {
    super(
      "The requested GitHub installation is not connected to this organization.",
    );
    this.name = "GithubInstallationMismatchError";
  }
}

export interface ConnectRepositoryInput {
  organizationId: string;
  githubInstallationId: string;
  repoFullName: string;
  ref: string;
  config: GithubAppConfig;
  github?: GithubRepositoryClient;
  store?: ConnectRepositoryStore;
}

export interface ConnectRepositoryResult {
  repository: Repository;
  job: Job;
  commitSha: string;
}

export interface ConnectRepositoryStore {
  getInstallation(
    organizationId: string,
  ): Promise<GithubInstallation | null>;
  getRepositoryByGithubRepoId(
    organizationId: string,
    githubRepoId: string,
  ): Promise<Repository | null>;
  createRepository(input: {
    organizationId: string;
    githubRepoId: string;
    name: string;
    defaultBranch: string;
  }): Promise<Repository>;
  updateRepository(
    organizationId: string,
    repositoryId: string,
    patch: {
      name?: string;
      defaultBranch?: string;
      connectionStatus?: Repository["connectionStatus"];
    },
  ): Promise<Repository | null>;
  enqueueJob(input: EnqueueJobInput): Promise<Job>;
}

const productionStore: ConnectRepositoryStore = {
  getInstallation: async (organizationId) =>
    getGithubInstallationByOrganizationId(getPool(), organizationId),
  getRepositoryByGithubRepoId: async (organizationId, githubRepoId) =>
    getRepositoryByGithubRepoId(getPool(), organizationId, githubRepoId),
  createRepository: async (input) =>
    createRepository(getPool(), {
      ...input,
      connectionStatus: "pending",
    }),
  updateRepository: async (organizationId, repositoryId, patch) =>
    updateRepository(getPool(), organizationId, repositoryId, patch),
  enqueueJob,
};

export async function connectRepository(
  input: ConnectRepositoryInput,
): Promise<ConnectRepositoryResult> {
  const store = input.store ?? productionStore;
  const installation = await store.getInstallation(input.organizationId);

  if (installation === null) {
    throw new GithubInstallationNotConnectedError();
  }

  if (installation.githubInstallationId !== input.githubInstallationId) {
    throw new GithubInstallationMismatchError();
  }

  const github =
    input.github ??
    createGithubRepositoryClient({
      config: input.config,
    });

  const resolved = await github.getRepositoryAndCommit(
    installation.githubInstallationId,
    input.repoFullName,
    input.ref,
  );

  const repository = await findOrCreateRepository(store, {
    organizationId: input.organizationId,
    githubRepoId: resolved.repository.githubRepoId,
    name: repositoryName(resolved.repository.fullName),
    defaultBranch: resolved.repository.defaultBranch,
  });

  const desiredName = repositoryName(resolved.repository.fullName);
  const needsPendingUpdate =
    repository.connectionStatus !== "pending" ||
    repository.name !== desiredName ||
    repository.defaultBranch !== resolved.repository.defaultBranch;

  const pendingRepository = needsPendingUpdate
    ? ((await store.updateRepository(input.organizationId, repository.id, {
        name: desiredName,
        defaultBranch: resolved.repository.defaultBranch,
        connectionStatus: "pending",
      })) ?? repository)
    : repository;

  const job = await store.enqueueJob({
    organizationId: input.organizationId,
    type: REPOSITORY_INGEST_JOB_TYPE,
    payload: {
      repositoryId: pendingRepository.id,
      ref: input.ref,
      commitSha: resolved.commit.sha,
    },
    idempotencyKey: repositoryIngestIdempotencyKey(
      pendingRepository.id,
      resolved.commit.sha,
    ),
  });

  return {
    repository: pendingRepository,
    job,
    commitSha: resolved.commit.sha,
  };
}

async function findOrCreateRepository(
  store: ConnectRepositoryStore,
  input: {
    organizationId: string;
    githubRepoId: string;
    name: string;
    defaultBranch: string;
  },
): Promise<Repository> {
  const existing = await store.getRepositoryByGithubRepoId(
    input.organizationId,
    input.githubRepoId,
  );

  if (existing !== null) {
    return existing;
  }

  try {
    return await store.createRepository(input);
  } catch (error) {
    if (!(error instanceof RepositoryConflictError)) {
      throw error;
    }

    const raced = await store.getRepositoryByGithubRepoId(
      input.organizationId,
      input.githubRepoId,
    );

    if (raced === null) {
      throw error;
    }

    return raced;
  }
}

function repositoryName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}
