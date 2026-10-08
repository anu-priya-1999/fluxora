# Step 21 — Next.js API Route and Express Router Detection

## Objective

Implement **Fluxora Global Step 21: Next.js API Route and Express Router Detection** (`docs/architecture/05-component-responsibilities.md §5.5`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 4`).

While prior steps answered:
- **Step 18**: *"What technologies are present?"*
- **Step 19**: *"What symbols exist in source files?"*
- **Step 20**: *"How are modules connected through imports and exports?"*

Step 21 answers:
> *"Which files/functions represent HTTP API routes or Express routers?"*

Given an immutable repository snapshot, Step 21 statically and deterministically:
1. Detects Next.js App Router route handlers (`app/**/route.ts`, `src/app/**/route.tsx`, etc.) and the HTTP methods exported (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`).
2. Detects Next.js Pages Router API routes (`pages/api/**`, `src/pages/api/**`) and derives their public route paths.
3. Detects Express router creation (`express.Router()`, `Router()`) and route registrations (`router.get`, `router.post`, `router.use`, etc.) when provenance is proven.
4. Detects Express application route registrations (`app.get`, `app.post`, `app.use`, etc.) when the application instance is proven to originate from `express()`.
5. Extracts static route paths deterministically without executing customer code, falling back to `(unresolved)` for dynamic non-literal expressions.
6. Strictly prevents false positives from arbitrary user objects named `router` or `app`.
7. Produces deterministic source locations, stable IDs, and descriptive evidence strings.

Step 21 is **not** graph database persistence (Phase 4). It produces structured route and router findings that downstream graph-building steps consume.

---

## 1. Architectural Position & Invariants

### Deterministic Core vs. Probabilistic AI Edge
Route and router detection are fundamental deterministic primitives of Fluxora:
- **No LLM in Core**: Route classification, method discovery, and path derivation never depend on an AI model or runtime inference.
- **Untrusted Input Guarantee**: Customer code is never executed, evaluated (`eval`), dynamically imported via Node.js runtime, or passed to package managers.
- **Pure AST & Path Analysis**: Analyzes AST structures (`ts.SourceFile`) and relative repository paths without disk or network side effects.
- **Strict Evidence Trail**: Every route and router record carries explicit deterministic evidence explaining the file convention or AST call that proved its classification.

### Strict Scope Boundary
- **Step 21** is strictly limited to Next.js API routes and Express routers.
- **Step 22** will implement event producer/consumer pattern detection.
- **Step 23** will implement database/ORM reference detection.
- **Step 24** will implement tree-sitter fallback parsing.
- **Step 25** will implement symbol normalization and barrel collapsing.
- **Phase 4** persists nodes, edges, and evidence to PostgreSQL (`GraphNode`, `GraphEdge`, `Evidence`). Step 21 produces pure in-memory contracts.

---

## 2. Shared Type Contracts (`@fluxora/shared-types`)

Route detection contracts are defined in `packages/shared-types/src/routes.ts`:

- `RepositoryRouteFramework`: `"Next.js" | "Express"`
- `RepositoryRouteType`: `"app-router-handler" | "pages-api-route" | "express-router" | "express-app-route"`
- `RepositoryHttpMethod`: `"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL"`
- `RepositoryApiRoute`:
  - `id`: `${filePath}#${routeType}:${httpMethods.join(",")}:${routePath}`
  - `framework`: `RepositoryRouteFramework`
  - `routeType`: `RepositoryRouteType`
  - `filePath`: relative path in repository
  - `routePath`: canonical route path (e.g. `/api/users`, `/users/:id`)
  - `httpMethods`: readonly list of HTTP methods
  - `symbolName`: optional function or handler identifier
  - `sourceLocation`: 1-based line/col and 0-based character offsets
  - `evidence`: deterministic explanation
- `RepositoryExpressRouter`:
  - `id`: `${filePath}#express-router:${routerSymbol}:${offset}`
  - `filePath`: relative path in repository
  - `routerSymbol`: name of router variable
  - `routes`: array of `RepositoryExpressRouteEntry`
  - `mountPath`: mount prefix if statically known, or `null`
  - `sourceLocation`: declaration location
  - `evidence`: deterministic explanation
- `RepositoryRouteDetectionResult`: contains `routes`, `routers`, `diagnostics`, and `counts`.

---

## 3. Detection Engine Implementation (`@fluxora/workers`)

