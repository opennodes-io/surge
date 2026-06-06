import { app } from 'electron';
import path from 'node:path';
import { SurgeStore } from '@surge/core';

let storePromise: Promise<SurgeStore> | null = null;

/** Singleton handle to the shared local SQLite store (same file the standalone server uses). */
export function getStore(): Promise<SurgeStore> {
  if (!storePromise) {
    const dbPath = path.join(app.getPath('userData'), 'surge.db');
    storePromise = SurgeStore.open({ path: dbPath, deviceId: 'surge-desktop' });
  }
  return storePromise;
}
