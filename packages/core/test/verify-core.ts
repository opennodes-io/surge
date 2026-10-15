// Quick verification of the newest core pieces (run via tsx).
import { createClient } from '@libsql/client';
import { SurgeStore, createBookmarksVirtualServer } from '@surge/core';
import { McpManager } from '@surge/core/mcp';
import { detectUiResource } from '@surge/core/ui';

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

  const pass =
    historyOk && migratedOk && dedupeOk &&
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
  console.log(pass ? '\n✅ CORE VERIFY PASSED' : '\n❌ CORE VERIFY FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
