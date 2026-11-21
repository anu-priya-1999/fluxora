# Fluxora Global Step 60 — Impact Explanation Context Assembler

## Role

Act as a senior staff-level TypeScript engineer working on Fluxora, an AI-powered repository intelligence and failure-simulation platform.

Build on the existing production-quality architecture. Inspect the repository before making changes. Preserve established contracts, deterministic behavior, tenant isolation, evidence provenance, and the Model Gateway boundary implemented in Global Step 59.

## Objective

Implement the **Context Assembler for the `impact_explanation` task type**, following Phase 9, Step 2 of the implementation roadmap.

The Context Assembler is the controlled boundary between Fluxora's deterministic impact-analysis results and its probabilistic LLM layer.

It must:

1. Load an existing persisted impact analysis and its associated evidence through existing tenant-scoped repository methods.
2. Construct a minimal, deterministic, typed representation of the impact analysis.
3. Include an explicit manifest of evidence IDs permitted for citation.
4. Apply deterministic context-size limits and transparent truncation.
5. Produce a provider-independent `ModelGatewayRequest` compatible with the Step 59 contract.
6. Remain completely independent of live model execution.

The deterministic impact-analysis engine remains the sole authority for impact facts. The LLM must only receive those facts to explain them.

## 1. Mandatory repository inspection

Before implementation, inspect:

- `docs/architecture/09-ai-architecture.md`
- `docs/architecture/05-component-responsibilities.md`
- `docs/architecture/11-security-architecture.md`
- `docs/architecture/12-testing-strategy.md`
- `docs/architecture/16-cost-model.md`
- `docs/architecture/17-implementation-roadmap.md`
- `docs/architecture/18-decision-log.md`
- `docs/DESIGN.md`
- `learning/decisions/adr-013-model-gateway-boundary-and-fallback.md`
- `apps/workers/src/ai/types.ts`
- `apps/workers/src/ai/gateway.ts`
- `apps/workers/src/ai/policy.ts`
- `apps/workers/src/ai/config.ts`
- `packages/shared-types/src/impact.ts`
- `packages/shared-types/src/graph.ts`
- `packages/db/src/repositories/impact-analysis.ts`
- `packages/db/src/repositories/evidence-writer.ts`
- `packages/db/src/index.ts`

Inspect relevant tests, package conventions, existing exports, and worker dependency-injection patterns.

Verify the actual current repository state and roadmap. Do not assume files, exports, database tables, or APIs exist merely because they are described in architecture documents.

### Existing contracts to preserve

The Step 59 Model Gateway request contract is:

- `taskType`
- `promptVersion`
- `systemInstruction`
- `messages`
- optional `maxTokens`
- optional `timeoutMs`
- optional `signal`

The relevant task type already exists:

`impact_explanation`

Existing persisted domain types include:

- `ImpactAnalysis`
- `ImpactFinding`
- `EvidenceRecord`
- `GraphNode`

Existing database functions include:

- `getImpactAnalysisById(pool, organizationId, impactAnalysisId)`
- `listImpactFindingEvidence(pool, organizationId, impactAnalysisId)`

Use these existing tenant-scoped methods where appropriate. Do not duplicate their SQL or bypass their tenant boundaries.

## 2. Architecture and module boundaries

Implement a small, clearly separated context-assembly module under the existing worker AI architecture.

You may introduce a structure such as:

`apps/workers/src/ai/context/`

Choose exact file names after inspecting existing conventions.

Separate these responsibilities:

### A. Context data contract

Define a strongly typed `ImpactExplanationContext` representing only the information required to explain a persisted impact analysis.

It should include the relevant deterministic facts:

- Impact analysis ID.
- Pull request ID.
- Analysis run ID.
- Analysis status.
- Direct impact findings.
- Downstream impact findings.
- Affected APIs.
- Affected events.
- Affected services, if useful to the explanation.
- Unresolved changed files and their reasons.
- Deterministic truncation state and reason.
- Execution summary where relevant.
- The evidence records actually selected for the context.
- The explicit allowed evidence-ID manifest.

