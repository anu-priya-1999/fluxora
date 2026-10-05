# Fluxora — Phase 1 Step 7 — OpenTelemetry Implementation Notes

## 1. Step objective

Canonical roadmap requirement:

> Wire up OpenTelemetry traces/metrics/logs end to end for one dummy endpoint and confirm data reaches the observability backend.

Implemented scope:

```text
shared observability package
        +
OTel SDK configuration
        +
API instrumentation
        +
worker instrumentation
        +
dummy telemetry endpoint
        +
local Collector verification
```

Steps 8–9 remain outside this implementation.

---

## 2. Final architecture

```text
apps/api
   │
   ├── HTTP instrumentation
   ├── manual Fluxora span
   ├── manual log
   └── metrics
          │
          ▼
 @fluxora/observability
          │
          ▼
 OpenTelemetry SDK
          │
        OTLP/HTTP
          │
          ▼
 OpenTelemetry Collector
          │
          ▼
       debug exporter
```

Worker direction:

```text
JobWorker
   │
   └── fluxora.worker.job.process
          │
          ▼
 @fluxora/observability
```

---

## 3. Package introduced

```text
packages/observability/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── config.ts
    ├── sdk.ts
    ├── tracer.ts
    └── signals.ts
```

Primary responsibility:

```text
@fluxora/observability
```

centralizes OpenTelemetry implementation details.

---

## 4. Dependencies

The package uses the OpenTelemetry Node SDK and OTLP exporters for:

```text
traces
metrics
logs
```

Additional pieces include:

```text
resources
semantic conventions
HTTP instrumentation
OpenTelemetry APIs
```

The API explicitly depends on:

```text
@fluxora/observability
@opentelemetry/instrumentation
```

The workers explicitly depend on:

```text
@fluxora/observability
```

---

## 5. Configuration

`config.ts` centralizes:

```text
serviceName
serviceVersion
environment
tracesEndpoint
metricsEndpoint
logsEndpoint
metricExportIntervalMs
```

Default OTLP base endpoint:

```text
http://localhost:4318
```

Signal endpoints are derived as:

```text
/v1/traces
/v1/metrics
/v1/logs
```

Signal-specific environment variables override the derived endpoints.

---

## 6. Resource configuration

The SDK creates a resource containing:

```text
service.name
service.version
deployment.environment.name
```

API verification showed:

```text
service.name = @fluxora/api
service.version = 0.0.0
deployment.environment.name = development
```

---

## 7. SDK configuration

The shared SDK creates:

### Traces

```text
OTLPTraceExporter
```

### Metrics

```text
OTLPMetricExporter
PeriodicExportingMetricReader
```

### Logs

```text
OTLPLogExporter
BatchLogRecordProcessor
```

### Instrumentation

```text
HttpInstrumentation
```

---

## 8. API initialization

New file:

```text
apps/api/src/telemetry.ts
```

Responsibilities:

```text
load environment
register OTel ESM instrumentation hook
load observability package
load observability config
create SDK
start SDK
export graceful shutdown
```

API start command:

```text
node --experimental-strip-types --import ./src/telemetry.ts src/server.ts
```

Reason:

OpenTelemetry initialization has to happen before application modules that need instrumentation are loaded.

---

## 9. API HTTP instrumentation

The API uses:

```text
@opentelemetry/instrumentation-http
```

This produced automatic HTTP telemetry including:

```text
http.server.request.duration
```

for the dummy endpoint.

The Collector output identified the instrumentation scope as:

```text
@opentelemetry/instrumentation-http 0.222.0
```

---

## 10. Manual tracing helper

`tracer.ts` provides Fluxora-level helpers around the OpenTelemetry trace API.

Key helpers:

```text
getTracer()
markSpanSuccess()
markSpanError()
```

This keeps application code from repeatedly implementing OpenTelemetry status/error handling.

---

## 11. Manual signal helpers

`signals.ts` provides:

```text
recordDummyTelemetryCall()
emitDummyTelemetryLog()
getObservabilityTracer()
```

An important correction made during implementation:

Telemetry instruments were initially created at module load time. They were changed to lazy lookup so tracer/meter/logger acquisition happens after SDK/provider initialization.

This was necessary because provider initialization order matters.

---

## 12. Dummy endpoint

Route:

```text
GET /api/v1/telemetry/dummy
```

Expected response:

```json
{
  "ok": true,
  "service": "fluxora-api"
}
```

On request:

### Trace

```text
fluxora.telemetry.dummy
```

### Log

```text
fluxora.telemetry.dummy.request
```

### Metric

HTTP instrumentation provides:

```text
http.server.request.duration
```

The custom counter helper was also implemented:

```text
fluxora.telemetry.dummy.calls
```

---

## 13. Span behavior

The dummy endpoint uses:

```text
startActiveSpan("fluxora.telemetry.dummy")
```

The span is:

```text
created
   ↓
endpoint executes
   ↓
success/error recorded
   ↓
span.end()
```

Successful Collector output showed:

```text
Status code: Ok
```

---

## 14. Log behavior

The manual log event:

```text
fluxora.telemetry.dummy.request
```

contains:

```text
body:
Fluxora dummy telemetry endpoint invoked.

attribute:
fluxora.endpoint=/api/v1/telemetry/dummy
```

The Collector also showed:

```text
Trace ID
Span ID
```

for these log records, demonstrating correlation.

---

## 15. Worker instrumentation

`apps/workers/src/worker.ts` was instrumented around job processing.

Span name:

```text
fluxora.worker.job.process
```

Attributes:

```text
fluxora.worker.id
fluxora.job.id
fluxora.job.type
fluxora.job.organization_id
fluxora.job.attempt
```

This does not change Step 6 queue semantics.

These operations remain untouched:

```text
claimNextJob()
completeJob()
failJob()
retryFailedJob()
```

The worker package does not currently have a standalone process entrypoint, so no new worker runtime was invented just for observability.

---

## 16. Local Collector

Local folder:

```text
.observability/
├── collector-config.yaml
├── otelcol.exe
├── otelcol.tar.gz
└── README.md
```

Collector configuration:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]

    metrics:
      receivers: [otlp]
      exporters: [debug]

    logs:
      receivers: [otlp]
      exporters: [debug]
```

Purpose:

```text
receive OTLP
   ↓
print telemetry
```

This allowed end-to-end local verification without Docker.

---

## 17. Verification sequence

### Collector

Validated successfully and started on:

```text
[::]:4318
```

Collector reported:

```text
Everything is ready.
Begin running and processing data.
```

### API

Started successfully:

```text
[observability] OpenTelemetry started for @fluxora/api
Fluxora API listening on port 4000
```

### Endpoint

Request:

```text
GET http://127.0.0.1:4000/api/v1/telemetry/dummy
```

Response:

```text
200
{"ok":true,"service":"fluxora-api"}
```

---

## 18. End-to-end evidence

The final Collector evidence showed:

### Logs

```text
otelcol.signal = logs
resource logs = 1
log records = 3
```

Service:

```text
@fluxora/api
```

Event:

```text
fluxora.telemetry.dummy.request
```

### Traces

```text
otelcol.signal = traces
resource spans = 1
spans = 6
```

Service:

```text
@fluxora/api
```

Fluxora-specific spans:

```text
fluxora.telemetry.dummy
```

Status:

```text
Ok
```

### Metrics

The Collector received metrics from:

```text
@fluxora/api
```

including:

```text
http.server.request.duration
```

for:

```text
GET
200
```

Therefore the telemetry pipeline is proven end-to-end.

---

## 19. Important debugging issues encountered

### Issue 1 — invalid OpenTelemetry version

Initial dependency spec incorrectly used:

```text
@opentelemetry/api ^2.0.0
```

The registry had:

```text
@opentelemetry/api 1.9.1
```

The dependency was corrected.

---

### Issue 2 — missing API workspace dependency

The API imported:

```text
@fluxora/observability
```

but did not declare it.

Result:

```text
TS2307
Cannot find module '@fluxora/observability'
```

Fix:

```text
pnpm --filter @fluxora/api add @fluxora/observability@workspace:*
```

---

### Issue 3 — wrong Logger import

`Logger` was initially imported from:

```text
@opentelemetry/api
```

The correct Logs API is:

```text
@opentelemetry/api-logs
```

The unused `Logger` type was then removed because inference was sufficient.

---

### Issue 4 — missing instrumentation package

The API start command referenced:

```text
@opentelemetry/instrumentation/hook.mjs
```

but `@opentelemetry/instrumentation` was not an API dependency.

Result:

```text
ERR_MODULE_NOT_FOUND
```

Fix:

```text
pnpm --filter @fluxora/api add @opentelemetry/instrumentation@0.222.0
```

and startup was changed to use Node `--import`.

---

### Issue 5 — telemetry initialization order

Signal instruments were initially created eagerly before the SDK provider was fully established.

Fix:

```text
lazy tracer lookup
lazy meter lookup
lazy logger lookup
```

This ensured the active providers are used after initialization.

---

### Issue 6 — Collector config indentation

The first Collector YAML accidentally placed `pipelines` under `exporters`.

It was corrected to:

```text
receivers
exporters
service:
  pipelines:
