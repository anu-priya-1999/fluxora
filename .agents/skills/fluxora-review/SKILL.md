---
name: fluxora-review
description: Review Fluxora implementation changes against architecture, security, correctness, testing, and scope.
---

# Fluxora Review Skill

Review changes in this order:

1. Correctness
2. Architecture compliance
3. Security
4. Tenant isolation
5. Deterministic/AI boundary
6. Evidence provenance
7. Error handling
8. Tests
9. Performance
10. Scope creep

Flag:

- undocumented architecture changes
- missing evidence
- hidden nondeterminism
- unsafe repository handling
- tenant leakage
- unnecessary dependencies
- future-phase implementation
- missing regression tests

Prefer concrete findings over stylistic commentary.
