import { app, ipcMain, type BaseWindow, type WebContents } from 'electron';
import type { McpManager } from '@surge/core';
import { SurgeHub, type HubAnswer } from './surge-hub';
import { getStore } from './store';
import type { SettingsService } from './settings-service';
import type { SecretStore } from './secret-store';

// No answer in 5 minutes counts as no; most apps give up sooner, and then the card goes away.
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

// Cards waiting for an answer, by request id.
const pending = new Map<string, (allow: boolean) => void>();

/** Whether a hub card is waiting: the window then keeps its expanded size (main.ts ignores "compact"). */
export const hubApprovalsWaiting = (): boolean => pending.size > 0;

export interface HubUi {
  /** The open page's origin, for the site an action acts on. */
  pageOrigin: () => string | null;
  /** The window and the app UI's contents, where the card is drawn. */
  appUi: () => { window: BaseWindow | null; contents: WebContents | null };
}

/** Creates the hub, starts it if enabled, and wires its IPC (Settings → Advanced → Surge hub, the cards). */
export function registerHubHandlers(mcp: McpManager, settings: SettingsService, secrets: SecretStore, ui: HubUi): SurgeHub {
  const hub = new SurgeHub(mcp, settings, secrets, {
    version: app.getVersion(),
    pageOrigin: ui.pageOrigin,
    // The same Allow / Deny card as the chat, drawn over whatever the window shows.
    ask: (req, signal) => new Promise<HubAnswer>((resolve) => {
      const { window, contents } = ui.appUi();
      if (!contents || contents.isDestroyed()) return resolve('no-answer');
      let settled = false;
      const done = (answer: HubAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
        contents.removeListener('destroyed', unanswered);
        pending.delete(req.id);
        if (!contents.isDestroyed()) contents.send('hub:approvalDone', req.id);
        resolve(answer);
      };
      const cancelled = () => done('cancelled');
      const unanswered = () => done('no-answer');
      const timer = setTimeout(unanswered, APPROVAL_TIMEOUT_MS);
      if (signal.aborted) return done('cancelled');
      signal.addEventListener('abort', cancelled, { once: true });
      contents.once('destroyed', unanswered);
      pending.set(req.id, (allow) => done(allow ? 'allow' : 'deny'));
      // The card needs the window: bring it back from the tray or the taskbar.
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
      }
      const server = mcp.getConnectedServers().find((s) => s.id === req.serverId);
      contents.send('hub:approval', {
        id: req.id, name: `${req.serverId}__${req.toolName}`, serverId: req.serverId, serverName: server?.name ?? req.serverId,
        toolName: req.toolName, status: 'approval', args: req.args,
        approval: { risk: req.risk, scope: req.scope.label, remembers: req.remembers },
      });
    }),
    log: (entry) => {
      getStore()
        .then((store) => store.hubCalls.record(entry))
        .catch((err) => console.error('[hub] could not log the call:', err?.message ?? err));
    },
  });
  hub.apply().catch((err) => console.error('[surge] hub failed to start:', err));
  app.on('before-quit', () => { hub.stop().catch(() => {}); });

  ipcMain.handle('hub:status', () => hub.status());
  ipcMain.handle('hub:configure', async (_e, cfg: { enabled?: boolean; port?: number; allowActions?: boolean }) => {
    if (cfg.enabled !== undefined) settings.set('hub.enabled', !!cfg.enabled);
    if (cfg.allowActions !== undefined) {
      if (!!cfg.allowActions !== !!settings.get('hub.allowActions')) hub.forgetApprovals();
      settings.set('hub.allowActions', !!cfg.allowActions);
    }
    if (cfg.port !== undefined) {
      const port = Math.trunc(Number(cfg.port));
      if (port >= 1024 && port <= 65535) settings.set('hub.port', port);
    }
    // Enabling, disabling or a new port restarts; tool visibility is read per request.
    if (cfg.enabled !== undefined || cfg.port !== undefined) return hub.apply();
    return hub.status();
  });
  ipcMain.handle('hub:token', () => hub.token());
  ipcMain.handle('hub:regenerateToken', () => hub.regenerateToken());
  // The user's answer on a hub card.
  ipcMain.handle('hub:approve', (_e, id: string, allow: boolean) => {
    const answer = pending.get(id);
    answer?.(allow === true);
    return !!answer;
  });
  ipcMain.handle('hub:calls', async (_e, limit?: number) => {
    const store = await getStore();
    return store.hubCalls.list({ limit: Math.min(Math.max(Number(limit) || 30, 1), 200) });
  });
  return hub;
}
