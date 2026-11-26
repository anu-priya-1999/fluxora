# ADR-016: Deterministic Simulation Narration Context Assembly, Strict Evidence Grounding, and Asynchronous Production Job Wiring

**Status:** Accepted
**Date:** 2026-11-24
**Deciders:** Core Engineering Team
**Consulted:** Architecture Review
**Informed:** Phase 9 (AI Reasoning)

---

## 1. Context & Problem Statement

In **Global Step 63**, Fluxora extends its AI reasoning pipeline to failure simulation:
$$\text{Deterministic failure simulation} \longrightarrow \text{State evidence persistence} \longrightarrow \text{Tenant context assembly} \longrightarrow \text{Model Gateway} \longrightarrow \text{Validation} \longrightarrow \text{Durable AIAnalysis} \longrightarrow \text{API} \longrightarrow \text{SimulationStudio UI}$$

Four key architectural requirements and tensions arose during implementation and audit:
1. **Production Trigger & Process Boundaries**: Deterministic failure simulation executes synchronously during `POST /api/v1/scenarios/:id/run` to return immediate deterministic results. The API server process must trigger AI narration without running slow LLM network requests in the HTTP lifecycle and without violating package isolation boundaries (the API package must not import worker-internal modules).
2. **Failure Simulation Safety & Truth Authority**: Unlike PR impact analysis (which analyzes historical code changes), failure simulations evaluate hypothetical fault injections. The LLM must never hallucinate unsimulated cascades or present synthetic scenarios as observed production incidents.
3. **Evidence Provenance & Manifest Synchronization**: Deterministic simulations generate `simulation_state` evidence linked to exact simulation runs via `metadata->>'simulationId' = simulationId`. The context assembler must load only evidence from the authorized simulation and strictly synchronize the trusted `allowedEvidenceIds` manifest with retained evidence after multi-key sorting and character budgeting.
4. **Failure Isolation & Idempotency**: Model downtime, rate limits, schema rejection, or persistence failure must never invalidate or fail the completed deterministic simulation. Repeated requests or worker deliveries must be idempotent and avoid duplicate LLM calls.

---

## 2. Decision

1. **Asynchronous Durable Queue Integration Boundary (`simulation.narration`)**:
   - Deterministic simulation execution (`executeSimulation`) completes and persists `SimulationResult` and `Evidence` rows atomically in PostgreSQL before narration is triggered.
   - Downstream of successful persistence, the API handler (`handleRunScenario`) enqueues a background job into PostgreSQL's `jobs` table using `SIMULATION_NARRATION_JOB_TYPE = 'simulation.narration'`.
   - The job is enqueued with tenant scope and stable idempotency key `simulation.narration:${simulation.id}` with `ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET id = jobs.id`.
   - The enqueue call is wrapped in a fail-safe `try/catch` block so that any queue failure never fails or rolls back the deterministic simulation response.
   - The API package `@fluxora/api` imports only from `@fluxora/db` and `@fluxora/shared-types`, strictly avoiding direct dependencies on `@fluxora/workers`.

2. **Dedicated Worker Job Handler (`simulationNarrationJobHandler`)**:
   - The worker harness registers `[SIMULATION_NARRATION_JOB_TYPE]` in `createDefaultJobHandlers()`.
   - The handler parses the payload (`parseSimulationNarrationJobPayload`), starts OpenTelemetry tracing span `fluxora.worker.simulation_narration.process`, and delegates to `orchestrateSimulationNarration`.
   - Any AI generation failure or validation rejection is recorded durably in `ai_analyses` without re-throwing, allowing the worker job to complete cleanly without endless retry loops.

3. **Deterministic Simulation Evidence Provenance (`listSimulationEvidence`)**:
   - The simulation engine uses `EvidenceWriter.createSimulationStateEvidence` to record provenance with `subject_type = 'simulation_state'` and `metadata->>'simulationId' = simulationId`.
   - Context loading via `listSimulationEvidence` queries this exact association within a tenant RLS transaction, verifying scenario ownership before retrieval.
   - Cross-simulation and cross-tenant evidence leakage is strictly prohibited.

