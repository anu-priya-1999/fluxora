import type {
  RedisClient,
  RedisSetOptions,
} from "./client.ts";

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class InMemoryRedisAdapter implements RedisClient {
  private readonly store = new Map<string, Entry>();

  async get(key: string): Promise<string | null> {
    const entry = this.getEntry(key);

    if (!entry) {
      return null;
    }

    return entry.value;
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: this.calculateExpiry(options?.ttlSeconds),
    });
  }

  async delete(key: string): Promise<boolean> {
    this.removeIfExpired(key);
    return this.store.delete(key);
  }

  async setIfAbsent(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<boolean> {
    this.removeIfExpired(key);

    if (this.store.has(key)) {
      return false;
    }

    this.store.set(key, {
      value,
      expiresAt: this.calculateExpiry(options?.ttlSeconds),
    });

    return true;
  }

  async increment(key: string): Promise<number> {
    const entry = this.getEntry(key);

    if (!entry) {
      this.store.set(key, {
        value: "1",
        expiresAt: null,
      });

      return 1;
    }

    const current = Number(entry.value);

    if (!Number.isInteger(current)) {
      throw new Error(`Redis value is not an integer: ${key}`);
    }

    const next = current + 1;

    entry.value = String(next);

    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const entry = this.getEntry(key);

    if (!entry) {
      return false;
    }

    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
      throw new Error("ttlSeconds must be a non-negative finite number");
    }

    entry.expiresAt = Date.now() + ttlSeconds * 1000;

    return true;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  private calculateExpiry(
    ttlSeconds: number | undefined,
  ): number | null {
    if (ttlSeconds === undefined) {
      return null;
    }

    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
      throw new Error("ttlSeconds must be a non-negative finite number");
    }

    return Date.now() + ttlSeconds * 1000;
  }

  private getEntry(key: string): Entry | null {
    this.removeIfExpired(key);

    return this.store.get(key) ?? null;
  }

  private removeIfExpired(key: string): void {
    const entry = this.store.get(key);

    if (!entry || entry.expiresAt === null) {
      return;
    }

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }
}