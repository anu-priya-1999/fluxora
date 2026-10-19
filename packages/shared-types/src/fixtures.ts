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

/**
 * Single changed file entry within a recorded golden pull request fixture.
 */
export interface GoldenPullRequestFileEntry {
  readonly path: string;
  readonly previousPath?: string | null | undefined;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string | null | undefined;
}

/**
 * Metadata and payload for a recorded golden pull request fixture.
 */
export interface GoldenPullRequestFixture {
  readonly fixtureId: string;
  readonly repositoryFullName: string;
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  readonly title: string;
  readonly description: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly changedFiles: readonly GoldenPullRequestFileEntry[];
  readonly provenance: {
    readonly sourceRepo: string;
    readonly derivedFrom: string;
    readonly verificationMethod: string;
  };
}

/**
 * Hand-verified expected impact analysis ground truth for a golden PR fixture.
 */
export interface GoldenImpactExpectationManifest {
  readonly fixtureId: string;
  readonly pullRequestNumber: number;
  readonly analysisRunCommitSha: string;
  readonly traversalDirection: "both" | "incoming" | "outgoing";
  readonly maxDepth: number;
  readonly decayFactor: number;
  readonly expectedChangedFiles: readonly string[];
  readonly expectedUnresolvedFiles: readonly string[];
  readonly expectedSeedCanonicalIds: readonly string[];
  readonly expectedDirectImpactCanonicalIds: readonly string[];
  readonly expectedOneHopDownstreamCanonicalIds: readonly string[];
  readonly expectedAffectedApiNames: readonly string[];
  readonly expectedAffectedEventNames: readonly string[];
  readonly expectedUnaffectedCanonicalIds: readonly string[];
  readonly expectedTruncated: boolean;
  readonly expectedMaxDepthReached: number;
  readonly prFixture: GoldenPullRequestFixture;
}
