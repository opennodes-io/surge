// Verifies ONP invocation safety in AiService against an in-process mock registry + node that
// signs real Ed25519 receipts (no network, no fixtures):
//  1. pins are read per request — a refreshed card revision is sent, not the first one cached
//  2. 409 price_changed → card re-resolved, policy re-applied, exactly one retry (no SDK resends);
//     the re-resolved pin survives a model-list refresh from a registry that still lags
//  3. a raised price within the policy is retried; beyond it, surfaced and then blocked
//  4. 409 offering-mismatch → surfaced, not retried
//  5. streaming: re-pin + retry, receipt by URL, stream read to the end before tool calls dispatch
//  6. receipts: verified (inline and by URL), inflated amount / foreign key / wrong revision →
//     invalid, none → missing; spend counts verified amounts, or the ceiling when unverifiable
//  7. spend policy (ONP-5 §3): spending off by default (paid blocked, free runs), minimum tier,
//     schemes, daily budget — all before any request reaches the node
//  8. attested offerings land in the Smart level
// Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-onp-invocation.ts
import http from 'node:http';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AiService, type OnpCallRecord, type PendingToolCall } from '../src/ai/ai-service.js';
import type { SettingsPort } from '../src/ports/index.js';

const NODE_ID = 'org.test.node';
const OFFERING = 'echo-1';
const KEY = `${NODE_ID}/${OFFERING}`;
const MODEL = `onp:${KEY}`;
const USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

type Pricing = { currency: string; input_per_mtok: number; output_per_mtok: number; schemes: string[] };
// Card revisions are strictly increasing ISO-8601 timestamps (ONP-2).
const rev = (n: number) => `2026-10-06T00:00:${String(n).padStart(2, '0')}.000Z`;
const price = (input: number, output: number): Pricing =>
  ({ currency: 'USD', input_per_mtok: input, output_per_mtok: output, schemes: input || output ? ['prepaid'] : ['free'] });
const cost = (p: Pricing) => Math.round((p.input_per_mtok * USAGE.prompt_tokens / 1e6 + p.output_per_mtok * USAGE.completion_tokens / 1e6) * 1e6) / 1e6;

const nodeKey = generateKeyPairSync('ed25519');
const strangerKey = generateKeyPairSync('ed25519');

