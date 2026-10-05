-- Phase 2 Step 13: persist SHA-256 of the immutable snapshot archive.
-- Forward-only; applied by packages/db migrate runner.
-- Does not add a connect API, WebSocket events, or snapshot UPDATE policies.
-- Existing Step 11 rows without a checksum cannot be verified and are removed.

ALTER TABLE repository_snapshots
  ADD COLUMN sha256 text;

DELETE FROM repository_snapshots
 WHERE sha256 IS NULL;

ALTER TABLE repository_snapshots
  ALTER COLUMN sha256 SET NOT NULL;

ALTER TABLE repository_snapshots
  ADD CONSTRAINT repository_snapshots_sha256_format
  CHECK (sha256 ~ '^[0-9a-f]{64}$');
