# ADR-013: Single Controlled Model Gateway Boundary with Secondary Model Fallback

## Status
Accepted

## Context
In Fluxora Global Step 59 (Phase 9 Step 1), the objective is to establish the foundational Model Gateway for all outbound Large Language Model (LLM) requests.

Fluxora's core product principle (P1) mandates a strict boundary between the deterministic intelligence core and the probabilistic AI edge:
- Dependency graph extraction, blast-radius calculation, failure scenario simulation, authorization (RBAC/RLS), and evidence provenance collection must **never** depend on an LLM.
- The LLM layer is strictly responsible for explaining and narrating deterministically computed facts over verified evidence citations.

To operationalize this principle, all model interactions must be governed by an observable, resilient, cost-aware, and secure architectural boundary. Key requirements and structural questions include:
1. **Provider Isolation**: How to prevent vendor lock-in and avoid leaking third-party SDK types (such as Anthropic Messages API types) into calling worker jobs or core domain logic.
2. **Offline & CI Predictability**: How to ensure that local development, automated test suites, and CI pipelines run 100% offline, deterministically, and without requiring live API keys or incurring financial costs.
3. **Resilience & Fallback**: How to handle transient provider outages, rate limits (429), and timeouts gracefully without cascading delays, and when to route to an alternate model tier.
4. **Separation of Concerns**: Ensuring the gateway strictly owns transport, retry, fallback, token accounting, and secret safety, while explicitly **not** owning prompt templating, context assembly, grounding validation, or deterministic non-AI product fallbacks.

## Alternatives Considered

1. **Calling Provider SDKs Directly Across Job Handlers**:
   - *Proposal*: Import `@anthropic-ai/sdk` directly within background job processors or API route handlers whenever an AI explanation is needed.
   - *Why rejected*: Severely fragments retry policies, exponential backoff, and error mapping across the codebase. It scatters token cost calculations, increases the risk of credential leakage in logs, prevents centralized OpenTelemetry metrics emission, and tightly couples worker jobs to a specific vendor's SDK API.

2. **Introducing an External Proxy Service or Third-Party Agent Framework (e.g., LiteLLM, LangChain)**:
   - *Proposal*: Deploy an external gateway container (e.g., LiteLLM proxy) or introduce heavy agent frameworks to handle routing and retries.
   - *Why rejected*: Introducing an external proxy service adds unnecessary operational dependencies, network hops, container management overhead, and potential points of failure. Third-party agent frameworks introduce bloated abstractions, unpredictable prompt wrappers, and non-deterministic behaviors that conflict with Fluxora's lean, high-assurance architecture.

3. **Silently Falling Back to Mock Mode When API Keys Are Missing in Real Mode**:
   - *Proposal*: If `USE_REAL_LLM=true` is set but `ANTHROPIC_API_KEY` is missing or invalid, fall back silently to the mock provider.
   - *Why rejected*: Silent fallback masks critical configuration errors in staging or production environments, leading operators to believe the system is generating genuine AI analyses when it is actually serving static mock data. Configuration errors in real mode must fail closed immediately with sanitized errors.

4. **Single Controlled In-Process Gateway Boundary with Secondary Model Fallback (Chosen)**:
   - *Proposal*: Centralize all model requests behind a provider-independent `ModelGateway` interface within `@fluxora/workers/src/ai/`. Isolate provider SDKs inside dedicated adapters, default to an offline mock provider for local development, enforce bounded task-aware routing and secondary model fallback, calculate microdollar token costs via an injectable pricing registry, and fail closed on misconfiguration.

## Decision
We choose Alternative 4:

1. **Single Controlled Gateway Contract**:
   - All outbound model traffic must pass through `ModelGateway.generate(request: ModelGatewayRequest): Promise<ModelGatewayResponse>`.
   - The contract uses normalized, provider-independent data structures (`role`, `content`, `systemInstruction`, `taskType`, `promptVersion`).