type ReceiptMode = 'ok' | 'none' | 'inflate' | 'foreign-key' | 'wrong-revision';
// What the node currently serves vs. what the registry has indexed (they can disagree: registry lag).
const node = { revision: rev(1), pricing: price(1, 2), servesOffering: KEY, receipt: 'ok' as ReceiptMode };
const registry = { revision: rev(1), pricing: price(1, 2), tier: 'attested' };
const posts: Array<{ revision: string | undefined; offering: string | undefined }> = [];
const streamedReceipts = new Map<string, string>();

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');
function signJws(payload: object, key: KeyObject): string {
  const h = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'onp-1' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${b64u(sign(null, Buffer.from(`${h}.${p}`), key))}`;
}

function makeReceipt(pinned: string): string | null {
  if (node.receipt === 'none') return null;
  const value = cost(node.pricing) * (node.receipt === 'inflate' ? 2 : 1);
  return signJws({
    receipt_id: `r_${randomUUID()}`, node_id: NODE_ID, offering_id: OFFERING,
    card_revision: node.receipt === 'wrong-revision' ? rev(0) : pinned,
    request_hash: 'sha256:test', usage: USAGE, amount: { currency: node.pricing.currency, value },
    scheme: node.pricing.schemes[0], issued_at: new Date().toISOString(),
  }, node.receipt === 'foreign-key' ? strangerKey.privateKey : nodeKey.privateKey);
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

const problem = (res: http.ServerResponse, status: number, title: string, detail: string) => {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: `https://opennodes.org/problems/${title}`, title, status, detail }));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sse = (res: http.ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

async function main() {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); pass = pass && cond; };

  const mockNode = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/open-node.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        onp: '0.1', revision: node.revision, node: { id: NODE_ID },
        offerings: [{ offering_id: OFFERING, pricing: node.pricing }],
      }));
    }
    if (req.method === 'GET' && req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: [{ ...nodeKey.publicKey.export({ format: 'jwk' }), kid: 'onp-1' }] }));
    }
    if (req.method === 'GET' && req.url?.startsWith('/onp/receipts/')) {
      const jws = streamedReceipts.get(req.url.slice('/onp/receipts/'.length));
      if (!jws) return problem(res, 404, 'unknown-receipt', req.url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(jws);
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const offering = req.headers['onp-offering'] as string | undefined;
        const revision = req.headers['onp-card-revision'] as string | undefined;
        posts.push({ revision, offering });
        if (offering !== node.servesOffering) return problem(res, 409, 'offering-mismatch', String(offering));
        if (revision !== node.revision) return problem(res, 409, 'price_changed', `pinned ${revision}, current ${node.revision}`);
        const body = JSON.parse(raw);
        const prompt = body.messages.at(-1).content;
        const text = `echo:${prompt}`;
        if (body.stream) {
          // Like the Node Kit: the receipt is announced by URL and exists only once the stream
          // has been delivered to the end — a client that stops reading early never gets one.
          const id = `r_${randomUUID()}`;
          let delivered = false;
          res.on('close', () => { if (delivered) { const jws = makeReceipt(revision!); if (jws) streamedReceipts.set(id, jws); } });
          res.writeHead(200, { 'content-type': 'text/event-stream', ...(node.receipt === 'none' ? {} : { 'onp-receipt': `${mockNode.base}/onp/receipts/${id}` }) });
          if (prompt === 'use a tool') {
            sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }] });
            await sleep(20);
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            sse(res, { choices: [{ index: 0, delta: { content: text } }] });
            await sleep(20);
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          await sleep(20);
          if (body.stream_options?.include_usage) sse(res, { choices: [], usage: USAGE });
          await sleep(20);
          res.write('data: [DONE]\n\n');
          delivered = !res.destroyed;
          return res.end();
        }
        const jws = makeReceipt(revision!);
        res.writeHead(200, { 'content-type': 'application/json', ...(jws ? { 'onp-receipt': jws } : {}) });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: USAGE }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  const mockRegistry = await listen((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v0/offerings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ total: 1, offerings: [{
        node_id: NODE_ID, offering_id: OFFERING, tier: registry.tier, source: 'registration', modality: 'text',
        card_revision: registry.revision, model: { name: 'Echo' }, binding: { model_id: 'echo' },
        pricing: registry.pricing, serving: { supports: ['streaming'] }, observed: { ttft_ms: { p50: 120 } },
        endpoints: { openai: `${mockNode.base}/v1` },
      }] }));
    }
    res.writeHead(404).end();
  });

  const SPENDING_ON = { maxRequestUsd: 1, dailyBudgetUsd: 10, maxPricePerMtok: null, minTier: 'unverified', schemes: ['free', 'prepaid', 'x402'] };
  const store: Record<string, any> = { 'ai.onpRegistryUrl': mockRegistry.base, 'onp.policy': SPENDING_ON };
  const settings: SettingsPort = {
    get: (key: string) => store[key],
    set: (key: string, value: any) => { store[key] = value; },
    getTier: () => 'free',
    getMaxConnections: () => 3,
  };
  const ai = new AiService(settings);
  const send = (text: string) => ai.chat([{ role: 'user', content: text }], MODEL);
  const errorOf = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };
  const stream = (text: string) => new Promise<{ text: string; error: string; calls: OnpCallRecord[]; tools?: PendingToolCall[]; order: string[] }>((resolve) => {
    const out = { text: '', error: '', calls: [] as OnpCallRecord[], order: [] as string[] };
    ai.streamChat([{ role: 'user', content: text }], MODEL, {
      onToken: (t) => { out.text += t; },
      onOnpCall: (c) => { out.calls.push(c); out.order.push('onpCall'); },
      onToolCall: (tools) => { out.order.push('toolCall'); resolve({ ...out, tools }); },
      onEnd: () => resolve(out),
      onError: (e) => resolve({ ...out, error: e }),
    });
  });

  // 8) listing
  const models = await ai.listModels();
  const echo = models.find((m) => m.id === MODEL);
  check('attested offering is listed at the Smart level', echo?.level === 'smart', `${echo?.description} · ${echo?.costEstimate}`);

  // 1) per-request pins + an inline receipt
  let r = await send('one');
  check('first call pins revision 1', r.content === 'echo:one' && posts.at(-1)?.revision === rev(1));
  check('inline receipt verified, amount = usage × pinned price', r.onp?.receipt === 'verified' && r.onp?.amount?.value === cost(price(1, 2)),
    `${r.onp?.receipt} ${r.onp?.amount?.value} ${r.onp?.reason ?? ''}`);
  check('spend counts the verified amount', ai.getOnpSpentToday() === cost(price(1, 2)), String(ai.getOnpSpentToday()));
  node.revision = registry.revision = rev(2);
  await ai.refreshOnpModels();
  posts.length = 0;
  r = await send('two');
  check('after a registry refresh the new revision is pinned (no stale cached client)', r.content === 'echo:two' && posts.length === 1 && posts[0].revision === rev(2), JSON.stringify(posts));

  // 2) node revises its card at a lower price; the registry has not re-indexed yet
  node.revision = rev(3); node.pricing = price(0.5, 2);
  posts.length = 0;
  r = await send('three');
  check('price_changed (cheaper) → re-resolved from the card and retried exactly once',
    r.content === 'echo:three' && posts.length === 2 && posts[0].revision === rev(2) && posts[1].revision === rev(3), JSON.stringify(posts));
  check('the receipt is checked against the re-pinned price', r.onp?.receipt === 'verified' && r.onp?.cardRevision === rev(3), r.onp?.reason);
  posts.length = 0;
  r = await send('four');
  check('the re-resolved pin sticks for the next call', posts.length === 1 && posts[0].revision === rev(3));
  await ai.refreshOnpModels(); // registry still lists revision 2
  posts.length = 0;
  r = await send('four-b');
  check('a lagging registry refresh does not roll the pin back', posts.length === 1 && posts[0].revision === rev(3), JSON.stringify(posts));

  // 3) price goes up: within the policy → retried; beyond it → surfaced, then blocked before sending
  node.revision = rev(4); node.pricing = price(0.5, 4);
  posts.length = 0;
  r = await send('five');
  check('price_changed (more expensive, within policy) → re-pinned and retried', r.content === 'echo:five' && posts.length === 2 && posts[1].revision === rev(4));
  store['onp.policy'] = { ...SPENDING_ON, maxPricePerMtok: 5 };
  node.revision = rev(5); node.pricing = price(0.5, 9);
  posts.length = 0;
  const raised = await errorOf(send('six'));
  check('price_changed beyond the policy → surfaced with the new price, not retried',
    raised.includes('changed price') && raised.includes('$0.5/$9') && raised.includes('above your cap') && posts.length === 1, raised);
  check('the picker price reflects the new card', (await ai.listModels()).find((m) => m.id === MODEL)?.costEstimate === '$0.5/$9 per MTok');
  posts.length = 0;
  const again = await errorOf(send('seven'));
  check('sending again is blocked by the policy before reaching the node', again.includes('spend policy') && posts.length === 0, again);
  store['onp.policy'] = SPENDING_ON;

  // 5) streaming path
  node.revision = rev(6);
  posts.length = 0;
  let s = await stream('eight');
  check('streamChat re-pins and retries once on price_changed', !s.error && s.text === 'echo:eight' && posts.length === 2 && posts[1].revision === rev(6), s.error || JSON.stringify(posts));
  check('streamed receipt fetched by URL and verified', s.calls.length === 1 && s.calls[0].receipt === 'verified' && s.calls[0].usage?.completionTokens === 2,
    `${s.calls[0]?.receipt} ${s.calls[0]?.reason ?? ''}`);
  s = await stream('use a tool');
  check('tool-call round: stream read to the end, receipt settled before tools dispatch',
    s.tools?.[0]?.functionName === 'lookup' && s.order.join(',') === 'onpCall,toolCall' && s.calls[0]?.receipt === 'verified',
    `${s.order.join(',')} ${s.calls[0]?.receipt} ${s.calls[0]?.reason ?? ''}`);

  // 6) receipts that must not verify
  for (const [mode, expect, needle] of [
    ['inflate', 'invalid', 'not usage × pinned price'],
    ['foreign-key', 'invalid', 'signature'],
    ['wrong-revision', 'invalid', 'not the pinned'],
  ] as const) {
    node.receipt = mode;
    r = await send(mode);
    check(`${mode} receipt → ${expect}`, r.onp?.receipt === expect && (r.onp?.reason ?? '').includes(needle), `${r.onp?.receipt}: ${r.onp?.reason}`);
  }
  node.receipt = 'none';
  const before = ai.getOnpSpentToday();
  r = await send('no receipt');
  check('no receipt → missing, and spend counts the request ceiling', r.onp?.receipt === 'missing' && ai.getOnpSpentToday() - before > cost(node.pricing),
    `${r.onp?.receipt} +${(ai.getOnpSpentToday() - before).toFixed(6)}`);
  s = await stream('no receipt, streamed');
  check('streamed without receipt → missing', s.calls[0]?.receipt === 'missing');
  node.receipt = 'ok';

  // 7) spend policy, checked before any request leaves the client
  store['onp.policy'] = undefined; // the default: spending off
  posts.length = 0;
  const off = await errorOf(send('paid, spending off'));
  check('default policy blocks a paid offering before sending', off.includes('could cost up to') && posts.length === 0, off);
  node.revision = registry.revision = rev(7); node.pricing = registry.pricing = price(0, 0);
  await ai.refreshOnpModels();
  r = await send('free');
  check('default policy lets a free offering run', r.content === 'echo:free' && r.onp?.receipt === 'verified' && r.onp?.amount?.value === 0, r.onp?.reason);
  node.revision = registry.revision = rev(8); node.pricing = registry.pricing = price(1, 2);
  registry.tier = 'unverified';
  await ai.refreshOnpModels();
  posts.length = 0;
  store['onp.policy'] = { ...SPENDING_ON, minTier: 'community' };
  const tierBlock = await errorOf(send('tier'));
  check('minimum tier blocks an unverified node', tierBlock.includes('below your minimum') && posts.length === 0, tierBlock);
  store['onp.policy'] = { ...SPENDING_ON, schemes: ['x402'] };
  const schemeBlock = await errorOf(send('scheme'));
  check('a disallowed payment scheme is blocked', schemeBlock.includes('scheme prepaid') && posts.length === 0, schemeBlock);
  store['onp.policy'] = { ...SPENDING_ON, dailyBudgetUsd: ai.getOnpSpentToday() + 0.001 };
  const dayBlock = await errorOf(send('budget'));
  check('the daily budget blocks a request that could exceed it', dayBlock.includes('daily budget') && posts.length === 0, dayBlock);
  store['onp.policy'] = SPENDING_ON;

  // 4) the endpoint now serves something else
  node.servesOffering = `${NODE_ID}/other`;
  posts.length = 0;
  const mismatch = await errorOf(send('mismatch'));
  check('offering-mismatch → surfaced, not retried', mismatch.includes('no longer serves') && posts.length === 1, mismatch);

  for (const { server } of [mockNode, mockRegistry]) { server.closeAllConnections(); server.close(); }
  console.log(pass ? '\n✅ ONP INVOCATION VERIFY PASSED' : '\n❌ ONP INVOCATION VERIFY FAILED');
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
