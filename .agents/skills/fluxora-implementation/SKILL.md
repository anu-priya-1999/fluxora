---
name: fluxora-implementation
description: Implement approved Fluxora engineering tasks while preserving the documented architecture, deterministic core, security boundaries, and testing requirements.
---

# Fluxora Implementation Skill

## When to use

Use this skill when implementing an approved Fluxora feature, phase step, bug fix, refactor, or infrastructure component.

## Process

### 1. Understand

Read:

- `docs/DESIGN.md`
- the relevant files under `docs/architecture/`

Determine the current phase and scope.

### 2. Inspect

Inspect the relevant source files before modifying them.

Do not assume the repository structure from the architecture documents.

### 3. Plan

Provide a concise implementation plan:

- files to create
- files to modify
- dependencies
- tests
- verification commands

### 4. Implement

Implement only the approved scope.

Do not silently introduce future-phase functionality.

### 5. Verify

Run the narrowest useful checks first.

Then run the broader relevant checks.

### 6. Report

Report:

- what changed
- why
- tests run
- verification results
- remaining limitations

## Architectural constraints

The deterministic core remains deterministic.

The LLM does not define graph truth.

Every user-facing deterministic claim must remain traceable to evidence.

PostgreSQL remains the MVP system of record.

Security boundaries must not be weakened for implementation convenience.
