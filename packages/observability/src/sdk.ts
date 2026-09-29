import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import type { ObservabilityConfig } from "./config.ts";

export function createOpenTelemetrySdk(config: ObservabilityConfig): NodeSDK {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
  });

  const traceExporter = new OTLPTraceExporter({
    url: config.tracesEndpoint,
  });

  const metricExporter = new OTLPMetricExporter({
    url: config.metricsEndpoint,
  });

  const logExporter = new OTLPLogExporter({
    url: config.logsEndpoint,
  });

  return new NodeSDK({
    resource,

    traceExporter,

    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.metricExportIntervalMs,
      }),
    ],

    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: logExporter,
      }),
    ],

    instrumentations: [new HttpInstrumentation()],
  });
}

export async function shutdownOpenTelemetrySdk(sdk: NodeSDK): Promise<void> {
  await sdk.shutdown();
}
