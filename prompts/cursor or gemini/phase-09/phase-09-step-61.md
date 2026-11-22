# Fluxora Global Step 61 — Structured Output Schemas & Evidence Grounding Validator

## Role

Act as a senior AI infrastructure and TypeScript engineer working on Fluxora, an AI-powered repository intelligence and failure-simulation platform.

Implement Global Step 61 as a production-quality extension of the existing Step 59 Model Gateway and Step 60 Impact Explanation Context Assembler.

Preserve the established architecture, provider independence, deterministic authority, evidence provenance, tenant isolation, and failure-handling boundaries.

## Objective

Implement strict structured-output schemas and a runtime validator for the `impact_explanation` task type.

The validator must:

1. Parse raw model output as strict JSON.
2. Validate the parsed value against a versioned, task-specific output schema.
3. Verify all claim evidence IDs against the exact trusted evidence-ID manifest supplied by Step 60.
4. Reject malformed, unsupported, or ungrounded output.
5. Support one bounded corrective retry using a deterministic validation error message.
6. Return a strongly typed validated result or an explicit validation failure.

The validator must distinguish citation provenance from semantic correctness. Evidence-manifest membership does not prove that cited evidence semantically supports a natural-language claim.

**This step implements the structured-output and validation boundary. It does not integrate AI generation into the product workflow.**
