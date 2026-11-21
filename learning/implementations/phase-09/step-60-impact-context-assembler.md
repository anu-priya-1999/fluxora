# Step 60: Impact Explanation Context Assembler — Implementation Report

## 1. Executive Summary & Objective

In **Global Step 60** (Phase 9 Step 2), Fluxora implements the **Impact Explanation Context Assembler** as the controlled, deterministic boundary between Fluxora's verified graph/impact results and its probabilistic Large Language Model (LLM) layer.

The context assembler implements the architectural requirements defined in `docs/architecture/09-ai-architecture.md §9.4`, `docs/architecture/05-component-responsibilities.md §5.12`, `docs/architecture/11-security-architecture.md §11.9`, and ADR-006:
1. **Deterministic Core vs Probabilistic Edge (P1/P10)**: The deterministic impact analysis engine remains the sole authority for blast-radius truth. The LLM only receives verified facts to narrate them.
2. **Strict Evidence Grounding Manifest**: Every factual claim the model is allowed to cite must correspond to an explicit evidence ID included in the allowed manifest.
3. **Transparent Truncation & Prioritization**: Context size limits (character budget, finding counts, evidence counts, string lengths) are enforced deterministically with transparent omission reporting—never silent truncation.
4. **Tenant Isolation**: Analysis and evidence records are loaded via tenant-scoped database methods under explicit `organizationId` and `impactAnalysisId` parameters, failing safely without disclosing cross-tenant record existence.
5. **Prompt Injection & Untrusted Data Safeguards**: Ingested repository content (symbol names, file paths, relationship descriptions) is treated strictly as untrusted data, stripped of control characters, length-clamped, and structurally separated from system instructions.
6. **Provider-Independent Request Generation**: Assembles a `ModelGatewayRequest` matching the Step 59 contract without invoking the Model Gateway or third-party SDKs.

---

## 2. Files Created and Modified

### Created Files
- `apps/workers/src/ai/context/types.ts`: Strongly typed contracts for bounded findings, bounded evidence records, truncation tracking, context limits, and the `ImpactExplanationContext` model.
- `apps/workers/src/ai/context/limits.ts`: Named default limits (`DEFAULT_CONTEXT_LIMITS`), overrides resolution, and ASCII control character sanitization.
- `apps/workers/src/ai/context/assembler.ts`: Pure deterministic context assembler transforming `ImpactAnalysis` and `EvidenceRecord[]` into a bounded `ImpactExplanationContext`.
- `apps/workers/src/ai/context/loader.ts`: Tenant-scoped loader using existing database repository methods with dependency injection for offline testing.
- `apps/workers/src/ai/context/request-builder.ts`: Prompt template serializer converting `ImpactExplanationContext` into a provider-independent `ModelGatewayRequest` (`impact_explanation` task type, version `impact-explain-v1`).
- `apps/workers/src/ai/context/index.ts`: Module export index.
- `apps/workers/src/ai/context/assembler.test.ts`: 25 unit tests covering all pure assembler requirements.
- `apps/workers/src/ai/context/loader.test.ts`: 8 unit tests covering tenant isolation, error handling, and status verification.
- `apps/workers/src/ai/context/request-builder.test.ts`: 9 unit tests covering request formatting, manifest embedding, truncation disclosure, and untrusted-data instructions.
- `prompts/cursor or gemini/phase-09/phase-09-step-60.md`: Archived Step 60 implementation prompt.
- `learning/implementations/phase-09/step-60-impact-context-assembler.md`: This comprehensive implementation report.
- `learning/notes/60. Impact Explanation Context Assembler.md`: Deep-dive engineering learning note.
- `learning/interviews/60. Step 60 Context Assembler Interview CheatSheet.md`: Technical interview and architecture defense guide.

### Modified Files
- `apps/workers/src/ai/index.ts`: Re-exported `./context/index.ts`.
- `docs/architecture/09-ai-architecture.md`: Updated Context Assembler implementation details.
- `docs/architecture/05-component-responsibilities.md`: Updated Context Assembler component status.
- `docs/architecture/17-implementation-roadmap.md`: Marked Step 60 complete.
- `docs/architecture/18-decision-log.md`: Cross-referenced ADR-006 and Context Assembler invariants.
- `docs/DESIGN.md`: Added Step 60 implementation snapshot.
- `learning/README.md`: Updated implementation tracking.

