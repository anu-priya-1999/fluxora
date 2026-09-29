import type { SecretValue, SecretsClient } from "./client.ts";

export class EnvSecretsProvider implements SecretsClient {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.environment = environment;
  }

  async getSecret(name: string): Promise<SecretValue> {
    const value = this.environment[name];

    if (value === undefined || value.length === 0) {
      throw new Error(`Secret "${name}" is not configured`);
    }

    return { value };
  }
}
