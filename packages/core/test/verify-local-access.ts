// Who may use Surge's two local servers, hermetically (mock Ollama and peers, no network):
//  1. private mode's embedded @opennodes/ollama-router: its own API (/router/*) needs the token the
//     router hands Surge, so a web page can't add a peer or read the catalog; web pages and other
//     Host names can't use the model routes either; Surge itself still lists and calls the models
//  2. the Surge hub: another app's actions wait for the user's Allow (once per site, a script every
//     time; opening a page asks for the site it opens), Deny and a vanished app don't run, actions
//     turned off refuse, and every call is logged without its arguments
// Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-local-access.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startOllamaRouter } from '@opennodes/ollama-router';
import { AiService, PRIVATE_AUTO_MODEL } from '../src/ai/ai-service.js';
import type { SettingsPort } from '../src/ports/index.js';

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;

function serve(handler: Handler): Promise<{ server: http.Server; port: number; origin: string }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ } handler(req, body, res); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    resolve({ server, port, origin: `http://127.0.0.1:${port}` });
  }));
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A request with exactly these headers (fetch can't set Host), as a browser or another process would send it. */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

async function main() {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); pass = pass && cond; };

  // ── 1) the private router ──────────────────────────────
  console.log('— private mode router');
  const ollamaAuth: string[] = [];
  const ollama = await serve((req, body, res) => {
    ollamaAuth.push(String(req.headers.authorization ?? ''));
    if (req.url === '/api/tags') return json(res, 200, { models: ['tiny:1b', 'plain:4b'].map((name) => ({ name, details: { parameter_size: name.split(':')[1].toUpperCase() } })) });
    if (req.url === '/api/show') return json(res, 200, { capabilities: body?.model === 'plain:4b' ? ['completion'] : ['completion', 'tools'], model_info: {} });
    if (req.url === '/v1/chat/completions') {
      return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: `local:${body.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    json(res, 404, {});
  });
  // What a page would add as a "LAN" peer: an Ollama-shaped server it controls. Any request here means it got in.
  const attackerSeen: string[] = [];
  const attacker = await serve((req, _body, res) => {
    attackerSeen.push(String(req.url));
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'trap:1b', details: {} }] });
    json(res, 200, { capabilities: ['completion', 'tools'] });
  });
  const ownPeerSeen: string[] = [];
  const ownPeer = await serve((req, _body, res) => {
    ownPeerSeen.push(String(req.url));
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'box:3b', details: {} }] });
    json(res, 200, { capabilities: ['completion'] });
  });

  const router: any = await startOllamaRouter({ port: 0, host: '127.0.0.1', ollama: ollama.origin, registry: null, mdns: false, log: () => {} });
  const token: string = router.token ?? '';
  const port: number = router.port;
  check('the router hands its owner a token', typeof router.token === 'string' && router.token.length >= 24, `token: ${typeof router.token}`);

  const page = 'https://attacker.example';
  const peerBody = JSON.stringify({ origin: attacker.origin });
  // A "simple" cross-origin POST: text/plain, so the browser sends it without a preflight.
  let r = await raw(port, { method: 'POST', path: '/router/peers', body: peerBody,
    headers: { origin: page, 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'cross-site', host: `127.0.0.1:${port}` } });
  check('a web page\'s POST /router/peers (no preflight) is refused', r.status === 401 || r.status === 403, `${r.status} ${r.body.slice(0, 120)}`);
  check('…and the page\'s server is never probed or added', attackerSeen.length === 0 && !router.peers.some((p: any) => p.origin === attacker.origin),
    `attacker saw ${attackerSeen.join(',') || 'nothing'}`);
  r = await raw(port, { method: 'OPTIONS', path: '/router/peers',
    headers: { origin: page, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', host: `127.0.0.1:${port}` } });
  const acao = String(r.headers['access-control-allow-origin'] ?? '');
  check('a web page\'s preflight gets no CORS grant', acao !== '*' && acao !== page && r.status >= 400, `${r.status} allow-origin=${acao || '(none)'}`);
  r = await raw(port, { method: 'POST', path: '/router/peers', body: peerBody, headers: { origin: page, 'content-type': 'application/json', host: `127.0.0.1:${port}` } });
  check('a JSON POST from a web page is refused too', (r.status === 401 || r.status === 403) && attackerSeen.length === 0, `${r.status}`);
  r = await raw(port, { method: 'POST', path: '/router/peers', body: peerBody, headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` } });
  check('another local process without the token can\'t add a peer', r.status === 401 && attackerSeen.length === 0, `${r.status}`);
  r = await raw(port, { path: '/router/catalog', headers: { host: `127.0.0.1:${port}` } });
  check('the catalog needs the token', r.status === 401, `${r.status}`);
  r = await raw(port, { path: '/api/tags', headers: { origin: page, host: `127.0.0.1:${port}` } });
  check('a web page can\'t list the local models', r.status === 403 && !r.body.includes('tiny:1b') && !r.headers['access-control-allow-origin'], `${r.status}`);
  const chat = JSON.stringify({ model: 'tiny:1b', messages: [{ role: 'user', content: 'hi' }] });
  r = await raw(port, { method: 'POST', path: '/v1/chat/completions', body: chat, headers: { origin: page, 'content-type': 'text/plain', host: `127.0.0.1:${port}` } });
  check('a web page can\'t prompt the local models', r.status === 403, `${r.status}`);
  // DNS rebinding: the page's own name resolves to 127.0.0.1, so its requests are same-origin to it.
  r = await raw(port, { method: 'POST', path: '/v1/chat/completions', body: chat,
    headers: { host: `rebind.attacker.example:${port}`, origin: `http://rebind.attacker.example:${port}`, 'content-type': 'application/json' } });
  check('a DNS-rebinding page (foreign Host) is refused', r.status === 403, `${r.status}`);
  r = await raw(port, { method: 'POST', path: '/router/peers', body: JSON.stringify({ origin: ownPeer.origin }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', host: `127.0.0.1:${port}` } });
  check('with the token, the owner can still add a peer', r.status === 200 && ownPeerSeen.includes('/api/tags'), `${r.status} ${r.body.slice(0, 120)}`);

  // Surge itself: the token on /router/*, the model routes and /api/show as a local app.
  const settings: Record<string, any> = { 'ai.onpRegistryUrl': 'http://127.0.0.1:9', 'private.enabled': true };
  const port_: SettingsPort = { get: (k: string) => settings[k] ?? null, set: (k: string, v: any) => { settings[k] = v; }, getMaxConnections: () => 25 };
  const ai = new AiService(port_);
  ai.setPrivateRouter({ origin: router.origin, token });
  const models = await ai.listModels();
  const ids = models.map((m) => m.id);
  check('Surge still lists the private models, led by Auto (private)', ids[0] === PRIVATE_AUTO_MODEL && ids.includes('private:tiny:1b') && ids.includes('private:plain:4b'), ids.join());
  check('…the page\'s server isn\'t among them', !ids.some((id) => id.includes('trap')), ids.join());
  check('…and /api/show still marks a model without tools', models.find((m) => m.id === 'private:plain:4b')?.description.includes('tools via prompt') === true
    && models.find((m) => m.id === 'private:tiny:1b')?.supportsToolCalling === true);
  const answer = await ai.chat([{ role: 'user', content: 'hi' }], 'private:tiny:1b');
  check('a local model answers Surge through the router', answer.content === 'local:tiny:1b', answer.content);
  check('the router token never reaches Ollama', !ollamaAuth.some((a) => a.includes(token)), ollamaAuth.filter(Boolean).join());
  const noToken = new AiService(port_);
  noToken.setPrivateRouter({ origin: router.origin, token: 'wrong' });
  check('with a wrong token the catalog stays closed', (await noToken.listModels()).length === 0);

  const box = models.find((m) => m.id.includes('box:3b'));
  check('a LAN peer the user added is listed, marked unpinned, and left out of Auto (private)',
    !!box?.description.includes('not pinned, so Auto (private) skips it') && models[0].description.startsWith('Picks one of 2 models'),
    `${box?.description} | ${models[0].description}`);

  await router.close();
  for (const m of [ollama, attacker, ownPeer]) { m.server.closeAllConnections(); m.server.close(); }

  // ── 2) the Surge hub ───────────────────────────────────
  // The real hub (apps/desktop's SurgeHub, Electron-free) behind the MCP SDK's own client.
  console.log('\n— Surge hub');
  const { SurgeHub } = await import('../../../apps/desktop/src/main/services/surge-hub.js');
  const { McpManager, SurgeStore } = await import('../src/index.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const free = await new Promise<number>((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
  const hubSettings: Record<string, any> = { 'hub.enabled': true, 'hub.allowActions': true, 'hub.port': free };
  const settingsPort: SettingsPort = { get: (k: string) => hubSettings[k] ?? null, set: (k: string, v: any) => { hubSettings[k] = v; }, getMaxConnections: () => 25 };
  const secretMap = new Map<string, string>();
  const secrets = { getSecret: (k: string) => secretMap.get(k) ?? null, setSecret: (k: string, v: string) => { secretMap.set(k, v); }, available: () => true };

  const ran: string[] = [];
  const tool = (serverId: string, name: string) => ({ name, serverId, description: name, inputSchema: { type: 'object', properties: {} } });
  const mcp = new McpManager(settingsPort);
  mcp.registerVirtualServer({
    id: 'browser', name: 'Browser (page tools)', source: 'ephemeral-browser',
    tools: ['getPageContent', 'clickElement', 'navigateTo', 'evaluateScript', 'fillInput'].map((n) => tool('browser', n)),
    callTool: async (name: string) => { ran.push(name); return { content: [{ type: 'text', text: `did ${name}` }] }; },
  });
  mcp.registerVirtualServer({
    id: 'bookmarks', name: 'Bookmarks', source: 'in-process',
    tools: ['bookmark_list', 'bookmark_add'].map((n) => tool('bookmarks', n)),
    callTool: async (name: string) => { ran.push(name); return { content: [{ type: 'text', text: `did ${name}` }] }; },
  });

  let openPage: string | null = 'https://shop.example';
  type Asked = { req: any; signal: AbortSignal; answer: (a: 'allow' | 'deny' | 'no-answer' | 'cancelled') => void };
  const asked: Asked[] = [];
  const store = await SurgeStore.open({ path: ':memory:' });
  const logging: Promise<unknown>[] = [];
  const hub = new SurgeHub(mcp, settingsPort as any, secrets as any, {
    version: 'test',
    pageOrigin: () => openPage,
    // What the desktop's card does: wait for the user; go away when the app does.
    ask: (req: any, signal: AbortSignal) => new Promise((resolve) => {
      asked.push({ req, signal, answer: resolve });
      signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    }),
    log: (entry: any) => { logging.push(store.hubCalls.record(entry)); },
  });
  await hub.apply();
  const hubToken = hub.token();
  const connect = async (bearer = hubToken) => {
    const client = new Client({ name: 'verify', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${free}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
    return client;
  };
  const text = (r: any) => String(r?.content?.[0]?.text ?? '');
  const waitFor = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  const stillWaiting = async (p: Promise<unknown>, ms = 250) => Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

  const app = await connect();
  let res: any = await app.callTool({ name: 'browser__getPageContent', arguments: {} });
  check('a read runs without asking', text(res) === 'did getPageContent' && asked.length === 0, text(res));

  let call = app.callTool({ name: 'browser__clickElement', arguments: { selector: '#buy' } });
  await waitFor(() => asked.length === 1);
  check('an action waits for the card', asked.length === 1 && await stillWaiting(call) && !ran.includes('clickElement'), `ran=${ran.join()}`);
  check('…which asks about the open page\'s site, once per site', asked[0]?.req.risk === 'action' && asked[0]?.req.scope.label === 'shop.example' && asked[0]?.req.remembers === true,
    JSON.stringify(asked[0]?.req.scope));
  asked[0].answer('allow');
  res = await call;
  check('Allow runs it', text(res) === 'did clickElement' && ran.filter((n) => n === 'clickElement').length === 1, text(res));
  res = await app.callTool({ name: 'browser__clickElement', arguments: { selector: '#again' } });
  check('the same site doesn\'t ask again', text(res) === 'did clickElement' && asked.length === 1);

  call = app.callTool({ name: 'browser__navigateTo', arguments: { url: 'bank.example/login' } });
  await waitFor(() => asked.length === 2);
  check('opening a page asks too, for the site it opens', asked[1]?.req.risk === 'action' && asked[1]?.req.scope.label === 'bank.example' && await stillWaiting(call),
    JSON.stringify(asked[1]?.req.scope));
  asked[1].answer('deny');
  res = await call;
  check('Deny: it doesn\'t run, and the app hears it was declined', res.isError === true && text(res).includes('declined') && !ran.includes('navigateTo'), text(res));

  openPage = 'https://other.example';
  call = app.callTool({ name: 'browser__clickElement', arguments: { selector: '#x' } });
  check('another site asks', await waitFor(() => asked.length === 3) && asked[2].req.scope.label === 'other.example');
  asked[2].answer('allow');
  await call;

  call = app.callTool({ name: 'browser__evaluateScript', arguments: { script: 'document.cookie' } });
  await waitFor(() => asked.length === 4);
  check('a script asks, and isn\'t remembered', asked[3]?.req.risk === 'script' && asked[3]?.req.remembers === false);
  asked[3].answer('allow');
  await call;
  call = app.callTool({ name: 'browser__evaluateScript', arguments: { script: 'document.title' } });
  check('…so the next script asks again', await waitFor(() => asked.length === 5));
  asked[4].answer('deny');
  await call;

  res = await app.callTool({ name: 'bookmarks__bookmark_list', arguments: {} });
  check('reading bookmarks is free', text(res) === 'did bookmark_list' && asked.length === 5);
  call = app.callTool({ name: 'bookmarks__bookmark_add', arguments: { url: 'https://x.example' } });
  check('saving one asks', await waitFor(() => asked.length === 6) && asked[5].req.scope.label === 'your bookmarks and history');
  asked[5].answer('allow');
  await call;

  // The app gives up (a client timeout, or it quits) while the card waits.
  openPage = 'https://login.example';
  const quitter = await connect();
  const abandoned = quitter.callTool({ name: 'browser__fillInput', arguments: { selector: '#pw', value: 'hunter2' } }).catch(() => 'gone');
  await waitFor(() => asked.length === 7);
  await quitter.close();
  await abandoned;
  check('an app that goes away takes its card with it', await waitFor(() => asked[6]?.signal.aborted === true) && !ran.includes('fillInput'));

  // The user turns actions off while a card waits: the Allow doesn't run it.
  openPage = 'https://late.example';
  call = app.callTool({ name: 'browser__clickElement', arguments: { selector: '#late' } });
  await waitFor(() => asked.length === 8);
  hubSettings['hub.allowActions'] = false;
  asked[7]?.answer('allow');
  res = await call;
  check('actions turned off while the card waits: it doesn\'t run', res.isError === true && ran.filter((n) => n === 'clickElement').length === 3, text(res));
  res = await app.callTool({ name: 'browser__clickElement', arguments: { selector: '#off' } });
  check('with actions off, an action is refused without a card', res.isError === true && text(res).includes("it's off") && asked.length === 8, text(res));
  hubSettings['hub.allowActions'] = true;
  hub.forgetApprovals();
  openPage = 'https://shop.example';
  call = app.callTool({ name: 'browser__clickElement', arguments: { selector: '#buy' } });
  check('after actions go off and on, a site allowed before asks again', await waitFor(() => asked.length === 9) && asked[8].req.scope.label === 'shop.example');
  asked[8].answer('allow');
  await call;

  const wrong = await connect('not-the-token').then(() => 'connected', (e: any) => String(e?.message ?? e));
  check('a wrong token is refused', wrong !== 'connected', wrong.slice(0, 80));

  await Promise.all(logging);
  const log = (await store.hubCalls.list({ limit: 50 })).reverse();
  const decisions = log.map((e) => `${e.tool.split('__')[1]}:${e.decision}`).join(' ');
  check('every call is logged with what the user decided', decisions ===
    'getPageContent:read clickElement:allowed clickElement:remembered navigateTo:declined clickElement:allowed evaluateScript:allowed evaluateScript:declined '
    + 'bookmark_list:read bookmark_add:allowed fillInput:cancelled clickElement:actions-off clickElement:actions-off clickElement:allowed', decisions);
  check('…with the site, and whether it ran', log[1].scope === 'shop.example' && log[1].ok === true && log[3].scope === 'bank.example' && log[3].ok === null);
  const logText = JSON.stringify(log);
  check('…but never the arguments (typed text can be a password)', !logText.includes('hunter2') && !logText.includes('document.cookie') && !logText.includes('#buy'));

  await app.close();
  await hub.stop();
  store.close();
  console.log(pass ? '\n✅ LOCAL ACCESS VERIFY PASSED' : '\n❌ LOCAL ACCESS VERIFY FAILED');
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
