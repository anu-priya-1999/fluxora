# Step 13 — Repository Snapshot Storage

## Objective

Turn the temporary repository tree produced by Step 12 into a deterministic, checksum-verified, tenant-scoped, durable repository snapshot.

The implementation reuses the existing object-storage and PostgreSQL abstractions.

## Responsibility boundary

```text
Step 12
GitHub
  ↓
download + validate + extract
  ↓
temporary workDir

Step 13
workDir
  ↓
deterministic packaging
  ↓
snapshot.tar.gz
  ↓
SHA-256
  ↓
object storage
  ↓
RepositorySnapshot row
  ↓
cleanup
```

Step 13 does not add a new queue, repository connect API, WebSocket progress, AST analysis, graph construction, or AI reasoning.

---

## Exact implementation shape

### Worker packaging

Primary files:

- `apps/workers/src/ingest/package-snapshot.ts`
- `apps/workers/src/ingest/package-snapshot.test.ts`
- `apps/workers/src/ingest/persist-snapshot.ts`
- `apps/workers/src/ingest/snapshot-store.ts`
- `apps/workers/src/ingest/storage-config.ts`
- `apps/workers/src/ingest/storage-config.test.ts`

The package operation:

1. recursively lists regular files under the extracted work directory;
2. skips symbolic links;
3. sorts normalized relative paths;
4. enforces the file-count limit;
5. writes a portable tar stream;
6. gzip-compresses it deterministically;
7. enforces the compressed archive limit;
8. writes `snapshot.tar.gz`;
9. hashes the exact archive bytes with SHA-256;
10. returns archive path, checksum, size, file count, and entries.

The archive is one deterministic object, not one object per source file.

---

## Determinism

The archive is designed to be reproducible for the same repository tree.

Important choices:

- stable relative-path ordering;
- portable tar metadata;
- no archive modification time;
- normalized gzip header bytes;
- stable compression settings.

The final SHA-256 is calculated over the exact archive bytes that will be persisted.

---

## Object-storage persistence

`persist-snapshot.ts` coordinates:

```text
packageSnapshotArchive()
        ↓
snapshot.tar.gz
        ↓
storage.put()
        ↓
createRepositorySnapshot()
```

The object name is:

```text
snapshot.tar.gz
```

The object key is tenant-scoped using the existing snapshot object-key helper:

```text
{organizationId}/{repositoryId}/{snapshotId}/snapshot.tar.gz
```

The upload includes the SHA-256 as object metadata.

The implementation checks the archived byte length before persisting metadata so the database does not describe a different size than the stored object.

---

## PostgreSQL persistence

`RepositorySnapshot` metadata includes:

```text
id
repositoryId
commitSha
ref
storageUri
sha256
fileCount
sizeBytes
createdAt
```

The SHA-256 field was added through:

```text
packages/db/migrations/0012_repository_snapshot_sha256.sql
```

The schema preserves the immutability model established in Step 11.

The uniqueness boundary remains:

```text
(repository_id, commit_sha)
```

A replay of the same compatible immutable snapshot returns the existing row instead of mutating it.

---

## Partial-failure handling

Two storage systems are involved:

```text
Object storage
PostgreSQL
```

The implementation explicitly handles:

### Upload succeeds, DB persistence fails

```text
storage.put()        ✅
createSnapshot()     ❌
        ↓
storage.delete()     ✅ cleanup
```

### Packaging fails

```text
archive creation     ❌
        ↓
remove partial archive
```

### Temporary archive cleanup

The generated temporary `.tar.gz` is removed in the persistence function's `finally` path.

This prevents local artifact leakage after success or failure.

---

## Worker integration

After Step 12 extraction succeeds, the existing `repository.ingest` flow calls `persistPackagedSnapshot()`.

The persistence function receives:

- organization id;
- repository id;
- resolved commit SHA;
- requested ref;
- work directory;
- extracted file count;
- ingestion limits;
- object-storage client;
- storage URI builder;
- snapshot persistence adapter.

After snapshot persistence succeeds:

```text
repository status → active
```

The handler returns snapshot identity and metadata and then cleans up the extraction directory.

No new queue or retry system was introduced.

---

## Retry and idempotency

Step 13 preserves the existing worker retry classification.

The snapshot layer does not introduce a second retry mechanism.

The logical snapshot identity is still tied to:

```text
(repository_id, commit_sha)
```

Re-running the same successful ingestion must not mutate the existing immutable snapshot.

If a replay path uploads a redundant object but an existing immutable DB row wins, the redundant object is cleaned up rather than replacing the stored snapshot.

---

## Storage configuration

`storage-config.ts` supports:

```text
OBJECT_STORAGE_DRIVER=filesystem
OBJECT_STORAGE_ROOT=...

OBJECT_STORAGE_DRIVER=s3
S3_BUCKET=...
AWS_REGION=...
S3_ENDPOINT=...
S3_FORCE_PATH_STYLE=...
```

The driver defaults to filesystem for local development.

The worker receives an object-storage client through its dependency boundary rather than hard-coding a concrete storage adapter into the ingestion algorithm.

---

## Tests

Step 13 added focused coverage for:

```text
deterministic snapshot checksum
archive contents
compressed-size limit
partial archive cleanup
filesystem/S3 storage configuration
snapshot SHA-256 migration contract
snapshot persistence
worker integration
idempotent re-ingestion
```

Full worker suite:

```text
24 passed
0 failed
```

Workspace verification after the implementation:

```text
pnpm typecheck  ✅
pnpm lint       ✅
pnpm test       ✅
```

---

## Acceptance criteria

- [x] deterministic repository archive
- [x] stable SHA-256 checksum
- [x] compressed-size limit enforced
- [x] partial archive cleaned on failure
- [x] existing object-storage abstraction reused
- [x] tenant-scoped snapshot object key
- [x] SHA-256 persisted with snapshot metadata
- [x] immutable `RepositorySnapshot`
- [x] uploaded object deleted when DB persistence fails
- [x] temporary packaging artifact cleaned
- [x] existing retry/idempotency architecture preserved
- [x] worker integration verified
- [x] complete worker suite passes
- [x] workspace typecheck/lint/test pass

## Important implementation lesson

The Step 13 runtime tests initially exposed two Node 24 compatibility issues:

1. TypeScript parameter properties are not supported by Node's strip-only runtime.
2. Passing `undefined` as an extra `pipeline()` argument is invalid.

The final implementation uses explicit fields and conditional pipeline options.

Useful rule:

> With `node --experimental-strip-types`, keep runtime-tested TypeScript syntax erasable, and don't pass `undefined` where Node expects another stream or options object.

## Next boundary

Step 14 is the repository-connect API/orchestration boundary. It should start the existing `repository.ingest` flow asynchronously rather than moving heavy ingestion into the HTTP request.
