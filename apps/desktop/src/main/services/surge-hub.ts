import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  toolWireName,
  READ_ONLY_TOOLS,
  hubToolRisk,
  createApprovalGate,
  declinedMessage,
  type McpManager,
  type ApprovalRequest,
  type ApprovalScope,
  type HubCallInput,
  type HubDecision,
} from '@surge/core';
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
 * - Even then, actions ask first, on the same Allow / Deny card as the chat (hubToolRisk): once per
 *   site until the hub restarts, actions are turned off or the token changes; a script every time.
 * - Every call is logged (tool, site, decision, time; never the arguments).
 *
 * No Electron here, so the hermetic tests drive this class; surge-hub-ipc.ts wires it to the app.
 */

const DEFAULT_PORT = 4766;
const EXPOSED_SERVERS = ['browser', 'bookmarks'];
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

/** How a card was answered: cancelled = the app went away first; no-answer = timed out or the window closed. */
export type HubAnswer = 'allow' | 'deny' | 'no-answer' | 'cancelled';

export interface HubOptions {
  version: string;
  /** The open page's origin ("https://example.com"), or null: what a browser action acts on. */
  pageOrigin: () => string | null;
  /** Shows the Allow / Deny card. `signal` aborts when the app that called goes away. */
  ask: (req: ApprovalRequest, signal: AbortSignal) => Promise<HubAnswer>;
  /** Records each call; best effort. */
  log?: (entry: HubCallInput) => void;
}

type HubSettings = Pick<SettingsService, 'get'>;
type HubSecrets = Pick<SecretStore, 'getSecret' | 'setSecret' | 'available'>;

/** Where BrowserService.navigateTo would go: same normalisation ("example.com" → https://example.com). */
function navigationOrigin(url: unknown): string | null {
  const text = String(url ?? '').trim();
  if (!text) return null;
  try {
    const u = new URL(text.startsWith('http') ? text : `https://${text}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export class SurgeHub {
  private server: http.Server | null = null;
  private error: string | undefined;
  private memoryToken: string | null = null;
  // Sites (and bookmarks) the user allowed for apps using the hub. Never shared with a chat's.
  private allowed = new Set<string>();

  constructor(private mcp: McpManager, private settings: HubSettings, private secrets: HubSecrets, private opts: HubOptions) {}

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

  regenerateToken(): string {
    this.forgetApprovals();
    return this.newToken();
  }

  /** The next action on any site asks again (hub restart, actions turned off or on, new token). */
  forgetApprovals(): void {
    this.allowed.clear();
  }

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
        const name = toolWireName(server.id, tool.name);
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
    this.forgetApprovals();
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
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(this.token());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** What an action acts on: opening a page, the site it opens; any other browser action, the open page's site. */
  private scopeOf(serverId: string, toolName: string, args: Record<string, unknown>): ApprovalScope {
    if (serverId === 'bookmarks') return { key: 'bookmarks', label: 'your bookmarks and history' };
    if (toolName === 'navigateTo') {
      const origin = navigationOrigin(args.url);
      // A link Surge can't read is allowed for that exact text only.
      if (!origin) return { key: `open:${String(args.url ?? '')}`, label: String(args.url ?? '').slice(0, 80) || 'a page' };
      return { key: `site:${origin}`, label: new URL(origin).host };
    }
    const origin = this.opts.pageOrigin();
    return origin ? { key: `site:${origin}`, label: new URL(origin).host } : { key: 'site:none', label: 'the browser' };
  }

  private record(entry: Omit<HubCallInput, 'at'> & { at?: number }): void {
    try { this.opts.log?.({ at: Date.now(), ...entry }); } catch { /* the log is best effort */ }
  }

  /** One tools/call from another app: refused, run freely (read), or run once the user allows it. */
  private async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const at = Date.now();
    const parsed = this.mcp.parseToolName(name);
    const exposedServer = EXPOSED_SERVERS.some((s) => name.startsWith(`${s}__`));
    const riskOfName = parsed ? hubToolRisk(parsed.serverId, parsed.toolName) : READ_ONLY_TOOLS.has(name) ? 'read' : 'action';
    if (!parsed || !this.tools().some((t) => t.name === name)) {
      const off = exposedServer && !READ_ONLY_TOOLS.has(name);
      this.record({ at, tool: name, risk: riskOfName, scope: null, decision: off ? 'actions-off' : 'unknown', ok: null, durationMs: null });
      return {
        isError: true,
        content: [{ type: 'text', text: off
          ? `"${name}" acts in the user's browser; it's off. The user can allow actions in Surge: Settings → Advanced → Surge hub.`
          : `Unknown tool "${name}".` }],
      };
    }

    let answer: HubAnswer | null = null;
    let scope: ApprovalScope | null = null;
    const gate = createApprovalGate({
      allowed: this.allowed,
      risk: hubToolRisk,
      scope: (serverId, toolName) => (scope = this.scopeOf(serverId, toolName, args)),
      ask: async (req) => (answer = await this.opts.ask(req, signal)) === 'allow',
    });
    const risk = hubToolRisk(parsed.serverId, parsed.toolName);
    const decision = await gate({ id: randomUUID(), serverId: parsed.serverId, toolName: parsed.toolName, args });
    const scopeLabel = (scope as ApprovalScope | null)?.label ?? null;
    const refuse = (d: HubDecision, text: string) => {
      this.record({ at, tool: name, risk, scope: scopeLabel, decision: d, ok: null, durationMs: null });
      return { isError: true, content: [{ type: 'text', text }] };
    };
    if (!decision.allowed) {
      if (answer === 'deny') return refuse('declined', decision.message);
      if (answer === 'cancelled') return refuse('cancelled', 'Cancelled: the request ended before the user answered.');
      return refuse('no-answer', `The user didn't answer in Surge, so ${parsed.toolName} didn't run. Don't retry it unasked.`);
    }
    // Things that can change while the card waits: the app gave up, or the user turned actions off.
    if (signal.aborted) return refuse('cancelled', 'Cancelled: the request ended before the action ran.');
    if (risk !== 'read' && !this.allowActions) return refuse('actions-off', declinedMessage(`${parsed.toolName}: actions were turned off`));

    const d: HubDecision = risk === 'read' ? 'read' : decision.asked ? 'allowed' : 'remembered';
    const started = Date.now();
    try {
      const result = await this.mcp.callTool(parsed.serverId, parsed.toolName, args);
      this.record({ at, tool: name, risk, scope: scopeLabel, decision: d, ok: !result?.isError, durationMs: Date.now() - started });
      return result;
    } catch (err) {
      this.record({ at, tool: name, risk, scope: scopeLabel, decision: d, ok: false, durationMs: Date.now() - started });
      throw err;
    }
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
    // The calling app gone (it timed out or quit): a card waiting for this request goes away.
    const gone = new AbortController();
    res.on('close', () => gone.abort());

    const mcp = new Server({ name: 'surge', version: this.opts.version }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools() }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, gone.signal));

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
