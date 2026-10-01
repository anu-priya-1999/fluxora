import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadRootEnvFile(): void {
  const envPath = path.resolve(
    fileURLToPath(new URL("../../../../.env", import.meta.url)),
  );

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function assertLocalDevelopmentDatabase(databaseUrl: string): void {
  if ((process.env.NODE_ENV ?? "development") !== "development") {
    throw new Error("Local database commands require NODE_ENV=development.");
  }

  const url = new URL(databaseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `Refusing destructive/local database operation against non-local host: ${url.hostname}`,
    );
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (databaseName !== "fluxora_dev") {
    throw new Error(
      `Refusing local database operation against database "${databaseName}". Expected "fluxora_dev".`,
    );
  }
}
