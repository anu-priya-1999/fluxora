export class PermanentJobError extends Error {
  readonly retryable = false as const;

  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export class RetryableJobError extends Error {
  readonly retryable = true as const;

  constructor(message: string) {
    super(message);
    this.name = "RetryableJobError";
  }
}

/** Default: retry. Permanent ingestion/security failures skip `retryFailedJob`. */
export function isRetryableJobError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return error.retryable;
  }

  return true;
}
