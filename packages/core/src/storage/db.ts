import { createClient, type Client } from '@libsql/client';
import { SCHEMA_STATEMENTS, COLUMN_ADDITIONS } from './schema.js';
import {
  BookmarksRepo,
  CollectionsRepo,
  TagsRepo,
  HistoryRepo,
  ProfilesRepo,
  AgentsRepo,
  ChatRepo,
  OnpCallsRepo,
} from './repos.js';

export interface SurgeStoreOptions {
  /** Filesystem path to the SQLite file. Use ':memory:' for an ephemeral DB (tests). */
  path?: string;
  /** Explicit libsql URL (e.g. file:..., libsql://... for Turso). Overrides `path`. */
  url?: string;
  /** Pre-created libsql client (advanced / tests). Overrides path/url. */
  client?: Client;
  /** Stable id for this device; stamped on every row for the future sync layer. */
  deviceId?: string | null;
}

function resolveUrl(opts: SurgeStoreOptions): string {
  if (opts.url) return opts.url;
  const p = opts.path ?? ':memory:';
  if (p === ':memory:') return ':memory:';
  return 'file:' + p.replace(/\\/g, '/');
}

/**
 * The single entry point to Surge's local-first storage. The Electron desktop and
 * the standalone bookmarks/history MCP server both call SurgeStore.open() against
 * the same file (default ~/.../surge.db). @libsql/client is N-API, so the same
 * binary loads in Electron and plain Node without a rebuild.
 */
export class SurgeStore {
  readonly client: Client;
  readonly deviceId: string | null;
  readonly bookmarks: BookmarksRepo;
  readonly collections: CollectionsRepo;
  readonly tags: TagsRepo;
  readonly history: HistoryRepo;
  readonly profiles: ProfilesRepo;
  readonly agents: AgentsRepo;
  readonly chat: ChatRepo;
  readonly onpCalls: OnpCallsRepo;

  private constructor(client: Client, deviceId: string | null) {
    this.client = client;
    this.deviceId = deviceId;
    this.bookmarks = new BookmarksRepo(client, deviceId);
    this.collections = new CollectionsRepo(client, deviceId);
    this.tags = new TagsRepo(client, deviceId);
    this.history = new HistoryRepo(client, deviceId);
    this.profiles = new ProfilesRepo(client, deviceId);
    this.agents = new AgentsRepo(client, deviceId);
    this.chat = new ChatRepo(client, deviceId);
    this.onpCalls = new OnpCallsRepo(client, deviceId);
  }

  static async open(opts: SurgeStoreOptions = {}): Promise<SurgeStore> {
    const client = opts.client ?? createClient({ url: resolveUrl(opts) });
    const store = new SurgeStore(client, opts.deviceId ?? null);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      await this.client.execute(stmt);
    }
    // Databases created before a column existed get it added (nullable, so old rows stay valid).
    for (const { table, column, type } of COLUMN_ADDITIONS) {
      const info = await this.client.execute(`PRAGMA table_info(${table})`);
      if (!info.rows.some((r) => String(r.name) === column)) {
        await this.client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }

  close(): void {
    this.client.close();
  }
}
