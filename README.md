# Fluxora — AI-Powered Software Digital Twin

Fluxora is an AI-powered software digital twin platform. It constructs a deterministic, queryable, evidence-backed model of a software system from repository source code, dependency relationships, API routes, database schemas, and event flows — layering change-impact analysis, scenario simulation, and AI explanations on top.

> **Core Architectural Invariant:** Fluxora maintains a **deterministic core** and a **probabilistic AI edge**. Software dependency graph construction, blast-radius calculation, graph traversal, tenant isolation (RLS), authorization, and evidence provenance are strictly deterministic and independently verifiable. The AI layer explains verified evidence; it never invents or defines the underlying system truth.

---

## Key Capabilities

### Implemented (Phases 1–4, Steps 1–29)

- **Multi-Tenant Foundation & Security:** Organization and user tenancy model built on PostgreSQL Row-Level Security (RLS) policies, Clerk authentication, JWT session verification, and job queue management.
- **Sandboxed Repository Ingestion:** GitHub App integration, snapshot packaging, checksum-verified storage in MinIO / AWS S3, and execution limits (zip-bomb and path-traversal safeguards).
- **Code Intelligence Parser:** Multi-pass parser using the TypeScript Compiler API (`typescript`) and `web-tree-sitter` for extracting symbols (functions, classes), modules, Next.js API routes, Express routes, event pub/sub patterns, database ORM calls, and barrel-file normalization.
- **Relational Graph Storage:** Transactional PostgreSQL persistence (`analysis_runs`, `graph_nodes`, `graph_edges`, `evidence`) enforcing composite foreign-key integrity, SHA-256 node/edge deduplication, and RLS multi-tenant scoping.
- **Evidence Writer & Architectural Lint:** `EvidenceWriter` module guaranteeing code provenance for graph writes, backed by a static AST CI lint check (`pnpm lint:evidence`).

### Planned Roadmap (Phases 4–11)

- **Graph Querying & Traversal (Phase 4 Step 30):** Bounded-depth CTE graph traversal and `POST /api/v1/graph/query` endpoint.
- **Architecture Explorer UI (Phase 5):** Interactive React Flow canvas, node inspector, and evidence trail.
- **Pull Request Impact Analysis (Phase 6):** Changed-file blast-radius computation, downstream API/event impact analysis, and GitHub PR overlays.
- **Evidence UI Hardening (Phase 7):** Clickable source citations and visual confidence weighting.
- **Scenario Simulation (Phase 8):** Rule-based failure propagation (infrastructure outages, latency degradation).
- **AI Reasoning Layer (Phase 9):** Model Gateway, Context Assembler, structured output validator, and hallucination evaluation suite.
- **Runtime Telemetry (Phase 10):** OpenTelemetry trace/metric integration to upgrade static graph confidence.
- **Production Hardening (Phase 11):** Read-replica routing, incremental graph updates, and load scaling.

---

## Monorepo Architecture

Fluxora is structured as a pnpm workspace monorepo:

```text
fluxora/
├── apps/
│   ├── api/             # Fastify API server (@fluxora/api) with OpenTelemetry & Clerk auth
│   ├── web/             # Next.js 16 frontend app (@fluxora/web) with React 19
│   └── workers/         # Async worker harness (@fluxora/workers) for ingestion & parsing
├── packages/
│   ├── db/              # PostgreSQL schema, migrations, seed, RLS, repositories & EvidenceWriter
│   ├── infrastructure/  # S3/MinIO storage client, Redis client, secrets manager
│   ├── observability/   # OpenTelemetry SDK (traces, metrics, logs)
│   └── shared-types/    # Domain types and interface definitions across apps and packages
├── docs/
│   ├── DESIGN.md        # Living implementation snapshot and step-by-step progress
│   └── architecture/    # Canonical 00–22 architectural specification package
├── scripts/
│   └── evidence-lint.ts # CI AST lint script verifying EvidenceWriter invocations
├── docker-compose.yml   # Local dev services (PostgreSQL 18, Redis 7, MinIO)
├── .env.example         # Template for local environment variables
├── package.json         # Workspace root package manifest & pnpm scripts
└── pnpm-workspace.yaml  # Workspace configuration
```

---

## System Architecture

```mermaid
flowchart TD
    subgraph Client ["Client & Auth Layer"]
        Web["Next.js Web App (@fluxora/web)"]
        Clerk["Clerk Auth Provider"]
    end

    subgraph API ["API & Job Queue Layer"]
        APIServer["API Server (@fluxora/api)"]
        Jobs[("PostgreSQL Job Queue")]
    end

    subgraph Processing ["Ingestion & Intelligence Workers (@fluxora/workers)"]
        Ingest["Ingestion Worker"]
        Parser["Code Intelligence Engine\n(TS Compiler API + tree-sitter)"]
        Normalizer["Barrel Normalizer"]
        GraphBuilder["Graph Builder & Projection"]
    end

    subgraph Storage ["Deterministic Storage & Evidence Layer (@fluxora/db)"]
        MinIO[("S3 / MinIO Object Storage\n(Snapshots)")]
        PG[("PostgreSQL Database\n(RLS Multi-Tenancy)")]
        Nodes["graph_nodes"]
        Edges["graph_edges"]
        Evidence["evidence & EvidenceWriter"]
    end

    subgraph AI ["AI Edge Layer (Planned)"]
        Gateway["Model Gateway & Context Assembler"]
    end

    Web --> Clerk
    Web --> APIServer
    APIServer --> Jobs
    Jobs --> Ingest
    Ingest --> MinIO
    Ingest --> Parser
    Parser --> Normalizer
    Normalizer --> GraphBuilder
    GraphBuilder --> Evidence
    Evidence --> PG
    PG --- Nodes
    PG --- Edges
    GraphBuilder ..-> Gateway
```

