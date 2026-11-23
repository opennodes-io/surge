// Verifies prompt-based tools for ONP nodes whose engine can't take `tools` (no network): a mock
// node that refuses them the way io.opennodes.helsinki does (502 problem+json, "engine returned
// 400: … does not support tools"), and one that calls tools natively, like io.opennodes.demo-node.
//  1. a node's problem+json detail reaches the error message (the SDK used to say "no body"),
//     and a 502 that isn't a refusal is not retried with prompt tools
//  2. a model picked by name: refused natively → retried once with the tools in the prompt, the
//     <tool_call> reply parsed into a tool call, no markup shown; remembered, so the next turn
//     sends one request without `tools`; listed as "tools via prompt"
//  3. Auto: a refusing pick gives way to a node that calls tools natively, and is skipped on the
//     next tool turn; only when no pick takes tools natively does a refuser answer via the prompt
//  4. a stale pin: 409 → card re-resolved → refusal → prompt tools on the re-pinned revision
// Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-onp-prompt-tools.ts
import http from 'node:http';
import { generateKeypair, signCard } from '@opennodes/core';
import type { AddressInfo } from 'node:net';
import { AiService, type OnpCallRecord, type PendingToolCall, type ToolDefinition } from '../src/ai/ai-service.js';
import type { SettingsPort } from '../src/ports/index.js';

const rev = (n: number) => `2026-11-23T00:00:${String(n).padStart(2, '0')}.000Z`;
const FREE = { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] };
const USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
const TOOLS: ToolDefinition[] = [{
  type: 'function',
  function: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
}];

type Mode = 'ok' | 'down';
type Post = { tools: boolean; revision: string | undefined; promptHasTools: boolean };

function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sse = (res: http.ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const problem = (res: http.ServerResponse, status: number, title: string, detail: string) => {
  res.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' });
  res.end(JSON.stringify({ type: `https://opennodes.io/problems/${title}`, title, status, detail }));
};

/** A node serving one offering: native tools or none, a signed card, pin checks like the Node Kit. */
async function mockNode(id: string, offering: string, opts: { nativeTools: boolean }) {
  const key = generateKeypair();
  const state = { revision: rev(1), mode: 'ok' as Mode, posts: [] as Post[] };
  const card = (base: string) => signCard({
    onp: '0.1', revision: state.revision,
    node: { id, name: id, operator: { name: 'Surge tests' } },
    endpoints: { openai: `${base}/v1`, health: `${base}/onp/health` },
    offerings: [{
      offering_id: offering, modality: 'text',
      model: { name: offering, artifact: `urn:proprietary:test:${offering}` },
      serving: { context_window: 8192, max_output_tokens: 4096, supports: ['streaming'] },
      binding: { profile: 'onp.openai.chat/v1', model_id: offering },
      pricing: FREE,
    }],
    payment: { schemes: [{ scheme: 'free' }] },
  }, key.privateKey);

  const node = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/open-node.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(card(node.base)));
    }
    if (req.method === 'GET' && req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: [{ ...key.publicJwk, kid: 'onp-1' }] }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const revision = req.headers['onp-card-revision'] as string | undefined;
      const system = body.messages.find((m: any) => m.role === 'system')?.content ?? '';
      state.posts.push({ tools: !!body.tools, revision, promptHasTools: system.includes('<tool_call>') });
      if (revision !== state.revision) return problem(res, 409, 'price_changed', `pinned ${revision}, current ${state.revision}`);
      if (state.mode === 'down') return problem(res, 502, 'engine-error', 'engine unreachable: connect ECONNREFUSED 127.0.0.1:11434');
      // Captured from io.opennodes.helsinki on 2026-11-23 (bielik-1.5b behind Ollama).
      if (body.tools && !opts.nativeTools) {
        return problem(res, 502, 'engine-error', `engine returned 400: {"error":{"message":"registry.ollama.ai/library/${offering}:latest does not support tools","type":"invalid_request_error","param":null,"code":null}}`);
      }
      const prompt = String(body.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (prompt === 'use a tool' && body.tools) {
        sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"native"}' } }] } }] });
      } else if (prompt === 'use a tool' && system.includes('<tool_call>')) {
        // The marker arrives in pieces, as small models stream it.
        for (const piece of ['Let me check. <tool', '_call>{"name": "lookup", ', '"arguments": {"q": "prompt"}}</tool_call>']) {
          sse(res, { choices: [{ index: 0, delta: { content: piece } }] });
          await sleep(10);
        }
      } else {
        sse(res, { choices: [{ index: 0, delta: { content: `${id}:${prompt}` } }] });
      }
      await sleep(10);
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (body.stream_options?.include_usage) sse(res, { choices: [], usage: USAGE });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const listing = (registryRevision: string) => ({
    node_id: id, offering_id: offering, tier: 'verified', source: 'registration', modality: 'text',
    card_revision: registryRevision, model: { name: offering, params_b: opts.nativeTools ? 1 : 70 },
    binding: { model_id: offering }, pricing: FREE, serving: { supports: ['streaming'] },
    observed: { probe_success: 1, ttft_ms: { p50: 100 } }, endpoints: { openai: `${node.base}/v1` },
  });
  return { ...node, state, listing, key: `${id}/${offering}` };
}

