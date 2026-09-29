import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import type {
  SecretValue,
  SecretsClient,
} from "./client.ts";

export interface SecretsManagerProviderOptions {
  region: string;
  client?: SecretsManagerClient;
}

export class SecretsManagerProvider implements SecretsClient {
  private readonly client: SecretsManagerClient;

  constructor(options: SecretsManagerProviderOptions) {
    if (!options.client && !options.region.trim()) {
      throw new Error("AWS region is required");
    }

    this.client =
      options.client ??
      new SecretsManagerClient({
        region: options.region,
      });
  }

  async getSecret(name: string): Promise<SecretValue> {
    if (!name.trim()) {
      throw new Error("Secret name is required");
    }

    const response = await this.client.send(
      new GetSecretValueCommand({
        SecretId: name,
      }),
    );

    if (response.SecretString !== undefined) {
      return {
        value: response.SecretString,
      };
    }

    if (response.SecretBinary !== undefined) {
      const binary =
        typeof response.SecretBinary === "string"
          ? response.SecretBinary
          : new TextDecoder().decode(response.SecretBinary);

      return {
        value: binary,
      };
    }

    throw new Error(`Secret "${name}" has no value`);
  }

  close(): void {
    this.client.destroy();
  }
}