Fluxora Global Step 11 ONLY — Repository, RepositorySnapshot, and Commit data model.

Use the canonical architecture and roadmap in the repository as the source of truth.

Implement ONLY Step 11. Do not implement Step 12+:
- no repository ingestion
- no GitHub repository fetching
- no installation access tokens
- no S3/object-storage upload
- no ingestion worker
- no repository-connect API
- no WebSocket ingestion progress
- no repository UI beyond anything strictly required by existing architecture

ARCHITECTURE SCOPE

Repository:
- id
- organization_id
- github_repo_id
- name
- default_branch
- connection_status: pending | active | needs_reauth | error
- last_indexed_at
- created_at

RepositorySnapshot:
- id
- repository_id
- commit_sha
- ref
- storage_uri
- file_count
- size_bytes
- created_at
- immutable; never overwrite an existing snapshot

Commit:
- id
- repository_id
- sha
- author
- message
- committed_at
- parent_shas

DESIGN REQUIREMENTS

- Repository belongs directly to Organization.
- RepositorySnapshot and Commit belong to Repository.
- Child tables inherit tenancy through the Repository -> Organization relationship.
- Preserve the existing PostgreSQL + FORCE RLS architecture.
- Do not add organization_id to child tables unless the canonical architecture requires it.
- Follow existing UUID, timestamp, enum, FK, constraint, index, repository-layer, migration, and RLS conventions.
- Do not modify already-applied migrations.
- Determine the correct next migration number from the actual repository rather than guessing.

IMPLEMENTATION

1. Inspect existing DB migrations and repository/data-access patterns first.
2. Create the forward-only Step 11 migration.
3. Create the three tables with appropriate:
   - primary keys
   - foreign keys
   - uniqueness constraints
   - check constraints
   - indexes
4. Implement tenant-safe RLS:
   - repository policies directly use organization_id/current tenant
   - snapshot/commit policies enforce tenant access through the parent repository
5. Implement repository/data-access modules using the existing project conventions.
6. Add focused tests for:
   - repository creation/read/update
   - connection_status changes
   - snapshot creation and immutability semantics
   - commit creation/read
   - repository -> snapshot relationship
   - repository -> commit relationship
   - cross-tenant repository denial
   - cross-tenant snapshot denial
   - cross-tenant commit denial
7. Do not touch the completed Step 10 GitHub installation flow except where an existing type/API dependency strictly requires it.

LEARNING PACKAGE — REQUIRED

After implementation, create/update all of these:

A. PERSONAL LEARNING NOTES
Create the Step 11 learning note using the existing learning-file conventions.

Explain in plain English:
- why Repository is a tenant-owned resource
- why Snapshot is immutable
- Repository vs RepositorySnapshot vs Commit
- why a snapshot is not the same thing as a commit
- why parent-chain tenancy is used for child tables
- how foreign keys protect integrity
- how indexes map to expected query paths
- how PostgreSQL RLS evaluates repository/snapshot/commit access
- how this design prepares Step 12 ingestion
- important trade-offs and alternatives
- mistakes/pitfalls to remember
- a small worked example from GitHub repository -> commit -> snapshot

B. STEP IMPLEMENTATION NOTES
Create/update the Phase 2 Step 11 implementation note.

Include:
- objective
- acceptance criteria
- exact files changed
- what every changed file is responsible for
- migration explanation
- schema explanation
- constraint/index explanation
- RLS explanation
- test strategy
- verification commands/results
- production deployment considerations
- recommended code-reading order
- file-by-file responsibility map
- end-to-end Step 11 lifecycle

C. INTERVIEW CHEAT SHEET
Create/update the Step 11 interview cheat sheet.

Cover senior-level questions such as:
- Repository vs snapshot vs commit
- Why snapshots are immutable
- Why not store repository contents directly in PostgreSQL
- Why not put organization_id on every child table
- How parent-chain RLS works
- How FK constraints help
- How uniqueness should be designed for GitHub repo IDs
- What indexes are needed and why
- How this model supports re-indexing/history
- How concurrent writes should be handled
- What happens if a repository is disconnected/reconnected
- How this design prepares ingestion workers
- What would change at larger scale
- What parts are source-of-truth vs derived data

D. DESIGN.md
Update docs/DESIGN.md to include Step 11 accurately.

IMPORTANT:
- Preserve ALL existing DESIGN.md content.
- Never replace, shorten, summarize, or delete existing sections.
- Add/modify only the sections required to reflect the actual Step 11 implementation.
- Keep terminology consistent with the repository's canonical architecture.
- Do not document functionality that was not implemented.

E. LEARNING/INTERVIEW REFERENCES
Where appropriate, cross-reference the new Step 11 note with the relevant architecture sections and implementation files.

VERIFICATION

Run:

pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
pnpm build

Then verify the actual local PostgreSQL schema and RLS behavior.

FINAL RESPONSE

Report:
1. Step 11 status
2. exact migration filename
3. tables created
4. constraints/indexes
5. RLS design
6. files changed
7. learning files created/updated
8. DESIGN.md sections updated
9. tests/results
10. recommended code-reading order
11. any known limitation

Do not start Step 12.