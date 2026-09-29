# 4. Complete System Architecture

## 4.1 Critique of the originally proposed layer diagram

The prompt's proposed flow:

```text
Source Ingestion / Runtime Ingestion → Repository Model / Telemetry Model → Software Graph
   → Impact Analysis / Simulation Engine → Evidence Layer → AI Reasoning → Product UI
```

This is directionally right but has one structural problem worth calling out explicitly (this is the kind of critique a staff engineer is expected to make, not just accept):

**Evidence should not be a downstream layer that comes *after* Impact Analysis and Simulation — it must be a cross-cutting layer that both of those consume *and* produce.** Impact Analysis doesn't just generate evidence at the end; it *is* a graph traversal that *is itself* evidence (the traversal path is the evidence). Placing Evidence strictly after Impact/Simulation in the pipe implies evidence is a report generated afterward, when actually the Evidence Layer should be the same store that indexes graph edges' provenance from the moment the graph is built, and Impact/Simulation *query* it while producing their output.

Revised layering below reflects this: Evidence is a horizontal store, not a vertical stage.

## 4.2 High-level architecture (corrected)

```mermaid
flowchart TB
    subgraph Ingestion["Ingestion Layer"]
        GH[GitHub OAuth + API]
        RI[Repository Ingestion Service]
        TI[Telemetry Ingestion Service - Phase 10]
    end

    subgraph Analysis["Code Intelligence Layer"]
        Parser[AST Parsers: ts-morph / tree-sitter]
        Extract[Symbol & Dependency Extractor]
    end

    subgraph Core["Deterministic Core"]
        Graph[(Software Graph Store - Postgres)]
        Evidence[(Evidence Store - indexed, append-only)]
        Impact[Impact Analysis Engine]
        Sim[Simulation Engine - rule-based]
    end

    subgraph AI["AI Reasoning Layer"]
        Gateway[Model Gateway]
        Context[Context Assembler]
        Validate[Structured Output Validator]
    end

    subgraph Product["Product Layer"]
        API[Fluxora API - GraphQL/REST]
        UI[Architecture Explorer - Next.js]
    end

    GH --> RI --> Parser --> Extract --> Graph
    Extract --> Evidence
    TI -. future .-> Graph
    Graph --> Impact
    Graph --> Sim
    Evidence --> Impact
    Evidence --> Sim
    Impact --> Evidence
    Sim --> Evidence
    Impact --> Context
    Sim --> Context
    Evidence --> Context
    Context --> Gateway --> Validate --> API
    Graph --> API
    Evidence --> API
    API --> UI
```

## 4.3 Container/component architecture

```mermaid
flowchart LR
    subgraph Client
        Next[Next.js App]
    end

    subgraph EdgeAPI["API Gateway / BFF"]
        REST[REST/GraphQL API]
        WS[WebSocket - job/graph updates]
    end

    subgraph Workers["Worker Fleet (horizontally scalable)"]
        W1[Ingestion Workers]
        W2[Analysis Workers]
        W3[Impact Workers]
        W4[Simulation Workers]
        W5[AI Reasoning Workers]
    end

    subgraph Queue["Job Queue / Event Bus"]
        Q[(Postgres-backed queue - MVP; upgrade path to SQS/Kafka)]
    end

    subgraph Data["Data Layer"]
        PG[(PostgreSQL - primary store + graph modeling)]
        Redis[(Redis - cache, rate limits, job coordination)]
        S3[(Object Storage - raw file snapshots, large payloads)]
        Search[(Search Index - Postgres FTS MVP / OpenSearch later)]
    end

    subgraph External
        GitHub[GitHub API]
        LLM[Claude API]
    end

    Next --> REST
    Next <--> WS
    REST --> Q
    REST --> PG
    Q --> W1 & W2 & W3 & W4 & W5
    W1 --> GitHub
    W1 --> S3
    W2 --> PG
    W2 --> S3
    W3 --> PG
    W4 --> PG
    W5 --> LLM
    W5 --> PG
    REST --> Redis
    W1 & W2 & W3 & W4 & W5 --> Redis
    REST --> Search
```

## 4.4 Repository ingestion flow

