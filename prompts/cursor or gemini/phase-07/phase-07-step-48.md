Implement ONLY Fluxora Global Step 48: Evidence Completeness Audit + Hardening.

IMPORTANT:
- Phase 6 / Steps 43–47 are complete.
- Step 48 is the FIRST step of Phase 7: Evidence Engine Hardening.
- The goal is to audit every conclusion-producing code path and guarantee evidence completeness.
- Focus specifically on graph edges and impact findings already implemented.
- Do NOT implement Step 49 clickable EvidenceCitation UI.
- Do NOT implement Step 50 confidence-based visual weighting.
- Do NOT implement Step 51 analysis-coverage UI.
- Do NOT implement simulation, AI, telemetry, runtime observation, or new product features.
- Do NOT redesign the Evidence model unless an actual existing gap makes it necessary.
- Do NOT invent evidence or fabricate source locations.
- Do NOT weaken assertions or suppress lint failures.
- Do NOT commit or push. I will commit separately.
- Preserve all existing Fluxora terminology, architecture, security invariants, testing conventions, and documentation style.

==================================================
1. READ THESE FIRST
==================================================

Before changing anything, inspect the actual current repository.

Read:

1. docs/architecture/17-implementation-roadmap.md
   - Phase 7 — Evidence engine (hardening pass)
   - Step 48 scope
   - Phase 7 testing expectations
   - Phase 7 acceptance criteria

2. docs/architecture/05-component-responsibilities.md
   - §5.7 Graph Builder
   - §5.8 Evidence Writer / Evidence Store
   - §5.9 Impact Analysis Engine
   - §5.10 Simulation Engine only to understand future evidence expectations
   - §5.14 Fluxora API
   - §5.15 Architecture Explorer

3. docs/architecture/06-database-schema.md
   - GraphNode
   - GraphEdge
   - Evidence
   - ImpactAnalysis
   - AnalysisRun
   - RLS / tenant inheritance

4. docs/architecture/12-testing-strategy.md
   - §12.1 unit tests
   - Evidence Writer requirements
   - graph-write path evidence requirements
   - evidence coverage lint expectations
   - confidence propagation testing requirements

5. docs/DESIGN.md
   - existing Step 29 evidence lint design
   - Steps 43–47 evidence flow
   - current evidence guarantees

6. Actual existing Step 29 Evidence Writer implementation:
   - all exported EvidenceWriter functions
   - identity/idempotency behavior
   - provenance validation
   - transaction requirements
   - subject_type conventions

7. Actual Step 28 Graph Builder implementation:
   - every GraphNode write
   - every GraphEdge write
   - every branch/early return
   - every bulk insert/upsert path
   - retry/idempotency paths

8. Actual Step 43 Impact Analysis implementation:
   - every ImpactFinding-producing branch
   - direct impacts
   - downstream impacts
   - affected APIs
   - affected events
   - affected services
   - unresolved findings
   - truncation
   - multi-seed deduplication
   - retry/re-execution paths

9. Actual Step 44 ImpactAnalysis persistence implementation:
   - all ImpactAnalysis writes
   - EvidenceWriter calls
   - rollback behavior
   - idempotency behavior
   - stable finding identity

10. Actual Step 45 worker/API orchestration:
   - all ways an ImpactAnalysis can be produced/persisted
   - worker retry/re-execution paths

11. Existing evidence lint script:
   - what files it scans
   - what patterns it recognizes
   - what it can miss
   - whether ImpactAnalysis writes are fully covered

Do not rely only on documentation. Audit the actual code.

==================================================
2. STEP 48 GOAL
==================================================

Establish and prove this invariant:

EVERY CONCLUSION-PRODUCING GRAPH OR IMPACT RESULT
MUST HAVE CORRESPONDING IMMUTABLE EVIDENCE.

Specifically:

GraphNode / GraphEdge conclusion
    ↓
EvidenceWriter
    ↓
Evidence row

ImpactFinding conclusion
    ↓
