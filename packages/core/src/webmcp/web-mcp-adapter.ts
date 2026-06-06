import type { McpTool, ToolDefinition, VirtualServer, VirtualServerSource } from '../mcp/mcp-manager.js';
import type { AgentSpec } from '../storage/types.js';

export function webMcpServerId(domain: string): string {
  return `webmcp:${domain}`;
}

/** Map OpenAI-style tool definitions to McpTool[], stripping a namespace prefix if present. */
export function toolDefsToMcpTools(serverId: string, defs: ToolDefinition[], stripPrefix?: string): McpTool[] {
  return defs.map((d) => {
    let name = d.function.name;
    if (stripPrefix && name.startsWith(stripPrefix)) name = name.slice(stripPrefix.length);
    return { name, description: d.function.description, inputSchema: d.function.parameters, serverId };
  });
}

export interface WebMcpAdapterOptions {
  /** Domain (or other stable key) the page tools belong to. */
  domain: string;
  /** Browser tool definitions; their function names may carry a prefix (e.g. "browser__"). */
  toolDefinitions: ToolDefinition[];
  /** Prefix to strip from tool names so callTool receives the bare name (default "browser__"). */
  stripPrefix?: string;
  source?: VirtualServerSource;
  name?: string;
  /** Execute a de-prefixed tool by name. */
  execute: (toolName: string, args: any) => Promise<any>;
}

/**
 * Wrap a set of website-interaction tools (provided by the platform's BrowserPort-backed
 * service) as a per-domain ephemeral MCP server so they appear, are namespaced, and are
 * routed exactly like a real MCP server. `persist()` is the seam where the later code-gen
 * phase turns the ephemeral page tools into a saved, profile-scoped agent.
 */
export function createWebMcpServer(opts: WebMcpAdapterOptions): VirtualServer {
  const id = webMcpServerId(opts.domain);
  const stripPrefix = opts.stripPrefix ?? 'browser__';
  const tools = toolDefsToMcpTools(id, opts.toolDefinitions, stripPrefix);
  const source: VirtualServerSource = opts.source ?? 'ephemeral-browser';
  return {
    id,
    name: opts.name ?? `${opts.domain} (page tools)`,
    source,
    tools,
    callTool: (toolName, args) => opts.execute(toolName, args),
    persist: (): AgentSpec => ({
      source: source === 'mcp-b' ? 'mcp-b' : 'ephemeral-browser',
      domain: opts.domain,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }),
  };
}
