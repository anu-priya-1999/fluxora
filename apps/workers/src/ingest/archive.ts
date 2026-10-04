import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Readable } from "node:stream";

import {
  permanentIngestionError,
  retryableIngestionError,
} from "./errors.ts";
import type { IngestLimits } from "./limits.ts";

export interface ExtractResult {
  fileCount: number;
  totalBytes: number;
}

export async function extractTarGz(
  archive: Readable,
  destination: string,
  limits: IngestLimits,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const extractor = new TarExtractWritable(destination, limits, signal);
  const gunzip = createGunzip();

  try {
    await pipeline(archive, gunzip, extractor);
  } catch (error) {
    if (error instanceof Error && error.name === "IngestionError") {
      throw error;
    }

    if (signal?.aborted === true) {
      throw retryableIngestionError(
        "timeout",
        "repository archive extraction exceeded the configured time limit",
      );
    }

    throw permanentIngestionError(
      "unsafe_archive",
      "repository archive could not be extracted safely",
      { repositoryStatus: "error" },
    );
  }

  return { fileCount: extractor.fileCount, totalBytes: extractor.totalBytes };
}

class TarExtractWritable extends Writable {
  fileCount = 0;
  totalBytes = 0;

  private buffer = Buffer.alloc(0);
  private remainingFileBytes = 0;
  private remainingPadding = 0;
  private currentPath: string | null = null;
  private currentWrite: Promise<void> = Promise.resolve();
  private longName: string | null = null;
  private pendingMeta: { kind: "longname" | "pax"; chunks: Buffer[] } | null =
    null;
  private ended = false;
  private readonly openedFiles = new Set<string>();
  private readonly destination: string;
  private readonly limits: IngestLimits;
  private readonly signal: AbortSignal | undefined;
  private readonly startedAt = Date.now();

