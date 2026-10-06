/**
 * Secure storage for API keys / tokens. Desktop backs this with the OS keychain
 * (Electron safeStorage); mobile with platform secure storage.
 */
export interface SecretStorePort {
  getSecret(key: string): Promise<string | null> | string | null;
  setSecret(key: string, value: string): Promise<void> | void;
  deleteSecret?(key: string): Promise<void> | void;
  /** Names of the stored secrets (never their values). */
  listSecrets?(): Promise<string[]> | string[];
}
