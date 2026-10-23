# Fluxora Global Step 56 — Simulation Studio UI

## Role
Act as a senior full-stack engineer building Fluxora, an AI-powered repository intelligence and failure-simulation platform.

## Objective
Implement a production-quality **Simulation Studio UI** on top of Steps 53–55. An authenticated user must be able to create a failure scenario, run it against a real analysis graph, inspect affected nodes, and understand the causal paths behind the results.

This is an implementation task, not a static mockup.

## 1. Inspect before coding
First inspect:
- The current Git status and diff. Preserve all existing uncommitted changes.
- `apps/web` routing, dashboard layout, design system, UI components, API client, and Clerk authentication.
- `packages/shared-types/src/simulation.ts`.
- Step 55 API handlers, request/response contracts, and relevant repository/graph APIs.
- `docs/DESIGN.md` and existing Step 55 documentation.

Discover the actual repository, analysis-run, and graph-node data sources. Reuse existing architecture and dependencies. Do not assume file paths, response shapes, or API URLs without checking them.

## 2. Build the Simulation Studio
Add the page under the existing authenticated application layout, choosing a route consistent with current conventions.

Implement:
- Repository selection using real accessible repositories.
- Analysis-run selection using valid data for the selected repository.
- Target-node selection from the selected analysis graph.
- Scenario name and supported failure type selection.
- Scenario creation and a separate **Run Simulation** action.
- Simulation execution status and impact summary.
- An affected-node table with useful sorting or filtering.
- A causal-path inspector showing state transitions, rule IDs, edge IDs, assumptions, confidence, and capped propagation where available.
- A details section displaying analysis-run identity, rule-table version, and limitations where provided.

Changing the repository or analysis run must invalidate incompatible selections. Show clear loading, validation, empty, and error states.

Use the current contracts and shared types. Do not invent repositories, nodes, API fields, results, or metrics.

## 3. Integrate the real APIs
Use the existing authenticated API client and Step 55 contracts:
- `POST /scenarios`
- `POST /scenarios/:id/run`
- `GET /simulations/:id`
- `GET /simulations/:id/results`

Follow the actual API base URL and authentication conventions. Do not hard-code localhost, bypass Clerk, trust client-supplied organization IDs for authorization, or expose secrets.

Handle authentication failures, not-found responses, validation errors, convergence failures, network failures, and server errors appropriately. Never display a failed request as a successful empty simulation.

## 4. Preserve simulation semantics
Reuse the Step 54 backend engine; do not reimplement propagation in the frontend.

Support only the established `unavailable` and `latency` failure types. Latency remains qualitative unless the existing engine explicitly provides numerical modeling.

Use actual result data for impact summaries. The simulation's confidence value is not automatically a real-world failure probability. Distinguish affected nodes from the rest of the graph, and never fabricate probabilities, downtime estimates, or progress percentages.

Make causal paths understandable, including seed steps with no edge ID. Display actual assumptions, rule versions, and capped-propagation metadata where available.

## 5. Engineering quality
Follow the existing Next.js, TypeScript, accessibility, and styling conventions. Build reusable components where useful without overengineering.

Add meaningful tests for:
- Form validation and dependent selections.
- Scenario creation and execution using the correct API contracts.
- Loading and duplicate-submission prevention.
- Rendering real results and causal paths.
- Empty results versus API failures.
- Authentication, validation, and server-error handling.

Update `docs/DESIGN.md` and create `learning/implementations/phase-08/step-56-simulation-studio-ui.md`. Add interview notes using the repository's existing naming convention.

## 6. Verification
Run the applicable existing commands for:
- Focused frontend tests.
- Web package typecheck, lint, and tests.
- Workspace typecheck, lint, tests, evidence lint, and build.
- `git diff --check`.

Inspect available package scripts before running commands. Fix regressions caused by your changes. Report any tests blocked by missing services or environment configuration honestly.

## Scope boundaries
Do not implement Steps 57 or 58. Do not add fake production data, unnecessary dependencies, new authentication architecture, speculative analytics, or unrelated refactors.

Do not commit or push. Preserve the existing working tree.

## Final report
Provide:
1. Architecture discovered and route selected.
2. Features implemented and files changed.
3. API contracts and authentication verified.
4. Actual verification commands and pass/fail/skip counts.
5. Remaining risks or environmental blockers.
6. Verdict: `READY FOR REVIEW`, `INCOMPLETE`, or `BLOCKED BY ENVIRONMENT`.
7. A suggested commit message, without creating the commit.

Begin by inspecting the current repository, then implement, test, document, and verify Step 56.