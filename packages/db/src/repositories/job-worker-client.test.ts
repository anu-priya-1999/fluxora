import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isPoolClient, withWorkerClient } from "./job.ts";
import { DATABASE_ROLE_ENV } from "../tenant.ts";

describe("PoolClient vs Pool detection (isPoolClient)", () => {
  it("reliably identifies a mock PoolClient that exposes query, connect, and release", () => {
    const mockPoolClient = {
      query: vi.fn(),
      connect: vi.fn(),
      release: vi.fn(),
    };

    assert.equal(isPoolClient(mockPoolClient), true);
  });

  it("reliably rejects a pg.Pool instance", () => {
    const pool = new pg.Pool({ max: 1 });
    assert.equal(isPoolClient(pool), false);
  });

  it("reliably rejects a mock Pool-like object that defines totalCount and no release", () => {
    const mockPool = {
      query: vi.fn(),
      connect: vi.fn(),
      totalCount: 5,
      idleCount: 2,
    };

    assert.equal(isPoolClient(mockPool), false);
  });

  it("returns false for non-client/invalid inputs", () => {
    assert.equal(isPoolClient(undefined), false);
    assert.equal(isPoolClient(null), false);
    assert.equal(isPoolClient({}), false);
    assert.equal(isPoolClient("string"), false);
    assert.equal(isPoolClient({ query: vi.fn() }), false);
  });
});

