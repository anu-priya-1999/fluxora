import assert from "node:assert/strict";
import test from "node:test";

import { FilesystemObjectStorage, S3ObjectStorage } from "@fluxora/infrastructure";

import {
  createObjectStorageClient,
  loadObjectStorageConfig,
  objectStorageUri,
} from "./storage-config.ts";

test("loadObjectStorageConfig reads filesystem and s3 settings without credentials", () => {
  assert.equal(loadObjectStorageConfig({}), null);

  const filesystem = loadObjectStorageConfig({
    OBJECT_STORAGE_DRIVER: "filesystem",
    OBJECT_STORAGE_ROOT: "C:/tmp/fluxora-objects",
  });
  assert.deepEqual(filesystem, {
    driver: "filesystem",
    rootDirectory: "C:/tmp/fluxora-objects",
  });
  assert.ok(createObjectStorageClient(filesystem!) instanceof FilesystemObjectStorage);
  assert.equal(
    objectStorageUri(filesystem!, "org/repo/snap/snapshot.tar.gz"),
    "filesystem://org/repo/snap/snapshot.tar.gz",
  );

  const s3 = loadObjectStorageConfig({
    OBJECT_STORAGE_DRIVER: "s3",
    S3_BUCKET: "fluxora-snapshots",
    AWS_REGION: "us-east-1",
    S3_ENDPOINT: "http://localhost:9000",
    S3_FORCE_PATH_STYLE: "true",
  });
  assert.deepEqual(s3, {
    driver: "s3",
    bucket: "fluxora-snapshots",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    forcePathStyle: true,
  });
  assert.ok(createObjectStorageClient(s3!) instanceof S3ObjectStorage);
  assert.equal(
    objectStorageUri(s3!, "org/repo/snap/snapshot.tar.gz"),
    "s3://fluxora-snapshots/org/repo/snap/snapshot.tar.gz",
  );
});

test("loadObjectStorageConfig rejects an unknown driver", () => {
  assert.throws(
    () => loadObjectStorageConfig({ OBJECT_STORAGE_DRIVER: "minio" }),
    /filesystem or s3/,
  );
});
