# 7. API Architecture

## 7.1 Style decision

**REST for resource CRUD and job orchestration, GraphQL-flavored (or a single flexible `/graph/query` endpoint) for graph reads.** Full GraphQL for everything is tempting but adds real complexity (schema stitching, N+1 mitigation via dataloaders, auth-per-field) that isn't justified for the CRUD parts of this product. The graph itself, though, genuinely benefits from a client-specified query shape since different UI views need very different slices of the same graph.

**Decision:** REST for `/repositories`, `/pull-requests`, `/scenarios`, `/analysis-runs` etc. A dedicated `POST /graph/query` endpoint accepting a small, purpose-built query DSL (not full GraphQL) for graph reads — node-type filters, depth-bounded traversal from a starting node, edge-type filters. WebSocket channel for live job/graph updates.

## 7.2 Core endpoints

### Repository connection & management

```
POST   /api/v1/repositories/connect
GET    /api/v1/repositories
GET    /api/v1/repositories/:id
DELETE /api/v1/repositories/:id
POST   /api/v1/repositories/:id/reindex
```

**Example: `POST /api/v1/repositories/connect`**
```json
// Request
{
  "github_installation_id": "12345678",
  "repo_full_name": "acme-corp/checkout-service",
  "branch": "main"
}

// Response 202 Accepted
{
  "repository_id": "repo_9f2a...",
  "status": "pending",
  "job_id": "job_ingest_88a1...",
  "estimated_seconds": 45
}
```

### Analysis runs

```
GET /api/v1/repositories/:id/analysis-runs
GET /api/v1/analysis-runs/:id
```

**Example: `GET /api/v1/analysis-runs/:id`**
```json
{
  "id": "run_7c3e...",
  "repository_id": "repo_9f2a...",
  "status": "completed",
  "coverage_summary": {
    "files_total": 842,
    "files_parsed": 819,
    "files_skipped": 23,
    "skip_reasons": { "unsupported_syntax": 5, "binary_or_generated": 18 }
  },
  "graph_summary": { "node_count": 3241, "edge_count": 12904 },
  "completed_at": "2026-09-20T14:02:11Z"
}
```

### Graph query

```
POST /api/v1/graph/query
```

**Example**
```json
// Request
{
  "analysis_run_id": "run_7c3e...",
  "start_node_id": "node_paymentprovider",
  "direction": "downstream",
  "max_depth": 3,
  "edge_types": ["CALLS", "EMITS_EVENT", "CONSUMES_EVENT"],
  "min_confidence": 0.6
}

// Response
{
  "nodes": [
    { "id": "node_paymentprovider", "type": "module", "name": "PaymentProvider.ts", "confidence": 1.0 },
    { "id": "node_checkoutservice", "type": "module", "name": "CheckoutService.ts", "confidence": 1.0 },
    { "id": "node_orderpaid", "type": "event", "name": "OrderPaid", "confidence": 0.82 }
  ],
  "edges": [
    { "source": "node_paymentprovider", "target": "node_checkoutservice", "type": "CALLS", "confidence": 1.0, "evidence_id": "ev_1123" },
    { "source": "node_checkoutservice", "target": "node_orderpaid", "type": "EMITS_EVENT", "confidence": 0.82, "evidence_id": "ev_1124" }
  ],
  "truncated": false
}
```

### PR impact analysis

```
POST /api/v1/pull-requests/:id/analyze-impact
GET  /api/v1/impact-analyses/:id
```

