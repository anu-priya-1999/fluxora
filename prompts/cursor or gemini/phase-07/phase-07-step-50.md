You are implementing Fluxora Phase 7, Step 50 only.

STEP 50: CONFIDENCE-BASED VISUAL WEIGHTING

Goal:
Use the confidence values already produced by Fluxora's backend to visually communicate relative confidence in the existing graph and impact-analysis UI.

Step 48 = evidence completeness
Step 49 = clickable evidence/provenance
Step 50 = confidence-based visual weighting
Step 51 = evidence coverage

IMPORTANT:
- Inspect the actual current repository before changing anything.
- Start from the current Step 49 implementation AFTER its regression fix.
- Reuse existing types, API contracts, components, state, styles, and data flow.
- Do NOT redesign the application.
- Do NOT change backend confidence calculations.
- Do NOT introduce a new confidence algorithm.
- Do NOT duplicate backend traversal/depth-decay calculations in the frontend.
- Do NOT implement Step 51.
- Do NOT implement simulation, telemetry, or AI reasoning.
- Do NOT fabricate confidence values.

==================================================
1. FIRST: INSPECT THE CURRENT IMPLEMENTATION
==================================================

Read:

- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- packages/shared-types/src/graph.ts
- packages/shared-types/src/impact.ts
- apps/web/src/components/graph/GraphCanvas.tsx
- apps/web/src/components/graph/NodeRenderer.tsx
- apps/web/src/components/graph/node-inspector-data.ts
- apps/web/src/components/graph/EvidenceCitation.tsx
- apps/web/src/components/graph/evidence-citation-data.ts
- apps/web/src/components/graph/ChangeModeBar.tsx
- apps/web/src/components/graph/change-mode-data.ts
- apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx
- relevant graph/change-mode/evidence tests

Determine:
1. where authoritative confidence exists,
2. which graph entities carry confidence,
3. which impact findings carry confidence,
4. how Step 49 already displays confidence,
5. which component should own presentation normalization.

The backend/API is authoritative.

==================================================
2. CORE RULE
==================================================

Confidence is PRESENTATION information.

Do not change what Fluxora believes.

Backend:
    analysis
        ↓
    authoritative confidence
        ↓
Frontend:
    presentation normalization
        ↓
    visual weighting

Do NOT calculate confidence again in the browser.

Never implement:
    confidence = 0.9 ** depth

or any equivalent frontend formula.

==================================================
3. CONFIDENCE REPRESENTATION
==================================================

Create a small reusable frontend representation only if the repository does not already have one.

Conceptually:

NormalizedConfidence
- value
- percentage
- presentation band/label if needed

Requirements:
- preserve the original numeric confidence,
- deterministic mapping,
- monotonic visual meaning,
- missing confidence remains missing,
- no fabricated fallback.

Before choosing thresholds, inspect the existing architecture/code for confidence terminology.

If thresholds are not already defined, introduce the smallest presentation-only mapping and document the exact thresholds.

Do not silently invent complex scoring logic.

==================================================
4. GRAPH EDGE VISUAL WEIGHTING
==================================================

Apply confidence-aware visual weighting to graph edges that already have authoritative confidence.

Possible presentation signals:
- opacity
- stroke width
- subtle emphasis

Use the existing Fluxora visual language.

Rules:
- higher confidence => stronger visual prominence
- lower confidence => weaker visual prominence
- low-confidence edges remain visible
- low-confidence edges remain selectable
- evidence remains accessible
- topology is unchanged
- edge semantics are unchanged

Do NOT:
- hide low-confidence edges
- remove low-confidence edges
- filter graph data
- change graph traversal
- change edge types

Do not use color alone.

==================================================
5. GRAPH NODE WEIGHTING
==================================================

Only weight graph nodes if node-level confidence is already an authoritative field in the existing response/model.

Do NOT derive node confidence from:
- child edges
- average edge confidence
- depth
- number of citations
- graph position

If nodes do not have an authoritative confidence contract:
- leave node rendering unchanged,
- document this limitation.

==================================================
6. IMPACT FINDING WEIGHTING
==================================================

Apply the same presentation principle to existing impact-analysis findings:

- direct impact
- downstream impact
- affected API
- affected event
- affected service

Confidence changes visual prominence only.

All findings must remain:
- visible
- selectable
- inspectable
- linked to their EvidenceCitation
- deterministically ordered

Do not reorder findings merely because of confidence unless the existing product contract already does so.

Do not change impact-analysis semantics.

==================================================
7. EVIDENCECITATION INTEGRATION
==================================================

Step 49 already has EvidenceCitation.

Use that existing component.

When confidence is present:
- show it consistently in compact/expanded citation presentation where appropriate.

Example concept:

[file.ts:L20-L35] 92%

Expanded:

Confidence: 92%

When confidence is missing:
- do not display a fake percentage,
- do not imply a confidence band,
- preserve the existing evidence/provenance UI.

Critical distinction:

Evidence
    = provenance supporting the claim

Confidence
    = strength signal for presentation

Never replace evidence with confidence.

==================================================
8. ACCESSIBILITY
==================================================

Do not communicate confidence through opacity or color alone.

Provide accessible text such as:

"High confidence, 92 percent"

or the equivalent terminology chosen from the existing design.

Requirements:
- keyboard accessible
- visible focus
- semantic HTML
- useful aria labels
- confidence understandable without color
- no important information available only through hover

Preserve Step 49 accessibility.

