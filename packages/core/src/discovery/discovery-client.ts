// Typed client for the MCP_Index registry REST API (with a registry.mcp.so fallback).
// We use REST (not the registry's MCP-server tools) because REST returns structured
// fields — qualityScore, uiType, requiresAuth, isOfficial — that a rich browse UI needs.

export type TrustTier = 'verified' | 'trusted' | 'community' | 'unverified';

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
  trustTier?: TrustTier;
  source?: string;
}

export interface IndexCategory {
  id?: string;
  name: string;
  slug: string;
  serverCount?: number;
}

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

function deriveTrustTier(s: { isOfficial?: boolean; isVerified?: boolean; qualityScore?: number | null }): TrustTier {
  const q = s.qualityScore ?? 0;
  if ((s.isOfficial || s.isVerified) && q >= 80) return 'verified';
  if (q >= 70) return 'trusted';
  if (q >= 40) return 'community';
  return 'unverified';
}

function normalize(s: any, source = 'mcp-index'): IndexServer {
  const out: IndexServer = {
    id: s.slug || s.id || s.name,
    slug: s.slug || s.id || s.name,
    name: s.name || s.slug || 'Unknown',
    description: s.description || '',
    category: s.category?.slug || s.category?.name || s.category || undefined,
    qualityScore: s.qualityScore ?? s.quality_score ?? null,
    uiType: s.uiType ?? s.ui_type ?? null,
    supportsUi: s.supportsUi ?? s.supports_ui ?? undefined,
    supportsDiscovery: s.supportsDiscovery ?? s.hasDiscovery ?? undefined,
    discoveryUrl: s.discoveryUrl ?? s.discovery_url ?? null,
    requiresAuth: s.requiresAuth ?? s.requires_auth ?? undefined,
    isOfficial: s.isOfficial ?? s.is_official ?? undefined,
    isVerified: s.isVerified ?? s.is_verified ?? undefined,
    stars: s.stars ?? undefined,
    weeklyDownloads: s.weeklyDownloads ?? s.weekly_downloads ?? undefined,
    npmPackage: s.npmPackage ?? s.npm_package ?? null,
    installCommand: s.installCommand ?? s.install_command ?? (s.npmPackage ? `npx -y ${s.npmPackage}` : `npx -y ${s.slug || s.id}`),
    source,
  };
  out.trustTier = deriveTrustTier(out);
  return out;
}

export class DiscoveryClient {
  constructor(private baseUrl: string = '') {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  private base(): string {
    return (this.baseUrl || '').trim().replace(/\/+$/, '');
  }

  async listServers(q: DiscoveryQuery = {}): Promise<{ servers: IndexServer[]; total: number }> {
    const base = this.base();
    if (base) {
      try {
        const p = new URLSearchParams();
        if (q.search) p.set('search', q.search);
        if (q.category) p.set('category', q.category);
        p.set('sortBy', q.sortBy || 'quality');
        p.set('limit', String(q.limit ?? 24));
        p.set('offset', String(q.offset ?? 0));
        if (q.hasUi) p.set('hasUi', 'true');
        if (q.minScore != null) p.set('minScore', String(q.minScore));
        if (q.requiresAuth != null) p.set('requiresAuth', String(q.requiresAuth));
        if (q.isOfficial != null) p.set('isOfficial', String(q.isOfficial));
        const res = await fetch(`${base}/api/v1/servers?${p.toString()}`, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const data: any = await res.json();
          const items: any[] = data.data || data.servers || [];
          return { servers: items.map((s) => normalize(s)), total: data.total ?? items.length };
        }
      } catch {
        // fall through to registry.mcp.so
      }
    }
    return this.fallback(q);
  }

  async getServer(slug: string): Promise<IndexServer | null> {
    const base = this.base();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/api/v1/servers/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data: any = await res.json();
        return normalize(data.data || data);
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async getSimilar(slug: string): Promise<IndexServer[]> {
    const base = this.base();
    if (!base) return [];
    try {
      const res = await fetch(`${base}/api/v1/servers/${encodeURIComponent(slug)}/similar`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data: any = await res.json();
        return (data.data || data || []).map((s: any) => normalize(s));
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  async listCategories(): Promise<IndexCategory[]> {
    const base = this.base();
    if (!base) return [];
    try {
      const res = await fetch(`${base}/api/v1/categories`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data: any = await res.json();
        return (data.data || data || []).map((c: any) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          serverCount: c.serverCount ?? c.server_count,
        }));
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  async getStats(): Promise<any> {
    const base = this.base();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/api/v1/stats`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) return res.json();
    } catch {
      /* ignore */
    }
    return null;
  }

  private async fallback(q: DiscoveryQuery): Promise<{ servers: IndexServer[]; total: number }> {
    try {
      const res = await fetch(
        `https://registry.mcp.so/api/servers?q=${encodeURIComponent(q.search || '')}&limit=${q.limit ?? 24}`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (res.ok) {
        const data: any = await res.json();
        const items: any[] = data.servers || data || [];
        return { servers: items.map((s) => normalize(s, 'mcp.so')), total: items.length };
      }
    } catch {
      /* ignore */
    }
    return { servers: [], total: 0 };
  }
}
