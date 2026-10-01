import { createSign } from "node:crypto";

const ISSUED_AT_SKEW_SECONDS = 60;
const LIFETIME_SECONDS = 8 * 60;

export interface GithubAppJwtInput {
  appId: string;
  privateKeyPem: string;
  now?: Date;
}

/** GitHub App JWT (RS256). The private key is used to sign and is not embedded. */
export function createGithubAppJwt(input: GithubAppJwtInput): string {
  if (!/^[1-9]\d*$/.test(input.appId)) {
    throw new Error("GitHub App id is invalid.");
  }

  const issuedAt =
    Math.floor((input.now ?? new Date()).getTime() / 1000) -
    ISSUED_AT_SKEW_SECONDS;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  // exp is 9 minutes after iat (60s skew + 8 minute lifetime), under GitHub's 10 minute maximum.
  const payload = base64UrlJson({
    iat: issuedAt,
    exp: issuedAt + ISSUED_AT_SKEW_SECONDS + LIFETIME_SECONDS,
    iss: input.appId,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(input.privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function decodeGithubAppJwtPayload(
  token: string,
): { iat: number; exp: number; iss: string } {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) {
    throw new Error("GitHub App JWT is malformed.");
  }

  const parsed: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );

  if (!isRecord(parsed)) {
    throw new Error("GitHub App JWT payload is malformed.");
  }

  if (
    typeof parsed.iat !== "number" ||
    typeof parsed.exp !== "number" ||
    typeof parsed.iss !== "string"
  ) {
    throw new Error("GitHub App JWT payload is malformed.");
  }

  return { iat: parsed.iat, exp: parsed.exp, iss: parsed.iss };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
