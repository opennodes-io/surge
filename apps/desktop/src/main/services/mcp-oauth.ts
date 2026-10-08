import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { shell } from 'electron';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpAuthHandler, McpServerConfig } from '@surge/core';
import type { SecretStore } from './secret-store';
import type { SettingsService } from './settings-service';

/**
 * OAuth sign-in for remote MCP servers (the MCP authorization spec: OAuth 2.1 + PKCE, with dynamic
 * client registration), for the desktop.
 *
 * - The sign-in page opens in the system browser (RFC 8252); it redirects back to a loopback
 *   callback (http://127.0.0.1:<mcp.oauthCallbackPort, 4767>/oauth/callback) that runs only
 *   while a sign-in is pending.
 * - The client registration and tokens are kept per server URL in the OS keychain (memory only
 *   where there's none). The SDK refreshes expired tokens with them.
 * - Non-interactive connects (e.g. reconnecting saved servers) never open a browser: they just
 *   fail with "sign-in required".
 */

const DEFAULT_CALLBACK_PORT = 4767;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface AuthStatus {
  serverId: string;
  serverName: string;
  status: 'waiting' | 'done' | 'failed' | 'cancelled';
  /** The sign-in page, to open again if the browser tab was closed. */
  url?: string;
  error?: string;
}

interface Flow {
  serverId: string;
  serverName: string;
  state: string;
  url?: string;
  code?: string;
  error?: string;
  waiters: Array<{ resolve: (code: string) => void; reject: (err: Error) => void }>;
  timer: ReturnType<typeof setTimeout>;
}

export class McpOAuth implements McpAuthHandler {
  private flows = new Map<string, Flow>(); // by server id
  private verifiers = new Map<string, string>(); // by server URL
  private memory = new Map<string, string>(); // stand-in for the keychain where there is none
  private server: http.Server | null = null;
  /** Where sign-in progress goes (the app window that started the connect). */
  onStatus: (status: AuthStatus) => void = () => {};

  constructor(private secrets: SecretStore, private settings: SettingsService) {}

  private get port(): number { return Number(this.settings.get('mcp.oauthCallbackPort')) || DEFAULT_CALLBACK_PORT; }
  private get redirectUrl(): string { return `http://127.0.0.1:${this.port}/oauth/callback`; }

  // ── credential storage (per server URL) ──
  private key(config: McpServerConfig, part: 'client' | 'tokens'): string {
    const u = new URL(config.url!);
    return `mcp.oauth.${u.host}${u.pathname}`.replace(/[^\w.:/-]/g, '_') + `#${part}`;
  }

  private read<T>(name: string): T | undefined {
    let raw: string | null | undefined = null;
    try { raw = this.secrets.getSecret(name); } catch { /* no keychain */ }
    raw ??= this.memory.get(name);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }

  private write(name: string, value: unknown): void {
    const raw = JSON.stringify(value);
    try { this.secrets.setSecret(name, raw); } catch { this.memory.set(name, raw); }
  }

  private remove(name: string): void {
    try { this.secrets.deleteSecret(name); } catch { /* nothing stored */ }
    this.memory.delete(name);
  }

  hasCredentials(config: McpServerConfig): boolean {
    return !!config.url && !!this.read(this.key(config, 'tokens'));
  }

  /** Forgets a server's tokens and client registration (Sign out). */
  forget(config: McpServerConfig): void {
    if (!config.url) return;
    this.remove(this.key(config, 'tokens'));
    this.remove(this.key(config, 'client'));
  }

