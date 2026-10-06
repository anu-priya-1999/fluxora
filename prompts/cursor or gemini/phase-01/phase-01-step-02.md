Read AGENTS.md, DESIGN.md, .cursor/rules/, and Fluxora architecture docs 00–22.

Implement ONLY Phase 1 Step 2 from roadmap 17:

- configure the existing packages/db for the local PostgreSQL database
- add migration infrastructure
- create Organization and User persistence
- implement tenant isolation with PostgreSQL RLS
- keep database access inside packages/db
- keep shared contracts in packages/shared-types
- use the existing local PostgreSQL setup; do not introduce Docker

Do not implement auth UI, GitHub OAuth, Redis, jobs, ingestion, graph, AI, or later-phase features.

Keep the implementation production-oriented but minimal.

Do not run tests, typecheck, or build.

Update learning/task notes with:
- what was implemented
- why the database architecture is structured this way
- all relevant concepts and terminology
- Fluxora-specific explanation of each concept
- important security/architecture decisions
- likely interview questions and answer points
- files changed
- remaining Phase 1 work

Do not fabricate experience or results.

STOP after Step 2.