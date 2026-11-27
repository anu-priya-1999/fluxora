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
POST /api/v1/ai-analyses/:id/regenerate (future)
POST /api/v1/chat/query   // free-form architecture Q&A, scoped to a repo + analysis run
```

**Example: `GET /api/v1/ai-analyses/:id`**
```json
// Response 200 OK (Completed)
{
  "id": "11111111-1111-4111-8111-111111111111",
  "subject_type": "impact_analysis",
  "subject_id": "22222222-2222-4222-8222-222222222222",
  "status": "completed",
  "model_used": "claude-sonnet-5-5",
  "prompt_version": "impact-explain-v1",
  "input_evidence_ids": ["ev-1001", "ev-1002"],
  "output_text": "PaymentService modifications affect downstream checkout and billing queues.",
  "output_structured": {
    "summary": "PaymentService modifications affect downstream checkout and billing queues.",
    "claims": [
      {
        "text": "PaymentService directly modified handler logic.",
        "evidence_ids": ["ev-1001"]
      },
      {
        "text": "CheckoutService imports modified payment client.",
        "evidence_ids": ["ev-1002"]
      }
    ],
    "confidence": "high",
    "caveats": ["Analysis bounded to 3-hop traversal depth."]
  },
  "validation_status": "passed",
  "token_count": 280,
  "cost_usd": 0.002450,
  "latency_ms": 750,
  "schema_version": "impact-explanation-output-v1",
  "created_at": "2026-11-22T20:00:00.000Z",
  "updated_at": "2026-11-22T20:00:01.000Z"
}

// Response 200 OK (Validation Rejected - Raw invalid model output withheld)
{
  "id": "11111111-1111-4111-8111-111111111111",
  "subject_type": "impact_analysis",
  "subject_id": "22222222-2222-4222-8222-222222222222",
  "status": "rejected",
  "model_used": "claude-sonnet-5-5",
  "prompt_version": "impact-explain-v1",
  "input_evidence_ids": ["ev-1001"],
  "output_text": null,
  "output_structured": null,
  "validation_status": "rejected",
  "token_count": 250,
  "cost_usd": 0.002100,
  "latency_ms": 600,
  "schema_version": "impact-explanation-output-v1",
  "created_at": "2026-11-22T20:00:00.000Z",
  "updated_at": "2026-11-22T20:00:01.000Z"
}
```

**Example: `POST /api/v1/chat/query`**
```json
// Request
{
  "repository_id": "repo_9f2a...",
  "analysis_run_id": "run_7c3e...",
  "question": "What would break if the Redis cache went down?"
}

// Response (202 Accepted — Async chat.query job enqueued, poll GET /api/v1/ai-analyses/:id)
{
  "chat_query_id": "55555555-5555-4555-8555-555555555555",
  "ai_analysis_id": "44444444-4444-4444-8444-444444444444",
  "status": "pending",
  "job_id": "job_chat_9955..."
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
  "ai_analysis_id": "ai_9977...",
  "ai_analysis_status": "completed"
}
```

*Note on AI Simulation Narration (Global Step 63):* `ai_analysis_id` and `ai_analysis_status` (`pending` | `completed` | `rejected` | `failed`) are populated if an AI narration task is associated with this simulation run. Deterministic simulation execution results remain fully valid and accessible even if `ai_analysis_id` is null or `ai_analysis_status` is failed or rejected.

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
