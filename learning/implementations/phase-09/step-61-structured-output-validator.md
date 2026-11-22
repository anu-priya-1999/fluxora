# Step 61: Structured Output Schemas & Evidence Grounding Validator — Implementation Report

## 1. Executive Summary & Objective

In **Global Step 61** (Phase 9 Step 3), Fluxora implements **Strict Structured-Output Schemas and the Evidence Grounding Validator** for the `impact_explanation` AI task type.

Operating directly downstream of the Step 59 Model Gateway and Step 60 Context Assembler, the Step 61 validator establishes a strict verification and admission-control boundary between raw LLM completions and Fluxora's verified product data structures:
1. **Strict JSON Parsing**: Rejects malformed JSON, Markdown code fences, leading/trailing prose, and non-object roots without permissive repair or extraction.
2. **Canonical Output Schema (`impact-explanation-output-v1`)**: Strictly enforces the canonical four-field contract (`summary`, `claims`, `confidence`, `caveats`) with explicit, conservative character lengths and array bounds.
3. **Evidence-Manifest Grounding Verification**: Enforces that every factual claim contains at least one evidence ID, and that every cited evidence ID exists in the trusted `allowedEvidenceIds` manifest assembled in Step 60.
4. **Strict Whole-Response Rejection (ADR-014)**: Rejects the entire response when any claim contains an ungrounded citation; never silently repairs, coerces, or strips claims.
5. **Bounded Corrective Retry**: Supports exactly one corrective retry (two total attempts maximum) using a deterministic error instruction without echoing raw model output.
6. **Provider & Database Independence**: Implemented as pure TypeScript without third-party validation libraries, provider SDK dependencies, database queries, or live network calls.

---

## 2. Files Created and Modified

### Created Files
- `apps/workers/src/ai/structured-output/types.ts`: Strongly typed contracts for `ImpactExplanationOutput`, `ImpactExplanationClaim`, `ImpactExplanationConfidence`, validation issues, and discriminated validation results.
- `apps/workers/src/ai/structured-output/constants.ts`: Schema version `impact-explanation-output-v1`, conservative limits (`IMPACT_EXPLANATION_LIMITS`), and stable error codes (`VALIDATION_ERROR_CODES`).
- `apps/workers/src/ai/structured-output/schema.ts`: Canonical JSON Schema (Draft-07) definition for provider-independent model prompting and schema reference.
- `apps/workers/src/ai/structured-output/parser.ts`: Pure strict JSON parser rejecting fences, prose, primitives, arrays, and empty text.
- `apps/workers/src/ai/structured-output/validator.ts`: Schema and grounding manifest validator returning typed discriminated results.
- `apps/workers/src/ai/structured-output/retry.ts`: Bounded retry helper generating deterministic corrective instructions and enforcing the two-attempt ceiling.
- `apps/workers/src/ai/structured-output/index.ts`: Module export index.
- `apps/workers/src/ai/structured-output/parser.test.ts`: 9 unit tests verifying strict JSON parsing rules.
- `apps/workers/src/ai/structured-output/validator.test.ts`: 23 unit tests verifying schema constraints, manifest grounding, and whole-response rejection.
- `apps/workers/src/ai/structured-output/retry.test.ts`: 8 unit tests verifying retry counts, corrective feedback generation, and error propagation.
- `learning/decisions/adr-014-strict-whole-response-rejection-for-ungrounded-citations.md`: Architectural Decision Record for whole-response rejection vs partial stripping.
- `prompts/cursor or gemini/phase-09/phase-09-step-61.md`: Archived Step 61 implementation prompt.
- `learning/implementations/phase-09/step-61-structured-output-validator.md`: This comprehensive implementation report.
- `learning/notes/61. Structured Output Schemas and Evidence Grounding Validator.md`: Technical learning note on AI output verification and grounding boundaries.
- `learning/interviews/61. Step 61 Structured Output Validator Interview CheatSheet.md`: Technical interview and architecture defense guide.

### Modified Files
- `apps/workers/src/ai/index.ts`: Re-exported `./structured-output/index.ts`.
- `docs/architecture/09-ai-architecture.md`: Updated structured output validation, retry limits, and whole-response rejection rules.
- `docs/architecture/05-component-responsibilities.md`: Updated Structured Output Validator component status and boundaries.
- `docs/architecture/11-security-architecture.md`: Documented whole-response rejection and semantic support boundaries.
- `docs/architecture/17-implementation-roadmap.md`: Marked Step 61 complete.
- `docs/architecture/18-decision-log.md`: Logged ADR-014.
- `docs/DESIGN.md`: Added Step 61 implementation snapshot.
- `learning/README.md`: Updated Phase 9 documentation directory.

---

## 3. Architecture & Data Flow

