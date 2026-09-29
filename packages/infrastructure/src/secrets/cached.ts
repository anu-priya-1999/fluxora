import type { SecretValue, SecretsClient } from "./client.ts";

interface CachedSecret {
  value: SecretValue;
  expiresAt: number;
}

export interface CachedSecretsClientOptions {
  ttlSeconds: number;
}

export class CachedSecretsClient implements SecretsClient {
  private readonly source: SecretsClient;
  private readonly options: CachedSecretsClientOptions;
  private readonly cache = new Map<string, CachedSecret>();

  constructor(source: SecretsClient, options: CachedSecretsClientOptions) {
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new Error("ttlSeconds must be greater than zero");
    }

    this.source = source;
    this.options = options;
  }

  async getSecret(name: string): Promise<SecretValue> {
    const now = Date.now();
    const cached = this.cache.get(name);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await this.source.getSecret(name);

    this.cache.set(name, {
      value,
      expiresAt: now + this.options.ttlSeconds * 1000,
    });

    return value;
  }

  clear(): void {
    this.cache.clear();
  }

  clearSecret(name: string): void {
    this.cache.delete(name);
  }
}
