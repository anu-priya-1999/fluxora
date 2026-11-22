# ADR-014: Strict Whole-Response Rejection for Ungrounded Structured Output Citations

## Status
Accepted

## Context
In Fluxora Global Step 61 (Phase 9 Step 3), the objective is to implement strict structured-output schemas and runtime validation for the `impact_explanation` AI task type.

A central requirement of Fluxora's architecture (`docs/architecture/09-ai-architecture.md §9.6`, Principle P1/P2/P10) is that every claim object in the output's `claims` array must cite verified evidence records assembled deterministically in Step 60 (`allowedEvidenceIds`).

When a model completion cites an evidence ID that does not exist in the trusted manifest supplied with the request (an ungrounded citation or hallucination), the system must enforce an unambiguous validation failure policy.

Section 9.6 of the architecture documentation previously noted two potential handling policies:
1. Permissive partial claim stripping: strip the invalid citations or remove only the ungrounded claim while accepting the remaining valid claims.
2. Strict whole-response rejection: reject the entire completion as invalid, perform a bounded corrective retry (up to 1 retry), and return an explicit validation failure if ungrounded citations persist.

## Alternatives Considered

1. **Permissive Partial Claim Stripping (Silent Removal)**:
   - *Proposal*: When a model returns a completion where some claims cite invalid evidence IDs, remove the invalid claims (or strip the ungrounded IDs from the claim) and return the remainder as a successful validation result.
   - *Why rejected*: Partial stripping silently alters the semantic coherence of the model's generated text. If a claim is removed, the surrounding `summary` or subsequent claims may still refer to the omitted finding, creating contradictions or confusing narratives. Furthermore, silent stripping masks model prompt-adherence issues from downstream evaluation suites, making it impossible to accurately measure hallucination rates.

2. **Permissive Acceptance with Warning Flags**:
   - *Proposal*: Accept the ungrounded claims but flag them with a warning or render them with an unverified badge in the UI.
   - *Why rejected*: Violates Principle P1 and P10. Presenting ungrounded claims to users—even with warning badges—risks eroding trust in Fluxora's blast-radius authority. The AI layer must not present ungrounded assertions as factual conclusions.

3. **Strict Whole-Response Rejection with Bounded Corrective Retry (Chosen)**:
   - *Proposal*: Treat any ungrounded evidence citation as a critical validation failure that invalidates the entire response payload. Enforce an atomic pass/fail outcome. Allow exactly one bounded corrective retry with explicit, deterministic error instructions detailing the validation error codes and property paths without echoing raw untrusted model output. If the retry also fails validation, return an explicit validation failure so the downstream orchestration layer can trigger deterministic non-AI template fallback (Step 66 / ADR-010).

## Decision
We choose Alternative 3:

1. **Atomic Whole-Response Validation**:
   - The validator never silently repairs, coerces, strips, or partially accepts an invalid model completion.
   - Every claim in the `claims` array must contain at least one evidence ID (`EMPTY_EVIDENCE_IDS` on empty array).
   - If any claim cites an evidence ID not present in the trusted `allowedEvidenceIds` manifest (`UNKNOWN_EVIDENCE_ID`) or cites duplicate IDs within the same claim (`DUPLICATE_EVIDENCE_ID`), the entire response fails validation.

2. **Strict Bounded Corrective Retry**:
   - The validator allows at most two total response attempts: the initial response plus one corrective retry (`MAX_VALIDATION_ATTEMPTS = 2`).
   - Validation failure results return up to 20 validation issues (`MAX_VALIDATION_ISSUES = 20`) to the calling orchestrator, which may consume them for downstream error handling and diagnostics.
   - The corrective feedback provides a concise, deterministic instruction formatting at most 10 issues (`MAX_CORRECTIVE_FEEDBACK_ISSUES = 10`) detailing error codes and paths without echoing raw untrusted model output, preventing prompt bloat during retry.
   - The retry is validated against the exact same original trusted evidence manifest.

3. **Clear Boundary with Deterministic Fallback**:
   - If both attempts fail validation, the validator returns an explicit discriminated failure result `{ success: false, errors: [...], attempts: 2 }`.
   - The validator does **not** fall back to a template explanation itself; deterministic fallback is owned by orchestration in Step 66.

4. **Provenance vs. Semantic Entailment Boundary**:
   - We explicitly recognize that manifest membership establishes citation provenance and allowlist compliance, but does not prove semantic correctness. Semantic entailment evaluation belongs to the planned Step 65 evaluation suite or human review; Step 61 manifest validation does not evaluate semantic support.

## Consequences

### Positive
- **Guaranteed Manifest Membership**: Evidence IDs absent from the trusted manifest cannot pass Step 61 validation. Step 61 guarantees schema compliance and citation provenance (verifying that every cited ID belongs to the allowed manifest), though it does not guarantee that cited evidence semantically supports the natural-language claim.
- **Semantic Coherence**: Explanations are never mangled by silent field deletion or partial claim removal.
- **Auditability and Eval Accuracy**: Every ungrounded citation results in an explicit validation failure returned to the caller, enabling downstream orchestration and evaluation harnesses (planned for Step 65) to accurately track failure rates without silent data corruption.
- **Fail-Closed Safety**: In accordance with Principle P10, failure of AI validation is explicit and clean; Step 61 returns an explicit validation failure so downstream orchestration can invoke deterministic fallback (Step 66), rather than Step 61 routing directly to fallback.

### Negative / Limitations
- **Higher Retry Rate on Minor Non-Compliance**: If a model generates five sound claims and one ungrounded citation, the entire completion must be retried rather than salvaged. However, capping the retry budget at exactly one corrective retry strictly limits additional latency and token cost, with actual model compliance rates measured downstream through the planned Step 65 evaluation suite.