```text
ModelGatewayResponse (Raw Text)
          │
          ▼
[parseStrictJsonObject]
  ├── Non-string / empty check ──────────────► Parse Error ($)
  ├── Markdown code fence detection (```) ───► Parse Error ($)
  ├── JSON.parse(rawText) ───────────────────► Parse Error ($)
  └── Root plain object check ───────────────► Parse Error ($)
          │
          ▼ Parsed Record<string, unknown>
[validateImpactExplanationOutput]
  ├── Check unrecognized root keys ──────────► Schema Error (path)
  ├── Check required keys (4 fields) ────────► Schema Error (path)
  ├── Validate summary (type, length, empty) ► Schema Error (summary)
  ├── Validate confidence (enum: high/med/low)► Schema Error (confidence)
  ├── Validate caveats (array, item lengths) ─► Schema Error (caveats[i])
  └── Validate claims
        ├── Object & required key check ─────► Schema Error (claims[i])
        ├── Text validation ─────────────────► Schema Error (claims[i].text)
        ├── Non-empty evidence_ids check ────► Grounding Error (claims[i].evidence_ids)
        ├── Within-claim duplicate check ────► Grounding Error (claims[i].evidence_ids[j])
        └── Manifest check (!allowedSet.has) ─► Grounding Error (claims[i].evidence_ids[j])
          │
          ├── Any Errors? ──► { success: false, errors: issues.slice(0, 20) }
          │                         │
          │                         ▼
          │                  [validateWithRetry]
          │                    ├── Build Bounded Corrective System Instruction
          │                    ├── Invoke Injected Retry Callback (Attempt 2)
          │                    └── Re-Validate against Exact Same Allowed Manifest
          │
          └── No Errors ────► { success: true, data: ImpactExplanationOutput, schemaVersion: "impact-explanation-output-v1" }
