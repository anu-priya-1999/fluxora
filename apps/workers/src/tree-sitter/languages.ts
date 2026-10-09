import type { SupportedLanguage } from "@fluxora/shared-types";

/**
 * Normalizes file extension to lowercase with leading dot.
 */
export function getExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? "";
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return basename.slice(lastDot).toLowerCase();
}

/**
 * Extension to SupportedLanguage mapping for Tree-sitter fallback parsing.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  ".json": "JSON",
  ".css": "CSS",
  ".html": "HTML",
  ".htm": "HTML",
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".mdx": "Markdown",
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "JavaScript",
};

/**
 * Maps a file path deterministically to its language or returns "unsupported".
 */
export function detectFileLanguage(filePath: string): SupportedLanguage | "unsupported" {
  const ext = getExtension(filePath);
  return EXTENSION_LANGUAGE_MAP[ext] ?? "unsupported";
}

/**
 * Returns the WASM file name for a supported language if available in tree-sitter-wasms.
 */
export function getWasmFileName(language: SupportedLanguage, ext?: string): string | null {
  switch (language) {
    case "JSON":
      return "tree-sitter-json.wasm";
    case "CSS":
      return "tree-sitter-css.wasm";
    case "HTML":
      return "tree-sitter-html.wasm";
    case "JavaScript":
      return ext === ".jsx" ? "tree-sitter-javascript.wasm" : "tree-sitter-javascript.wasm";
    case "TypeScript":
      return ext === ".tsx" ? "tree-sitter-tsx.wasm" : "tree-sitter-typescript.wasm";
    case "Markdown":
      return null; // Handled by deterministic Markdown AST fallback parser
    default:
      return null;
  }
}

