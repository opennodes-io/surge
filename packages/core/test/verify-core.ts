// Quick verification of the newest core pieces (run via tsx).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@libsql/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AiService, McpManager, SurgeStore, agentServerId, createBookmarksVirtualServer, runToolLoop, toolRisk, type SettingsPort } from '@surge/core';
import { detectUiResource } from '@surge/core/ui';

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

const readBody = async (req: http.IncomingMessage) => {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : null;
};

/**
 * 6) Tool names providers accept. Tools are named "serverId__toolName", but server ids aren't always
 * names: MCPWeb sites are "mcpweb:<origin>", per-site agents "agent:<host>", and catalog slugs can carry
 * "/" or "." or start with a digit; MCP tool names may contain dots. OpenAI-style APIs reject anything
 * outside ^[a-zA-Z0-9_-]{1,64}$ (a 400 for the whole turn), and Gemini also wants a letter or underscore
 * first. A real MCPWeb site (in-process MCP server over Streamable HTTP), a mock OpenAI-compatible
 * model that validates names like OpenAI does, and a mocked Gemini endpoint that validates them like
 * Gemini does.
 */
async function verifyToolNames(): Promise<boolean> {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); pass = pass && cond; };

  // ── an MCPWeb site: stateless Streamable HTTP, a plain tool and a dotted one ──
  const siteCalls: Array<{ name: string; args: any }> = [];
  const site = http.createServer(async (req, res) => {
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    const body = await readBody(req);
    const mcp = new Server({ name: 'example-site', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'search', description: 'Search the site', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
        { name: 'docs.read', description: 'Read a docs page', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      siteCalls.push({ name: r.params.name, args: r.params.arguments });
      return { content: [{ type: 'text', text: `results for ${(r.params.arguments as any)?.q}: Widget, Gadget` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  const sitePort = await listen(site);

  // ── an OpenAI-compatible model that rejects bad names the way OpenAI does ──
  const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
  const model = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const names: string[] = (body.tools ?? []).map((t: any) => t.function.name);
    const bad = names.findIndex((n) => !OPENAI_NAME.test(n));
    if (bad >= 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: {
        message: `Invalid 'tools[${bad}].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`,
        type: 'invalid_request_error', param: `tools[${bad}].function.name`, code: 'invalid_value',
      } }));
    }
    // First round: call the site's search tool by the name it was given. Then answer with the result.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: any, finish: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const last = body.messages.at(-1);
    if (last.role === 'tool') send({ content: `Found: ${last.content}` }, 'stop');
    else {
      const search = body.tools.find((t: any) => t.function.description.startsWith('[Example site] Search'));
      send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: search.function.name, arguments: JSON.stringify({ q: 'widgets' }) } }] }, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  const modelPort = await listen(model);

  const settingsStore: Record<string, any> = {
    'ai.vllmEndpoint': `http://127.0.0.1:${modelPort}`, 'ai.vllmModel': 'mock', 'ai.geminiApiKey': 'test-key',
    'ai.onpRegistryUrl': 'http://127.0.0.1:9', // never contacted here
  };
  const settings: SettingsPort = { get: (k) => settingsStore[k], set: (k, v) => { settingsStore[k] = v; }, getMaxConnections: () => 10 };
  const mcp = new McpManager(settings);
  const web = await mcp.connectMcpWeb({
    supported: true, url: `http://127.0.0.1:${sitePort}/`, connectUrl: `http://127.0.0.1:${sitePort}/mcp`,
    serverInfo: { name: 'Example site', version: '1.0.0' },
  });
  // Ids Surge already uses that make fine names (unchanged), and ones that don't.
  const plain = (id: string, ...tools: string[]) => mcp.registerVirtualServer({
    id, name: id, tools: tools.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, serverId: id })),
    callTool: async (toolName: string) => ({ content: [{ type: 'text', text: `${id}/${toolName}` }] }),
  });
  plain('browser', 'navigateTo');
  plain('ui', 'render');
  plain('manual-1760000000000', 'echo');
  plain('github', 'create_issue');
  plain(agentServerId('shop.example.com'), 'find_products');
  plain('io.github.acme/weather', 'get_forecast');
  plain('21st-dev-magic', 'component');
  plain('a-rather-long-catalog-slug-for-a-reporting-server', 'get_the_extremely_detailed_quarterly_report');

  // The server's tool annotations survive into Surge's tool list, so approvals can tell reads apart.
  const searchTool = web.tools.find((t) => t.name === 'search');
  const docsTool = web.tools.find((t) => t.name === 'docs.read');
  check('tool annotations are kept (readOnlyHint), and drive the approval risk',
    searchTool?.annotations?.readOnlyHint === true && !docsTool?.annotations
      && toolRisk(web.id, 'search', searchTool) === 'read' && toolRisk(web.id, 'docs.read', docsTool) === 'action');

  const defs = mcp.getToolDefinitions();
  const names = defs.map((d) => d.function.name);
  const WIRE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/; // OpenAI's rule, and Gemini's (a letter or _ first, ≤ 63 in some docs)
  console.log('  tool names sent:', names.join(', '));
  const badNames = names.filter((n) => !WIRE.test(n));
  check('every tool name is one OpenAI and Gemini accept', badNames.length === 0, badNames.join(', '));
  check('tool names are unique', new Set(names).size === names.length);
  check('names that were already fine are unchanged',
    ['browser__navigateTo', 'ui__render', 'manual-1760000000000__echo', 'github__create_issue'].every((n) => names.includes(n)));

  // Every name the model is given routes back to its server and tool (the order matches getConnectedServers).
  const expected = mcp.getConnectedServers().flatMap((s) => s.tools.map((t) => ({ serverId: s.id, toolName: t.name })));
  const misrouted = defs.filter((d, i) => {
    const p = mcp.parseToolName(d.function.name);
    return p?.serverId !== expected[i].serverId || p?.toolName !== expected[i].toolName;
  });
  check('every tool name parses back to its server and tool', misrouted.length === 0, misrouted.map((d) => d.function.name).join(', '));
  const dotted = mcp.parseToolName(names.find((n) => mcp.parseToolName(n)?.toolName === 'docs.read') ?? '');
  check('a dotted MCP tool name keeps its dots for the server', dotted?.serverId === web.id && dotted?.toolName === 'docs.read');
  const raw = mcp.parseToolName(`${web.id}__search`);
  check('a raw "serverId__tool" still parses (a prompt-based model copying an id)', raw?.serverId === web.id && raw?.toolName === 'search');
  const searchName = names.find((n) => mcp.parseToolName(n)?.toolName === 'search' && mcp.parseToolName(n)?.serverId === web.id) ?? '';
  const ns = searchName.slice(0, searchName.lastIndexOf('__search'));
  check('the system prompt shows the server as it appears in tool names', mcp.getSystemPrompt().includes(`- Example site (${ns}):`), ns);

  // ── a chat turn while the MCPWeb site is connected (what ai:streamChat does) ──
  const ai = new AiService(settings);
  const toolLabels = (n: string) => {
    const p = mcp.parseToolName(n);
    return { serverId: p?.serverId, serverName: mcp.getConnectedServers().find((s) => s.id === p?.serverId)?.name, toolName: p?.toolName };
  };
  let text = '';
  let error = '';
  const labels: any[] = [];
  await runToolLoop({
    ai, model: 'vllm-custom', conversation: [{ role: 'user', content: 'find widgets on this site' }],
    toolDefs: () => mcp.getToolDefinitions(),
    executeTool: async (tc) => {
      const p = mcp.parseToolName(tc.functionName);
      if (!p) return { resultText: `Error: Unknown tool "${tc.functionName}".` };
      const r = await mcp.callTool(p.serverId, p.toolName, tc.arguments);
      return { resultText: r.content.map((c: any) => c.text).join('\n'), serverId: p.serverId };
    },
    callbacks: {
      onToken: (t) => { text += t; }, onToolCallStart: (i) => labels.push(toolLabels(i.name)), onToolCallResult: () => {},
      onEnd: () => {}, onError: (m) => { error = m; },
    },
  });
  check('a chat turn with an MCPWeb site connected succeeds', !error, error);
  check('the model\'s call reaches the site\'s tool', siteCalls.length === 1 && siteCalls[0].name === 'search' && siteCalls[0].args?.q === 'widgets', JSON.stringify(siteCalls));
  check('the answer carries the tool result', text.includes('Widget, Gadget'), JSON.stringify(text));
  check('the chat\'s tool label names the site and the bare tool',
    labels[0]?.serverId === web.id && labels[0]?.serverName === 'Example site' && labels[0]?.toolName === 'search', JSON.stringify(labels[0]));

  // ── Gemini: the same names, checked against Gemini's rule ──
  const realFetch = globalThis.fetch;
  let geminiNames: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    const body = JSON.parse(init.body);
    geminiNames = (body.tools?.[0]?.functionDeclarations ?? []).map((f: any) => f.name);
    if (geminiNames.some((n) => !/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/.test(n))) {
      return new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid function name. Must start with a letter or an underscore. Must be alphameric (a-z, A-Z, 0-9), underscores (_), dots (.), colons (:), or dashes (-), with a maximum length of 64.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'gemini ok' }] }, finishReason: 'STOP' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  let geminiText = '';
  let geminiError = '';
  try {
    await ai.streamChat([{ role: 'user', content: 'hello' }], 'gemini-flash-lite',
      { onToken: (t) => { geminiText += t; }, onEnd: () => {}, onError: (m) => { geminiError = m; } }, mcp.getToolDefinitions());
  } finally {
    globalThis.fetch = realFetch;
  }
  check('Gemini gets the same tool names and answers', !geminiError && geminiText === 'gemini ok' && geminiNames.length === names.length, geminiError);

  await mcp.disconnectMcpWeb(`http://127.0.0.1:${sitePort}/`);
  check('a disconnected site\'s tools are gone', !mcp.getToolDefinitions().some((d) => mcp.parseToolName(d.function.name)?.serverId === web.id));
  // Drop keep-alive connections and wait for the close: exiting while handles close aborts Node on Windows.
  for (const s of [site, model]) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  return pass;
}

