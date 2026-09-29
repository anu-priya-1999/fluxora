import {
  metrics,
  trace,
  type Attributes,
  type Counter,
} from "@opentelemetry/api";

import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("@fluxora/observability");
const meter = metrics.getMeter("@fluxora/observability");
const logger = logs.getLogger("@fluxora/observability");

const dummyRequestCounter: Counter = meter.createCounter(
  "fluxora.telemetry.dummy.calls",
  {
    description: "Number of calls to the Fluxora dummy telemetry endpoint.",
    unit: "{call}",
  },
);

export function recordDummyTelemetryCall(attributes: Attributes = {}): void {
  dummyRequestCounter.add(1, attributes);
}

export function emitDummyTelemetryLog(
  body: string,
  attributes: Attributes = {},
): void {
  logger.emit({
    body,
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    attributes,
    eventName: "fluxora.telemetry.dummy.request",
  });
}

export { tracer };