EvidenceWriter.createImpactFindingEvidence(...)
    ↓
Evidence row

No code path may be able to persist or expose a confirmed conclusion
without the corresponding evidence record.

The audit must find real gaps, if any, and close them.

Do not assume "EvidenceWriter is called somewhere in the function"
means the whole function is covered. Inspect all branches and failure
paths.

==================================================
3. CONCLUSION-PRODUCING PATH INVENTORY
==================================================

Create an explicit inventory of all current conclusion-producing paths.

At minimum audit:

A. Graph Builder
- GraphNode creation
- GraphNode upsert
- GraphEdge creation
- GraphEdge upsert
- batch/bulk writes
- retries
- reprocessing/idempotent paths
- initial graph creation
- graph rebuilds
- any alternate graph persistence code path

B. Impact Analysis
- direct ImpactFinding creation
- downstream ImpactFinding creation
- affected API findings
- affected event findings
- affected service findings
- any finding deduplication/merge
- truncation-related findings
- multi-seed paths
- persisted ImpactAnalysis output
- any worker retry path that can write findings again

C. Any other CURRENT conclusion-producing graph/impact write path
discovered during code audit.

Do NOT implement future SimulationResult evidence yet unless the
current repository already has a simulation write path. If simulation
does not exist, document it as a future Step 8/10 evidence obligation
rather than adding unrelated functionality.

==================================================
4. EVIDENCE CONTRACT
==================================================

For every conclusion-producing write, verify:

1. Evidence is produced through EvidenceWriter.
2. Evidence uses the correct subject_type.
3. Evidence points to the correct subject_id.
4. Evidence references the correct analysis_run_id.
5. Evidence carries the actual source file path.
6. Evidence carries actual symbol_id where available.
7. Evidence carries real line_start / line_end when available.
8. Evidence carries the real relationship description.
9. Evidence confidence matches the source conclusion confidence.
10. Evidence contains no fabricated source location.
11. Evidence is persisted in the same transaction as the conclusion.
12. A failed evidence write causes the associated conclusion write to
    fail/rollback according to the established architecture.
13. Evidence is immutable/append-only according to the existing model.
14. Re-analysis produces evidence tied to the new AnalysisRun.
15. Cross-tenant evidence cannot be exposed.

Do not invent missing values merely to satisfy schema checks.

Where a source coordinate genuinely does not exist, follow the existing
EvidenceWriter contract and explicitly represent that limitation rather
than fabricating line numbers.

==================================================
5. GRAPH EDGE EVIDENCE AUDIT
==================================================

Audit the Graph Builder path in detail.

For every GraphEdge-producing relationship:

IMPORTS
CALLS
EXTENDS
EXPOSES_ROUTE
EMITS_EVENT
CONSUMES_EVENT
QUERIES_DB
WRITES
and any additional CURRENT edge types

verify that a corresponding Evidence row is always created.

Verify:

- source node
- target node
- edge type
- analysis run
- source file
- source symbol where available
- source line range
- relationship description
- confidence
- provenance

must agree.

Check for subtle gaps such as:

- bulk insert path bypassing EvidenceWriter
- conflict/upsert path without evidence
- retry path duplicating edge without evidence
- initial edge path using EvidenceWriter while a fallback path does not
- special edge type missing evidence
- failed evidence write leaving a committed edge
- evidence referencing the wrong analysis run
- evidence subject_id pointing to the wrong graph edge
- duplicate evidence generated unnecessarily during idempotent rerun

Fix genuine gaps.

Do not change existing graph semantics merely to make the audit easier.

==================================================
6. IMPACT FINDING EVIDENCE AUDIT
==================================================

Audit every ImpactFinding-producing path.

Every user-visible finding must have evidence.

Check:

- direct impacts
- downstream impacts
- affected APIs
- affected events
- affected services
- any other classification introduced by Step 43

The evidence must preserve:

- finding node
- analysis run
- file/symbol provenance where available
- traversal relationship
- confidence
- path/provenance semantics

