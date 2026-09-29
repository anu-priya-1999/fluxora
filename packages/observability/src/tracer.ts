import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

export function getTracer(
  instrumentationName: string,
  instrumentationVersion = "0.0.0",
) {
  return trace.getTracer(instrumentationName, instrumentationVersion);
}

export function markSpanSuccess(span: Span): void {
  span.setStatus({
    code: SpanStatusCode.OK,
  });
}

export function markSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
  } else {
    span.recordException(String(error));
  }

  span.setStatus({
    code: SpanStatusCode.ERROR,
  });
}

export type SpanAttributes = Attributes;
