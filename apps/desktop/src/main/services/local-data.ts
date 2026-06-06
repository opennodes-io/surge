import { app, ipcMain } from 'electron';
import path from 'node:path';
import { SurgeStore, DiscoveryClient, createBookmarksVirtualServer } from '@surge/core';
import type { McpManager } from '@surge/core';
import { SettingsService } from './settings-service';

/**
 * Local-first data: opens the shared SQLite store (same file the standalone
 * surge-bookmarks-mcp server uses), registers bookmarks/history as an in-process
 * virtual MCP server, and wires bookmarks/history/discovery IPC handlers.
 */
export function registerLocalDataHandlers(mcpManager: McpManager, settings: SettingsService): void {
  const dbPath = path.join(app.getPath('userData'), 'surge.db');
  const storePromise = SurgeStore.open({ path: dbPath, deviceId: 'surge-desktop' });

  storePromise
    .then((store) => mcpManager.registerVirtualServer(createBookmarksVirtualServer(store)))
    .catch((err) => console.error('[surge] storage init failed:', err));

  const discovery = new DiscoveryClient(settings.get('mcp.indexUrl') || '');
  const refreshDiscovery = () => discovery.setBaseUrl(settings.get('mcp.indexUrl') || '');

  // ── Bookmarks ──
  ipcMain.handle('bookmarks:add', async (_e, input) => (await storePromise).bookmarks.add(input));
  ipcMain.handle('bookmarks:remove', async (_e, id) => ({ removed: await (await storePromise).bookmarks.remove(id) }));
  ipcMain.handle('bookmarks:list', async (_e, opts) => (await storePromise).bookmarks.list(opts || {}));
  ipcMain.handle('bookmarks:search', async (_e, query) => (await storePromise).bookmarks.search(query));
  ipcMain.handle('bookmarks:tag', async (_e, id, tag) => {
    await (await storePromise).bookmarks.tag(id, tag);
    return { ok: true };
  });
  ipcMain.handle('bookmarks:untag', async (_e, id, tag) => {
    await (await storePromise).bookmarks.untag(id, tag);
    return { ok: true };
  });

  // ── History ──
  ipcMain.handle('history:record', async (_e, input) => (await storePromise).history.record(input || {}));
  ipcMain.handle('history:search', async (_e, query) => (await storePromise).history.search(query));
  ipcMain.handle('history:list', async (_e, opts) => (await storePromise).history.list(opts || {}));
  ipcMain.handle('history:clear', async (_e, opts) => {
    const olderThan = opts?.olderThanDays ? Date.now() - opts.olderThanDays * 86_400_000 : undefined;
    return { cleared: await (await storePromise).history.clear({ kind: opts?.kind, olderThan }) };
  });

  // ── Discovery (MCP_Index) ──
  ipcMain.handle('discovery:list', async (_e, params) => {
    refreshDiscovery();
    return discovery.listServers(params || {});
  });
  ipcMain.handle('discovery:get', async (_e, slug) => {
    refreshDiscovery();
    return discovery.getServer(slug);
  });
  ipcMain.handle('discovery:similar', async (_e, slug) => {
    refreshDiscovery();
    return discovery.getSimilar(slug);
  });
  ipcMain.handle('discovery:categories', async () => {
    refreshDiscovery();
    return discovery.listCategories();
  });
  ipcMain.handle('discovery:stats', async () => {
    refreshDiscovery();
    return discovery.getStats();
  });
}
