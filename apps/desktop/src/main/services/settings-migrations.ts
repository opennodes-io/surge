// One-time rewrites of stored settings. Pure (no Electron, no fs) so the hermetic tests can run them.

/** Until 0.1.8 `mcp.indexUrl` defaulted to a local MCP_Index dev server, which installed users never run. */
const LEGACY_INDEX_URLS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

/** Set once the index URL has been migrated, so a later deliberate localhost:3000 is left alone. */
export const INDEX_URL_MIGRATED = 'mcp.indexUrlMigrated';

/**
 * Drops a stored legacy `mcp.indexUrl` so the current default applies, once per settings file. Any
 * other stored value is the user's own choice and stays. Returns true when `data` changed.
 */
export function migrateSettingsData(data: Record<string, any>): boolean {
  if (data[INDEX_URL_MIGRATED]) return false;
  const stored = data['mcp.indexUrl'];
  if (typeof stored === 'string' && LEGACY_INDEX_URLS.has(stored.trim().replace(/\/+$/, ''))) delete data['mcp.indexUrl'];
  data[INDEX_URL_MIGRATED] = true;
  return true;
}
