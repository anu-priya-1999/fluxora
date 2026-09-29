import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CachedSecretsClient,
  EnvSecretsProvider,
  FilesystemObjectStorage,
  InMemoryRedisAdapter,
  cacheKey,
  organizationRedisKey,
  snapshotObjectKey,
} from "./index.ts";

test("redis key helpers create tenant-scoped keys", () => {
  assert.equal(
    organizationRedisKey("org-1", "cache", "repo-1"),
    "org:org-1:cache:repo-1",
  );

  assert.equal(cacheKey("org-1", "repo-1"), "org:org-1:cache:repo-1");

  assert.throws(
    () => organizationRedisKey("", "cache", "key"),
    /organizationId is required/,
  );
});

test("in-memory redis supports TTL and set-if-absent", async () => {
  const redis = new InMemoryRedisAdapter();

  assert.equal(await redis.ping(), true);

  assert.equal(await redis.setIfAbsent("lock:test", "first"), true);

  assert.equal(await redis.setIfAbsent("lock:test", "second"), false);

  assert.equal(await redis.get("lock:test"), "first");

  await redis.set("counter", "10");

  assert.equal(await redis.increment("counter"), 11);

  assert.equal(await redis.delete("counter"), true);

  assert.equal(await redis.get("counter"), null);

  await redis.close();
});

test("snapshot object keys are tenant scoped", () => {
  assert.equal(
    snapshotObjectKey("org-1", "repo-1", "snapshot-1", "source/index.ts"),
    "org-1/repo-1/snapshot-1/source/index.ts",
  );

  assert.throws(
    () =>
      snapshotObjectKey("org-1", "repo-1", "snapshot-1", "../../secret.txt"),
    /invalid path/,
  );
});

test("filesystem object storage writes, reads, checks and deletes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluxora-storage-"));

  try {
    const storage = new FilesystemObjectStorage({
      rootDirectory: root,
    });

    const key = snapshotObjectKey(
      "org-1",
      "repo-1",
      "snapshot-1",
      "source/index.ts",
    );

    const body = new TextEncoder().encode("export const value = 42;");

    assert.equal(await storage.exists(key), false);

    await storage.put(key, body, {
      contentType: "text/typescript",
    });

    assert.equal(await storage.exists(key), true);

    const result = await storage.get(key);

    assert.equal(new TextDecoder().decode(result), "export const value = 42;");

    assert.equal(await storage.delete(key), true);
    assert.equal(await storage.exists(key), false);
    assert.equal(await storage.delete(key), false);

    await storage.close();
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("filesystem object storage rejects path traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluxora-storage-"));

  try {
    const storage = new FilesystemObjectStorage({
      rootDirectory: root,
    });

    await assert.rejects(
      () =>
        storage.put("../../outside.txt", new TextEncoder().encode("blocked")),
      /invalid object key/,
    );

    await storage.close();
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("environment secrets provider reads configured secrets", async () => {
  const provider = new EnvSecretsProvider({
    FLUXORA_TEST_SECRET: "secret-value",
  });

  assert.deepEqual(await provider.getSecret("FLUXORA_TEST_SECRET"), {
    value: "secret-value",
  });

  await assert.rejects(
    () => provider.getSecret("MISSING_SECRET"),
    /not configured/,
  );
});

test("cached secrets client caches values until TTL expires", async () => {
  let calls = 0;

  const source = new EnvSecretsProvider({
    FLUXORA_TEST_SECRET: "secret-value",
  });

  const countingSource = {
    async getSecret(name: string) {
      calls += 1;
      return source.getSecret(name);
    },
  };

  const cached = new CachedSecretsClient(countingSource, {
    ttlSeconds: 60,
  });

  await cached.getSecret("FLUXORA_TEST_SECRET");
  await cached.getSecret("FLUXORA_TEST_SECRET");

  assert.equal(calls, 1);

  cached.clearSecret("FLUXORA_TEST_SECRET");

  await cached.getSecret("FLUXORA_TEST_SECRET");

  assert.equal(calls, 2);
});
