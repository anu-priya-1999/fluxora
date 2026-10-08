Implement ONLY Fluxora Global Step 21: Next.js API Route and Express Router Detection.

IMPORTANT:
- Inspect the current repository before modifying anything.
- Treat docs/architecture/17-implementation-roadmap.md as the authoritative roadmap.
- Step 18, Step 19, and Step 20 are already implemented.
- Reuse the existing TypeScript Compiler API, Step 19 symbol extraction, and Step 20 module-analysis infrastructure where appropriate.
- Do NOT implement Step 22 or any later step.
- Do NOT perform broad refactors.
- Do NOT introduce LLM/AI analysis.
- Keep detection deterministic and reproducible.
- Do not execute analyzed repository code.

==================================================
STEP 21 OBJECTIVE
==================================================

Step 18 answers:
"What technologies are present?"

Step 19 answers:
"What symbols exist in source files?"

Step 20 answers:
"How are modules connected through imports/exports?"

Step 21 must answer:

"Which files/functions represent HTTP API routes or Express routers?"

Implement deterministic static detection for:

1. Next.js API routes / route handlers
2. Express router definitions and route registrations

The output must identify the route/router source location and the relevant symbol or file.

==================================================
IMPORTANT SCOPE RULE
==================================================

Before implementing detection patterns, inspect:

- docs/architecture/17-implementation-roadmap.md
- docs/architecture/05-component-responsibilities.md
- existing Step 18 detector
- existing Step 19 symbol extractor
- existing Step 20 module graph contracts/implementation
- existing golden fixture

Use the repository's existing conventions.

Do not invent unrelated route frameworks.

Step 21 is specifically:
- Next.js API route detection
- Express router detection

Do NOT implement:
- event producer/consumer detection
- database/ORM detection
- tree-sitter fallback
- normalizer/barrel collapse
- GraphNode/GraphEdge/Evidence persistence
- graph query API
- AI/LLM reasoning

==================================================
NEXT.JS DETECTION
==================================================

Implement deterministic detection based on repository structure and AST evidence.

Support the Next.js API route conventions actually present/required by the existing architecture and fixture.

At minimum inspect for:

### App Router route handlers

Files following:

app/**/route.ts
app/**/route.tsx
app/**/route.js
app/**/route.jsx

Detect exported HTTP handler functions such as:

export async function GET() {}
export async function POST() {}
export async function PUT() {}
export async function PATCH() {}
export async function DELETE() {}
export async function HEAD() {}
export async function OPTIONS() {}

Capture:

- framework: Next.js
- route type: app-router-handler
- file path
- HTTP methods detected
- exported symbol/function where deterministically available
- source location
- evidence explaining why it was classified as an API route

Do not execute the handler.

### Pages Router API routes

Detect files under:

pages/api/**

and the corresponding supported source extensions.

A Pages API route may be represented by a default-exported handler.

Capture:

- framework: Next.js
- route type: pages-api-route
- file path
- exported handler symbol where available
- source location
- route path derived deterministically from the repository-relative file path

Handle dynamic segments conservatively and preserve the repository's actual naming semantics.

Do not execute the handler.

==================================================
EXPRESS DETECTION
==================================================

Detect Express router usage using AST/static evidence.

At minimum support patterns such as:

const router = express.Router();

router.get(...)
router.post(...)
router.put(...)
router.patch(...)
router.delete(...)
router.use(...)

and equivalent patterns where the router object is imported/referenced through supported syntax.

Also detect:

app.get(...)
app.post(...)
app.put(...)
app.patch(...)
app.delete(...)
app.use(...)

ONLY classify these as Express-related when there is deterministic evidence that the object originates from Express.

Examples of evidence may include:

import express from "express";
import { Router } from "express";

const router = express.Router();

const router = Router();

Do NOT assume that an arbitrary variable named "router" or "app" is Express.

Avoid false positives.

Capture:

- framework: Express
- route/router type
- source file
- router symbol when available
- HTTP method
- route path when statically known
- source location
- evidence

For:

router.get("/users", handler)

capture:

method = GET
path = /users

For:

router.use("/api", childRouter)

capture the mount relationship/path when statically available.

Do not implement cross-file router composition beyond what the existing Step 20 module relationships can safely support.

==================================================
STATIC VALUE EXTRACTION
==================================================

Extract route path only when deterministically available from AST/static expressions.

Support simple cases such as:

"/users"
"/users/:id"
"/api"

Do not evaluate arbitrary expressions.

For:

router.get(BASE_PATH + "/users", handler)

do not execute code.

Represent the path as unknown/unresolved unless the existing architecture already supports deterministic constant folding.

==================================================
NEXT.JS ROUTE PATH DERIVATION
==================================================

Derive route paths only from repository-relative file paths.

Examples:

app/api/users/route.ts
→ /api/users

app/api/users/[id]/route.ts
→ /api/users/[id]

pages/api/users.ts
→ /api/users

Do not confuse frontend page routes with API routes.

Only files matching the API-route conventions should be classified.

==================================================
RESULT CONTRACTS
==================================================

Create strongly typed shared contracts in:

packages/shared-types

Follow the repository's existing naming conventions.

Prefer a structure containing concepts such as:

RepositoryApiRoute
- framework
- routeType
- filePath
- routePath
- httpMethods
- symbolName where available
- sourceLocation
- evidence

RepositoryExpressRouter
- filePath
- routerSymbol
- methods/routes
- mountPath where statically known
- sourceLocation
- evidence

RepositoryRouteDetectionResult
- routes
- routers
- diagnostics
- deterministic counts

Use explicit string unions for:

- framework
- route type
- HTTP method
- detection status where necessary

Stable identifiers must be deterministic.

Do NOT create database tables.

Do NOT create GraphNode/GraphEdge/Evidence persistence.

==================================================
EVIDENCE
==================================================

Every detected route/router should include concise deterministic evidence.

Examples:

Next.js App Router:
- file pattern: app/**/route.ts
- exported handler: GET
- route path: /api/users

