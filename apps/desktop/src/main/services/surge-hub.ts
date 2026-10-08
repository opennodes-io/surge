import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { app, ipcMain } from 'electron';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpManager } from '@surge/core';
import type { SettingsService } from './settings-service';
import type { SecretStore } from './secret-store';

/**
 * The Surge hub: a local MCP server (Streamable HTTP, http://127.0.0.1:<port>/mcp) that lets other
 * AI apps (Claude Code, Cursor, LM Studio, …) use Surge's embedded browser and bookmarks.
 *
 * - Off by default; loopback only; every request needs the bearer token (kept in the OS keychain);
 *   the SDK's DNS-rebinding protection rejects requests whose Host isn't this loopback address.
 * - Read-only by default: reading the open page and bookmarks/history. Acting in the browser
 *   (navigate, click, type, run scripts) or writing bookmarks needs `hub.allowActions`, because
 *   it drives the user's logged-in browser.
 */

const DEFAULT_PORT = 4766;
const EXPOSED_SERVERS = ['browser', 'bookmarks'];
// Tools that only read. Everything else on the exposed servers changes something.
const READ_ONLY_TOOLS = new Set([
  'browser__getPageContent', 'browser__getPageMetadata', 'browser__getLinks', 'browser__getFormFields',
  'browser__getSelectedText', 'browser__getElementText', 'browser__getElementAttribute', 'browser__getTableData',
  'browser__waitForSelector', 'browser__detectMcpBTools',
  'bookmarks__bookmark_list', 'bookmarks__bookmark_search', 'bookmarks__history_search', 'bookmarks__history_list',
]);
const TOKEN_SECRET = 'hub.token';
const MAX_BODY = 4 * 1024 * 1024;

export interface HubStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  allowActions: boolean;
  /** Tools a connected app sees right now. */
  tools: string[];
  /** Whether the token is kept in the OS keychain (otherwise it's new each launch). */
  tokenPersisted: boolean;
  error?: string;
}

export class SurgeHub {
  private server: http.Server | null = null;
  private error: string | undefined;
  private memoryToken: string | null = null;

  constructor(private mcp: McpManager, private settings: SettingsService, private secrets: SecretStore) {}

  private get port(): number { return Number(this.settings.get('hub.port')) || DEFAULT_PORT; }
  private get allowActions(): boolean { return !!this.settings.get('hub.allowActions'); }

  /** The bearer token, created on first use. Kept in the keychain when there is one. */
  token(): string {
    let token: string | null = null;
    try { token = this.secrets.getSecret(TOKEN_SECRET); } catch { /* no keychain */ }
    token ??= this.memoryToken;
    if (!token) token = this.newToken();
    return token;
  }

  regenerateToken(): string { return this.newToken(); }

  private newToken(): string {
    const token = randomBytes(24).toString('base64url');
    this.memoryToken = token;
    try { this.secrets.setSecret(TOKEN_SECRET, token); } catch { /* keychain unavailable: memory only */ }
    return token;
  }

  /** Whether the token survives restarts: it does wherever there is an OS keychain to keep it in. */
  private tokenPersisted(): boolean {
    return this.secrets.available();
  }

  /** The tools a connected app may see and call, namespaced like the chat's ("server__tool"). */
  private tools(): Array<{ name: string; description: string; inputSchema: any }> {
    const out: Array<{ name: string; description: string; inputSchema: any }> = [];
    for (const server of this.mcp.getConnectedServers()) {
      if (!EXPOSED_SERVERS.includes(server.id) || server.status !== 'connected') continue;
      for (const tool of server.tools) {
        const name = `${server.id}__${tool.name}`;
        if (!this.allowActions && !READ_ONLY_TOOLS.has(name)) continue;
        out.push({ name, description: `[Surge ${server.name}] ${tool.description}`, inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
      }
    }
    return out;
  }

  status(): HubStatus {
    return {
      enabled: !!this.settings.get('hub.enabled'),
      running: !!this.server?.listening,
      port: this.port,
      url: this.server?.listening ? `http://127.0.0.1:${this.port}/mcp` : null,
      allowActions: this.allowActions,
      tools: this.tools().map((t) => t.name),
      tokenPersisted: this.tokenPersisted(),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Starts or stops the server to match the settings. */
  async apply(): Promise<HubStatus> {
    await this.stop();
    this.error = undefined;
    if (this.settings.get('hub.enabled')) await this.start();
    return this.status();
  }

  private start(): Promise<void> {
    const port = this.port;
    const server = http.createServer((req, res) => {
      this.handle(req, res, port).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      });
    });
    return new Promise((resolve) => {
      server.once('error', (err: any) => {
        this.error = err?.code === 'EADDRINUSE' ? `Port ${port} is already in use: choose another.` : String(err?.message || err);
        this.server = null;
        resolve();
      });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(this.token());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
    const path = (req.url || '').split('?')[0];
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. The Surge hub is at /mcp.' }));
      return;
    }
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'Missing or wrong token. Copy it from Surge: Settings → Advanced → Surge hub.' }));
      return;
    }
    // Stateless: every POST gets its own server and transport, so there's no session state to leak.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Use POST (stateless Streamable HTTP).' }));
      return;
    }
    const body = await readJson(req);

    const mcp = new Server({ name: 'surge', version: app.getVersion() }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools() }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      if (!this.tools().some((t) => t.name === name)) {
        const action = EXPOSED_SERVERS.some((s) => name.startsWith(`${s}__`)) && !READ_ONLY_TOOLS.has(name);
        return {
          isError: true,
          content: [{ type: 'text', text: action
            ? `"${name}" acts in the user's browser; it's off. The user can allow actions in Surge: Settings → Advanced → Surge hub.`
            : `Unknown tool "${name}".` }],
        };
      }
      const parsed = this.mcp.parseToolName(name)!;
      return this.mcp.callTool(parsed.serverId, parsed.toolName, request.params.arguments ?? {});
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(req as any, res, body);
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Creates the hub, starts it if enabled, and wires its IPC (Settings → Advanced → Surge hub). */
export function registerHubHandlers(mcp: McpManager, settings: SettingsService, secrets: SecretStore): SurgeHub {
  const hub = new SurgeHub(mcp, settings, secrets);
  hub.apply().catch((err) => console.error('[surge] hub failed to start:', err));
  app.on('before-quit', () => { hub.stop().catch(() => {}); });

  ipcMain.handle('hub:status', () => hub.status());
  ipcMain.handle('hub:configure', async (_e, cfg: { enabled?: boolean; port?: number; allowActions?: boolean }) => {
    if (cfg.enabled !== undefined) settings.set('hub.enabled', !!cfg.enabled);
    if (cfg.allowActions !== undefined) settings.set('hub.allowActions', !!cfg.allowActions);
    if (cfg.port !== undefined) {
      const port = Math.trunc(Number(cfg.port));
      if (port >= 1024 && port <= 65535) settings.set('hub.port', port);
    }
    // Enabling, disabling or a new port restarts; tool visibility is read per request.
    if (cfg.enabled !== undefined || cfg.port !== undefined) return hub.apply();
    return hub.status();
  });
  ipcMain.handle('hub:token', () => hub.token());
  ipcMain.handle('hub:regenerateToken', () => hub.regenerateToken());
  return hub;
}