async function main() {
  // 1) in-process bookmarks virtual server dispatches to the store
  const store = await SurgeStore.open({ path: ':memory:', deviceId: 'verify' });
  const vs = createBookmarksVirtualServer(store);
  const addObj = JSON.parse((await vs.callTool('bookmark_add', { url: 'https://x.com', title: 'X', tags: ['a'] })).content[0].text);
  const list = JSON.parse((await vs.callTool('bookmark_list', {})).content[0].text);
  store.close();

  // 2) MCP-UI detection across the supported shapes
  const uiHtml = detectUiResource([{ type: 'resource', resource: { uri: 'ui://app/x', mimeType: 'text/html', text: '<button>hi</button>' } }], 'srv');
  const uiTmpl = detectUiResource({ _meta: { 'openai/outputTemplate': 'ui://tmpl/1' }, content: [] }, 'srv');
  const uiUrl = detectUiResource([{ type: 'resource', resource: { uri: 'ui://app/y', mimeType: 'text/uri-list', text: 'https://example.com/app' } }]);
  const none = detectUiResource('just text');

  // 3) chat history: sessions with their page, messages with display meta, rename, search, delete
  const hs = await SurgeStore.open({ path: ':memory:', deviceId: 'verify' });
  const s1 = await hs.chat.createSession({ title: 'Summarize the news', model: 'onp:auto', pageUrl: 'https://example.com/' });
  await hs.chat.addMessage(s1.id, { role: 'user', content: 'summarize the news' });
  await hs.chat.addMessage(s1.id, { role: 'assistant', content: 'Here is the gist.', meta: { toolCalls: [{ id: 't1', toolName: 'getPageContent' }] } });
  const s2 = await hs.chat.createSession({ title: 'Recipes' });
  await hs.chat.addMessage(s2.id, { role: 'user', content: 'pancakes please' });
  const msgs = await hs.chat.getMessages(s1.id);
  await hs.chat.updateSession(s2.id, { title: 'Breakfast ideas' });
  const byTitle = await hs.chat.listSessions({ query: 'breakfast' });
  const byContent = await hs.chat.listSessions({ query: 'gist' });
  const wildcard = await hs.chat.listSessions({ query: '%' });
  await hs.chat.deleteSession(s1.id);
  const afterDelete = await hs.chat.listSessions();
  hs.close();
  const historyOk =
    s1.pageUrl === 'https://example.com/' &&
    msgs.length === 2 && msgs[0].role === 'user' && msgs[1].seq === 1 && (msgs[1].meta as any)?.toolCalls?.[0]?.toolName === 'getPageContent' &&
    byTitle.length === 1 && byTitle[0].title === 'Breakfast ideas' &&
    byContent.length === 1 && byContent[0].id === s1.id &&
    wildcard.length === 0 &&
    afterDelete.length === 1 && afterDelete[0].id === s2.id;

  // 4) an older surge.db (chat tables without page_url / meta) gets the columns on open
  const legacy = createClient({ url: ':memory:' });
  await legacy.execute(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1, origin_device_id TEXT)`);
  await legacy.execute(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1, origin_device_id TEXT)`);
  const migrated = await SurgeStore.open({ client: legacy, deviceId: 'verify' });
  const ms = await migrated.chat.createSession({ title: 'old db', pageUrl: 'https://a.example/' });
  await migrated.chat.addMessage(ms.id, { role: 'assistant', content: 'x', meta: { ok: true } });
  const migratedOk = ms.pageUrl === 'https://a.example/' && ((await migrated.chat.getMessages(ms.id))[0].meta as any)?.ok === true;
  migrated.close();

  // 5) saved MCP servers: one entry per server. Manual servers used to get a new id per connect, so
  //    the same URL piled up (six copies in a real settings file).
  const url = 'http://localhost:60784/mcp/';
  const settingsStore: Record<string, any> = {
    'mcp.savedServers': [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `manual-17738${n}`, name: 'localhost:60784', transport: 'streamable-http', url })),
      { id: 'filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'fs-server', '/a'] },
      { id: 'filesystem-b', name: 'Filesystem B', transport: 'stdio', command: 'npx', args: ['-y', 'fs-server', '/b'] },
      { id: 'other', name: 'Other', transport: 'sse', url: 'https://other.example/sse' },
    ],
  };
  const writes: number[] = [];
  const mm = new McpManager({ get: (k) => settingsStore[k], set: (k, v) => { settingsStore[k] = v; writes.push(1); }, getMaxConnections: () => 25 } as any);
  const savedIds = () => (settingsStore['mcp.savedServers'] as any[]).map((s) => s.id).join();
  const tidied = savedIds();
  // Saving the same URL under a new id replaces the saved one in place; a new server is appended.
  (mm as any).saveServerConfig({ id: 'manual-again', name: 'localhost:60784', transport: 'streamable-http', url });
  const afterSameUrl = savedIds();
  (mm as any).saveServerConfig({ id: 'brand-new', name: 'New', transport: 'streamable-http', url: 'http://localhost:7000/mcp' });
  const afterNew = savedIds();
  // Connecting the same URL under another id returns the live connection instead of a second one.
  const live = { id: 'manual-again', name: 'localhost:60784', status: 'connected', tools: [], config: { id: 'manual-again', name: 'x', transport: 'streamable-http', url } };
  (mm as any).connections.set('manual-again', { client: {}, transport: {}, server: live });
  const twin = await mm.connectServer({ id: 'manual-other', name: 'x', transport: 'sse', url });
  const writesBefore = writes.length;
  new McpManager({ get: (k) => settingsStore[k], set: (k, v) => { settingsStore[k] = v; writes.push(1); }, getMaxConnections: () => 25 } as any);
  const dedupeOk =
    tidied === 'manual-177386,filesystem,filesystem-b,other' &&
    afterSameUrl === 'manual-again,filesystem,filesystem-b,other' &&
    afterNew === 'manual-again,filesystem,filesystem-b,other,brand-new' &&
    twin === live && (mm as any).connections.size === 1 &&
    writes.length === writesBefore;
  if (!dedupeOk) console.log('dedupe detail:', { tidied, afterSameUrl, afterNew, twinIsLive: twin === live, extraWrites: writes.length - writesBefore });

  // 6) tool names providers accept (see verifyToolNames)
  const toolNamesOk = await verifyToolNames();

  const pass =
    historyOk && migratedOk && dedupeOk && toolNamesOk &&
    addObj.url === 'https://x.com' && addObj.tags.length === 1 &&
    list.length === 1 &&
    uiHtml?.kind === 'html' && uiHtml.uiType === 'mcp-ui' &&
    uiTmpl?.kind === 'html' && uiTmpl.uiType === 'mcp-apps' && uiTmpl.resourceUri === 'ui://tmpl/1' &&
    uiUrl?.kind === 'url' && uiUrl.url === 'https://example.com/app' &&
    none === null;

  console.log('bookmark vs:', addObj.id ? 'ok' : 'FAIL', '| list:', list.length);
  console.log('ui html:', uiHtml?.kind, '| ui tmpl:', uiTmpl?.uiType, '| ui url:', uiUrl?.url, '| none:', none);
  console.log('chat history:', historyOk ? 'ok' : 'FAIL', '| old db migrated:', migratedOk ? 'ok' : 'FAIL');
  console.log('saved MCP servers deduped (startup, same URL, live twin):', dedupeOk ? 'ok' : 'FAIL');
  console.log('provider-safe tool names:', toolNamesOk ? 'ok' : 'FAIL');
  console.log(pass ? '\n✅ CORE VERIFY PASSED' : '\n❌ CORE VERIFY FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
