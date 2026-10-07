/**
 * Supported programming and markup languages in Fluxora code intelligence.
 */
export const SupportedLanguages = [
  "TypeScript",
  "JavaScript",
  "JSON",
  "CSS",
  "HTML",
  "Markdown",
] as const;

export type SupportedLanguage = (typeof SupportedLanguages)[number];

/**
 * Supported frameworks and ecosystem runtimes detected by Fluxora.
 */
export const SupportedFrameworks = [
  "Next.js",
  "React",
  "Node.js",
] as const;

export type SupportedFramework = (typeof SupportedFrameworks)[number];

/**
 * Minimal file metadata item passed into the detector.
 */
export interface RepositoryDetectorFileItem {
  readonly path: string;
  readonly size?: number;
}

/**
 * Deterministic detection input representing an immutable repository snapshot.
 */
export interface RepositoryDetectorInput {
  readonly files: readonly RepositoryDetectorFileItem[];
  /**
   * Optional helper to read content of specific configuration/manifest files
   * (e.g. package.json, tsconfig.json).
   * Untrusted repository code is strictly read as text/data and never executed.
   */
  readonly readFile?: (relativePath: string) => Promise<string | null> | string | null;
}

/**
 * Explanatory evidence unit explaining why a language or framework was detected.
 */
export interface RepositoryDetectorEvidence {
  readonly target: SupportedLanguage | SupportedFramework;
  readonly category: "language" | "framework";
  readonly reasons: readonly string[];
}

/**
 * Summary of a recognized source/config file in the repository.
 */
export interface RepositoryDetectorFileSummary {
  readonly path: string;
  readonly language: SupportedLanguage;
}

/**
 * Strongly typed result model produced deterministically by the detector.
 */
export interface RepositoryDetectorResult {
  readonly languages: readonly SupportedLanguage[];
  readonly frameworks: readonly SupportedFramework[];
  readonly primaryLanguage: SupportedLanguage | null;
  readonly primaryFramework: SupportedFramework | null;
  readonly evidence: readonly RepositoryDetectorEvidence[];
  readonly totalFilesEvaluated: number;
  readonly ignoredFilesCount: number;
  readonly recognizedFiles: readonly RepositoryDetectorFileSummary[];
}