Next.js Pages API:
- file pattern: pages/api/**
- default export handler
- route path: /api/users

Express:
- import source: express
- router construction: express.Router()
- registration: router.get
- route path: /users

Do not use probabilistic confidence scores.

==================================================
STEP 19 / STEP 20 INTEGRATION
==================================================

Reuse existing Step 19 symbol information where useful.

Reuse Step 20 module/reference information only where needed.

Do NOT duplicate large parts of Step 19 or Step 20.

Do not turn Step 21 into a generic graph builder.

Step 21 should produce deterministic route/router findings that later graph steps can consume.

==================================================
GOLDEN FIXTURE
==================================================

Use the existing:

fixtures/golden/taxonomy

Do NOT modify the fixture.

Verify real-world Next.js API routes present in the fixture.

The fixture contains Next.js route handlers under app/api and Pages Router API routes.

Use those real files to prove detection.

Also verify that unrelated page/component files are NOT incorrectly classified as API routes.

For Express:
- If the golden fixture does not contain a genuine Express router example, use a small synthetic in-memory test fixture.
- Do not modify the canonical golden repository.

==================================================
TESTS
==================================================

Add focused deterministic tests for:

1. Next.js App Router route.ts detection
2. Next.js App Router HTTP method detection
3. Next.js Pages Router API detection
4. Next.js dynamic API route path derivation
5. Non-API app pages not being detected
6. Express Router creation through express.Router()
7. Express Router creation through Router imported from express
8. router.get detection
9. router.post detection
10. router.put detection
11. router.patch detection
12. router.delete detection
13. router.use detection
14. app.get/app.post/etc. when Express origin is proven
15. static route path extraction
16. dynamic/non-static route path handling
17. false-positive prevention for arbitrary objects named router/app
18. source locations
19. deterministic repeated execution
20. malformed source tolerance
21. ignored directories
22. golden fixture Next.js route detection

Do not add tests for:
- event producer/consumer detection
- database/ORM detection
- graph persistence
- barrel normalization

==================================================
FALSE-POSITIVE REQUIREMENT
==================================================

This is especially important.

Do NOT classify:

const router = {
  get() {}
};

as Express.

Do NOT classify:

app.get("/users", handler);

as Express unless there is deterministic evidence that app is an Express application.

Do NOT classify:

src/app/users/page.tsx

as an API route merely because it is inside app/.

Require the appropriate Next.js API-file convention or Express evidence.

==================================================
SECURITY
==================================================

Repository source is untrusted.

Never:

- execute route handlers
- import customer modules
- run package scripts
- run npm/pnpm/yarn from the analyzed repository
- evaluate arbitrary JavaScript
- make network calls based on repository content

All detection must be static AST/path analysis.

==================================================
DETERMINISM / PERFORMANCE
==================================================

Results must be deterministic for identical snapshot input.

Sort output collections deterministically.

Do not depend on filesystem traversal order.

Avoid reparsing the same source unnecessarily.

Reuse parsed AST/symbol results from existing analysis where practical.

==================================================
DOCUMENTATION
==================================================

Create:

learning/implementations/phase-03/step-21-route-and-router-detection.md

Document:

- Step 21 purpose
- Next.js App Router detection
- Next.js Pages Router API detection
- Express router detection
- route-path derivation
- AST evidence
- false-positive prevention
- security model
- deterministic behavior
- testing strategy
- explicit Step 21 boundary

Create the next appropriately numbered learning note in:

learning/notes/

Create:

learning/interviews/21. Step 21 API Route and Express Router Detection Interview CheatSheet.md

Cover:

- Next.js App Router vs Pages Router API conventions
- AST-based route detection
- Express Router detection
- distinguishing Express from arbitrary objects
- deterministic route-path derivation
- static analysis vs runtime execution
- false-positive prevention
- security when analyzing untrusted repositories
- relationship between Steps 18, 19, 20, and 21

Update:

docs/DESIGN.md

Do not delete or rewrite existing sections unnecessarily.

==================================================
STRICT STEP BOUNDARY
==================================================

DO NOT implement Step 22+:

- event producer/consumer detection
- database/ORM reference detection
- tree-sitter fallback
- symbol/barrel normalization
- GraphNode / GraphEdge / Evidence persistence
- graph traversal
- graph query API
- graph.updated events
- impact analysis
- AI reasoning
- LLM calls
- UI changes

==================================================
VERIFICATION
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run the focused Step 21 tests separately if useful.

Do not weaken tests just to make them pass.

At completion report:

1. exact files created/modified
2. Next.js detection patterns implemented
3. Express detection patterns implemented
4. false-positive safeguards
5. golden-fixture results
6. test counts/results
7. lint/typecheck/test/build results
8. explicit confirmation that Step 22+ was not implemented
9. genuine remaining limitations

Do not claim completion unless the verification commands actually pass.