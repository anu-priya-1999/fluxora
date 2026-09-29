# 21. Demo Script (5–10 minutes, recruiter/interviewer audience)

## Setup (before the call)

- A real, recognizable, moderately complex open-source Next.js/TypeScript repository already connected and analyzed (not a toy example — something the interviewer might recognize or at least respect as "real").
- A specific real PR from that repo's history pre-selected, ideally one with a genuinely non-obvious downstream effect (a change to a shared utility or a payment/auth-adjacent module, not a CSS tweak).
- A pre-built scenario ("what if the database is unavailable") ready to run live.
- Backup: a screen recording of the same flow, in case of live-demo risk (network, API rate limits, etc.).

## Minute 0–1: The pitch, stated plainly

> "Fluxora builds a living model of a codebase — not a chatbot that reads your files and guesses, but a deterministic dependency graph, computed the same way a compiler would, that an AI layer then explains. I'll show you three things: the architecture map, blast-radius analysis on a real PR, and a failure simulation."

## Minute 1–3: Architecture Explorer

- Open the connected repo's Architecture Explorer.
- Pan/zoom to show the graph is real and detailed — click one node (ideally something mid-depth, not top-level) and open the inspector panel.
- **Key beat:** click an edge's evidence citation → jump to the exact file/line that produced it. *"Every line in this graph is backed by an actual line of code — nothing here is guessed."*

## Minute 3–5: PR impact analysis

- Open the pre-selected real PR.
- Show the impact report: direct impact → downstream impact → affected events/workflows.
- **Key beat:** click through 2–3 evidence citations in the impact report, showing the propagation chain (A calls B, B emits event C, C consumed by D) is fully traceable.
- Show the AI explanation panel, visually distinct from the graph-derived facts. *"This paragraph is AI-generated — but notice it can't say anything the graph above didn't already prove. If I ask it to justify a claim, it points back to the same evidence."*

## Minute 5–7: Simulation

- Run (or show pre-run) the "database unavailable" scenario.
- Watch the propagation animate across the graph (healthy → degraded → at_risk).
- **Key beat:** open the "assumptions" panel — *"It's explicit that this assumes no circuit breaker was detected here, because that's what static analysis could verify. That honesty about uncertainty is deliberate, not a limitation I'm hiding."*

## Minute 7–8: The one architectural point worth making explicit

> "The single decision I'd want to highlight: the LLM never decides what depends on what — that's pure deterministic code, unit-tested like any compiler pass. The LLM only narrates results that already exist. That's what makes this trustworthy enough to actually act on, instead of another AI tool you have to double-check."

## Minute 8–10: Q&A buffer / free-form chat

- If time allows, ask the chat interface a live, unscripted question about the repo ("what would break if we removed this API route?") to show it isn't just canned demo paths — it's actually querying the live graph via tool calls.
- Close by briefly gesturing at the roadmap: *"This is the MVP — static analysis, one language ecosystem, rule-based simulation. The architecture is explicitly built so runtime telemetry, multi-language support, and larger-scale simulation are additive, not rewrites."*

## What to have ready if asked to go deeper

- The database schema diagram (`06-database-schema.md`), especially the evidence model.
- The AI context-assembly explanation (`09-ai-architecture.md §9.4`) — this is almost always the most interesting follow-up thread.
- One specific, honest failure case you hit during development and how the confidence/evidence model surfaced it rather than hiding it — a real story here is worth more than a polished flow.
