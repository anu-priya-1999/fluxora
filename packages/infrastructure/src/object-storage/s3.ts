import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type {
  ObjectMetadata,
  ObjectStorageClient,
} from "./client.ts";

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  client?: S3Client;
}

export class S3ObjectStorage implements ObjectStorageClient {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3ObjectStorageOptions) {
    if (!options.bucket.trim()) {
      throw new Error("S3 bucket is required");
    }

    if (!options.region.trim() && !options.client) {
      throw new Error("S3 region is required");
    }

    this.bucket = options.bucket;

    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint
          ? {
              endpoint: options.endpoint,
              forcePathStyle: options.forcePathStyle ?? false,
            }
          : {}),
      });
  }

  async put(
    key: string,
    body: Uint8Array,
    options?: ObjectMetadata,
  ): Promise<void> {
    if (!key.trim()) {
      throw new Error("object key is required");
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType,
        Metadata: options?.metadata,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    if (!key.trim()) {
      throw new Error("object key is required");
    }

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`Object body is missing for key: ${key}`);
    }

    return response.Body.transformToByteArray();
  }

  async exists(key: string): Promise<boolean> {
    if (!key.trim()) {
      throw new Error("object key is required");
    }

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      return true;
    } catch (error) {
      if (this.isNotFound(error)) {
        return false;
      }

      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!key.trim()) {
      throw new Error("object key is required");
    }

    const existed = await this.exists(key);

    if (!existed) {
      return false;
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    return true;
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private isNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const candidate = error as {
      name?: string;
      $metadata?: {
        httpStatusCode?: number;
      };
    };

    return (
      candidate.name === "NotFound" ||
      candidate.name === "NoSuchKey" ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }
}