---

## 3. Architecture & Data Flow

```text
PostgreSQL Database
  ├── getImpactAnalysisById(pool, orgId, analysisId) ──┐
  └── listImpactFindingEvidence(pool, orgId, analysisId)─┴─► [Tenant-Scoped Loader]
                                                                     │
                                                      ImpactAnalysis + EvidenceRecord[]
                                                                     │
                                                                     ▼
                                                      [Pure Deterministic Assembler]
                                                        ├── Validate Structural Evidence Association
                                                        ├── Map & Deduplicate Findings
                                                        ├── Prioritize (Confidence, Depth, NodeId)
                                                        ├── Bound Context & Character Budget
                                                        └── Synthesize Allowed Manifest
                                                                     │
                                                          ImpactExplanationContext
                                                                     │
                                                                     ▼
                                                          [Model Request Builder]
                                                        ├── System Instruction (P1, P10, Security)
                                                        ├── User Message (<impact_context> JSON)
                                                        └── Grounding Manifest Definition
                                                                     │
                                                                     ▼
                                                           ModelGatewayRequest
                                                      (Ready for Step 59 ModelGateway)
```

### Module Boundaries
- `apps/workers/src/ai/context/`:
  - **No Provider SDK Dependencies**: Zero imports from `@anthropic-ai/sdk`.
  - **No Live Model Calls**: Zero invocations of `ModelGateway.generate()`.
  - **No Graph/Traversal Logic**: Operates purely on already-persisted `ImpactAnalysis` and `EvidenceRecord` data.
  - **No Output Validation**: Does not validate or parse model completions (owned by Step 61).

---

## 4. Structural Evidence Association and Grounding Manifest

The evidence manifest is the central reliability mechanism making grounding checkable:
1. **Subject Type Validation**: Accepts only evidence records with `subjectType === "impact_finding"`.
2. **Analysis Run Isolation**: Rejects any evidence record whose `analysisRunId` does not match `analysis.analysisRunId`.
3. **Analysis Association Verification**: Rejects any evidence record whose `metadata.impactAnalysisId` (or `metadata.impact_analysis_id`) does not match the requested `analysis.id`.
4. **Subject Node Matching**: Every cited evidence ID on a finding is validated to ensure the evidence's `subjectId === finding.node.id`. `metadata.nodeId` is never used as a substitute for a mismatched subject ID.
5. **No Fabricated Evidence IDs**: Findings listing fabricated or unverified IDs have those IDs stripped; findings with zero verified evidence retain `evidenceIds: []`.
6. **Manifest-Context Coherence**: The `allowedEvidenceIds` manifest is derived strictly from the evidence records *actually retained* in the serialized context. If an evidence record is omitted due to character budget or evidence limits, its ID is removed from both the manifest and any remaining finding's `evidenceIds`.

### Three-Level Grounding Architecture and Guarantees

To prevent overstating reliability guarantees, the architecture explicitly distinguishes three separate levels:

1. **Structural Evidence Association (Step 60 — Context Assembler)**
   - The Context Assembler establishes that candidate evidence is structurally associated with the relevant persisted impact finding through validated subject identity, analysis-run identity, and impact-analysis association (`subjectType === "impact_finding"`, matching `analysisRunId`, matching `metadata.impactAnalysisId`, exact `subjectId === finding.node.id`; `metadata.nodeId` is never used as a substitute for a mismatched `subjectId`).
   - Only retained, structurally verified evidence records contribute IDs to the `allowedEvidenceIds` manifest.
   - *Guarantee:* Establishes that the evidence record is structurally associated with the relevant persisted impact finding through validated subject identity, analysis-run identity, and impact-analysis association, and that no fabricated or cross-run evidence IDs enter the context.
   - *Non-Guarantee:* This verifies the record's structural association. It does not independently establish the truth, completeness, or semantic accuracy of the underlying evidence description.

