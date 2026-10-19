Implement ONLY Fluxora Global Step 47: Golden-Fixture PR Impact Validation.

IMPORTANT:
- Step 43: Impact Analysis Engine — complete.
- Step 44: ImpactAnalysis Persistence + Evidence — complete.
- Step 45: PR Impact Analysis API — complete.
- Step 46: Architecture Explorer change-mode overlay — complete.
- Step 47 is the FINAL STEP of Phase 6.
- This step validates the deterministic PR-impact pipeline against a real golden-fixture PR with hand-verified expected impact.
- Do NOT move into Phase 7.
- Do NOT implement evidence hardening, clickable evidence citations, confidence visual weighting, or analysis-coverage UI beyond what is strictly necessary to validate Step 47.
- Do NOT add AI, simulation, telemetry, runtime observation, or new graph algorithms.
- Do NOT redesign the frontend.
- Do NOT change the Step 43 traversal semantics simply to make a fixture pass.
- Do NOT weaken assertions to make the test pass.
- Do NOT commit or push. I will commit separately.

==================================================
1. READ THESE FIRST
==================================================

Read the actual repository files before coding.

1. docs/architecture/17-implementation-roadmap.md
   - Phase 6 — PR impact analysis
   - Step 7
   - Phase 6 acceptance criteria
   - Phase 6 risks/mitigation

2. docs/architecture/12-testing-strategy.md
   - §12.1 graph traversal testing
   - §12.2 integration testing
   - §12.3 contract testing
   - §12.4 end-to-end tests
   - golden-fixture expectations

3. docs/architecture/05-component-responsibilities.md
   - §5.7 Graph Builder
   - §5.8 Evidence Writer
   - §5.9 Impact Analysis Engine
   - §5.14 Fluxora API
   - §5.15 Architecture Explorer
   - §5.16 Job Queue / Worker Coordination

4. docs/architecture/06-database-schema.md
   - PullRequest
   - PullRequestFile
   - RepositorySnapshot
   - AnalysisRun
   - GraphNode
   - GraphEdge
   - Evidence
   - ImpactAnalysis
   - RLS / tenant boundaries

5. docs/architecture/07-api-architecture.md
   - graph query API
   - PR impact-analysis APIs
   - status/error conventions

6. Inspect the actual Step 33 golden graph fixture implementation.
   - existing fixture repository/data
   - existing fixture naming
   - existing test harness
   - existing canonical node/edge contracts
   - existing analysis-run setup
   - existing evidence assertions

7. Inspect the actual Step 43 tests.
   - impact seed resolution
   - changed-line matching
   - traversal
   - depth
   - confidence
   - truncation
   - classification

8. Inspect Step 44 persistence/evidence tests.

9. Inspect Step 45 API/job tests.

10. Inspect Step 46 frontend change-mode tests only to understand
    the persisted impact contract; do not modify frontend behavior
    unless a minimal fixture-facing compatibility issue is discovered.

11. Search the repository for any existing:
    - golden fixture repository data
    - recorded GitHub fixture responses
    - PR fixture
    - VCR-style recording
    - pull request fixture
    - known changed files
    - fixture manifests
    - expected impact snapshots

Do not assume the fixture repository, PR number, or expected result.
Discover what actually exists.

==================================================
2. STEP 47 GOAL
==================================================

Create a deterministic golden-fixture PR validation test proving:

real/recorded PR fixture
    ↓
PullRequest
    ↓
PullRequestFile / diff
    ↓
AnalysisRun
    ↓
GraphNode + GraphEdge + Evidence
    ↓
Step 43 impact analysis
    ↓
Step 44 persistence + evidence
    ↓
Step 45 API/job path where practical
    ↓
persisted ImpactAnalysis
    ↓
expected impact manifest
    ↓
assert actual == hand-verified expectation

The central acceptance criterion is:

Given a known PR, Fluxora's DIRECT impact and ONE-HOP DOWNSTREAM impact must match the hand-verified expectation for that PR.

The test must be deterministic and CI-safe.

==================================================
3. GOLDEN FIXTURE STRATEGY
==================================================

First determine whether the repository already contains a suitable
golden fixture repository and known PR.

Prefer, in this order:

