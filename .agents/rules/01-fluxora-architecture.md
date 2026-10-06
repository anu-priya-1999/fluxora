---
trigger: model_decision
description: "Fluxora architecture and implementation-boundary rules."
---

# Fluxora Architecture Rule

Use `docs/architecture/` as the authoritative architecture package.

Before making an architecture-sensitive implementation change, inspect the relevant source document.

Prefer the documented MVP architecture.

PostgreSQL remains the MVP graph/system-of-record database.

Evidence is cross-cutting and must remain traceable.

Do not introduce Neo4j, Kafka, Kubernetes, or additional infrastructure without an explicit documented trigger.
