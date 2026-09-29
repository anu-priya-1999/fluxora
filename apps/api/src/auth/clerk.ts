import { createClerkClient, verifyToken } from "@clerk/backend";

const secretKey = process.env.CLERK_SECRET_KEY;
const authorizedParties = (process.env.CLERK_AUTHORIZED_PARTIES ?? "http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!secretKey) {
  throw new Error("CLERK_SECRET_KEY is required.");
}

const clerkClient = createClerkClient({ secretKey });

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
    secretKey,
    authorizedParties,
  });

  if (!payload.sub) {
    throw new Error("Clerk token has no subject.");
  }

  return payload.sub;
}

export async function getClerkGithubIdentity(clerkUserId: string) {
  const user = await clerkClient.users.getUser(clerkUserId);

  const github = user.externalAccounts.find(
    (account) => account.provider === "github",
  );

  const email = user.primaryEmailAddress?.emailAddress;

  if (!github?.providerUserId || !email) {
    throw new Error("A verified GitHub account and email are required.");
  }

  return {
    githubUserId: github.providerUserId,
    email,
    organizationName:
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      email.split("@")[0] ||
      "Fluxora Organization",
  };
}

