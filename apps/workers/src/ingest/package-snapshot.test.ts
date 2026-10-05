import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import tar from "tar";

import { IngestionError } from "./errors.ts";
import { packageSnapshotArchive } from "./package-snapshot.ts";

const limits = {
  maxFileCount: 50,
  maxTotalBytes: 1024 * 1024,
  maxArchiveBytes: 256 * 1024,
  timeoutMs: 5_000,
};

async function writeTree(root: string): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export {}\n", "utf8");
}

test("packages a snapshot with a stable checksum and expected files", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "fluxora-pack-ok-"));
  const archiveA = `${workDir}.a.tar.gz`;
  const archiveB = `${workDir}.b.tar.gz`;

  try {
    await writeTree(workDir);
    const first = await packageSnapshotArchive(workDir, archiveA, limits);
    const second = await packageSnapshotArchive(workDir, archiveB, limits);

    assert.deepEqual(first.entries, ["README.md", "src/index.ts"]);
    assert.equal(first.fileCount, 2);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.sha256, createHash("sha256").update(await readFile(archiveA)).digest("hex"));
    assert.match(first.sha256, /^[0-9a-f]{64}$/);

    const listed: string[] = [];
    await tar.t({
      file: archiveA,
      gzip: true,
      onReadEntry(entry) {
        if (entry.type === "File") {
          listed.push(entry.path.replace(/\\/g, "/"));
        }
      },
    });
    listed.sort();
    assert.deepEqual(listed, ["README.md", "src/index.ts"]);
    assert.equal(
      await readFile(path.join(workDir, "README.md"), "utf8"),
      "# demo\n",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(archiveA, { force: true });
    await rm(archiveB, { force: true });
  }
});

test("packaging over the compressed size limit removes the partial archive", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "fluxora-pack-big-"));
  const archivePath = `${workDir}.tar.gz`;

  try {
    await writeFile(path.join(workDir, "blob.bin"), Buffer.alloc(64 * 1024, 1));
    await assert.rejects(
      () =>
        packageSnapshotArchive(workDir, archivePath, {
          ...limits,
          maxArchiveBytes: 32,
        }),
      (error: unknown) => {
        assert.ok(error instanceof IngestionError);
        assert.equal(error.code, "repository_too_large");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(existsSync(archivePath), false);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
});
