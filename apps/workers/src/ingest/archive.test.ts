import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { extractTarGz, resolveSafeArchivePath } from "./archive.ts";
import { IngestionError } from "./errors.ts";
import { gzipTar } from "./tar-fixture.ts";

const limits = {
  maxFileCount: 10,
  maxTotalBytes: 1024,
  maxArchiveBytes: 4096,
  timeoutMs: 5_000,
};

test("extracts a well-formed GitHub-style tarball and strips the root directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fluxora-archive-ok-"));
  try {
    const archive = gzipTar([
      {
        name: "repo-sha/README.md",
        body: Buffer.from("hello", "utf8"),
      },
      {
        name: "repo-sha/src/index.ts",
        body: Buffer.from("export {}", "utf8"),
      },
    ]);

    const result = await extractTarGz(Readable.from(archive), dir, limits);
    assert.equal(result.fileCount, 2);
    assert.equal(await readFile(path.join(dir, "README.md"), "utf8"), "hello");
    assert.equal(
      await readFile(path.join(dir, "src/index.ts"), "utf8"),
      "export {}",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects path traversal entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fluxora-archive-trav-"));
  try {
    const archive = gzipTar([
      {
        name: "repo-sha/../../etc/passwd",
        body: Buffer.from("nope", "utf8"),
      },
    ]);

    await assert.rejects(
      () => extractTarGz(Readable.from(archive), dir, limits),
      (error: unknown) => {
        assert.ok(error instanceof IngestionError);
        assert.equal(error.code, "unsafe_archive");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects symlink entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fluxora-archive-link-"));
  try {
    const archive = gzipTar([
      {
        name: "repo-sha/link",
        typeFlag: "2",
      },
    ]);

    await assert.rejects(
      () => extractTarGz(Readable.from(archive), dir, limits),
      (error: unknown) => {
        assert.ok(error instanceof IngestionError);
        assert.equal(error.code, "unsafe_archive");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects archives that exceed uncompressed size limits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fluxora-archive-size-"));
  try {
    const archive = gzipTar([
      {
        name: "repo-sha/big.txt",
        body: Buffer.alloc(2048, 1),
      },
    ]);

    await assert.rejects(
      () => extractTarGz(Readable.from(archive), dir, limits),
      (error: unknown) => {
        assert.ok(error instanceof IngestionError);
        assert.equal(error.code, "repository_too_large");
        assert.equal(error.repositoryStatus, "error");
        assert.ok((error.details.sizeBytes ?? 0) > 0);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveSafeArchivePath rejects escapes from the working directory", () => {
  const root = path.resolve("/tmp/fluxora-ingest-safe");
  assert.throws(
    () => resolveSafeArchivePath(root, "../outside"),
    IngestionError,
  );
});
