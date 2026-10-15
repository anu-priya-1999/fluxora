import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookSignatureVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | "missing_signature"
        | "missing_secret"
        | "invalid_format"
        | "mismatch";
    };

const SIGNATURE_PREFIX = "sha256=";
const HEX_SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Computes the HMAC-SHA256 signature header value of a raw body with a given secret.
 * Used for testing and signature generation.
 */
export function computeGithubWebhookSignature(
  rawBody: Buffer | string,
  secret: string,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  return `${SIGNATURE_PREFIX}${hmac.digest("hex")}`;
}

/**
 * Validates the X-Hub-Signature-256 header against the raw body using timing-safe comparison.
 * Never logs or exposes the secret.
 */
export function verifyGithubWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): WebhookSignatureVerificationResult {
  if (secret === undefined || secret.trim().length === 0) {
    return { valid: false, reason: "missing_secret" };
  }

  if (signatureHeader === undefined || signatureHeader.trim().length === 0) {
    return { valid: false, reason: "missing_signature" };
  }

  const trimmed = signatureHeader.trim();
  if (!trimmed.startsWith(SIGNATURE_PREFIX)) {
    return { valid: false, reason: "invalid_format" };
  }

  const signatureHex = trimmed.slice(SIGNATURE_PREFIX.length);
  if (!HEX_SHA256_PATTERN.test(signatureHex)) {
    return { valid: false, reason: "invalid_format" };
  }

  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const expectedDigest = hmac.digest();

  const signatureBuffer = Buffer.from(signatureHex, "hex");

  if (signatureBuffer.length !== expectedDigest.length) {
    return { valid: false, reason: "mismatch" };
  }

  if (!timingSafeEqual(signatureBuffer, expectedDigest)) {
    return { valid: false, reason: "mismatch" };
  }

  return { valid: true };
}