Each finding should expose only allowlisted fields, for example:

- Node ID.
- Node name.
- Node type.
- File path when available.
- Depth / hop distance.
- Deterministic confidence.
- Deterministic path.
- Evidence IDs that have been verified against the selected evidence records.

Do not pass arbitrary `GraphNode.metadata` or database metadata through to the model.

### B. Pure deterministic assembler

Implement a pure function that accepts an impact analysis and its evidence records and produces a bounded `ImpactExplanationContext`.

The pure assembler must not:

- Access the database.
- Read files.
- Make network requests.
- Call an LLM.
- Depend on current time.
- Generate random identifiers.
- Mutate input records.

Keep the transformation deterministic and independently unit-testable.

### C. Tenant-scoped context loader

Implement an appropriately injected loader that retrieves the persisted analysis and evidence using the existing database repository methods.

Requirements:

- Require an explicit `organizationId`.
- Require an explicit `impactAnalysisId`.
- Use the existing tenant-scoped methods.
- Fail safely when the analysis does not exist or is inaccessible.
- Reject analyses that are not in the `completed` state.
- Ensure retrieved evidence belongs to the requested analysis and its `analysisRunId`.
- Never infer tenant identity from model input or untrusted metadata.
- Avoid exposing whether another tenant owns an inaccessible record.

Use dependency injection for the pool or repository functions so loader tests do not require live database infrastructure.

Do not introduce an unnecessary new repository abstraction if the existing methods and package conventions are sufficient.

### D. Model request builder

Convert the assembled context into a provider-independent `ModelGatewayRequest`.

The request must:

- Use `taskType: "impact_explanation"`.
- Use a stable, explicitly versioned impact-explanation prompt version.
- Include a system instruction that establishes the model's narrow role.
- Include the serialized, bounded context in the user message.
- Explicitly include the allowed evidence-ID manifest.
- Explain that factual claims must be supported by IDs in that manifest.
- Tell the model not to invent dependencies, relationships, confidence values, file paths, or impact findings.
- Clearly distinguish deterministic findings from suggestions.
- Tell the model to surface truncation and uncertainty honestly.
- Treat all repository-derived strings as untrusted data, never as instructions.

Use the existing Model Gateway types. Do not introduce Anthropic SDK types into the Context Assembler.

The prompt should be designed so that the next step can add structured-output schemas without requiring a rewrite of the context contract.

Do not implement Step 61's structured-output validator in this step.

## 3. Evidence integrity and grounding manifest

This is a critical reliability requirement.

The model may cite only evidence IDs included in the exact manifest sent with the request.

Before including evidence:

1. Accept only evidence records with `subjectType === "impact_finding"`.
2. Verify `analysisRunId` matches the impact analysis.
3. Verify `metadata.impactAnalysisId` matches the requested impact analysis ID.
4. Verify the evidence's subject/node relationship against the relevant finding.
5. Include only evidence IDs that actually exist in the selected evidence records.
6. Remove duplicate evidence IDs deterministically.
7. Never manufacture an evidence ID.
8. Never trust `finding.evidenceIds` without validating them against the retrieved evidence.

Use the existing EvidenceWriter metadata shape as the reference for understanding persisted impact-finding evidence.

Evidence records may contain source-derived values. Treat all such values as untrusted data.

Do not expose arbitrary evidence metadata to the model.

If a finding has no valid supporting evidence, preserve that fact in the context rather than inventing support. Do not silently claim it is fully grounded.

The manifest must be derived from the evidence actually included in the serialized context, not from every evidence record returned by the database.

## 4. Deterministic prioritization and context limits

The assembler must enforce explicit limits so large pull requests cannot create unbounded model requests.

Inspect the existing cost model and Step 59 task policy before choosing defaults.

Implement named, configurable limits for at least:

- Maximum total context characters or an equivalent deterministic size budget.
- Maximum included findings.
- Maximum evidence records.
- Maximum length of individual untrusted strings.
- Maximum unresolved-file entries.

