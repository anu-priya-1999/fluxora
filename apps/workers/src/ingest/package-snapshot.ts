import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import tar from "tar";

import {
  permanentIngestionError,
  retryableIngestionError,
} from "./errors.ts";
import type { IngestLimits } from "./limits.ts";

export interface PackagedSnapshot {
  archivePath: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  entries: string[];
}

export async function packageSnapshotArchive(
  workDir: string,
  archivePath: string,
  limits: IngestLimits,
  signal?: AbortSignal,
): Promise<PackagedSnapshot> {
  const entries = await listRelativeFiles(workDir);
  if (entries.length > limits.maxFileCount) {
    throw permanentIngestionError(
      "repository_too_large",
      "repository exceeds the configured file-count limit",
      {
        repositoryStatus: "error",
        details: {
          fileCount: entries.length,
          maxFileCount: limits.maxFileCount,
          maxTotalBytes: limits.maxTotalBytes,
        },
      },
    );
  }

  const limiter = new ArchiveSizeLimiter(limits, signal);
  let packed = false;

  try {
    const pack = tar.c(
      {
        cwd: workDir,
        gzip: false,
        portable: true,
        noMtime: true,
        prefix: "",
        onWriteEntry(entry) {
          entry.mtime = new Date(0);
          entry.uid = 0;
          entry.gid = 0;
          entry.uname = "";
          entry.gname = "";
          entry.mode = entry.mode === undefined ? 0o644 : entry.mode & 0o777;
        },
      },
      entries,
    );

    await pipeline(
      pack,
      createGzip({ level: 6 }),
      new GzipHeaderNormalizer(),
      limiter,
      createWriteStream(archivePath),
      signal === undefined ? undefined : { signal },
    );
    packed = true;
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => undefined);

    if (error instanceof Error && error.name === "IngestionError") {
      throw error;
    }

    if (signal?.aborted === true || isAbortError(error)) {
      throw retryableIngestionError(
        "timeout",
        "repository snapshot packaging exceeded the configured time limit",
      );
    }

    throw permanentIngestionError(
      "unsafe_archive",
      "repository snapshot could not be packaged",
      { repositoryStatus: "error" },
    );
  }

  if (!packed) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw permanentIngestionError(
      "unsafe_archive",
      "repository snapshot could not be packaged",
      { repositoryStatus: "error" },
    );
  }

  try {
    const hashed = await hashArchiveFile(archivePath, limits, signal);
    return {
      archivePath,
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes,
      fileCount: entries.length,
      entries,
    };
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function hashArchiveFile(
  archivePath: string,
  limits: IngestLimits,
  signal?: AbortSignal,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const startedAt = Date.now();

  await pipeline(
    createReadStream(archivePath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (signal?.aborted === true || Date.now() - startedAt > limits.timeoutMs) {
          callback(
            retryableIngestionError(
              "timeout",
              "repository snapshot packaging exceeded the configured time limit",
            ),
          );
          return;
        }

        sizeBytes += chunk.length;
        if (sizeBytes > limits.maxArchiveBytes) {
          callback(
            permanentIngestionError(
              "repository_too_large",
              "repository snapshot exceeds the configured compressed size limit",
              {
                repositoryStatus: "error",
                details: {
                  sizeBytes,
                  maxTotalBytes: limits.maxTotalBytes,
                },
              },
            ),
          );
          return;
        }

        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    signal === undefined ? undefined : { signal },
  );

  return { sha256: hash.digest("hex"), sizeBytes };
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative.length === 0) {
        continue;
      }

      files.push(relative);
    }
  }

  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw permanentIngestionError(
      "unsafe_archive",
      "repository snapshot work directory is not a directory",
      { repositoryStatus: "error" },
    );
  }

  await walk(root);
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return files;
}

class ArchiveSizeLimiter extends Transform {
  private sizeBytes = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly limits: IngestLimits,
    private readonly signal: AbortSignal | undefined,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    if (
      this.signal?.aborted === true ||
      Date.now() - this.startedAt > this.limits.timeoutMs
    ) {
      callback(
        retryableIngestionError(
          "timeout",
          "repository snapshot packaging exceeded the configured time limit",
        ),
      );
      return;
    }

    this.sizeBytes += chunk.length;
    if (this.sizeBytes > this.limits.maxArchiveBytes) {
      callback(
        permanentIngestionError(
          "repository_too_large",
          "repository snapshot exceeds the configured compressed size limit",
          {
            repositoryStatus: "error",
            details: {
              sizeBytes: this.sizeBytes,
              maxTotalBytes: this.limits.maxTotalBytes,
            },
          },
        ),
      );
      return;
    }

    callback(null, chunk);
  }
}

class GzipHeaderNormalizer extends Transform {
  private headerBytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    if (this.headerBytes >= 10) {
      callback(null, chunk);
      return;
    }

    const copy = Buffer.from(chunk);
    for (let index = 0; index < copy.length && this.headerBytes < 10; index += 1) {
      const headerIndex = this.headerBytes;
      if (headerIndex >= 4 && headerIndex <= 7) {
        copy[index] = 0;
      }
      if (headerIndex === 9) {
        copy[index] = 255;
      }
      this.headerBytes += 1;
    }

    callback(null, copy);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
