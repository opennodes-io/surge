import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SettingsPort } from '../ports/index.js';
import type { McpWebCapabilities } from './mcpweb-detector.js';
import type { AgentSpec } from '../storage/types.js';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  isMcpWeb?: boolean; // true if connected via MCPWeb auto-detect
}

export interface ConnectedServer {
  id: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: McpTool[];
  config: McpServerConfig;
  /** true for in-memory virtual servers (page tools, in-process repos) — not real transports */
  virtual?: boolean;
  source?: VirtualServerSource;
}

export type VirtualServerSource = 'ephemeral-browser' | 'mcp-b' | 'codegen' | 'in-process';

/**
 * A virtual server exposes tools that aren't backed by a real MCP transport — e.g. the
 * Web->MCP adapter (page tools), MCP-B page tools, or in-process repos (bookmarks/history).
 * They are routed, namespaced and surfaced exactly like real servers. `persist()` is the
 * seam the future code-gen / saved-agent phase targets.
 */
export interface VirtualServer {
  id: string;
  name: string;
  tools: McpTool[];
  source?: VirtualServerSource;
  callTool: (toolName: string, args: any) => Promise<any>;
  persist?: () => AgentSpec;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  serverId: string;
}

// OpenAI-compatible tool definition for AI function calling
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

export class McpManager {
  private connections: Map<string, { client: Client; transport: any; server: ConnectedServer }> = new Map();
  private virtualServers: Map<string, VirtualServer> = new Map();
  private settings: SettingsPort;

  constructor(settings: SettingsPort) {
    this.settings = settings;
  }

  // ── Virtual Servers (Web->MCP adapter, in-process repos) ─
  registerVirtualServer(vs: VirtualServer): ConnectedServer {
    this.virtualServers.set(vs.id, vs);
    return this.virtualToConnected(vs);
  }

  unregisterVirtualServer(id: string): void {
    this.virtualServers.delete(id);
  }

  hasVirtualServer(id: string): boolean {
    return this.virtualServers.has(id);
  }

  private virtualToConnected(vs: VirtualServer): ConnectedServer {
    return {
      id: vs.id,
      name: vs.name,
      status: 'connected',
      tools: vs.tools,
      virtual: true,
      source: vs.source,
      config: { id: vs.id, name: vs.name, transport: 'stdio', isMcpWeb: vs.source === 'ephemeral-browser' || vs.source === 'mcp-b' },
    };
  }

  // ── MCPWeb Auto-Connect ─────────────────────────────────
  // Connects to a site's MCP endpoint discovered via .well-known/mcp
  async connectMcpWeb(caps: McpWebCapabilities): Promise<ConnectedServer> {
    if (!caps.supported || !caps.connectUrl) {
      throw new Error('Site does not support MCPWeb or has no connect URL');
    }

    const origin = new URL(caps.url).origin;
    const serverId = `mcpweb:${origin}`;

    // Already connected to this MCPWeb site?
    if (this.connections.has(serverId)) {
      const existing = this.connections.get(serverId)!;
      if (existing.server.status === 'connected') {
        return existing.server;
      }
      await this.disconnectServer(serverId);
    }

    const config: McpServerConfig = {
      id: serverId,
      name: caps.serverInfo?.name || origin,
      transport: 'sse',
      url: caps.connectUrl,
      isMcpWeb: true,
    };

    return this.connectServer(config);
  }

  // Disconnect an MCPWeb site connection by origin URL
  async disconnectMcpWeb(url: string): Promise<void> {
    try {
      const origin = new URL(url).origin;
      const serverId = `mcpweb:${origin}`;
      await this.disconnectServer(serverId);
    } catch {
      // Ignore
    }
  }

  // Check if a site is MCPWeb-connected
  isMcpWebConnected(url: string): boolean {
    try {
      const origin = new URL(url).origin;
      const serverId = `mcpweb:${origin}`;
      const conn = this.connections.get(serverId);
      return conn?.server.status === 'connected' || false;
    } catch {
      return false;
    }
  }

