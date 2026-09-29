export interface ObjectMetadata {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface ObjectStorageClient {
  put(key: string, body: Uint8Array, options?: ObjectMetadata): Promise<void>;

  get(key: string): Promise<Uint8Array>;

  exists(key: string): Promise<boolean>;

  delete(key: string): Promise<boolean>;

  close(): Promise<void>;
}
