export interface McpWebTransport {
  type: 'sse' | 'streamable-http';
  url: string;
  messages_url?: string;
}

export interface McpWebCapabilities {
  supported: boolean;
  url: string;
  serverInfo?: {
    name: string;
    version: string;
    description?: string;
  };
  tools?: Array<{
    name: string;
    description: string;
    inputSchema?: any;
  }>;
  resources?: Array<{
    uri: string;
    name: string;
    description?: string;
  }>;
  transports?: McpWebTransport[];
  connectUrl?: string;
}

export class McpWebDetector {
  private cache: Map<string, { result: McpWebCapabilities; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async detect(url: string): Promise<McpWebCapabilities> {
    const origin = new URL(url).origin;

    // Check cache
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.result;
    }

    const result = await this.probe(origin);
    this.cache.set(origin, { result, timestamp: Date.now() });
    return result;
  }

  private async probe(origin: string): Promise<McpWebCapabilities> {
    const wellKnownUrl = `${origin}/.well-known/mcp`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(wellKnownUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return { supported: false, url: origin };
      }

      const manifest = await response.json();

      // Parse transports from manifest (new format with transports array)
      const transports = this.parseTransports(manifest, origin);

      // Pick best connect URL: prefer streamable-http > SSE > fallback
      const connectUrl = this.pickBestConnectUrl(transports, manifest, origin);

      return {
        supported: true,
        url: origin,
        serverInfo: {
          name: manifest.name || manifest.server?.name || 'Unknown',
          version: manifest.version || manifest.server?.version || '1.0',
          description: manifest.description || manifest.server?.description,
        },
        tools: manifest.tools || manifest.capabilities?.tools || [],
        resources: manifest.resources || manifest.capabilities?.resources || [],
        transports,
        connectUrl,
      };
    } catch {
      return { supported: false, url: origin };
    }
  }

  private parseTransports(manifest: any, origin: string): McpWebTransport[] {
    const transports: McpWebTransport[] = [];

    // New format: manifest.transports array
    if (Array.isArray(manifest.transports)) {
      for (const t of manifest.transports) {
        const type = t.type as string;
        if (type === 'streamable-http' || type === 'sse') {
          transports.push({
            type: type as 'sse' | 'streamable-http',
            url: this.resolveUrl(t.url, origin),
            messages_url: t.messages_url ? this.resolveUrl(t.messages_url, origin) : undefined,
          });
        }
      }
    }

    // Legacy format: single endpoint field
    if (transports.length === 0) {
      const endpoint = manifest.endpoint || manifest.url;
      if (endpoint) {
        // Try to detect transport type from the URL
        const resolvedUrl = this.resolveUrl(endpoint, origin);
        if (endpoint.includes('sse')) {
          transports.push({ type: 'sse', url: resolvedUrl });
        } else {
          // Default to streamable-http for generic endpoints
          transports.push({ type: 'streamable-http', url: resolvedUrl });
        }
      }
    }

    // Ultimate fallback: assume /mcp endpoint exists
    if (transports.length === 0) {
      transports.push({ type: 'sse', url: `${origin}/mcp/sse` });
    }

    return transports;
  }

  private pickBestConnectUrl(
    transports: McpWebTransport[],
    manifest: any,
    origin: string
  ): string {
    // Prefer streamable-http > SSE
    const streamable = transports.find(t => t.type === 'streamable-http');
    if (streamable) return streamable.url;

    const sse = transports.find(t => t.type === 'sse');
    if (sse) return sse.url;

    // Fallback to manifest endpoint
    return manifest.endpoint || manifest.url || `${origin}/mcp`;
  }

  private resolveUrl(url: string, origin: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  clearCache(): void {
    this.cache.clear();
  }

  invalidate(url: string): void {
    try {
      const origin = new URL(url).origin;
      this.cache.delete(origin);
    } catch {
      // Invalid URL
    }
  }
}
