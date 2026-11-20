# Step 59: Model Gateway Foundation — Engineering Implementation Report

## 1. Executive Summary & Objective

In **Global Step 59** (Phase 9 Step 1), Fluxora introduces the **Model Gateway Foundation** as the single controlled boundary for all outbound LLM requests.

This implementation establishes an isolated, resilient, and observable AI infrastructure layer that strictly separates probabilistic language model generation from Fluxora's deterministic repository intelligence core (Principle P1/P10).

Key achievements:
1. **Provider-Independent Model Gateway Contract**: Narrow, decoupled `ModelGateway` interface accepting pre-assembled `ModelGatewayRequest` and returning normalized `ModelGatewayResponse`.
2. **Official Anthropic Claude Adapter**: Implemented via `@anthropic-ai/sdk` (`^1.10.0`), mapping Messages API parameters, extracting token usage and request IDs, and normalizing error structures.
3. **Task-Aware Model Selection Policy**: Deterministic routing policies mapping `impact_explanation` (20s budget), `simulation_narration` (30s budget), and `chat_query` (45s budget) to primary (`claude-sonnet-5-5`) and secondary fallback (`claude-haiku-5-5`) tiers.
4. **Resilience & Fault Tolerance**: Bounded retries (default 2 retries for transient 5xx/network/timeouts), bounded exponential backoff, parser for `Retry-After` HTTP headers (capped at safety ceiling), single fallback execution on primary exhaustion, and zero retries on fatal authentication or client errors.
5. **Caller Cancellation Propagation**: `AbortSignal` listener on gateway dispatch and sleep backoff loops that immediately aborts pending network timers and aborts in-flight attempts.
6. **Token Usage and Microdollar Cost Calculation**: Injectable pricing registry keyed by model identifier supporting per-token rates (USD per million input/output tokens) with multi-attempt aggregate cost tracking and no fabricated numbers.
7. **Dedicated OpenTelemetry Observability**: Low-cardinality AI metrics (`requests`, `attempts`, `tokens.input`, `tokens.output`, `cost.usd`, `latency`, `attempt.latency`), tracer spans (`fluxora.ai.gateway.request`, `fluxora.ai.provider.attempt`), and structured log events.
8. **Deterministic Mock Mode**: Default local development behavior (`USE_REAL_LLM=false`) generating stable canned responses with zero external network access, zero required API keys, and explicit mock identification.
9. **Zero Credential or Prompt Leakage**: Automated sanitization regex redacting API keys, Bearer tokens, and sensitive headers from all errors and logs.
10. **Exhaustive Test Verification**: 6 dedicated test suites comprising 41 tests passing with 100% offline isolation.

---

## 2. Architecture & Module Boundaries

The Model Gateway lives within `@fluxora/workers` under `apps/workers/src/ai/`:

```text
apps/workers/src/ai/
├── types.ts              # Core contracts: ModelGatewayRequest, ModelGatewayResponse, Provider interfaces
├── errors.ts             # Typed ModelGatewayError hierarchy with sanitization and classification
├── pricing.ts            # DefaultModelPricingRegistry with token cost formulas and multi-attempt aggregation
├── policy.ts             # ModelRoutingPolicy with task timeouts and primary/fallback tiers
├── config.ts             # Config loader integrating SecretsClient and USE_REAL_LLM flag
├── mock-gateway.ts       # MockModelProvider and MockModelGateway for offline local dev and CI
├── anthropic-adapter.ts  # Anthropic Claude provider adapter wrapping @anthropic-ai/sdk
├── gateway.ts            # ProductionModelGateway orchestrator (retries, fallback, backoff, spans, metrics)
├── factory.ts            # createModelGateway factory wiring dependencies
└── index.ts              # Public module exports
```

### Module Boundary Invariants
- **Independence from Deterministic Core**: The Model Gateway has no knowledge of AST extraction, graph traversal, blast-radius calculations, simulation state transitions, or database schemas.
- **No Prompt Templating or Validation**: The gateway receives an already assembled `ModelGatewayRequest` and returns raw model text. Prompt templating, evidence manifest grounding, and structured JSON validation belong to subsequent Phase 9 steps.
- **Provider SDK Isolation**: Anthropic SDK types (`Anthropic.Message`, `Anthropic.APIError`, etc.) remain strictly private to `anthropic-adapter.ts`. The public gateway interface exports only normalized types.

