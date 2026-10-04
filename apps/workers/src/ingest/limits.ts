export interface IngestLimits {
  maxFileCount: number;
  maxTotalBytes: number;
  maxArchiveBytes: number;
  timeoutMs: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxFileCount: 10_000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxArchiveBytes: 50 * 1024 * 1024,
  timeoutMs: 60_000,
};

export function loadIngestLimits(
  env: NodeJS.ProcessEnv = process.env,
): IngestLimits {
  return {
    maxFileCount: readPositiveInt(
      env.FLUXORA_INGEST_MAX_FILE_COUNT,
      DEFAULT_INGEST_LIMITS.maxFileCount,
    ),
    maxTotalBytes: readPositiveInt(
      env.FLUXORA_INGEST_MAX_TOTAL_BYTES,
      DEFAULT_INGEST_LIMITS.maxTotalBytes,
    ),
    maxArchiveBytes: readPositiveInt(
      env.FLUXORA_INGEST_MAX_ARCHIVE_BYTES,
      DEFAULT_INGEST_LIMITS.maxArchiveBytes,
    ),
    timeoutMs: readPositiveInt(
      env.FLUXORA_INGEST_TIMEOUT_MS,
      DEFAULT_INGEST_LIMITS.timeoutMs,
    ),
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ingestion limit environment variables must be positive integers");
  }

  return parsed;
}
