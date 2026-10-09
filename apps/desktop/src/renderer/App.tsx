import React, { useState, useCallback, useEffect, useRef } from 'react';
import SearchBar from './components/SearchBar';
import ChatPanel from './components/ChatPanel';
import ServerPanel from './components/ServerPanel';
import SettingsPanel from './components/SettingsPanel';
import WebBrowserBar from './components/WebBrowserBar';
import McpWebPanel from './components/McpWebPanel';
import AgentApprovalModal from './components/AgentApprovalModal';
import HistoryPanel from './components/HistoryPanel';
import ChannelsPanel from './components/ChannelsPanel';
import { IconNewChat, IconHistory, IconShare, IconBolt, IconGlobe, IconSettings, IconMinus, IconX, IconMaximize, IconRestore } from './components/Icons';
import { PRIVATE_AUTO_MODEL, ONP_AUTO_MODEL } from './types';
import type { SocialChannel } from './types';
import type { AppMode, ChatMessage, AiModel, OnpCall, McpWebCapabilities, McpWebConnectResult, McpBDetectResult, WebAgentSpec } from './types';
import type { ToolCallData } from './components/McpToolCallBlock';
import './styles/app.css';

// History titles: the first message, on one line.
const chatTitle = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 80);

// Tool results can be big (a page's text, base64 images). History keeps enough to show what
// happened: text trimmed, images and audio dropped.
const HISTORY_TEXT_LIMIT = 2000;
function forHistory(tc: ToolCallData): ToolCallData {
  const cap = (s: string) => (s.length > HISTORY_TEXT_LIMIT ? `${s.slice(0, HISTORY_TEXT_LIMIT)}… [trimmed in history]` : s);
  const result = typeof tc.result === 'string'
    ? cap(tc.result)
    : Array.isArray(tc.result)
      ? tc.result.map((c: any) =>
          c?.type === 'text' ? { ...c, text: cap(String(c.text ?? '')) }
            : c?.type === 'image' || c?.type === 'audio' ? { type: c.type, mimeType: c.mimeType, omitted: true }
              : c)
      : tc.result;
  return { ...tc, result };
}

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-flash-lite');
  const [models, setModels] = useState<AiModel[]>([]);
  // Chat history: the saved session this conversation belongs to (created by its first message).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const setSession = useCallback((id: string | null) => { sessionIdRef.current = id; setSessionId(id); }, []);
  const [showHistory, setShowHistory] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  // The current turn's tool calls, read when the turn ends (state would be stale in that closure).
  const liveToolCalls = useRef<ToolCallData[]>([]);
  const browserUrlRef = useRef('');
  // Set once the startup model has been chosen, so the default isn't saved over the user's last pick.
  const modelsReady = useRef(false);
  // Private mode: only local/LAN models answer; the model in use before it was turned on comes back after
  const [privateMode, setPrivateMode] = useState(false);
  const modelBeforePrivate = useRef('gemini-flash-lite');
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

  // Per-site agent generation/approval
  const [agentProposal, setAgentProposal] = useState<{ spec: WebAgentSpec; usesCode: boolean } | null>(null);
  const [creatingAgent, setCreatingAgent] = useState(false);
  // One message under the browser bar: why "Create agent" failed (with a retry on a keyless model),
  // or what "Check for MCPWeb support" found (with Connect when there's a server).
  const [barNotice, setBarNotice] = useState<{
    text: string;
    tone: 'error' | 'info' | 'success';
    failedModel?: string;
    action?: { label: string; run: () => void };
  } | null>(null);

  useEffect(() => {
    // Start on the model used last if it still works; otherwise on one that needs no setup
    // (OpenNodes Auto, then local Ollama). A fresh install used to start on Gemini and fail
    // the first message without a key.
    Promise.all([
      window.surge?.ai?.getModels?.() ?? Promise.resolve([]),
      window.surge?.settings?.get('ui.lastModel').catch(() => null),
      window.surge?.private?.status?.().catch(() => null),
    ]).then(([list, last, st]: [AiModel[], string | null, any]) => {
      setModels(list);
      if (st?.enabled) {
        setPrivateMode(true);
        setSelectedModel(PRIVATE_AUTO_MODEL);
      } else {
        const usable = (id?: string | null) => !!id && list.some((m) => m.id === id && !m.needs);
        const pick = [last, ONP_AUTO_MODEL, 'ollama-local'].find(usable) ?? list.find((m) => !m.needs)?.id;
        if (pick) setSelectedModel(pick);
      }
      modelsReady.current = true;
    }).catch(() => {});
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
      const list = liveToolCalls.current;
      const i = list.findIndex(t => t.id === data.id);
      liveToolCalls.current = i >= 0 ? list.map((t, j) => (j === i ? { ...t, ...data } : t)) : [...list, data];
      setToolCalls(liveToolCalls.current);
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

  // Browser-like history: record embedded-browser navigations.
  useEffect(() => {
    const unsub = window.surge?.browser?.onNavigate?.((url: string) => {
      setBrowserUrl(url);
      window.surge?.history?.record({ kind: 'web', url, title: url }).catch(() => {});
    });
    return unsub;
  }, []);

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
        window.surge?.history
          ?.record({ kind: 'mcpweb-visit', url: fullUrl, title: connectResult.serverName || fullUrl, targetRef: connectResult.serverId })
          .catch(() => {});
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
    liveToolCalls.current = [];

    // History: the chat's first message creates its session; every message is saved as it lands.
    const sessionReady: Promise<string | null> = (async () => {
      let sid = sessionIdRef.current;
      if (!sid) {
        const session = await window.surge.chats.create({ title: chatTitle(query), model: selectedModel, pageUrl: browserUrlRef.current || null });
        sid = session.id;
        setSession(sid);
      }
      await window.surge.chats.addMessage(sid, { role: 'user', content: query });
      return sid;
    })().catch(() => null);

    // A finished reply: tool calls move from the live list onto the message, and it's saved.
    const finishReply = (content: string) => {
      const turnTools = liveToolCalls.current;
      liveToolCalls.current = [];
      setToolCalls([]);
      if (!content && !onpCalls.length && !turnTools.length) return;
      const reply: ChatMessage = {
        role: 'assistant',
        content,
        onpCalls: onpCalls.length ? onpCalls : undefined,
        toolCalls: turnTools.length ? turnTools : undefined,
      };
      setMessages(msgs => [...msgs, reply]);
      sessionReady.then((sid) => {
        if (!sid) return;
        window.surge.chats.addMessage(sid, {
          role: 'assistant',
          content,
          meta: { toolCalls: reply.toolCalls?.map(forHistory), onpCalls: reply.onpCalls, model: selectedModel },
        }).catch(() => {});
        window.surge.chats.update(sid, { model: selectedModel, pageUrl: browserUrlRef.current || null }).catch(() => {});
      });
    };

    // Register listeners BEFORE starting the stream
    // Use a flag to ensure onEnd only processes once (prevents duplication from multi-round tool calls)
    let finished = false;
    let accumulatedContent = '';
    const onpCalls: OnpCall[] = [];

    const removeToken = window.surge.ai.onStreamToken((token) => {
      accumulatedContent += token;
      setStreamContent(prev => prev + token);
    });

    const removeOnpCall = window.surge.ai.onOnpCall((call) => { onpCalls.push(call); });

    const cleanup = () => {
      removeToken();
      removeOnpCall();
      removeEnd();
      removeError();
    };

    const removeEnd = window.surge.ai.onStreamEnd(() => {
      if (finished) return; // Prevent duplicate processing
      finished = true;
      cleanup();
      finishReply(accumulatedContent);
      window.surge?.history?.record({ kind: 'chat', title: query.slice(0, 80) }).catch(() => {});
      setStreamContent('');
      setIsStreaming(false);
    });

    const removeError = window.surge.ai.onStreamError((error) => {
      if (finished) return;
      finished = true;
      cleanup();
      finishReply(`Error: ${error}`);
      setStreamContent('');
      setIsStreaming(false);
    });

    try {
      await window.surge.ai.streamChat(newMessages, selectedModel);
    } catch (err: any) {
      if (!finished) {
        finished = true;
        cleanup();
        finishReply(`${err.message || 'Failed to connect'}`);
        setIsStreaming(false);
        setStreamContent('');
      }
    }
  }, [messages, isStreaming, selectedModel, navigateToUrl, setSession]);

  // Channels: open a feed (sign in there the first time), or open it and ask for a summary that
  // reads it with browser__collectFeed.
  const openChannel = useCallback((c: SocialChannel) => {
    setShowChannels(false);
    navigateToUrl(c.home);
  }, [navigateToUrl]);

  const summarizeChannel = useCallback(async (c: SocialChannel) => {
    setShowChannels(false);
    if (!browserUrl.includes(c.domain)) await navigateToUrl(c.home);
    handleSubmit(`Summarize my ${c.name} feed. Use browser__collectFeed to gather the posts on the open page (it scrolls a few screens), `
      + 'then give me the main themes, the most notable posts with who posted them, and anything that looks like it needs my attention. '
      + "Only read: don't open posts, like, comment or post anything.");
  }, [browserUrl, navigateToUrl, handleSubmit]);

  // MCP-UI host "prompt" actions: an embedded MCP App can push a prompt into the chat.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (typeof text === 'string' && text) handleSubmit(text);
    };
    window.addEventListener('surge:prompt', onPrompt as EventListener);
    return () => window.removeEventListener('surge:prompt', onPrompt as EventListener);
  }, [handleSubmit]);

  // Live UI links open in Surge's browser.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) navigateToUrl(url);
    };
    window.addEventListener('surge:open-url', onOpen);
    return () => window.removeEventListener('surge:open-url', onOpen);
  }, [navigateToUrl]);

  const togglePrivate = useCallback(async () => {
    const turningOn = !privateMode;
    if (turningOn) modelBeforePrivate.current = selectedModel;
    const status = await window.surge.private.setEnabled(turningOn);
    setPrivateMode(status.enabled);
    setModels(await window.surge.ai.getModels());
    setSelectedModel(status.enabled ? PRIVATE_AUTO_MODEL : modelBeforePrivate.current);
    if (status.error) {
      setMode('chat');
      setMessages(msgs => [...msgs, { role: 'assistant', content: status.error! }]);
    }
  }, [privateMode, selectedModel]);

  const handleNewChat = useCallback(() => {
    // Disconnect MCPWeb if connected
    if (mcpWebServerId) {
      window.surge?.mcpweb?.disconnect(mcpWebServerId).catch(() => {});
    }
    setMessages([]);
    setStreamContent('');
    setIsStreaming(false);
    setToolCalls([]);
    liveToolCalls.current = [];
    setSession(null);
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

  // Generate a per-site agent from the current page (proposal only — user must approve).
  // A failure becomes a notice under the browser bar, not a native alert.
  const createAgent = useCallback(async (model: string) => {
    if (creatingAgent) return;
    setCreatingAgent(true);
    setBarNotice(null);
    const modelName = models.find((m) => m.id === model)?.name || model;
    try {
      const res = await window.surge.agents.generate(model);
      if (res.success && res.spec && res.spec.tools.length > 0) {
        setAgentProposal({ spec: res.spec, usesCode: !!res.usesCode });
      } else if (res.success) {
        setBarNotice({ tone: 'error', text: `${modelName} found nothing on this page to turn into agent tools.`, failedModel: model });
      } else {
        setBarNotice({ tone: 'error', text: `Couldn't create an agent with ${modelName}: ${res.error || 'unknown error'}`, failedModel: model });
      }
    } catch (err: any) {
      setBarNotice({ tone: 'error', text: `Couldn't create an agent with ${modelName}: ${err.message || 'unknown error'}`, failedModel: model });
    } finally {
      setCreatingAgent(false);
    }
  }, [creatingAgent, models]);

  const handleCreateAgent = useCallback(() => createAgent(selectedModel), [createAgent, selectedModel]);

  // Offer a retry on a model that needs no API key: OpenNodes Auto, or auto-private in private mode.
  const agentRetryModel = barNotice?.failedModel
    ? models.find((m) => (m.id === ONP_AUTO_MODEL || m.id === PRIVATE_AUTO_MODEL) && m.id !== barNotice.failedModel)
    : undefined;

  // Remember the model for next time (private-mode models are tied to the session's mode).
  useEffect(() => {
    if (modelsReady.current && !selectedModel.startsWith('private:')) {
      window.surge?.settings?.set('ui.lastModel', selectedModel).catch(() => {});
    }
  }, [selectedModel]);

  useEffect(() => { browserUrlRef.current = browserUrl; }, [browserUrl]);

  // History opens over the chat. The idle window is a 160px bar, so it grows while the list is open.
  const toggleHistory = useCallback(() => {
    const next = !showHistory;
    setShowHistory(next);
    setShowChannels(false);
    if (mode === 'idle') window.surge?.window?.resize(next ? 'expanded' : 'compact');
  }, [showHistory, mode]);

  const toggleChannels = useCallback(() => {
    const next = !showChannels;
    setShowChannels(next);
    setShowHistory(false);
    if (mode === 'idle') window.surge?.window?.resize(next ? 'expanded' : 'compact');
  }, [showChannels, mode]);

  // Reopen a saved chat: its messages (with tool calls and receipts), its model if it still works,
  // and the page it was about.
  const openChat = useCallback(async (id: string) => {
    const data = await window.surge.chats.get(id).catch(() => null);
    if (!data) return;
    setShowHistory(false);
    setSession(id);
    setMessages(data.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
        onpCalls: m.meta?.onpCalls,
        toolCalls: m.meta?.toolCalls,
      })));
    liveToolCalls.current = [];
    setToolCalls([]);
    setStreamContent('');
    setMode('chat');
    const model = data.session.model;
    if (model && models.some((m) => m.id === model && !m.needs)) setSelectedModel(model);
    if (data.session.pageUrl && data.session.pageUrl !== browserUrl) navigateToUrl(data.session.pageUrl);
  }, [models, browserUrl, navigateToUrl, setSession]);

  // A notice belongs to the page it was about.
  useEffect(() => { setBarNotice(null); }, [browserUrl]);

  // "Check for MCPWeb support": a server-side MCPWeb endpoint (/.well-known/mcp) and browser-native
  // MCP-B tools registered by the open page. The answer goes in the notice under the bar.
  const checkMcpWeb = useCallback(async (url: string) => {
    setBarNotice(null);
    let host = url;
    try { host = new URL(url).hostname; } catch { /* keep the raw text */ }
    const [caps, mcpB] = await Promise.all([
      window.surge.mcpweb.detect(url).catch((err: any) => ({ supported: false, url, error: err?.message }) as any),
      window.surge.browser.detectMcpB().catch(() => null),
    ]);
    if (caps?.supported) {
      const n = caps.tools?.length ?? 0;
      const name = caps.serverInfo?.name ? ` (${caps.serverInfo.name})` : '';
      setBarNotice({
        tone: 'success',
        text: `${host} has an MCPWeb server${name} with ${n} tool${n === 1 ? '' : 's'}.`,
        action: mcpWebConnected ? undefined : { label: 'Connect', run: () => { setBarNotice(null); navigateToUrl(url); } },
      });
    } else if (mcpB?.supported && (mcpB.tools?.length ?? 0) > 0) {
      const tools = mcpB.tools!;
      const names = tools.slice(0, 3).map((t) => t.name).join(', ') + (tools.length > 3 ? ', …' : '');
      setBarNotice({ tone: 'success', text: `This page registers ${tools.length} MCP-B tool${tools.length === 1 ? '' : 's'} (${names}). The AI can call them through the Browser tools.` });
    } else if (caps?.error) {
      setBarNotice({ tone: 'error', text: `Couldn't check ${host} for MCPWeb: ${caps.error}` });
    } else {
      setBarNotice({ tone: 'info', text: `${host} has no MCPWeb server (/.well-known/mcp), and the page registers no MCP-B tools. The AI can still read and use the page through the Browser tools, or press \u2728 to create an agent for it.` });
    }
  }, [mcpWebConnected, navigateToUrl]);

  // The globe shows or hides the page. The page view keeps its last page even after New Chat
  // cleared the URL, so showing it re-syncs the URL bar from the page itself.
  const toggleBrowser = useCallback(async () => {
    if (showBrowser) {
      setShowBrowser(false);
      window.surge?.browser?.hide();
      return;
    }
    setShowBrowser(true);
    window.surge?.browser?.show();
    if (!browserUrl) {
      const url = await window.surge?.browser?.getUrl?.();
      if (url && /^https?:/i.test(url)) setBrowserUrl(url);
    }
  }, [showBrowser, browserUrl]);

  // Settings takes the whole window: the web page steps aside while it's open and comes back on
  // close. Closing returns to the chat (or the open page), or to idle if there's neither.
  const openSettings = useCallback(() => {
    setShowSettings(true);
    setMode('settings');
    if (showBrowser) window.surge?.browser?.hide();
  }, [showBrowser]);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setMode(messages.length === 0 && !browserUrl ? 'idle' : 'chat');
    if (showBrowser) window.surge?.browser?.show();
  }, [showBrowser, messages.length, browserUrl]);

  const handleApproveAgent = useCallback(async (spec: WebAgentSpec) => {
    const res = await window.surge.agents.save(spec);
    setAgentProposal(null);
    if (!res.success) setBarNotice({ tone: 'error', text: `Couldn't save the agent: ${res.error || 'unknown error'}` });
  }, []);

  return (
    <div className={`app ${mode}`}>
      {/* Title bar */}
      <div className="title-bar drag-region">
        <div className="title-bar-left no-drag">
          {mode !== 'idle' && (
            <button className="btn-icon" onClick={handleNewChat} title="New Chat">
              <IconNewChat size={15} />
            </button>
          )}
          <button className={`btn-icon ${showHistory ? 'active' : ''}`} onClick={toggleHistory} title="Chat history">
            <IconHistory size={15} />
          </button>
          <button className={`btn-icon ${showChannels ? 'active' : ''}`} onClick={toggleChannels} title="Channels (social feeds)">
            <IconShare size={15} />
          </button>
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
            <button className="btn-icon" onClick={toggleBrowser} title="Web Browser">
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
          <button className="btn-icon" onClick={showSettings ? closeSettings : openSettings} title="Settings">
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
          onBack={() => window.surge?.browser?.back()}
          onForward={() => window.surge?.browser?.forward()}
          onRefresh={() => browserUrl && navigateToUrl(browserUrl)}
          onBookmark={() => {
            if (browserUrl) {
              window.surge?.bookmarks
                ?.add({ url: browserUrl, title: browserUrl, kind: mcpWebConnected ? 'mcpweb' : 'web' })
                .catch(() => {});
            }
          }}
          onCreateAgent={handleCreateAgent}
          creatingAgent={creatingAgent}
          onCheckMcpWeb={checkMcpWeb}
          notice={barNotice && {
            text: barNotice.text,
            tone: barNotice.tone,
            actionLabel: barNotice.action?.label ?? (agentRetryModel && `Retry with ${agentRetryModel.name}`),
            onAction: barNotice.action?.run ?? (agentRetryModel && (() => createAgent(agentRetryModel.id))),
          }}
          onDismissNotice={() => setBarNotice(null)}
        />
      )}

      {/* Main content */}
      <div className="app-content">
        {showSettings ? (
          <SettingsPanel
            selectedModel={selectedModel}
            models={models}
            onSelectModel={setSelectedModel}
            onModelsChanged={setModels}
            onClose={closeSettings}
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
                onRefreshModels={() => { window.surge?.ai?.getModels?.().then(setModels).catch(() => {}); }}
                privateMode={privateMode}
                onTogglePrivate={togglePrivate}
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

            {showChannels && (
              <ChannelsPanel onOpen={openChannel} onSummarize={summarizeChannel} onClose={toggleChannels} />
            )}

            {showHistory && (
              <HistoryPanel
                currentId={sessionId}
                onOpen={openChat}
                onClose={toggleHistory}
                onDeleted={(id) => { if (id === sessionIdRef.current) handleNewChat(); }}
              />
            )}

            {agentProposal && (
              <AgentApprovalModal
                spec={agentProposal.spec}
                usesCode={agentProposal.usesCode}
                onApprove={handleApproveAgent}
                onCancel={() => setAgentProposal(null)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default App;