1. An existing real open-source TypeScript/Next.js golden fixture
   already used by Step 33 or later tests.

2. An existing recorded GitHub fixture/fixture repository plus a
   known PR.

3. A stable local fixture that faithfully represents a real PR only
   if the architecture already permits recorded fixture data.

Do NOT introduce a live GitHub network dependency into the normal CI
test suite.

The testing strategy explicitly prefers recorded/fixture-based network
behavior for normal tests, reserving real GitHub calls for a separate
nightly/manual environment.

If a real-world known PR is already recorded, use it.

If no suitable PR fixture exists, create the smallest stable fixture
representation necessary within the existing fixture architecture,
but document exactly that it is derived from a real PR and which
facts were hand-verified.

Do NOT silently fabricate a "real PR."

==================================================
4. HAND-VERIFIED EXPECTATION
==================================================

The expected impact must be explicit and human-readable.

Create a fixture manifest or equivalent structured expected-result
artifact containing at least:

- PR identifier/fixture identifier
- repository identifier
- expected changed files
- expected direct impact node canonical IDs
- expected one-hop downstream node canonical IDs
- expected affected API canonical IDs, if applicable
- expected affected event canonical IDs, if applicable
- expected unresolved files, if applicable
- expected truncated state
- expected analysis-run relationship
- expected evidence/provenance locations where the fixture architecture
  supports stable assertions

The canonical IDs must come from the actual graph fixture.

Do not assert only display names.

Do not assert only array lengths.

Do not use snapshots that could pass while the wrong nodes are returned.

Use stable sorted canonical identifiers.

==================================================
5. WHAT MUST BE VERIFIED
==================================================

At minimum assert:

A. PR fixture loads correctly.

B. Changed files exactly match the recorded fixture expectation.

C. The selected AnalysisRun is the intended graph snapshot.

D. Changed-file → seed-symbol resolution is correct.

E. Direct impact set matches the hand-verified expectation.

F. One-hop downstream impact set matches the hand-verified expectation.

G. No unexpected direct-impact nodes exist.

H. No unexpected one-hop nodes exist.

I. A node expected to be unaffected is not returned.

J. A disconnected/irrelevant part of the fixture is not included.

K. Evidence IDs exist for persisted impact findings.

L. Evidence provenance points to real fixture paths/line ranges where
   the existing EvidenceWriter contract provides such data.

M. Confidence values are preserved according to Step 43 semantics.

N. Hop distances are correct.

O. Truncation is correct.

P. Unresolved files are correct.

Q. The persisted ImpactAnalysis references the exact expected
   AnalysisRun.

R. Re-running the same fixture produces the same logical result.

S. Re-running does not create duplicate persisted analysis/evidence,
   using existing Step 44 idempotency behavior.

==================================================
6. DIRECT VS ONE-HOP DEFINITION
==================================================

Be precise about the terminology.

Direct impact must correspond to Step 43's actual direct-impact
classification.

One-hop downstream must correspond to the first downstream traversal
level beyond the changed seed/direct nodes according to the existing
engine semantics.

Do not redefine depth merely for the fixture.

Inspect the actual Step 43 implementation and tests and encode the
expectation using those established semantics.

The fixture should explicitly distinguish:

Changed/seed nodes
    ↓
Direct impact
    ↓
One-hop downstream

Do not assert a vague "overall affected nodes" list as a substitute.

==================================================
7. FULL PIPELINE VALIDATION
==================================================

The preferred test should validate as much of the real Phase 6 path as
the current architecture allows without turning CI into a live external
integration test.

Prefer:

fixture PR
    ↓
existing database setup
    ↓
existing graph fixture / analysis run
    ↓
existing PullRequest + PullRequestFile persistence
    ↓
existing Step 43 engine
    ↓
existing Step 44 persistence/evidence
    ↓
existing Step 45 retrieval contract

If invoking the entire HTTP server/job queue would make the suite slow
or fragile, keep that separate.

Create:
- a deterministic golden-fixture integration test for the deterministic
  core and persistence
- contract/API assertions only where useful and already supported by
  the test architecture

Do not duplicate Step 45's API tests.

==================================================
8. TEST LAYERS
==================================================

