// Verifies item 5 of the OpenNodes client work, hermetically (mock registry, nodes and Ollama):
//  1. per-host API keys (SecretStorePort): a key is sent only to the host it was saved for,
//     unlocks that host's imported offerings, joins them to the Auto pool, and is forgotten on delete
//  2. spend ledger: settled calls persist through SurgeStore.onpCalls and summarize by UTC day / node
//  3. private mode: @opennodes/ollama-router embedded with no registry — only local models are
//     listed and answer (auto-private included), everything else is refused, the registry untouched
// Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-keys-spend-private.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startOllamaRouter } from '@opennodes/ollama-router';
import { AiService, PRIVATE_AUTO_MODEL, type OnpCallRecord } from '../src/ai/ai-service.js';
import { SurgeStore } from '../src/storage/index.js';
import type { SettingsPort, SecretStorePort } from '../src/ports/index.js';

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;

// Dual-stack listener, so the same server answers as 127.0.0.1 and as localhost (two hostnames).
function serve(handler: Handler): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handler(req, raw ? JSON.parse(raw) : null, res));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// An OpenAI-compatible reply that echoes which model answered and the last user turn.
function reply(res: http.ServerResponse, body: any, who: string) {
  const text = `${who}:${body.model}:${body.messages.at(-1).content}`;
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
}

