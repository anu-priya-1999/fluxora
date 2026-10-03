import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import type { GithubInstallation } from "@fluxora/shared-types";

import { loadGithubAppConfig, normalizePrivateKeyPem } from "./config.ts";
import {
  completeInstallation,
  GithubAppMisconfiguredError,
  GithubInstallationRoleError,
} from "./complete-installation.ts";
import { GithubInstallationIdError, parseGithubInstallationId, readGithubInstallationIdField } from "./installation-id.ts";
import {
  createGithubAppJwt,
  decodeGithubAppJwtPayload,
} from "./jwt.ts";
import { parseGithubInstallationResponse } from "./parse-installation.ts";
import { redactForLog } from "./redact.ts";
import { githubInstallationHttpError } from "./http-error.ts";
import { InstallationOwnershipError } from "./verify-installation.ts";
import {
  corsHeadersForAllowedOrigin,
  githubInstallationPreflight,
  loadAllowedWebOrigins,
  rejectedCorsOriginForLog,
} from "../http/cors.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const now = new Date("2026-01-01T00:00:00.000Z");

test("GitHub App JWT is RS256, short-lived, and does not contain the private key", () => {
  const token = createGithubAppJwt({
    appId: "8675309",
    privateKeyPem: privateKey,
    now,
  });

  assert.equal(token.includes("PRIVATE"), false);
  assert.equal(token.split(".").length, 3);

  const header = JSON.parse(
    Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as { alg: string; typ: string };
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });

  const payload = decodeGithubAppJwtPayload(token);
  assert.equal(payload.iss, "8675309");
  assert.equal(payload.iat, 1_767_225_600 - 60);
  assert.equal(payload.exp - payload.iat, 540);
  assert.ok(payload.exp - payload.iat <= 600);

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature ?? "", "base64url"),
    ),
    true,
  );
});

test("escaped PEM newlines still sign a GitHub App JWT", () => {
  const escaped = privateKey.replace(/\n/g, "\\n");
  const normalized = normalizePrivateKeyPem(escaped);
  const token = createGithubAppJwt({
    appId: "42",
    privateKeyPem: normalized,
    now,
  });

  assert.equal(decodeGithubAppJwtPayload(token).iss, "42");
});

test("GitHub App config treats blank values as unset and rejects a non-pem", () => {
  assert.equal(
    loadGithubAppConfig({
      GITHUB_APP_ID: "  ",
      GITHUB_APP_PRIVATE_KEY: "",
    }),
    null,
  );

  assert.throws(
    () =>
      loadGithubAppConfig({
        GITHUB_APP_ID: "42",
        GITHUB_APP_PRIVATE_KEY: "not-a-key",
      }),
    /PEM private key/,
  );

  const loaded = loadGithubAppConfig({
    GITHUB_APP_ID: "42",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_API_BASE_URL: "https://api.github.com/extra",
  });
  assert.equal(loaded?.apiBaseUrl, "https://api.github.com");
  assert.equal(loaded?.privateKeyPem.includes("BEGIN"), true);
});

test("installation ids stay strings and reject JSON numbers", () => {
  assert.equal(parseGithubInstallationId("9007199254740993"), "9007199254740993");
  assert.throws(() => parseGithubInstallationId(123), GithubInstallationIdError);
  assert.throws(() => parseGithubInstallationId("0123"), GithubInstallationIdError);
  assert.throws(
    () => parseGithubInstallationId("9223372036854775808"),
    GithubInstallationIdError,
  );
  assert.equal(
    readGithubInstallationIdField({ github_installation_id: "77" }),
    "77",
  );
  assert.throws(
    () => readGithubInstallationIdField({ github_installation_id: 77 }),
    GithubInstallationIdError,
  );
  assert.throws(
    () => readGithubInstallationIdField({ installation_id: "77" }),
    GithubInstallationIdError,
  );
});

test("GitHub installation JSON preserves integer ids that do not fit in Number", () => {
  const body = `{"id":9007199254740993,"account":{"login":"octocat","id":4242,"type":"User","bio":"id: 999999999999999999"}}`;
  const parsed = parseGithubInstallationResponse(body);

  assert.equal(parsed.installationId, "9007199254740993");
  assert.equal(parsed.accountId, "4242");
  assert.equal(parsed.accountLogin, "octocat");
  assert.equal(parsed.accountType, "User");

  const withDecimal = parseGithubInstallationResponse(
    `{"id":555,"account":{"login":"octocat","id":4242,"type":"User"},"weight":1.5}`,
  );
  assert.equal(withDecimal.installationId, "555");
  assert.equal(withDecimal.accountId, "4242");
});