  // ── McpAuthHandler ──
  provider(config: McpServerConfig, opts: { interactive: boolean }): OAuthClientProvider {
    const self = this;
    const url = config.url!;
    return {
      get redirectUrl() { return self.redirectUrl; },
      get clientMetadata() {
        return {
          client_name: 'Surge',
          client_uri: 'https://github.com/opennodes-io/surge',
          redirect_uris: [self.redirectUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none', // a public client: PKCE instead of a secret
        };
      },
      state: () => self.startFlow(config).state,
      clientInformation: () => self.read(self.key(config, 'client')),
      saveClientInformation: (info) => self.write(self.key(config, 'client'), info),
      tokens: () => self.read(self.key(config, 'tokens')),
      saveTokens: (tokens) => self.write(self.key(config, 'tokens'), tokens),
      saveCodeVerifier: (verifier) => { self.verifiers.set(url, verifier); },
      codeVerifier: () => {
        const verifier = self.verifiers.get(url);
        if (!verifier) throw new Error('No sign-in is in progress for this server.');
        return verifier;
      },
      redirectToAuthorization: async (authorizationUrl) => {
        if (!opts.interactive) return; // the connect fails with "sign-in required" instead
        const flow = self.flows.get(config.id) ?? self.startFlow(config);
        flow.url = authorizationUrl.toString();
        await self.ensureCallbackServer();
        self.onStatus({ serverId: config.id, serverName: config.name, status: 'waiting', url: flow.url });
        await shell.openExternal(flow.url);
      },
      invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'client') self.remove(self.key(config, 'client'));
        if (scope === 'all' || scope === 'tokens') self.remove(self.key(config, 'tokens'));
        if (scope === 'all' || scope === 'verifier') self.verifiers.delete(url);
      },
    };
  }

  waitForCode(config: McpServerConfig): Promise<string> {
    const flow = this.flows.get(config.id);
    if (!flow) return Promise.reject(new Error('No sign-in is in progress for this server.'));
    if (flow.code) return Promise.resolve(this.finish(flow, flow.code));
    if (flow.error) return Promise.reject(new Error(this.fail(flow, flow.error)));
    return new Promise((resolve, reject) => flow.waiters.push({ resolve, reject }));
  }

  /** The user gave up (Cancel in the MCP Servers panel). */
  cancel(serverId: string): void {
    const flow = this.flows.get(serverId);
    if (!flow) return;
    this.endFlow(flow);
    for (const w of flow.waiters) w.reject(new Error('Sign-in cancelled.'));
    this.onStatus({ serverId, serverName: flow.serverName, status: 'cancelled' });
  }

  // ── flows ──
  private startFlow(config: McpServerConfig): Flow {
    const previous = this.flows.get(config.id);
    if (previous) clearTimeout(previous.timer);
    const flow: Flow = {
      serverId: config.id,
      serverName: config.name,
      state: randomBytes(16).toString('base64url'),
      waiters: previous?.waiters ?? [],
      timer: setTimeout(() => {
        this.endFlow(flow);
        for (const w of flow.waiters) w.reject(new Error('Sign-in timed out. Connect again to retry.'));
        this.onStatus({ serverId: config.id, serverName: config.name, status: 'failed', error: 'Sign-in timed out.' });
      }, SIGN_IN_TIMEOUT_MS),
    };
    this.flows.set(config.id, flow);
    return flow;
  }

  private finish(flow: Flow, code: string): string {
    this.endFlow(flow);
    this.onStatus({ serverId: flow.serverId, serverName: flow.serverName, status: 'done' });
    return code;
  }

  private fail(flow: Flow, error: string): string {
    this.endFlow(flow);
    this.onStatus({ serverId: flow.serverId, serverName: flow.serverName, status: 'failed', error });
    return error;
  }

  private endFlow(flow: Flow): void {
    clearTimeout(flow.timer);
    if (this.flows.get(flow.serverId) === flow) this.flows.delete(flow.serverId);
    if (this.flows.size === 0) this.stopCallbackServer();
  }

  // ── loopback callback ──
  private ensureCallbackServer(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    const server = http.createServer((req, res) => this.handleCallback(req, res));
    return new Promise((resolve, reject) => {
      server.once('error', (err: any) => reject(new Error(err?.code === 'EADDRINUSE'
        ? `Port ${this.port} (the sign-in callback) is in use; set mcp.oauthCallbackPort to a free port.`
        : String(err?.message || err))));
      server.listen(this.port, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }

  private stopCallbackServer(): void {
    const server = this.server;
    this.server = null;
    server?.close();
  }

  private handleCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', this.redirectUrl);
    if (url.pathname !== '/oauth/callback') { res.writeHead(404).end(); return; }
    const state = url.searchParams.get('state');
    const flow = [...this.flows.values()].find((f) => f.state === state);
    const page = (title: string, body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3em;max-width:36em">`
        + `<h2>${title}</h2><p>${body}</p></body>`);
    };
    if (!flow) { page('Sign-in link expired', 'Go back to Surge and connect again.'); return; }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const name = escapeHtml(flow.serverName);
    if (error || !code) {
      const message = url.searchParams.get('error_description') || error || 'No authorization code was returned.';
      flow.error = message;
      for (const w of flow.waiters.splice(0)) w.reject(new Error(this.fail(flow, message)));
      page('Sign-in failed', `${name}: ${escapeHtml(message)}. You can close this tab.`);
      return;
    }
    flow.code = code;
    const waiters = flow.waiters.splice(0);
    if (waiters.length) {
      const c = this.finish(flow, code);
      for (const w of waiters) w.resolve(c);
    }
    page(`Signed in to ${name}`, 'You can close this tab and go back to Surge.');
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