2. **Strict Provider SDK Isolation**:
   - Vendor SDKs (`@anthropic-ai/sdk`) are encapsulated strictly within `AnthropicProviderAdapter`.
   - Provider SDK types (`Anthropic.Message`, `Anthropic.APIError`, etc.) are never exported from the AI module or referenced by calling jobs.
   - Provider-specific errors are mapped deterministically to typed `ModelGatewayError` categories (`TIMEOUT_ERROR`, `RATE_LIMIT_ERROR`, `PROVIDER_UNAVAILABLE`, `AUTHENTICATION_ERROR`, `INVALID_RESPONSE`, `ABORTED`, `CONFIGURATION_ERROR`, `RETRIES_EXHAUSTED`).

3. **Offline Mock Mode as Default with Fail-Closed Real Mode**:
   - By default (`USE_REAL_LLM=false` or unset), the gateway instantiates `MockModelProvider`, returning deterministic canned responses without external network access or credentials.
   - When explicitly opted-in (`USE_REAL_LLM=true`), the gateway resolves credentials via `SecretsClient` / environment and fails closed with `CONFIGURATION_ERROR` if the API key is missing.

4. **Bounded, Task-Aware Primary and Secondary Model Routing**:
   - Routing policies are keyed by `ModelTaskType` (`impact_explanation`, `simulation_narration`, `chat_query`), enforcing task-specific timeout budgets (e.g. 20s, 30s, 45s) and token limits.
   - Active default models are configured to current active Claude models:
     - Primary: `claude-sonnet-5-5` (standard list rate: $2.00 / MTok input, $10.00 / MTok output).
     - Fallback: `claude-haiku-5-5` (standard list rate: $0.10 / MTok input $\le$ 100K tokens, $0.50 / MTok input $>$ 100K tokens; $0.50 / MTok output $\le$ 100K tokens, $2.50 / MTok output $>$ 100K tokens; verified November 20, 2026).
   - Transient failures (429, 5xx, timeouts) on the primary model are retried up to `maxPrimaryRetries` (default: 2 retries) with bounded exponential backoff and `Retry-After` header parsing.
   - If primary retries are exhausted, the gateway attempts the secondary fallback model **exactly once**.
   - Fatal client errors (401/403, 400) and caller aborts fail immediately without retry or fallback.

5. **Decoupling from Upstream and Downstream Reasoning Responsibilities**:
   - The gateway does **not** assemble context or inspect repository files (owned by the Context Assembler in Step 60).
   - The gateway does **not** validate structured schemas or verify evidence citation grounding (owned by Output Validation in Step 61).
   - The gateway does **not** generate deterministic template-based non-AI explanations (owned by Orchestration in Step 66 / ADR-010). If the gateway fails, it surfaces a typed error so the orchestration layer can trigger deterministic explanation fallback.

6. **Microdollar Cost Accounting & Secret Redaction**:
   - `DefaultModelPricingRegistry` tracks token usage and calculates exact USD costs rounded to 6 decimal places (microdollars), preserving `costUsd: null` if usage or pricing is unavailable.
   - Automated regex redaction cleanses API keys (`sk-ant-...`) and Bearer tokens from all errors, exceptions, and telemetry attributes. Prompts and source code are strictly forbidden from log attributes.

## Consequences

### Positive
- **Deterministic Core Integrity**: Strictly maintains the separation of concerns mandated by Principle P1 and P10.
- **Provider Agility**: Swapping model providers or introducing multi-provider adapters in future phases requires zero modifications to calling worker jobs.
- **Security & Hygiene**: Centralized secret redaction eliminates credential leaks in logs; fail-closed configuration prevents accidental mock usage in production.
- **Cost Observability**: Granular tracking of input/output tokens and microdollar costs across all attempts feeds directly into OpenTelemetry metrics and future billing rollups.
- **Zero-Dependency Testing**: Injected sleep functions and mock providers allow comprehensive unit and integration testing without network calls or third-party rate limits.

### Negative / Limitations
- **No Direct Explanations in Step 59**: The Model Gateway is purely an infrastructure foundation. End-to-end user-facing explanations require the subsequent completion of Context Assembly (Step 60), Output Validation (Step 61), and AI Explanation Generation (Step 62).
