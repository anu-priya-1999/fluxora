# Step 47 — Golden-Fixture PR Impact Validation

## Objective & Role in Roadmap

Global Step 47 completes **Phase 6: PR Impact Analysis** of the Fluxora Engineering Roadmap (`docs/architecture/17-implementation-roadmap.md`, Step 7). It establishes an automated, end-to-end deterministic validation pipeline that proves that for a real-world repository and recorded golden Pull Request fixture, Fluxora's deterministic PR impact analysis pipeline produces the exact hand-verified direct and downstream impact findings.

This fulfills:
- `docs/architecture/17-implementation-roadmap.md` (Phase 6, Step 7: Golden-fixture PR impact validation)
- `docs/architecture/12-testing-strategy.md` (§12.1 Graph traversal testing, §12.2 Integration testing, §12.3 Contract testing, §12.4 Golden-fixture expectations)
- `docs/architecture/05-component-responsibilities.md` (§5.7 Graph Builder, §5.8 Evidence Writer, §5.9 Impact Analysis Engine, §5.16 Job Queue / Worker Coordination)
- `docs/architecture/06-database-schema.md` (PullRequest, PullRequestFile, AnalysisRun, GraphNode, GraphEdge, Evidence, ImpactAnalysis, RLS)

---

## Architectural Data Flow & Verification Pipeline

```
Golden PR Manifest (fixtures/golden/pr-impact-manifest.json)
      │
      ├─ Recorded PR: "Harden subscription plan validation and grace period checks" (#42)
      ├─ Pinned Repository: "shadcn-ui/taxonomy" @ commit 298a8857c7128a0d121e7f699dfd729f23b3966d
      └─ Changed Files: lib/subscription.ts (modified), content/docs/billing.mdx (unresolved documentation)
      │
      ▼
PostgreSQL Ingestion & Graph Projection
      │
      ├─ Organizations, Repositories, Snapshots, Analysis Runs (multi-tenant RLS setup)
      ├─ AST extraction & canonical graph build: 490 nodes, 888 edges, Phase 3 pipeline
      └─ PullRequest & PullRequestFiles persisted into PostgreSQL
      │
      ▼
Step 43 Impact Analysis Engine (traverseGraph & computeImpactAnalysis)
      │
      ├─ Diff Hunk Parsing: @@ -7,4 +7,6 @@ in lib/subscription.ts
      ├─ Seed Resolution: sym:lib/subscription.ts#function:getUserSubscriptionPlan:197
      ├─ Traversal (direction: "both", maxDepth: 2, decayFactor: 0.9):
      │    ├─ Direct Impact (Depth 1): Exactly 4 module nodes (confidence = 0.90)
      │    └─ One-Hop Downstream (Depth 2): Exactly 45 nodes: 3 API routes, 14 modules, 28 symbols (confidence = 0.81)
      ├─ Affected APIs: GET /api/posts, GET /api/users/stripe, POST /api/posts
      └─ Unresolved Files: content/docs/billing.mdx (no graph nodes, no phantom nodes)
      │
      ▼
Step 44 Impact Analysis Persistence + EvidenceWriter
      │
      ├─ PostgreSQL impact_analyses table insertion
      ├─ EvidenceWriter: 49 deterministic impact_finding evidence records
      └─ Idempotency: ON CONFLICT DO UPDATE, zero duplicate evidence records
      │
      ▼
Step 45 API / Worker Job Readback Contract
      │
      ├─ processPullRequestImpactJob: Successful job execution with golden payload
      ├─ getLatestImpactAnalysisForPullRequest & getImpactAnalysisById readback
      └─ RLS Tenant Isolation: Non-member tenant receives null / empty array
      │
      ▼
Golden Ground Truth Assertion (Assert Actual == Expected)
      └─ 100% exact set equality on sorted canonical IDs, unaffected negative controls confirmed absent
```

---

## Detailed Specifications

### 1. Golden Fixture Identification & Selection
Rather than fabricating synthetic nodes, Step 47 reuses the canonical golden fixture repository `shadcn-ui/taxonomy` (pinned to Git SHA `298a8857c7128a0d121e7f699dfd729f23b3966d`) established in Step 17 and Step 33. This codebase represents a production Next.js 13 App Router architecture featuring NextAuth.js authentication, Stripe subscription billing, Prisma database schemas, and documentation content.