2. **Evidence Manifest Membership (Step 61 — Output Validator)**
   - The future structured-output Validator checks that evidence IDs cited by model-generated claims belong to the exact allowed evidence-ID manifest supplied with the request.
   - Claims citing evidence IDs outside the allowed manifest are rejected as violating the evidence-grounding policy (and stripped or retried per Step 61 validation policy).
   - *Guarantee:* Establishes citation provenance and allowlist compliance. It prevents the model from citing evidence IDs that were not structurally verified and retained in the context. Crucially, it does not prove that the model interpreted the evidence correctly or that the cited evidence factually supports the claim.

3. **Semantic Evidence Support (Acknowledged Limitation)**
   - Manifest membership alone cannot establish that cited evidence substantively supports or entails a natural-language claim.
   - For example, a model might cite a valid evidence ID associated with an unrelated finding, or misrepresent the relationship described by a valid evidence record.
   - Manifest membership establishes citation provenance and allowlist compliance, not semantic correctness. The validator does not automatically prove that cited evidence entails or substantively supports the natural-language claim.
   - Semantic support requires additional verification (such as explicit claim-to-finding association checks, downstream semantic evaluation in the evaluation suite §12.5 / Step 65, or human review).
   - Unless such verification is implemented, semantic correctness is documented as an acknowledged limitation, not a guaranteed property.

---

## 5. Prioritization, Dual Budgets & Truncation Rules

To prevent runaway token costs and model latency, the assembler enforces configurable, named limits across two distinct, independent boundaries:

### Dual Independent Budgets
1. **Context Envelope Budget (`maxTotalCharacters: 30,000` default)**:
   - Bounds the raw compact JSON envelope (`ImpactExplanationContext`) during deterministic context assembly.
   - Trims unresolved files and lowest-priority findings iteratively when over budget, updating evidence records and the allowed manifest in lockstep.
   - Evaluates candidate size inclusive of active truncation reasons.
2. **Final Request Message Hard Cap (`MAX_REQUEST_MESSAGE_CHARACTERS = 100,000`)**:
   - Independently bounds the final formatted user message (`ModelGatewayRequest.messages[0].content`) after pretty-printing (space=2), secondary manifest serialization, static prompt instructions, truncation disclosures, and Unicode escaping.
   - **Hard Ceiling Invariant**: Callers may supply a lower custom limit via `options.maxRequestMessageCharacters`, but can NEVER raise the limit above 100,000 or bypass it via `Infinity`, `NaN`, negative values, or zero (`Math.max(1, Math.min(Math.floor(requestedLimit), 100_000))`). Positive fractional values are floored and clamped to $\ge 1$.
   - **Application-Level Safeguard vs Tokenizer**: Character limits are deterministic application-level safeguards, not tokenizers; the Model Gateway and provider policies manage token budgets.

### Configurable Limits
- `maxTotalCharacters`: 30,000 characters (default)
- `maxFindings`: 50 findings (default)
- `maxEvidenceRecords`: 50 records (default)
- `maxStringLength`: 500 characters (default)
- `maxUnresolvedFiles`: 20 files (default)

### Deterministic Prioritization Hierarchy
1. **Higher Confidence First**: Findings with higher confidence decay scores are prioritized (`b.confidence - a.confidence`).
2. **Lower Hop Distance First**: Findings closer to the modified files are prioritized (`a.depth - b.depth`).
3. **Canonical Category Priority**: `direct` < `downstream` < `api` < `event` < `service`.
4. **Stable Node ID Tie-Breaker**: Node IDs break ties deterministically (`a.nodeId.localeCompare(b.nodeId)`).

### Transparent Truncation
When limits are exceeded:
- Context is flagged with `truncated: true`.
- `contextLimitsExceeded: true` is tracked alongside underlying graph traversal truncation (`analysisWasTruncated`).
- Counts of omitted findings, evidence records, and unresolved files are recorded.
- Detailed human-readable reasons are assembled (e.g. `"Finding limit (50) exceeded: 12 findings omitted"`).
- Character budget overages iteratively drop lowest-priority findings and re-synchronize evidence records until the serialized envelope fits within budget.

---

## 6. Security & Tenant Isolation

