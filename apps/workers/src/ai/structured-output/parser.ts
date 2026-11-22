/**
 * @file parser.ts
 * Strict JSON parser for model output.
 *
 * Enforces strict parsing rules:
 * - Full string must be valid JSON without leading/trailing explanatory prose
 * - Markdown code fences are explicitly rejected
 * - Non-object roots (arrays, primitives, null) are rejected
 * - Empty or whitespace-only responses are rejected
 * - No permissive auto-repair, coercion, or regex extraction
 */

import { VALIDATION_ERROR_CODES } from "./constants.ts";
import type { ValidationIssue } from "./types.ts";

export type ParseStrictJsonObjectResult =
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly issue: ValidationIssue;
    };

/**
 * Parses raw text as a strict JSON object.
 * Rejects leading/trailing prose, Markdown fences, primitives, arrays, and malformed JSON.
 */
export function parseStrictJsonObject(rawText: string): ParseStrictJsonObjectResult {
  if (typeof rawText !== "string") {
    return {
      ok: false,
      issue: {
        category: "parse",
        code: VALIDATION_ERROR_CODES.INVALID_INPUT,
        path: "$",
        message: "Response must be a string.",
      },
    };
  }

  const trimmed = rawText.trim();

  if (trimmed.length === 0) {
    return {
      ok: false,
      issue: {
        category: "parse",
        code: VALIDATION_ERROR_CODES.EMPTY_RESPONSE,
        path: "$",
        message: "Response is empty or contains only whitespace.",
      },
    };
  }

  // Reject Markdown code fences explicitly
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    return {
      ok: false,
      issue: {
        category: "parse",
        code: VALIDATION_ERROR_CODES.MARKDOWN_CODE_FENCE_DETECTED,
        path: "$",
        message:
          "Response contains Markdown code fences. Expected a pure raw JSON object without enclosing markdown.",
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "SyntaxError";
    return {
      ok: false,
      issue: {
        category: "parse",
        code: VALIDATION_ERROR_CODES.JSON_PARSE_ERROR,
        path: "$",
        message: `Failed to parse response as JSON: ${errorMsg}`,
      },
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const actualType = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      issue: {
        category: "parse",
        code: VALIDATION_ERROR_CODES.INVALID_ROOT_TYPE,
        path: "$",
        message: `Expected a JSON object at root, received ${actualType}.`,
      },
    };
  }

  return {
    ok: true,
    value: parsed as Record<string, unknown>,
  };
}
