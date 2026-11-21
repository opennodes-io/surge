import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { ONP_DEFAULT_REGISTRY, DEFAULT_ONP_POLICY, type OnpSpendPolicy } from '@surge/core/onp';
import { DEFAULT_MCP_INDEX } from '@surge/core/discovery';
import type { SecretStore } from './secret-store';
import { migrateSettingsData } from './settings-migrations';

interface Settings {
  // AI model configuration
  'ai.defaultModel': string;
  'ai.geminiApiKey': string;
  'ai.groqApiKey': string;
  'ai.claudeApiKey': string;
  'ai.mistralApiKey': string;
  'ai.ollamaHost': string;
  'ai.vllmEndpoint': string;
  'ai.vllmModel': string;
  'ai.onpRegistryUrl': string; // OpenNodes registry for model discovery

  // OpenNodes spend (ONP-5): 'onp.' keys don't reset the AI clients when saved
  'onp.policy': OnpSpendPolicy;
  'onp.spend': { day: string; usd: number }; // today's (UTC) settled spend

  // MCP
  'mcp.maxConnections': number; // resource guard on simultaneous MCP servers
  'mcp.autoReconnect': boolean;
  'mcp.savedServers': any[];
  'mcp.indexUrl': string; // where the MCP Servers panel finds servers; '' = the official MCP Registry alone

  // UI
  'ui.theme': 'dark' | 'light';

  [key: string]: any;
}

const DEFAULTS: Partial<Settings> = {
  'ai.defaultModel': 'gemini-flash-lite',
  'ai.geminiApiKey': '',
  'ai.groqApiKey': '',
  'ai.claudeApiKey': '',
  'ai.mistralApiKey': '',
  'ai.ollamaHost': 'http://localhost:11434',
  'ai.vllmEndpoint': '',
  'ai.vllmModel': '',
  'ai.onpRegistryUrl': ONP_DEFAULT_REGISTRY,
  'onp.policy': DEFAULT_ONP_POLICY,
  'mcp.maxConnections': 25,
  'mcp.autoReconnect': true,
  'mcp.savedServers': [],
  // mcprating.io (same maintainer as Surge, said in the panel); the official MCP Registry is the fallback
  'mcp.indexUrl': DEFAULT_MCP_INDEX,
  'ui.theme': 'dark',
};

// Provider API keys keep their settings names, but with an OS keychain their values live in the
// SecretStore, never in surge-settings.json, and are never returned to the renderer.
// ai.onpApiKey is retired (one key for every node); it is only migrated so it stops being plaintext.
export const SECRET_SETTINGS = ['ai.geminiApiKey', 'ai.groqApiKey', 'ai.claudeApiKey', 'ai.mistralApiKey', 'ai.vllmApiKey', 'ai.onpApiKey'];

export class SettingsService {
  private data: Record<string, any> = {};
  private filePath: string;
  private secrets: SecretStore | null;

  constructor(secrets: SecretStore | null = null) {
    const userDataPath = app?.getPath?.('userData') || '.';
    this.filePath = path.join(userDataPath, 'surge-settings.json');
    this.secrets = secrets;
    this.load();
    if (migrateSettingsData(this.data)) this.save();
    this.migrateSecrets();
  }

  /** True when provider keys are kept in the OS keychain (otherwise they stay in the settings file). */
  secretsEncrypted(): boolean {
    return !!this.secrets?.available();
  }

  hasSecret(key: string): boolean {
    return this.secretsEncrypted() ? !!this.secrets!.getSecret(key) : !!this.data[key];
  }

  // One-time move of plaintext provider keys into the keychain. The plaintext is dropped from the
  // settings file only once the keychain copies are on disk; if sealing fails, the next start retries.
  private migrateSecrets(): void {
    if (!this.secretsEncrypted()) return;
    const present = SECRET_SETTINGS.filter((key) => key in this.data);
    if (!present.length) return;
    const writes = present
      .filter((key) => typeof this.data[key] === 'string' && this.data[key])
      .map((key) => this.secrets!.setSecret(key, this.data[key]));
    Promise.all(writes).then(() => {
      for (const key of present) delete this.data[key];
      this.save();
    }).catch(() => { /* kept in plaintext for now; SecretStore logged why */ });
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw);
      }
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch {
      // Silently fail if we can't write
    }
  }

  get(key: string): any {
    if (SECRET_SETTINGS.includes(key) && this.secretsEncrypted()) return this.secrets!.getSecret(key) ?? '';
    return this.data[key] ?? (DEFAULTS as any)[key] ?? null;
  }

  /** Saves at once, except a provider key in the keychain, which is on disk when the promise resolves. */
  set(key: string, value: any): Promise<void> | void {
    if (SECRET_SETTINGS.includes(key) && this.secretsEncrypted()) {
      return value ? this.secrets!.setSecret(key, String(value)) : this.secrets!.deleteSecret(key);
    }
    this.data[key] = value;
    this.save();
  }

  getMaxConnections(): number {
    return Number(this.get('mcp.maxConnections')) || 25;
  }
}