The detection engine is implemented in `apps/workers/src/routes/detector.ts`:

### A. Next.js App Router Detection
1. **File Matching**: Files matching `(?:^|/)(?:src/)?app/(?:.+/)?route\.(?:ts|tsx|js|jsx)$`.
2. **Export Inspection**: Scans AST statements for exported declarations matching `NEXT_APP_ROUTER_METHODS`:
   - Function declarations: `export async function GET() {}`
   - Variable declarations: `export const POST = async () => {}`
   - Named export clauses: `export { GET, POST }`
3. **Route Path Derivation**:
   - `app/api/posts/route.ts` -> `/api/posts`
   - `src/app/api/users/[id]/route.tsx` -> `/api/users/[id]`
   - `app/route.ts` -> `/`

### B. Next.js Pages Router API Detection
1. **File Matching**: Files matching `(?:^|/)(?:src/)?pages/api/.+\.(?:ts|tsx|js|jsx)$`.
2. **Default Export Inspection**:
   - `export default function handler() {}`
   - `export default class Handler {}`
   - `export default handler;`
3. **Route Path Derivation**:
   - `pages/api/posts/[id].ts` -> `/api/posts/[id]`
   - `pages/api/users/index.ts` -> `/api/users`
   - `pages/api/index.ts` -> `/api`

### C. Express Router and App Detection
1. **Provenance Tracking via Two-Pass AST Scope Analysis**:
   - Scans imports: `import express from "express"`, `import { Router } from "express"`, `require("express")`, `{ Router } = require("express")`.
   - If Express was not imported, skips Express analysis completely.
   - Identifies instantiation:
     - `const app = express()` -> registers `app` as an Express app variable.
     - `const router = express.Router()` or `const router = Router()` -> registers `router` as an Express router variable.
2. **Method & Route Registration Extraction**:
   - Identifies `router.get`, `router.post`, `router.put`, `router.patch`, `router.delete`, `router.head`, `router.options`, `router.all`.
   - Identifies middleware & mount calls: `router.use("/api", childRouter)`.
   - Identifies `app.get`, `app.post`, `app.use`, etc. only on proven Express app instances.
3. **Static Value Extraction**:
   - Extracts literal strings: `"/users"`, `"/users/:id"`.
   - Flags dynamic or computed expressions (e.g. `BASE + "/users"`) safely as `"(unresolved)"` without executing code.

### D. False-Positive Safeguards
- Frontend pages like `app/page.tsx` or `pages/index.tsx` are strictly rejected.
- Plain object literals (`const router = { get() {} }`) or custom classes (`class Application { get() {} }`) are never classified as Express.
- Standard ignored directories (`node_modules`, `.next`, `dist`, `build`, etc.) are completely skipped.

---

## 4. Verification & Testing

The implementation was validated against 22 focused tests in `apps/workers/src/routes/detector.test.ts`:
1. Next.js App Router `route.ts` detection
2. Next.js App Router HTTP method detection (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`)
3. Next.js Pages Router API detection
4. Next.js dynamic API route path derivation (`[id]`, nested segments, `index`)
5. Non-API app pages (`page.tsx`, `layout.tsx`) ignored
6. Express Router creation through `express.Router()`
7. Express Router creation through `Router` imported from `express`
8. `router.get` detection
9. `router.post` detection
10. `router.put` detection
11. `router.patch` detection
12. `router.delete` detection
13. `router.use` detection
14. `app.get`/`app.post` when Express origin is proven
15. Static route path extraction (string and template literals)
16. Dynamic/non-static route path handling (`(unresolved)`)
17. False-positive prevention for arbitrary objects named router/app
18. Source locations tracking 1-based line/col and 0-based character offsets
19. Deterministic repeated execution across runs
20. Malformed source tolerance
21. Ignored directories skipped (`node_modules`, `.next`, `dist`)
22. Real-world Golden Fixture Next.js route detection (finds all 5 route handlers in `shadcn/taxonomy`: `app/api/og/route.tsx`, `app/api/posts/route.ts` GET & POST, `app/api/users/stripe/route.ts`, `app/api/webhooks/stripe/route.ts`)

Full workspace checks passed cleanly:
- `pnpm lint` -> 0 errors
- `pnpm typecheck` -> 7 workspace projects passed with 0 errors
- `pnpm test` -> 120 total tests passed
- `pnpm build` -> production build succeeded

