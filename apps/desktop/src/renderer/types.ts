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
        getModels: () => Promise<AiModel[]>;
      };
      mcp: {
        connect: (config: McpServerConfig) => Promise<any>;
        disconnect: (serverId: string) => Promise<any>;
        getServers: () => Promise<ConnectedServer[]>;
        getTools: (serverId?: string) => Promise<McpTool[]>;
        callTool: (serverId: string, toolName: string, args: any) => Promise<any>;
        discover: (query: string) => Promise<any[]>;
        onServerEvent: (callback: (event: any) => void) => () => void;
        onToolCall: (callback: (data: any) => void) => () => void;
      };
      mcpweb: {
        detect: (url: string) => Promise<McpWebCapabilities>;
        connect: (url: string) => Promise<McpWebConnectResult>;
        disconnect: (serverId: string) => Promise<void>;
      };
      search: {
        web: (query: string) => Promise<{ results: SearchResult[]; error?: string }>;
      };
      browser: {
        navigate: (url: string) => void;
        show: () => void;
        hide: () => void;
        openExternal: (url: string) => void;
        onNavigate: (callback: (url: string) => void) => () => void;
        detectMcpB: () => Promise<McpBDetectResult>;
      };
      settings: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: any) => Promise<any>;
        getTier: () => Promise<string>;
      };
    };
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export type ModelLevel = 'quick' | 'smart' | 'best';

export interface AiModel {
  id: string;
  name: string;
  provider: string;
  tier: string;
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
