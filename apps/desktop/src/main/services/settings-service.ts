import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { ONP_DEFAULT_REGISTRY, DEFAULT_ONP_POLICY, type OnpSpendPolicy } from '@surge/core/onp';
import type { SecretStore } from './secret-store';

export type Tier = 'free' | 'pro' | 'enterprise';

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

  // License / tier
  'license.key': string;
  'license.tier': Tier;

  // MCP
  'mcp.maxConnections': number;
  'mcp.autoReconnect': boolean;
  'mcp.savedServers': any[];
  'mcp.indexUrl': string; // MCP_Index API endpoint for server discovery

  // Search
  'search.dailyCount': number;
  'search.lastReset': string;
  'search.dailyLimit': number;

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
  'license.key': '',
  'license.tier': 'free',
  'mcp.maxConnections': 3,
  'mcp.autoReconnect': true,
  'mcp.savedServers': [],
  'mcp.indexUrl': 'http://localhost:3000', // MCP_Index registry; falls back to registry.mcp.so
  'search.dailyCount': 0,
  'search.lastReset': new Date().toISOString().slice(0, 10),
  'search.dailyLimit': 50,
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
    this.migrateSecrets();
  }

  /** True when provider keys are kept in the OS keychain (otherwise they stay in the settings file). */
  secretsEncrypted(): boolean {
    return !!this.secrets?.available();
  }

  hasSecret(key: string): boolean {
    return this.secretsEncrypted() ? !!this.secrets!.getSecret(key) : !!this.data[key];
  }

  // One-time move of plaintext provider keys into the keychain.
  private migrateSecrets(): void {
    if (!this.secretsEncrypted()) return;
    const present = SECRET_SETTINGS.filter((key) => key in this.data);
    for (const key of present) {
      if (typeof this.data[key] === 'string' && this.data[key]) this.secrets!.setSecret(key, this.data[key]);
      delete this.data[key];
    }
    if (present.length) this.save();
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

  set(key: string, value: any): void {
    if (SECRET_SETTINGS.includes(key) && this.secretsEncrypted()) {
      if (value) this.secrets!.setSecret(key, String(value));
      else this.secrets!.deleteSecret(key);
      return;
    }
    this.data[key] = value;
    this.save();
  }

  getTier(): Tier {
    return this.get('license.tier') || 'free';
  }

  isFeatureAvailable(feature: string): boolean {
    const tier = this.getTier();
    const proFeatures = ['claude', 'mistral', 'gemini-pro', 'vllm', 'unlimited-mcp', 'unlimited-search'];
    const enterpriseFeatures = ['gpt4', 'claude-opus', 'team', 'sso'];

    if (enterpriseFeatures.includes(feature)) return tier === 'enterprise';
    if (proFeatures.includes(feature)) return tier === 'pro' || tier === 'enterprise';
    return true;
  }

  getMaxConnections(): number {
    const tier = this.getTier();
    if (tier === 'free') return 3;
    return 100;
  }

  checkSearchQuota(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    const lastReset = this.get('search.lastReset');
    
    if (lastReset !== today) {
      this.set('search.dailyCount', 0);
      this.set('search.lastReset', today);
    }

    const count = this.get('search.dailyCount') || 0;
    const limit = this.getTier() === 'free' ? 50 : Infinity;
    return count < limit;
  }

  incrementSearchCount(): void {
    const count = this.get('search.dailyCount') || 0;
    this.set('search.dailyCount', count + 1);
  }
}
