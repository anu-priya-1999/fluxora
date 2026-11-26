# Fluxora Global Step 63 — End-to-End AI Simulation Narration

## 1. Objective

Implement production-quality AI-powered narration for Fluxora's deterministic failure simulation engine.

This step extends the Phase 9 AI reasoning pipeline:

- Step 59: Model Gateway.
- Step 60: Deterministic context assembly and evidence manifest.
- Step 61: Strict structured-output validation and evidence grounding.
- Step 62: End-to-end impact explanation integration.
- Step 63: AI simulation narration.

The desired flow is:

**Deterministic simulation execution → persisted simulation result → tenant-scoped narration context → Model Gateway → strict structured-output validation → evidence-grounded AIAnalysis persistence → authenticated API → simulation narration UI.**

The AI narration should help users understand the simulation without becoming another source of truth.

A successful simulation must remain successful even when AI narration fails.

## 2. Invariants & Scope Boundaries

1. **Deterministic Simulation Authority**: The deterministic simulation engine is the sole authority for target failures, propagation paths, node counts, hop distances, severity, and resulting states. The LLM only explains verified simulation results provided in context.
2. **AI Optionality & Isolation**: A successfully persisted simulation result must remain available when AI narration fails. Provider errors, rate limits, timeouts, or validation rejections must never fail or repeat deterministic simulation execution.
3. **Strict Evidence Grounding**: Every claim returned by the AI must cite evidence IDs strictly belonging to the allowed simulation evidence manifest (`allowedEvidenceIds`).
4. **Bounded Discovery & Polling**: The frontend poller uses bounded discovery (up to 5 attempts, 2-second interval) to discover asynchronously generated AI narration records without infinite loops or hanging background tasks.
