# Fluxora Global Step 59 — Model Gateway Foundation

## Role

Act as a senior AI infrastructure and full-stack engineer building Fluxora, an AI-powered repository intelligence and failure-simulation platform.

## Objective

Implement a production-quality **Model Gateway** as the single controlled boundary for all outbound LLM requests.

This is the first implementation step of Phase 9 — AI Reasoning.

Implement:

1. A provider-independent Model Gateway contract.
2. Anthropic Claude as the primary provider.
3. A configurable secondary Claude model for fallback and task-aware cost optimization.
4. Bounded retries, exponential backoff, provider timeouts, and cancellation.
5. Token usage, cost, latency, and request outcome instrumentation.
6. A deterministic mock implementation as the default local-development mode.
7. Tests proving retry, fallback, timeout, cost calculation, telemetry, and secret-handling behavior.

The gateway must remain independent of graph extraction, impact analysis, simulation rules, prompt construction, and output validation.

**This step creates the reliable AI infrastructure boundary. It does not yet integrate AI explanations into the product workflow.**

---

## 1. Inspect before coding

Start with:

```powershell
git status --short
git log -5 --oneline
```

Preserve all existing changes. Do not reset, clean, overwrite, or stage unrelated files.

Inspect these architecture documents:

```text
docs/architecture/17-implementation-roadmap.md
docs/architecture/04-system-architecture-diagrams.md
docs/architecture/05-component-responsibilities.md
docs/architecture/06-database-schema.md
docs/architecture/09-ai-architecture.md
docs/architecture/11-security-architecture.md
docs/architecture/12-testing-strategy.md
docs/architecture/14-local-development.md
docs/architecture/16-cost-model.md
docs/DESIGN.md
docs/architecture/18-decision-log.md
```

Inspect the actual repository implementation:

```text
package.json
pnpm-workspace.yaml

apps/workers/package.json
apps/workers/src/index.ts
apps/workers/src/run.ts
apps/workers/src/env.ts
apps/workers/src/handlers.ts

packages/infrastructure/package.json
packages/infrastructure/src/index.ts
packages/infrastructure/src/secrets/

packages/observability/package.json
packages/observability/src/index.ts
packages/observability/src/signals.ts
packages/observability/src/tracer.ts
packages/observability/src/config.ts

packages/shared-types/src/index.ts
packages/db/src/index.ts
packages/db/src/migrate/
.env.example
```

Inspect relevant existing tests and factories before adding anything.

### Existing architectural constraints

The current repository already has:

- Node.js `>=20` and pnpm `10.34.5`.
- A workers application with dependencies on `@fluxora/db`, `@fluxora/infrastructure`, `@fluxora/observability`, and `@fluxora/shared-types`.
- A Secrets abstraction with `SecretsClient`, `EnvSecretsProvider`, `CachedSecretsClient`, and `SecretsManagerProvider`.
- OpenTelemetry instrumentation through `@fluxora/observability`.
- A documented local development convention where `USE_REAL_LLM=true` opts into real model calls and mock behavior is otherwise used.

Verify these against the current checkout; do not assume the repository has not changed.

The current worker package manifest does not list the Anthropic SDK. Inspect the lockfile and existing dependencies. Add the official Anthropic SDK only if the implementation requires it. Keep the dependency change minimal.

Do not introduce a new monorepo package merely to hold a small gateway. Prefer the existing worker-side AI module boundary unless repository evidence justifies another location.

---

## 2. Gateway architecture and contracts

Create a clear internal module boundary, preferably under:

```text
apps/workers/src/ai/
```

Use the existing repository conventions for interfaces, adapters, factories, configuration, errors, and tests.

The gateway should expose a narrow interface conceptually similar to:

```ts
type ModelTaskType =
  | "impact_explanation"
  | "simulation_narration"
  | "chat_query";

interface ModelGateway {
  generate(request: ModelGatewayRequest): Promise<ModelGatewayResponse>;
}
```

The exact types and names should follow existing conventions.

### Request contract

Support:

- Task type.
- Prompt version.
- System instruction.
- Ordered user/assistant messages.
- Maximum output tokens.
- Optional request timeout override within configured safety limits.
- Optional `AbortSignal`.

Do not add prompt templates, evidence assembly, or JSON schema validation here. The gateway receives an already assembled model request.

### Response contract

Return a normalized response containing:

