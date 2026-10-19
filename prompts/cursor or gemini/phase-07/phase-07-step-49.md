You are implementing Fluxora Phase 7, Step 49 only.

STEP 49: CLICKABLE EVIDENCE CITATION UI

Goal:
Turn the evidence already produced by Fluxora into a real, clickable EvidenceCitation experience in the frontend, end-to-end.

This step is about traceability:
a user should be able to see that a graph/impact conclusion has evidence and click that evidence to inspect the exact provenance.

IMPORTANT:
- Inspect the current repository implementation before changing anything.
- Reuse the existing Fluxora architecture, terminology, components, types, API patterns, auth model, and styling.
- Do NOT redesign the application.
- Do NOT introduce new AI reasoning.
- Do NOT implement Step 50 confidence-based visual weighting.
- Do NOT implement Step 51 analysis-coverage UI.
- Do NOT modify simulation functionality.
- Do NOT bypass the existing API layer with direct database access from the frontend.
- Do NOT fabricate evidence, source locations, line numbers, commits, or GitHub URLs.
- Preserve the existing Step 48 evidence invariants.

==================================================
1. FIRST: INSPECT CURRENT IMPLEMENTATION
==================================================

Read the relevant existing implementation before coding, especially:

- existing graph explorer UI
- GraphCanvas
- NodeRenderer
- NodeInspectorPanel
- EvidenceTrail / existing evidence-related UI
- graph query response types
- impact-analysis response types
- graph edge/node evidence fields
- ImpactFinding evidenceIds
- EvidenceWriter/evidence schema only to understand the contract
- existing repository/GitHub metadata available to the frontend
- existing routing/data-fetching/error/loading conventions
- tests for graph explorer and impact analysis UI

Determine exactly:
1. where evidence IDs/records are currently returned,
2. whether evidence metadata is already available in the API response,
3. whether an existing evidence endpoint already exists,
4. how repository + commit/ref information is represented,
5. how file paths and line ranges are represented,
6. how the current EvidenceTrail renders evidence.

Do not assume missing APIs or types exist.

==================================================
2. SCOPE OF STEP 49
==================================================

Implement a reusable frontend EvidenceCitation capability that can be used wherever Fluxora presents a conclusion backed by evidence.

At minimum, support evidence citations for:

A. Graph edge evidence
B. Graph node evidence when node provenance is available
C. Impact-analysis findings
D. EvidenceTrail / NodeInspectorPanel

The user must be able to:

CONCLUSION
  ↓
EvidenceCitation
  ↓
Evidence details
  ↓
Source location / provenance target

The citation must expose enough information for the user to understand:
- what was concluded,
- where the evidence came from,
- what file is involved,
- what line range is involved when available,
- what relationship/finding the evidence supports,
- which analysis run produced it,
- confidence when already supplied by the existing API,
- and how to navigate to the underlying source.

Do not add new confidence semantics in this step.

==================================================
3. EVIDENCECITATION COMPONENT
==================================================

Create or refactor a reusable component following the existing frontend component conventions.

Suggested conceptual shape:

EvidenceCitation
- compact citation mode for inline use
- expanded/detail mode for EvidenceTrail or inspector
- accessible button/link semantics
- loading/error/ unavailable states where necessary

The component should NOT invent fields.

Use the actual backend evidence contract already present in Fluxora.

Display useful provenance such as:

- source file path
- line range:
  - "L10-L18"
  - or "L10"
  - only when real line metadata exists
- symbol, when available
- relationship description
- analysis run
- confidence, only where already returned
- evidence status/source availability

Do not render fake values such as:
"unknown line 0"
"confidence 100%"
"main branch"
"latest commit"

unless the backend actually supplies them.

==================================================
4. CLICK BEHAVIOR
==================================================

EvidenceCitation must be genuinely clickable.

Preferred behavior:

If the system has enough trusted repository/ref/source metadata to construct a stable source permalink:
- navigate to the exact source location,
- preserve file path,
- preserve line/range where possible,
- prefer an immutable commit SHA/ref over a mutable branch,
- use the existing repository/GitHub URL conventions.

If the current application already has an in-app source viewer or source route:
- use that instead of inventing another source system.

