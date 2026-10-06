---
trigger: model_decision
description: "Fluxora testing and verification requirements."
---

# Fluxora Testing Rule

Tests are part of the implementation, not a final cleanup step.

Prioritize tests for:
- deterministic graph behavior
- evidence creation
- graph traversal
- depth limits
- cycle handling
- simulation rules
- idempotent jobs
- tenant isolation
- API contracts

When implementing a bug fix:
1. reproduce the failure
2. add or identify the regression test
3. implement the fix
4. run the focused test
5. run the broader relevant suite
