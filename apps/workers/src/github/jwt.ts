import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

const ISSUED_AT_SKEW_SECONDS = 60;
const LIFETIME_SECONDS = 8 * 60;

export type GithubAppJwtFailureReason =
  | "invalid_app_id"
  | "invalid_pem_parsing"
  | "unsupported_private_key_format"
  | "crypto_signing_failure";

export class GithubAppJwtError extends Error {
  readonly reason: GithubAppJwtFailureReason;

  constructor(reason: GithubAppJwtFailureReason) {
    super(`GitHub App JWT could not be created (${reason}).`);
    this.name = "GithubAppJwtError";
    this.reason = reason;
  }
}

export interface GithubAppJwtInput {
  appId: string;
  privateKeyPem: string;
  now?: Date;
}

/** GitHub App JWT (RS256). The private key is used to sign and is not embedded. */
export function createGithubAppJwt(input: GithubAppJwtInput): string {
  if (!/^[1-9]\d*$/.test(input.appId)) {
    throw new GithubAppJwtError("invalid_app_id");
  }

  const key = loadRsaPrivateKey(input.privateKeyPem);
  const issuedAt =
    Math.floor((input.now ?? new Date()).getTime() / 1000) -
    ISSUED_AT_SKEW_SECONDS;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: issuedAt,
    exp: issuedAt + ISSUED_AT_SKEW_SECONDS + LIFETIME_SECONDS,
    iss: input.appId,
  });
  const signingInput = `${header}.${payload}`;

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(key).toString("base64url");
    return `${signingInput}.${signature}`;
  } catch {
    throw new GithubAppJwtError("crypto_signing_failure");
  }
}

function loadRsaPrivateKey(privateKeyPem: string): KeyObject {
  const label = pemLabel(privateKeyPem);
  if (label === null) {
    throw new GithubAppJwtError("invalid_pem_parsing");
  }

  if (
    label === "OPENSSH PRIVATE KEY" ||
    label === "ENCRYPTED PRIVATE KEY" ||
    label === "EC PRIVATE KEY" ||
    label === "DSA PRIVATE KEY"
  ) {
    throw new GithubAppJwtError("unsupported_private_key_format");
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new GithubAppJwtError("invalid_pem_parsing");
  }

  if (key.asymmetricKeyType !== "rsa") {
    throw new GithubAppJwtError("unsupported_private_key_format");
  }

  return key;
}

function pemLabel(value: string): string | null {
  const match = value
    .trim()
    .match(/^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]+-----END \1-----$/);
  return match?.[1] ?? null;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
