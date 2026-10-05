import type { CreateRepositorySnapshotInput } from "@fluxora/db";
import type { RepositorySnapshot } from "@fluxora/shared-types";

export interface SnapshotStore {
  create(input: CreateRepositorySnapshotInput): Promise<RepositorySnapshot>;
}
