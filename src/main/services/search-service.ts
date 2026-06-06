import { McpManager } from './mcp-manager';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export class SearchService {
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  async search(query: string): Promise<{ results: SearchResult[] }> {
    // Try using connected MCP search server first
    const servers = this.mcpManager.getConnectedServers();
    const searchServer = servers.find(s =>
      s.name.toLowerCase().includes('search') ||
      s.tools.some(t => t.name.toLowerCase().includes('search'))
    );

    if (searchServer) {
      const searchTool = searchServer.tools.find(t =>
        t.name.toLowerCase().includes('search')
      );
      if (searchTool) {
        const result = await this.mcpManager.callTool(
          searchServer.id,
          searchTool.name,
          { query }
        );
        return this.parseSearchResults(result);
      }
    }

    // Fallback: basic web search simulation
    // In production, this would connect to a search MCP server
    return {
      results: [
        {
          title: `Search results for: ${query}`,
          url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
          snippet: 'Connect a search MCP server (e.g., @mcp-server/google-search-mcp) for real results.',
          source: 'surge-fallback',
        },
      ],
    };
  }

  private parseSearchResults(mcpResult: any): { results: SearchResult[] } {
    const results: SearchResult[] = [];

    if (mcpResult?.content) {
      for (const item of mcpResult.content) {
        if (item.type === 'text') {
          try {
            // Try parsing as JSON array of results
            const parsed = JSON.parse(item.text);
            if (Array.isArray(parsed)) {
              for (const r of parsed) {
                results.push({
                  title: r.title || r.name || 'Untitled',
                  url: r.url || r.link || '#',
                  snippet: r.snippet || r.description || '',
                  source: 'mcp-search',
                });
              }
            }
          } catch {
            // Plain text result — create a single entry
            results.push({
              title: 'Search Result',
              url: '#',
              snippet: item.text,
              source: 'mcp-search',
            });
          }
        }
      }
    }

    return { results };
  }
}
