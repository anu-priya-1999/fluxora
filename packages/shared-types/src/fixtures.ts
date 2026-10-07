/**
 * Metadata contract and characteristics for golden repository fixtures used in deterministic tests.
 */
export interface GoldenFixtureCharacteristics {
  readonly framework: string;
  readonly language: string;
  readonly router: string;
  readonly hasServerComponents: boolean;
  readonly hasApiRoutes: boolean;
  readonly hasPrisma: boolean;
  readonly hasTailwind: boolean;
  readonly hasTsconfigPaths: boolean;
}

export interface GoldenFixtureFileEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface GoldenFixtureManifest {
  readonly fixtureId: string;
  readonly repositoryUrl: string;
  readonly repositoryFullName: string;
  readonly repositoryName: string;
  readonly pinnedCommitSha: string;
  readonly sourceBranch: string;
  readonly description: string;
  readonly frameworkCharacteristics: GoldenFixtureCharacteristics;
  readonly fileCount: number;
  readonly totalSizeBytes: number;
  readonly files: readonly GoldenFixtureFileEntry[];
}