async function main() {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); pass = pass && cond; };
  const errorOf = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };

  // ── mocks ──────────────────────────────────────────────
  const seen = { admitted: [] as string[], imported: [] as string[], ollama: [] as string[], registry: 0 };
  const admitted = await serve((req, body, res) => {
    if (req.url === '/v1/chat/completions') { seen.admitted.push(String(req.headers.authorization)); return reply(res, body, 'admitted'); }
    json(res, 404, {});
  });
  const KEY = 'sk-test-123';
  const imported = await serve((req, body, res) => {
    if (req.url !== '/v1/chat/completions') return json(res, 404, {});
    seen.imported.push(String(req.headers.authorization));
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: 'missing or wrong API key' } });
    reply(res, body, 'imported');
  });
  const offering = (o: Record<string, unknown>) => ({
    source: 'registration', modality: 'text', card_revision: '2026-10-06T00:00:01.000Z', binding: {}, serving: { supports: ['streaming'] },
    pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] }, observed: { probe_success: 1 }, ...o,
  });
  const registry = await serve((req, _body, res) => {
    seen.registry++;
    const url = new URL(req.url!, 'http://x');
    if (url.pathname !== '/v0/offerings') return json(res, 404, {});
    const all = [
      offering({ node_id: 'org.test.admitted', offering_id: 'small', tier: 'verified', model: { name: 'Small', params_b: 1 }, binding: { model_id: 'small' },
        endpoints: { openai: `http://127.0.0.1:${admitted.port}/v1` } }),
      offering({ node_id: 'import.test.catalog', offering_id: 'big', tier: 'unverified', source: 'import', model: { name: 'Big', params_b: 70 }, binding: { model_id: 'big' },
        endpoints: { openai: `http://localhost:${imported.port}/v1` } }),
    ];
    const minTier = url.searchParams.get('tier');
    json(res, 200, { offerings: minTier ? all.filter((o) => o.tier !== 'unverified') : all });
  });
  const ollama = await serve((req, body, res) => {
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'tiny:1b', details: { parameter_size: '1B' } }, { name: 'mid:8b', details: { parameter_size: '8B' } }] });
    if (req.url === '/api/show') return json(res, 200, { capabilities: ['completion', 'tools'], model_info: {} });
    if (req.url === '/v1/chat/completions') { seen.ollama.push(body.model); return reply(res, body, 'ollama'); }
    json(res, 404, {});
  });

  const settingsStore: Record<string, any> = { 'ai.onpRegistryUrl': `http://127.0.0.1:${registry.port}` };
  const settings: SettingsPort = {
    get: (k) => settingsStore[k], set: (k, v) => { settingsStore[k] = v; }, getTier: () => 'free', getMaxConnections: () => 3,
  };
  const vault = new Map<string, string>();
  const secrets: SecretStorePort = {
    getSecret: (k) => vault.get(k) ?? null, setSecret: (k, v) => { vault.set(k, v); }, deleteSecret: (k) => { vault.delete(k); }, listSecrets: () => [...vault.keys()],
  };
  const ai = new AiService(settings, secrets);
  const send = (model: string, text: string) => ai.chat([{ role: 'user', content: text }], model);

  // ── 2) ledger wiring (as the desktop does it) ─────────
  const store = await SurgeStore.open({ path: ':memory:', deviceId: 'test' });
  const writes: Promise<unknown>[] = [];
  const settled: OnpCallRecord[] = [];
  ai.onOnpCallSettled((c) => {
    settled.push(c);
    writes.push(store.onpCalls.record({
      at: c.at, offering: c.offering, nodeId: c.nodeId, modelName: c.modelName, tier: c.tier, price: c.price, cardRevision: c.cardRevision,
      receipt: c.receipt, receiptId: c.receiptId ?? null, reason: c.reason ?? null, promptTokens: c.usage?.promptTokens ?? null,
      completionTokens: c.usage?.completionTokens ?? null, amount: c.amount ?? null, countedUsd: c.countedUsd, durationMs: c.durationMs, advisor: c.advisor ?? null,
    }));
  });

  // ── 1) per-host keys ───────────────────────────────────
  let models = await ai.listModels();
  check('without a key, Auto routes over the admitted node only', /Picks one of 1 admitted node per/.test(models.find((m) => m.id === 'onp:auto')?.description ?? ''));
  const noKey = await errorOf(send('onp:import.test.catalog/big', 'no key'));
  check('an imported offering without a key fails at its host (401)', noKey.includes('401'), noKey);
  check('hostnames are validated', (await errorOf(ai.setOnpKey('http://localhost', KEY))).includes('not a hostname'));

  await ai.setOnpKey('localhost', KEY);
  check('the store holds the key by host; listing returns names only', vault.get('onp.key.localhost') === KEY && (await ai.getOnpKeyHosts()).join() === 'localhost');
  models = await ai.listModels();
  check('the keyed offering is marked and joins Auto', !!models.find((m) => m.id === 'onp:import.test.catalog/big')?.description.includes('your key')
    && /1 admitted node \+ 1 offering you have keys for/.test(models.find((m) => m.id === 'onp:auto')?.description ?? ''), models.find((m) => m.id === 'onp:auto')?.description);
  let r = await send('onp:import.test.catalog/big', 'with key');
  check('with the key, the imported offering answers', r.content === 'imported:big:with key', r.content);
  check('the key went to its host', seen.imported.at(-1) === `Bearer ${KEY}`);
  r = await send('onp:org.test.admitted/small', 'admitted');
  check('the key is not sent to any other host', r.content.startsWith('admitted:') && seen.admitted.every((h) => !h.includes(KEY)), JSON.stringify(seen.admitted));
  r = await send('onp:auto', 'auto with keys');
  check('Auto can route to the keyed offering (ranked first here)', r.onp?.offering === 'import.test.catalog/big' && r.content === 'imported:big:auto with keys', r.onp?.offering);
  await ai.deleteOnpKey('localhost');
  const afterDelete = await errorOf(send('onp:import.test.catalog/big', 'deleted'));
  check('deleting the key rebuilds the client: 401 again', afterDelete.includes('401') && (await ai.getOnpKeyHosts()).length === 0, afterDelete);

  // ── 2) ledger ──────────────────────────────────────────
  await Promise.all(writes);
  await store.onpCalls.record({ ...{ offering: 'org.test.admitted/small', nodeId: 'org.test.admitted', modelName: 'Small', tier: 'verified', price: 'Free',
    cardRevision: 'r', receipt: 'verified', receiptId: 'r_old', reason: null, promptTokens: 5, completionTokens: 5, amount: { currency: 'USD', value: 0.25 },
    countedUsd: 0.25, durationMs: 10, advisor: null }, at: Date.now() - 3 * 86_400_000 });
  const summary = await store.onpCalls.summary({ days: 14 });
  const recent = await store.onpCalls.list({ limit: 10 });
  check('every settled call was persisted (plus one older seeded call)', summary.calls === settled.length + 1 && recent.length === settled.length + 1, `${summary.calls} vs ${settled.length + 1}`);
  check('spend is summarized by UTC day', summary.byDay.length === 2 && summary.totalUsd === 0.25, JSON.stringify(summary.byDay));
  const byNode = Object.fromEntries(summary.byNode.map((n) => [n.nodeId, n]));
  check('and by node, with receipt counts', byNode['org.test.admitted']?.verified === 1 && byNode['import.test.catalog']?.unreceipted === 2,
    JSON.stringify(summary.byNode));
  check('advisor details survive the round trip', recent.some((c) => (c.advisor as any)?.taskClass === 'chat'));

  // ── 3) private mode ────────────────────────────────────
  const router = await startOllamaRouter({ port: 0, host: '127.0.0.1', ollama: `http://127.0.0.1:${ollama.port}`, registry: null, mdns: false, log: () => {} });
  settingsStore['private.enabled'] = true;
  ai.setPrivateRouter(router.origin);
  const registryBefore = seen.registry;
  models = await ai.listModels();
  check('private mode lists only the local models, led by Auto (private)', models.map((m) => m.id).join() === `${PRIVATE_AUTO_MODEL},private:tiny:1b,private:mid:8b`,
    models.map((m) => m.id).join());
  const refused = await errorOf(send('onp:auto', 'leak?'));
  check('anything else is refused', refused.includes('Private mode is on'), refused);
  r = await send('private:tiny:1b', 'local');
  check('a chosen local model answers through the router', r.content === 'ollama:tiny:1b:local' && seen.ollama.at(-1) === 'tiny:1b', r.content);
  r = await send(PRIVATE_AUTO_MODEL, 'auto local');
  check('auto-private routes to one of the local models', /^ollama:(tiny:1b|mid:8b):auto local$/.test(r.content), r.content);
  const streamed = await new Promise<string>((resolve) => {
    let text = '';
    ai.streamChat([{ role: 'user', content: 'stream local' }], PRIVATE_AUTO_MODEL, {
      onToken: (t) => { text += t; }, onEnd: () => resolve(text), onError: (e) => resolve(`error: ${e}`),
    });
  });
  check('auto-private streams too', /^ollama:(tiny:1b|mid:8b):stream local$/.test(streamed), streamed);
  check('the registry was never contacted in private mode', seen.registry === registryBefore, `${seen.registry - registryBefore} requests`);
  settingsStore['private.enabled'] = false;
  ai.setPrivateRouter(null);
  await router.close();
  check('with private mode off, private models say it is not running', (await errorOf(send('private:tiny:1b', 'x'))).includes('not running'));

  for (const m of [admitted, imported, registry, ollama]) { m.server.closeAllConnections(); m.server.close(); }
  store.close();
  console.log(pass ? '\n✅ KEYS / SPEND / PRIVATE VERIFY PASSED' : '\n❌ KEYS / SPEND / PRIVATE VERIFY FAILED');
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
