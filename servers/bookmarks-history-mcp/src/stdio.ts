import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openStore } from './store.js';
import { createServer } from './server.js';
import { resolveDbPath } from './store.js';

async function main(): Promise<void> {
  const store = await openStore();
  const server = createServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NOTE: stdout is the JSON-RPC channel for stdio servers — never log there.
  process.stderr.write(`[surge-bookmarks-mcp] connected (stdio) db=${resolveDbPath()}\n`);
}

main().catch((err) => {
  process.stderr.write(`[surge-bookmarks-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