```mermaid
sequenceDiagram
    participant U as User
    participant API as Fluxora API
    participant GH as GitHub API
    participant Q as Job Queue
    participant W as Ingestion Worker
    participant S3 as Object Storage
    participant PG as PostgreSQL

    U->>API: Connect repo (OAuth)
    API->>GH: Verify access + list branches
    API->>PG: Create Repository record (status=pending)
    API->>Q: Enqueue repository.ingest job (idempotency_key=repo_id+commit_sha)
    Q->>W: Deliver job
    W->>GH: Clone/fetch repo content at HEAD
    W->>S3: Store raw snapshot (tarball)
    W->>PG: Create RepositorySnapshot record
    W->>Q: Enqueue analysis.start job
    W-->>API: emit repository.indexed event
    API-->>U: WS push - "Indexed, analyzing..."
```

## 4.5 Code-analysis pipeline

```mermaid
flowchart TB
    Snapshot[Repository Snapshot in S3] --> Detect[Language/Framework Detection]
    Detect --> TSAST[TypeScript Compiler API pass]
    Detect --> TreeSitter[tree-sitter pass - other/fallback]
    TSAST --> Symbols[Symbol Table: functions, classes, exports]
    TSAST --> Imports[Import/Export Graph]
    TSAST --> Routes[API Route Detection - Next.js/Express]
    TSAST --> EventDetect[Event Producer/Consumer Detection - pattern-based]
    TSAST --> DBDetect[DB Reference Detection - ORM call patterns]
    Symbols --> Normalize[Normalization: dedupe, resolve path aliases]
    Imports --> Normalize
    Routes --> Normalize
    EventDetect --> Normalize
    DBDetect --> Normalize
    Normalize --> GraphBuilder[Graph Builder]
    GraphBuilder --> EvidenceWriter[Evidence Writer - file/symbol/line/confidence]
    GraphBuilder --> PGGraph[(Software Graph in Postgres)]
    EvidenceWriter --> PGEvidence[(Evidence Store)]
```

## 4.6 PR impact-analysis flow

```mermaid
sequenceDiagram
    participant U as User/CI
    participant API as Fluxora API
    participant GH as GitHub Webhook
    participant Q as Job Queue
    participant W as Impact Worker
    participant PG as PostgreSQL
    participant AI as AI Reasoning Worker

    GH->>API: pull_request.opened/synchronize webhook
    API->>PG: Create PullRequest + changed files record
    API->>Q: Enqueue impact.analysis.started job
    Q->>W: Deliver job
    W->>PG: Resolve changed files -> changed symbols
    W->>PG: Graph traversal (BFS/DFS, bounded depth) from changed symbols
    W->>PG: Write ImpactAnalysis record + evidence links
    W->>Q: Enqueue ai.analysis.started (with ImpactAnalysis id)
    Q->>AI: Deliver job
    AI->>PG: Fetch structured impact + evidence (read-only)
    AI->>AI: Assemble context, call model, validate structured output
    AI->>PG: Store AIAnalysis (explanation, linked to evidence ids used)
    AI-->>API: emit ai.analysis.completed
    API-->>U: Impact report ready (deterministic result + AI narration)
```

## 4.7 Simulation architecture

```mermaid
flowchart TB
    Scenario[Scenario Definition: target node + failure type] --> Init[Initialize State: all nodes HEALTHY]
    Init --> Propagate[Propagation Engine: apply rule set per edge type]
    Propagate --> Rules{Rule Table}
    Rules -->|CALLS + sync + no fallback| Degrade1[Downstream -> DEGRADED]
    Rules -->|CALLS + circuit breaker present| Degrade2[Downstream -> DEGRADED, capped]
    Rules -->|WRITES + failure| Fail1[Dependent reads -> AT_RISK]
    Rules -->|EMITS + consumer only| Fail2[Consumer -> AT_RISK, producer unaffected]
    Propagate --> Converge{State stable?}
    Converge -->|No| Propagate
    Converge -->|Yes| Output[SimulationResult: per-node state, path, assumptions, confidence]
    Output --> Evidence[(Evidence Store - links each state change to the rule + edge that caused it)]
```

## 4.8 AI architecture (high level)