4. **Pure Multi-Key Context Assembly & Strict Manifest Synchronization**:
   - `assembleSimulationNarrationContext` deterministically sorts results by: (1) higher confidence, (2) higher state severity (`failed` > `degraded` > `at_risk` > `healthy`), (3) lower hop distance, and (4) stable nodeId.
   - `allowedEvidenceIds` is strictly derived from retained evidence records after truncation and character budgeting: $\text{allowedEvidenceIds} \equiv \text{retainedEvidenceRecords.map}(e \to e.\text{id}).\text{sort}()$.
   - When no evidence is present, an empty manifest is represented consistently as a frozen empty array `[]`.

5. **Prompt Guardrails (`simulation-narrate-v1`) & Structured Validation (`simulation-narration-output-v1`)**:
   - Prompts mandate clear distinction between synthetic failure scenarios and real production observations.
   - Validator enforces atomic whole-response rejection (ADR-014): ungrounded citations trigger at most one corrective retry before marking the analysis as `rejected` with `null` output columns.

6. **Decoupled API Delivery & Bounded Frontend Discovery Polling**:
   - `GET /api/v1/simulations/:id` exposes `ai_analysis_id` and `ai_analysis_status` for correlation without heavy payload inlining.
   - `AISimulationNarrationPanel` implements bounded discovery polling (up to 5 attempts at 2000ms intervals = 10s budget) with manual user recovery ("Check again").

---

## 3. Alternatives Considered

### Alternative A: Synchronous LLM generation in the HTTP handler
- **Description:** Call `orchestrateSimulationNarration` directly inside `POST /api/v1/scenarios/:id/run` and wait for the model before returning the HTTP response.
- **Why rejected:** Violates Core Principles P1 (Deterministic Core) and P10 (Fail-Safe AI). Stalls HTTP connections for 5–20 seconds. An LLM timeout or 429 rate limit would either delay the user or risk failing the entire HTTP request. Furthermore, importing worker modules into the API violates monorepo package boundaries.

### Alternative B: Direct import of worker modules into `@fluxora/api`
- **Description:** Add `@fluxora/workers` as a dependency of `@fluxora/api` and invoke the orchestrator in-process via an un-awaited Promise.
- **Why rejected:** Violates architectural layering. Workers contain heavy dependencies (tree-sitter, anthropic SDK, tar, file parsers) that do not belong in the API server. In-process un-awaited Promises lack durability across process restarts or container deployments.

### Alternative C: Reusing PR impact explanation prompt and validator without differentiation
- **Description:** Reuse `impact-explain-v1` and `impact-explanation-output-v1` directly for simulation narration.
- **Why rejected:** Failure simulations model synthetic, hypothetical cascades rather than verified git diff changes. Failing to instruct the model on this distinction creates severe risk of confusing simulated fault injections with real-world incidents. Furthermore, simulation evidence uses `simulation_state` subjects rather than `impact_finding` rows.

### Alternative D: Failing deterministic simulation when AI narration fails
- **Description:** Mark the simulation status as `failed` if narration generation fails or validation rejects.
- **Why rejected:** Violates the fundamental Fluxora invariant: deterministic truth is authoritative. A simulation engine run that successfully computed graph rule cascades and persisted state changes is 100% valid regardless of whether an LLM can narrate it.

---

## 4. Consequences & Invariants

### Positive
- **Architectural Purity:** API and worker responsibilities remain decoupled; communication occurs exclusively through PostgreSQL durable jobs with tenant RLS.
- **Reliable Provenance:** Every claim is grounded in verified `simulation_state` evidence linked to the exact simulation run.
- **Resilient Delivery:** Simulation results are returned to clients immediately; AI narrations arrive asynchronously and are discovered via bounded polling without race conditions.
- **Idempotency:** Redelivery of simulation completion events reuses existing completed records without incurring duplicate model costs.

### Negative / Trade-offs
- An additional database table interaction (`jobs`) is required to hand off narration generation from API to worker.
- The frontend must perform bounded discovery polling (up to 5 attempts) to retrieve the narration after simulation execution completes.