async function main() {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); pass = pass && cond; };

  // The refuser is bigger, so the advisor ranks it first, as it ranks helsinki over demo-node.
  const refuser = await mockNode('org.test.refuser', 'bielik-1.5b', { nativeTools: false });
  const native = await mockNode('org.test.native', 'llama-1b', { nativeTools: true });
  const registryRevision = { refuser: rev(1) };
  const registry = await listen((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v0/offerings')) {
      const offerings = [refuser.listing(registryRevision.refuser), native.listing(rev(1))];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ total: offerings.length, offerings }));
    }
    res.writeHead(404).end();
  });

  const settings = (): SettingsPort => {
    const store: Record<string, any> = { 'ai.onpRegistryUrl': registry.base };
    return { get: (k: string) => store[k], set: (k: string, v: any) => { store[k] = v; }, getMaxConnections: () => 3 };
  };
  const REFUSER = `onp:${refuser.key}`;
  const NATIVE = `onp:${native.key}`;
  type Turn = { text: string; error: string; tools?: PendingToolCall[]; calls: OnpCallRecord[] };
  const turn = (ai: AiService, model: string, text: string, tools: ToolDefinition[] | null = TOOLS) => new Promise<Turn>((resolve) => {
    const out: Turn = { text: '', error: '', calls: [] };
    ai.streamChat([{ role: 'user', content: text }], model, {
      onToken: (t) => { out.text += t; },
      onOnpCall: (c) => { out.calls.push(c); },
      onToolCall: (calls) => resolve({ ...out, tools: calls }),
      onEnd: () => resolve(out),
      onError: (e) => resolve({ ...out, error: e }),
    }, tools ?? undefined);
  });
  const reset = () => { refuser.state.posts.length = 0; native.state.posts.length = 0; };

  // 1) the node's reason reaches the error, and an engine that's down isn't mistaken for a refusal
  let ai = new AiService(settings());
  refuser.state.mode = 'down';
  reset();
  let t = await turn(ai, REFUSER, 'use a tool');
  check('a node\'s problem+json detail reaches the error', t.error.includes('engine-error: engine unreachable'), t.error);
  check('a 502 that is not a refusal is not retried with prompt tools', refuser.state.posts.length === 1, JSON.stringify(refuser.state.posts));
  check('…and the offering is not marked "tools via prompt"', !(await ai.listModels()).find((m) => m.id === REFUSER)?.description.includes('tools via prompt'));
  refuser.state.mode = 'ok';

  // 2) picked by name: refused, retried once in prompt mode, parsed, remembered
  reset();
  t = await turn(ai, REFUSER, 'use a tool');
  check('a refusal is retried once with the tools in the prompt',
    refuser.state.posts.length === 2 && refuser.state.posts[0].tools && !refuser.state.posts[1].tools && refuser.state.posts[1].promptHasTools,
    JSON.stringify(refuser.state.posts));
  check('the <tool_call> reply becomes a tool call', t.tools?.[0]?.functionName === 'lookup' && t.tools?.[0]?.arguments.q === 'prompt', JSON.stringify(t.tools));
  check('no markup reaches the reply', !t.text.includes('<') && t.text.startsWith('Let me check.'), JSON.stringify(t.text));
  check('the call is settled for the node that answered', t.calls[0]?.nodeId === 'org.test.refuser', JSON.stringify(t.calls.map((c) => c.nodeId)));
  check('listed as "tools via prompt"', !!(await ai.listModels()).find((m) => m.id === REFUSER)?.description.includes('tools via prompt'));
  reset();
  t = await turn(ai, REFUSER, 'use a tool');
  check('the next tool turn sends one request, without `tools`',
    refuser.state.posts.length === 1 && !refuser.state.posts[0].tools && refuser.state.posts[0].promptHasTools && t.tools?.[0]?.functionName === 'lookup',
    JSON.stringify(refuser.state.posts));
  reset();
  t = await turn(ai, REFUSER, 'hello', null);
  check('a turn without tools is sent plainly', refuser.state.posts.length === 1 && !refuser.state.posts[0].promptHasTools && t.text === 'org.test.refuser:hello', t.text);
  reset();
  t = await turn(ai, NATIVE, 'use a tool');
  check('a node that takes tools natively still gets them natively',
    native.state.posts.length === 1 && native.state.posts[0].tools && t.tools?.[0]?.arguments.q === 'native', JSON.stringify(native.state.posts));

  // 3) Auto: native tools first, refusers via the prompt only when nothing else takes them
  ai = new AiService(settings());
  reset();
  t = await turn(ai, 'onp:auto', 'use a tool');
  const advisor = t.calls[0]?.advisor;
  check('Auto: a refusing pick gives way to a node with native tools',
    t.calls[0]?.nodeId === 'org.test.native' && t.tools?.[0]?.arguments.q === 'native' && refuser.state.posts.length === 1,
    `${t.calls[0]?.nodeId} · ${JSON.stringify(refuser.state.posts)}`);
  check('Auto: the refusal is recorded as a skip', !!advisor?.skipped.some((s) => s.includes('org.test.refuser') && s.includes('no native tool calling')), JSON.stringify(advisor?.skipped));
  reset();
  t = await turn(ai, 'onp:auto', 'use a tool');
  check('Auto: the next tool turn skips the refuser without asking it', refuser.state.posts.length === 0 && t.calls[0]?.nodeId === 'org.test.native', JSON.stringify(refuser.state.posts));
  reset();
  t = await turn(ai, 'onp:auto', 'hello', null);
  check('Auto: a turn without tools still goes to the top pick', t.calls[0]?.nodeId === 'org.test.refuser', t.calls[0]?.nodeId);
  native.state.mode = 'down';
  reset();
  t = await turn(ai, 'onp:auto', 'use a tool');
  check('Auto: with no native taker, the refuser answers with the tools in the prompt',
    t.calls[0]?.nodeId === 'org.test.refuser' && t.tools?.[0]?.arguments.q === 'prompt' && refuser.state.posts.length === 1 && !refuser.state.posts[0].tools,
    `${t.calls[0]?.nodeId} ${t.error} ${JSON.stringify(refuser.state.posts)}`);
  native.state.mode = 'ok';

  // 4) stale pin: 409 → re-resolved card → refusal → prompt tools, pinned to the new revision
  ai = new AiService(settings());
  refuser.state.revision = rev(2); // the registry still lists rev(1)
  reset();
  t = await turn(ai, REFUSER, 'use a tool');
  const revs = refuser.state.posts.map((p) => `${p.revision === rev(1) ? 'old' : 'new'}${p.tools ? '+tools' : ''}`).join(' ');
  check('409, then a refusal: prompt tools on the re-pinned revision',
    revs === 'old+tools new+tools new' && t.tools?.[0]?.arguments.q === 'prompt' && t.calls[0]?.cardRevision === rev(2), `${revs} · ${t.error}`);
  reset();
  t = await turn(ai, REFUSER, 'use a tool');
  check('…and remembered for that revision', refuser.state.posts.length === 1 && !refuser.state.posts[0].tools && refuser.state.posts[0].revision === rev(2), JSON.stringify(refuser.state.posts));

  for (const s of [refuser.server, native.server, registry.server]) s.close();
  console.log(pass ? '\n✅ ONP PROMPT TOOLS VERIFY PASSED' : '\n❌ ONP PROMPT TOOLS VERIFY FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
