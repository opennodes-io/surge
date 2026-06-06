/**
 * Secure storage for API keys / tokens. Desktop can back this with the OS keychain
 * (or the settings file today); mobile with platform secure storage.
 */
export interface SecretStorePort {
  getSecret(key: string): Promise<string | null> | string | null;
  setSecret(key: string, value: string): Promise<void> | void;
  deleteSecret?(key: string): Promise<void> | void;
}
