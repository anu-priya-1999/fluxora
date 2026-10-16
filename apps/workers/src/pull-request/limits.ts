export interface PullRequestLimits {
  maxFileCount: number;
  maxPatchBytesPerFile: number;
  maxTotalPatchBytes: number;
}

export const DEFAULT_PULL_REQUEST_LIMITS: PullRequestLimits = {
  maxFileCount: 1_000,
  maxPatchBytesPerFile: 512 * 1024, // 512 KB
  maxTotalPatchBytes: 10 * 1024 * 1024, // 10 MB
};

export function loadPullRequestLimits(
  env: NodeJS.ProcessEnv = process.env,
): PullRequestLimits {
  return {
    maxFileCount: readPositiveInt(
      env.FLUXORA_PR_MAX_FILE_COUNT,
      DEFAULT_PULL_REQUEST_LIMITS.maxFileCount,
    ),
    maxPatchBytesPerFile: readPositiveInt(
      env.FLUXORA_PR_MAX_PATCH_BYTES,
      DEFAULT_PULL_REQUEST_LIMITS.maxPatchBytesPerFile,
    ),
    maxTotalPatchBytes: readPositiveInt(
      env.FLUXORA_PR_MAX_TOTAL_PATCH_BYTES,
      DEFAULT_PULL_REQUEST_LIMITS.maxTotalPatchBytes,
    ),
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("pull request limit environment variables must be positive integers");
  }

  return parsed;
}

