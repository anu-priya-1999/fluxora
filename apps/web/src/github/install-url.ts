/** Public GitHub App install URL. The slug is not a secret. Installation ids are never put here. */
export function githubAppInstallUrl(slug: string | undefined): string | null {
  if (slug === undefined) {
    return null;
  }

  const trimmed = slug.trim();
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
    return null;
  }

  return `https://github.com/apps/${trimmed}/installations/new`;
}
