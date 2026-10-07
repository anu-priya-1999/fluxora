import type {
  RepositoryDetectorEvidence,
  RepositoryDetectorFileSummary,
  RepositoryDetectorInput,
  RepositoryDetectorResult,
  SupportedFramework,
  SupportedLanguage,
} from "@fluxora/shared-types";

/**
 * Standard list of directory segments to ignore completely during detection.
 * Matches standard build caches, package managers, and version control metadata.
 */
export const DEFAULT_IGNORED_DIRECTORIES = new Set<string>([
  "node_modules",
  ".git",
  ".next",
  "build",
  "dist",
  "out",
  ".turbo",
  ".cache",
  "coverage",
]);

/**
 * Checks whether a relative POSIX file path is inside an ignored directory.
 */
export function isIgnoredPath(
  filePath: string,
  ignoredDirs: Set<string> = DEFAULT_IGNORED_DIRECTORIES,
): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  // Any segment before the filename matching an ignored dir means it is ignored
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg !== undefined && ignoredDirs.has(seg)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes file extension to lowercase with leading dot.
 */
function getExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? "";
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return basename.slice(lastDot).toLowerCase();
}

/**
 * Extension to SupportedLanguage mapping.
 * Multiple extensions map deterministically to canonical languages.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".css": "CSS",
  ".html": "HTML",
  ".htm": "HTML",
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".mdx": "Markdown",
};

/**
 * Parse JSON safely without throwing.
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure deterministic function detecting languages and frameworks from a snapshot input.
 */