---

## Technology Stack

- **Workspace Manager:** pnpm 10.34.5
- **Runtime & Language:** Node.js (>=20), TypeScript (~5.9.2)
- **Database & Storage:** PostgreSQL 18 (with RLS), Redis 7, MinIO / AWS S3 (`@aws-sdk/client-s3`)
- **Backend Framework:** Node.js HTTP/WS, Fastify (`@fluxora/api`)
- **Frontend Framework:** Next.js 16 (App Router), React 19 (`@fluxora/web`)
- **AST & Parser Tools:** TypeScript Compiler API (`typescript`), `web-tree-sitter`, `tree-sitter-wasms`, `tar`
- **Auth & Security:** Clerk (`@clerk/nextjs`, `@clerk/backend`), PostgreSQL Row-Level Security
- **Observability:** OpenTelemetry SDK (`@opentelemetry/sdk-node`, trace/metrics/logs OTLP proto exporters)
- **Tooling & Quality:** ESLint 9, TypeScript ESLint, GitHub Actions CI

---

## Getting Started

### Prerequisites

- **Node.js:** `>=20.0.0`
- **pnpm:** `^10.34.5`
- **Docker Desktop:** For running PostgreSQL, Redis, and MinIO locally

### 1. Clone & Install

```bash
git clone https://github.com/fluxora/fluxora.git
cd fluxora
pnpm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Ensure your `.env` contains the local development configuration:

```env
DATABASE_URL=postgresql://fluxora:fluxora@localhost:5433/fluxora_dev
NODE_ENV=development

# Clerk Auth
CLERK_SECRET_KEY=
CLERK_AUTHORIZED_PARTIES=http://localhost:3000

# API Configuration
API_PORT=4000

# GitHub App Integration
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_SLUG=
FLUXORA_API_URL=http://127.0.0.1:4000
```

### 3. Start Local Services

Start PostgreSQL, Redis, and MinIO using Docker Compose:

```bash
docker compose up -d
```

### 4. Run Database Migrations & Seed

Initialize database tables, Row-Level Security policies, and development seed data:

```bash
pnpm db:migrate
pnpm db:seed
```

To reset the database environment at any time:

```bash
pnpm db:reset
```

---

## Verification & Development Commands

All verification commands are configured in root `package.json` and executed in CI:

| Command | Action |
| --- | --- |
| `pnpm dev` | Start development mode across all monorepo applications |
| `pnpm api:start` | Start the `@fluxora/api` server |
| `pnpm typecheck` | Run TypeScript type checking across all workspace packages |
| `pnpm lint` | Execute ESLint code quality checks across the project |
| `pnpm lint:evidence` | Run static AST check verifying `EvidenceWriter` invocations |
| `pnpm test` | Run unit and integration test suites across all packages |
| `pnpm build` | Build production artifacts for all packages |
| `pnpm format` | Run code formatter across workspaces |

---

## Implementation Status & Source of Truth

- **Current Implementation Milestone:** **Phase 4 Step 29** (Evidence Writer & Static CI Evidence Lint complete).
- **Canonical Architecture Package:** [`docs/architecture/`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/architecture/) (`00-README.md` through `22-definition-of-done.md`).
- **Implementation Sequence:** [`docs/architecture/17-implementation-roadmap.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/architecture/17-implementation-roadmap.md).
- **Living Implementation Snapshot:** [`docs/DESIGN.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/DESIGN.md).

---

## Security Principles & Isolation Boundaries

1. **Strict Tenant Boundaries:** Every database query and graph mutation operates within an organization context enforced by PostgreSQL Row-Level Security (RLS). Policies utilize helper functions (`fluxora_current_org_id`, `fluxora_snapshot_in_current_tenant`, `fluxora_analysis_run_in_current_tenant`) to prevent cross-tenant data leakage.
2. **Untrusted Repository Content:** Ingested customer repository contents are treated strictly as untrusted data. Fluxora never executes customer code during static analysis. Snapshot archives are extracted under strict path-traversal and file-size constraints.
3. **Prompt Injection Safety:** Raw repository source code is never fed directly into LLM prompts as system instructions. The AI layer consumes structured evidence manifests validated against deterministic database IDs.

---

## Contribution & Quality Bar

Before requesting a code review or submitting a PR, verify your changes against the portfolio quality bar defined in [`docs/architecture/22-definition-of-done.md`](file:///c:/Users/HP/Desktop/Projects/fluxora/docs/architecture/22-definition-of-done.md):

```bash
pnpm lint
pnpm lint:evidence
pnpm typecheck
pnpm test
pnpm build
```

