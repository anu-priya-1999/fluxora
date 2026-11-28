/** Supported external runtime telemetry providers (`06-database-schema.md`). */
export const TelemetryProviders = ["datadog", "otel", "newrelic"] as const;

export type TelemetryProvider = (typeof TelemetryProviders)[number];

/** Minimal explicit lifecycle states for a configured telemetry source. */
export const TelemetrySourceStatuses = [
  "pending",
  "active",
  "error",
  "disabled",
] as const;

export type TelemetrySourceStatus = (typeof TelemetrySourceStatuses)[number];

/** Allowed state transitions for `TelemetrySource.status`. */
export const TELEMETRY_SOURCE_STATUS_TRANSITIONS: Record<
  TelemetrySourceStatus,
  readonly TelemetrySourceStatus[]
> = {
  pending: ["pending", "active", "error", "disabled"],
  active: ["active", "error", "disabled"],
  error: ["error", "pending", "active", "disabled"],
  disabled: ["disabled", "pending", "active"],
};

/**
 * Opaque encrypted configuration envelope (`enc:v<N>:...` or `kms:v<N>:...`).
 * Plaintext credentials or JSON objects must never be stored in `TelemetrySource.connectionConfig`.
 */
export type EncryptedConnectionConfig = string;

export interface TelemetrySource {
  id: string;
  repositoryId: string;
  provider: TelemetryProvider;
  connectionConfig: EncryptedConnectionConfig;
  status: TelemetrySourceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Observation {
  id: string;
  telemetrySourceId: string;
  repositoryId: string;
  /** Nullable until runtime telemetry is correlated to a deterministic GraphNode. */
  nodeId: string | null;
  metricName: string;
  /** Exact decimal string preserving PostgreSQL `NUMERIC` precision. */
  value: string;
  observedAt: Date;
  createdAt: Date;
}
