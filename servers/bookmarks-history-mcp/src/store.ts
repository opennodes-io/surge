import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { SurgeStore } from '@surge/core/storage';

/** Mirror Electron's app.getPath('userData') so this server shares Surge's DB by default. */
function userDataDir(appName = 'Surge'): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

/** DB path precedence: --db <path>  >  SURGE_DB_PATH env  >  default userData/surge.db */
export function resolveDbPath(): string {
  const argIdx = process.argv.indexOf('--db');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.SURGE_DB_PATH) return process.env.SURGE_DB_PATH;
  return path.join(userDataDir(), 'surge.db');
}

export async function openStore(): Promise<SurgeStore> {
  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') {
    await mkdir(path.dirname(dbPath), { recursive: true });
  }
  return SurgeStore.open({ path: dbPath, deviceId: 'surge-bookmarks-mcp' });
}