If the available evidence does NOT contain enough information to safely construct a source permalink:
- keep the citation visible,
- open the evidence detail UI instead,
- clearly show why direct source navigation is unavailable,
- never fabricate a URL.

Do not expose credentials, tokens, signed URLs, internal database identifiers that are not already intended for the UI, or secret environment values.

Use normal external-link semantics for true external source links:
- accessible label
- keyboard support
- visible focus state
- correct target behavior
- no unsafe string-based URL construction

==================================================
5. EVIDENCE DETAIL EXPERIENCE
==================================================

When a user clicks an evidence citation, provide a useful evidence-detail experience consistent with the existing UI.

The detail view should clearly establish:

"Why is this conclusion being shown?"

Example conceptual structure:

Evidence
  Source: src/foo/bar.ts
  Lines: 42–48
  Symbol: someFunction
  Relationship: IMPORTS
  Analysis run: ...
  Confidence: ...        <- only if already available
  [Open source]

For impact findings, clearly distinguish:
- direct impact
- downstream impact
- affected API
- affected event
- affected service

Use the actual existing finding/evidence model rather than adding a parallel model.

If one finding has multiple evidence citations:
- render all unique citations,
- preserve deterministic ordering,
- do not duplicate identical evidence entries.

==================================================
6. INTEGRATE INTO EXISTING UI
==================================================

Integrate EvidenceCitation into the existing Step 46/previous UI instead of creating disconnected UI.

At minimum review and update:

- NodeInspectorPanel
- EvidenceTrail
- graph edge/finding presentation
- impact-analysis change mode
- any existing impact finding detail component

Expected UX:

Graph:
  select node/edge
      ↓
  inspector
      ↓
  conclusion/finding
      ↓
  EvidenceCitation
      ↓
  evidence detail/source

Impact mode:
  select finding
      ↓
  direct/downstream/API/event finding
      ↓
  EvidenceCitation
      ↓
  evidence detail/source

Do not alter the meaning of the existing change-mode states.

Preserve:
- OFF
- loading
- ready
- empty
- error
- stale
- truncated

Step 49 adds traceability to those existing views; it must not change their semantics.

==================================================
7. API / DATA FETCHING
==================================================

Use the existing frontend data-access architecture.

If an existing API already returns complete evidence metadata:
- consume it directly.

If evidence IDs are returned but the UI currently lacks the required evidence metadata:
- inspect whether a minimal existing backend read path already exists.
- Reuse it.

Only add a small read-only API surface if it is genuinely required for Step 49 and does not already exist.

Any new API must:
- use existing auth middleware,
- derive tenant/org from authenticated context,
- enforce tenant isolation,
- never accept client-supplied organization ownership as authority,
- use the existing REST conventions,
- return stable errors,
- never expose unrelated tenants' evidence,
- never recompute analysis,
- never mutate evidence.

Do NOT create a new evidence-writing path.

==================================================
8. SECURITY + DATA INTEGRITY
==================================================

Preserve Step 48 guarantees.

The UI must treat evidence as provenance, not as user-generated content.

Requirements:
- never fabricate source paths
- never fabricate line ranges
- never fabricate commit SHAs
- never derive authorization from client-provided org/repository IDs
- never allow arbitrary external URLs from untrusted evidence fields
- sanitize/validate any constructed source URL according to the application's existing rules
- do not leak private implementation metadata
- evidence belonging to another tenant must never be rendered

Evidence remains append-only and backend-owned.

Frontend must not mutate evidence.

==================================================
9. UX STATES
==================================================

EvidenceCitation must handle:

1. evidence exists and source is available
2. evidence exists but line range is unavailable
3. evidence exists but direct source URL cannot be generated
4. multiple evidence entries
5. duplicate evidence IDs
6. loading evidence metadata
7. evidence fetch failure
8. stale/old analysis
9. truncated impact result

Do not hide an otherwise valid conclusion merely because direct source navigation is unavailable.

The UX should communicate:
- "evidence available"
versus
- "source navigation unavailable"

rather than pretending the source exists.

==================================================
10. ACCESSIBILITY
==================================================

Make the interaction production-quality:

