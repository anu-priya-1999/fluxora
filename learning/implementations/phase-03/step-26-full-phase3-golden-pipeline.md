# Step 26 — Full Phase 3 Golden-Fixture Pipeline Verification

## Purpose & Overview

Step 26 is the final milestone of **Phase 3 — Code Intelligence**.

The goal of Step 26 is to connect and verify all Phase 3 static analysis layers (Steps 18–25) into a coherent, deterministic, multi-stage code-intelligence pipeline executing against the production-grade golden fixture repository (`shadcn-ui/taxonomy`).

---

## Complete Phase 3 Architecture Flow

```
+-----------------------------------------------------------------------+
|                 Immutable Golden Repository Snapshot                  |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 18: Stack Detection (Languages, Frameworks, Manifests)           |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 19: Per-File AST Symbol Extraction (Compiler API)                |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 20: Import/Export Module Graph + TS Path Alias Resolution        |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 21: Next.js Route Handlers & Express Router Detection            |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 22: Event Producer & Consumer Pattern Detection                  |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 23: ORM / Database Interaction Reference Detection              |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 24: WebAssembly Tree-sitter Fallback Pass (JSON/CSS/MD)         |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Step 25: Symbol Normalization & Re-Export / Barrel Resolution         |
+-----------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Canonical Phase 3 Result & Deterministic Verification Summary        |
+-----------------------------------------------------------------------+
```

---

## Important Files

- `apps/workers/src/pipeline/phase3.ts`: Reusable internal Phase 3 pipeline orchestrator function (`runPhase3Pipeline`).
- `apps/workers/src/pipeline/phase3.test.ts`: Integration test suite executing the complete Phase 3 pipeline and hand-verifying source evidence.
- `apps/workers/src/fixtures/golden.ts`: Golden fixture loader helper (`loadGoldenFixtureFileMap`).

---

## Hand-Verified Evidence Summary (`shadcn-ui/taxonomy`)

### 1. Representative Symbols
- **`db`** (`lib/db.ts#L18`): Extracted as exported `constant`, normalized to `sym:lib/db.ts#constant:db:269`.
- **`siteConfig`** (`config/site.ts#L3`): Extracted as exported `constant`, normalized to `sym:config/site.ts#constant:siteConfig:63`.
- **`GET`** (`app/api/posts/route.ts#L12`): Extracted as exported `async function`, normalized to `sym:app/api/posts/route.ts#function:GET:351`.

### 2. Representative Module Edges
- **`app/api/posts/route.ts` -> `lib/db.ts`**: Import specifier `@/lib/db` resolved via `tsconfig.json` path alias `@/*`.
- **`app/layout.tsx` -> `config/site.ts`**: Import specifier `@/config/site` resolved via `tsconfig.json` path alias `@/*`.
- **`components/user-auth-form.tsx` -> `lib/validations/auth.ts`**: Import specifier `@/lib/validations/auth`.

### 3. Representative API Routes
- **`/api/posts`**: File `app/api/posts/route.ts`, HTTP methods `GET`, `POST`.
- **`/api/posts/[postId]`**: File `app/api/posts/[postId]/route.ts`, HTTP methods `GET`, `PATCH`, `DELETE`.

### 4. Database References
- **Prisma `db.post.findMany`**: File `app/api/posts/route.ts` line 23 (`read` operation on `post` model).
- **Prisma `db.user.findFirst`**: File `lib/auth.ts` line 84 (`read` operation on `user` model).

### 5. Event Patterns
- **None present**: The golden taxonomy repository contains zero supported event pattern shapes (0 producers, 0 consumers). Recorded explicitly without fabricating false data.

### 6. Export Resolution / Barrel Collapse
- **`Button`**: `components/ui/button.tsx` export clause `export { Button }` resolved deterministically to canonical symbol `sym:components/ui/button.tsx#constant:Button:...`.

---

## Invariants Kept Strictly

1. **No Code Execution**: Static AST and compiler analysis only. Never imports or evaluates repository code.
2. **No AI / LLM Calls**: Deterministic rule-based analysis.
3. **No Database Persistence**: No graph nodes or database writes created in Phase 3.
4. **Strict Determinism**: Repeated pipeline execution produces identical canonical IDs, ordering, and counts across platforms.
5. **Fixture Integrity**: Verified via SHA-256 hashes, byte sizes, and LF line-ending normalization.

---

## Outcome & Readiness for Phase 4

Phase 3 is **100% Complete**. The extracted, normalized intelligence is ready for Phase 4 graph persistence (`GraphNode`, `GraphEdge`, `Evidence`).