Important:

Do NOT create generic "impact exists" evidence when actual graph-edge
evidence can be linked.

Prefer the most concrete provenance already available from Step 43.

Do not fabricate file/line coordinates for downstream findings.

Where the finding derives from traversal:

finding
  ↓
traversed graph relationship(s)
  ↓
underlying evidence

The evidence chain should remain explainable.

==================================================
7. EVIDENCE IDENTITY / DEDUPLICATION
==================================================

Review the existing EvidenceWriter identity strategy.

Verify that repeated execution does NOT generate duplicate evidence
records for the same logical conclusion when idempotency is expected.

At the same time:

- different AnalysisRuns must remain independent
- different logical findings must not accidentally collapse
- different evidence provenance must not collapse incorrectly
- tenant boundaries must remain independent

Do not introduce random evidence IDs as the solution.

Use the existing deterministic identity/idempotency strategy.

If the current identity strategy has a real ambiguity discovered by the
audit, fix it minimally and document why.

==================================================
8. TRANSACTIONAL INVARIANT
==================================================

Prove this invariant:

CONCLUSION WRITE + EVIDENCE WRITE
MUST BE ATOMIC.

Test failure scenarios such as:

- graph edge insert succeeds, evidence write fails
- impact analysis insert succeeds, evidence write fails
- one finding's evidence succeeds, a later finding's evidence fails
- transaction rollback during bulk persistence
- retry after rollback

Expected behavior:

NO CONFIRMED CONCLUSION WITHOUT ITS EVIDENCE.

The exact rollback mechanism must follow existing Step 28/44
transaction conventions.

Do not introduce a distributed transaction or new storage engine.

==================================================
9. ANALYSIS-RUN ISOLATION
==================================================

Evidence must remain tied to the exact AnalysisRun.

Verify:

Run A:
GraphEdge A
Evidence A

Run B:
GraphEdge B
Evidence B

Run A must never see Run B's evidence.

A re-analysis producing identical logical code relationships must still
create evidence associated with the correct new AnalysisRun according to
the existing append-only evidence model.

Test for accidental cross-run joins.

==================================================
10. TENANT / RLS AUDIT
==================================================

Verify evidence completeness does not weaken tenancy.

Test:

Tenant A:
- can read its own graph conclusions + evidence

Tenant B:
- cannot read Tenant A graph conclusions
- cannot read Tenant A impact findings
- cannot read Tenant A evidence
- cannot create/update evidence for Tenant A conclusions

Cross-tenant access must follow existing safe behavior.

Do not add client-supplied organization IDs.

Use existing RLS and server-side tenant resolution.

==================================================
11. EVIDENCE LINT HARDENING
==================================================

Step 48 must strengthen the existing evidence lint into a trustworthy
CI gate.

First understand exactly what the current `pnpm lint:evidence` scans.

Then determine whether it reliably catches all CURRENT graph and impact
write paths.

The lint must fail when a new conclusion-producing write path is added
without a corresponding evidence path.

At minimum the hardening should recognize CURRENT write targets involving:

- GraphEdge
- GraphNode where appropriate under the existing evidence invariant
- ImpactAnalysis
- ImpactFinding-related persistence

Do not build an overly broad heuristic that produces false positives on
unrelated DTOs, tests, reads, or types.

Prefer AST/static analysis using established project tooling.

The lint should provide an actionable failure message containing:

- file
- relevant write path
- expected evidence writer usage
- why the path failed detection

Do not suppress known exceptions silently.

If a legitimate exception exists, it must be explicit and documented.

==================================================
12. TEST COVERAGE
==================================================

Add focused tests for the audit.

A. Graph evidence coverage
- every edge type has evidence
- every graph write path calls EvidenceWriter
- evidence subject matches edge
- analysis_run_id matches
- provenance is real
- confidence matches

