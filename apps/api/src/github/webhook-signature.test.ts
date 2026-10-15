import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  computeGithubWebhookSignature,
  verifyGithubWebhookSignature,
} from "./webhook-signature.ts";

describe("GitHub Webhook Signature Verification", () => {
  const secret = "test-secret-12345";
  const payload = Buffer.from('{"hello":"world"}', "utf8");

  it("successfully verifies valid HMAC-SHA256 signature", () => {
    const signature = computeGithubWebhookSignature(payload, secret);
    const result = verifyGithubWebhookSignature(payload, signature, secret);
    assert.deepEqual(result, { valid: true });
  });

  it("accepts string rawBody as well as Buffer", () => {
    const bodyStr = '{"hello":"world"}';
    const signature = computeGithubWebhookSignature(bodyStr, secret);
    const result = verifyGithubWebhookSignature(bodyStr, signature, secret);
    assert.deepEqual(result, { valid: true });
  });

  it("rejects when secret is missing or empty", () => {
    const signature = computeGithubWebhookSignature(payload, secret);
    assert.deepEqual(verifyGithubWebhookSignature(payload, signature, undefined), {
      valid: false,
      reason: "missing_secret",
    });
    assert.deepEqual(verifyGithubWebhookSignature(payload, signature, "   "), {
      valid: false,
      reason: "missing_secret",
    });
  });

  it("rejects when signature header is missing or empty", () => {
    assert.deepEqual(verifyGithubWebhookSignature(payload, undefined, secret), {
      valid: false,
      reason: "missing_signature",
    });
    assert.deepEqual(verifyGithubWebhookSignature(payload, "", secret), {
      valid: false,
      reason: "missing_signature",
    });
    assert.deepEqual(verifyGithubWebhookSignature(payload, "   ", secret), {
      valid: false,
      reason: "missing_signature",
    });
  });

  it("rejects invalid signature format (missing sha256= prefix)", () => {
    const rawHex = computeGithubWebhookSignature(payload, secret).replace("sha256=", "");
    assert.deepEqual(verifyGithubWebhookSignature(payload, rawHex, secret), {
      valid: false,
      reason: "invalid_format",
    });
    assert.deepEqual(verifyGithubWebhookSignature(payload, `sha1=${rawHex}`, secret), {
      valid: false,
      reason: "invalid_format",
    });
  });

  it("rejects invalid signature length or non-hex characters", () => {
    assert.deepEqual(
      verifyGithubWebhookSignature(payload, "sha256=tooshort", secret),
      { valid: false, reason: "invalid_format" },
    );
    assert.deepEqual(
      verifyGithubWebhookSignature(
        payload,
        "sha256=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        secret,
      ),
      { valid: false, reason: "invalid_format" },
    );
  });

  it("rejects signature mismatch for different payload or secret", () => {
    const signature = computeGithubWebhookSignature(payload, secret);
    const differentPayload = Buffer.from('{"hello":"other"}', "utf8");
    assert.deepEqual(
      verifyGithubWebhookSignature(differentPayload, signature, secret),
      { valid: false, reason: "mismatch" },
    );

    const differentSecret = "different-secret";
    assert.deepEqual(
      verifyGithubWebhookSignature(payload, signature, differentSecret),
      { valid: false, reason: "mismatch" },
    );
  });
});

