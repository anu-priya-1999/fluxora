const SECRET_MIN_LENGTH = 32;

export interface AuthConfig {
  port: number;
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const clerkSecretKey = required(env, "CLERK_SECRET_KEY");

  if (clerkSecretKey.length < SECRET_MIN_LENGTH) {
    throw new Error(
      `CLERK_SECRET_KEY must be at least ${SECRET_MIN_LENGTH} characters.`,
    );
  }

  return {
    port: readPort(env.API_PORT),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set.`);
  }

  return value.trim();
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 4000;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error("API_PORT must be an integer.");
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be between 1 and 65535.");
  }

  return port;
}