B. Impact evidence coverage
- every direct finding has evidence
- every downstream finding has evidence
- affected API finding has evidence
- affected event finding has evidence
- affected service finding has evidence where applicable
- evidence subject_id matches finding identity

C. Failure/rollback
- evidence failure rolls back conclusion
- partial finding persistence rolls back
- retry does not create unsupported duplicates

D. Idempotency
- repeated graph persistence does not duplicate evidence
- repeated impact persistence does not duplicate logical evidence

E. Analysis-run isolation
- Run A evidence never appears under Run B
- same logical relationship in different runs has correct run identity

F. Tenant isolation
- cross-tenant evidence access is rejected/empty according to RLS

G. Static lint
- introduce a controlled test fixture/example representing a graph/impact
  write missing EvidenceWriter
- verify lint detects it
- verify valid writer-backed path passes

Do not pollute production code with fake missing-evidence paths merely to
test the linter. Use the linter's existing test fixture architecture or
a temporary isolated fixture representation.

==================================================
13. CONFIDENCE PROPAGATION
==================================================

Audit the evidence confidence values against the actual conclusion.

At minimum verify existing Step 43 semantics remain intact:

confidence at depth N
=
initial confidence × decayFactor^N

The evidence associated with the finding must not accidentally reset
confidence to 1.0.

Add regression assertions showing that a deeper finding has lower
confidence than a shallower finding when the same decay factor applies.

Do NOT redesign the frontend visual weighting in this step.

This is an evidence/data correctness test only.

==================================================
14. NO FABRICATED EVIDENCE
==================================================

The following are prohibited:

- invented filenames
- invented line numbers
- invented symbol IDs
- guessed source locations
- fake evidence IDs
- generic placeholder evidence pretending to be source provenance

Evidence must originate from actual graph/source provenance already
available in the system.

When provenance is genuinely unavailable:
- preserve the finding only according to current system semantics
- mark/represent the provenance limitation
- do not fabricate certainty

Document any such limitation discovered during the audit.

==================================================
15. PERFORMANCE
==================================================

Do not turn evidence hardening into an O(N²) persistence process.

Prefer:

- batch evidence creation where the existing architecture supports it
- deterministic identity keys
- efficient maps/sets for in-memory validation
- indexed subject/run queries
- transaction-local evidence writes

Do not introduce a second database lookup per finding if the existing
EvidenceWriter or transaction already has the required data.

Do not change the core graph/impact algorithm for performance reasons in
Step 48 unless an actual evidence-specific performance issue is found.

==================================================
16. STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- Step 49 EvidenceCitation UI
- Step 50 confidence-based visual weighting
- Step 51 analysis coverage UI
- clickable file/line navigation
- new frontend screens
- simulation evidence paths unless already implemented/currently required
- AI evidence/grounding
- LLM calls
- runtime telemetry
- new graph algorithms
- new impact-analysis semantics
- new DB tables unless absolutely required to fix a proven existing
  evidence invariant gap
- new external services
- new authentication mechanisms

Step 48 is evidence completeness hardening of CURRENT conclusion paths.

==================================================
17. DOCUMENTATION
==================================================

Create:

learning/implementations/phase-07/step-48-evidence-completeness-audit.md

learning/notes/48. Evidence Completeness Audit.md

learning/interviews/48. Step 48 Evidence Completeness Audit Interview CheatSheet.md

Update:

docs/DESIGN.md

The implementation document must contain:

1. Scope and motivation.
2. Existing evidence architecture.
3. Conclusion-producing paths audited.
4. Graph evidence audit results.
5. Impact finding evidence audit results.
6. Evidence identity/idempotency analysis.
7. Transactional guarantees.
8. Analysis-run isolation.
9. Tenant/RLS guarantees.
10. Evidence lint hardening.
11. Tests added.
12. Any real gaps discovered and fixed.
13. Any paths audited and found already correct.
14. Known remaining limitations.
15. Why Step 49 is still separate.

The engineering note should teach:

- evidence as a trust boundary
- why "write the result, then write evidence later" is unsafe
- provenance vs. explanation
- append-only evidence
- deterministic evidence identity
- transaction atomicity
- analysis-run versioning
- tenant isolation
- static evidence coverage enforcement

The interview cheat sheet should cover:

- How do you guarantee every graph edge has evidence?
- How do you guarantee every impact finding has evidence?
- Why must evidence and conclusions be transactional?
- What happens when EvidenceWriter fails?
- How do you prevent duplicate evidence?
- Why is AnalysisRun part of evidence identity?
- How do you prevent cross-tenant evidence leakage?
- How would you statically detect a new evidence-less write path?
- Why is fabricated source location worse than missing provenance?
- How do you preserve confidence through the evidence chain?
- What limitations remain after the audit?

Use the same learning structure, terminology, and depth as Steps 43–47.

==================================================
18. DESIGN.md
==================================================

Add a Step 48 architecture section.

Document this invariant:

CONCLUSION
   ↓
EVIDENCE WRITER
   ↓
ATOMIC TRANSACTION
   ↓
CONCLUSION + EVIDENCE COMMITTED TOGETHER

For graph edges:

Graph extraction
   ↓
GraphEdge
   ↓
EvidenceWriter
   ↓
Evidence

For impact:

Step 43 finding
   ↓
Step 44 persistence
   ↓
EvidenceWriter
   ↓
Evidence

Also document:

- evidence identity
- provenance
- confidence
- transaction rollback
- RLS
- AnalysisRun isolation
- static evidence lint
- retry/idempotency behavior

Do not rewrite previous sections unnecessarily.

==================================================
19. VERIFICATION
==================================================

Run:

1. focused EvidenceWriter tests
2. focused graph evidence tests
3. focused impact evidence tests
4. focused evidence-lint tests
5. pnpm --filter @fluxora/db test
6. pnpm --filter @fluxora/workers test
7. pnpm --filter @fluxora/api test
8. pnpm --filter @fluxora/web test

Then run:

pnpm test

pnpm typecheck

pnpm lint

pnpm lint:evidence

pnpm build

git diff --check

Also inspect:

git status

Do not claim a check passed unless it actually passed.

Do not modify unrelated failing tests.

==================================================
20. SUCCESS CRITERIA
==================================================

Step 48 is complete only when:

1. Every CURRENT graph conclusion-producing write path has evidence.
2. Every CURRENT impact conclusion-producing write path has evidence.
3. Evidence provenance is real and traceable.
4. Evidence confidence matches conclusion confidence.
5. Evidence and conclusion writes are atomic.
6. Reruns remain idempotent according to existing semantics.
7. AnalysisRun isolation is preserved.
8. Tenant/RLS isolation is preserved.
9. `pnpm lint:evidence` is a reliable hard CI gate for the audited paths.
10. Tests prove the invariant rather than merely asserting one happy path.
11. No Step 49/50/51 functionality was implemented.

Do NOT declare success merely because existing evidence tests pass.
The purpose of Step 48 is to prove there are no uncovered CURRENT
conclusion-producing paths.

==================================================
21. FINAL REPORT
==================================================

At the end, report:

1. Exact files created.
2. Exact files modified.
3. Every conclusion-producing path audited.
4. Every real evidence gap discovered.
5. Exact fixes made for each gap.
6. GraphNode/GraphEdge evidence guarantees.
7. ImpactFinding evidence guarantees.
8. EvidenceWriter methods used.
9. Evidence identity/idempotency behavior.
10. Transactional rollback behavior.
11. AnalysisRun isolation behavior.
12. Tenant/RLS behavior.
13. Evidence lint improvements.
14. Confidence propagation verification.
15. Exact tests added.
16. Exact verification command results.
17. Remaining limitations.
18. Confirmation that Step 49 was NOT implemented.
19. Confirmation that Step 50 was NOT implemented.
20. Confirmation that Step 51 was NOT implemented.
21. Confirmation that no commit or push was performed.

Do not commit or push.