### 2. Golden PR Scenario Design
The golden PR scenario was designed around the core business logic of SaaS subscription management:
- **Title**: *"Harden subscription plan validation and grace period checks"* (PR #42)
- **Changed File 1 (`lib/subscription.ts`)**: Modifies `getUserSubscriptionPlan` (lines 7–10) adding guard checks on `userId`.
- **Changed File 2 (`content/docs/billing.mdx`)**: Added documentation file explaining subscription billing plans. This serves as an intentional negative control proving that unmapped Markdown documentation files are correctly reported under `unresolvedFiles` without generating synthetic phantom graph nodes.

### 3. Traversal Semantics & Direct vs. Downstream Definition
- **AST Symbol Representation**: In TypeScript, symbols are declared within modules. The graph model represents `getUserSubscriptionPlan` as `sym:lib/subscription.ts#function:getUserSubscriptionPlan:197`.
- **Seed Node (Depth 0)**: The function `getUserSubscriptionPlan` is identified as the seed via diff line overlap.
- **Direct Impact (Depth 1)**: Traversal with `direction: "both"` identifies the immediate parent module `mod:lib/subscription.ts` as well as consuming modules that import or call the function:
  1. `mod:app/(dashboard)/dashboard/billing/page.tsx`
  2. `mod:app/api/posts/route.ts`
  3. `mod:app/api/users/stripe/route.ts`
  4. `mod:lib/subscription.ts`
  Confidence is $1.0 \times 0.9^1 = 0.90$.
- **One-Hop Downstream Impact (Depth 2)**: The downstream consumers and children of the depth 1 modules:
  - 3 API route endpoints:
    - `route:app/api/posts/route.ts#app-router-handler:GET:/api/posts:360`
    - `route:app/api/posts/route.ts#app-router-handler:POST:/api/posts:907`
    - `route:app/api/users/stripe/route.ts#app-router-handler:GET:/api/users/stripe:361`
  - 14 modules (including UI cards, shell, header, billing form, config)
  - 28 symbols (exported functions, constants, handlers)
  Confidence is $1.0 \times 0.9^2 = 0.81$.
- **Negative Controls (Unaffected Nodes)**: Hand-verified nodes that must NEVER appear in the impact set:
  - `route:app/api/og/route.tsx#app-router-handler:GET:/api/og:238` (OpenGraph image generator)
  - `route:app/api/webhooks/stripe/route.ts#app-router-handler:POST:/api/webhooks/stripe:561` (Stripe incoming webhook handler)
  - `mod:components/site-footer.tsx` (Global footer)
  - `sym:config/site.ts#constant:siteConfig:49` (Site metadata config)
  - `mod:lib/toc.ts` (Table of contents parser)
  - `mod:app/(marketing)/page.tsx` (Marketing landing page)

### 4. Verification Layers in `golden-pr-impact.test.ts`
The test suite implements 6 distinct verification layers:
1. **Layer A: Fixture Contract & Ground Truth Setup**: Manifest loads, valid SHA, expected changed files match, seed symbols exist in projected graph, unresolved files do not become phantom nodes.
2. **Layer B: Impact Analysis Integration & Hand-Verified Assertions**: Exact match on 4 direct impact canonical IDs, exact match on 45 one-hop downstream canonical IDs, affected APIs list, unresolved files list, negative control absence.
3. **Layer C: Evidence Provenance & Audit Trail**: Every finding links to a persisted `impact_finding` evidence record, valid file paths and line ranges, matching confidence, correct metadata.
4. **Layer D: Determinism & Idempotency**: Re-running the pipeline produces identical logical findings; re-running with a stable ID is idempotent and creates 0 duplicate evidence records.
5. **Layer E: Multi-Tenant & Run Isolation**: RLS blocks cross-tenant reads and inserts; alternate empty analysis run produces 0 findings without mutating existing run.
6. **Layer F: Worker Job Handler Integration & Step 45 Readback**: Worker job handler executes golden payload; repository query APIs return fully hydrated result matching manifest.

---

## Verification Results

| Command | Status | Output Summary |
| --- | --- | --- |
| `pnpm --filter @fluxora/workers test src/pipeline/golden-pr-impact.test.ts` | **PASSED** | 18 tests passed (106s) |
| `pnpm --filter @fluxora/workers test src/fixtures/golden.test.ts` | **PASSED** | 9 tests passed (2.3s) |
| `pnpm --filter @fluxora/db test` | **PASSED** | 13 test files, 123 tests passed (36.8s) |
| `pnpm --filter @fluxora/api test` | **PASSED** | 11 test files, 123 tests passed (25.2s) |
| `pnpm --filter @fluxora/web test` | **PASSED** | 11 test files, 132 tests passed (13.2s) |
| `pnpm typecheck` | **PASSED** | 7 workspace packages compiled cleanly |
| `pnpm lint` | **PASSED** | Zero ESLint warnings or errors |
| `pnpm lint:evidence` | **PASSED** | Static AST check confirmed all graph writes invoke `EvidenceWriter` |
| `pnpm build` | **PASSED** | Production builds compiled cleanly |

