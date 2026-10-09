import type { SupportedLanguage, TreeSitterParseInput, TreeSitterParseResult } from "@fluxora/shared-types";
import { isIgnoredPath } from "../detect/detector.ts";
import { detectFileLanguage } from "./languages.ts";
import { parseTreeSitterFile } from "./parser.ts";

export interface FallbackDecision {
  readonly shouldRunTreeSitter: boolean;
  readonly language: SupportedLanguage | "unsupported";
  readonly reason:
    | "ignored_path"
    | "unsupported_language"
    | "primary_compiler_succeeded"
    | "non_compiler_fallback_language"
    | "primary_compiler_failed_fallback_available";
}

/**
 * Evaluates whether a file should use the Tree-sitter fallback parser based on language,
 * primary compiler status, and path rules.
 */
export function evaluateFallbackDecision(input: TreeSitterParseInput): FallbackDecision {
  const relativePath = input.relativePath.replace(/\\/g, "/");

  if (isIgnoredPath(relativePath)) {
    return {
      shouldRunTreeSitter: false,
      language: "unsupported",
      reason: "ignored_path",
    };
  }

  const language = input.language ?? detectFileLanguage(relativePath);
  if (language === "unsupported") {
    return {
      shouldRunTreeSitter: false,
      language: "unsupported",
      reason: "unsupported_language",
    };
  }

  const isTsJs = language === "TypeScript" || language === "JavaScript";

  if (isTsJs) {
    if (input.primaryParserSucceeded === true) {
      return {
        shouldRunTreeSitter: false,
        language,
        reason: "primary_compiler_succeeded",
      };
    }
    return {
      shouldRunTreeSitter: true,
      language,
      reason: "primary_compiler_failed_fallback_available",
    };
  }

  // Non-TS/JS supported languages (JSON, CSS, HTML, Markdown)
  return {
    shouldRunTreeSitter: true,
    language,
    reason: "non_compiler_fallback_language",
  };
}

/**
 * Runs the complete Step 24 Tree-sitter fallback pass, enforcing decision path rules.
 */
export async function runTreeSitterFallbackPass(input: TreeSitterParseInput): Promise<TreeSitterParseResult> {
  const decision = evaluateFallbackDecision(input);

  if (!decision.shouldRunTreeSitter) {
    const relativePath = input.relativePath.replace(/\\/g, "/");
    const id = `${relativePath}#tree-sitter`;

    if (decision.reason === "primary_compiler_succeeded") {
      return {
        id,
        relativePath,
        language: decision.language,
        parserUsed: "compiler-primary",
        success: true,
        usedFallback: false,
        diagnostics: [],
      };
    }

    if (decision.reason === "ignored_path") {
      return {
        id,
        relativePath,
        language: "unsupported",
        parserUsed: "none",
        success: false,
        usedFallback: false,
        diagnostics: [
          {
            message: `Path '${relativePath}' is in an ignored directory`,
            severity: "warning",
          },
        ],
      };
    }

    return {
      id,
      relativePath,
      language: "unsupported",
      parserUsed: "none",
      success: false,
      usedFallback: false,
      diagnostics: [
        {
          message: `Unsupported language or extension for path '${relativePath}'`,
          severity: "warning",
        },
      ],
    };
  }

  return parseTreeSitterFile(input);
}

