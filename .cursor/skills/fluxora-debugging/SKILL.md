---
name: fluxora-debugging
description: Debug Fluxora failures systematically using reproduction, evidence, minimal fixes, regression tests, and verification.
---

# Fluxora Debugging Skill

## Process

1. Reproduce the failure.
2. Capture the exact error.
3. Identify the smallest failing layer.
4. Trace the data/control flow.
5. Form a concrete hypothesis.
6. Test the hypothesis.
7. Apply the smallest correct fix.
8. Add or update a regression test.
9. Run focused verification.
10. Run broader verification when appropriate.

Do not mask errors with broad exception handling.

Do not solve infrastructure problems by weakening application correctness.

Do not claim a fix is complete until the original failure is reproduced successfully after the change.
