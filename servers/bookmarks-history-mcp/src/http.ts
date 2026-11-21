import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { openStore, resolveDbPath } from './store.js';
import { createServer } from './server.js';

/**
 * Streamable HTTP mode, for MCP clients on this machine. Bookmarks and history are as private as a
 * browser's, so, as in the Surge hub (apps/desktop/src/main/services/surge-hub.ts):
 * - it listens on 127.0.0.1 only, and refuses a Host other than 127.0.0.1:<port> or localhost:<port>
 *   (DNS rebinding);
 * - it sends no CORS headers, and refuses any request a web page makes (Origin, or Sec-Fetch-Site other than "none");
 * - every request needs the bearer token (SURGE_MCP_HTTP_TOKEN, or one generated at start and printed
 *   to stderr), checked before the body is read;
 * - bodies are capped at 4 MiB, and sessions at 32: an idle one closes after 10 minutes, and the least
 *   recently used idle one makes room for a new one.
 */

const HOST = '127.0.0.1';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_SESSIONS = 32;
const IDLE_MS = 10 * 60_000;
const MIN_TOKEN_LENGTH = 16;
const TAG = '[surge-bookmarks-mcp]';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Requests in flight, the client's open GET stream included. A session with one is never closed. */
  open: number;
  lastSeen: number;
}

class BodyTooLarge extends Error {}
class ClientGone extends Error {}

function fail(message: string): never {
  process.stderr.write(`${TAG} ${message}\n`);
  process.exit(1);
}

function resolvePort(): number {
  const raw = process.env.PORT ?? process.env.SURGE_MCP_HTTP_PORT ?? '3939';
  const port = Number(raw);
  if (!raw.trim() || !Number.isInteger(port) || port < 0 || port > 65535) fail(`PORT must be a port number (0–65535), not "${raw}".`);
  return port;
}

/** SURGE_MCP_HTTP_TOKEN, or a new random one when it isn't set. */
function resolveToken(): { token: string; generated: boolean } {
  const given = process.env.SURGE_MCP_HTTP_TOKEN?.trim();
  if (!given) return { token: randomBytes(24).toString('base64url'), generated: true };
  if (given.length < MIN_TOKEN_LENGTH) {
    fail(`SURGE_MCP_HTTP_TOKEN is too short: use at least ${MIN_TOKEN_LENGTH} characters, or leave it unset to get a random one.`);
  }
  return { token: given, generated: false };
}

const digest = (text: string) => createHash('sha256').update(text).digest();

/** Compared as SHA-256 digests, so the timing shows neither the token nor its length. */
function bearerMatches(req: http.IncomingMessage, expected: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return !!match && timingSafeEqual(digest(match[1].trim()), expected);
}

/**
 * A web page's request: browsers send Origin with cross-origin ones and Sec-Fetch-Site with all of them.
 * Sec-Fetch-Site "none" means the user opened the address themselves, which page script can't fake, and
 * clients built on Chromium's network stack may send it; without Origin it isn't a page's.
 */
