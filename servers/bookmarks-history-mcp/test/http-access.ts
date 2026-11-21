/**
 * Who may use the standalone server's HTTP mode: the built dist/http.js on a random loopback port, a temp
 * DB, raw requests shaped like a web page's or another process's, and the MCP SDK's own client. No network.
 * - no token, a wrong one, a spoofed Host, a web page (preflight, simple POST, same-site page) and an
 *   oversized body are refused, and none of them writes anything;
 * - the SDK's Streamable HTTP client with the token still reads and writes, and gets no CORS headers;
 * - sessions are capped, the least recently used idle one goes first, and one with an open stream stays;
 * - without SURGE_MCP_HTTP_TOKEN it prints a generated token; a short one stops it from starting.
 * Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx test/http-access.ts (after pnpm build)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'http.js');
const TOKEN = 'test-token-0123456789abcdef';
const MiB = 1024 * 1024;
const children = new Set<ChildProcess>();
const dbs: string[] = [];

interface Started { child: ChildProcess; port: number; stderr: () => string }

/** Starts dist/http.js with PORT=0 and resolves once it says where it listens; rejects if it exits first. */
function start(env: Record<string, string | undefined>): Promise<Started> {
  const db = path.join(os.tmpdir(), `surge-http-${process.pid}-${dbs.length}.db`);
  dbs.push(db);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: '0', SURGE_DB_PATH: db };
  delete childEnv.SURGE_MCP_HTTP_TOKEN;
  delete childEnv.SURGE_MCP_HTTP_PORT;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k]; else childEnv[k] = v;
  const child = spawn(process.execPath, [serverEntry], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line in 15s: ${err}`)), 15_000);
    child.stderr!.on('data', (c) => {
      err += c;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(err);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), stderr: () => err }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(Object.assign(new Error(`exited ${code}: ${err}`), { code, stderr: err })); });
  });
}

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: string }

/**
 * One request with exactly these headers (fetch can't set Host or Origin freely). `chunks` are sent with
 * chunked encoding. A refused upload may fail mid-write once the server has answered: the answer counts.
 */
function raw(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[]; close?: boolean }): Promise<Raw> {
  return new Promise((resolve, reject) => {
    let got: Raw | undefined;
    // close: a one-off agent, so the request says Connection: close.
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: opts.headers ?? {}, ...(opts.close ? { agent: false } : {}) }, (res) => {
      got = { status: res.statusCode ?? 0, headers: res.headers, body: '' };
      res.setEncoding('utf8');
      res.on('data', (c) => { got!.body += c; });
      res.on('end', () => resolve(got!));
      res.on('error', () => resolve(got!));
    });
    req.on('error', (e) => { if (got) resolve(got); else reject(e); });
    if (opts.chunks) {
      for (const chunk of opts.chunks) req.write(chunk);
      req.end();
    } else {
      req.end(opts.body);
    }
  });
}

const initialize = (id = 1) => JSON.stringify({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
});
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function main() {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); pass = pass && cond; };
  const textOf = (res: any): string => (res?.content ?? []).map((c: any) => c.text ?? '').join('\n');

  // What fromBrowser() relies on: Node's fetch (the SDK client's) sends neither Origin nor Sec-Fetch-Site.
  const seen: http.IncomingHttpHeaders[] = [];
  const probe = http.createServer((req, res) => { seen.push(req.headers); res.end('{}'); });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  await fetch(`http://127.0.0.1:${(probe.address() as AddressInfo).port}/`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  probe.close();
  check('Node\'s fetch sends no Origin or Sec-Fetch-Site', seen.length === 1 && seen[0].origin === undefined && seen[0]['sec-fetch-site'] === undefined,
    Object.keys(seen[0] ?? {}).join(', '));

  console.log('\n— starting');
  const short = await start({ SURGE_MCP_HTTP_TOKEN: 'short' }).then(() => null, (e) => e);
  check('a token under 16 characters stops it from starting', short?.code === 1 && /too short/.test(short?.stderr ?? ''), short?.stderr?.trim());

  const gen = await start({});
  const genToken = /token \(generated[^)]*\): (\S+)/.exec(gen.stderr())?.[1] ?? '';
  check('without SURGE_MCP_HTTP_TOKEN it prints a generated token', genToken.length >= 24, `${genToken.length} characters`);
  {
    const client = new Client({ name: 'generated-token', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gen.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${genToken}` } } }));
    const tools = await client.listTools();
    await client.close();
    check('…which an SDK client can use', tools.tools.length >= 13, `${tools.tools.length} tools`);
  }
  gen.child.kill();

  const srv = await start({ SURGE_MCP_HTTP_TOKEN: TOKEN });
  const { port } = srv;
  const host = `127.0.0.1:${port}`;
  const url = new URL(`http://${host}/mcp`);
  check('it listens on 127.0.0.1', /listening on http:\/\/127\.0\.0\.1:\d+\/mcp/.test(srv.stderr()));
  check('a token it was given is never printed', !srv.stderr().includes(TOKEN));
  const base = { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const auth = { ...base, authorization: `Bearer ${TOKEN}` };

  console.log('\n— the SDK client, with the token');
  const responseHeaders: Headers[] = [];
  const recordingFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, init);
    responseHeaders.push(res.headers);
    return res;
  };
  const client = new Client({ name: 'http-access', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }, fetch: recordingFetch });
  await client.connect(transport);
  const tools = await client.listTools();
  check('connects and lists the tools', tools.tools.length >= 13, `${tools.tools.length} tools`);
  const added = JSON.parse(textOf(await client.callTool({ name: 'bookmark_add', arguments: { url: 'https://example.com', title: 'Example', tags: ['a'] } })));
  check('writes a bookmark', typeof added.id === 'string' && added.tags?.length === 1);
  const listed = JSON.parse(textOf(await client.callTool({ name: 'bookmark_list', arguments: {} })));
  check('reads it back', listed.items.length === 1 && listed.items[0].url === 'https://example.com', `${listed.items.length} item(s)`);
  await client.callTool({ name: 'history_record', arguments: { url: 'https://example.com', title: 'Example', kind: 'web' } });
  const recent = JSON.parse(((await client.readResource({ uri: 'history://recent' })).contents[0] as any).text);
  check('reads a resource', recent.length === 1);
  check('no response carries CORS headers', responseHeaders.length > 0 && responseHeaders.every((h) => !h.has('access-control-allow-origin') && !h.has('access-control-allow-headers')),
    `${responseHeaders.length} responses`);
  const sdkSession = transport.sessionId;

  console.log('\n— refused');
  let r = await raw(port, { headers: base, body: initialize() });
  check('no token: 401', r.status === 401 && r.headers['www-authenticate'] === 'Bearer' && !r.headers['mcp-session-id'], `${r.status}`);
  r = await raw(port, { headers: { ...base, authorization: `Bearer ${TOKEN.slice(0, -1)}x` }, body: initialize() });
  check('wrong token (same length): 401', r.status === 401, `${r.status}`);
  r = await raw(port, { headers: { ...base, authorization: 'Bearer nope' }, body: initialize() });
  check('wrong token (shorter): 401', r.status === 401, `${r.status}`);
  r = await raw(port, { headers: { ...base, authorization: TOKEN }, body: initialize() });
  check('the token without "Bearer": 401', r.status === 401, `${r.status}`);
  r = await raw(port, { method: 'GET', headers: { host, accept: 'text/event-stream', 'mcp-session-id': sdkSession ?? '' } });
  check('GET on a live session without the token: 401', r.status === 401, `${r.status}`);
  r = await raw(port, { method: 'DELETE', headers: { host, 'mcp-session-id': sdkSession ?? '' } });
  check('DELETE of a live session without the token: 401', r.status === 401, `${r.status}`);
  r = await raw(port, { headers: { ...base, 'content-length': String(5 * MiB) }, body: Buffer.alloc(5 * MiB, 0x20) });
  check('no token with a 5 MiB body: 401, so the token is checked before the body is read', r.status === 401, `${r.status}`);

  r = await raw(port, { headers: { ...auth, host: `rebind.attacker.example:${port}` }, body: initialize() });
  check('spoofed Host (DNS rebinding), with the token: 403', r.status === 403 && !r.headers['mcp-session-id'], `${r.status} ${r.body.slice(0, 80)}`);
  r = await raw(port, { headers: { ...auth, host: `127.0.0.1.attacker.example` }, body: initialize() });
  check('a Host that only starts like 127.0.0.1: 403', r.status === 403, `${r.status}`);
  r = await raw(port, { headers: { ...auth, host: 'localhost:1' }, body: initialize() });
  check('localhost on another port: 403', r.status === 403, `${r.status}`);
  r = await raw(port, { headers: { ...auth, host: `localhost:${port}` }, body: initialize() });
  check('localhost on this port is allowed', r.status === 200 && !!r.headers['mcp-session-id'], `${r.status}`);

  // A session to aim the page's write at, so only the Origin check is left to stop it.
  r = await raw(port, { headers: auth, body: initialize() });
  const sid = String(r.headers['mcp-session-id'] ?? '');
  const inSession = { ...auth, 'mcp-session-id': sid, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION };
  const pageWrite = rpc(7, 'tools/call', { name: 'bookmark_add', arguments: { url: 'https://evil.example/planted', title: 'planted' } });
  const page = 'https://evil.example';
  r = await raw(port, { method: 'OPTIONS', headers: { host, origin: page, 'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization, content-type, mcp-session-id', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' } });
  check('a web page\'s preflight: 403, no CORS grant', r.status === 403 && !r.headers['access-control-allow-origin'] && !r.headers['access-control-allow-headers'],
    `${r.status} allow-origin=${r.headers['access-control-allow-origin'] ?? '(none)'}`);
  r = await raw(port, { headers: { ...inSession, origin: page, 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }, body: pageWrite });
  check('a web page\'s simple POST (no preflight), even with the token and a session: 403', r.status === 403 && !r.headers['access-control-allow-origin'], `${r.status}`);
  r = await raw(port, { headers: { ...inSession, origin: page }, body: pageWrite });
  check('a web page\'s JSON POST: 403', r.status === 403, `${r.status}`);
  r = await raw(port, { headers: { ...inSession, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }, body: pageWrite });
  check('a page on another local port (same-site): 403', r.status === 403, `${r.status}`);
  r = await raw(port, { headers: { ...inSession, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }, body: pageWrite });
  check('a browser request without Origin (Sec-Fetch-Site only): 403', r.status === 403, `${r.status}`);

  r = await raw(port, { headers: { ...auth, 'content-length': String(4 * MiB + 1) }, body: Buffer.alloc(4 * MiB + 1, 0x20) });
  check('a body declared over 4 MiB, with the token: 413', r.status === 413, `${r.status}`);
  r = await raw(port, { headers: { ...inSession }, chunks: Array.from({ length: 5 }, () => Buffer.alloc(MiB, 0x20)) });
  check('a chunked body over 4 MiB, with the token: 413', r.status === 413, `${r.status}`);
  // A client that asks to close: the server reads the rest before answering, or the 413 is lost to a reset.
  const closing: Array<number | string> = [];
  for (let i = 0; i < 4; i++) {
    const declared = i % 2 === 0;
    closing.push(await raw(port, declared
      ? { headers: { ...auth, 'content-length': String(5 * MiB) }, body: Buffer.alloc(5 * MiB, 0x20), close: true }
      : { headers: { ...auth }, chunks: Array.from({ length: 5 }, () => Buffer.alloc(MiB, 0x20)), close: true })
      .then((res) => res.status, (e) => e.code ?? String(e)));
  }
  check('…and with Connection: close, declared or chunked, the 413 still arrives', closing.every((s) => s === 413), closing.join(' '));
  const nearCap = rpc(8, 'tools/call', { name: 'bookmark_add', arguments: { url: 'https://example.org/big', title: 'big', description: 'x'.repeat(3 * MiB) } });
  r = await raw(port, { headers: inSession, body: nearCap });
  check('a 3 MiB body still goes through', r.status === 200 && r.body.includes('example.org/big'), `${r.status}`);

  r = await raw(port, { headers: inSession, body: '{not json' });
  check('a body that isn\'t JSON: 400', r.status === 400 && r.body.includes('-32700'), `${r.status}`);
  r = await raw(port, { headers: { ...auth, 'mcp-session-id': 'no-such-session' }, body: rpc(9, 'tools/list') });
  check('an unknown session: 404, so the client starts a new one', r.status === 404, `${r.status}`);
  r = await raw(port, { path: '/other', headers: auth, body: initialize() });
  check('another path: 404', r.status === 404, `${r.status}`);

  const after = JSON.parse(textOf(await client.callTool({ name: 'bookmark_list', arguments: {} })));
  check('none of the refused requests wrote anything', after.items.length === 2 && !after.items.some((b: any) => b.url.includes('evil.example')),
    after.items.map((b: any) => b.url).join(', '));
  await client.close();

  console.log('\n— sessions');
  const open = async () => String((await raw(port, { headers: auth, body: initialize() })).headers['mcp-session-id'] ?? '');
  const alive = async (id: string) => (await raw(port, { headers: { ...auth, 'mcp-session-id': id, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }, body: rpc(10, 'tools/list') })).status;
  const ids: string[] = [];
  for (let i = 0; i < 32; i++) ids.push(await open());
  check('32 sessions open', ids.every(Boolean) && new Set(ids).size === 32);
  check('…and the oldest idle ones made room', await alive(sid) === 404 && (sdkSession ? await alive(sdkSession) === 404 : false));
  // Keep a GET stream open on the oldest: a session that's in use is never closed for room.
  const stream = await new Promise<http.ClientRequest & { status?: number }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/mcp',
      headers: { host, authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'mcp-session-id': ids[0], 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } },
    (res) => { (req as any).status = res.statusCode; resolve(req); });
    req.on('error', (e) => { if ((req as any).status === undefined) reject(e); });
    req.end();
  });
  check('a GET stream opens on the oldest session', stream.status === 200, `${stream.status}`);
  const extra = await open();
  check('a 33rd session opens', !!extra && await alive(extra) === 200);
  check('…closing the least recently used idle one, not the one with an open stream', await alive(ids[1]) === 404 && await alive(ids[0]) === 200);
  stream.destroy();

  console.log(pass ? '\n✅ HTTP ACCESS CHECKS PASSED' : '\n❌ HTTP ACCESS CHECKS FAILED');
  return pass;
}

const hardStop = setTimeout(() => {
  console.error('http-access: timed out after 90s');
  for (const child of children) child.kill();
  process.exit(1);
}, 90_000);
hardStop.unref();

main()
  .then((pass) => { process.exitCode = pass ? 0 : 1; }, (err) => { console.error('http-access error:', err); process.exitCode = 1; })
  .finally(async () => {
    for (const child of children) child.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const db of dbs) for (const f of [db, `${db}-wal`, `${db}-shm`]) try { rmSync(f, { force: true }); } catch { /* still locked on Windows */ }
    process.exit(process.exitCode ?? 0);
  });
