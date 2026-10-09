# Step 24 — Tree-sitter Fallback Pass Implementation Guide

## Overview

Fluxora Global Step 24 implements a Tree-sitter-based fallback parsing pass for source files that are NOT handled by the primary TypeScript Compiler API pipeline.

## Architectural Boundaries & Invariants

1. **Deterministic Core Invariant**:
   - The fallback pass is strictly static and deterministic.
   - It NEVER executes target repository code.
   - It NEVER imports target repository modules.
   - It NEVER connects to databases, networks, or external services.

2. **Primary vs. Fallback Decision Boundary**:
   - If the existing TypeScript Compiler API/parser can successfully analyze a TypeScript/JavaScript file, Fluxora keeps using the existing compiler pipeline.
   - Tree-sitter NEVER replaces or duplicates successful TypeScript/JavaScript analysis.
   - Tree-sitter runs ONLY when:
     1. The file language is supported by the fallback but is outside the compiler-based TS/JS scope (e.g., JSON, CSS, HTML, Markdown).
     2. The primary parser cannot parse/handle the file safely (e.g., malformed TS/JS) and a fallback grammar is available.

3. **Non-Duplication Rule**:
   - Step 24 exposes generic syntax information (root node, node counts, source ranges, structural units).
   - It does NOT duplicate symbol extraction, import/export extraction, route detection, event detection, or database reference detection.

## Supported Language Scope & Grammar Strategy

- **JSON**: Parsed via `web-tree-sitter` and `tree-sitter-json.wasm`. Structural units: `json_property`.
- **CSS**: Parsed via `web-tree-sitter` and `tree-sitter-css.wasm`. Structural units: `css_rule`.
- **HTML**: Parsed via `web-tree-sitter` and `tree-sitter-html.wasm`. Structural units: `html_element`.
- **Markdown**: Parsed via deterministic Markdown AST parser. Structural units: `markdown_heading`, `code_block`.
- **TypeScript / JavaScript Fallback**: Parsed via `tree-sitter-typescript.wasm` / `tree-sitter-javascript.wasm` only when primary compilation fails.
- **Unknown Extensions**: Return `language: "unsupported"`, `usedFallback: false`, `success: false` with deterministic warning diagnostics.

## Result Contract

Exported from `@fluxora/shared-types`: `TreeSitterParseResult`
- `id`: `${relativePath}#tree-sitter`
- `relativePath`: POSIX relative file path
- `language`: `SupportedLanguage | "unsupported"`
- `parserUsed`: String identifying the parser (e.g., `tree-sitter-json`, `compiler-primary`, `none`)
- `success`: Boolean parse status
- `usedFallback`: Boolean indicating if Tree-sitter was executed
- `diagnostics`: Array of deterministic `TreeSitterDiagnostic`
- `rootNode`: Syntax node range and snippet summary
- `genericStructure`: Generic structural units and node counts

## Verification

Validated via unit tests in `apps/workers/src/tree-sitter/parser.test.ts` covering all 18 requirements without regressing existing Phase 3 detectors (Steps 18–23).