==================================================
9. VISUAL DESIGN
==================================================

Keep the visual treatment subtle.

Do not introduce:
- a new visual design system
- large confidence banners
- gradients
- unnecessary animation
- flashing/pulsing elements
- excessive badges

The purpose is:

"this relationship/finding is stronger or weaker"

not:

"this is a different entity."

Prefer small, deterministic changes in prominence.

==================================================
10. CHANGE MODE COMPATIBILITY
==================================================

Preserve all Step 46 states:

- OFF
- loading
- ready
- empty
- error
- stale
- truncated

Confidence weighting must sit on top of the existing states.

Do not change ChangeModeState semantics.

Do not change persisted impact-analysis behavior.

Do not add frontend recomputation.

==================================================
11. FILTERS AND STEP 51 BOUNDARY
==================================================

A tiny visual legend is allowed only if necessary to explain the Step 50 encoding.

DO NOT implement:

- evidence coverage
- evidence coverage percentage
- repository evidence health
- missing-evidence analytics
- evidence coverage dashboard
- coverage heatmaps

Those belong to Step 51.

==================================================
12. DATA INTEGRITY
==================================================

The browser must treat confidence as read-only backend data.

Do not accept user-supplied confidence as authoritative.

Do not persist frontend-derived confidence.

Do not send changed confidence back to the server.

Do not expose new sensitive backend metadata merely for styling.

==================================================
13. TESTING
==================================================

Add focused tests.

A. Confidence representation
- valid confidence is preserved
- percentage formatting is correct
- deterministic band mapping
- missing confidence remains missing
- malformed/out-of-contract values are handled safely

B. Edge weighting
- higher confidence gets stronger prominence
- lower confidence gets weaker prominence
- weighting is monotonic
- low-confidence edge remains visible
- low-confidence edge remains selectable

C. Node behavior
- node weighting occurs only when authoritative node confidence exists
- no fabricated node confidence
- existing node rendering remains unchanged when confidence is absent

D. Impact findings
- direct finding confidence displayed correctly
- downstream confidence displayed correctly
- API/event/service confidence displayed correctly
- all findings remain selectable
- deterministic ordering remains intact

E. EvidenceCitation
- confidence shown when provided
- confidence omitted when absent
- existing citation/source navigation still works

F. Accessibility
- confidence is exposed textually
- confidence does not depend on color/opacity alone

G. Regression
- Step 49 evidence-citation tests remain green
- Step 46 change-mode tests remain green
- graph explorer tests remain green
- inspector tests remain green

Do not weaken or delete existing tests.

==================================================
14. DOCUMENTATION
==================================================

Create:

learning/implementations/phase-07/step-50-confidence-based-visual-weighting.md

learning/notes/50. Confidence-Based Visual Weighting.md

learning/interviews/50. Step 50 Confidence-Based Visual Weighting Interview CheatSheet.md

Update:

docs/DESIGN.md

Use the same terminology, organization, and depth as the previous Fluxora learning artifacts.

Document:
- Step 50 goal
- why visual confidence matters
- evidence vs confidence
- authoritative confidence source
- frontend data flow
- normalization/presentation mapping
- chosen thresholds, if any
- graph edge weighting
- node behavior
- impact finding weighting
- EvidenceCitation integration
- accessibility
- security/data integrity
- missing-confidence behavior
- deterministic rendering
- limitations
- Step 48/49/50/51 boundary
- senior/staff interview reasoning

Document only what is actually implemented.

==================================================
15. DESIGN.MD
==================================================

Update docs/DESIGN.md with the actual Step 50 architecture.

Include:
- confidence as backend-owned metadata
- presentation normalization
- visual weighting behavior
- graph integration
- impact integration
- EvidenceCitation integration
- accessibility
- invariants
- limitations

Do not rewrite unrelated sections.

==================================================
16. STRICT SCOPE
==================================================

DO NOT IMPLEMENT:

- Step 51
- coverage analytics
- new confidence algorithms
- confidence persistence changes
- graph traversal changes
- impact-analysis engine changes
- evidence-writing changes
- simulation
- runtime telemetry
- AI reasoning
- clustering/LOD
- new authentication
- unrelated UI refactors

Step 50 is presentation-only.

==================================================
17. VERIFICATION
==================================================

Run focused tests first.

Then run:

pnpm typecheck
pnpm lint
pnpm lint:evidence
pnpm build
pnpm test
git diff --check

Also specifically verify:

pnpm --filter @fluxora/web typecheck
pnpm --filter @fluxora/web test

Review the final git diff for:
- unrelated changes
- generated files
- secrets
- accidental Step 51 implementation
- confidence calculation changes
- backend analysis changes

If anything fails:
- report the exact failure,
- fix only the Step 50 issue,
- rerun the failed verification.

Do not claim a check passed unless it actually passed.

==================================================
18. FINAL REPORT
==================================================

Report:

1. Step 50 status
2. exact files changed
3. new files created
4. authoritative confidence source
5. normalization/presentation rules
6. graph edge weighting behavior
7. node behavior
8. impact finding weighting
9. EvidenceCitation changes
10. accessibility behavior
11. focused test results
12. full test results
13. typecheck result
14. lint result
15. evidence-lint result
16. build result
17. git diff --check result
18. limitations

Explicitly confirm:

- Step 51 was NOT implemented.
- Backend confidence calculation was NOT changed.
- Graph/impact analysis semantics were NOT changed.
- Evidence persistence was NOT changed.

Do NOT commit or push.