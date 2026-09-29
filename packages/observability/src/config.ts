export interface ObservabilityConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  tracesEndpoint: string;
  metricsEndpoint: string;
  logsEndpoint: string;
  metricExportIntervalMs: number;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSignalEndpoint(
  baseEndpoint: string,
  signal: "traces" | "metrics" | "logs",
): string {
  const normalized = baseEndpoint.replace(/\/+$/, "");

  if (normalized.endsWith(`/v1/${signal}`)) {
    return normalized;
  }

  return `${normalized}/v1/${signal}`;
}

export function loadObservabilityConfig(
  defaultServiceName: string,
): ObservabilityConfig {
  const baseEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  return {
    serviceName:
      process.env.OTEL_SERVICE_NAME ?? defaultServiceName,
    serviceVersion:
      process.env.FLUXORA_SERVICE_VERSION ?? "0.0.0",
    environment:
      process.env.NODE_ENV ?? "development",

    tracesEndpoint:
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      buildSignalEndpoint(baseEndpoint, "traces"),

    metricsEndpoint:
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
      buildSignalEndpoint(baseEndpoint, "metrics"),

    logsEndpoint:
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
      buildSignalEndpoint(baseEndpoint, "logs"),

    metricExportIntervalMs: readPositiveInteger(
      process.env.OTEL_METRIC_EXPORT_INTERVAL_MS,
      10_000,
    ),
  };
}