export async function detectRepositoryStack(
  input: RepositoryDetectorInput,
): Promise<RepositoryDetectorResult> {
  const languageEvidenceMap = new Map<SupportedLanguage, Set<string>>();
  const frameworkEvidenceMap = new Map<SupportedFramework, Set<string>>();
  const languageCounts = new Map<SupportedLanguage, number>();
  const recognizedFiles: RepositoryDetectorFileSummary[] = [];

  const ignoredDirs = DEFAULT_IGNORED_DIRECTORIES;

  // 1. Scan file entries for languages and ignored files
  let ignoredCount = 0;
  for (const entry of input.files) {
    const rawPath = entry.path.replace(/\\/g, "/");
    if (isIgnoredPath(rawPath, ignoredDirs)) {
      ignoredCount++;
      continue;
    }

    const ext = getExtension(rawPath);
    const lang = EXTENSION_LANGUAGE_MAP[ext];

    if (lang !== undefined) {
      if (!languageEvidenceMap.has(lang)) {
        languageEvidenceMap.set(lang, new Set());
      }
      languageEvidenceMap.get(lang)!.add(`extension: ${ext}`);

      languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
      recognizedFiles.push({
        path: rawPath,
        language: lang,
      });
    }
  }

  // 2. Read manifests and configs using input.readFile
  const filePathsSet = new Set(
    input.files
      .map((f) => f.path.replace(/\\/g, "/"))
      .filter((p) => !isIgnoredPath(p, ignoredDirs)),
  );

  let packageJson: Record<string, unknown> | null = null;
  let packageJsonRaw: string | null = null;
  if (filePathsSet.has("package.json") && input.readFile !== undefined) {
    packageJsonRaw = await input.readFile("package.json");
    if (packageJsonRaw !== null) {
      packageJson = tryParseJson(packageJsonRaw);
    }
  }

  // Check tsconfig.json presence as additional TypeScript evidence
  if (filePathsSet.has("tsconfig.json")) {
    if (!languageEvidenceMap.has("TypeScript")) {
      languageEvidenceMap.set("TypeScript", new Set());
    }
    languageEvidenceMap.get("TypeScript")!.add("config: tsconfig.json");
  }

  // 3. Framework & Ecosystem Detection
  const allDeps = new Set<string>();
  if (packageJson !== null) {
    const dependencies = packageJson.dependencies as Record<string, unknown> | undefined;
    const devDependencies = packageJson.devDependencies as Record<string, unknown> | undefined;

    if (typeof dependencies === "object" && dependencies !== null) {
      for (const key of Object.keys(dependencies)) {
        allDeps.add(key);
      }
    }
    if (typeof devDependencies === "object" && devDependencies !== null) {
      for (const key of Object.keys(devDependencies)) {
        allDeps.add(key);
      }
    }
  }

  // Next.js detection
  const hasNextDep = allDeps.has("next");
  const hasNextConfig =
    filePathsSet.has("next.config.js") ||
    filePathsSet.has("next.config.mjs") ||
    filePathsSet.has("next.config.ts");
  const hasNextAppOrPagesDir =
    Array.from(filePathsSet).some(
      (p) =>
        p.startsWith("app/") ||
        p.startsWith("src/app/") ||
        p.startsWith("pages/") ||
        p.startsWith("src/pages/"),
    );

  if (hasNextDep) {
    if (!frameworkEvidenceMap.has("Next.js")) {
      frameworkEvidenceMap.set("Next.js", new Set());
    }
    frameworkEvidenceMap.get("Next.js")!.add("package.json: dependency 'next'");
    if (hasNextConfig) {
      const configName = ["next.config.mjs", "next.config.js", "next.config.ts"].find((c) =>
        filePathsSet.has(c),
      );
      if (configName) {
        frameworkEvidenceMap.get("Next.js")!.add(`config: ${configName}`);
      }
    }
    if (hasNextAppOrPagesDir) {
      if (Array.from(filePathsSet).some((p) => p.startsWith("app/") || p.startsWith("src/app/"))) {
        frameworkEvidenceMap.get("Next.js")!.add("directory: app router structure");
      }
      if (Array.from(filePathsSet).some((p) => p.startsWith("pages/") || p.startsWith("src/pages/"))) {
        frameworkEvidenceMap.get("Next.js")!.add("directory: pages router structure");
      }
    }
  } else if (hasNextConfig && hasNextAppOrPagesDir) {
    // If next config and next app/pages dir exist even without parsed package.json
    if (!frameworkEvidenceMap.has("Next.js")) {
      frameworkEvidenceMap.set("Next.js", new Set());
    }
    frameworkEvidenceMap.get("Next.js")!.add("config: next.config");
    frameworkEvidenceMap.get("Next.js")!.add("directory: next project structure");
  }

  // React detection
  const hasReactDep = allDeps.has("react") || allDeps.has("react-dom");
  const hasReactComponentFiles = Array.from(filePathsSet).some(
    (p) => p.endsWith(".tsx") || p.endsWith(".jsx"),
  );

  if (hasReactDep) {
    if (!frameworkEvidenceMap.has("React")) {
      frameworkEvidenceMap.set("React", new Set());
    }
    if (allDeps.has("react")) {
      frameworkEvidenceMap.get("React")!.add("package.json: dependency 'react'");
    }
    if (allDeps.has("react-dom")) {
      frameworkEvidenceMap.get("React")!.add("package.json: dependency 'react-dom'");
    }
    if (hasReactComponentFiles) {
      frameworkEvidenceMap.get("React")!.add("source: JSX/TSX components present");
    }
  } else if (hasReactComponentFiles && (hasNextDep || frameworkEvidenceMap.has("Next.js"))) {
    // React is also present if Next.js was detected and component files exist
    if (!frameworkEvidenceMap.has("React")) {
      frameworkEvidenceMap.set("React", new Set());
    }
    frameworkEvidenceMap.get("React")!.add("source: JSX/TSX components in Next.js project");
  }

  // Node.js ecosystem detection
  const hasNodeManifest = filePathsSet.has("package.json");
  const hasLockfile =
    filePathsSet.has("pnpm-lock.yaml") ||
    filePathsSet.has("package-lock.json") ||
    filePathsSet.has("yarn.lock") ||
    filePathsSet.has("bun.lockb");
  const hasNodeTypes = allDeps.has("@types/node");

  if (hasNodeManifest || hasLockfile || hasNodeTypes) {
    if (!frameworkEvidenceMap.has("Node.js")) {
      frameworkEvidenceMap.set("Node.js", new Set());
    }
    if (hasNodeManifest) {
      frameworkEvidenceMap.get("Node.js")!.add("manifest: package.json");
    }
    if (hasLockfile) {
      const lock = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"].find((l) =>
        filePathsSet.has(l),
      );
      if (lock) {
        frameworkEvidenceMap.get("Node.js")!.add(`lockfile: ${lock}`);
      }
    }
    if (hasNodeTypes) {
      frameworkEvidenceMap.get("Node.js")!.add("dependency: @types/node");
    }
  }

  // 4. Primary language and primary framework determination
  // Primary language: Language with the highest recognized code file count, favoring TypeScript/JavaScript if tie
  let primaryLanguage: SupportedLanguage | null = null;
  // Deterministic order of languages to check
  const sortedLanguages = Array.from(languageCounts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    // Priority order: TypeScript > JavaScript > others > alphabetical
    const priority = (lang: SupportedLanguage): number => {
      if (lang === "TypeScript") return 100;
      if (lang === "JavaScript") return 90;
      return 10;
    };
    const pDiff = priority(b[0]) - priority(a[0]);
    if (pDiff !== 0) return pDiff;
    return a[0].localeCompare(b[0]);
  });

  if (sortedLanguages.length > 0 && sortedLanguages[0] !== undefined) {
    primaryLanguage = sortedLanguages[0][0];
  }

  // Primary framework determination:
  // Next.js > React > Node.js
  let primaryFramework: SupportedFramework | null = null;
  if (frameworkEvidenceMap.has("Next.js")) {
    primaryFramework = "Next.js";
  } else if (frameworkEvidenceMap.has("React")) {
    primaryFramework = "React";
  } else if (frameworkEvidenceMap.has("Node.js")) {
    primaryFramework = "Node.js";
  }

  // 5. Structure evidence array deterministically (sorted)
  const evidenceList: RepositoryDetectorEvidence[] = [];

  const sortedLangs = Array.from(languageEvidenceMap.keys()).sort();
  for (const lang of sortedLangs) {
    const reasons = Array.from(languageEvidenceMap.get(lang)!).sort();
    evidenceList.push({
      target: lang,
      category: "language",
      reasons,
    });
  }

  const sortedFrameworks = Array.from(frameworkEvidenceMap.keys()).sort();
  for (const fw of sortedFrameworks) {
    const reasons = Array.from(frameworkEvidenceMap.get(fw)!).sort();
    evidenceList.push({
      target: fw,
      category: "framework",
      reasons,
    });
  }

  return {
    languages: sortedLangs,
    frameworks: sortedFrameworks,
    primaryLanguage,
    primaryFramework,
    evidence: evidenceList,
    totalFilesEvaluated: input.files.length,
    ignoredFilesCount: ignoredCount,
    recognizedFiles,
  };
}
