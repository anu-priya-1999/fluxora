import {
  FilesystemObjectStorage,
  S3ObjectStorage,
  type ObjectStorageClient,
} from "@fluxora/infrastructure";

export type ObjectStorageDriver = "filesystem" | "s3";

export interface FilesystemObjectStorageConfig {
  driver: "filesystem";
  rootDirectory: string;
}

export interface S3ObjectStorageConfig {
  driver: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export type ObjectStorageConfig =
  | FilesystemObjectStorageConfig
  | S3ObjectStorageConfig;

export function loadObjectStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig | null {
  const driver = (blankToUndefined(env.OBJECT_STORAGE_DRIVER) ?? "filesystem")
    .trim()
    .toLowerCase();

  if (driver !== "filesystem" && driver !== "s3") {
    throw new Error("OBJECT_STORAGE_DRIVER must be filesystem or s3");
  }

  if (driver === "filesystem") {
    const rootDirectory = blankToUndefined(env.OBJECT_STORAGE_ROOT);
    if (rootDirectory === undefined) {
      return null;
    }

    return { driver: "filesystem", rootDirectory };
  }

  const bucket = blankToUndefined(env.S3_BUCKET);
  const region = blankToUndefined(env.AWS_REGION);
  if (bucket === undefined || region === undefined) {
    return null;
  }

  const endpoint = blankToUndefined(env.S3_ENDPOINT);
  const forcePathStyle = parseOptionalBoolean(env.S3_FORCE_PATH_STYLE);

  return {
    driver: "s3",
    bucket,
    region,
    ...(endpoint === undefined ? {} : { endpoint }),
    forcePathStyle: forcePathStyle ?? false,
  };
}

export function createObjectStorageClient(
  config: ObjectStorageConfig,
): ObjectStorageClient {
  if (config.driver === "filesystem") {
    return new FilesystemObjectStorage({
      rootDirectory: config.rootDirectory,
    });
  }

  return new S3ObjectStorage({
    bucket: config.bucket,
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
  });
}

export function objectStorageUri(
  config: ObjectStorageConfig,
  key: string,
): string {
  const normalizedKey = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalizedKey.length === 0) {
    throw new Error("object key is required");
  }

  if (config.driver === "filesystem") {
    return `filesystem://${normalizedKey}`;
  }

  return `s3://${config.bucket}/${normalizedKey}`;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const trimmed = blankToUndefined(value);
  if (trimmed === undefined) {
    return undefined;
  }

  if (trimmed === "true" || trimmed === "1") {
    return true;
  }

  if (trimmed === "false" || trimmed === "0") {
    return false;
  }

  throw new Error("S3_FORCE_PATH_STYLE must be true, false, 1, or 0");
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