  constructor(
    destination: string,
    limits: IngestLimits,
    signal: AbortSignal | undefined,
  ) {
    super();
    this.destination = path.resolve(destination);
    this.limits = limits;
    this.signal = signal;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.enqueue(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.enqueue(null, callback);
  }

  private async enqueue(
    chunk: Buffer | null,
    callback: (error?: Error | null) => void,
  ): Promise<void> {
    this.currentWrite = this.currentWrite.then(async () => {
      this.checkBudget();
      if (chunk !== null) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        await this.processBuffer();
      } else {
        await this.processBuffer();
        if (
          this.remainingFileBytes > 0 ||
          (this.buffer.length > 0 && !isZeroBlock(this.buffer))
        ) {
          throw permanentIngestionError(
            "unsafe_archive",
            "repository archive ended before all entries were extracted",
            { repositoryStatus: "error" },
          );
        }
        this.ended = true;
      }
    });

    try {
      await this.currentWrite;
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async processBuffer(): Promise<void> {
    while (!this.ended) {
      this.checkBudget();

      if (this.remainingFileBytes > 0) {
        const take = Math.min(this.buffer.length, this.remainingFileBytes);
        if (take === 0) {
          return;
        }

        const slice = this.buffer.subarray(0, take);
        this.buffer = this.buffer.subarray(take);
        this.remainingFileBytes -= take;
        this.totalBytes += take;
        this.ensureSizeLimit();

        if (this.pendingMeta !== null) {
          this.pendingMeta.chunks.push(slice);
        } else if (this.currentPath !== null) {
          await this.appendFile(this.currentPath, slice);
        }

        if (this.remainingFileBytes === 0) {
          if (this.pendingMeta !== null) {
            this.applyPendingMeta();
          }
          this.currentPath = null;
        }

        continue;
      }

      if (this.remainingPadding > 0) {
        const take = Math.min(this.buffer.length, this.remainingPadding);
        if (take === 0) {
          return;
        }
        this.buffer = this.buffer.subarray(take);
        this.remainingPadding -= take;
        continue;
      }

      if (this.buffer.length < 512) {
        return;
      }

      const header = this.buffer.subarray(0, 512);
      this.buffer = this.buffer.subarray(512);

      if (isZeroBlock(header)) {
        this.ended = true;
        this.buffer = Buffer.alloc(0);
        return;
      }

      await this.consumeHeader(header);
    }
  }

  private async consumeHeader(header: Buffer): Promise<void> {
    if (!validTarChecksum(header)) {
      throw permanentIngestionError(
        "unsafe_archive",
        "repository archive contains a corrupted tar header",
        { repositoryStatus: "error" },
      );
    }

    const typeFlag = header[156] ?? 0;
    const size = parseOctal(header.subarray(124, 136));
    const rawName = this.longName ?? readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const headerName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const type = String.fromCharCode(typeFlag);
    this.longName = null;

    this.remainingPadding = (512 - (size % 512)) % 512;
    this.remainingFileBytes = size;

    if (type === "L" || type === "x") {
      this.currentPath = null;
      this.pendingMeta = { kind: type === "L" ? "longname" : "pax", chunks: [] };
      if (size === 0) {
        this.applyPendingMeta();
      }
      return;
    }

    if (type === "K" || type === "g") {
      this.currentPath = null;
      return;
    }

    if (type === "1" || type === "2" || type === "3" || type === "4" || type === "6") {
      throw permanentIngestionError(
        "unsafe_archive",
        "repository archive contains a symlink, hard link, or device file",
        { repositoryStatus: "error" },
      );
    }

    if (type !== "0" && type !== "5" && typeFlag !== 0) {
      throw permanentIngestionError(
        "unsafe_archive",
        "repository archive contains an unsupported file type",
        { repositoryStatus: "error" },
      );
    }

    const relative = stripArchiveRoot(headerName);
    if (relative === null) {
      this.currentPath = null;
      return;
    }

    const target = resolveSafeArchivePath(this.destination, relative);

    if (type === "5" || (typeFlag === 0 && size === 0 && headerName.endsWith("/"))) {
      await mkdir(target, { recursive: true });
      this.remainingFileBytes = 0;
      return;
    }

    this.fileCount += 1;
    if (this.fileCount > this.limits.maxFileCount) {
      throw permanentIngestionError(
        "repository_too_large",
        "repository exceeds the configured file-count limit",
        {
          repositoryStatus: "error",
          details: {
            fileCount: this.fileCount,
            sizeBytes: this.totalBytes,
            maxFileCount: this.limits.maxFileCount,
            maxTotalBytes: this.limits.maxTotalBytes,
          },
        },
      );
    }

    await mkdir(path.dirname(target), { recursive: true });
    this.currentPath = target;
    if (size === 0) {
      await this.appendFile(target, Buffer.alloc(0));
      this.currentPath = null;
    }
  }

  private applyPendingMeta(): void {
    const pending = this.pendingMeta;
    this.pendingMeta = null;
    if (pending === null) {
      return;
    }

    const text = Buffer.concat(pending.chunks)
      .toString("utf8")
      .replace(/\0+$/g, "")
      .trim();

    if (pending.kind === "longname") {
      this.longName = text;
      return;
    }

    const pathRecord = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes(" path="));
    if (pathRecord === undefined) {
      return;
    }

    const value = pathRecord.slice(pathRecord.indexOf(" path=") + 6);
    if (value.length > 0) {
      this.longName = value;
    }
  }

  private async appendFile(target: string, chunk: Buffer): Promise<void> {
    const flags = this.openedFiles.has(target) ? "a" : "w";
    this.openedFiles.add(target);
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target, { flags, mode: 0o644 });
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end(chunk);
    });
  }

  private ensureSizeLimit(): void {
    if (this.totalBytes <= this.limits.maxTotalBytes) {
      return;
    }

    throw permanentIngestionError(
      "repository_too_large",
      "repository exceeds the configured uncompressed size limit",
      {
        repositoryStatus: "error",
        details: {
          fileCount: this.fileCount,
          sizeBytes: this.totalBytes,
          maxFileCount: this.limits.maxFileCount,
          maxTotalBytes: this.limits.maxTotalBytes,
        },
      },
    );
  }

  private checkBudget(): void {
    if (this.signal?.aborted === true) {
      throw retryableIngestionError(
        "timeout",
        "repository archive extraction exceeded the configured time limit",
      );
    }

    if (Date.now() - this.startedAt > this.limits.timeoutMs) {
      throw retryableIngestionError(
        "timeout",
        "repository archive extraction exceeded the configured time limit",
      );
    }
  }
}

export function stripArchiveRoot(entryName: string): string | null {
  const normalized = entryName.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length <= 1) {
    return null;
  }

  parts.shift();
  return parts.join("/");
}

export function resolveSafeArchivePath(root: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw permanentIngestionError(
      "unsafe_archive",
      "repository archive contains an absolute or NUL path",
      { repositoryStatus: "error" },
    );
  }

  const parts = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw permanentIngestionError(
      "unsafe_archive",
      "repository archive contains a path-traversal entry",
      { repositoryStatus: "error" },
    );
  }

  const resolved = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw permanentIngestionError(
      "unsafe_archive",
      "repository archive would extract outside the working directory",
      { repositoryStatus: "error" },
    );
  }

  return resolved;
}

function readTarString(block: Buffer): string {
  const end = block.indexOf(0);
  const slice = end === -1 ? block : block.subarray(0, end);
  return slice.toString("utf8").trim();
}

function parseOctal(block: Buffer): number {
  const text = block.toString("utf8").replace(/\0/g, " ").trim();
  if (text.length === 0) {
    return 0;
  }

  const value = Number.parseInt(text, 8);
  if (!Number.isInteger(value) || value < 0) {
    throw permanentIngestionError(
      "unsafe_archive",
      "repository archive contains an invalid size field",
      { repositoryStatus: "error" },
    );
  }

  return value;
}

function validTarChecksum(header: Buffer): boolean {
  const stored = parseOctal(header.subarray(148, 156));
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i += 1) {
    const byte = i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    unsigned += byte;
    signed += byte < 128 ? byte : byte - 256;
  }

  return stored === unsigned || stored === signed;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) {
      return false;
    }
  }

  return true;
}
