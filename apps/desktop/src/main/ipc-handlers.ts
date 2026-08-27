import { ipcMain, shell, type WebContentsView } from 'electron';
import {
  AiService,
  McpManager,
  SearchService,
  McpWebDetector,
  runToolLoop,
  toolDefsToMcpTools,
  type PendingToolCall,
  type ToolExecutionResult,
} from '@surge/core';
import { SettingsService } from './services/settings-service';
import { BrowserService } from './services/browser-service';
import { registerLocalDataHandlers } from './services/local-data';
import { registerAgentHandlers } from './services/agents';
import { ElectronBrowserPort } from './services/electron-browser-port';

let aiService: AiService;
let mcpManager: McpManager;
let searchService: SearchService;
let mcpWebDetector: McpWebDetector;
let settingsService: SettingsService;
let browserService: BrowserService;

const MAX_TOOL_CALL_ROUNDS = 10;

export function registerIpcHandlers(getBrowserView: () => WebContentsView | null): void {
  settingsService = new SettingsService();
  aiService = new AiService(settingsService);
  mcpManager = new McpManager(settingsService);
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

  // ── Local-first data: storage, bookmarks/history IPC + virtual server, discovery ──
  registerLocalDataHandlers(mcpManager, settingsService);

  // ── Agentic per-site agents (generate → approve → persist → virtual server) ──
  const browserPort = new ElectronBrowserPort(getBrowserView);
  registerAgentHandlers(mcpManager, aiService, browserService, browserPort, settingsService);

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
      const toolDefs = mcpManager.getToolDefinitions();
      const mcpSystemPrompt = mcpManager.getSystemPrompt();
      const browserContext = await browserService.getContextPrompt();

      let systemPrompt = mcpSystemPrompt;
      if (browserContext) {
        systemPrompt =
          (systemPrompt || 'You are Surge, an AI assistant in the Surge MCP Browser.\n') + browserContext;
      }

      const conversation = messages.map((m: any) => ({ role: m.role, content: m.content }));

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
          onToolCallStart: (i) =>
            sender.send('mcp:toolCall', { id: i.id, name: i.name, status: 'running', args: i.args }),
          onToolCallResult: (i) =>
            sender.send('mcp:toolCall', {
              id: i.id,
              name: i.name,
              serverId: i.serverId,
              status: i.status,
              result: i.result,
              durationMs: i.durationMs,
              args: i.args,
            }),
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
  ipcMain.handle('mcp:connect', async (_event, config: any) => {
    try {
      const server = await mcpManager.connectServer(config);
      return { success: true, server };
    } catch (err: any) {
      return { error: err.message };
    }
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
  ipcMain.handle('settings:get', async (_event, key: string) => settingsService.get(key));

  ipcMain.handle('settings:set', async (_event, key: string, value: any) => {
    settingsService.set(key, value);
    if (key.startsWith('ai.') || key.startsWith('models.')) {
      aiService.refreshConfig();
    }
    return { success: true };
  });

  ipcMain.handle('settings:getTier', async () => settingsService.getTier());
}