- Generated text.
- Provider identifier.
- Actual model identifier.
- Task type.
- Prompt version.
- Input token count, when reported by the provider.
- Output token count, when reported by the provider.
- Total token count, when reliably available.
- Calculated cost in USD, or `null` when pricing is unknown.
- Total end-to-end latency.
- Attempt count.
- Whether fallback was used.
- Provider request ID, when available.
- Provider stop reason, when available.
- An explicit indicator when the result came from mock mode.

Do not invent usage, pricing, or provider metadata.

Keep provider-specific SDK types inside the provider adapter. Do not leak Anthropic SDK response types through the gateway's public interface.

---

## 3. Anthropic provider adapter

Implement Claude through the official Anthropic TypeScript SDK.

Requirements:

- Use the official SDK, not handwritten HTTP requests.
- Initialize the client through dependency injection or an existing production factory.
- Obtain the API key through the existing secrets abstraction.
- Never log or expose the key.
- Never commit real credentials.
- Keep model identifiers configurable rather than scattering model names through application code.
- Normalize provider output into the gateway response contract.
- Extract usage only from actual provider usage fields.
- Handle empty, malformed, or unexpected provider responses safely.
- Preserve provider request IDs for diagnostics when available.

Use configuration for:

```text
ANTHROPIC_API_KEY
ANTHROPIC_PRIMARY_MODEL
ANTHROPIC_FALLBACK_MODEL
USE_REAL_LLM
```

The precise configuration interface should match the repository's existing environment and secrets conventions.

Real mode must fail with an explicit, sanitized configuration error when required configuration is missing.

Do not silently use a mock response when the developer explicitly enabled real mode but supplied invalid configuration.

---

## 4. Task-aware model selection and fallback

Implement an explicit, testable model-selection policy.

Support:

- Primary model selection.
- Secondary/fallback model selection.
- Task-specific model tier selection.
- Configurable per-task timeouts.
- A deterministic policy when task-specific configuration is missing.

Use the architectural guidance:

| Task | Timeout guidance |
|---|---:|
| Impact explanation | 20 seconds |
| Simulation narration | Configurable, with a sensible bounded default |
| Free-form chat query | 45 seconds |

The task policy must be configurable and unit-testable. Do not scatter model-selection conditions throughout the gateway.

The fallback model is a configured secondary model, not an excuse to add an unrelated provider or another routing platform.

Use the same Anthropic provider adapter for the primary and fallback Claude models unless the existing architecture provides a concrete reason otherwise.

A request must report which model actually produced its response.

---

## 5. Retry, timeout, and failure behavior

Implement bounded provider resilience.

### Retry policy

- Retry transient network errors.
- Retry provider timeouts.
- Retry rate-limit responses with bounded handling of `Retry-After` when available.
- Retry eligible server-side 5xx failures.
- Do not retry authentication failures, invalid requests, or other non-retryable client errors.
- Use bounded exponential backoff.
- Keep attempt counts and total retry time bounded.
- Make sleep/backoff injectable so tests remain deterministic and fast.

### Fallback policy

1. Attempt the configured primary model.
2. Retry eligible transient failures within the configured limit.
3. On exhaustion of eligible primary attempts, try the configured fallback model once, subject to its own timeout.
4. Return the normalized successful response and record that fallback was used.
5. If fallback also fails, return a typed gateway error.

Do not retry indefinitely.

Do not invoke fallback after caller cancellation.

Do not hide the original primary failure. Preserve safe diagnostic information in the final error without exposing secrets or raw provider payloads.

### Cancellation

- Respect caller-provided `AbortSignal`.
- Apply a separate bounded timeout to each provider attempt.
- Stop all further attempts when the caller aborts.
- Avoid leaving retry timers or provider requests running after cancellation.

### Error contract

Use typed gateway errors or the repository's established error pattern.

Distinguish at minimum:

- Configuration error.
- Authentication/authorization error.
- Timeout.
- Rate limited.
- Provider unavailable.
- Invalid provider response.
- Caller aborted.
- Exhausted retries and fallback.

Errors must be useful to developers but safe for logs and user-facing handling.

Do not implement the later deterministic explanation fallback in this step. The gateway reports failure; the later orchestration layer decides how to display a deterministic explanation.

---

## 6. Token usage and cost calculation

Cost must be based on actual provider-reported usage and configured pricing.

Implement an injectable pricing registry keyed by model identifier.

Support separate rates for:

- Input tokens per million.
- Output tokens per million.

