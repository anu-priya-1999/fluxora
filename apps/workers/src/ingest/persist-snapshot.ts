import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import type { CreateRepositorySnapshotInput } from "@fluxora/db";
import { RepositorySnapshotImmutableError } from "@fluxora/db";
import type { ObjectStorageClient } from "@fluxora/infrastructure";
import { snapshotObjectKey } from "@fluxora/infrastructure";
import type { RepositorySnapshot } from "@fluxora/shared-types";

import {
  permanentIngestionError,
  retryableIngestionError,
} from "./errors.ts";
import type { IngestLimits } from "./limits.ts";
import { packageSnapshotArchive } from "./package-snapshot.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

export const SNAPSHOT_OBJECT_NAME = "snapshot.tar.gz";

export interface PersistPackagedSnapshotInput {
  organizationId: string;
  repositoryId: string;
  commitSha: string;
  ref: string;
  workDir: string;
  fileCount: number;
  limits: IngestLimits;
  storage: ObjectStorageClient;
  objectStorageUri: (key: string) => string;
  snapshots: SnapshotStore;
  createSnapshotId?: () => string;
  signal?: AbortSignal;
}

export interface PersistPackagedSnapshotResult {
  snapshot: RepositorySnapshot;
  objectKey: string;
  uploaded: boolean;
}

export async function persistPackagedSnapshot(
  input: PersistPackagedSnapshotInput,
): Promise<PersistPackagedSnapshotResult> {
  const snapshotId = input.createSnapshotId?.() ?? randomUUID();
  const archivePath = `${input.workDir}.snapshot.tar.gz`;
  const packaged = await packageSnapshotArchive(
    input.workDir,
    archivePath,
    input.limits,
    input.signal,
  );

  if (packaged.fileCount !== input.fileCount) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    throw permanentIngestionError(
      "unsafe_archive",
      "packaged snapshot file count does not match the extracted tree",
      { repositoryStatus: "error" },
    );
  }

  const objectKey = snapshotObjectKey(
    input.organizationId,
    input.repositoryId,
    snapshotId,
    SNAPSHOT_OBJECT_NAME,
  );
  const storageUri = input.objectStorageUri(objectKey);
  let uploaded = false;

  try {
    const exists = await input.storage.exists(objectKey);
    if (exists) {
      throw permanentIngestionError(
        "snapshot_conflict",
        "refusing to overwrite an existing immutable snapshot object",
        { repositoryStatus: "error" },
      );
    }

    const body = await readFile(archivePath);
    if (body.byteLength !== packaged.sizeBytes) {
      throw permanentIngestionError(
        "unsafe_archive",
        "snapshot archive changed after checksum",
        { repositoryStatus: "error" },
      );
    }

    try {
      await input.storage.put(objectKey, body, {
        contentType: "application/gzip",
        metadata: {
          sha256: packaged.sha256,
        },
      });
      uploaded = true;
    } catch (error) {
      await deleteOrphanObject(input.storage, objectKey);
      if (error instanceof Error && error.name === "IngestionError") {
        throw error;
      }

      throw retryableIngestionError(
        "object_storage",
        "failed to upload the immutable repository snapshot",
      );
    }

    const createInput: CreateRepositorySnapshotInput = {
      id: snapshotId,
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      ref: input.ref,
      storageUri,
      sha256: packaged.sha256,
      fileCount: packaged.fileCount,
      sizeBytes: String(packaged.sizeBytes),
    };

    try {
      const snapshot = await input.snapshots.create(createInput);
      if (snapshot.id !== snapshotId && uploaded) {
        await deleteOrphanObject(input.storage, objectKey);
        uploaded = false;
      }

      return { snapshot, objectKey, uploaded };
    } catch (error) {
      if (uploaded) {
        await deleteOrphanObject(input.storage, objectKey);
        uploaded = false;
      }

      if (error instanceof RepositorySnapshotImmutableError) {
        throw permanentIngestionError(
          "snapshot_conflict",
          "an existing snapshot for this commit has different immutable metadata",
          { repositoryStatus: "error" },
        );
      }

      if (error instanceof Error && error.name === "IngestionError") {
        throw error;
      }

      throw retryableIngestionError(
        "object_storage",
        "failed to persist the immutable repository snapshot",
      );
    }
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
  }
}

async function deleteOrphanObject(
  storage: ObjectStorageClient,
  key: string,
): Promise<void> {
  await storage.delete(key).catch(() => undefined);
}
