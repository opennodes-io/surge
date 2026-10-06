import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';
import type { SecretStorePort } from '@surge/core';

/**
 * API keys encrypted with the OS keychain via Electron safeStorage (DPAPI on Windows, Keychain on
 * macOS, libsecret/kwallet on Linux) and kept as ciphertext in <userData>/surge-secrets.json.
 * Synchronous, so SettingsService.get() can serve provider keys from it. Must be used after the
 * app is ready. Without a real keychain (Linux 'basic_text') it refuses to store anything.
 */
export class SecretStore implements SecretStorePort {
  private filePath: string;
  private data: Record<string, string> = {}; // name -> base64 ciphertext

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'surge-secrets.json');
    try {
      if (fs.existsSync(this.filePath)) this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')).secrets ?? {};
    } catch {
      this.data = {};
    }
  }

  /** True when values are protected by an OS keychain rather than a hard-coded key. */
  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }

  getSecret(name: string): string | null {
    const sealed = this.data[name];
    if (!sealed || !this.available()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    } catch {
      return null; // sealed by another OS user / machine
    }
  }

  setSecret(name: string, value: string): void {
    if (!this.available()) throw new Error('No OS keychain is available, so the key was not stored.');
    this.data[name] = safeStorage.encryptString(value).toString('base64');
    this.save();
  }

  deleteSecret(name: string): void {
    if (!(name in this.data)) return;
    delete this.data[name];
    this.save();
  }

  listSecrets(): string[] {
    return Object.keys(this.data);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, secrets: this.data }, null, 2), { mode: 0o600 });
  }
}
