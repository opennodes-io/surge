// Type declarations for the Surge preload bridge

declare global {
  interface Window {
    surge: {
      window: {
        resize: (mode: 'compact' | 'expanded') => void;
        close: () => void;
        minimize: () => void;
        maximize: () => void;
        startDrag: () => void;
        onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void;
      };
      ai: {
        chat: (messages: ChatMessage[], model: string) => Promise<any>;
        streamChat: (messages: ChatMessage[], model: string) => Promise<any>;
        onStreamToken: (callback: (token: string) => void) => () => void;
        onStreamEnd: (callback: () => void) => () => void;
        onStreamError: (callback: (error: string) => void) => () => void;
        onOnpCall: (callback: (call: OnpCall) => void) => () => void;
        getModels: () => Promise<AiModel[]>;
        listVllmModels: (endpoint: string) => Promise<{ models?: string[]; error?: string }>;
      };
      mcp: {
        connect: (config: McpServerConfig) => Promise<any>;
        disconnect: (serverId: string) => Promise<any>;
        getServers: () => Promise<ConnectedServer[]>;
        getTools: (serverId?: string) => Promise<McpTool[]>;
        callTool: (serverId: string, toolName: string, args: any) => Promise<any>;
        readResource: (serverId: string, uri: string) => Promise<any>;
        discover: (query: string) => Promise<any[]>;
        onServerEvent: (callback: (event: any) => void) => () => void;
        onToolCall: (callback: (data: any) => void) => () => void;
      };
      mcpweb: {
        detect: (url: string) => Promise<McpWebCapabilities>;
        connect: (url: string) => Promise<McpWebConnectResult>;
        disconnect: (serverId: string) => Promise<void>;
      };
      discovery: {
        list: (params?: DiscoveryQuery) => Promise<{ servers: IndexServer[]; total: number }>;
        get: (slug: string) => Promise<IndexServer | null>;
        similar: (slug: string) => Promise<IndexServer[]>;
        categories: () => Promise<IndexCategory[]>;
        stats: () => Promise<any>;
      };
      bookmarks: {
        add: (input: Partial<Bookmark> & { url: string }) => Promise<Bookmark>;
        remove: (id: string) => Promise<{ removed: boolean }>;
        list: (opts?: { collectionId?: string; kind?: string; limit?: number }) => Promise<Bookmark[]>;
        search: (query: string) => Promise<Bookmark[]>;
        tag: (id: string, tag: string) => Promise<any>;
        untag: (id: string, tag: string) => Promise<any>;
      };
      history: {
        record: (input: Partial<HistoryEntry>) => Promise<HistoryEntry>;
        search: (query: string) => Promise<HistoryEntry[]>;
        list: (opts?: { kind?: string; limit?: number }) => Promise<HistoryEntry[]>;
        clear: (opts?: { kind?: string; olderThanDays?: number }) => Promise<{ cleared: number }>;
      };
      agents: {
        generate: (model: string) => Promise<{ success: boolean; spec?: WebAgentSpec; usesCode?: boolean; error?: string }>;
        save: (spec: WebAgentSpec) => Promise<{ success: boolean; agent?: SavedAgent; error?: string }>;
        list: () => Promise<SavedAgent[]>;
        remove: (id: string, domain?: string) => Promise<{ removed: boolean }>;
      };
      search: {
        web: (query: string) => Promise<{ results: SearchResult[]; error?: string }>;
      };
      browser: {
        navigate: (url: string) => void;
        show: () => void;
        hide: () => void;
        back: () => void;
        forward: () => void;
        openExternal: (url: string) => void;
        onNavigate: (callback: (url: string) => void) => () => void;
        detectMcpB: () => Promise<McpBDetectResult>;
      };
      settings: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: any) => Promise<any>;
        secrets: () => Promise<{ encrypted: boolean; saved: Record<string, boolean> }>;
      };
      onp: {
        spend: () => Promise<OnpSpend>;
      };
      private: {
        status: () => Promise<PrivateStatus>;
        setEnabled: (enabled: boolean) => Promise<PrivateStatus>;
        configure: (cfg: { peers?: string[]; mdns?: boolean }) => Promise<PrivateStatus>;
      };
      onpKeys: {
        list: () => Promise<{ encrypted: boolean; hosts: string[]; suggestions: Array<{ host: string; offerings: number }> }>;
        set: (host: string, key: string) => Promise<{ success?: boolean; error?: string }>;
        remove: (host: string) => Promise<{ success: boolean }>;
      };
    };
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  onpCalls?: OnpCall[];        // OpenNodes calls behind this reply (one per model round)
}

// Mirrors @surge/core's OnpCallRecord: one settled OpenNodes call
export interface OnpCall {
  at: number;
  offering: string;
  modelName: string;
  nodeId: string;
  tier: string;
  registryTtftMsP50?: number;  // registry-measured, not this call
  durationMs: number;          // this call, measured by Surge
  price: string;
  cardRevision: string;
  receipt: 'verified' | 'missing' | 'unverified' | 'invalid';
  reason?: string;
  receiptId?: string;
  usage?: { promptTokens: number; completionTokens: number };
  amount?: { currency: string; value: number };
  countedUsd: number;          // what the daily budget counted
  advisor?: { taskClass: string; score: number; reasons: string[]; considered: number; eligible: number; skipped: string[] };
}

