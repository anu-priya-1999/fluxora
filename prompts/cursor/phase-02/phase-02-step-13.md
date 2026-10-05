Implement ONLY Fluxora Global Step 13: Snapshot packaging + immutable object-storage upload.

Read first:
- docs/architecture/17-implementation-roadmap.md
- docs/architecture/05-component-responsibilities.md
- docs/architecture/06-database-schema.md
- apps/workers/src/ingest/ingest.ts
- apps/workers/src/ingest/handler.ts
- apps/workers/src/ingest/limits.ts
- packages/db/src/repositories/repository-snapshot.ts
- packages/infrastructure/src/object-storage/client.ts
- packages/infrastructure/src/object-storage/filesystem.ts
- packages/infrastructure/src/object-storage/s3.ts
- packages/infrastructure/src/object-storage/paths.ts

Current Step 12 behavior:
GitHub App installation token → resolve ref/commit → download tar.gz → safe extract to ephemeral workDir → return result → handler deletes workDir.

Step 13 must change that to:
extract → package immutable snapshot → SHA-256 checksum → upload through ObjectStorageClient → persist RepositorySnapshot → then delete workDir.

Do NOT implement Step 14 or Step 15. No repository connect API, no WebSocket/event work.

Requirements:

1. Reuse @fluxora/infrastructure ObjectStorageClient.
   - Do not create another storage abstraction.
   - Add @fluxora/infrastructure dependency to @fluxora/workers if needed.
   - Local driver: FilesystemObjectStorage.
   - Production driver: S3ObjectStorage.
   - Add a small worker-side storage factory/config using:
     OBJECT_STORAGE_DRIVER=filesystem|s3
     OBJECT_STORAGE_ROOT for filesystem
     S3_BUCKET
     AWS_REGION
     optional S3_ENDPOINT
     optional S3_FORCE_PATH_STYLE
   - Never hardcode credentials.
   - AWS SDK default credential resolution remains responsible for production credentials.

2. Package the extracted workDir into a .tar.gz snapshot.
   - Use a maintained tar implementation rather than writing a custom tar format unless the repository already has an equivalent.
   - Preserve the existing ingestion limits.
   - Do not load unlimited data into memory.
   - Enforce the existing compressed snapshot size ceiling.
   - Enforce the existing timeout/abort signal during packaging.
   - On packaging failure or size overflow, remove the partial archive and fail the ingestion job safely.

3. Calculate SHA-256 of the final snapshot archive.
   - Hash the exact bytes that are uploaded.
   - Persist the checksum.
   - Make packaging deterministic where practical (stable file ordering, portable metadata) so identical source snapshots produce stable archives/checksums.

4. Extend RepositorySnapshot persistence to retain checksum.
   - Add a forward-only migration after 0011.
   - Add sha256 to repository_snapshots.
   - Add the corresponding shared type field.
   - Validate sha256 as exactly 64 lowercase hexadecimal characters.
   - Keep RepositorySnapshot immutable: no UPDATE policy.
   - Preserve all existing RLS behavior.

5. Preserve idempotency/immutability.
   - One repository + commit SHA must map to one immutable snapshot.
   - Never overwrite an existing snapshot object.
   - Use a stable object key containing organization + repository + snapshot identity, e.g.
     <org>/<repo>/<snapshot-id>/snapshot.tar.gz
   - Generate the snapshot UUID before upload so the storage key can use the snapshot identity.
   - Extend createRepositorySnapshot only as necessary to allow that caller-supplied UUID.
   - If the DB insert discovers an already-existing snapshot for the same repository+commit, verify the immutable metadata/checksum matches; never replace it.
   - If upload succeeds but DB persistence fails, delete only the newly-created orphan object.
   - Never delete an existing immutable snapshot object.

6. storage_uri:
   - Use an explicit logical URI:
     filesystem://<key> for filesystem storage
     s3://<bucket>/<key> for S3
   - Keep the object key/path separate from the URI construction.

7. Integrate Step 13 into the existing production ingestion dependency flow.
   - Do not bypass the existing dependency-injection/testing structure.
   - Add snapshot/storage dependencies to RepositoryIngestDependencies.
   - createProductionIngestDependencies must construct the selected ObjectStorageClient and use the existing DB pool/repository APIs.
   - ingestRepository() must complete packaging/upload/persistence before returning success.
   - The workDir must still be deleted after successful or failed ingestion.
   - Existing Step 12 status/error handling must remain intact.

8. Tests:
   - Unit test snapshot packaging/checksum.
   - Test archive contains expected files.
   - Test archive size/limit failure.
   - Test object upload failure cleans up partial/orphan state correctly.
   - Test successful creation persists RepositorySnapshot with checksum/storage_uri/file_count/size_bytes.
   - Test same repository+commit is idempotent and immutable.
   - Test a conflicting checksum/metadata is rejected.
   - Test workDir cleanup still happens.
   - Reuse a fake ObjectStorageClient in tests; do not hit AWS.
   - Preserve all existing Step 10/11/12 tests.

9. Documentation:
   - Update docs/learning for Step 13:
     learning/notes/12. Repository Snapshot Packaging and Object Storage.md
     learning/implementations/phase-02/step-13-snapshot-packaging-object-storage.md
     learning/interviews/6. Step 13 Snapshot Packaging Object Storage Interview CheatSheet.md
   - Update the FULL docs/DESIGN.md by preserving all existing content and adding Step 13 architecture/details. Do not replace or shorten the existing document.
   - Include file-by-file responsibility map and code-reading order in the Step 13 implementation notes.

10. Verification:
   Run:
   pnpm db:migrate
   pnpm --filter @fluxora/infrastructure typecheck
   pnpm --filter @fluxora/db typecheck
   pnpm --filter @fluxora/workers typecheck
   pnpm --filter @fluxora/infrastructure test
   pnpm --filter @fluxora/workers test
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build

Keep scope strictly to Step 13. Do not modify Step 14/15 behavior.