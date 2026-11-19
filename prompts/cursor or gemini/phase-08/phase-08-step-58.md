# Fluxora Global Step 58 — Golden Fixture Simulation Validation

## Role

Act as a senior full-stack engineer and test-architecture owner building Fluxora, an AI-powered repository intelligence and deterministic failure-simulation platform.

## Objective

Implement **Global Step 58 — Golden Fixture Simulation Validation**, the final validation step of Phase 8.

Validate the existing Step 53 Simulation Rule Table and Step 54 Simulation Engine against Fluxora's real, immutable Taxonomy golden repository fixture.

The objective is to establish a deterministic, offline, hand-verified simulation scenario that proves:

1. The actual pinned repository fixture loads and passes integrity checks.
2. The existing Phase 3 pipeline and graph projection produce the expected real graph.
3. A manually verified dependency relationship can be represented explicitly for a golden simulation scenario without fabricating production graph relationships.
4. The deterministic engine produces the exact expected state transitions.
5. Every non-seed transition identifies its actual simulation edge, rule, rule version, and assumptions.
6. Unrelated nodes remain unaffected.
7. Repeated execution produces identical logical results.

This is a validation task, not a new simulation engine or graph-extraction feature.

---

## 1. Inspect before coding

First inspect:

- `git status --short`
- `git diff`
- `git diff --cached`
- Recent Git history.
- `AGENTS.md` and relevant repository instructions.
- `docs/DESIGN.md`.
- `docs/architecture/17-implementation-roadmap.md`.
- `docs/architecture/18-decision-log.md`.
- `docs/architecture/12-testing-strategy.md`.
- Existing Step 47 golden-fixture PR validation.
- Step 53 rule table and Step 54 engine.
- Existing golden fixture loader, manifests, and integrity tests.
- Existing Phase 3 pipeline and graph projection.
- Existing simulation-engine tests and persistence/evidence tests.

Inspect these implementation files:

```text
fixtures/golden/manifest.json
fixtures/golden/pr-impact-manifest.json
fixtures/golden/taxonomy/

apps/workers/src/fixtures/golden.ts
apps/workers/src/fixtures/golden.test.ts
apps/workers/src/pipeline/phase3.ts
apps/workers/src/pipeline/golden-graph.test.ts
apps/workers/src/builder/graph-builder.ts

packages/shared-types/src/fixtures.ts
packages/shared-types/src/simulation.ts
packages/shared-types/src/simulation-rules.ts

packages/db/src/repositories/simulation-engine.ts
packages/db/src/repositories/simulation-engine.test.ts
packages/db/src/repositories/simulation-rules.ts
packages/db/src/repositories/simulation-rules.test.ts
```

Check actual exports, types, package scripts, and test conventions before implementation.

Preserve all pre-existing working-tree changes. Do not overwrite unrelated work.

---

## 2. Golden fixture identity and integrity

Use the existing canonical golden fixture:

```text
Repository: shadcn-ui/taxonomy
Fixture ID: golden-taxonomy-v1
Pinned commit: 298a8857c7128a0d121e7f699dfd729f23b3966d
Manifest: fixtures/golden/manifest.json
Fixture directory: fixtures/golden/taxonomy/
```

The existing manifest records:

- 177 files.
- SHA-256 hashes for every listed file.
- File sizes.
- Pinned repository identity and commit.

Reuse:

```ts
loadGoldenFixtureManifest()
loadGoldenFixtureFileMap()
readGoldenFixtureFile()
readGoldenFixtureFileText()
```

Do not download the repository or access GitHub during tests.

Do not execute, import, or evaluate any Taxonomy fixture source code. Treat fixture files strictly as passive source data.

Reuse the existing Phase 3 extraction pipeline:

```ts
runPhase3Pipeline({ files: fileMap })
```

Reuse the deterministic graph projection:

```ts
buildGraphProjection({
  organizationId,
  analysisRunId,
  normalizedResult,
})
```

