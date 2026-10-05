import type { RepositoryConnectionStatus } from "@fluxora/shared-types";

export type IngestionErrorCode =
  | "invalid_payload"
  | "tenant_mismatch"
  | "github_auth"
  | "github_rate_limit"
  | "invalid_ref"
  | "repository_too_large"
  | "unsafe_archive"
  | "timeout"
  | "github_unavailable"
  | "misconfigured"
  | "object_storage"
  | "snapshot_conflict";

export interface IngestionErrorDetails {
  fileCount?: number;
  sizeBytes?: number;
  maxTotalBytes?: number;
  maxFileCount?: number;
}

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  readonly retryable: boolean;
  readonly repositoryStatus: RepositoryConnectionStatus | null;
  readonly details: IngestionErrorDetails;

  constructor(input: {
    code: IngestionErrorCode;
    message: string;
    retryable: boolean;
    repositoryStatus?: RepositoryConnectionStatus | null;
    details?: IngestionErrorDetails;
  }) {
    super(input.message);
    this.name = "IngestionError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.repositoryStatus = input.repositoryStatus ?? null;
    this.details = input.details ?? {};
  }
}

export function permanentIngestionError(
  code: IngestionErrorCode,
  message: string,
  options?: {
    repositoryStatus?: RepositoryConnectionStatus | null;
    details?: IngestionErrorDetails;
  },
): IngestionError {
  return new IngestionError({
    code,
    message,
    retryable: false,
    repositoryStatus: options?.repositoryStatus ?? null,
    ...(options?.details === undefined ? {} : { details: options.details }),
  });
}

export function retryableIngestionError(
  code: IngestionErrorCode,
  message: string,
): IngestionError {
  return new IngestionError({
    code,
    message,
    retryable: true,
    repositoryStatus: null,
  });
}
