import { contextBridge, ipcRenderer } from 'electron';

// Expose protected APIs to the renderer process
contextBridge.exposeInMainWorld('surge', {
  // Window controls
  window: {
    resize: (mode: 'compact' | 'expanded') => ipcRenderer.send('window:resize', mode),
    close: () => ipcRenderer.send('window:close'),
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    startDrag: () => ipcRenderer.send('window:startDrag'),
    onMaximizeChanged: (callback: (isMaximized: boolean) => void) => {
      const handler = (_event: any, isMaximized: boolean) => callback(isMaximized);
      ipcRenderer.on('window:maximizeChanged', handler);
      return () => ipcRenderer.removeListener('window:maximizeChanged', handler);
    },
  },

  // AI chat
  ai: {
    chat: (messages: any[], model: string) =>
      ipcRenderer.invoke('ai:chat', messages, model),
    streamChat: (messages: any[], model: string) =>
      ipcRenderer.invoke('ai:streamChat', messages, model),
    onStreamToken: (callback: (token: string) => void) => {
      const handler = (_event: any, token: string) => callback(token);
      ipcRenderer.on('ai:token', handler);
      return () => ipcRenderer.removeListener('ai:token', handler);
    },
    onStreamEnd: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('ai:streamEnd', handler);
      return () => ipcRenderer.removeListener('ai:streamEnd', handler);
    },
    onStreamError: (callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on('ai:streamError', handler);
      return () => ipcRenderer.removeListener('ai:streamError', handler);
    },
    onOnpCall: (callback: (call: any) => void) => {
      const handler = (_event: any, call: any) => callback(call);
      ipcRenderer.on('ai:onpCall', handler);
      return () => ipcRenderer.removeListener('ai:onpCall', handler);
    },
    getModels: () => ipcRenderer.invoke('ai:getModels'),
    listVllmModels: (endpoint: string) => ipcRenderer.invoke('ai:listVllmModels', endpoint),
  },

  // MCP server management
  mcp: {
    connect: (config: any) => ipcRenderer.invoke('mcp:connect', config),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
    getServers: () => ipcRenderer.invoke('mcp:getServers'),
    getTools: (serverId?: string) => ipcRenderer.invoke('mcp:getTools', serverId),
    callTool: (serverId: string, toolName: string, args: any) =>
      ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
    readResource: (serverId: string, uri: string) =>
      ipcRenderer.invoke('mcp:readResource', serverId, uri),
    discover: (query: string) => ipcRenderer.invoke('mcp:discover', query),
    onServerEvent: (callback: (event: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('mcp:serverEvent', handler);
      return () => ipcRenderer.removeListener('mcp:serverEvent', handler);
    },
    onToolCall: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('mcp:toolCall', handler);
      return () => ipcRenderer.removeListener('mcp:toolCall', handler);
    },
  },

  // MCPWeb detection & auto-connect
  mcpweb: {
    detect: (url: string) => ipcRenderer.invoke('mcpweb:detect', url),
    connect: (url: string) => ipcRenderer.invoke('mcpweb:connect', url),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcpweb:disconnect', serverId),
  },

  // Discovery (MCP_Index registry, with quality ratings)
  discovery: {
    list: (params: any) => ipcRenderer.invoke('discovery:list', params),
    get: (slug: string) => ipcRenderer.invoke('discovery:get', slug),
    similar: (slug: string) => ipcRenderer.invoke('discovery:similar', slug),
    categories: () => ipcRenderer.invoke('discovery:categories'),
    stats: () => ipcRenderer.invoke('discovery:stats'),
  },

  // Bookmarks (local-first; mirrors the standalone bookmarks MCP server)
  bookmarks: {
    add: (input: any) => ipcRenderer.invoke('bookmarks:add', input),
    remove: (id: string) => ipcRenderer.invoke('bookmarks:remove', id),
    list: (opts?: any) => ipcRenderer.invoke('bookmarks:list', opts),
    search: (query: string) => ipcRenderer.invoke('bookmarks:search', query),
    tag: (id: string, tag: string) => ipcRenderer.invoke('bookmarks:tag', id, tag),
    untag: (id: string, tag: string) => ipcRenderer.invoke('bookmarks:untag', id, tag),
  },

  // History (local-first)
  history: {
    record: (input: any) => ipcRenderer.invoke('history:record', input),
    search: (query: string) => ipcRenderer.invoke('history:search', query),
    list: (opts?: any) => ipcRenderer.invoke('history:list', opts),
    clear: (opts?: any) => ipcRenderer.invoke('history:clear', opts),
  },

  // Per-site agents (generate → approve → persist as MCP virtual server)
  agents: {
    generate: (model: string) => ipcRenderer.invoke('agents:generate', model),
    save: (spec: any) => ipcRenderer.invoke('agents:save', spec),
    list: () => ipcRenderer.invoke('agents:list'),
    remove: (id: string, domain?: string) => ipcRenderer.invoke('agents:remove', id, domain),
  },

  // Web search
  search: {
    web: (query: string) => ipcRenderer.invoke('search:web', query),
  },

  // Browser view controls
  browser: {
    navigate: (url: string) => ipcRenderer.send('browser:navigate', url),
    show: () => ipcRenderer.send('browser:show'),
    hide: () => ipcRenderer.send('browser:hide'),
    back: () => ipcRenderer.send('browser:back'),
    forward: () => ipcRenderer.send('browser:forward'),
    openExternal: (url: string) => ipcRenderer.send('browser:openExternal', url),
    onNavigate: (callback: (url: string) => void) => {
      const handler = (_event: any, url: string) => callback(url);
      ipcRenderer.on('browser:didNavigate', handler);
      return () => ipcRenderer.removeListener('browser:didNavigate', handler);
    },
    // MCP-B: detect browser-native MCP tools (navigator.modelContext)
    detectMcpB: () => ipcRenderer.invoke('browser:detectMcpB'),
  },

  // Settings / licensing
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    getTier: () => ipcRenderer.invoke('settings:getTier'),
    secrets: () => ipcRenderer.invoke('settings:secrets'),
  },

  // Private mode (local Ollama + LAN only, via the embedded ollama-router)
  private: {
    status: () => ipcRenderer.invoke('private:status'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('private:setEnabled', enabled),
    configure: (cfg: { peers?: string[]; mdns?: boolean }) => ipcRenderer.invoke('private:configure', cfg),
  },

  // OpenNodes spend ledger (persisted settled calls)
  onp: {
    spend: () => ipcRenderer.invoke('onp:spend'),
  },

  // OpenNodes per-host API keys: write-only; listing returns host names, never keys
  onpKeys: {
    list: () => ipcRenderer.invoke('onpKeys:list'),
    set: (host: string, key: string) => ipcRenderer.invoke('onpKeys:set', host, key),
    remove: (host: string) => ipcRenderer.invoke('onpKeys:delete', host),
  },
});
