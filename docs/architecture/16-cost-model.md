# 16. Cost Model

## 16.1 Cost drivers, ranked

1. **LLM API calls (dominant cost driver, by far, at any realistic scale).** Every impact analysis, every simulation, every chat query that triggers an AI explanation is a metered cost. This is the line item that actually determines unit economics.
2. **Analysis worker compute.** AST parsing of large repositories is CPU/memory-intensive; this scales with repo size and re-analysis frequency (every push to a connected branch, potentially), not with user count directly.
3. **Storage.** Raw repository snapshots (S3) accumulate across `AnalysisRun` history; graph/evidence tables grow with repo size × analysis frequency.
4. **Database compute.** Read-heavy graph queries + write-heavy ingestion, scaling with active usage.
5. **Egress/CDN/API compute.** Comparatively minor for this product category (not media-heavy).

## 16.2 LLM cost optimization strategies

- **Task-appropriate model selection** (`09-ai-architecture.md §9.2`): not every call needs the most capable/expensive model. A quick chat clarification or a low-complexity impact explanation can route to a cheaper model tier; complex free-form architecture Q&A or nuanced simulation narration routes to the primary model.
- **Response caching:** identical `(subject_type, subject_id, prompt_version, evidence_id_set)` tuples produce identical explanations deterministically enough to cache — an `AIAnalysis` is only regenerated on explicit user request or when the underlying evidence changes, not on every view. This alone likely eliminates a large fraction of would-be duplicate calls (users re-viewing the same PR's impact report multiple times).
- **Context minimization** (`09-ai-architecture.md §9.4.2`): scoping context tightly to exactly the relevant `ImpactAnalysis`/`Evidence` records, not the whole graph, directly reduces input token cost — this is a case where the reliability-motivated design decision (P2/P7, scoped grounded context) and the cost-motivated decision point the same direction.
- **Truncation with explicit notice** (§9.4.4) rather than always sending maximal context — bounding worst-case cost per call.
- **Rate limiting free-form chat** per organization/session to prevent runaway cost from an abusive or looping client.
- **Batching where applicable:** if multiple impact analyses complete in a short window (e.g., a bulk repo re-index), batch-eligible AI explanation requests where the provider offers batch-pricing discounts for non-latency-sensitive narration (this doesn't apply to interactive chat, only to background narration generation).
- **Prompt efficiency as an ongoing eval metric** (`12-testing-strategy.md §12.5`): cost per call is tracked alongside quality, so prompt iterations that increase cost without a corresponding quality gain are visible and treated as a regression, not silently accepted.

## 16.3 Analysis compute optimization

- **Incremental analysis (future optimization, real win):** instead of fully re-parsing an entire repository on every push, compute a file-level diff against the last `AnalysisRun` and re-parse only changed files + their direct dependents, re-using unaffected symbol/edge data from the prior run. This is a meaningful engineering investment deferred past MVP (full-repo re-analysis is fine at MVP scale) but becomes important as repos and push frequency grow.
- **Right-sizing worker instances:** analysis workers get more CPU/memory per instance than lighter job types (impact analysis is comparatively cheap graph traversal, not heavy parsing) — avoids over-provisioning the whole fleet to the needs of the most expensive job type.
- **Depth/size caps** (`05-component-responsibilities.md §5.9`, `§11.10`) bound worst-case compute per job, protecting against runaway cost from pathological inputs.

## 16.4 Storage optimization

- **Snapshot retention policy:** keep raw file content (S3) for only the last N `AnalysisRun`s per repository (configurable, e.g., last 5), while retaining the much smaller derived graph/evidence data (Postgres) indefinitely — most of the product's value (the graph, the history of impact analyses) doesn't require keeping every historical raw snapshot forever.
- **S3 lifecycle rules:** transition older snapshots to cheaper storage tiers (infrequent access) automatically rather than manual cleanup.

## 16.5 What Fluxora explicitly does *not* do to save cost (and why)

- **Does not** skip evidence-writing to save DB write volume — evidence is the product's core trust mechanism (Principle P2); this cost is non-negotiable, not a lever.
- **Does not** send full raw repository content to the LLM to "save engineering time" on context assembly — this would actually be *more* expensive (far more input tokens) as well as less safe (`11-security-architecture.md §11.9`), so the reliability-correct design is also the cost-correct design here.
- **Does not** cache AI explanations indefinitely without invalidation — a stale explanation referencing evidence that's since been superseded by a new `AnalysisRun` is worse than the cost of regenerating it.

## 16.6 Cost visibility

Per-organization cost dashboards (`04-system-architecture-diagrams.md §4.13`) breaking down LLM spend, compute spend, and storage spend — both as an internal operating metric and as the eventual foundation for usage-based pricing tiers if Fluxora were a real commercial product.