- **Zero Source Code Ingestion**: Raw repository files, diffs, comments, and README contents are never passed to the model.
- **Untrusted Data Sanitization**: Untrusted strings (symbol names, file paths, relationship descriptions, truncation reasons) are stripped of non-printable ASCII control characters and clamped to `maxStringLength`.
- **System Instruction Defense**: System instructions explicitly inform the model that all repository-derived strings are untrusted data that must never be interpreted as instructions or role overrides.
- **Structural XML Containment & Safe JSON Escaping**: `<impact_context>` JSON block isolates data from instructions, with markup-significant characters (`<`, `>`, `&`) safely encoded as JSON unicode escape sequences (`\u003c`, `\u003e`, `\u0026`) preventing XML tag breakout. Truncation notices outside `<impact_context>` also safely encode markup characters and strip newlines.
- **Defense-in-Depth Acknowledgment**: JSON Unicode escaping enforces structural containment; semantic prompt injection remains an acknowledged risk handled by layered safeguards (untrusted data directives, minimal context, Step 61 schema/grounding validation, Step 66 fallback).
- **Zero Metadata Leakage**: Arbitrary `GraphNode.metadata` and database metadata objects are stripped; only allowlisted fields are exposed.
- **Tenant Scope Enforcement**: `loadImpactExplanationContext` requires explicit `organizationId` and `impactAnalysisId`, utilizing existing PostgreSQL RLS queries (`getImpactAnalysisById`, `listImpactFindingEvidence`) and returning `not_found` for missing or foreign tenant records.

---

## 7. Testing & Verification

All tests run 100% offline without live database or third-party network access.

| Test Suite | Purpose | Tests | Status |
|---|---|---|---|
| `src/ai/context/assembler.test.ts` | Pure deterministic assembler: 31 requirements | 31 | ✅ Passed |
| `src/ai/context/loader.test.ts` | Tenant-scoped loader: RLS, status, errors | 8 | ✅ Passed |
| `src/ai/context/request-builder.test.ts` | Request builder: contracts, manifest, injection defense, prompt, 100k cap matrix | 19 | ✅ Passed |
| `src/ai/*.test.ts` | All AI module tests (Step 59 + Step 60) | 99 | ✅ Passed |
| `apps/workers` Full Suite | Workers integration and pipeline tests | 388 passed (4 skipped) | ✅ Passed |
| Workspace Typecheck (`tsc`) | Static TypeScript check across 7 packages | 0 errors | ✅ Passed |
| Workspace Lint (`eslint`) | Code style, import, and AST cleanliness | 0 errors | ✅ Passed |
| Evidence Completeness Lint | Verified all conclusion write paths | 5 files passed | ✅ Passed |
| Workspace Build (`next build`) | Turbopack compilation and page generation | Succeeded | ✅ Passed |
| Git Diff Check (`git diff --check`) | Whitespace and syntax integrity | Clean | ✅ Passed |

---

## 8. Explicit Non-Goals & Deferred Work

The eight sequential steps of Phase 9 (AI Reasoning) are:
- **Global Step 59 (Phase 9 Step 1)**: Model Gateway foundational client, Claude integration, and mock provider (Completed).
- **Global Step 60 (Phase 9 Step 2)**: Impact Explanation Context Assembler (Completed).
- **Global Step 61 (Phase 9 Step 3)**: Structured-output schema definition and Grounding Validator.
- **Global Step 62 (Phase 9 Step 4)**: End-to-end impact explanation integration (worker job orchestration + `AIExplanationPanel` UI).
- **Global Step 63 (Phase 9 Step 5)**: Simulation narration context assembly, validation, and UI integration.
- **Global Step 64 (Phase 9 Step 6)**: Tool-calling interactive Q&A chat interface (`query_graph`, `get_evidence`, `run_simulation`).
- **Global Step 65 (Phase 9 Step 7)**: Initial AI evaluation suite (groundedness and hallucination baseline metrics).
- **Global Step 66 (Phase 9 Step 8)**: Deterministic non-AI fallback explanation path.

### Deferred Verification & Grounding Scope Protection
- **No Output Validation in Step 60**: Output schema parsing and grounding manifest validation belong strictly to Step 61.
- **No Semantic Claim Evaluation**: Step 60 and Step 61 enforce structural evidence association and manifest membership. Evaluating whether cited evidence semantically entails or substantively supports a natural-language claim is deferred to the AI evaluation suite (Step 65) or future verification controls. Semantic correctness remains an acknowledged limitation of manifest-based grounding.
