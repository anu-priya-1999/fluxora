import { createClerkClient, verifyToken } from "@clerk/backend";

const authorizedParties = (
  process.env.CLERK_AUTHORIZED_PARTIES ?? "http://localhost:3000"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

let clerkClientInstance: ReturnType<typeof createClerkClient> | null = null;

function getSecretKey(): string {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is required.");
  }
  return secretKey;
}

function getClerkClient(): ReturnType<typeof createClerkClient> {
  if (!clerkClientInstance) {
    clerkClientInstance = createClerkClient({ secretKey: getSecretKey() });
  }
  return clerkClientInstance;
}

export async function authenticateClerkToken(
  authorization: string | undefined,
): Promise<string> {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token.");
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    throw new Error("Missing bearer token.");
  }

  const payload = await verifyToken(token, {
    secretKey: getSecretKey(),
    authorizedParties,
  });

  if (!payload.sub) {
    throw new Error("Clerk token has no subject.");
  }

  return payload.sub;
}

export type ClerkGithubIdentity =
  | {
      ok: true;
      githubUserId: string;
      email: string;
      organizationName: string;
    }
  | {
      ok: false;
      code: "github_account_required" | "email_required";
      message: string;
    };

export async function getClerkGithubIdentity(
  clerkUserId: string,
): Promise<ClerkGithubIdentity> {
  const user = await getClerkClient().users.getUser(clerkUserId);

  const github = user.externalAccounts.find((account) => {
    const provider = account.provider.toLowerCase();

    return provider === "github" || provider === "oauth_github";
  });

  if (!github?.providerUserId) {
    return {
      ok: false,
      code: "github_account_required",
      message: "A connected GitHub account is required.",
    };
  }

  const email =
    user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId,
    )?.emailAddress ?? github.emailAddress;

  if (!email) {
    return {
      ok: false,
      code: "email_required",
      message: "A verified email address is required.",
    };
  }

  const organizationName =
    (github.username ??
      user.username ??
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim()) ||
    email.split("@")[0] ||
    "Fluxora Organization";

  return {
    ok: true,
    githubUserId: github.providerUserId,
    email,
    organizationName,
  };
}
