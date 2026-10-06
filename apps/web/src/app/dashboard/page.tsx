import { auth } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

import { readGithubAppSlug } from "../../github/env";
import { githubAppInstallUrl } from "../../github/install-url";
import { RepositoryIndexedLiveFeed } from "./repository-indexed-feed";

export const runtime = "nodejs";

export default async function DashboardPage() {
  const { userId, isAuthenticated } = await auth();

  if (!isAuthenticated) {
    return null;
  }

  const installUrl = githubAppInstallUrl(readGithubAppSlug());

  return (
    <main>
      <header>
        <h1>Fluxora</h1>
        <UserButton />
      </header>

      <section>
        <h2>Organization Dashboard</h2>
        <p>Your Fluxora workspace is ready.</p>
        <p>User ID: {userId}</p>
        <p>No repositories connected yet.</p>
        <p>
          {installUrl === null ? (
            "Connect GitHub is not configured."
          ) : (
            <a href={installUrl} rel="noopener noreferrer">
              Connect GitHub
            </a>
          )}
        </p>
        <RepositoryIndexedLiveFeed />
      </section>
    </main>
  );
}
