import type { VirtualServer, McpTool } from './mcp-manager.js';
import type { SurgeStore } from '../storage/index.js';

function tool(name: string, description: string, properties: Record<string, any>, required: string[] = []): McpTool {
  return { name, description, serverId: 'bookmarks', inputSchema: { type: 'object', properties, required } };
}

function asText(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Expose the local bookmarks/history store as an in-process virtual MCP server so the
 * AI can save/recall bookmarks and history with the same `serverId__tool` surface as
 * any other server (no subprocess). Mirrors a subset of the standalone server's tools.
 */
export function createBookmarksVirtualServer(store: SurgeStore): VirtualServer {
  const tools: McpTool[] = [
    tool('bookmark_add', 'Save a bookmark (kind: web|mcp-server|mcpweb|chat).', {
      url: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string' },
      targetRef: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    }, ['url']),
    tool('bookmark_list', 'List saved bookmarks.', { kind: { type: 'string' }, limit: { type: 'number' } }),
    tool('bookmark_search', 'Search bookmarks by title/url/description.', { query: { type: 'string' } }, ['query']),
    tool('history_record', 'Record a history entry.', { url: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' }, targetRef: { type: 'string' } }),
    tool('history_search', 'Search history by title/url.', { query: { type: 'string' } }, ['query']),
    tool('history_list', 'List recent history entries.', { kind: { type: 'string' }, limit: { type: 'number' } }),
  ];

  return {
    id: 'bookmarks',
    name: 'Bookmarks & History',
    source: 'in-process',
    tools,
    callTool: async (toolName: string, args: any) => {
      const a = args || {};
      switch (toolName) {
        case 'bookmark_add':
          return asText(await store.bookmarks.add(a));
        case 'bookmark_list':
          return asText(await store.bookmarks.list(a));
        case 'bookmark_search':
          return asText(await store.bookmarks.search(a.query, { limit: a.limit }));
        case 'history_record':
          return asText(await store.history.record(a));
        case 'history_search':
          return asText(await store.history.search(a.query, { limit: a.limit }));
        case 'history_list':
          return asText(await store.history.list(a));
        default:
          return { content: [{ type: 'text', text: `Unknown tool ${toolName}` }], isError: true };
      }
    },
  };
}