Do not create a second parser, a new graph builder, or a parallel graph-extraction pipeline.

### Existing graph baseline

The existing golden graph contract records:

- 490 graph nodes.
- 888 graph edges.
- 367 symbol nodes.
- 118 module nodes.
- 5 API route nodes.
- 511 `IMPORTS` edges.
- 5 `EXPOSES_ROUTE` edges.
- 372 `RESOLVES_TO` edges.
- Zero event nodes and zero direct database nodes.

Reconfirm these against the current checkout and existing tests. Reuse established assertions rather than duplicating the entire Step 33 graph validation suite.

---

## 3. Critical semantic boundary: IMPORTS is not CALLS

This is the most important constraint in Step 58.

Inspect `apps/workers/src/builder/graph-builder.ts` and the actual golden graph edge output.

The current graph builder creates edges for:

- `IMPORTS`
- `EXPOSES_ROUTE`
- `RESOLVES_TO`
- Event relationships where extraction supports them.
- Database relationships where extraction supports them.

The current Taxonomy graph does not provide first-class `CALLS` edges.

The Step 53 simulation rule table supports actual semantic relationships such as:

- `CALLS`
- `QUERIES_DB`
- `CONSUMES_EVENT`

It does not interpret an ordinary `IMPORTS` edge as a function invocation.

**Never convert, relabel, cast, or reinterpret `IMPORTS` edges as `CALLS` merely to make simulation propagation happen.**

Do not modify the production graph builder to invent call relationships as part of this validation step.

### Fixture-backed manually verified relationship

Inspect this actual pinned Taxonomy source relationship:

```text
Caller:
app/api/users/stripe/route.ts

Callee:
lib/subscription.ts

Invoked function:
getUserSubscriptionPlan
```

The API route contains an awaited invocation:

```ts
const subscriptionPlan = await getUserSubscriptionPlan(session.user.id)
```

The callee exports `getUserSubscriptionPlan`.

Verify the exact call-site line, function definition, import, and module canonical IDs directly from the pinned fixture files. Do not blindly trust copied line numbers.

Expected canonical module identities:

```text
mod:app/api/users/stripe/route.ts
mod:lib/subscription.ts
```

If the current production graph projection now contains a verified `CALLS` edge for this exact relationship, use that real edge and its evidence.

Otherwise, represent this manually verified invocation through an explicitly **test-only simulation relationship** added to the `SimulationGraphSnapshot`.

The test-only relationship must:

- Be derived from the exact pinned fixture source.
- Record the caller and callee canonical IDs.
- Record the source file path and verified call-site line.
- Record the invoked symbol.
- Use `edgeType: "CALLS"`.
- Have a deterministic ID.
- Carry clearly identifiable test-only provenance.
- Include the actual simulation metadata needed by the rule table.
- Never be added to the canonical production `GraphProjectionResult`.
- Never be described as a relationship emitted by the production graph builder.
- Never be persisted as a normal production Taxonomy graph edge.

This is a test-fixture augmentation for validating simulation semantics, not evidence that the current extraction pipeline discovers `CALLS`.

---

## 4. Create a dedicated Golden Simulation Expectation Manifest

Create:

```text
fixtures/golden/simulation-manifest.json
```

Follow the conventions of:

```text
fixtures/golden/manifest.json
fixtures/golden/pr-impact-manifest.json
```

Create a typed contract in:

```text
packages/shared-types/src/fixtures.ts
```

Use a clearly named type such as:

```ts
GoldenSimulationExpectationManifest
```

The manifest must describe:

### A. Fixture identity

- A unique simulation fixture ID.
- The pinned Taxonomy repository identity.
- The exact fixture commit SHA.

### B. Scenario definition

Use one hand-designed scenario:

```text
Scenario: Taxonomy subscription helper unavailable
Failure type: unavailable
Target canonical ID: mod:lib/subscription.ts
```

### C. Manually verified call relationship

Record:

- Caller canonical ID.
- Callee canonical ID.
- Edge type.
- Invoked symbol.
- Exact source file.
- Verified source line or line range.
- Verified source snippet.
- Simulation metadata.
- Explicit declaration that the edge is test-only when it does not exist in the production graph.

Use conservative metadata.

For this awaited call, `sync: true` may be used only after verifying the call-site semantics. Keep unverified fallback and circuit-breaker metadata as `"unknown"` rather than inventing confirmed absence.

### D. Expected simulation results

Represent expected results using canonical node IDs rather than relying on generated UUIDs.

Expected logical behavior:

| Component | Expected state | Explanation |
|---|---|---|
| `mod:lib/subscription.ts` | `failed` | Direct failure seed |
| `mod:app/api/users/stripe/route.ts` | `degraded` | Caller affected by the verified simulation-only `CALLS` relationship |
| `mod:components/site-footer.tsx` | `healthy` | Unrelated negative control |

Expected causal semantics:

- Seed transition: `healthy → failed`.
- Seed rule: `target_failure`.
- Propagated transition: `healthy → degraded`.
- Propagation rule: `CALLS+sync+no_fallback`.
- Propagation edge: the exact deterministic ID of the manually verified test relationship.
- Propagation confidence: derive from the actual Step 53 rule decision. With `sync: true` and unknown fallback/circuit-breaker metadata, verify the expected confidence of `0.9` from the rule implementation.
- Propagation assumptions must be the actual assumptions produced by the rule table.
- Capped propagation must match the actual rule decision.

Do not fabricate expected values. Verify every expectation against the actual engine and rule table before writing the manifest.

---

## 5. Add a Golden Simulation Manifest Loader

Update:

```text
apps/workers/src/fixtures/golden.ts
```

Follow existing loader conventions.

Add:

- A canonical golden simulation fixture ID constant.
- A canonical manifest path constant.
- A typed loader such as `loadGoldenSimulationExpectationManifest()`.

Reuse the existing fixture path and file-reading safeguards.

Do not introduce a new filesystem abstraction or duplicate path-resolution logic.

Update:

```text
apps/workers/src/fixtures/golden.test.ts
```

Add checks for:

- Manifest existence and successful parsing.
- Fixture identity.
- Pinned commit equality.
- Valid target canonical ID.
- Valid expected state values.
- Valid expected call relationship.
- Source file exists inside the pinned fixture.
- Stored source location and snippet match the actual source file.
- Test-only relationship declaration is explicit where applicable.
- Expected positive and negative controls are valid.

Retain all existing fixture integrity checks.

---

## 6. Implement the Golden Simulation Validation Test

Create:

```text
apps/workers/src/pipeline/golden-simulation.test.ts
```

Use the existing real fixture pipeline:

```text
Pinned Taxonomy source files
          |
          v
Golden Fixture Loader
          |
          v
Phase 3 Extraction Pipeline
          |
          v
Normalized Intelligence
          |
          v
Deterministic Graph Projection
          |
          v
SimulationGraphSnapshot
          |
          v
Step 54 runSimulationEngine
          |
          v
Hand-verified expected results
```

Keep this test deterministic and offline.

Prefer the pure `runSimulationEngine` path for this fixture validation. Existing Step 54 tests already cover persistence, transactions, and database evidence behavior; do not duplicate those suites unnecessarily.

### Test A — Production graph projection integrity

Build the real Taxonomy graph projection.

Assert:

- Target and caller module canonical IDs exist.
- The selected negative-control module exists.
- The real source relationship is present in the pinned fixture.
- The production graph projection remains unchanged.
- No fabricated `CALLS` edge appears in the production projection.

### Test B — IMPORTS negative control

Run the scenario with the real projected graph and no test-only CALLS edge.

Seed:

```text
mod:lib/subscription.ts
```

Assert:

