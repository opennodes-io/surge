import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';
import type { SecretStorePort } from '@surge/core';

/**
 * API keys encrypted with the OS keychain via Electron safeStorage and kept as ciphertext in
 * <userData>/surge-secrets.json. On Windows the AES key that seals them is in <userData>/Local State,
 * protected by DPAPI; macOS uses the Keychain, Linux libsecret/kwallet.
 *
 * Uses safeStorage's async methods: Electron 45 deprecates the synchronous ones and 46 removes them.
 * `SecretStore.open()` decrypts every saved value once, after the app is ready. Reads are then served
 * from memory, so SettingsService.get() stays synchronous. A write is readable at once, and is sealed
 * and saved in order in the background; `flush()` waits for those writes.
 * Ciphertext from the synchronous methods (Surge 0.1.8 and earlier, Electron 35) reads the same, and
 * Electron 35 reads what this writes, so going back a version keeps the keys.
 * Without a real keychain (Linux 'basic_text') it refuses to store anything.
 */
export class SecretStore implements SecretStorePort {
  private readonly filePath: string;
  private sealed: Record<string, string> = {}; // name -> base64 ciphertext, as on disk
  private plain = new Map<string, string>(); // name -> value, for every saved name that decrypted
  private unreadable = new Set<string>(); // saved names that didn't decrypt (another OS user / machine)
  private keychain = false;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  private constructor() {
    this.filePath = path.join(app.getPath('userData'), 'surge-secrets.json');
    try {
      if (fs.existsSync(this.filePath)) this.sealed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')).secrets ?? {};
    } catch {
      this.sealed = {};
    }
  }

  /** Checks for a keychain and decrypts what is saved. Call after the app is ready. Never rejects. */
  static async open(): Promise<SecretStore> {
    const store = new SecretStore();
    try {
      store.keychain = (await safeStorage.isAsyncEncryptionAvailable())
        && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    } catch {
      store.keychain = false;
    }
    if (!store.keychain) {
      for (const name of Object.keys(store.sealed)) store.unreadable.add(name);
      return store;
    }
    const reseal: string[] = [];
    await Promise.all(Object.entries(store.sealed).map(async ([name, b64]) => {
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'));
        store.plain.set(name, result);
        if (shouldReEncrypt) reseal.push(name); // the key was rotated: seal it again under the new one
      } catch {
        store.unreadable.add(name);
      }
    }));
    for (const name of reseal) store.persist(name);
    return store;
  }

  /** True when values are protected by an OS keychain rather than a hard-coded key. */
  available(): boolean {
    return this.keychain;
  }

  getSecret(name: string): string | null {
    return this.keychain ? this.plain.get(name) ?? null : null;
  }

  /**
   * Readable at once; on disk when the returned promise resolves. It rejects if sealing failed (the
   * value then lasts only until the app quits); ignoring it is safe. Throws at once without a keychain.
   */
  setSecret(name: string, value: string): Promise<void> {
    if (!this.keychain) throw new Error('No OS keychain is available, so the key was not stored.');
    this.plain.set(name, value);
    this.unreadable.delete(name);
    return this.persist(name);
  }

  deleteSecret(name: string): Promise<void> {
    if (!this.plain.has(name) && !this.unreadable.has(name) && !(name in this.sealed)) return Promise.resolve();
    this.plain.delete(name);
    this.unreadable.delete(name);
    return this.persist(name);
  }

  listSecrets(): string[] {
    return [...this.plain.keys(), ...this.unreadable];
  }

  /** True while a write is still being sealed or saved. */
  get writing(): boolean {
    return this.pending > 0;
  }

  /** Resolves once every write so far is on disk (or has failed). */
  async flush(): Promise<void> {
    while (this.pending > 0) await this.queue;
  }

  // One write at a time, in order. Each job saves the name's state when it runs, not when it was
  // queued, so a later set or delete always wins.
  private persist(name: string): Promise<void> {
    this.pending++;
    const job = this.queue.then(async () => {
      const value = this.plain.get(name);
      if (value === undefined) delete this.sealed[name];
      else this.sealed[name] = (await safeStorage.encryptStringAsync(value)).toString('base64');
      this.save();
    });
    this.queue = job.catch((err) => console.error(`[secrets] could not save ${name}:`, err?.message ?? err))
      .finally(() => { this.pending--; });
    job.catch(() => {}); // a caller that doesn't await it mustn't leave an unhandled rejection
    return job;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, secrets: this.sealed }, null, 2), { mode: 0o600 });
  }
}
