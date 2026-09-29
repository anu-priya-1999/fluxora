export interface RedisSetOptions {
  ttlSeconds?: number;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;

  set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<void>;

  delete(key: string): Promise<boolean>;

  setIfAbsent(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<boolean>;

  increment(key: string): Promise<number>;

  expire(key: string, ttlSeconds: number): Promise<boolean>;

  ping(): Promise<boolean>;

  close(): Promise<void>;
}