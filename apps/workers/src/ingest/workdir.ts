import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PREFIX = "fluxora-ingest-";

export async function createIngestWorkDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), PREFIX));
}

export async function removeIngestWorkDir(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(tmpdir());
  const expectedPrefix = path.join(tempRoot, PREFIX);

  if (resolved !== expectedPrefix && !resolved.startsWith(expectedPrefix)) {
    throw new Error("refusing to delete a directory outside the ingest temp prefix");
  }

  await rm(resolved, { recursive: true, force: true });
}