Use the formula:

```text
cost_usd =
  (input_tokens / 1_000_000 * input_rate_usd_per_million)
  +
  (output_tokens / 1_000_000 * output_rate_usd_per_million)
```

Requirements:

- Do not hardcode model prices in gateway business logic.
- Do not assume different model identifiers share the same pricing.
- Do not report zero cost merely because pricing is missing.
- Return `costUsd: null` when usage or price information is insufficient.
- Do not fabricate token counts for mock requests.
- Account for the cost of all billed attempts, including failed primary attempts when the provider reports billable usage.
- Distinguish attempt-level telemetry from aggregate request-level usage.
- Add tests for rounding, missing pricing, and primary-plus-fallback cost aggregation.

The architecture documents `AIAnalysis` as the durable audit record. Inspect the current database migrations and repositories before deciding how to handle persistence.

Do not couple the gateway directly to PostgreSQL or invent subject IDs. If the existing AIAnalysis persistence path is not yet implemented, return complete normalized usage metadata and emit gateway telemetry so the later orchestration step can persist the completed AIAnalysis against its actual subject and evidence. Document this boundary clearly.

Do not add an unrelated migration just to make the gateway appear integrated.

---

## 7. Observability and secret safety

Use the existing `@fluxora/observability` package.

Add dedicated AI telemetry rather than reusing or renaming dummy telemetry.

Record useful, low-cardinality dimensions:

- Provider.
- Actual model.
- Task type.
- Prompt version.
- Attempt outcome.
- Fallback usage.
- Error category.
- Input/output token counts where available.
- Cost where calculable.
- End-to-end latency.
- Per-attempt latency where useful.

Use appropriate OpenTelemetry instruments and structured logs following existing conventions.

Consider a span around each gateway request and/or provider attempt.

### Strict logging rules

Never log:

- API keys.
- Authorization headers.
- Full prompts.
- Full message content.
- Raw repository source code.
- Unredacted provider request or response bodies.
- Sensitive customer information.

Do not add organization IDs, repository IDs, or subject IDs as unbounded metric labels.

Sanitize provider errors before recording them.

Telemetry must still record useful operational information when a request fails before returning a model completion.

Mock requests must be clearly distinguishable from real provider calls. Their usage and cost must not be fabricated.

---

## 8. Default mock mode and local development

The gateway must work locally and in automated tests without an Anthropic account, API key, or external network access.

Default behavior:

```text
USE_REAL_LLM=false
```

Provide a deterministic mock implementation that:

- Produces stable canned responses.
- Does not make network calls.
- Does not require secrets.
- Does not fabricate real provider usage or cost.
- Identifies its responses as mock output.
- Supports deterministic tests for successful requests and controlled failures.

When:

```text
USE_REAL_LLM=true
```

use the configured real Anthropic provider and validate required settings.

Update `.env.example` with non-secret placeholders and clear comments. Never populate actual credentials.

Keep real provider smoke tests opt-in and excluded from the ordinary test suite. Default CI must not make paid model calls.

---

## 9. Testing requirements

Follow existing Vitest conventions and test the gateway without external network access.

Include tests for:

1. Mock mode returns deterministic output.
2. Real mode validates missing API key and model configuration.
3. Anthropic adapter maps provider text and usage correctly using a fake SDK/client boundary.
4. Primary success does not invoke fallback.
5. Retryable primary failure is retried within the configured limit.
6. Primary exhaustion invokes fallback.
7. Fallback success is marked accurately.
8. Fallback failure returns a typed error.
9. Non-retryable authentication/invalid-request errors are not retried.
10. Rate-limit and Retry-After handling are bounded.
11. Timeout aborts an attempt and respects task-specific budgets.
12. Caller cancellation prevents further retries and fallback.
13. Pricing calculation is correct.
14. Missing usage or pricing produces unknown cost, not fabricated zero cost.
15. Aggregate cost includes billable failed attempts when usage is returned.
16. Telemetry captures safe metadata for success and failure.
17. Prompts, message contents, API keys, and provider payloads do not leak into logs.
18. Model selection follows the configured task policy.
19. A real network request is never made by default unit tests.

Use fake provider adapters, injected clocks/sleep functions, and deterministic test configuration.

Do not depend on a live Anthropic account to pass the standard test suite.

---

## 10. Strict non-goals

Do not implement these later Phase 9 steps:

- Context Assembler.
- Evidence-ID manifest construction.
- Prompt template library or prompt version promotion system.
- Structured-output schema definitions.
- Structured-output Validator.
- Evidence grounding validation.
- Impact-analysis completion integration.
- Simulation narration integration.
- AIExplanationPanel changes.
- Free-form tool-calling chat.
- AI evaluation suite.
- Deterministic template explanation fallback.

Do not:

- Modify graph extraction.
- Modify impact-analysis semantics.
- Modify simulation rules or engine.
- Add repository source-code execution.
- Give the model unrestricted repository or database tools.
- Add destructive or state-changing model tools.
- Add a second AI framework or agent orchestration platform.
- Add another provider unless existing architecture requires it and the decision is documented.
- Perform unrelated refactoring.

The deterministic core remains authoritative. The LLM must never become the source of graph, impact, simulation, authorization, or evidence facts.

---

## 11. Documentation deliverables

Use actual implementation and test results.

### A. Archived prompt

Create:

```text
prompts/cursor or gemini/phase-09/phase-09-step-59.md
```

Save this complete implementation prompt using the repository's existing conventions.

### B. Implementation report

Create:

```text
learning/implementations/phase-09/step-59-model-gateway.md
```

Include architecture, provider boundary, request/response contracts, retry/fallback behavior, security, configuration, pricing, telemetry, tests, and limitations.

### C. Learning note

Create:

```text
learning/notes/58. Model Gateway Foundation.md
```

Explain provider abstraction, retries, fallback routing, timeouts, cancellation, cost accounting, observability, secret safety, mock-first development, and the difference between model fallback and deterministic product fallback.

### D. Interview guide

Create:

```text
learning/interviews/59. Step 59 Model Gateway Interview CheatSheet.md
```

Cover senior/staff-level questions on AI gateway architecture, provider abstractions, retries, rate limits, cost accounting, telemetry, secrets, task-aware routing, and graceful failure.

### E. Architecture documentation

Update only where supported by the implementation:

```text
docs/DESIGN.md
docs/architecture/09-ai-architecture.md
docs/architecture/05-component-responsibilities.md
docs/architecture/18-decision-log.md
learning/README.md
docs/architecture/17-implementation-roadmap.md
```

Keep architectural design decisions separate from implementation details.

Create an ADR-013 only if this step makes a material architectural decision not already established by the existing architecture. Do not create an ADR just to increment the number.

Mark Phase 9 Step 1 / Global Step 59 complete in the roadmap only when the implementation and acceptance criteria are genuinely satisfied.

---

## 12. Verification

Inspect actual scripts before running commands.

Run focused worker tests and any observability tests supported by the package scripts.

Then run:

```powershell
pnpm --filter @fluxora/workers typecheck
pnpm typecheck
pnpm lint
pnpm lint:evidence
pnpm test
pnpm build
git diff --check
```

If a package does not expose a test script, state that clearly rather than inventing a command.

Record exact test counts, skipped tests, exit codes, and commands actually executed.

Do not claim real Anthropic integration was exercised unless a real opt-in request was made successfully. Do not claim a paid-provider smoke test passed when only a fake provider was used.

---

## 13. Git and change management

- Preserve all existing working-tree changes.
- Do not stage unrelated files.
- Do not commit or push.
- Do not reset or clean the working tree.
- Inspect the complete final diff.
- Keep new dependencies and lockfile changes limited to what is required.
- Ensure the prompt archive accurately reflects the task.

---

## 14. Final implementation report

Return:

1. Gateway architecture and module boundaries.
2. Anthropic adapter and SDK dependency changes.
3. Request/response contracts.
4. Primary/fallback model-selection policy.
5. Retry, timeout, cancellation, and error semantics.
6. Token usage and cost calculation.
7. Observability metrics and logs.
8. Secret-management and redaction verification.
9. Mock-mode behavior.
10. Test coverage and exact results.
11. All files created and modified.
12. Documentation and ADR changes.
13. Exact verification commands and exit codes.
14. Remaining limitations and next-step dependencies.
15. Suggested commit message, without committing.

Use one verdict:

- `MODEL GATEWAY PASSED`
- `MODEL GATEWAY INCOMPLETE`
- `BLOCKED BY ENVIRONMENT`

**Begin with repository inspection. Build the smallest reliable gateway that keeps Claude calls isolated, observable, cost-aware, testable, and completely separate from Fluxora's deterministic reasoning core.**