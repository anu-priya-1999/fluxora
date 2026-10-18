Implement ONLY Fluxora Global Step 44: ImpactAnalysis Persistence + Evidence.

IMPORTANT:
- Global Step 43 is complete and pushed.
- Implement ONLY Step 44 from docs/architecture/17-implementation-roadmap.md.
- Do NOT implement Steps 45, 46, or 47.
- Do NOT add impact-analysis REST endpoints.
- Do NOT modify the frontend/change-mode UI.
- Do NOT add AI/LLM reasoning.
- Do NOT implement golden-fixture PR validation.
- Do NOT refactor unrelated database or graph code.
- Do NOT repeat or replace the Step 43 Impact Analysis Engine.
- Use the existing Step 43 engine as the source of the deterministic result.

FIRST:
1. Inspect the current repository and git history.
2. Read:
   - docs/architecture/17-implementation-roadmap.md
   - docs/architecture/05-component-responsibilities.md §5.8 and §5.9
   - docs/architecture/06-database-schema.md
   - docs/architecture/12-testing-strategy.md
   - Step 43 implementation, tests, learning docs, shared types, and DESIGN section
   - existing EvidenceWriter implementation and tests
   - existing repository persistence/RLS/idempotency patterns
3. Determine the current migration number and create the next migration number; do not guess if another migration already exists.
4. Preserve existing database conventions exactly.

STEP 44 OBJECTIVE:
Persist the deterministic Step 43 impact-analysis result into PostgreSQL and create the corresponding evidence records for impact findings.

Conceptual flow:

PullRequest
    ↓
Step 43 Impact Analysis Engine
    ↓
ImpactAnalysis persistence
    +
EvidenceWriter
    ↓
committed ImpactAnalysis + impact_finding Evidence