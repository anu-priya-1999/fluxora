import {
  metrics,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
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

// ---------------------------------------------------------------------------
// Dedicated AI Gateway Telemetry Instruments (Phase 9)
// ---------------------------------------------------------------------------

const aiRequestsCounter: Counter = meter.createCounter(
  "fluxora.ai.gateway.requests",
  {
    description: "Total number of completed AI model gateway requests.",
    unit: "{request}",
  },
);

const aiAttemptsCounter: Counter = meter.createCounter(
  "fluxora.ai.gateway.attempts",
  {
    description: "Total number of AI provider invocation attempts.",
    unit: "{attempt}",
  },
);

const aiInputTokensCounter: Counter = meter.createCounter(
  "fluxora.ai.tokens.input",
  {
    description: "Total count of input tokens reported by AI providers.",
    unit: "{token}",
  },
);

const aiOutputTokensCounter: Counter = meter.createCounter(
  "fluxora.ai.tokens.output",
  {
    description: "Total count of output tokens reported by AI providers.",
    unit: "{token}",
  },
);

const aiCostHistogram: Histogram = meter.createHistogram(
  "fluxora.ai.cost.usd",
  {
    description: "Estimated cost of AI provider requests in USD.",
    unit: "USD",
  },
);

const aiRequestLatencyHistogram: Histogram = meter.createHistogram(
  "fluxora.ai.gateway.latency",
  {
    description: "Total end-to-end latency of AI gateway requests in milliseconds.",
    unit: "ms",
  },
);

const aiAttemptLatencyHistogram: Histogram = meter.createHistogram(
  "fluxora.ai.attempt.latency",
  {
    description: "Latency of individual AI provider attempts in milliseconds.",
    unit: "ms",
  },
);

const aiFallbackExecutionsCounter: Counter = meter.createCounter(
  "fluxora.ai.fallback.executions",
  {
    description: "Total number of deterministic AI fallback explanations executed.",
  },
);

export function recordAiFallbackExecution(attributes: Attributes = {}): void {
  aiFallbackExecutionsCounter.add(1, attributes);
}

export function recordAiGatewayRequest(attributes: Attributes = {}): void {
  aiRequestsCounter.add(1, attributes);
}

export function recordAiGatewayAttempt(attributes: Attributes = {}): void {
  aiAttemptsCounter.add(1, attributes);
}

export function recordAiTokenUsage(
  inputTokens: number,
  outputTokens: number,
  attributes: Attributes = {},
): void {
  if (inputTokens > 0) {
    aiInputTokensCounter.add(inputTokens, attributes);
  }
  if (outputTokens > 0) {
    aiOutputTokensCounter.add(outputTokens, attributes);
  }
}

export function recordAiCost(
  costUsd: number,
  attributes: Attributes = {},
): void {
  if (costUsd >= 0) {
    aiCostHistogram.record(costUsd, attributes);
  }
}

export function recordAiRequestLatency(
  latencyMs: number,
  attributes: Attributes = {},
): void {
  if (latencyMs >= 0) {
    aiRequestLatencyHistogram.record(latencyMs, attributes);
  }
}

export function recordAiAttemptLatency(
  latencyMs: number,
  attributes: Attributes = {},
): void {
  if (latencyMs >= 0) {
    aiAttemptLatencyHistogram.record(latencyMs, attributes);
  }
}

export function emitAiGatewayLog(
  body: string,
  severity: "info" | "warn" | "error" = "info",
  attributes: Attributes = {},
): void {
  let severityNumber = SeverityNumber.INFO;
  let severityText = "INFO";

  if (severity === "warn") {
    severityNumber = SeverityNumber.WARN;
    severityText = "WARN";
  } else if (severity === "error") {
    severityNumber = SeverityNumber.ERROR;
    severityText = "ERROR";
  }

  logger.emit({
    body,
    severityNumber,
    severityText,
    attributes,
    eventName: `fluxora.ai.gateway.${severity === "error" ? "failed" : "event"}`,
  });
}

export { tracer, meter, logger };