Use the existing test organization.

A. Fixture contract test
- fixture loads
- manifest is valid
- expected IDs resolve

B. Impact-analysis integration test
- known PR
- known analysis run
- deterministic engine
- persisted result

C. Evidence assertions
- every expected impact finding has evidence
- provenance belongs to the correct analysis run
- no fabricated file/path/line data

D. Idempotency assertion
- repeat same logical analysis
- result remains equivalent
- no duplicate logical ImpactAnalysis/evidence rows

E. Run isolation
- same PR against a different AnalysisRun remains independent where
  existing fixture data permits the assertion

F. API read assertion
- GET persisted ImpactAnalysis
- returned result still matches the hand-verified expectation

Only add HTTP/job coverage beyond this where it meaningfully validates
the end-to-end contract.

==================================================
9. DETERMINISM
==================================================

The golden test must be deterministic.

Assert:

- stable canonical ID ordering
- stable finding ordering
- stable hop distance
- stable confidence
- stable evidence linkage
- stable unresolved-file ordering
- stable truncation fields

Run the impact computation twice from identical fixture input.

Assert logically equivalent output.

Do not compare volatile fields such as:
- created_at
- execution duration
- random UUIDs
unless existing deterministic IDs are intentionally used.

If the persisted ImpactAnalysis ID is deterministic in the current
Step 44/45 design, assert it. Otherwise assert the stable logical
identity rather than a random generated UUID.

==================================================
10. REGRESSION / NEGATIVE ASSERTIONS
==================================================

Include meaningful negative assertions.

At least:

- unrelated graph nodes are absent
- a disconnected component is absent
- an unrelated API is absent
- an unrelated event is absent
- a node belonging to another analysis run is absent
- if there is an unresolved changed file, it does not become a fake node
- cross-run contamination is impossible
- the test does not pass merely because the result contains the expected
  nodes plus additional unexpected nodes

Use exact set equality where appropriate.

==================================================
11. FALSE-NEGATIVE DEFENSE
==================================================

Phase 6 explicitly identifies false negatives as its primary risk.

The golden fixture must therefore catch missing edges/impact.

Add assertions for known relationships that the engine MUST discover.

For example:

changed symbol
    → known direct consumer
    → known one-hop downstream consumer

The test should fail if any expected node disappears.

Do not only assert counts such as:
"2 direct nodes" and "3 downstream nodes."

Assert the exact canonical node set.

==================================================
12. NO GOLDEN FIXTURE NETWORK DEPENDENCY
==================================================

Do NOT make ordinary CI depend on:

- live GitHub credentials
- live GitHub API
- current PR state
- current GitHub rate limits
- external repository availability
- current branch contents

Use existing recorded fixture infrastructure.

If the fixture metadata references a real GitHub repository/PR for human
traceability, include that provenance in documentation/manifest, but keep
the normal test deterministic.

==================================================
13. DATABASE / RLS
==================================================

Where the fixture test uses PostgreSQL, preserve existing tenant/RLS
testing conventions.

Verify:

- fixture organization owns the PR
- fixture PR owns the expected impact analysis
- graph nodes/edges belong to the expected AnalysisRun
- evidence belongs to the same run
- no cross-run contamination
- no cross-tenant visibility

Do not weaken RLS policies.

Do not bypass tenant scoping simply to make fixture setup easier.

Test setup helpers must establish ownership exactly as production code
expects.

==================================================
14. PERFORMANCE
==================================================

The golden test should remain reasonably fast and stable in CI.

Do not:
- introduce huge repositories
- add arbitrary sleep/retry loops
- call live network services
- rerun the entire workspace repeatedly inside one test

Use the existing small golden fixture and existing database test setup.

If the fixture is already the Step 33 taxonomy fixture, reuse it rather
than creating another duplicate fixture.

==================================================
15. IMPLEMENTATION LOCATION
==================================================

Prefer the existing golden-fixture/test locations and conventions.

Inspect where Step 33's golden graph verification lives and extend that
architecture rather than creating a disconnected test framework.

Possible areas include:
- apps/workers/src/pipeline/
- packages/db/src/repositories/
- fixtures/
- test-fixtures/
- learning/testing assets