  // ── Standard Server Connection ──────────────────────────
  async connectServer(config: McpServerConfig): Promise<ConnectedServer> {
    // Check connection limit
    const maxConn = this.settings.getMaxConnections();
    if (this.connections.size >= maxConn) {
      throw new Error(
        `Connection limit reached (${maxConn}). ${
          this.settings.getTier() === 'free' ? 'Upgrade to Pro for unlimited connections.' : ''
        }`
      );
    }

    // Don't double-connect
    if (this.connections.has(config.id)) {
      const existing = this.connections.get(config.id)!;
      if (existing.server.status === 'connected') {
        return existing.server;
      }
      // Clean up broken connection
      await this.disconnectServer(config.id);
    }

    let transport: any;

    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('stdio transport requires a command');
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
      });
    } else if (config.transport === 'streamable-http') {
      if (!config.url) throw new Error('streamable-http transport requires a URL');
      transport = new StreamableHTTPClientTransport(new URL(config.url));
    } else if (config.transport === 'sse') {
      if (!config.url) throw new Error('SSE transport requires a URL');
      // Try streamable-http first (newer protocol), fall back to SSE
      try {
        transport = new StreamableHTTPClientTransport(new URL(config.url));
        const testClient = new Client({ name: 'surge-mcp-browser', version: '1.0.0' });
        await testClient.connect(transport);
        // Streamable-http worked — use this connection directly
        const toolsResult = await testClient.listTools();
        const tools: McpTool[] = (toolsResult.tools || []).map((t: any) => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || {},
          serverId: config.id,
        }));
        const server: ConnectedServer = {
          id: config.id,
          name: config.name,
          status: 'connected',
          tools,
          config: { ...config, transport: 'streamable-http' },
        };
        this.connections.set(config.id, { client: testClient, transport, server });
        return server;
      } catch {
        // Streamable-http failed, fall back to SSE
        transport = new SSEClientTransport(new URL(config.url));
      }
    } else {
      throw new Error(`Unsupported transport: ${config.transport}`);
    }

    const client = new Client({
      name: 'surge-mcp-browser',
      version: '1.0.0',
    });

    await client.connect(transport);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools: McpTool[] = (toolsResult.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
      serverId: config.id,
    }));

    const server: ConnectedServer = {
      id: config.id,
      name: config.name,
      status: 'connected',
      tools,
      config,
    };

    this.connections.set(config.id, { client, transport, server });

    // Save to persistent config (skip MCPWeb ephemeral connections)
    if (!config.isMcpWeb) {
      this.saveServerConfig(config);
    }

    return server;
  }

  async disconnectServer(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch {
      // Ignore errors during cleanup
    }

    this.connections.delete(serverId);
    if (!conn.server.config.isMcpWeb) {
      this.removeServerConfig(serverId);
    }
  }

  async callTool(serverId: string, toolName: string, args: any): Promise<any> {
    // Virtual servers (page tools / in-process repos) are routed through their callTool.
    const vs = this.virtualServers.get(serverId);
    if (vs) {
      const startTime = Date.now();
      try {
        const result = await vs.callTool(toolName, args || {});
        const content = Array.isArray(result?.content)
          ? result.content
          : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }];
        return {
          toolCallId: `${serverId}:${toolName}:${Date.now()}`,
          name: toolName,
          serverId,
          content,
          isError: result?.isError || false,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        return {
          toolCallId: `${serverId}:${toolName}:${Date.now()}`,
          name: toolName,
          serverId,
          content: [{ type: 'text', text: err.message }],
          isError: true,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Server not connected: ${serverId}`);

    const startTime = Date.now();
    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args || {},
      });

      return {
        toolCallId: `${serverId}:${toolName}:${Date.now()}`,
        name: toolName,
        serverId,
        content: result.content,
        isError: result.isError || false,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        toolCallId: `${serverId}:${toolName}:${Date.now()}`,
        name: toolName,
        serverId,
        content: [{ type: 'text', text: err.message }],
        isError: true,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Read an MCP resource (e.g. a ui:// template for MCP Apps / MCP-UI rendering).
  async readResource(serverId: string, uri: string): Promise<any> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Server not connected: ${serverId}`);
    return conn.client.readResource({ uri });
  }

  getConnectedServers(): ConnectedServer[] {
    const real = Array.from(this.connections.values()).map(c => c.server);
    const virtual = Array.from(this.virtualServers.values()).map(vs => this.virtualToConnected(vs));
    return [...real, ...virtual];
  }

  getTools(serverId?: string): McpTool[] {
    if (serverId) {
      const conn = this.connections.get(serverId);
      if (conn) return conn.server.tools;
      const vs = this.virtualServers.get(serverId);
      return vs ? vs.tools : [];
    }
    // All tools from all servers (real + virtual)
    const tools: McpTool[] = [];
    for (const conn of this.connections.values()) tools.push(...conn.server.tools);
    for (const vs of this.virtualServers.values()) tools.push(...vs.tools);
    return tools;
  }

  // ── Tool Inventory for AI ───────────────────────────────
  // Returns OpenAI-compatible tool definitions for function calling
  getToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.getConnectedServers()) {
      if (server.status !== 'connected') continue;
      for (const tool of server.tools) {
        tools.push({
          type: 'function',
          function: {
            // Namespace: serverId__toolName to avoid collisions
            name: `${server.id}__${tool.name}`,
            description: `[${server.name}] ${tool.description}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    }
    return tools;
  }

  // Returns a human-readable system prompt listing all connected tools
  getSystemPrompt(): string {
    const servers = this.getConnectedServers().filter(s => s.status === 'connected');
    if (servers.length === 0) return '';

    const lines: string[] = [
      'You are Surge, an AI assistant integrated into the Surge MCPWeb Browser.',
      'You have access to the following MCP servers and their tools.',
      'When the user asks to do something that a connected tool can handle, call the appropriate tool.',
      'Use the namespaced function name format: serverId__toolName',
      '',
      '## Connected MCP Servers',
      '',
    ];

    for (const server of servers) {
      lines.push(`### ${server.name} (${server.id})`);
      if (server.tools.length === 0) {
        lines.push('  No tools available.');
      } else {
        for (const tool of server.tools) {
          lines.push(`- **${server.id}__${tool.name}**: ${tool.description}`);
          if (tool.inputSchema?.properties) {
            const params = Object.keys(tool.inputSchema.properties).join(', ');
            lines.push(`  Parameters: ${params}`);
          }
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // Parse a namespaced tool name back to serverId + toolName
  parseToolName(namespacedName: string): { serverId: string; toolName: string } | null {
    const sep = namespacedName.indexOf('__');
    if (sep === -1) {
      // Try to find by tool name alone (first match) across real + virtual servers
      for (const server of this.getConnectedServers()) {
        const tool = server.tools.find(t => t.name === namespacedName);
        if (tool) {
          return { serverId: server.id, toolName: namespacedName };
        }
      }
      return null;
    }
    return {
      serverId: namespacedName.slice(0, sep),
      toolName: namespacedName.slice(sep + 2),
    };
  }

  // ── Server Discovery ────────────────────────────────────
  async discoverServers(query: string): Promise<any[]> {
    const results: any[] = [];

    // 1. Try MCP_Index first (local or configured endpoint)
    const mcpIndexUrl = this.settings.get('mcp.indexUrl') || '';
    if (mcpIndexUrl) {
      try {
        const response = await fetch(
          `${mcpIndexUrl}/api/v1/servers?search=${encodeURIComponent(query)}&limit=10&sortBy=quality`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (response.ok) {
          const data = await response.json();
          const servers = data.data || data.servers || data || [];
          results.push(...servers.map((s: any) => ({
            id: s.slug || s.id || s.name,
            name: s.name || s.slug,
            description: s.description || '',
            category: s.category || 'general',
            qualityScore: s.qualityScore || s.quality_score || null,
            installCommand: s.installCommand || `npx -y ${s.slug || s.id}`,
            hasDiscovery: s.hasDiscovery || false,
            discoveryUrl: s.discoveryUrl || null,
            source: 'mcp-index',
          })));
        }
      } catch {
        // MCP_Index unavailable, fall through to registry.mcp.so
      }
    }

    // 2. Fallback to registry.mcp.so
    if (results.length === 0) {
      try {
        const response = await fetch(
          `https://registry.mcp.so/api/servers?q=${encodeURIComponent(query)}&limit=10`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (response.ok) {
          const data = await response.json();
          results.push(...(data.servers || data || []).map((s: any) => ({
            id: s.slug || s.id || s.name,
            name: s.name || s.slug,
            description: s.description || '',
            category: s.category || 'general',
            qualityScore: null,
            installCommand: s.installCommand || s.install?.command || `npx -y ${s.slug}`,
            hasDiscovery: false,
            discoveryUrl: null,
            source: 'mcp.so',
          })));
        }
      } catch {
        // Registry unavailable
      }
    }

    return results;
  }

  // ── Persistence ─────────────────────────────────────────
  private saveServerConfig(config: McpServerConfig): void {
    const saved: McpServerConfig[] = this.settings.get('mcp.savedServers') || [];
    const idx = saved.findIndex(s => s.id === config.id);
    if (idx >= 0) {
      saved[idx] = config;
    } else {
      saved.push(config);
    }
    this.settings.set('mcp.savedServers', saved);
  }

  private removeServerConfig(serverId: string): void {
    const saved: McpServerConfig[] = this.settings.get('mcp.savedServers') || [];
    this.settings.set('mcp.savedServers', saved.filter(s => s.id !== serverId));
  }

  async reconnectSaved(): Promise<void> {
    if (!this.settings.get('mcp.autoReconnect')) return;

    const saved: McpServerConfig[] = this.settings.get('mcp.savedServers') || [];
    for (const config of saved) {
      try {
        await this.connectServer(config);
      } catch {
        // Skip failed reconnections silently
      }
    }
  }
}
