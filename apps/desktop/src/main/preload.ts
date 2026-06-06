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
    getModels: () => ipcRenderer.invoke('ai:getModels'),
  },

  // MCP server management
  mcp: {
    connect: (config: any) => ipcRenderer.invoke('mcp:connect', config),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
    getServers: () => ipcRenderer.invoke('mcp:getServers'),
    getTools: (serverId?: string) => ipcRenderer.invoke('mcp:getTools', serverId),
    callTool: (serverId: string, toolName: string, args: any) =>
      ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
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

  // Web search
  search: {
    web: (query: string) => ipcRenderer.invoke('search:web', query),
  },

  // Browser view controls
  browser: {
    navigate: (url: string) => ipcRenderer.send('browser:navigate', url),
    show: () => ipcRenderer.send('browser:show'),
    hide: () => ipcRenderer.send('browser:hide'),
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
  },
});