Do not guess paths.

Use the repository's actual structure.

==================================================
16. DOCUMENTATION
==================================================

Create:

learning/implementations/phase-06/step-47-golden-fixture-pr-impact-validation.md

learning/notes/47. Golden Fixture PR Impact Validation.md

learning/interviews/47. Step 47 Golden Fixture PR Impact Validation Interview CheatSheet.md

Update:

docs/DESIGN.md

Documentation must explain:

1. Why Step 47 exists.
2. Why a real-world golden fixture matters.
3. What PR/fixture was selected.
4. How the fixture was recorded/represented.
5. How the expected impact was hand-verified.
6. What direct impact means in this test.
7. What one-hop downstream means.
8. Which canonical node IDs are expected.
9. Why exact-set assertions are used.
10. How evidence is validated.
11. How AnalysisRun isolation is validated.
12. How idempotency is validated.
13. Why the test avoids live GitHub calls.
14. What the fixture does NOT prove.
15. How this test protects against false negatives.
16. How this becomes the Phase 6 acceptance gate.
17. Known limitations and future fixture expansion.

Also document the traceability between:
- source repository
- PR
- changed files
- hand-verified impact
- expected canonical IDs
- expected persisted result.

Do not claim a PR is real if the test is only a synthetic reconstruction.
Be explicit about fixture provenance.

==================================================
17. DESIGN.md
==================================================

Add a Step 47 section describing:

Golden Fixture PR
      ↓
Recorded PullRequest + diff
      ↓
Known AnalysisRun + graph
      ↓
Step 43 Impact Analysis
      ↓
Step 44 Persistence + Evidence
      ↓
Exact expected impact manifest
      ↓
Equality + provenance + idempotency assertions
      ↓
Phase 6 acceptance

Also document:

- direct impact
- one-hop downstream
- evidence
- determinism
- run isolation
- false-negative protection

Do not rewrite unrelated sections.

==================================================
18. TEST COMMANDS
==================================================

Run the focused golden-fixture test first.

Then run:

pnpm --filter @fluxora/workers test

pnpm --filter @fluxora/db test

pnpm --filter @fluxora/api test

pnpm --filter @fluxora/web test

pnpm test

pnpm typecheck

pnpm lint

pnpm lint:evidence

pnpm build

git diff --check

Do not stop after the focused test.

Do not weaken unrelated tests.

==================================================
19. PHASE 6 ACCEPTANCE CHECK
==================================================

At the end, explicitly determine whether Phase 6 acceptance is satisfied.

The acceptance criterion is:

"Given a real PR, Fluxora's direct + one-hop downstream impact matches
what an experienced maintainer of that repo would identify."

Only declare that criterion satisfied if the fixture expectation is
actually hand-verified and the test asserts exact direct and one-hop
sets.

If the available fixture is insufficient to support that conclusion,
say so explicitly instead of inventing confidence.

==================================================
20. STRICT SCOPE
==================================================

DO NOT implement:

- Phase 7
- evidence-citation UI
- new evidence model
- confidence redesign
- analysis coverage UI
- AI explanation
- simulation
- runtime telemetry
- new graph database
- new graph traversal algorithm
- new API endpoint
- new frontend change-mode behavior
- new webhook behavior
- new PR ingestion behavior unless strictly needed to load the fixture
- live external GitHub CI dependency

Step 47 is validation, not a new product feature.

==================================================
21. FINAL REPORT
==================================================

Report:

1. Exact files created.
2. Exact files modified.
3. Golden fixture repository/source.
4. PR fixture identity.
5. Fixture provenance.
6. Changed files.
7. Hand-verified expected direct impact.
8. Hand-verified expected one-hop downstream impact.
9. Expected APIs/events if applicable.
10. Expected unresolved files.
11. Expected truncation state.
12. AnalysisRun used.
13. Evidence assertions.
14. Idempotency assertions.
15. RLS/run-isolation assertions.
16. Exact tests added.
17. Exact verification command results.
18. Whether the Phase 6 acceptance criterion is satisfied.
19. Known limitations.
20. Confirmation that Phase 7 was NOT implemented.
21. Confirmation that no commit/push was performed.

Do not commit or push.