```

---

## 4. Canonical Schema Contract & Limits

### Required Fields
1. **`summary`** (string): Concise narrative synthesizing the deterministic findings and context without introducing new ungrounded facts.
2. **`claims`** (array): Array of factual claim objects. Empty claims array `[]` is valid if context lacks citable findings.
   - `text` (string): The factual claim.
   - `evidence_ids` (array of strings): 1 to 20 evidence IDs. Non-empty required for every factual claim.
3. **`confidence`** (`"high" | "medium" | "low"`): Model's self-assessed explanation confidence.
4. **`caveats`** (array of strings): Limitations, uncertainties, and qualifications.

### Limits (`IMPACT_EXPLANATION_LIMITS`)
| Field / Purpose | Maximum Limit | Enforcement Point & Behavior |
|---|---|---|
| `summary` | 2,000 characters | `validator.ts` — `STRING_TOO_LONG` |
| `claims` | 50 items | `validator.ts` — `ARRAY_TOO_LONG` |
| `claim.text` | 1,200 characters | `validator.ts` — `STRING_TOO_LONG` |
| `claim.evidence_ids` | 20 IDs per claim | `validator.ts` — `ARRAY_TOO_LONG` |
| Evidence ID string | 128 characters | `validator.ts` — `STRING_TOO_LONG` |
| `caveats` | 20 items | `validator.ts` — `ARRAY_TOO_LONG` |
| `caveat` string | 500 characters | `validator.ts` — `STRING_TOO_LONG` |
| Returned validation issues (`MAX_VALIDATION_ISSUES` / `MAX_RETURNED_VALIDATION_ISSUES`) | 20 issues | `validator.ts` — Truncated deterministically via `issues.slice(0, 20)` in the returned `ValidationResult` for downstream callers |
| Corrective retry feedback issues (`MAX_CORRECTIVE_FEEDBACK_ISSUES`) | 10 issues | `retry.ts` — Truncated deterministically via `errors.slice(0, 10)` in retry prompt instruction |
| Total validation attempts | 2 attempts (1 initial + 1 retry) | `retry.ts` — `MAX_VALIDATION_ATTEMPTS` ceiling |

---

## 5. Strict Parsing and Grounding Validation

### Strict JSON Parsing (`parser.ts`)
- Rejects non-string input (`INVALID_INPUT`).
- Rejects empty strings and whitespace-only text (`EMPTY_RESPONSE`).
- Rejects Markdown code fences (e.g., ````json ... ````) with `MARKDOWN_CODE_FENCE_DETECTED`.
- Rejects leading or trailing prose (e.g., `"Here is the JSON: {...}"` or `"{...} Hope this helps!"`) via `JSON_PARSE_ERROR`.
- Rejects arrays, numbers, strings, booleans, and `null` at the root with `INVALID_ROOT_TYPE`.
- Does not extract JSON from surrounding text, does not coerce types, and never repairs syntax errors.

### Evidence Grounding Manifest Validation (`validator.ts`)
- Takes the trusted `allowedEvidenceIds` from `ImpactExplanationContext` (assembled in Step 60).
- For each claim:
  1. Requires `evidence_ids` to be a non-empty array (`EMPTY_EVIDENCE_IDS`).
  2. Enforces within-claim uniqueness (`DUPLICATE_EVIDENCE_ID`).
  3. Verifies that every cited evidence ID exists in `allowedEvidenceIds` (`UNKNOWN_EVIDENCE_ID`).
- **Atomic Whole-Response Rejection**: If even one cited evidence ID fails manifest validation, the whole response is rejected.
- Allows multiple separate claims to cite the same allowed evidence ID.
- Allows empty claims `[]` when the manifest is empty, but rejects any claim with citations against an empty manifest.

---

## 6. Bounded Corrective Retry Policy (`retry.ts`)

- **Maximum Attempts**: Exactly 2 total attempts (initial response + 1 corrective retry).
- **Two Separate, Intentional Issue Limits**:
  - **Returned Validation Issues (`MAX_VALIDATION_ISSUES = 20`)**: Enforced at the validator boundary (`validator.ts`) on `ValidationResult.errors`. Returns up to 20 deterministic validation issues so downstream callers, error handlers, or evaluation harnesses can inspect comprehensive failure diagnostics without unbounded memory growth.
  - **Corrective Retry Feedback Issues (`MAX_CORRECTIVE_FEEDBACK_ISSUES = 10`)**: Enforced in the corrective instruction builder (`retry.ts`) via `errors.slice(0, 10)`. Caps the error bullet list formatted into the LLM retry prompt to prevent prompt bloat, token waste, and cognitive overload for the model during its single allowed retry attempt.
- **Corrective System Instruction**:
  - Details up to 10 validation issues (`MAX_CORRECTIVE_FEEDBACK_ISSUES`) by error code and property path.
  - Commands the model to return ONLY a single raw JSON object conforming to the schema.
  - Re-emphasizes that only IDs from the original allowed manifest may be cited.
  - **Secret & Content Safety**: Never echoes the previous raw model output in the prompt or error list.
- **Provider Exception Transparency**: If the injected `retry` callback throws (e.g. `ModelGatewayError.rateLimit()`), the exception is not swallowed or misclassified as a validation error; it propagates cleanly to the caller.

---

## 7. Three-Level Grounding Architecture & Guarantees

Fluxora explicitly defines three distinct levels of evidence grounding:

1. **Level 1 — Structural Evidence Association (Step 60 — Context Assembler)**:
   - Validates that evidence records match `subjectType === "impact_finding"`, matching `analysisRunId`, matching `metadata.impactAnalysisId`, and exact subject-node matching (`subjectId === finding.node.id`).
   - *Guarantee*: Candidate evidence is structurally linked to verified impact findings.
   - *Non-Guarantee*: Does not independently establish the truth, completeness, or semantic accuracy of the underlying evidence description.
2. **Level 2 — Evidence Manifest Membership (Step 61 — Output Validator)**:
   - Validates that every evidence ID cited in a claim belongs to the exact trusted manifest sent with the request.
   - *Guarantee*: Proves citation provenance and allowlist compliance. Prevents citing fabricated or cross-run evidence IDs.
   - *Non-Guarantee*: Does **not** prove that the cited evidence semantically entails or supports the claim. A model could cite a valid evidence ID associated with an unrelated finding.
3. **Level 3 — Semantic Evidence Support (Acknowledged Limitation)**:
   - Evaluates whether the factual claim is substantively supported by the content of the cited evidence.
   - Requires semantic evaluation (Step 65) or human review. Manifest membership alone cannot guarantee semantic support.

---

## 8. Verification Results

All tests run 100% offline with zero live model calls or network dependencies:

### Structured Output Tests (`apps/workers/src/ai/structured-output`)
- `parser.test.ts`: 9 passed (9/9)
- `validator.test.ts`: 23 passed (23/23)
- `retry.test.ts`: 8 passed (8/8)
- **Total Structured Output Tests**: 40 passed (40/40)

### Workspace Verification
- `pnpm --filter @fluxora/workers test`: 34 test files passed (440 passed, 4 skipped).
- `pnpm typecheck`: Clean across all 7 workspace packages (0 errors).
- `pnpm lint`: Clean (0 errors).
- `pnpm lint:evidence`: Clean (5/5 conclusion-producing files verified).
- `pnpm build`: Clean (Next.js 16 Turbopack build succeeded).
- `git diff --check`: Clean (0 whitespace/syntax issues).

---

## 9. Deferred Responsibilities

The following capabilities are deliberately out of scope for Step 61 and deferred to future roadmap steps:
- **Step 62**: Wiring impact-analysis completion $\to$ Model Gateway generation $\to$ Structured Output Validation $\to$ UI explanation presentation.
- **Step 63**: Simulation narration schema, prompt, and validator.
- **Step 64**: Tool-calling schema and interactive chat query validator.
- **Step 65**: Semantic entailment and hallucination rate evaluation suite.
- **Step 66**: Deterministic non-AI template fallback when validation retries are exhausted.
