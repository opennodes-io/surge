import { ipcMain, shell, type WebContentsView } from 'electron';
import { AiService, type PendingToolCall, type ChatMessageWithTools } from './services/ai-service';
import { McpManager, type ToolDefinition } from './services/mcp-manager';
import { SearchService } from './services/search-service';
import { McpWebDetector } from './services/mcpweb-detector';
import { SettingsService } from './services/settings-service';
import { BrowserService } from './services/browser-service';

let aiService: AiService;
let mcpManager: McpManager;
let searchService: SearchService;
let mcpWebDetector: McpWebDetector;
let settingsService: SettingsService;
let browserService: BrowserService;

const MAX_TOOL_CALL_ROUNDS = 10; // Prevent infinite loops

export function registerIpcHandlers(
  getBrowserView: () => WebContentsView | null
): void {
  settingsService = new SettingsService();
  aiService = new AiService(settingsService);
  mcpManager = new McpManager(settingsService);
  searchService = new SearchService(mcpManager);
  mcpWebDetector = new McpWebDetector();
  browserService = new BrowserService(getBrowserView);

  // ── AI Handlers ────────────────────────────────────────
  ipcMain.handle('ai:chat', async (event, messages: any[], model: string) => {
    try {
      return await aiService.chat(messages, model);
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:getModels', async () => {
    return aiService.getAvailableModels();
  });

  // ── AI Streaming with Multi-Step Tool Orchestration ────
  // The AI now has access to:
  //   1. All connected MCP server tools (including MCPWeb sites)
  //   2. Browser interaction tools (read page, click, fill, navigate, etc.)
  ipcMain.handle('ai:streamChat', async (event, messages: any[], model: string) => {
    try {
      const sender = event.sender;

      // ── Build merged tool definitions ──
      // MCP tools (from connected servers + MCPWeb sites)
      const mcpToolDefs = mcpManager.getToolDefinitions();
      // Browser tools (read/interact with the embedded web page)
      const browserToolDefs = browserService.getToolDefinitions();
      // Merge all
      const allToolDefs: ToolDefinition[] = [...mcpToolDefs, ...browserToolDefs];
      const hasTools = allToolDefs.length > 0;

      // ── Build system prompt with full context ──
      const mcpSystemPrompt = mcpManager.getSystemPrompt();
      const browserContext = await browserService.getContextPrompt();

      let systemPrompt = mcpSystemPrompt;
      if (browserContext) {
        systemPrompt = (systemPrompt || 'You are Surge, an AI assistant in the Surge MCPWeb Browser.\n') + browserContext;
      }

      // Track the full conversation for multi-step tool calling
      const conversation: ChatMessageWithTools[] = messages.map((m: any) => ({
        role: m.role,
        content: m.content,
      }));

      let round = 0;

      // ── Tool Execution Router ──
      // Routes tool calls to either MCP servers or browser service
      const executeTool = async (tc: PendingToolCall): Promise<{ resultText: string; rawContent?: any[]; serverId?: string }> => {
        const name = tc.functionName;

        // Browser tools: prefixed with "browser__"
        if (name.startsWith('browser__')) {
          const browserToolName = name.replace('browser__', '');
          const resultText = await browserService.executeTool(browserToolName, tc.arguments);
          return { resultText, serverId: 'browser' };
        }

        // MCP tools: namespaced as "serverId__toolName"
        const parsed = mcpManager.parseToolName(name);
        if (parsed) {
          const result = await mcpManager.callTool(parsed.serverId, parsed.toolName, tc.arguments);
          // Preserve the full content array for rich rendering (images, tables, etc.)
          const contentArray = result.content || [];
          // Build text-only version for the AI conversation
          const resultText = contentArray
            .map((c: any) => c.text || (c.type === 'image' ? '[image]' : JSON.stringify(c)))
            .join('\n') || 'No output';
          return { resultText, rawContent: contentArray, serverId: parsed.serverId };
        }

        return {
          resultText: `Error: Unknown tool "${name}". Available: ${allToolDefs.map(t => t.function.name).join(', ')}`,
        };
      };

      let streamEndSent = false;

      const runStream = (): Promise<void> => {
        return new Promise((resolve, reject) => {
          aiService.streamChat(
            conversation,
            model,
            {
              onToken: (token: string) => sender.send('ai:token', token),

              onToolCall: async (toolCalls: PendingToolCall[]) => {
                round++;
                if (round > MAX_TOOL_CALL_ROUNDS) {
                  sender.send('ai:token', '\n\n*Reached maximum tool call depth. Stopping.*');
                  if (!streamEndSent) {
                    streamEndSent = true;
                    sender.send('ai:streamEnd');
                  }
                  resolve();
                  return;
                }

                // Add assistant message with tool_calls to conversation
                conversation.push({
                  role: 'assistant',
                  content: '',
                  tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                      name: tc.functionName,
                      arguments: JSON.stringify(tc.arguments),
                    },
                  })),
                });

                // Execute each tool call
                for (const tc of toolCalls) {
                  // Notify renderer: running
                  sender.send('mcp:toolCall', {
                    id: tc.id,
                    name: tc.functionName,
                    status: 'running',
                    args: tc.arguments,
                  });

                  let resultText: string;
                  let serverId: string | undefined;
                  let rawContent: any[] | undefined;

                  try {
                    const result = await executeTool(tc);
                    resultText = result.resultText;
                    serverId = result.serverId;
                    rawContent = result.rawContent;

                    sender.send('mcp:toolCall', {
                      id: tc.id,
                      name: tc.functionName,
                      serverId: serverId || 'unknown',
                      status: 'success',
                      // Send raw content array for rich rendering (images, tables)
                      result: rawContent && rawContent.length > 0 ? rawContent : resultText,
                      durationMs: 0,
                      args: tc.arguments,
                    });
                  } catch (err: any) {
                    resultText = `Error: ${err.message}`;
                    sender.send('mcp:toolCall', {
                      id: tc.id,
                      name: tc.functionName,
                      status: 'error',
                      result: resultText,
                      args: tc.arguments,
                    });
                  }

                  // Add tool result to conversation
                  conversation.push({
                    role: 'tool',
                    content: resultText,
                    tool_call_id: tc.id,
                    name: tc.functionName,
                  });
                }

                // Continue the conversation — AI will process tool results
                try {
                  await runStream();
                  resolve();
                } catch (err) {
                  reject(err);
                }
              },

              onEnd: () => {
                resolve(); // Don't send streamEnd here — sent once after full orchestration
              },

              onError: (err: string) => {
                if (!streamEndSent) {
                  streamEndSent = true;
                  sender.send('ai:streamError', err);
                }
                resolve();
              },
            },
            hasTools ? allToolDefs : undefined,
            systemPrompt || undefined
          );
        });
      };

      await runStream();
      // Send streamEnd exactly once after all rounds complete
      if (!streamEndSent) {
        streamEndSent = true;
        sender.send('ai:streamEnd');
      }
      return { success: true };
    } catch (err: any) {
      if (!streamEndSent) {
        streamEndSent = true;
        event.sender.send('ai:streamError', err.message);
      }
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

  ipcMain.handle('mcp:getServers', async () => {
    return mcpManager.getConnectedServers();
  });

  ipcMain.handle('mcp:getTools', async (_event, serverId?: string) => {
    return mcpManager.getTools(serverId);
  });

  ipcMain.handle('mcp:callTool', async (_event, serverId: string, toolName: string, args: any) => {
    try {
      return await mcpManager.callTool(serverId, toolName, args);
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle('mcp:discover', async (_event, query: string) => {
    return mcpManager.discoverServers(query);
  });

  // ── MCPWeb Handlers ────────────────────────────────────
  ipcMain.handle('mcpweb:detect', async (_event, url: string) => {
    try {
      return await mcpWebDetector.detect(url);
    } catch (err: any) {
      return { supported: false, error: err.message };
    }
  });

  // MCPWeb auto-connect: detect + connect in one call
  ipcMain.handle('mcpweb:connect', async (_event, url: string) => {
    try {
      const caps = await mcpWebDetector.detect(url);
      if (!caps.supported) {
        return { success: false, error: 'Site does not support MCPWeb' };
      }
      const server = await mcpManager.connectMcpWeb(caps);
      return {
        success: true,
        serverId: server.id,
        serverName: server.name,
        tools: server.tools,
        capabilities: caps,
      };
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

  // MCP-B detection: check if current browser page has navigator.modelContext tools
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
  ipcMain.handle('settings:get', async (_event, key: string) => {
    return settingsService.get(key);
  });

  ipcMain.handle('settings:set', async (_event, key: string, value: any) => {
    settingsService.set(key, value);
    if (key.startsWith('ai.') || key.startsWith('models.')) {
      aiService.refreshConfig();
    }
    return { success: true };
  });

  ipcMain.handle('settings:getTier', async () => {
    return settingsService.getTier();
  });
}