- keyboard accessible
- semantic button/link
- visible focus state
- useful aria-labels
- tooltips only as enhancement, not the only source of information
- do not rely on color alone
- meaningful screen-reader text
- external links clearly indicated where appropriate

Do not make the entire graph node clickable merely to satisfy this requirement; the citation itself should be actionable.

==================================================
11. TESTING
==================================================

Add focused tests for Step 49.

At minimum test:

A. EvidenceCitation
- renders file path
- renders line range when present
- does not render fabricated line data when absent
- renders symbol when supplied
- renders relationship
- supports keyboard interaction
- opens correct source target when a valid source URL/ref exists
- gracefully handles unavailable source navigation

B. Multiple evidence
- duplicate evidence IDs are deduplicated
- deterministic ordering is preserved

C. Inspector integration
- graph evidence appears in EvidenceTrail / inspector
- clicking citation opens the expected evidence/source experience

D. Impact integration
- impact finding evidence appears
- direct/downstream/API/event findings retain their evidence
- clicking a finding's evidence works

E. Failure states
- evidence loading
- evidence fetch failure
- missing source location
- stale/truncated result

F. Security/data handling
- no arbitrary unsafe URL is accepted
- tenant-sensitive data is not surfaced by fallback logic

Use the repository's existing testing stack and conventions.

Do not weaken existing tests.

==================================================
12. DOCUMENTATION / LEARNING ARTIFACTS
==================================================

Preserve the exact Fluxora learning pattern used in previous steps.

Create:

learning/implementations/phase-07/step-49-evidence-citation-ui.md

learning/notes/49. Evidence Citation UI.md

learning/interviews/49. Step 49 Evidence Citation UI Interview CheatSheet.md

Update:

docs/DESIGN.md

Documentation must explain, in the same terminology/style/detail level as previous learning artifacts:

- what Step 49 implements
- why clickable evidence matters
- EvidenceCitation architecture
- data flow from conclusion → evidence → source
- graph evidence path
- impact evidence path
- API boundary, if changed
- source-link construction rules
- immutable vs mutable source references
- security considerations
- accessibility considerations
- failure states
- deterministic rendering/deduplication
- what Step 49 does NOT implement
- interview questions and senior-level reasoning

Explicitly distinguish:
Step 48 = evidence completeness guarantees
Step 49 = evidence citation UX/navigation
Step 50 = confidence-based visual weighting
Step 51 = coverage view

Do not document future steps as implemented.

==================================================
13. DESIGN.MD
==================================================

Update docs/DESIGN.md with the actual implemented Step 49 architecture.

Document only what exists in code.

Include:
- EvidenceCitation component responsibility
- evidence data flow
- source navigation behavior
- UI integration points
- API dependency, if any
- security/invariants
- limitations

Do not rewrite unrelated architecture sections.

==================================================
14. STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- Step 50 confidence-based visual weighting
- Step 51 evidence coverage dashboard/view
- runtime telemetry
- simulation
- AI reasoning
- new graph semantics
- new impact-analysis semantics
- evidence writing changes unless strictly necessary for an existing read contract bug
- unrelated UI redesign
- new authentication flow
- new GitHub installation logic

Do not change backend analysis behavior.

==================================================
15. VERIFICATION
==================================================

Run the smallest focused checks first, then the normal repository gates.

At minimum:

- relevant frontend tests for EvidenceCitation
- relevant graph explorer tests
- relevant impact-analysis/change-mode tests
- pnpm typecheck
- pnpm lint
- pnpm lint:evidence
- pnpm build
- pnpm test
- git diff --check

If a command cannot run because of an environment prerequisite, report the exact reason rather than claiming success.

Review the final diff for:
- only Step 49-related code/docs
- no accidental generated files
- no secrets
- no node_modules
- no unrelated refactors

==================================================
16. FINAL REPORT
==================================================

After implementation, report:

1. Step 49 status
2. exact files changed
3. new files created
4. API changes, if any
5. EvidenceCitation behavior
6. source navigation behavior
7. tests run + exact results
8. typecheck/lint/build results
9. git diff --check result
10. any limitations
11. explicit confirmation that Step 50/51 were not implemented

Do NOT commit or push unless explicitly requested.