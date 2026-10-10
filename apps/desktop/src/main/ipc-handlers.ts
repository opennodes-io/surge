import { app, ipcMain, shell, type WebContentsView, clipboard } from 'electron';
import {
  AiService,
  McpManager,
  SearchService,
  McpWebDetector,
  runToolLoop,
  toolDefsToMcpTools,
  LIVE_UI_TOOL,
  liveUiToolResult,
  shouldOfferLiveUi,
  parsePartialJson,
  type PendingToolCall,
  type ToolExecutionResult,
} from '@surge/core';
import { SettingsService, SECRET_SETTINGS } from './services/settings-service';
import { SecretStore } from './services/secret-store';
import { getStore } from './services/store';
import { startPrivateRouter, stopPrivateRouter, privateRouterStatus } from './services/private-router';
import { BrowserService } from './services/browser-service';
import { registerLocalDataHandlers } from './services/local-data';
import { registerAgentHandlers } from './services/agents';
import { registerHubHandlers } from './services/surge-hub';
import { McpOAuth } from './services/mcp-oauth';
import { registerChannelHandlers } from './services/channels';
import { ElectronBrowserPort } from './services/electron-browser-port';

let aiService: AiService;
let mcpManager: McpManager;
let searchService: SearchService;
let mcpWebDetector: McpWebDetector;
let settingsService: SettingsService;
let browserService: BrowserService;

const MAX_TOOL_CALL_ROUNDS = 10;

