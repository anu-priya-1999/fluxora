export interface SecretValue {
  value: string;
}

export interface SecretsClient {
  getSecret(name: string): Promise<SecretValue>;
  close?(): Promise<void> | void;
}