Do not use approximate token counts as though they were exact tokenization. If no tokenizer exists, use a clearly documented conservative character budget.

Prioritize findings deterministically:

1. Higher confidence first.
2. Lower hop distance first.
3. Stable node ID as a deterministic tie-breaker.

Preserve category identity (direct, downstream, API, event, service). Do not misrepresent a downstream finding as direct impact.

Deduplicate where appropriate without erasing meaningful category information.

When limits are reached:

- Never truncate silently.
- Preserve a deterministic truncation flag.
- Include counts of omitted findings/evidence where possible.
- Include a clear truncation reason.
- Make the truncation information available to the model.
- Ensure the evidence manifest contains only retained evidence.

The same input and configuration must always produce the same serialized context and manifest.

## 5. Security requirements

Follow `11-security-architecture.md`, especially the prompt-injection mitigations.

The Context Assembler must:

- Never read repository files or source excerpts.
- Never pass raw diffs, README content, comments, source code, or arbitrary repository text to the model.
- Never use LLM-generated content to modify deterministic facts.
- Never treat repository-derived strings as trusted instructions.
- Serialize data structurally rather than constructing prompts through unsafe interpolation.
- Avoid including secrets, credentials, environment variables, internal stack traces, or unrelated tenant data.
- Avoid passing arbitrary metadata objects to the model.
- Enforce tenant-scoped access before context construction.
- Keep context data out of telemetry attributes and logs.

Do not attempt to solve prompt injection using fragile keyword filtering alone. Structural separation and explicit untrusted-data treatment are required.

## 6. Integration boundary

Step 60 must prepare a request. It must not execute it.

Do not:

- Call `ModelGateway.generate()`.
- Instantiate the Anthropic adapter.
- Make a real or mock model request.
- Change the impact-analysis engine.
- Change graph extraction or graph traversal.
- Change simulation behavior.
- Add an AI explanation UI.
- Add a worker job that invokes the model.
- Add AI persistence or an `AIAnalysis` migration.
- Implement schema validation or grounding validation of model output.
- Implement deterministic fallback explanations.

Those belong to later roadmap steps.

Do not modify existing production impact-analysis results or evidence.

## 7. Testing requirements

Write focused tests alongside implementation.

### Pure assembler tests

Cover:

- Valid completed impact analysis.
- Empty findings.
- All finding categories.
- Evidence association and manifest construction.
- Evidence from a different analysis run is rejected.
- Evidence associated with another impact analysis is rejected.
- Wrong subject type is rejected.
- Evidence subject ID does not match the finding.
- Missing evidence IDs.
- Duplicate evidence IDs.
- Findings containing fabricated evidence IDs.
- Stable ordering for equal confidence and depth.
- Confidence prioritization.
- Hop-distance prioritization.
- Category preservation.
- Maximum finding limit.
- Maximum evidence limit.
- Maximum string length.
- Context character budget.
- Transparent truncation metadata.
- Unresolved file limits.
- Malformed or unexpected optional values.
- Input immutability.
- Repeatability: identical inputs produce identical output.

### Loader tests

Cover:

- Successful tenant-scoped load.
- Missing or inaccessible analysis.
- Incomplete/failed analysis rejection.
- Evidence loaded using the same organization and analysis ID.
- Repository dependency failures.
- No cross-tenant access.
- No live database requirement for unit tests.

### Request builder tests

Cover:

- Correct `ModelGatewayRequest` contract.
- Correct `impact_explanation` task type.
- Stable prompt version.
- Explicit evidence manifest.
- No unsupported evidence IDs.
- Truncation disclosure.
- No raw repository content.
- No arbitrary metadata leakage.
- Untrusted-data instructions.
- Deterministic serialization.

All tests must be offline and deterministic. Do not require an Anthropic API key or make real provider calls.

Follow the repository's existing test conventions.

## 8. Documentation and learning deliverables

This is a major architecture phase. Update the existing documentation rather than creating competing architecture descriptions.