```mermaid
flowchart LR
    Trigger[Trigger: impact/simulation/chat completed or user question] --> Context[Context Assembler]
    Context --> Fetch1[Fetch structured graph facts - read-only, scoped]
    Context --> Fetch2[Fetch evidence records]
    Context --> Fetch3[Fetch relevant historical AIAnalysis - cache]
    Fetch1 & Fetch2 & Fetch3 --> Prompt[Prompt Builder - versioned templates]
    Prompt --> Gateway[Model Gateway - provider abstraction]
    Gateway --> Primary[Primary Model - Claude]
    Gateway -.fallback.-> Secondary[Fallback Model]
    Primary --> Output[Structured JSON Output]
    Output --> SchemaValidate{Validates against schema?}
    SchemaValidate -->|No| Retry[Retry w/ correction prompt, max N]
    Retry --> Gateway
    SchemaValidate -->|Yes| Ground{Every claim traces to provided evidence id?}
    Ground -->|No| Reject[Reject / flag unsupported claim]
    Ground -->|Yes| Store[(Store AIAnalysis + cost/token metrics)]
```

## 4.9 Event-driven architecture

```mermaid
flowchart TB
    subgraph Producers
        P1[Ingestion Worker]
        P2[Analysis Worker]
        P3[Impact Worker]
        P4[Simulation Worker]
        P5[AI Worker]
    end
    Bus[(Event Bus - Postgres LISTEN/NOTIFY + outbox table, MVP)]
    subgraph Consumers
        C1[WS Gateway -> UI live updates]
        C2[Audit Logger]
        C3[Metrics/Observability]
        C4[Downstream job triggers - e.g. graph.updated -> reindex search]
    end
    P1 & P2 & P3 & P4 & P5 --> Bus --> C1 & C2 & C3 & C4
```

## 4.10 Database/data architecture

See `06-database-schema.md` for full entity design. Summary of engine placement:

```mermaid
flowchart LR
    App[Application/Workers] --> PG[(PostgreSQL: relational entities + graph edges as typed rows + JSONB metadata)]
    App --> Redis[(Redis: cache, job locks, rate limiting, ephemeral session state)]
    App --> S3[(Object Storage: raw repo snapshots, large AST artifacts)]
    App --> Search[(Search Index: Postgres full-text MVP -> OpenSearch at scale)]
```

## 4.11 Authentication/security architecture

```mermaid
flowchart TB
    User --> Clerk[Auth Provider - session/JWT]
    Clerk --> API[Fluxora API]
    API --> RBAC{Tenant + Role Check on every query}
    RBAC -->|allowed| PG[(Postgres - RLS enforced per tenant)]
    API --> Vault[Secrets Manager - GitHub tokens encrypted at rest]
    Vault --> GH[GitHub API - scoped, short-lived tokens]
    Analysis[Analysis Workers] --> Sandbox[Sandboxed execution - no outbound network, resource-limited]
    Sandbox --> Snapshot[Repo snapshot - read-only mount]
```

## 4.12 Deployment architecture

See `13-deployment-architecture.md` for full detail; summary:

```mermaid
flowchart TB
    subgraph Edge
        CDN[CDN/Edge - Next.js static + SSR]
    end
    subgraph App["App Platform (containers)"]
        APIsvc[API service - autoscaled]
        Workers[Worker pool - autoscaled by queue depth]
    end
    subgraph Data
        PGmanaged[(Managed Postgres - primary + read replica)]
        Redismanaged[(Managed Redis)]
        S3managed[(S3-compatible storage)]
    end
    CDN --> APIsvc
    APIsvc --> PGmanaged
    APIsvc --> Redismanaged
    Workers --> PGmanaged
    Workers --> S3managed
    Workers --> Redismanaged
```

## 4.13 Observability architecture

```mermaid
flowchart LR
    App[API + Workers] --> OTel[OpenTelemetry SDK]
    OTel --> Traces[Traces -> Tempo/Jaeger-compatible backend]
    OTel --> Metrics[Metrics -> Prometheus-compatible backend]
    OTel --> Logs[Structured Logs -> log aggregator]
    Metrics --> Dash[Dashboards: ingestion latency, analysis duration, graph size, AI cost/token, failure rates]
    Traces --> Dash
    Logs --> Dash
    Dash --> Alerts[Alerting: job failure rate, LLM error rate, queue backlog]
```
