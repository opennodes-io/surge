import React, { useState, useCallback, useEffect } from 'react';
import SearchBar from './components/SearchBar';
import ChatPanel from './components/ChatPanel';
import ServerPanel from './components/ServerPanel';
import SettingsPanel from './components/SettingsPanel';
import WebBrowserBar from './components/WebBrowserBar';
import McpWebPanel from './components/McpWebPanel';
import { IconStar, IconBolt, IconGlobe, IconSettings, IconMinus, IconX, IconMaximize, IconRestore } from './components/Icons';
import type { AppMode, ChatMessage, AiModel, McpWebCapabilities, McpWebConnectResult, McpBDetectResult } from './types';
import type { ToolCallData } from './components/McpToolCallBlock';
import './styles/app.css';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-flash-lite');
  const [models, setModels] = useState<AiModel[]>([]);
  const [showServers, setShowServers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserUrl, setBrowserUrl] = useState('');
  const [mcpWebCaps, setMcpWebCaps] = useState<McpWebCapabilities | null>(null);
  const [showMcpWeb, setShowMcpWeb] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallData[]>([]);

  // Phase 1: MCPWeb-first state
  const [mcpWebConnected, setMcpWebConnected] = useState(false);
  const [mcpWebServerId, setMcpWebServerId] = useState<string | null>(null);
  const [mcpWebConnecting, setMcpWebConnecting] = useState(false);
  const [mcpWebTools, setMcpWebTools] = useState<any[]>([]);

  // Window maximize state
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    window.surge?.ai?.getModels?.().then(setModels).catch(() => {});
    // Load saved theme
    window.surge?.settings?.get('ui.theme').then((theme: string) => {
      if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    }).catch(() => {});
    // Listen for maximize state changes
    const unsub = window.surge?.window?.onMaximizeChanged?.((maximized: boolean) => {
      setIsMaximized(maximized);
    });
    return () => unsub?.();
  }, []);

  useEffect(() => {
    const unsub = window.surge?.mcp?.onToolCall?.((data: any) => {
      setToolCalls(prev => {
        const existing = prev.findIndex(t => t.id === data.id);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = { ...updated[existing], ...data };
          return updated;
        }
        return [...prev, data];
      });
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (mode === 'idle') {
      window.surge?.window?.resize('compact');
    } else {
      window.surge?.window?.resize('expanded');
    }
  }, [mode]);

  // ── MCPWeb-First Navigation ──────────────────────────────
  // Three-layer detection:
  //   1. Try .well-known/mcp (server-side MCPWeb) → auto-connect via MCP SDK
  //   2. If not found, load page → check navigator.modelContext (MCP-B / browser-native)
  //   3. If neither → show as conventional website with Playwright-like AI tools
  const navigateToUrl = useCallback(async (url: string) => {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    setBrowserUrl(fullUrl);
    setMode('chat');
    setMcpWebConnecting(true);
    setMcpWebConnected(false);
    setMcpWebServerId(null);
    setMcpWebTools([]);
    setMcpWebCaps(null);
    setShowMcpWeb(false);

    try {
      // ── Step 1: Probe .well-known/mcp (server-side MCPWeb) ──
      const connectResult: McpWebConnectResult = await window.surge.mcpweb.connect(fullUrl);

      if (connectResult.success && connectResult.tools && connectResult.tools.length > 0) {
        // Server-side MCPWeb detected! Show MCP tools as primary view
        setMcpWebConnected(true);
        setMcpWebServerId(connectResult.serverId || null);
        setMcpWebTools(connectResult.tools || []);
        setShowMcpWeb(true);

        const caps = await window.surge.mcpweb.detect(fullUrl);
        setMcpWebCaps(caps);

        setShowBrowser(false);
        window.surge?.browser?.hide();
        setMcpWebConnecting(false);
        return;
      }
    } catch {
      // Server-side MCPWeb not available — continue to MCP-B check
    }

    // ── Step 2: Load page and check for MCP-B (browser-native) ──
    // Load the page first so navigator.modelContext can initialize
    window.surge?.browser?.navigate(fullUrl);
    window.surge?.browser?.show();
    setShowBrowser(true);

    // Wait for page to load before checking MCP-B
    try {
      await new Promise(r => setTimeout(r, 2500));
      const mcpbResult: McpBDetectResult = await window.surge.browser.detectMcpB();

      if (mcpbResult.supported && mcpbResult.tools && mcpbResult.tools.length > 0) {
        // MCP-B detected! Show tools as action buttons alongside the browser
        const mcpbCaps: McpWebCapabilities = {
          supported: true,
          url: fullUrl,
          serverInfo: {
            name: new URL(fullUrl).hostname,
            version: '1.0',
            description: `Browser-native MCP tools (${mcpbResult.toolCount} tools via navigator.modelContext)`,
          },
          tools: mcpbResult.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.schema || undefined,
          })),
        };
        setMcpWebCaps(mcpbCaps);
        setMcpWebConnected(true);
        setMcpWebTools(mcpbResult.tools.map((t, i) => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.schema || {},
          serverId: 'mcpb-browser',
        })));
        setShowMcpWeb(true);
        setMcpWebConnecting(false);
        return;
      }
    } catch {
      // MCP-B detection failed — it's a plain website
    }

    // ── Step 3: Conventional website — AI can still interact via browser tools ──
    setMcpWebConnecting(false);
    setMcpWebConnected(false);
  }, []);

  const handleSubmit = useCallback(async (query: string) => {
    if (!query.trim() || isStreaming) return;

    // Detect URLs vs. chat queries
    const urlPattern = /^(https?:\/\/|www\.)/i;
    const domainPattern = /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/;
    if (urlPattern.test(query) || domainPattern.test(query)) {
      navigateToUrl(query);
      return;
    }

    const userMessage: ChatMessage = { role: 'user', content: query };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setMode('chat');
    setIsStreaming(true);
    setStreamContent('');
    setToolCalls([]);

    // Register listeners BEFORE starting the stream
    // Use a flag to ensure onEnd only processes once (prevents duplication from multi-round tool calls)
    let finished = false;
    let accumulatedContent = '';

    const removeToken = window.surge.ai.onStreamToken((token) => {
      accumulatedContent += token;
      setStreamContent(prev => prev + token);
    });

    const cleanup = () => {
      removeToken();
      removeEnd();
      removeError();
    };

    const removeEnd = window.surge.ai.onStreamEnd(() => {
      if (finished) return; // Prevent duplicate processing
      finished = true;
      cleanup();
      if (accumulatedContent) {
        setMessages(msgs => [...msgs, { role: 'assistant', content: accumulatedContent }]);
      }
      setStreamContent('');
      setIsStreaming(false);
    });

    const removeError = window.surge.ai.onStreamError((error) => {
      if (finished) return;
      finished = true;
      cleanup();
      setMessages(msgs => [...msgs, { role: 'assistant', content: `Error: ${error}` }]);
      setStreamContent('');
      setIsStreaming(false);
    });

    try {
      await window.surge.ai.streamChat(newMessages, selectedModel);
    } catch (err: any) {
      if (!finished) {
        finished = true;
        cleanup();
        setMessages(prev => [...prev, { role: 'assistant', content: `${err.message || 'Failed to connect'}` }]);
        setIsStreaming(false);
        setStreamContent('');
      }
    }
  }, [messages, isStreaming, selectedModel, navigateToUrl]);

  const handleNewChat = useCallback(() => {
    // Disconnect MCPWeb if connected
    if (mcpWebServerId) {
      window.surge?.mcpweb?.disconnect(mcpWebServerId).catch(() => {});
    }
    setMessages([]);
    setStreamContent('');
    setIsStreaming(false);
    setToolCalls([]);
    setShowBrowser(false);
    setShowMcpWeb(false);
    setMcpWebCaps(null);
    setMcpWebConnected(false);
    setMcpWebServerId(null);
    setMcpWebTools([]);
    setMcpWebConnecting(false);
    setBrowserUrl('');
    setMode('idle');
    window.surge?.browser?.hide();
  }, [mcpWebServerId]);

  const handleBrowserNavigate = useCallback((url: string) => {
    navigateToUrl(url);
  }, [navigateToUrl]);

  // "Open in Browser" escape hatch for MCPWeb sites
  const handleOpenInBrowser = useCallback(() => {
    if (browserUrl) {
      setShowBrowser(true);
      window.surge?.browser?.navigate(browserUrl);
      window.surge?.browser?.show();
    }
  }, [browserUrl]);

  // "Open in External Browser" for non-MCP sites
  const handleOpenExternal = useCallback(() => {
    if (browserUrl) {
      window.surge?.browser?.openExternal(browserUrl);
    }
  }, [browserUrl]);

  return (
    <div className={`app ${mode}`}>
      {/* Title bar */}
      <div className="title-bar drag-region">
        <div className="title-bar-left no-drag">
          {mode !== 'idle' && (
            <button className="btn-icon" onClick={handleNewChat} title="New Chat">
              <IconStar size={15} />
            </button>
          )}
          <button className="btn-icon" onClick={() => {
            if (mode === 'idle') {
              setMode('chat');
              window.surge?.window?.resize('expanded');
            }
            setShowServers(!showServers);
          }} title="MCP Servers">
            <IconBolt size={15} />
          </button>
          {mode !== 'idle' && (
            <button className="btn-icon" onClick={() => { setShowBrowser(!showBrowser); showBrowser ? window.surge?.browser?.hide() : window.surge?.browser?.show(); }} title="Web Browser">
              <IconGlobe size={15} />
            </button>
          )}
        </div>
        <div className="title-bar-center">
          {mode === 'idle' && <span className="title-logo text-gradient">SURGE</span>}
          {mcpWebConnecting && <span className="title-status">Probing MCPWeb...</span>}
          {mcpWebConnected && <span className="title-status mcpweb-active">&#9889; MCPWeb Connected</span>}
        </div>
        <div className="title-bar-right no-drag">
          <button className="btn-icon" onClick={() => { setShowSettings(!showSettings); if (!showSettings) setMode('settings'); }} title="Settings">
            <IconSettings size={15} />
          </button>
          <button className="btn-icon" onClick={() => window.surge?.window?.minimize()} title="Minimize">
            <IconMinus size={15} />
          </button>
          <button className="btn-icon" onClick={() => window.surge?.window?.maximize()} title={isMaximized ? "Restore" : "Maximize"}>
            {isMaximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
          </button>
          <button className="btn-icon btn-close" onClick={() => window.surge?.window?.close()} title="Close">
            <IconX size={15} />
          </button>
        </div>
      </div>

      {/* Browser bar — shown when browser visible OR when navigating to a URL */}
      {(showBrowser || browserUrl) && mode !== 'idle' && !showSettings && (
        <WebBrowserBar
          onNavigate={handleBrowserNavigate}
          currentUrl={browserUrl}
          mcpWebCapabilities={mcpWebCaps}
          mcpWebConnected={mcpWebConnected}
          onShowMcpWeb={() => setShowMcpWeb(!showMcpWeb)}
          onOpenInBrowser={handleOpenInBrowser}
          onOpenExternal={handleOpenExternal}
          onBack={() => {}}
          onForward={() => {}}
          onRefresh={() => browserUrl && navigateToUrl(browserUrl)}
        />
      )}

      {/* Main content */}
      <div className="app-content">
        {showSettings ? (
          <SettingsPanel
            selectedModel={selectedModel}
            models={models}
            onSelectModel={setSelectedModel}
            onClose={() => { setShowSettings(false); if (messages.length === 0) setMode('idle'); else setMode('chat'); }}
          />
        ) : (
          <>
            <div className={`search-section ${mode === 'idle' ? 'centered' : 'top'}`}>
              <SearchBar
                onSubmit={handleSubmit}
                isStreaming={isStreaming}
                mode={mode}
                selectedModel={selectedModel}
                models={models}
                onSelectModel={setSelectedModel}
              />
            </div>

            {/* MCPWeb Panel — PRIMARY view for MCPWeb sites */}
            {showMcpWeb && mcpWebCaps?.supported && (
              <McpWebPanel
                capabilities={mcpWebCaps}
                connected={mcpWebConnected}
                connecting={mcpWebConnecting}
                connectedTools={mcpWebTools}
                onCallTool={(toolName) => {
                  const serverName = mcpWebCaps.serverInfo?.name || 'this site';
                  // For MCP-B tools, instruct the AI to use browser__callMcpBTool
                  const isMcpB = mcpWebServerId === null && mcpWebTools.some(t => t.serverId === 'mcpb-browser');
                  if (isMcpB) {
                    handleSubmit(`Call the MCP-B tool "${toolName}" on this page using browser__callMcpBTool. Ask me for any required parameters.`);
                  } else {
                    handleSubmit(`Use the ${toolName} tool from ${serverName}`);
                  }
                }}
                onBrowse={handleOpenInBrowser}
                onOpenExternal={handleOpenExternal}
                onDisconnect={() => {
                  if (mcpWebServerId) {
                    window.surge?.mcpweb?.disconnect(mcpWebServerId).then(() => {
                      setMcpWebConnected(false);
                      setMcpWebServerId(null);
                      setMcpWebTools([]);
                      handleOpenInBrowser();
                    });
                  } else {
                    // MCP-B: just clear the state (no server to disconnect)
                    setMcpWebConnected(false);
                    setMcpWebTools([]);
                    setShowMcpWeb(false);
                    setMcpWebCaps(null);
                  }
                }}
              />
            )}

            {mode === 'chat' && (
              <div className="chat-section fade-in">
                <ChatPanel
                  messages={messages}
                  streamContent={streamContent}
                  isStreaming={isStreaming}
                  toolCalls={toolCalls}
                />
              </div>
            )}

            {showServers && (
              <ServerPanel onClose={() => setShowServers(false)} />
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default App;
