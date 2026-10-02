"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  completeGithubInstallationFromBrowser,
  type GithubSetupCompletionResult,
} from "../../../github/complete-setup";

export function GithubSetupCompletion({
  apiUrl,
  installationId,
}: {
  apiUrl: string;
  installationId: string;
}) {
  const { isLoaded, getToken } = useAuth();
  const [result, setResult] = useState<GithubSetupCompletionResult | null>(
    null,
  );

  useEffect(() => {
  if (!isLoaded) {
    return;
  }

  let cancelled = false;

  void completeGithubInstallationFromBrowser({
    apiUrl,
    installationId,
    getToken,
  }).then((next) => {
    if (!cancelled) {
      setResult(next);
    }
  });

  return () => {
    cancelled = true;
  };
}, [apiUrl, installationId, isLoaded, getToken]);

  return (
    <main>
      <h1>GitHub setup</h1>
      {result === null ? (
        <p>Connecting GitHub installation.</p>
      ) : result.ok ? (
        <>
          <p>
            {result.created
              ? "GitHub installation connected."
              : "GitHub installation already connected."}
          </p>
          <p>
            <Link href="/dashboard">Back to dashboard</Link>
          </p>
        </>
      ) : (
        <>
          <p>{result.message}</p>
          {result.message === "Authentication required." ? null : (
            <p>
              <Link href="/dashboard">Back to dashboard</Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