test("installation completion verifies the Clerk GitHub account before saving", async () => {
  const saved: unknown[] = [];
  const result = await completeInstallation({
    role: "owner",
    organizationId: "org-1",
    githubUserId: "4242",
    githubInstallationId: "555",
    now,
    config: {
      appId: "42",
      privateKeyPem: privateKey,
      apiBaseUrl: "https://api.github.com",
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.github.com/app/installations/555");
      const headers = init?.headers as Record<string, string>;
      assert.match(headers.authorization ?? "", /^Bearer ey/);
      assert.equal(headers.authorization?.includes("PRIVATE"), false);
      assert.equal(headers["user-agent"], "fluxora");
      return new Response(
        `{"id":555,"account":{"login":"octocat","id":4242,"type":"User"}}`,
        { status: 200 },
      );
    },
    writer: {
      async save(input) {
        saved.push(input);
        const installation: GithubInstallation = {
          id: "row-1",
          organizationId: input.organizationId,
          githubInstallationId: input.githubInstallationId,
          githubAccountId: input.githubAccountId,
          githubAccountLogin: input.githubAccountLogin,
          githubAccountType: "User",
          createdAt: now,
          updatedAt: now,
        };
        return { installation, created: saved.length === 1 };
      },
    },
  });

  assert.equal(result.created, true);
  assert.equal(result.installation.githubInstallationId, "555");
  assert.equal(saved.length, 1);

  const replay = await completeInstallation({
    role: "owner",
    organizationId: "org-1",
    githubUserId: "4242",
    githubInstallationId: "555",
    now,
    config: {
      appId: "42",
      privateKeyPem: privateKey,
      apiBaseUrl: "https://api.github.com",
    },
    fetchImpl: async () =>
      new Response(
        `{"id":555,"account":{"login":"octocat","id":4242,"type":"User"}}`,
        { status: 200 },
      ),
    writer: {
      async save(input) {
        saved.push(input);
        const installation: GithubInstallation = {
          id: "row-1",
          organizationId: input.organizationId,
          githubInstallationId: input.githubInstallationId,
          githubAccountId: input.githubAccountId,
          githubAccountLogin: input.githubAccountLogin,
          githubAccountType: "User",
          createdAt: now,
          updatedAt: now,
        };
        return { installation, created: false };
      },
    },
  });

  assert.equal(replay.created, false);
  assert.equal(replay.installation.id, "row-1");
});

test("installation completion does not save when the GitHub account does not match", async () => {
  let saved = 0;

  await assert.rejects(
    () =>
      completeInstallation({
        role: "owner",
        organizationId: "org-1",
        githubUserId: "4242",
        githubInstallationId: "555",
        now,
        config: {
          appId: "42",
          privateKeyPem: privateKey,
          apiBaseUrl: "https://api.github.com",
        },
        fetchImpl: async () =>
          new Response(
            `{"id":555,"account":{"login":"other","id":999,"type":"User"}}`,
            { status: 200 },
          ),
        writer: {
          async save() {
            saved += 1;
            throw new Error("should not save");
          },
        },
      }),
    InstallationOwnershipError,
  );

  assert.equal(saved, 0);
});

test("organization installations are not treated as the signed-in user", async () => {
  await assert.rejects(
    () =>
      completeInstallation({
        role: "admin",
        organizationId: "org-1",
        githubUserId: "4242",
        githubInstallationId: "555",
        now,
        config: {
          appId: "42",
          privateKeyPem: privateKey,
          apiBaseUrl: "https://api.github.com",
        },
        fetchImpl: async () =>
          new Response(
            `{"id":555,"account":{"login":"acme","id":4242,"type":"Organization"}}`,
            { status: 200 },
          ),
        writer: {
          async save() {
            throw new Error("should not save");
          },
        },
      }),
    InstallationOwnershipError,
  );
});

test("viewers cannot complete a GitHub installation", async () => {
  await assert.rejects(
    () =>
      completeInstallation({
        role: "viewer",
        organizationId: "org-1",
        githubUserId: "4242",
        githubInstallationId: "555",
        now,
        config: {
          appId: "42",
          privateKeyPem: privateKey,
          apiBaseUrl: "https://api.github.com",
        },
        fetchImpl: async () => {
          throw new Error("should not call GitHub");
        },
        writer: {
          async save() {
            throw new Error("should not save");
          },
        },
      }),
    GithubInstallationRoleError,
  );
});