function fromBrowser(req: http.IncomingMessage): boolean {
  if (req.headers.origin !== undefined) return true;
  const site = req.headers['sec-fetch-site'];
  return site !== undefined && site !== 'none';
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
const tooLarge = () => rpcError(-32000, `Request body over ${MAX_BODY} bytes.`);

/**
 * The body as text, at most MAX_BODY bytes. A bigger one (declared or chunked) is still read to the end and
 * dropped before the 413: a socket closed with unread data is reset, and the client never sees the answer.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number(req.headers['content-length'] ?? 0) > MAX_BODY;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => reject(new ClientGone()));
    req.on('close', () => { if (!req.complete) reject(new ClientGone()); });
  });
}

async function main(): Promise<void> {
  const port = resolvePort();
  const { token, generated } = resolveToken();
  const expected = digest(token);
  const store = await openStore();
  const sessions = new Map<string, Session>();
  // Filled once the port is known (PORT=0 picks one).
  const allowedHosts: string[] = [];

  const closeSession = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.server.close().catch(() => {}); // closes its transport too
  };

  // Room for one more session: at the cap, the least recently used idle one goes. None idle: no room.
  const makeRoom = (): boolean => {
    if (sessions.size < MAX_SESSIONS) return true;
    let oldest: [string, Session] | undefined;
    for (const entry of sessions) {
      if (entry[1].open === 0 && (!oldest || entry[1].lastSeen < oldest[1].lastSeen)) oldest = entry;
    }
    if (!oldest) return false;
    closeSession(oldest[0]);
    return true;
  };

  const track = (session: Session, res: http.ServerResponse) => {
    session.open++;
    session.lastSeen = Date.now();
    res.on('close', () => {
      session.open--;
      session.lastSeen = Date.now();
    });
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.open === 0 && now - session.lastSeen > IDLE_MS) closeSession(id);
  }, 60_000);
  sweep.unref();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // DNS rebinding: a page whose own name resolves to 127.0.0.1 sends that name as the Host.
    if (!allowedHosts.includes(req.headers.host ?? '')) {
      send(res, 403, rpcError(-32000, `Invalid Host header: ${req.headers.host ?? '(none)'}`));
      return;
    }
    // No CORS: a web page, preflight or not, gets nothing it can read or act through.
    if (fromBrowser(req)) {
      send(res, 403, rpcError(-32000, 'Web pages cannot use this server. Connect from an MCP client on this machine.'));
      return;
    }
    if ((req.url ?? '').split('?')[0] !== '/mcp') {
      send(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
      return;
    }
    // Before the body is read: without the token, nothing is parsed or stored.
    if (!bearerMatches(req, expected)) {
      send(res, 401, rpcError(-32001, 'Missing or wrong token. Send Authorization: Bearer <token>.'), { 'www-authenticate': 'Bearer' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (Array.isArray(sessionId)) {
      send(res, 400, rpcError(-32000, 'Send one mcp-session-id header.'));
      return;
    }
    const session = sessionId ? sessions.get(sessionId) : undefined;
    // 404 tells a client its session is gone (closed while idle, or for room), so it starts a new one.
    if (sessionId && !session) {
      send(res, 404, rpcError(-32001, 'Session not found; send initialize to start a new one.'));
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!session) {
        send(res, 400, rpcError(-32000, 'Missing mcp-session-id header.'));
        return;
      }
      track(session, res);
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, rpcError(-32000, 'Method not allowed.'), { allow: 'GET, POST, DELETE' });
      return;
    }

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : undefined;
    } catch (err) {
      if (err instanceof BodyTooLarge) send(res, 413, tooLarge(), { connection: 'close' });
      else if (err instanceof SyntaxError) send(res, 400, rpcError(-32700, 'Parse error: the body is not JSON.'));
      else if (!(err instanceof ClientGone)) throw err;
      return;
    }

    if (session) {
      track(session, res);
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      send(res, 400, rpcError(-32000, 'No session; send initialize first.'));
      return;
    }
    if (!makeRoom()) {
      send(res, 503, rpcError(-32000, `Too many open sessions (${MAX_SESSIONS}); close one and retry.`), { 'retry-after': '5' });
      return;
    }

    const server = createServer(store);
    let fresh: Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // The SDK's own Host check, behind the one above.
      enableDnsRebindingProtection: true,
      allowedHosts,
      onsessioninitialized: (sid) => {
        sessions.set(sid, fresh);
      },
    });
    fresh = { server, transport, open: 0, lastSeen: Date.now() };
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.get(sid) === fresh) sessions.delete(sid);
    };
    await server.connect(transport);
    track(fresh, res);
    await transport.handleRequest(req, res, body);
    // An initialize that didn't start a session leaves nothing behind.
    if (!transport.sessionId) server.close().catch(() => {});
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`${TAG} request failed: ${err?.stack || err}\n`);
      if (!res.headersSent) send(res, 500, rpcError(-32603, 'Internal error.'));
      else res.end();
    });
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    fail(err.code === 'EADDRINUSE' ? `Port ${port} is already in use; set PORT to another.` : `HTTP server error: ${err.message}`);
  });

  httpServer.listen(port, HOST, () => {
    const actual = (httpServer.address() as AddressInfo).port;
    allowedHosts.push(`${HOST}:${actual}`, `localhost:${actual}`);
    const lines = [`HTTP (streamable) listening on http://${HOST}:${actual}/mcp db=${resolveDbPath()}`];
    if (generated) lines.push(`token (generated; set SURGE_MCP_HTTP_TOKEN to keep one across restarts): ${token}`);
    lines.push('clients must send: Authorization: Bearer <token>');
    process.stderr.write(lines.map((line) => `${TAG} ${line}\n`).join(''));
  });
}

main().catch((err) => {
  process.stderr.write(`${TAG} fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