Update as appropriate:

- `docs/architecture/09-ai-architecture.md`
- `docs/architecture/05-component-responsibilities.md`
- `docs/architecture/17-implementation-roadmap.md`
- `docs/architecture/18-decision-log.md`
- `docs/DESIGN.md`
- `learning/README.md`

Create the following Step 60 artifacts, following the existing naming and formatting conventions:

1. Archived implementation prompt:
   `prompts/cursor or gemini/phase-09/phase-09-step-60.md`
2. Implementation report:
   `learning/implementations/phase-09/step-60-impact-context-assembler.md`
3. Learning note:
   `learning/notes/60. Impact Explanation Context Assembler.md`
4. Interview guide:
   `learning/interviews/60. Step 60 Context Assembler Interview CheatSheet.md`
5. Architecture decision record only if a genuinely new architectural decision is made. Do not create an ADR merely to document implementation details.

The implementation report must describe:

- What was implemented.
- Files created and modified.
- Module boundaries.
- Data flow.
- Evidence integrity guarantees.
- Truncation and prioritization rules.
- Security decisions.
- Tests and validation results.
- Known limitations.
- Explicitly deferred responsibilities.

The learning note should teach the engineering concepts, not merely repeat the implementation report.

The interview guide should cover trade-offs, evidence grounding, deterministic ordering, prompt-injection boundaries, tenant isolation, context budgeting, and likely senior-engineer interview questions.

## 9. Explicit non-goals

Do not implement:

- Step 61 structured-output schemas or output validator.
- Step 62 impact-analysis completion to AI generation orchestration.
- Step 63 AI explanation UI.
- Simulation narration.
- Chat query context.
- Tool calling.
- Repository file-reading tools.
- RAG or vector search.
- Embeddings.
- AIAnalysis database persistence.
- New database migrations.
- AI evaluation framework.
- Deterministic explanation fallback.
- Provider changes or pricing changes.
- Unrelated refactors.
- New dependencies unless demonstrably necessary and explicitly justified.

Keep the implementation narrow and reviewable.

## 10. Validation

First inspect package scripts and existing test commands.

Run the relevant focused tests, then the full workspace checks using the repository's established commands.

At minimum, validate:

- Focused Context Assembler tests.
- Existing Step 59 AI gateway tests.
- Full workspace tests.
- TypeScript checks.
- Lint.
- Evidence lint.
- Build.
- `git diff --check`.

Do not claim a check passed unless its command actually completed successfully.

If a command fails, report the exact failure and whether it is related to this change.

Do not skip tests merely to obtain a green result. Explain any skipped tests and whether they are pre-existing.

Do not make live Anthropic requests.

## 11. Acceptance criteria

Step 60 is complete only when:

1. A completed persisted impact analysis can be loaded through tenant-scoped repository methods.
2. Its impact findings and evidence are transformed into a minimal typed context.
3. Every allowed evidence ID is verified against the exact evidence records included.
4. The context is deterministically ordered and bounded.
5. Truncation is explicit and transparent.
6. Repository-derived content is treated as untrusted data.
7. A valid provider-independent `ModelGatewayRequest` can be produced.
8. The assembler never invokes the gateway or any model.
9. Existing deterministic impact-analysis and Step 59 behavior remains unchanged.
10. Focused and workspace validation pass.
11. Required documentation and learning artifacts are complete.

## 12. Required final implementation report

After implementation, provide:

1. Executive summary.
2. Architecture and data-flow explanation.
3. Exact files created, modified, or deleted.
4. Public types, functions, and exports added.
5. Evidence-manifest validation details.
6. Context prioritization and truncation behavior.
7. Security and tenant-isolation guarantees.
8. Tests executed with exact pass/fail/skip counts.
9. Typecheck, lint, evidence lint, build, and diff-check results.
10. Any deviations from this prompt and why.
11. Known limitations and deferred work.
12. Suggested manual review points.
13. Confirmation that no model request was executed and no commit or push was made.

**Do not commit or push. Leave all changes available for review.**
