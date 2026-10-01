export interface ParsedGithubInstallation {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
}

export class GithubInstallationResponseError extends Error {
  constructor() {
    super("GitHub installation response was invalid.");
    this.name = "GithubInstallationResponseError";
  }
}

const MAX_BODY_CHARS = 1_000_000;

/**
 * Parses a GitHub installation resource.
 * Integer fields are read from the raw JSON text so ids are not passed through Number().
 */
export function parseGithubInstallationResponse(
  body: string,
): ParsedGithubInstallation {
  if (body.length === 0 || body.length > MAX_BODY_CHARS) {
    throw new GithubInstallationResponseError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteJsonIntegers(body));
  } catch {
    throw new GithubInstallationResponseError();
  }

  if (!isRecord(parsed) || !isRecord(parsed.account)) {
    throw new GithubInstallationResponseError();
  }

  const installationId = requiredCanonicalId(parsed.id);
  const accountId = requiredCanonicalId(parsed.account.id);
  const accountLogin = parsed.account.login;
  const accountType = parsed.account.type;

  if (typeof accountLogin !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(accountLogin)) {
    throw new GithubInstallationResponseError();
  }

  if (accountType !== "User" && accountType !== "Organization") {
    throw new GithubInstallationResponseError();
  }

  return {
    installationId,
    accountId,
    accountLogin,
    accountType,
  };
}

/**
 * Quotes JSON integers that sit outside strings so JSON.parse cannot round them.
 * Numeric literals inside strings are left untouched.
 */
export function quoteJsonIntegers(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (character === undefined) {
      break;
    }

    if (inString) {
      out += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }

    if (character === "-" || isDigit(character)) {
      const numberEnd = readJsonNumberEnd(json, index);
      if (numberEnd > index) {
        const raw = json.slice(index, numberEnd);
        // Quote only complete integers. Quoting the "1" in "1.5" would leave a broken ".5".
        out += /^-?\d+$/.test(raw) ? `"${raw}"` : raw;
        index = numberEnd - 1;
        continue;
      }
    }

    out += character;
  }

  return out;
}

function readJsonNumberEnd(json: string, start: number): number {
  let index = start;
  if (json[index] === "-") {
    index += 1;
  }

  if (!isDigit(json[index] ?? "")) {
    return start;
  }

  while (isDigit(json[index] ?? "")) {
    index += 1;
  }

  if (json[index] === ".") {
    index += 1;
    while (isDigit(json[index] ?? "")) {
      index += 1;
    }
  }

  if (json[index] === "e" || json[index] === "E") {
    index += 1;
    if (json[index] === "+" || json[index] === "-") {
      index += 1;
    }
    while (isDigit(json[index] ?? "")) {
      index += 1;
    }
  }

  return index;
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function requiredCanonicalId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new GithubInstallationResponseError();
  }

  if (BigInt(value) > 9223372036854775807n) {
    throw new GithubInstallationResponseError();
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
