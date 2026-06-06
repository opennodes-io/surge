import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SurgeStore } from '@surge/core/storage';

const bookmarkKind = z.enum(['web', 'mcp-server', 'mcpweb', 'chat']);
const historyKind = z.enum(['web', 'mcp-server-connect', 'mcpweb-visit', 'chat', 'tool-call']);

/** Wrap a JSON-serialisable value as both human-readable text and machine-readable structuredContent. */
function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: (data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data }),
  };
}

export function createServer(store: SurgeStore): McpServer {
  const server = new McpServer({
    name: 'surge-bookmarks-history',
    version: '1.0.0',
  });

  // ── Bookmarks ─────────────────────────────────────────
  server.registerTool(
    'bookmark_add',
    {
      title: 'Add bookmark',
      description: 'Save a bookmark. `kind` distinguishes plain web pages from MCP servers, MCPWeb sites, or chats; use `targetRef` for the serverId / origin / chat-session id when not a plain URL.',
      inputSchema: {
        url: z.string().describe('URL or canonical reference for the bookmark'),
        title: z.string().optional(),
        description: z.string().optional(),
        kind: bookmarkKind.optional(),
        targetRef: z.string().optional(),
        collectionId: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => ok(await store.bookmarks.add(args)),
  );

  server.registerTool(
    'bookmark_remove',
    { title: 'Remove bookmark', description: 'Soft-delete a bookmark by id.', inputSchema: { id: z.string() } },
    async ({ id }) => ok({ removed: await store.bookmarks.remove(id) }),
  );

  server.registerTool(
    'bookmark_list',
    {
      title: 'List bookmarks',
      description: 'List bookmarks, optionally filtered by collection or kind.',
      inputSchema: {
        collectionId: z.string().optional(),
        kind: bookmarkKind.optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => ok({ items: await store.bookmarks.list(args) }),
  );

  server.registerTool(
    'bookmark_search',
    {
      title: 'Search bookmarks',
      description: 'Full-text-ish search over bookmark title, url and description.',
      inputSchema: { query: z.string(), limit: z.number().int().positive().max(200).optional() },
    },
    async ({ query, limit }) => ok({ items: await store.bookmarks.search(query, { limit }) }),
  );

  server.registerTool(
    'bookmark_tag',
    { title: 'Tag bookmark', description: 'Attach a tag to a bookmark (creates the tag if needed).', inputSchema: { bookmarkId: z.string(), tag: z.string() } },
    async ({ bookmarkId, tag }) => { await store.bookmarks.tag(bookmarkId, tag); return ok({ ok: true }); },
  );

  server.registerTool(
    'bookmark_untag',
    { title: 'Untag bookmark', description: 'Remove a tag from a bookmark.', inputSchema: { bookmarkId: z.string(), tag: z.string() } },
    async ({ bookmarkId, tag }) => { await store.bookmarks.untag(bookmarkId, tag); return ok({ ok: true }); },
  );

  // ── Collections ───────────────────────────────────────
  server.registerTool(
    'collection_create',
    { title: 'Create collection', description: 'Create a bookmark folder/collection.', inputSchema: { name: z.string(), parentId: z.string().optional() } },
    async ({ name, parentId }) => ok(await store.collections.create(name, parentId ?? null)),
  );

  server.registerTool(
    'collection_list',
    { title: 'List collections', description: 'List all bookmark collections (folders).', inputSchema: {} },
    async () => ok({ items: await store.collections.list() }),
  );

  server.registerTool(
    'collection_move',
    { title: 'Move collection', description: 'Re-parent a collection (null parent = top level).', inputSchema: { id: z.string(), parentId: z.string().nullable().optional() } },
    async ({ id, parentId }) => ok({ moved: await store.collections.move(id, parentId ?? null) }),
  );

  // ── History ───────────────────────────────────────────
  server.registerTool(
    'history_record',
    {
      title: 'Record history',
      description: 'Append a history entry (a visited page, an MCP server connection, an MCPWeb visit, a chat, or a tool call).',
      inputSchema: {
        url: z.string().optional(),
        title: z.string().optional(),
        kind: historyKind.optional(),
        targetRef: z.string().optional(),
        meta: z.record(z.unknown()).optional(),
      },
    },
    async (args) => ok(await store.history.record(args)),
  );

  server.registerTool(
    'history_search',
    { title: 'Search history', description: 'Search history by title or url.', inputSchema: { query: z.string(), limit: z.number().int().positive().max(200).optional() } },
    async ({ query, limit }) => ok({ items: await store.history.search(query, { limit }) }),
  );

  server.registerTool(
    'history_list',
    {
      title: 'List history',
      description: 'List recent history entries, optionally filtered by kind.',
      inputSchema: { kind: historyKind.optional(), limit: z.number().int().positive().max(500).optional(), offset: z.number().int().nonnegative().optional() },
    },
    async (args) => ok({ items: await store.history.list(args) }),
  );

  server.registerTool(
    'history_clear',
    {
      title: 'Clear history',
      description: 'Soft-delete history. With no args clears all; or restrict by kind and/or olderThanDays.',
      inputSchema: { kind: historyKind.optional(), olderThanDays: z.number().int().positive().optional() },
    },
    async ({ kind, olderThanDays }) => {
      const olderThan = olderThanDays ? Date.now() - olderThanDays * 86_400_000 : undefined;
      return ok({ cleared: await store.history.clear({ kind, olderThan }) });
    },
  );

  // ── Resources ─────────────────────────────────────────
  server.registerResource(
    'all-bookmarks',
    'bookmarks://all',
    { title: 'All bookmarks', description: 'Every saved bookmark as JSON.', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await store.bookmarks.list({ limit: 500 }), null, 2) }],
    }),
  );

  server.registerResource(
    'recent-history',
    'history://recent',
    { title: 'Recent history', description: 'The 100 most recent history entries as JSON.', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await store.history.list({ limit: 100 }), null, 2) }],
    }),
  );

  server.registerResource(
    'collection-bookmarks',
    new ResourceTemplate('bookmarks://collection/{id}', { list: undefined }),
    { title: 'Bookmarks in a collection', description: 'Bookmarks belonging to a given collection id.', mimeType: 'application/json' },
    async (uri, { id }) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await store.bookmarks.list({ collectionId: String(id), limit: 500 }), null, 2) }],
    }),
  );

  return server;
}
