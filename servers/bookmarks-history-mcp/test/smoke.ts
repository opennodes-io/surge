/**
 * End-to-end smoke test: spawn the built stdio server against a temp DB and drive
 * it through a real MCP client. Run: pnpm --filter @surge/bookmarks-history-mcp exec tsx test/smoke.ts
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'stdio.js');
const tmpDb = path.join(os.tmpdir(), `surge-smoke-${Date.now()}.db`);

function textOf(res: any): string {
  return (res?.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: [serverEntry, '--db', tmpDb] });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`);

  const added = await client.callTool({
    name: 'bookmark_add',
    arguments: { url: 'https://example.com', title: 'Example Site', kind: 'web', tags: ['demo', 'test'] },
  });
  const bm = JSON.parse(textOf(added));
  console.log(`added bookmark id=${bm.id} tags=${JSON.stringify(bm.tags)}`);

  await client.callTool({ name: 'bookmark_add', arguments: { url: 'https://modelcontextprotocol.io', title: 'MCP', kind: 'web' } });

  const listed = JSON.parse(textOf(await client.callTool({ name: 'bookmark_list', arguments: {} })));
  console.log(`bookmark_list -> ${listed.items.length} items`);

  const searched = JSON.parse(textOf(await client.callTool({ name: 'bookmark_search', arguments: { query: 'example' } })));
  console.log(`bookmark_search "example" -> ${searched.items.length} item(s): ${searched.items.map((b: any) => b.title).join(', ')}`);

  await client.callTool({ name: 'history_record', arguments: { url: 'https://example.com', title: 'Example Site', kind: 'web' } });
  await client.callTool({ name: 'history_record', arguments: { targetRef: 'filesystem', kind: 'mcp-server-connect', title: 'Connected filesystem' } });
  const hist = JSON.parse(textOf(await client.callTool({ name: 'history_list', arguments: {} })));
  console.log(`history_list -> ${hist.items.length} entries: ${hist.items.map((h: any) => h.kind).join(', ')}`);

  const res = await client.readResource({ uri: 'history://recent' });
  const recent = JSON.parse((res.contents[0] as any).text);
  console.log(`resource history://recent -> ${recent.length} entries`);

  await client.close();

  const pass =
    tools.tools.length >= 13 &&
    listed.items.length === 2 &&
    searched.items.length === 1 &&
    hist.items.length === 2 &&
    bm.tags.length === 2;
  console.log(pass ? '\n✅ SMOKE TEST PASSED' : '\n❌ SMOKE TEST FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test error:', err);
  process.exit(1);
});
