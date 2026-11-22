/**
 * @file parser.test.ts
 * Comprehensive unit tests for strict JSON parsing of model responses.
 */

import { describe, expect, it } from "vitest";

import { VALIDATION_ERROR_CODES } from "./constants.ts";
import { parseStrictJsonObject } from "./parser.ts";

describe("Strict JSON Parser", () => {
  it("successfully parses valid compact and formatted JSON objects", () => {
    const compact = '{"summary":"Impact explanation","claims":[],"confidence":"high","caveats":[]}';
    const parsed1 = parseStrictJsonObject(compact);
    expect(parsed1.ok).toBe(true);
    if (parsed1.ok) {
      expect(parsed1.value.summary).toBe("Impact explanation");
    }

    const formatted = `
    {
      "summary": "Impact explanation",
      "claims": [],
      "confidence": "high",
      "caveats": []
    }
    `;
    const parsed2 = parseStrictJsonObject(formatted);
    expect(parsed2.ok).toBe(true);
    if (parsed2.ok) {
      expect(parsed2.value.confidence).toBe("high");
    }
  });

  it("rejects non-string input", () => {
    // @ts-expect-error testing invalid runtime input
    const res = parseStrictJsonObject(12345);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.code).toBe(VALIDATION_ERROR_CODES.INVALID_INPUT);
      expect(res.issue.category).toBe("parse");
    }
  });

  it("rejects empty string and whitespace-only input", () => {
    const res1 = parseStrictJsonObject("");
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issue.code).toBe(VALIDATION_ERROR_CODES.EMPTY_RESPONSE);
    }

    const res2 = parseStrictJsonObject("   \n\t  ");
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issue.code).toBe(VALIDATION_ERROR_CODES.EMPTY_RESPONSE);
    }
  });

  it("rejects Markdown code fences enclosing JSON", () => {
    const fencedJson = '```json\n{"summary":"Test","claims":[],"confidence":"high","caveats":[]}\n```';
    const res = parseStrictJsonObject(fencedJson);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.code).toBe(VALIDATION_ERROR_CODES.MARKDOWN_CODE_FENCE_DETECTED);
      expect(res.issue.message).toContain("Markdown code fences");
    }

    const fencedNoLang = '```\n{"summary":"Test"}\n```';
    const res2 = parseStrictJsonObject(fencedNoLang);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issue.code).toBe(VALIDATION_ERROR_CODES.MARKDOWN_CODE_FENCE_DETECTED);
    }
  });

  it("rejects leading explanatory prose", () => {
    const prose = 'Here is the requested JSON response:\n{"summary":"Test","claims":[],"confidence":"high","caveats":[]}';
    const res = parseStrictJsonObject(prose);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.code).toBe(VALIDATION_ERROR_CODES.JSON_PARSE_ERROR);
    }
  });

  it("rejects trailing explanatory prose", () => {
    const prose = '{"summary":"Test","claims":[],"confidence":"high","caveats":[]}\nHope this explanation helps!';
    const res = parseStrictJsonObject(prose);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.code).toBe(VALIDATION_ERROR_CODES.JSON_PARSE_ERROR);
    }
  });

  it("rejects malformed JSON syntax", () => {
    const malformed = '{"summary": "missing trailing brace"';
    const res = parseStrictJsonObject(malformed);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.code).toBe(VALIDATION_ERROR_CODES.JSON_PARSE_ERROR);
      // Ensure the error message does not echo the entire raw response
      expect(res.issue.message).not.toContain("missing trailing brace");
    }
  });

  it("rejects JSON array at root level", () => {
    const arrayJson = '[{"summary":"Test"}]';
    const res = parseStrictJsonObject(arrayJson);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.code).toBe(VALIDATION_ERROR_CODES.INVALID_ROOT_TYPE);
      expect(res.issue.message).toContain("received array");
    }
  });

  it("rejects JSON primitives at root level", () => {
    const stringJson = '"just a string"';
    const res1 = parseStrictJsonObject(stringJson);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issue.code).toBe(VALIDATION_ERROR_CODES.INVALID_ROOT_TYPE);
    }

    const numberJson = '42';
    const res2 = parseStrictJsonObject(numberJson);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issue.code).toBe(VALIDATION_ERROR_CODES.INVALID_ROOT_TYPE);
    }

    const booleanJson = 'true';
    const res3 = parseStrictJsonObject(booleanJson);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issue.code).toBe(VALIDATION_ERROR_CODES.INVALID_ROOT_TYPE);
    }

    const nullJson = 'null';
    const res4 = parseStrictJsonObject(nullJson);
    expect(res4.ok).toBe(false);
    if (!res4.ok) {
      expect(res4.issue.code).toBe(VALIDATION_ERROR_CODES.INVALID_ROOT_TYPE);
      expect(res4.issue.message).toContain("received null");
    }
  });
});