// Private mode: model calls stay on this machine's Ollama and LAN peers
export interface PrivateStatus {
  enabled: boolean;
  running: boolean;
  origin: string | null;
  ollama: string;
  peers: string[];
  mdns: boolean;
  discoveredPeers: Array<{ name: string; kind: string; origin: string }>;
  error?: string;
}

export const PRIVATE_AUTO_MODEL = 'private:auto-private';

// The spend dashboard's data (mirrors OnpSpendSummary / OnpCallEntry from @surge/core/storage)
export interface OnpSpend {
  policy: { maxRequestUsd: number; dailyBudgetUsd: number; maxPricePerMtok: number | null; minTier: string; schemes: string[] };
  todayUsd: number;
  summary: {
    since: number;
    totalUsd: number;
    calls: number;
    byDay: Array<{ day: string; usd: number; calls: number }>;
    byNode: Array<{ nodeId: string; usd: number; calls: number; verified: number; invalid: number; unreceipted: number }>;
  };
  recent: Array<{
    id: string; at: number; offering: string; nodeId: string; modelName: string | null; tier: string | null; price: string | null;
    receipt: OnpCall['receipt']; reason: string | null; promptTokens: number | null; completionTokens: number | null;
    amount: { currency: string; value: number } | null; countedUsd: number; durationMs: number | null; advisor: Record<string, unknown> | null;
  }>;
}

export type ModelLevel = 'quick' | 'smart' | 'best';

export interface AiModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  supportsToolCalling: boolean;
  level?: ModelLevel;          // Which Quick/Smart/Best level this model can serve
  costEstimate?: string;       // e.g. "Free", "~$0.01/msg", "~$0.05/msg"
}

// Power-Up Pack template: a pre-configured combo of MCP servers + MCPWeb patterns
export interface PowerUpPack {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: 'productivity' | 'shopping' | 'research' | 'home' | 'social' | 'creative' | 'dev';
  servers: McpServerConfig[];
  mcpwebPatterns?: string[];
  systemPromptAddition?: string;
  quickActions?: Array<{ label: string; icon: string; prompt: string }>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  isMcpWeb?: boolean;
}

export interface ConnectedServer {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: McpTool[];
  config: McpServerConfig;
  virtual?: boolean;
  source?: string;
}

// ── Discovery (MCP_Index) ──────────────────────────────
export interface DiscoveryQuery {
  search?: string;
  category?: string;
  sortBy?: 'quality' | 'stars' | 'downloads' | 'recent' | 'name';
  limit?: number;
  offset?: number;
  hasUi?: boolean;
  minScore?: number;
  requiresAuth?: boolean;
  isOfficial?: boolean;
}

export interface IndexServer {
  id: string;
  slug: string;
  name: string;
  description: string;
  category?: string;
  qualityScore?: number | null;
  uiType?: 'mcp-apps' | 'mcp-ui' | null;
  supportsUi?: boolean;
  supportsDiscovery?: boolean;
  discoveryUrl?: string | null;
  requiresAuth?: boolean;
  isOfficial?: boolean;
  isVerified?: boolean;
  stars?: number;
  weeklyDownloads?: number;
  npmPackage?: string | null;
  installCommand?: string | null;
  trustTier?: 'verified' | 'trusted' | 'community' | 'unverified';
  source?: string;
}

export interface IndexCategory {
  id?: string;
  name: string;
  slug: string;
  serverCount?: number;
}

// ── Local bookmarks / history (renderer view) ──────────
export interface Bookmark {
  id: string;
  url: string;
  title: string | null;
  description?: string | null;
  favicon?: string | null;
  kind: 'web' | 'mcp-server' | 'mcpweb' | 'chat';
  targetRef?: string | null;
  collectionId?: string | null;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  url: string | null;
  title: string | null;
  kind: 'web' | 'mcp-server-connect' | 'mcpweb-visit' | 'chat' | 'tool-call';
  targetRef?: string | null;
  visitedAt: number;
  meta?: Record<string, unknown> | null;
}

// ── Per-site agents (codegen) ──────────────────────────
export interface AgentStep {
  action: string;
  selector?: string;
  url?: string;
  value?: string;
  valueFromParam?: string;
  attribute?: string;
  key?: string;
  saveAs?: string;
  timeoutMs?: number;
}

export interface AgentToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] };
  steps?: AgentStep[];
  code?: string;
}

export interface WebAgentSpec {
  version: 1;
  source: 'web-mcp' | 'codegen';
  domain: string;
  name: string;
  description?: string;
  tools: AgentToolDef[];
  codeApproved?: boolean;
}

export interface SavedAgent {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  spec: WebAgentSpec | null;
  createdAt: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  serverId: string;
}

export interface McpWebTransport {
  type: 'sse' | 'streamable-http';
  url: string;
  messages_url?: string;
}

export interface McpWebCapabilities {
  supported: boolean;
  url: string;
  serverInfo?: { name: string; version: string; description?: string };
  tools?: Array<{ name: string; description: string; inputSchema?: any }>;
  resources?: Array<{ uri: string; name: string; description?: string }>;
  transports?: McpWebTransport[];
  connectUrl?: string;
}

export interface McpWebConnectResult {
  success: boolean;
  serverId?: string;
  serverName?: string;
  tools?: McpTool[];
  error?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface McpBDetectResult {
  supported: boolean;
  toolCount?: number;
  tools?: Array<{ name: string; description: string; schema?: any }>;
  message?: string;
}

export type AppMode = 'idle' | 'searching' | 'results' | 'chat' | 'settings';
