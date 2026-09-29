const DATABASE_URL_ENV = "DATABASE_URL";

export function getDatabaseUrl(): string {
  const url = process.env[DATABASE_URL_ENV];
  if (url === undefined || url.length === 0) {
    throw new Error(
      `${DATABASE_URL_ENV} is not set. Copy .env.example to .env and point it at your local fluxora_dev database.`,
    );
  }
  return url;
}