describe("withWorkerClient execution paths", () => {
  const originalRoleEnv = process.env[DATABASE_ROLE_ENV];

  beforeEach(() => {
    delete process.env[DATABASE_ROLE_ENV];
  });

  afterEach(() => {
    if (originalRoleEnv !== undefined) {
      process.env[DATABASE_ROLE_ENV] = originalRoleEnv;
    } else {
      delete process.env[DATABASE_ROLE_ENV];
    }
  });

  describe("Caller-supplied PoolClient path", () => {
    it("executes the callback using the supplied client without reconnecting or releasing", async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const result = await withWorkerClient(
        mockClient as unknown as pg.PoolClient,
        async (client) => {
          assert.equal(client, mockClient);
          return "client-result";
        },
      );

      assert.equal(result, "client-result");
      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(mockClient.release).not.toHaveBeenCalled();
    });

    it("does not execute SET ROLE or RESET ROLE even when DATABASE_ROLE_ENV is set", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_custom_role";

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      await withWorkerClient(
        mockClient as unknown as pg.PoolClient,
        async (client) => {
          await client.query("SELECT 1");
          return true;
        },
      );

      // Verify query was called ONLY for the callback's SELECT 1 query
      expect(mockClient.query).toHaveBeenCalledTimes(1);
      expect(mockClient.query).toHaveBeenCalledWith("SELECT 1");
      expect(mockClient.release).not.toHaveBeenCalled();
    });

    it("verifies the client is not released when the callback throws an error", async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      await assert.rejects(
        withWorkerClient(
          mockClient as unknown as pg.PoolClient,
          async () => {
            throw new Error("handler-failed");
          },
        ),
        /handler-failed/,
      );

      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(mockClient.release).not.toHaveBeenCalled();
    });
  });

  describe("Pool-acquired client path", () => {
    it("acquires client from pool, runs without SET ROLE when no role env is set, and releases normally", async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      const result = await withWorkerClient(
        mockPool as unknown as pg.Pool,
        async (client) => {
          assert.equal(client, mockClient);
          return "pool-result";
        },
      );

      assert.equal(result, "pool-result");
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledWith();
    });

    it("executes SET ROLE and RESET ROLE when DATABASE_ROLE_ENV is configured", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_worker_role";

      const queryCalls: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          queryCalls.push(sql);
          return { rows: [] };
        }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      const result = await withWorkerClient(
        mockPool as unknown as pg.Pool,
        async () => "worker-done",
      );

      assert.equal(result, "worker-done");
      expect(queryCalls).toEqual([
        "SET ROLE test_worker_role",
        "RESET ROLE",
      ]);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledWith();
    });

    it("destroys tainted client by passing resetError to release if RESET ROLE fails on success", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_worker_role";

      const resetError = new Error("reset-failed-fatal");
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === "RESET ROLE") {
            throw resetError;
          }
          return { rows: [] };
        }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      await assert.rejects(
        withWorkerClient(mockPool as unknown as pg.Pool, async () => "ok"),
        /reset-failed-fatal/,
      );

      expect(mockClient.release).toHaveBeenCalledWith(resetError);
    });

    it("resets role, releases client, and rethrows original operation error if operation throws", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_worker_role";

      const opError = new Error("operation-exploded");
      const queryCalls: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          queryCalls.push(sql);
          return { rows: [] };
        }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      await assert.rejects(
        withWorkerClient(mockPool as unknown as pg.Pool, async () => {
          throw opError;
        }),
        /operation-exploded/,
      );

      expect(queryCalls).toEqual([
        "SET ROLE test_worker_role",
        "RESET ROLE",
      ]);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledWith();
    });

    it("destroys tainted client by passing resetError to release if RESET ROLE fails during operation error handling", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_worker_role";

      const opError = new Error("operation-exploded");
      const resetError = new Error("reset-also-failed");
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === "RESET ROLE") {
            throw resetError;
          }
          return { rows: [] };
        }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      await assert.rejects(
        withWorkerClient(mockPool as unknown as pg.Pool, async () => {
          throw opError;
        }),
        /operation-exploded/,
      );

      // Client must be destroyed with resetError
      expect(mockClient.release).toHaveBeenCalledWith(resetError);
    });

    it("resets role, releases client cleanly, and rethrows error if SET ROLE fails", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_worker_role";

      const setRoleError = new Error("set-role-failed");
      const queryCalls: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          queryCalls.push(sql);
          if (sql === "SET ROLE test_worker_role") {
            throw setRoleError;
          }
          return { rows: [] };
        }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      await assert.rejects(
        withWorkerClient(mockPool as unknown as pg.Pool, async () => "ok"),
        /set-role-failed/,
      );

      expect(queryCalls).toEqual([
        "SET ROLE test_worker_role",
        "RESET ROLE",
      ]);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledWith();
    });

    it("destroys tainted client by passing resetError to release if SET ROLE fails and RESET ROLE also fails", async () => {
      process.env[DATABASE_ROLE_ENV] = "test_worker_role";

      const setRoleError = new Error("set-role-failed");
      const resetError = new Error("reset-also-failed");
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === "SET ROLE test_worker_role") {
            throw setRoleError;
          }
          if (sql === "RESET ROLE") {
            throw resetError;
          }
          return { rows: [] };
        }),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      await assert.rejects(
        withWorkerClient(mockPool as unknown as pg.Pool, async () => "ok"),
        /set-role-failed/,
      );

      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledWith(resetError);
    });

    it("regression: invalid FLUXORA_DATABASE_ROLE configuration does not leak a pooled connection (mock pool)", async () => {
      process.env[DATABASE_ROLE_ENV] = "invalid-role; DROP TABLE users;--";

      const mockClient = {
        query: vi.fn(),
        connect: vi.fn(),
        release: vi.fn(),
      };

      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        totalCount: 1,
      };

      await assert.rejects(
        withWorkerClient(mockPool as unknown as pg.Pool, async () => "should-not-run"),
        /is not a safe SQL identifier/,
      );

      // Verify connect was never called, preventing any connection leak
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.release).not.toHaveBeenCalled();
    });

    it("regression: invalid FLUXORA_DATABASE_ROLE configuration does not leak a pooled connection (real pg.Pool)", async () => {
      process.env[DATABASE_ROLE_ENV] = "invalid_role!";

      const pool = new pg.Pool({ max: 1 });
      try {
        await assert.rejects(
          withWorkerClient(pool, async () => "should-not-run"),
          /is not a safe SQL identifier/,
        );

        // Verify zero connections were checked out or created
        expect(pool.totalCount).toBe(0);
        expect(pool.idleCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });
});