- The seed receives the expected unavailable failure state.
- The existing `IMPORTS` relationship does not cause caller degradation.
- No other unsupported relationship type triggers simulation propagation.
- Unrelated nodes remain healthy.
- The engine does not create a phantom propagation step.

This is a critical regression test proving that imports are not treated as function invocations.

### Test C — Hand-verified simulation relationship

Add the explicitly documented test-only `CALLS` relationship to the simulation snapshot, without modifying the production projection.

Run:

```ts
runSimulationEngine({
  scenario,
  graph,
})
```

Use the established default rule table unless the existing architecture requires otherwise.

Assert exact logical results using canonical node IDs:

1. Subscription helper becomes `failed`.
2. API route caller becomes `degraded`.
3. The call-site causal step references the exact test-only edge ID.
4. The propagation step uses `CALLS+sync+no_fallback`.
5. The rule version matches the actual rule table.
6. Confidence matches the verified rule output.
7. Assumptions match the actual rule output.
8. The seed step has `edgeId: null`.
9. No phantom edge is introduced.
10. The negative-control site-footer module remains healthy and is not emitted as an affected result.

Assert the complete expected result set, not merely that two expected records happen to exist.

### Test D — Determinism

Execute the identical scenario against the identical snapshot more than once.

Normalize results by canonical node ID and compare:

- Result states.
- Applied rules.
- Rule versions.
- Confidence values.
- Assumptions.
- Causal paths and edge IDs.
- Capping metadata.
- Convergence.
- Iteration behavior where deterministic and meaningful.

The logical output must be identical.

Use deterministic analysis-run and test-edge identities. Do not compare unstable timestamps or unrelated generated metadata.

### Test E — Causal evidence integrity

For every propagated result, assert:

- A valid structured causal step exists.
- The referenced edge ID exists in the simulation snapshot.
- The edge connects the expected caller and callee.
- The rule ID is canonical.
- The rule version is present.
- `previousState` and `resultingState` are valid canonical states.
- Confidence is in the valid range.
- Assumptions are preserved.
- The path begins with the expected seed transition.

Do not infer a causal edge from a node pair if no explicit edge exists.

---

## 7. Strict scope boundaries

This step validates the existing deterministic simulation architecture.

Do not:

- Reimplement Step 53 rules.
- Reimplement Step 54 propagation.
- Change existing simulation semantics merely to satisfy the golden expectation.
- Convert `IMPORTS` edges into `CALLS`.
- Add speculative production `CALLS` extraction.
- Add synthetic nodes to the production graph.
- Add new API endpoints.
- Add database migrations or tables.
- Add a new worker or simulation execution system.
- Add an LLM or probabilistic scoring.
- Introduce live GitHub requests into tests.
- Execute any Taxonomy fixture code.
- Modify the pinned Taxonomy source files.
- Rewrite the existing golden PR manifest or Step 47 test suite.
- Perform unrelated refactoring.

If the golden fixture exposes a real limitation in the current graph extractor, document it honestly. Do not conceal it by changing graph semantics in this validation step.

If a reproducible bug in the existing simulation engine blocks validation, isolate the smallest justified correction, add a regression test, and explain the change separately in the final report.

---

## 8. Documentation deliverables

Complete the following documentation using actual implementation and test results.

### A. Implementation report

Create:

```text
learning/implementations/phase-08/step-58-golden-fixture-simulation-validation.md
```

Document:

- Objective and roadmap relationship.
- Fixture identity and integrity.
- Actual Taxonomy graph projection.
- Scenario design and source evidence.
- The distinction between production graph edges and test-only simulation relationships.
- Exact expected and actual propagation.
- Causal evidence verification.
- Negative controls.
- Determinism verification.
- Full verification matrix.
- Limitations and follow-up opportunities.

### B. Technical learning note

Create:

```text
learning/notes/57. Golden Fixture Simulation Validation.md
```

Explain:

- Golden-fixture validation principles.
- Why real fixtures are stronger than synthetic-only tests.
- Why pinned snapshots and offline integrity matter.
- Graph projection versus simulation graph inputs.
- The semantic difference between imports and calls.
- How test-only, source-verified relationships can validate an engine without misrepresenting production extraction.
- Deterministic worklist propagation.
- Causal-path and evidence validation.
- Negative controls.
- Expected-versus-actual comparison.
- Testing trade-offs and limitations.

### C. Interview guide

Create:

```text
learning/interviews/58. Step 58 Golden Fixture Simulation Validation Interview CheatSheet.md
```

Include practical senior/staff-level questions covering:

- Golden fixtures and immutable source snapshots.
- Hand-verified ground truth.
- Deterministic graph and simulation validation.
- Negative controls.
- Why imports cannot be treated as calls.
- Test-only relationship provenance.
- Causal evidence.
- Reproducibility.
- Limitations and trade-offs.

### D. Decision record

Inspect the existing ADR sequence.

The current decision log contains ADR-011. Where the implementation confirms the test-only relationship approach, add:

```text
learning/decisions/adr-012-golden-simulation-fixture-edge-provenance.md
```

Record the decision to keep manually verified simulation-only edges separate from canonical production graph projection when the latter lacks the semantic relationship.

Explain alternatives:

- Treat imports as calls.
- Modify production extraction during fixture validation.
- Validate only seed failure with no propagation.
- Use an explicitly source-verified simulation-only relationship.

Update:

```text
docs/architecture/18-decision-log.md
```

Do not invent an ADR if the actual implementation takes a different justified approach.

### E. Living architecture and indexes

Update `docs/DESIGN.md` with the verified Step 58 implementation state.

Update `learning/README.md` to include the new Phase 8 learning note and implementation report where appropriate.

Update the roadmap only when the acceptance criteria are genuinely satisfied.

Ensure all documentation links and filenames match the repository conventions.

---

## 9. Verification

Inspect package scripts before running commands.

Run focused checks:

```powershell
pnpm --filter @fluxora/workers test src/fixtures/golden.test.ts

pnpm --filter @fluxora/workers test src/pipeline/golden-simulation.test.ts
```

Then run the relevant package and workspace checks:

```powershell
pnpm --filter @fluxora/workers typecheck

pnpm typecheck

pnpm lint

pnpm lint:evidence

pnpm test

pnpm build

git diff --check
```

If full workspace tests or build require unavailable services, report the actual blocker and distinguish skipped tests from passed tests.

Do not claim that a test passed when it was skipped.

Record exact:

- Test file counts.
- Passed tests.
- Failed tests.
- Skipped tests.
- Exit codes.
- Commands actually executed.

Do not reuse stale verification counts from Step 47 or earlier steps.

---

## 10. Git and change management

- Preserve all uncommitted user changes.
- Do not stage unrelated files.
- Do not commit or push.
- Do not reset or clean the working tree.
- Review the final diff and new files.
- Keep the implementation tightly scoped to fixture contracts, loader, focused validation, and documentation.

---

## 11. Final implementation report

Return:

1. Fixture identity and integrity verification.
2. Actual graph projection counts and edge types.
3. The manually verified source relationship and its exact location.
4. Whether a production `CALLS` edge existed.
5. Whether a test-only relationship was required.
6. Explanation of why `IMPORTS` was not treated as `CALLS`.
7. Scenario definition and exact expected-versus-actual node results.
8. Causal-path, rule, confidence, and assumption verification.
9. Negative-control results.
10. Determinism results.
11. All files created and modified.
12. ADR and architecture documentation changes.
13. Exact validation commands and results.
14. Remaining limitations.
15. Suggested commit message, without committing.

Use one of these verdicts:

- `GOLDEN VALIDATION PASSED`
- `GOLDEN VALIDATION INCOMPLETE`
- `BLOCKED BY ENVIRONMENT`

**Begin with repository inspection. Implement the smallest deterministic golden-fixture validation that proves the existing simulation engine's behavior without fabricating production graph relationships.**