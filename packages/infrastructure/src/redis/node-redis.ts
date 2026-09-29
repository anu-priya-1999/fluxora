import { createClient, type RedisClientType } from "redis";

import type { RedisClient, RedisSetOptions } from "./client.ts";

export interface RedisAdapterOptions {
  url: string;
}

export class RedisAdapter implements RedisClient {
  private readonly client: RedisClientType;

  constructor(options: RedisAdapterOptions) {
    if (!options.url.trim()) {
      throw new Error("Redis URL is required");
    }

    this.client = createClient({
      url: options.url,
    });

    this.client.on("error", (error) => {
      console.error("[redis] client error", error);
    });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<void> {
    await this.ensureConnected();

    await this.client.set(key, value, {
      ...(options?.ttlSeconds !== undefined ? { EX: options.ttlSeconds } : {}),
    });
  }

  async delete(key: string): Promise<boolean> {
    await this.ensureConnected();
    const result = await this.client.del(key);
    return result > 0;
  }

  async setIfAbsent(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<boolean> {
    await this.ensureConnected();

    const result = await this.client.set(key, value, {
      NX: true,
      ...(options?.ttlSeconds !== undefined ? { EX: options.ttlSeconds } : {}),
    });

    return result === "OK";
  }

  async increment(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    await this.ensureConnected();

    const result = await this.client.expire(key, ttlSeconds);
    return result > 0;
  }

  async ping(): Promise<boolean> {
    await this.ensureConnected();
    const result = await this.client.ping();
    return result === "PONG";
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }
}
