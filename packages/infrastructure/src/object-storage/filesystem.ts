import { promises as fs } from "node:fs";
import path from "node:path";

import type { ObjectMetadata, ObjectStorageClient } from "./client.ts";

export interface FilesystemObjectStorageOptions {
  rootDirectory: string;
}

export class FilesystemObjectStorage implements ObjectStorageClient {
  private readonly rootDirectory: string;

  constructor(options: FilesystemObjectStorageOptions) {
    if (!options.rootDirectory.trim()) {
      throw new Error("rootDirectory is required");
    }

    this.rootDirectory = path.resolve(options.rootDirectory);
  }

  private resolveKey(key: string): string {
    const normalizedKey = key.replace(/\\/g, "/").trim();

    if (!normalizedKey) {
      throw new Error("object key is required");
    }

    if (
      normalizedKey.startsWith("/") ||
      normalizedKey
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("invalid object key");
    }

    return path.join(this.rootDirectory, ...normalizedKey.split("/"));
  }

  async put(
    key: string,
    body: Uint8Array,
    options?: ObjectMetadata,
  ): Promise<void> {
    void options;

    const filePath = this.resolveKey(key);

    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
    });

    await fs.writeFile(filePath, body);
  }

  async get(key: string): Promise<Uint8Array> {
    const filePath = this.resolveKey(key);
    return fs.readFile(filePath);
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolveKey(key);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    const filePath = this.resolveKey(key);

    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }

      throw error;
    }
  }

  async close(): Promise<void> {
    // Filesystem storage does not maintain a persistent connection.
  }
}
