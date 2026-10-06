// Verifies ONP invocation safety in AiService against an in-process mock registry + node
// (no network, no fixtures):
//  1. pins are read per request — a refreshed card revision is sent, not the first one cached
//  2. 409 price_changed at the same/lower price → card re-resolved, exactly one retry (no SDK resends);
//     the re-resolved pin survives a model-list refresh from a registry that still lags
//  3. 409 price_changed at a higher price → surfaced with the new price; sending again accepts it
//  4. 409 offering-mismatch → surfaced, not retried
//  5. the streaming path (streamChat) gets the same re-pin + retry
//  6. attested offerings land in the Smart level
// Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-onp-invocation.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiService } from '../src/ai/ai-service.js';
import type { SettingsPort } from '../src/ports/index.js';

const NODE_ID = 'org.test.node';
const OFFERING = 'echo-1';
const KEY = `${NODE_ID}/${OFFERING}`;

type Pricing = { currency: string; input_per_mtok: number; output_per_mtok: number; schemes: string[] };
// Card revisions are strictly increasing ISO-8601 timestamps (ONP-2).
const rev = (n: number) => `2026-10-06T00:00:0${n}.000Z`;
const price = (input: number, output: number): Pricing => ({ currency: 'USD', input_per_mtok: input, output_per_mtok: output, schemes: ['prepaid'] });

// What the node currently serves vs. what the registry has indexed (they can disagree: registry lag).
const node = { revision: rev(1), pricing: price(1, 2), servesOffering: KEY };
const registry = { revision: rev(1), pricing: price(1, 2), tier: 'attested' };
const posts: Array<{ revision: string | undefined; offering: string | undefined }> = [];

function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

const problem = (res: http.ServerResponse, status: number, title: string, detail: string) => {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: `https://opennodes.org/problems/${title}`, title, status, detail }));
};

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
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const offering = req.headers['onp-offering'] as string | undefined;
        const revision = req.headers['onp-card-revision'] as string | undefined;
        posts.push({ revision, offering });
        if (offering !== node.servesOffering) return problem(res, 409, 'offering-mismatch', String(offering));
        if (revision !== node.revision) return problem(res, 409, 'price_changed', `pinned ${revision}, current ${node.revision}`);
        const body = JSON.parse(raw);
        const text = `echo:${body.messages.at(-1).content}`;
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
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
        pricing: registry.pricing, serving: { supports: ['streaming'] }, observed: {},
        endpoints: { openai: `${mockNode.base}/v1` },
      }] }));
    }
    res.writeHead(404).end();
  });

  const settings: SettingsPort = {
    get: (key: string) => (key === 'ai.onpRegistryUrl' ? mockRegistry.base : undefined),
    set: () => {},
    getTier: () => 'free',
    getMaxConnections: () => 3,
  };
  const ai = new AiService(settings);
  const MODEL = `onp:${KEY}`;
  const send = (text: string) => ai.chat([{ role: 'user', content: text }], MODEL);
  const errorOf = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };

  // 6) listing
  const models = await ai.listModels();
  const echo = models.find((m) => m.id === MODEL);
  check('attested offering is listed at the Smart level', echo?.level === 'smart', `${echo?.description} · ${echo?.costEstimate}`);

  // 1) per-request pins: first call caches a client at revision 1, then the card moves on and the registry catches up
  let r = await send('one');
  check('first call pins revision 1', r.content === 'echo:one' && posts.at(-1)?.revision === rev(1));
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
  posts.length = 0;
  r = await send('four');
  check('the re-resolved pin sticks for the next call', posts.length === 1 && posts[0].revision === rev(3));
  await ai.refreshOnpModels(); // registry still lists revision 2
  posts.length = 0;
  r = await send('four-b');
  check('a lagging registry refresh does not roll the pin back', posts.length === 1 && posts[0].revision === rev(3), JSON.stringify(posts));

  // 3) price goes up → surfaced, then accepted by sending again
  node.revision = rev(4); node.pricing = price(0.5, 9);
  posts.length = 0;
  const raised = await errorOf(send('five'));
  check('price_changed (more expensive) → surfaced with the new price, not retried',
    raised.includes('changed price') && raised.includes('$0.5/$9') && posts.length === 1, raised);
  check('the picker price reflects the new card', (await ai.listModels()).find((m) => m.id === MODEL)?.costEstimate === '$0.5/$9 per MTok');
  posts.length = 0;
  r = await send('six');
  check('sending again accepts the new price (revision 4 pinned)', r.content === 'echo:six' && posts.length === 1 && posts[0].revision === rev(4));

  // 5) streaming path
  node.revision = rev(5);
  posts.length = 0;
  let streamed = '';
  const streamErr = await new Promise<string>((resolve) => ai.streamChat(
    [{ role: 'user', content: 'seven' }], MODEL,
    { onToken: (t) => { streamed += t; }, onEnd: () => resolve(''), onError: (e) => resolve(e) },
  ));
  check('streamChat re-pins and retries once on price_changed',
    !streamErr && streamed === 'echo:seven' && posts.length === 2 && posts[1].revision === rev(5), streamErr || JSON.stringify(posts));

  // 4) the endpoint now serves something else
  node.servesOffering = `${NODE_ID}/other`;
  posts.length = 0;
  const mismatch = await errorOf(send('eight'));
  check('offering-mismatch → surfaced, not retried', mismatch.includes('no longer serves') && posts.length === 1, mismatch);

  for (const { server } of [mockNode, mockRegistry]) { server.closeAllConnections(); server.close(); }
  console.log(pass ? '\n✅ ONP INVOCATION VERIFY PASSED' : '\n❌ ONP INVOCATION VERIFY FAILED');
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
