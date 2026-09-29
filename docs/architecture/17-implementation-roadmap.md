# 17. Detailed Implementation Roadmap

Broken into phases; each phase's features are further broken into small, sequential engineering steps sized for implementation with an AI pair-programmer (Claude Code / Cursor) — each step should be completable and reviewable independently.

---

## Phase 0 — Architecture (this package)

**Goal:** Lock the design before writing product code.
**Acceptance criteria:** This document set exists, reviewed, and treated as the reference for all following phases.
**Demo outcome:** N/A (planning phase).

---

## Phase 1 — Foundation

**Goal:** A deployable skeleton: auth, tenancy, empty data model, CI/CD, observability wired up — nothing product-specific yet.

**Steps:**
1. Scaffold monorepo (`apps/api`, `apps/web`, `apps/workers`, `packages/shared-types`, `packages/db`).
2. Set up Postgres + migration tooling; implement `Organization`, `User` tables + RLS policies.
3. Integrate auth provider (GitHub OAuth login), issue JWTs, implement session middleware.
4. Scaffold Next.js app with the auth flow (`/`, `/login`, empty org dashboard).
5. Set up Redis, object storage (S3/minio), and the secrets-manager client abstraction.
6. Implement the Postgres-backed job queue table + a minimal worker harness (`claim job`, `mark complete/failed`, idempotency-key enforcement).
7. Wire up OpenTelemetry (traces/metrics/logs) end to end for one dummy endpoint, confirm data reaches the observability backend.
8. Set up CI (lint, typecheck, unit test) and CD to a preview environment per PR.
9. Write the local-dev `docker-compose` + seed script skeleton.

**Database changes:** `Organization`, `User`, `audit_log`, `jobs` tables.
**Testing:** Unit tests for auth middleware and RLS policies (cross-tenant read attempt returns empty). Integration test for job claim/complete/idempotency.
**Security:** RLS enabled from the first migration; secrets never in env files committed to the repo.
**Acceptance criteria:** A user can log in via GitHub, see an empty dashboard, and the whole stack deploys through CI/CD to a preview environment automatically.
**Demo outcome:** "Here's the skeleton — auth works, multi-tenant from day one, full CI/CD pipeline live."
**Dependencies:** none.
**Risks:** Over-building foundation before product validation. *Mitigation:* strict scope — no product features in this phase, timebox it.

---

## Phase 2 — Repository ingestion

**Goal:** Connect a real GitHub repo and pull down an immutable snapshot.