```

Collector validation then succeeded.

---

## 20. HTTP exporter self-instrumentation

Because HTTP instrumentation is enabled, the application's OTLP exporter requests to:

```text
localhost:4318
```

are themselves HTTP requests.

The Collector output therefore showed:

```text
http.client.request.duration
```

for OTLP POSTs.

This is expected instrumentation behavior but can produce noisy telemetry.

It is a useful production-design consideration: exporter traffic should not pollute application request telemetry.

---

## 21. Production evolution

MVP local setup:

```text
API
 ↓
OTLP
 ↓
Collector
 ↓
debug exporter
```

Production can become:

```text
API + Workers
      ↓
OpenTelemetry
      ↓
Collector
      ↓
traces backend
metrics backend
logs backend
      ↓
dashboards / alerts
```

The application should remain largely unchanged when the backend changes.

---

## 22. Expected future Fluxora instrumentation

As the product grows:

### API

```text
HTTP request
auth
DB query
job enqueue
```

### Workers

```text
job claim
repository ingestion
snapshot packaging
static analysis
graph construction
impact analysis
simulation
AI request
```

### Metrics

```text
queue depth
job duration
retry count
dead-letter count
analysis duration
graph size
AI latency
AI tokens/cost
failure rate
```

### Logs

```text
job failures
GitHub errors
analysis warnings
AI failures
security events
```

---

## 23. Security rules for telemetry

Never put these into telemetry casually:

```text
GitHub tokens
Clerk secrets
JWTs
repository contents
full source files
AI prompts containing secrets
private credentials
```

Telemetry must be treated as potentially sensitive.

Tenant identifiers should be added only where there is a clear operational need and where the resulting cardinality/privacy characteristics are understood.

---

## 24. Step 7 acceptance criteria

```text
OpenTelemetry package                         ✅
trace configuration                          ✅
metric configuration                         ✅
log configuration                            ✅
API instrumentation                          ✅
worker instrumentation                       ✅
dummy endpoint                               ✅
Collector                                    ✅
OTLP export                                  ✅
trace reception                              ✅
metric reception                             ✅
log reception                                ✅
service identity                             ✅
end-to-end verification                      ✅
```

---

## 25. Final interview answer

> "For Fluxora I built a vendor-neutral observability layer using OpenTelemetry. I centralized it in a shared package, initialized the Node SDK before the application modules loaded, enabled HTTP instrumentation, and added business-level spans and logs for a dummy endpoint. I also instrumented job processing in the worker. For verification I ran an OpenTelemetry Collector locally, sent telemetry over OTLP/HTTP, called the dummy API, and verified that the Collector received traces, metrics, and logs for the `@fluxora/api` service. One of the interesting problems I had to solve was Node ESM initialization order and making sure instrumentation providers were active before acquiring telemetry APIs."

---

## 26. Memory anchor

```text
OTEL STEP 7

PACKAGE
→ SDK
→ INSTRUMENT
→ SIGNALS
→ OTLP
→ COLLECTOR
→ VERIFY
```