test("a bad private key becomes a misconfiguration error without echoing the key", async () => {
  const secret = "super-secret-key-material";
  await assert.rejects(
    () =>
      completeInstallation({
        role: "owner",
        organizationId: "org-1",
        githubUserId: "4242",
        githubInstallationId: "555",
        config: {
          appId: "42",
          privateKeyPem: secret,
          apiBaseUrl: "https://api.github.com",
        },
        fetchImpl: async () => {
          throw new Error("should not call GitHub");
        },
        writer: {
          async save() {
            throw new Error("should not save");
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof GithubAppMisconfiguredError);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("installation HTTP errors use stable codes and omit credentials", () => {
  const mapped = githubInstallationHttpError(new InstallationOwnershipError());
  assert.equal(mapped?.status, 403);
  assert.equal(mapped?.code, "installation_account_mismatch");
  assert.equal(mapped?.message.includes("Bearer"), false);
});

test("log redaction removes PEMs, bearer tokens, and JWTs", () => {
  const token = createGithubAppJwt({
    appId: "42",
    privateKeyPem: privateKey,
    now,
  });
  const redacted = redactForLog(
    `failed ${token} Bearer ${token} key ${privateKey} trailing`,
  );

  assert.equal(redacted.includes("PRIVATE"), false);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.match(redacted, /\[redacted private key\]/);
  assert.match(redacted, /\[redacted jwt\]/);
});

test("GitHub installation CORS allows only configured web origins", () => {
  const allowed = loadAllowedWebOrigins({
    CLERK_AUTHORIZED_PARTIES:
      "https://fluxora-rho-cyan.vercel.app,http://localhost:3000",
  });
  const vercel = corsHeadersForAllowedOrigin(
    "https://fluxora-rho-cyan.vercel.app",
    allowed,
  );
  const local = corsHeadersForAllowedOrigin("http://localhost:3000", allowed);
  const rejected = corsHeadersForAllowedOrigin("https://evil.example", allowed);

  assert.equal(vercel?.["access-control-allow-origin"], "https://fluxora-rho-cyan.vercel.app");
  assert.equal(local?.["access-control-allow-origin"], "http://localhost:3000");
  assert.equal(rejected, undefined);
  assert.equal(Object.values(vercel ?? {}).includes("*"), false);
  assert.equal(vercel?.["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.equal(
    vercel?.["access-control-allow-headers"],
    "Authorization, Content-Type",
  );
});

test("GitHub installation OPTIONS preflight echoes the allowed origin", () => {
  const allowed = loadAllowedWebOrigins({
    CLERK_AUTHORIZED_PARTIES: "https://fluxora-rho-cyan.vercel.app",
  });
  const preflight = githubInstallationPreflight(
    "https://fluxora-rho-cyan.vercel.app",
    allowed,
  );
  const blocked = githubInstallationPreflight("https://evil.example", allowed);

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    "https://fluxora-rho-cyan.vercel.app",
  );
  assert.equal(preflight.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.equal(
    preflight.headers["access-control-allow-headers"],
    "Authorization, Content-Type",
  );
  assert.equal(blocked.status, 204);
  assert.equal(blocked.headers["access-control-allow-origin"], undefined);
});

test("a per-deployment Vercel origin is rejected without echoing unsafe values", () => {
  const allowed = loadAllowedWebOrigins({
    CLERK_AUTHORIZED_PARTIES: "https://fluxora-rho-cyan.vercel.app",
  });

  assert.equal(
    rejectedCorsOriginForLog(
      "https://fluxora-9yp7s70sy-mera-baba.vercel.app",
      allowed,
    ),
    "https://fluxora-9yp7s70sy-mera-baba.vercel.app",
  );
  assert.equal(
    rejectedCorsOriginForLog("https://fluxora-rho-cyan.vercel.app", allowed),
    undefined,
  );
  assert.equal(rejectedCorsOriginForLog(undefined, allowed), undefined);
  assert.equal(
    rejectedCorsOriginForLog("https://user:secret@evil.example", allowed),
    "rejected",
  );
  assert.equal(rejectedCorsOriginForLog("not a url", allowed), "rejected");
});

test("GitHub installation CORS defaults to the Clerk local web origin", () => {
  const allowed = loadAllowedWebOrigins({});
  const headers = corsHeadersForAllowedOrigin("http://localhost:3000", allowed);

  assert.deepEqual(allowed, ["http://localhost:3000"]);
  assert.equal(headers?.["access-control-allow-origin"], "http://localhost:3000");
  assert.equal(corsHeadersForAllowedOrigin("*", allowed), undefined);
});