**Steps:**
1. Register a GitHub App (dev credentials), implement the App installation flow in the frontend.
2. Implement `Repository`, `RepositorySnapshot`, `Commit` tables.
3. Implement the Ingestion Worker: given a repo + ref, fetch content via GitHub API (or git clone via the App's installation token), extract to a working directory.
4. Implement snapshot packaging + upload to S3, with size/time limits enforced (`11-security-architecture.md §11.10`).
5. Implement `POST /api/v1/repositories/connect` → enqueue `repository.ingest` job.
6. Implement the `repository.indexed` event + WS push to the frontend showing ingestion progress.
7. Handle failure paths: revoked access, oversized repo, GitHub rate limiting (backoff, not failure).
8. Record the first golden-fixture repository (a real, moderate-complexity open-source Next.js/TS repo) for use in later phases' tests.

**Database changes:** `Repository`, `RepositorySnapshot`, `Commit`.
**Frontend work:** Connect-repo flow, ingestion-progress UI.
**Testing:** Integration tests against recorded GitHub API fixtures; failure-path tests (revoked token, oversized repo).
**Security:** Sandboxed extraction (path-traversal/zip-bomb protections, `§11.10`); encrypted credential storage.
**Acceptance criteria:** A real repository can be connected and its content lands in object storage as an immutable, checksum-verified snapshot, with the user seeing live progress.
**Demo outcome:** "Watch a real repo get connected and ingested end to end."
**Dependencies:** Phase 1.
**Risks:** GitHub API rate limits during development/demo. *Mitigation:* recorded fixtures for automated tests, real calls reserved for manual demo runs.

---

## Phase 3 — Code intelligence

**Goal:** Turn a snapshot into extracted symbols and candidate dependency edges.

**Steps:**
1. Implement language/framework detection (`§5.2`).
2. Integrate ts-morph / TypeScript Compiler API; implement per-file symbol extraction (functions, classes, exports).
3. Implement import/export graph extraction, including path-alias resolution via `tsconfig.json`.
4. Implement Next.js API-route detection (file-based routing pattern matching) and Express-router detection.
5. Implement event producer/consumer pattern detection (common pub/sub client call shapes) — start with a small, explicit pattern library, expand iteratively.
6. Implement DB-reference detection (common ORM call shapes) — same iterative-pattern-library approach.
7. Implement the tree-sitter fallback pass for files the compiler-based pass can't handle.
8. Implement the Normalizer (barrel-file resolution, symbol dedup).
9. Run the full pipeline against the golden-fixture repo from Phase 2; hand-verify a sample of extracted symbols/edges against the actual source.

**Database changes:** `File`, `Symbol`, `AnalysisRun`.
**Testing:** The fixture-based unit test suite (`12-testing-strategy.md §12.1`) built out here, alongside this phase's implementation — not after.
**Acceptance criteria:** Given the golden-fixture repo, the extracted symbol/import data matches hand-verified expectations for a representative sample of files.
**Demo outcome:** "Here's the raw extracted symbol data for a real repo — before it's even a graph yet."
**Dependencies:** Phase 2.
**Risks:** Real-world TS/JS syntax diversity (monorepos, decorators, complex generics) breaking naive parsing. *Mitigation:* the fixture library is explicitly built to include hard cases early, not discovered late.

---

## Phase 4 — Graph

**Goal:** Persist the extracted data as a queryable, typed graph with evidence.

**Steps:**
1. Implement `GraphNode`, `GraphEdge`, `Evidence` tables with indexes (`06-database-schema.md §6.2–6.3`).
2. Implement the Graph Builder: normalized edges → persisted graph, scoped to an `AnalysisRun`, transactional (`§5.7`).
3. Implement the Evidence Writer, wired into every graph-write path; add the CI lint check enforcing every write path produces evidence (`12-testing-strategy.md §12.1`).
4. Implement bounded-depth recursive-CTE graph traversal as a reusable internal query function.
5. Implement `POST /api/v1/graph/query` (`07-api-architecture.md §7.2`).
6. Implement `graph.updated` event + diff summary computation (node/edge delta vs. previous run).
7. Re-run against the golden-fixture repo; hand-verify graph shape for a subset of known relationships.

**Database changes:** `GraphNode`, `GraphEdge`, `Evidence`.
**Testing:** Graph-traversal unit tests (synthetic graphs, cycles, depth limits — `§12.1`); evidence-coverage lint check.
**Acceptance criteria:** The golden-fixture repo produces a graph that a human familiar with the repo agrees is "basically right" for direct relationships (per the product-scope success criterion).
**Demo outcome:** Raw graph query results (JSON) for a real repo — still pre-UI, but the deterministic core is now functionally complete.
**Dependencies:** Phase 3.
**Risks:** Graph explosion on large repos slowing traversal. *Mitigation:* depth caps and indexing validated against a deliberately large fixture, not just small demo repos.

---

## Phase 5 — Architecture UI

**Goal:** The Architecture Explorer — the flagship visual screen.

**Steps:**
1. Integrate react-flow; implement `GraphCanvas`, per-node-type `NodeRenderer`.
2. Implement `/repositories/[repoId]/explorer` route, fetching via `POST /graph/query`.
3. Implement `NodeInspectorPanel` (evidence, dependencies, consumers) and `EvidenceTrail` shared component.
4. Implement `GraphFilters` (node-type, edge-type, confidence filters).
5. Implement clustering/level-of-detail for large graphs (`10-frontend-architecture.md §10.4`).
6. Wire up WS live updates (`graph.updated` → cache invalidation → re-render).
7. Polish: loading states, empty states, error states for partial/failed analysis.

**Frontend work:** the bulk of this phase.
**Testing:** Component tests for graph rendering with fixture data; E2E test (connect repo → see graph render with expected node count).
**Acceptance criteria:** A user can visually explore the real dependency graph of a connected repository, inspect any node, and see its evidence.
**Demo outcome:** "Here's the live, interactive architecture map of a real codebase." — first genuinely demo-able milestone.
**Dependencies:** Phase 4.
**Risks:** Graph layout readability at scale. *Mitigation:* clustering built and tested against the large synthetic fixture (`14-local-development.md §14.3`), not deferred until it's a production problem.

---

## Phase 6 — PR impact analysis

**Goal:** Blast-radius computation for a real pull request.

**Steps:**
1. Implement GitHub webhook handling for `pull_request.opened/synchronize`.
2. Implement `PullRequest` table + changed-file/diff storage.
3. Implement the Impact Analysis Engine (`§5.9`): changed files → changed symbols → bounded traversal → direct/downstream/affected-APIs/affected-events output.
4. Implement `ImpactAnalysis` persistence + evidence linking.
5. Implement `POST /pull-requests/:id/analyze-impact` and `GET /impact-analyses/:id`.
6. Implement change-mode overlay in the frontend (highlight changed/affected nodes on the existing GraphCanvas).
7. Test against a real PR from the golden-fixture repo with hand-verified expected impact.

**Database changes:** `PullRequest`, `ImpactAnalysis`.
**Testing:** Golden-fixture PR test (`12-testing-strategy.md §12.4`) — the core acceptance test for this phase.
**Acceptance criteria:** Given a real PR, Fluxora's direct + one-hop downstream impact matches what an experienced maintainer of that repo would identify.
**Demo outcome:** "Here's a real PR, and here's exactly what it will affect, visualized." — the product's core value proposition, now demo-able without AI narration yet.
**Dependencies:** Phase 5.
**Risks:** False negatives (missed real dependencies) undermining trust. *Mitigation:* the golden-fixture PR test set is the primary defense; expand it before claiming this phase "done."

---

## Phase 7 — Evidence engine (hardening pass)

**Goal:** The evidence layer, already present since Phase 4, gets a dedicated hardening pass — this phase exists to explicitly stress-test the trust mechanism rather than assume it's solid because it "exists."

**Steps:**
1. Audit every conclusion-producing code path (graph edges, impact findings) for evidence completeness; close any gaps found.
2. Implement the clickable evidence-citation UI end-to-end (`EvidenceCitation` component jumping from a claim to the exact graph node + underlying file/line).
3. Add confidence-based visual weighting throughout the UI (low-confidence edges rendered distinctly, per Principle P3).
4. Add an "analysis coverage" view — what fraction of files parsed successfully, what was skipped and why (`§6.3 AnalysisRun.coverage_summary`), surfaced in the product, not just internal logs.

**Testing:** The evidence-coverage lint check (Phase 4) becomes a hard CI gate; add tests specifically asserting confidence propagates correctly through traversal (a 3-hop finding should show meaningfully lower confidence than a 1-hop finding).
**Acceptance criteria:** Every user-facing claim in the Architecture Explorer and Impact Report is clickable through to concrete evidence; analysis coverage/gaps are visible, not hidden.
**Demo outcome:** "Click any claim — here's exactly why Fluxora believes it." This phase is what separates Fluxora from "a chatbot attached to GitHub" (per the product thesis).
**Dependencies:** Phase 6.
**Risks:** Low — mostly a polish/rigor pass on existing infrastructure.

---

## Phase 8 — Simulation

**Goal:** Rule-based scenario propagation.

**Steps:**
1. Implement `Scenario`, `Simulation`, `SimulationResult` tables.
2. Design and implement the initial rule table (infra-unavailable and latency-degradation rules only, per MVP scope — `02-product-scope.md`).
3. Implement the Simulation Engine (`§5.10`, propagation loop with convergence check, `04-system-architecture-diagrams.md §4.7`).
4. Implement `POST /scenarios`, `POST /scenarios/:id/run`, `GET /simulations/:id`.
5. Implement simulation-mode overlay in the frontend (state-colored graph, assumptions panel).
6. Rule-table unit tests (`12-testing-strategy.md §12.1`) — build alongside the rule table, not after.
7. Validate against the golden-fixture repo with a hand-designed scenario and manually sanity-checked expected propagation.

**Database changes:** `Scenario`, `Simulation`, `SimulationResult`.
**Testing:** Rule-isolation tests + full-scenario tests against synthetic and golden-fixture graphs.
**Acceptance criteria:** A rule-based scenario produces internally consistent propagation matching the rule table's logic, with every state change linked to evidence (which edge/rule caused it).
**Demo outcome:** "What happens if the payments API goes down?" — animated propagation across the real graph.
**Dependencies:** Phase 7 (relies on mature evidence infrastructure).
**Risks:** Rule table oversimplifying real failure dynamics. *Mitigation:* rules explicitly surface their assumptions (`§5.10`) rather than presenting output as certain — this is a feature of the design, not a gap to hide.

---

## Phase 9 — AI reasoning

**Goal:** Ground the deterministic outputs in natural-language explanation.

**Steps:**
1. Implement the Model Gateway (`§9.2`) with Claude integration, retry/fallback logic, cost/latency logging.
2. Implement the Context Assembler (`§9.4`) for the impact-explanation task type first (narrowest, highest-value scope).
3. Implement structured-output schemas + the Validator (`§9.6`), including the grounding check against the evidence-id manifest.
4. Wire impact-analysis completion → AI explanation generation → `AIExplanationPanel` in the UI.
5. Repeat 2–4 for simulation narration.
6. Implement the tool-calling free-form chat interface (`§9.5`) with the `query_graph`/`get_evidence`/`run_simulation` tool set.
7. Build the initial AI evaluation suite (`12-testing-strategy.md §12.5`) against the golden-fixture repo's impact analyses, establish baseline groundedness/hallucination-rate metrics.
8. Implement the deterministic-fallback explanation path for when AI generation fails validation after retries.

**Database changes:** `AIAnalysis`.
**AI work:** the bulk of this phase — prompt template design per task type, schema design, eval-suite construction.
**Testing:** AI eval suite as the primary acceptance gate for this phase, not just unit tests.
**Security:** Prompt-injection mitigations (`11-security-architecture.md §11.9`) implemented and specifically tested (adversarial fixture: a repo with injection-attempt content in a comment/README, assert the AI layer's factual claims are unaffected).
**Acceptance criteria:** AI explanations for the golden-fixture repo's impact analyses pass the groundedness/hallucination-rate eval thresholds (`12-testing-strategy.md §12.5`); an adversarial prompt-injection fixture does not alter factual output.
**Demo outcome:** The full MVP loop, narrated: "Here's what this PR affects, and here's why, in plain English, with every claim clickable to evidence." **This is the MVP-complete milestone.**
**Dependencies:** Phase 8 (needs both impact and simulation results to narrate).
**Risks:** This is the highest-risk phase for the product's core trust proposition. *Mitigation:* the entire architecture (P1, P2, §9.4, §9.6) exists specifically to de-risk this phase — treat any eval-suite regression here as a release blocker, not a nice-to-fix.

---

## Phase 10 — Runtime telemetry (post-MVP)

**Goal:** Connect real observability data to ground/enrich the static graph.

**Steps (high-level, this phase is intentionally less granular since it follows MVP validation):**
1. Implement `TelemetrySource`, `Observation` tables.
2. Build an OpenTelemetry-compatible ingestion endpoint; map incoming trace/metric data to existing `GraphNode`s where identifiable (service-name matching, with confidence, since this mapping is itself imperfect and should be evidence-tagged like everything else).
3. Use runtime-observed call data to *upgrade* the confidence of statically-inferred edges (an edge seen both in static analysis and in real traffic gets `provenance: runtime-observed` and higher confidence) and to *surface* dynamically-only-discoverable edges static analysis missed (flagged distinctly, since they weren't code-verified).
4. Feed real latency/error-rate data into the Simulation Engine's rule table as optional overrides to the static assumptions (e.g., "this call has historically had a circuit breaker trip N times" informs the propagation rule more accurately than the static "no fallback detected" default).

**Acceptance criteria:** Connecting a real OTel-instrumented service measurably improves graph confidence and simulation realism versus static-only analysis, without ever making telemetry a silent source of *new unverified* claims — it's additive evidence, following Principle P2/P3 exactly like every other evidence source.
**Dependencies:** Phase 9 (MVP complete).
**Risks:** Telemetry data volume/cost; service-name-to-node mapping ambiguity. *Mitigation:* confidence-scored mapping, human-correctable in the UI.

---

## Phase 11 — Production hardening

**Goal:** Everything needed to run this for real, multi-tenant customers at meaningful scale.

**Steps:**
1. Load-test the analysis pipeline against large real-world repositories (not just the golden fixtures); tune worker sizing and depth/size caps against real data.
2. Implement the incremental-analysis optimization (`16-cost-model.md §16.3`).
3. Implement read-replica routing for graph-query traffic (`15-scaling-strategy.md §15.2`).
4. Full security review pass against `11-security-architecture.md` as a checklist; penetration-test the sandboxed analysis execution path specifically.
5. Build out cost dashboards (`16-cost-model.md §16.6`) and per-organization rate limiting enforcement.
6. Formalize on-call/alerting thresholds from the observability metrics already being collected since Phase 1.
7. Disaster-recovery drill: restore from backup, replay job queue from outbox, verify data consistency.

**Acceptance criteria:** The system survives a load test at ~10x the expected initial customer volume without correctness regressions; security checklist fully passed; DR drill succeeds within target RTO/RPO.
**Dependencies:** Phase 10 (or can run partially in parallel with it).
**Risks:** Standard production-readiness risks; mitigated by treating this as a dedicated phase with explicit acceptance criteria rather than "hardening as we go."

---

## Phase 12 — Portfolio/demo polish

**Goal:** Package the MVP (Phases 1–9, plus whichever of 10/11 are relevant) as a compelling portfolio artifact.

**Steps:**
1. Select and polish 2–3 real, recognizable open-source repositories as permanent demo fixtures (more impressive than a toy example — see `21-demo-script.md`).
2. Record the demo script (`21-demo-script.md`) as both a live-demo runbook and a backup screen-recording.
3. Write the case-study narrative: the problem, the architecture decisions and *why* (especially the deterministic-core/AI-edge separation — this is the single most interview-worthy decision in the whole system), what was hard, what you'd do differently at scale.
4. Clean up the public repo: README, architecture diagrams (reuse this package's Mermaid diagrams), a "how to run it locally" guide (`14-local-development.md`) that actually works for a stranger.
5. Prepare answers to the senior interview question set (`20-interview-questions.md`) — not memorized, but genuinely understood, since you built the reasoning behind each decision.

**Acceptance criteria:** `22-definition-of-done.md` fully satisfied.
**Demo outcome:** The `21-demo-script.md` runs cleanly, live, in front of an interviewer.
**Dependencies:** Phase 9 minimum; 10/11 strengthen the story but aren't required for a compelling demo.