---

## 3. Contracts: Request and Response

### Request Contract (`ModelGatewayRequest`)
```ts
export interface ModelGatewayRequest {
  readonly taskType: ModelTaskType; // "impact_explanation" | "simulation_narration" | "chat_query"
  readonly promptVersion: string;
  readonly systemInstruction?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}
```

### Response Contract (`ModelGatewayResponse`)
```ts
export interface ModelGatewayResponse {
  readonly text: string;
  readonly provider: string; // "anthropic" | "mock"
  readonly model: string;    // Actual model identifier that generated the output
  readonly taskType: ModelTaskType;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly attemptCount: number;
  readonly usedFallback: boolean;
  readonly providerRequestId: string | null;
  readonly stopReason: string | null;
  readonly isMock: boolean;
  readonly attempts: readonly ModelGatewayAttemptRecord[];
}
```

---

## 4. Resilience: Retries, Backoff, Timeouts, and Fallback

### Retry Policy
- **Retryable Causes**: `TIMEOUT_ERROR`, `RATE_LIMIT_ERROR`, `PROVIDER_UNAVAILABLE` (network connectivity errors, 5xx server errors).
- **Non-Retryable Causes**: `AUTHENTICATION_ERROR` (401/403), `INVALID_RESPONSE` (400 bad request, empty content), `CONFIGURATION_ERROR`, `ABORTED`.
- **Bounded Exponential Backoff**: `delay = Math.min(baseRetryDelayMs * (2 ** (attempt - 1)), maxRetryDelayMs)`. Default base delay: 500ms; max delay: 5,000ms.
- **`Retry-After` Handling**: Inspects provider HTTP response headers (supporting both Web API `Headers.get()` and plain dictionary objects). Clamped at `maxRetryAfterMs` (default: 10,000ms).
- **Injectable Sleep**: `sleepFn` can be injected for deterministic, instantaneous unit test execution.

### Fallback Policy
1. Attempt the configured primary model (`claude-sonnet-5-5`).
2. Retry transient errors up to `maxPrimaryRetries` (default: 2 retries, total 3 primary attempts).
3. On exhaustion of primary retries, if fallback model is distinct, attempt the configured fallback model (`claude-haiku-5-5`) once.
4. On success: record `usedFallback: true` and response model.
5. On fallback failure: throw `ModelGatewayError.retriesExhausted`, preserving the primary error in `error.primaryError` for diagnostics without secret leakage.

### Cancellation
- `AbortSignal` is monitored prior to dispatch, during sleep backoff intervals, and in-flight during provider API calls.
- Cancellation cleans up timers and aborts provider HTTP connections immediately, throwing `ModelGatewayError.aborted()`.

---

## 5. Token Usage & Cost Calculation

Implemented in `DefaultModelPricingRegistry`:
- **Formula**:
  $$\text{cost\_usd} = \left(\frac{\text{input\_tokens}}{1{,}000{,}000} \times \text{input\_rate}\right) + \left(\frac{\text{output\_tokens}}{1{,}000{,}000} \times \text{output\_rate}\right)$$
- **Active Canonical Rates (Verified November 20, 2026)**:
  - `claude-sonnet-5-5`: \$2.00 / MTok input, \$10.00 / MTok output.
  - `claude-haiku-5-5`:
    - Input $\le$ 100K tokens: \$0.10 / MTok input, \$0.50 / MTok output.
    - Input $>$ 100K tokens:  \$0.50 / MTok input, \$2.50 / MTok output.
- **Historical Rates (Audit/Telemetry Accounting Only, Excluded from Active Routing)**:
  - `claude-3-5-sonnet-20241022`: \$3.00 / MTok input, \$15.00 / MTok output.
  - `claude-3-5-haiku-20241022`: \$0.80 / MTok input, \$4.00 / MTok output.
  - `claude-3-opus-20240229`: \$15.00 / MTok input, \$75.00 / MTok output.
  - `claude-3-haiku-20240307`: \$0.25 / MTok input, \$1.25 / MTok output.