export function registerIpcHandlers(getBrowserView: () => WebContentsView | null): void {
  const secretStore = new SecretStore();
  settingsService = new SettingsService(secretStore);
  aiService = new AiService(settingsService, secretStore);
  // Spend ledger: every settled OpenNodes call is persisted for the dashboard (best effort).
  aiService.onOnpCallSettled((call) => {
    getStore()
      .then((store) => store.onpCalls.record({
        at: call.at, offering: call.offering, nodeId: call.nodeId, modelName: call.modelName, tier: call.tier,
        price: call.price, cardRevision: call.cardRevision, receipt: call.receipt, receiptId: call.receiptId ?? null,
        reason: call.reason ?? null, promptTokens: call.usage?.promptTokens ?? null, completionTokens: call.usage?.completionTokens ?? null,
        amount: call.amount ?? null, countedUsd: call.countedUsd, durationMs: call.durationMs, advisor: call.advisor ?? null,
      }))
      .catch((err) => console.error('[onp] could not record the call:', err?.message ?? err));
  });
  mcpManager = new McpManager(settingsService);
  // OAuth sign-in for remote MCP servers ("Connect my accounts"): system browser + loopback callback.
  const mcpOAuth = new McpOAuth(secretStore, settingsService);
  mcpManager.setAuthHandler(mcpOAuth);
  searchService = new SearchService(mcpManager);
  mcpWebDetector = new McpWebDetector();
  browserService = new BrowserService(getBrowserView);

  // ── Web->MCP: register the embedded browser's page tools as a virtual MCP server ──
  // Browser tools now appear, are namespaced (browser__*) and routed exactly like a real
  // server, replacing the previous hard-coded special case in the tool router.
  mcpManager.registerVirtualServer({
    id: 'browser',
    name: 'Browser (page tools)',
    source: 'ephemeral-browser',
    tools: toolDefsToMcpTools('browser', browserService.getToolDefinitions(), 'browser__'),
    callTool: (toolName: string, args: any) => browserService.executeTool(toolName, args),
  });

  // ── Live UI: interactive answers the model composes with ui__render; the renderer draws them ──
  mcpManager.registerVirtualServer({
    id: 'ui',
    name: 'Live UI',
    source: 'in-process',
    tools: [{ ...LIVE_UI_TOOL, serverId: 'ui' }],
    callTool: async (_toolName: string, args: any) => liveUiToolResult(args),
  });

  // ── Local-first data: storage, bookmarks/history IPC + virtual server, discovery ──
  registerLocalDataHandlers(mcpManager, settingsService);

  // ── Agentic per-site agents (generate → approve → persist → virtual server) ──
  const browserPort = new ElectronBrowserPort(getBrowserView);
  registerAgentHandlers(mcpManager, aiService, browserService, browserPort, settingsService);

  // ── Social channels: feeds read in the embedded browser with the user's own sign-in ──
  registerChannelHandlers();

  // ── Surge hub: a local MCP server other AI apps can use (off by default) ──
  registerHubHandlers(mcpManager, settingsService, secretStore);

  // Copy text for the renderer (its sandbox has no reliable clipboard access).
  ipcMain.handle('clipboard:writeText', (_e, text: string) => { clipboard.writeText(String(text ?? '')); return true; });

  // What the chat's tool-call block shows: the server and the bare tool name from "server__tool".
  const toolLabels = (namespaced: string) => {
    const parsed = mcpManager.parseToolName(namespaced);
    const server = parsed && mcpManager.getConnectedServers().find((s) => s.id === parsed.serverId);
    return { serverId: parsed?.serverId ?? 'unknown', serverName: server?.name ?? parsed?.serverId, toolName: parsed?.toolName ?? namespaced };
  };

  // ── Tool execution router (uniform over real + virtual + MCPWeb servers) ──
  const executeTool = async (tc: PendingToolCall): Promise<ToolExecutionResult> => {
    const parsed = mcpManager.parseToolName(tc.functionName);
    if (!parsed) {
      return { resultText: `Error: Unknown tool "${tc.functionName}".` };
    }
    const result = await mcpManager.callTool(parsed.serverId, parsed.toolName, tc.arguments);
    const contentArray = result.content || [];
    const resultText =
      contentArray
        .map((c: any) => c.text || (c.type === 'image' ? '[image]' : JSON.stringify(c)))
        .join('\n') || 'No output';
    return { resultText, rawContent: contentArray, serverId: parsed.serverId };
  };

  // ── AI Handlers ────────────────────────────────────────
  ipcMain.handle('ai:chat', async (_event, messages: any[], model: string) => {
    try {
      return await aiService.chat(messages, model);
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:getModels', async () => aiService.listModels());

  // ── AI Streaming with multi-round tool orchestration (core/orchestrator) ──
  ipcMain.handle('ai:streamChat', async (event, messages: any[], model: string) => {
    const sender = event.sender;
    try {
      // Page tools need a page. Without one, the browser server offers only navigateTo, so the turn
      // doesn't carry ~20 schemas it can't use. Re-read every round: after navigateTo opens a page,
      // the rest of the turn gets the page tools.
      // Live UI (ui__render): `ui.liveUi` is false (off), 'always', or anything else ("When it helps":
      // only turns that look like a comparison, plan, data or calculation question, or that follow a
      // view, carry the tool's ~900 prompt tokens). Never offered to Ollama Local's default llama3.2
      // (3B): asked for a comparison, it wrote broken JSON instead of an answer.
      const liveUiMode = settingsService.get('ui.liveUi');
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
      const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
      const followsView = !!lastAssistant?.toolCalls?.some((t: any) => t.serverId === 'ui' && t.status === 'success');
      const liveUi = liveUiMode !== false && model !== 'ollama-local'
        && (liveUiMode === 'always' || shouldOfferLiveUi(String(lastUser?.content ?? ''), followsView));
      const toolDefs = () => {
        const pageOpen = browserService.hasPage();
        return mcpManager.getToolDefinitions((serverId, toolName) =>
          (pageOpen || serverId !== 'browser' || toolName === 'navigateTo') && (liveUi || serverId !== 'ui'));
      };
      const mcpSystemPrompt = mcpManager.getSystemPrompt();
      const browserContext = await browserService.getContextPrompt();

      let systemPrompt = mcpSystemPrompt;
      if (browserContext) {
        systemPrompt =
          (systemPrompt || 'You are Surge, an AI assistant in the Surge MCP Browser.\n') + browserContext;
      }

      const conversation = messages.map((m: any) => ({ role: m.role, content: m.content }));

      // A view is drawn while the model writes it: ui__render's arguments so far, parsed as far as
      // they go, at most every 120 ms. Sent synchronously, so none can land after the call starts.
      const previewSentAt = new Map<string, number>();
      const previewView = (d: { id: string; name: string; argsText: string }) => {
        if (d.name !== 'ui__render') return;
        const now = Date.now();
        if (now - (previewSentAt.get(d.id) ?? 0) < 120) return;
        const args = parsePartialJson(d.argsText);
        if (!args || typeof args !== 'object') return;
        previewSentAt.set(d.id, now);
        sender.send('mcp:toolCall', { id: d.id, name: d.name, ...toolLabels(d.name), status: 'pending', args });
      };

      await runToolLoop({
        ai: aiService,
        model,
        conversation,
        toolDefs,
        systemPrompt: systemPrompt || undefined,
        executeTool,
        maxRounds: MAX_TOOL_CALL_ROUNDS,
        callbacks: {
          onToken: (token) => sender.send('ai:token', token),
          onToolCallDelta: previewView,
          onToolCallStart: (i) =>
            sender.send('mcp:toolCall', { id: i.id, name: i.name, ...toolLabels(i.name), status: 'running', args: i.args }),
          onToolCallResult: (i) =>
            sender.send('mcp:toolCall', {
              id: i.id,
              name: i.name,
              ...toolLabels(i.name),
              status: i.status,
              result: i.result,
              durationMs: i.durationMs,
              args: i.args,
            }),
          onOnpCall: (call) => sender.send('ai:onpCall', call),
          onEnd: () => sender.send('ai:streamEnd'),
          onError: (msg) => sender.send('ai:streamError', msg),
        },
      });
      return { success: true };
    } catch (err: any) {
      sender.send('ai:streamError', err.message);
      return { error: err.message };
    }
  });

  // ── MCP Handlers ───────────────────────────────────────
  ipcMain.handle('mcp:connect', async (event, config: any) => {
    // Sign-in progress (if the server needs OAuth) goes to the window that asked.
    mcpOAuth.onStatus = (status) => { if (!event.sender.isDestroyed()) event.sender.send('mcp:authStatus', status); };
    try {
      const server = await mcpManager.connectServer(config);
      return { success: true, server };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('mcp:cancelSignIn', (_event, serverId: string) => { mcpOAuth.cancel(serverId); return true; });

  // Sign out: forget the server's OAuth tokens and registration, and disconnect it.
  ipcMain.handle('mcp:signOut', async (_event, serverId: string) => {
    const server = mcpManager.getConnectedServers().find((s) => s.id === serverId);
    if (server) mcpOAuth.forget(server.config);
    await mcpManager.disconnectServer(serverId);
    return { success: true };
  });

  ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
    try {
      await mcpManager.disconnectServer(serverId);
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('mcp:getServers', async () => mcpManager.getConnectedServers());

  ipcMain.handle('mcp:getTools', async (_event, serverId?: string) => mcpManager.getTools(serverId));

  ipcMain.handle('mcp:callTool', async (_event, serverId: string, toolName: string, args: any) => {
    try {
      return await mcpManager.callTool(serverId, toolName, args);
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('mcp:readResource', async (_event, serverId: string, uri: string) => {
    try {
      return await mcpManager.readResource(serverId, uri);
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('mcp:discover', async (_event, query: string) => mcpManager.discoverServers(query));

  // ── MCPWeb Handlers ────────────────────────────────────
  ipcMain.handle('mcpweb:detect', async (_event, url: string) => {
    try {
      return await mcpWebDetector.detect(url);
    } catch (err: any) {
      return { supported: false, error: err.message };
    }
  });

  ipcMain.handle('mcpweb:connect', async (_event, url: string) => {
    try {
      const caps = await mcpWebDetector.detect(url);
      if (!caps.supported) {
        return { success: false, error: 'Site does not support MCPWeb' };
      }
      const server = await mcpManager.connectMcpWeb(caps);
      return { success: true, serverId: server.id, serverName: server.name, tools: server.tools, capabilities: caps };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('mcpweb:disconnect', async (_event, serverId: string) => {
    try {
      await mcpManager.disconnectServer(serverId);
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // ── Browser Handlers ───────────────────────────────────
  ipcMain.on('browser:openExternal', (_event, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.handle('browser:detectMcpB', async () => {
    try {
      const result = await browserService.executeTool('detectMcpBTools', {});
      return JSON.parse(result);
    } catch (err: any) {
      return { supported: false, message: err.message };
    }
  });

  // ── Search Handlers ────────────────────────────────────
  ipcMain.handle('search:web', async (_event, query: string) => {
    try {
      return await searchService.search(query);
    } catch (err: any) {
      return { error: err.message, results: [] };
    }
  });

  // ── Settings Handlers ──────────────────────────────────
  // API keys are write-only from the renderer: it can save or remove them, never read them back.
  ipcMain.handle('settings:get', async (_event, key: string) =>
    SECRET_SETTINGS.includes(key) ? null : settingsService.get(key));

  ipcMain.handle('settings:secrets', async () => ({
    encrypted: settingsService.secretsEncrypted(),
    saved: Object.fromEntries(SECRET_SETTINGS.map((key) => [key, settingsService.hasSecret(key)])),
  }));

  ipcMain.handle('settings:set', async (_event, key: string, value: any) => {
    settingsService.set(key, value);
    if (key.startsWith('ai.') || key.startsWith('models.')) {
      aiService.refreshConfig();
    }
    return { success: true };
  });


  // vLLM model discovery runs here so a saved key can be used without exposing it to the renderer.
  ipcMain.handle('ai:listVllmModels', async (_event, endpoint: string) => {
    let base = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base += '/v1';
    const key = settingsService.get('ai.vllmApiKey');
    try {
      const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const body: any = await res.json();
      return { models: (body.data || []).map((m: any) => m.id) };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // ── Private mode: model calls only to this machine's Ollama and LAN peers (embedded ollama-router) ──
  const privateStatus = () => ({ enabled: aiService.isPrivateMode(), ...privateRouterStatus(settingsService) });

  ipcMain.handle('private:status', async () => privateStatus());

  ipcMain.handle('private:setEnabled', async (_event, enabled: boolean) => {
    try {
      if (enabled) aiService.setPrivateRouter(await startPrivateRouter(settingsService));
      settingsService.set('private.enabled', !!enabled);
      if (!enabled) {
        aiService.setPrivateRouter(null);
        await stopPrivateRouter();
      }
      return privateStatus();
    } catch (err: any) {
      return { ...privateStatus(), error: `Could not start private mode: ${err.message}` };
    }
  });

  // Peers, mDNS and the Ollama host are read at start, so a running router restarts to apply them.
  ipcMain.handle('private:configure', async (_event, cfg: { peers?: string[]; mdns?: boolean }) => {
    if (cfg.peers) settingsService.set('private.peers', cfg.peers.map((p) => p.trim()).filter(Boolean));
    if (cfg.mdns !== undefined) settingsService.set('private.mdns', !!cfg.mdns);
    if (privateRouterStatus(settingsService).running) {
      await stopPrivateRouter();
      try {
        aiService.setPrivateRouter(await startPrivateRouter(settingsService));
      } catch (err: any) {
        aiService.setPrivateRouter(null);
        return { ...privateStatus(), error: `Could not restart private mode: ${err.message}` };
      }
    }
    return privateStatus();
  });

  // Private mode survives restarts: bring the router back if it was on.
  if (aiService.isPrivateMode()) {
    startPrivateRouter(settingsService)
      .then((origin) => aiService.setPrivateRouter(origin))
      .catch((err) => console.error('[private] router did not start:', err?.message ?? err));
  }
  app.on('will-quit', () => { stopPrivateRouter().catch(() => {}); });

  // ── OpenNodes spend dashboard ──
  ipcMain.handle('onp:spend', async () => {
    const store = await getStore();
    return {
      policy: aiService.getOnpPolicy(),
      todayUsd: aiService.getOnpSpentToday(),
      summary: await store.onpCalls.summary({ days: 14 }),
      recent: await store.onpCalls.list({ limit: 50 }),
    };
  });

  // ── OpenNodes per-host API keys (OS keychain; each key is sent only to its own host) ──
  ipcMain.handle('onpKeys:list', async () => ({
    encrypted: settingsService.secretsEncrypted(),
    hosts: await aiService.getOnpKeyHosts(),
    suggestions: aiService.getOnpKeyHostSuggestions(),
  }));

  ipcMain.handle('onpKeys:set', async (_event, host: string, key: string) => {
    try {
      await aiService.setOnpKey(host, key);
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('onpKeys:delete', async (_event, host: string) => {
    await aiService.deleteOnpKey(host);
    return { success: true };
  });
}
