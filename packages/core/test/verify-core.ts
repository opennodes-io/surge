// Quick verification of the newest core pieces (run via tsx).
import { SurgeStore, createBookmarksVirtualServer } from '@surge/core';
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

  const pass =
    addObj.url === 'https://x.com' && addObj.tags.length === 1 &&
    list.length === 1 &&
    uiHtml?.kind === 'html' && uiHtml.uiType === 'mcp-ui' &&
    uiTmpl?.kind === 'html' && uiTmpl.uiType === 'mcp-apps' && uiTmpl.resourceUri === 'ui://tmpl/1' &&
    uiUrl?.kind === 'url' && uiUrl.url === 'https://example.com/app' &&
    none === null;

  console.log('bookmark vs:', addObj.id ? 'ok' : 'FAIL', '| list:', list.length);
  console.log('ui html:', uiHtml?.kind, '| ui tmpl:', uiTmpl?.uiType, '| ui url:', uiUrl?.url, '| none:', none);
  console.log(pass ? '\n✅ CORE VERIFY PASSED' : '\n❌ CORE VERIFY FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