**Example: `GET /api/v1/impact-analyses/:id`**
```json
{
  "id": "impact_44a1...",
  "pull_request_id": "pr_7781...",
  "analysis_run_id": "run_7c3e...",
  "direct_impact": [
    { "node_id": "node_paymentservice", "name": "Payment Service", "reason": "file changed", "evidence_id": "ev_1001" }
  ],
  "downstream_impact": [
    { "node_id": "node_checkout", "name": "Checkout", "hop_distance": 1, "confidence": 0.95, "evidence_id": "ev_1123" },
    { "node_id": "node_orders", "name": "Orders", "hop_distance": 2, "confidence": 0.87, "evidence_id": "ev_1130" },
    { "node_id": "node_subscriptions", "name": "Subscriptions", "hop_distance": 3, "confidence": 0.71, "evidence_id": "ev_1145" }
  ],
  "affected_events": [{ "name": "OrderPaid", "evidence_id": "ev_1124" }],
  "workflow_impact_summary": ["Checkout", "Subscription renewal", "Revenue event processing"],
  "truncated": false,
  "ai_analysis_id": "ai_9921..."
}
```

### AI explanation

```
GET  /api/v1/ai-analyses/:id
POST /api/v1/ai-analyses/:id/regenerate
POST /api/v1/chat/query   // free-form architecture Q&A, scoped to a repo + analysis run
```

**Example: `POST /api/v1/chat/query`**
```json
// Request
{
  "repository_id": "repo_9f2a...",
  "analysis_run_id": "run_7c3e...",
  "question": "What would break if the Redis cache went down?"
}

// Response
{
  "answer": "Based on the current graph, three services read from the Redis cache node directly: SessionService, RateLimiter, and CheckoutService (cache-aside pattern). If Redis is unavailable, SessionService has no detected fallback (evidence: session.ts:44), so user sessions would likely fail. CheckoutService has a fallback path to Postgres for cart state (evidence: cart-store.ts:112), so it would degrade in latency but likely stay functional.",
  "evidence_ids": ["ev_2001", "ev_2002", "ev_2003"],
  "confidence": "high",
  "ai_analysis_id": "ai_9955..."
}
```

### Simulation

```
POST /api/v1/scenarios
POST /api/v1/scenarios/:id/run
GET  /api/v1/simulations/:id
```

**Example: `POST /api/v1/scenarios`**
```json
{
  "repository_id": "repo_9f2a...",
  "name": "Payment provider unavailable",
  "target_node_id": "node_paymentprovider",
  "failure_type": "unavailable"
}
```

**Example: `GET /api/v1/simulations/:id`**
```json
{
  "id": "sim_3312...",
  "scenario_id": "scn_881...",
  "results": [
    { "node_id": "node_paymentprovider", "state": "failed", "rule_applied": "target_failure" },
    { "node_id": "node_checkout", "state": "degraded", "rule_applied": "CALLS+sync+no_fallback", "evidence_id": "ev_3001" },
    { "node_id": "node_orders", "state": "degraded", "rule_applied": "propagate_degraded", "evidence_id": "ev_3002" },
    { "node_id": "node_subscriptions", "state": "at_risk", "rule_applied": "propagate_at_risk", "evidence_id": "ev_3003" }
  ],
  "assumptions": ["No circuit breaker detected on CheckoutService->PaymentProvider call"],
  "ai_analysis_id": "ai_9977..."
}
```

### Jobs (polling fallback to WS)

```
GET /api/v1/jobs/:id
```

## 7.3 Cross-cutting API conventions

- **Auth:** Bearer JWT (session token from auth provider) on every request; `organization_id` derived from token, never trusted from client payload.
- **Long-running work:** Always `202 Accepted` + `job_id`, never a synchronous blocking call for anything touching ingestion/analysis/AI.
- **Pagination:** Cursor-based (`?cursor=...&limit=...`) on all list endpoints.
- **Idempotency:** Client-supplied `Idempotency-Key` header honored on all POST endpoints that trigger jobs.
- **Versioning:** URL-prefixed (`/api/v1/...`); breaking changes get a new prefix, not header-based versioning, for simplicity and debuggability.
- **Error shape:** consistent `{ "error": { "code": "...", "message": "...", "details": {...} } }` across all endpoints.
- **Rate limiting:** per-organization, enforced via Redis token bucket, surfaced via `429` + `Retry-After`.