- **Microdollar Rounding**: Rounded to 6 decimal places to prevent IEEE 754 precision drift.
- **Fail-Safe Missing Pricing**: If a model is unregistered or if token usage is null, cost returns `null`, never fabricated zero.
- **Multi-Attempt Aggregation**: Collects billed usage across all attempts (including billable failed attempts if reported by provider).

---

## 6. Observability & Telemetry

Integrated with `@fluxora/observability`:

### OpenTelemetry Metrics
| Metric | Type | Dimensions | Description |
|---|---|---|---|
| `fluxora.ai.gateway.requests` | Counter | `provider`, `model`, `task_type`, `prompt_version`, `outcome`, `used_fallback`, `is_mock`, `error_category` | Completed gateway requests |
| `fluxora.ai.gateway.attempts` | Counter | `provider`, `model`, `task_type`, `attempt_number`, `attempt_outcome`, `is_fallback`, `is_mock`, `error_category` | Provider invocation attempts |
| `fluxora.ai.tokens.input` | Counter | `provider`, `model` | Reported input tokens |
| `fluxora.ai.tokens.output` | Counter | `provider`, `model` | Reported output tokens |
| `fluxora.ai.cost.usd` | Histogram | `provider`, `model` | Request cost in USD |
| `fluxora.ai.gateway.latency` | Histogram | `provider`, `model`, `task_type` | End-to-end request duration |
| `fluxora.ai.attempt.latency` | Histogram | `provider`, `model`, `is_fallback` | Single attempt duration |

### Tracer Spans
- `fluxora.ai.gateway.request`: Encompasses the entire lifecycle of a gateway request.
- `fluxora.ai.provider.attempt`: Encompasses an individual provider attempt (marked with success or error status).

### Structured Log Events
- Emitted via OpenTelemetry Logs SDK (`fluxora.ai.gateway.request.completed` and `fluxora.ai.gateway.request.failed`).
- High-cardinality sensitive data (prompts, repository files, customer IDs) is excluded by design.

---

## 7. Security & Secret Safety

1. **Secret Acquisition**: API keys are retrieved from `SecretsClient` (or environment fallback).
2. **Fail-Closed Configuration**: If `USE_REAL_LLM=true` and `ANTHROPIC_API_KEY` is missing or empty, `loadModelGatewayConfig` throws a typed `CONFIGURATION_ERROR`. It never falls back silently to mock mode.
3. **Automated Redaction**: `sanitizeErrorMessage()` strips API key patterns (`sk-ant-...`), authorization bearer tokens, and sensitive headers from error messages and log attributes.
4. **Offline Local Development**: Local development defaults to `USE_REAL_LLM=false`, running entirely offline with `MockModelProvider`.

---

## 8. Verification Results

### AI Module Test Suite
- `src/ai/anthropic-adapter.test.ts`: 7 passed
- `src/ai/gateway.test.ts`: 12 passed
- `src/ai/pricing.test.ts`: 11 passed
- `src/ai/config.test.ts`: 4 passed
- `src/ai/policy.test.ts`: 4 passed
- `src/ai/factory.test.ts`: 3 passed
- **Total AI Tests**: 41 passed (0 failed).

### Comprehensive Workspace Verification
- `pnpm --filter @fluxora/workers test`: 28 test files passed (342 passed, 4 skipped).
- `pnpm test`: 1,195 tests passed (9 skipped) across all workspace packages.
- `pnpm typecheck`: Clean across all 7 workspace packages (0 errors).
- `pnpm lint`: Clean across workspace (0 errors).
- `pnpm lint:evidence`: Clean (5/5 conclusion write paths verified).
- `pnpm build`: Clean (Next.js 16 Turbopack production build succeeded).
- `git diff --check`: Clean (0 whitespace/conflict errors).

---

## 9. Limitations & Next Steps

1. **No Product Integration in Step 59**: As required, this step establishes the AI gateway infrastructure boundary without wiring explanations into UI panels or background workers.
2. **Next Roadmap Step (Step 60 / Phase 9 Step 2)**: Implement the **Context Assembler** for impact-explanation tasks to construct bounded evidence manifests without passing raw file content.
