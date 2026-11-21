// MCP server discovery: a rating index (mcprating.io's REST API, by default) with the official MCP
// Registry as the neutral fallback. Platform-agnostic (fetch only): the mobile shell imports it too.
//
// We use the index's REST API (not its MCP tools) because REST returns structured fields (quality,
// trust tier, safety, start test, UI type, auth) that a browse UI needs. No key of any kind is ever
// sent: in particular never an `x-partner-key`, which is what turns on promoted results there.

/** The default index. It has the same maintainer as Surge, which the discovery panel says. */
export const DEFAULT_MCP_INDEX = 'https://mcprating.io';
/** The official MCP Registry: listings only, no ratings. The fallback, and a choice of its own. */
export const OFFICIAL_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';

export type TrustTier = 'verified' | 'trusted' | 'community' | 'unverified';
export type SafetyBand = 'safe' | 'caution' | 'risk';
/** The index's start test: did its harness start the server and list its tools. */
export type StartTestOutcome = 'verified' | 'needs_credentials' | 'failed_to_start' | 'unsupported';

export interface StartTest {
  outcome: StartTestOutcome | string;
  /** When the latest attempt ran (ISO). */
  at?: string;
  /** Tools the harness listed on its last successful start. */
  tools?: number;
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
  /** A hosted endpoint to connect to (`remotes` in the source), instead of a command. */
  remoteUrl?: string | null;
  remoteTransport?: 'streamable-http' | 'sse';
  requiresAuth?: boolean;
  isOfficial?: boolean;
  isVerified?: boolean;
  stars?: number;
  weeklyDownloads?: number;
  npmPackage?: string | null;
  /** Only ever the source's own command (or `npx -y <npmPackage>`): never guessed from a name. */
  installCommand?: string | null;
  repositoryUrl?: string | null;
  /** Unset when the source doesn't rate servers (the official MCP Registry). */
  trustTier?: TrustTier;
  /** Who set the tier: the source itself, or Surge's estimate from the source's quality score. */
  tierBasis?: 'source' | 'surge';
  safetyScore?: number | null;
  safetyBand?: SafetyBand | null;
  safetyFlags?: string[];
  startTest?: StartTest | null;
  /** 'mcp-index' (a rating index) or 'mcp-registry' (the official registry). */
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

/** Where a page of results came from, so the panel can say so. */
export interface DiscoveryOrigin {
  /** 'none' when nothing answered. */
  kind: 'index' | 'registry' | 'none';
  /** The base URL that answered (or the last one tried). */
  url: string;
  /** The index didn't answer, so these come from the fallback registry. */
  fallback?: boolean;
  /** The index that didn't answer. */
  failed?: string;
  /** Something the user should know about this page (e.g. filters the registry can't apply). */
  note?: string;
}

export interface DiscoveryResult {
  servers: IndexServer[];
  total: number;
  from: DiscoveryOrigin;
}

/** What it takes to connect to a listed server; null when the listing gives no way to run it. */
export interface DiscoveryConnect {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
}

const TIERS: readonly TrustTier[] = ['verified', 'trusted', 'community', 'unverified'];
const TIMEOUT_MS = 6000;

/** The source's tier, if it sent one. mcprating.io's fourth tier is `unknown` ("Unverified" in its UI). */
function sourceTier(raw: unknown): TrustTier | undefined {
  const t = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (t === 'unknown') return 'unverified';
  return (TIERS as readonly string[]).includes(t) ? (t as TrustTier) : undefined;
}

/**
 * Surge's own estimate, used only when the source sends a quality score but no tier. A safety score
 * caps it the way mcprating.io's own rule does: under 50 at most community, under 30 unverified.
 */
export function deriveTrustTier(s: { isOfficial?: boolean; isVerified?: boolean; qualityScore?: number | null; safetyScore?: number | null }): TrustTier {
  const q = s.qualityScore ?? 0;
  let tier: TrustTier;
  if ((s.isOfficial || s.isVerified) && q >= 80) tier = 'verified';
  else if (q >= 70) tier = 'trusted';
  else if (q >= 40) tier = 'community';
  else tier = 'unverified';
  const safety = s.safetyScore;
  if (typeof safety === 'number') {
    if (safety < 30) tier = 'unverified';
    else if (safety < 50 && (tier === 'verified' || tier === 'trusted')) tier = 'community';
  }
  return tier;
}

function bandOf(score: number): SafetyBand {
  return score >= 80 ? 'safe' : score >= 50 ? 'caution' : 'risk';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Listing fields that become command-line arguments. Anyone can publish to the official registry, so a
// name has to look like a package name and nothing else: not a flag (`--call=…`), a path, a URL, a
// tarball or a GitHub `owner/repo` shorthand, all of which npx and uvx would also accept.
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const VERSION = /^[0-9][0-9a-z.+-]*$/i;
/** An npm package name npx can only read as a registry package; null otherwise. */
export function npmPackageName(v: unknown): string | null {
  const s = str(v);
  return s && s.length <= 214 && NPM_NAME.test(s) ? s : null;
}

/** The first hosted endpoint a listing offers that Surge can connect to without filling in a template. */
function pickRemote(remotes: unknown): { url: string; transport: 'streamable-http' | 'sse'; needsAuth: boolean } | null {
  if (!Array.isArray(remotes)) return null;
  for (const r of remotes) {
    const url = str(r?.url);
    const type = r?.type === 'sse' ? 'sse' : r?.type === 'streamable-http' || r?.type === 'http' ? 'streamable-http' : null;
    if (!url || !type || !/^https?:\/\//i.test(url) || /[{}]/.test(url)) continue;
    const headers: any[] = Array.isArray(r?.headers) ? r.headers : [];
    const needsAuth = headers.some((h) => h?.isRequired || h?.isSecret || /^authorization$/i.test(String(h?.name)));
    return { url, transport: type, needsAuth };
  }
  return null;
}

function startTestOf(s: any): StartTest | null {
  const v = s.verification;
  const outcome = str(v?.latestOutcome) ?? str(v?.outcome);
  if (!outcome) return null;
  const at = str(v?.lastAttemptedAt) ?? str(v?.at) ?? undefined;
  const tools = num(s.metadata?.verification?.tools) ?? num(v?.tools);
  return { outcome, ...(at ? { at } : {}), ...(tools != null && outcome === 'verified' ? { tools } : {}) };
}

/** One listing from a rating index (mcprating.io's `/api/v1/servers` shape). */
export function normalizeIndexServer(s: any, source = 'mcp-index'): IndexServer {
  const npmPackage = str(s.npmPackage) ?? str(s.npm_package);
  const runnableNpm = npmPackageName(npmPackage);
  const remote = pickRemote(s.remotes ?? s.metadata?.remotes);
  const safetyScore = num(s.safetyScore) ?? num(s.safety_score);
  const band = s.safetyBand ?? s.safety_band;
  const out: IndexServer = {
    id: s.slug || s.id || s.name,
    slug: s.slug || s.id || s.name,
    name: s.name || s.slug || 'Unknown',
    description: s.description || '',
    category: s.category?.slug || s.category?.name || (typeof s.category === 'string' ? s.category : undefined),
    qualityScore: num(s.qualityScore) ?? num(s.quality_score),
    uiType: s.uiType ?? s.ui_type ?? null,
    supportsUi: s.supportsUi ?? s.supports_ui ?? undefined,
    supportsDiscovery: s.supportsDiscovery ?? s.hasDiscovery ?? undefined,
    discoveryUrl: s.discoveryUrl ?? s.discovery_url ?? null,
    remoteUrl: remote?.url ?? null,
    ...(remote ? { remoteTransport: remote.transport } : {}),
    // mcprating.io sends requiresAuth: false beside an endpoint whose Authorization header it marks secret.
    requiresAuth: !!(s.requiresAuth ?? s.requires_auth) || remote?.needsAuth || undefined,
    isOfficial: s.isOfficial ?? s.is_official ?? undefined,
    isVerified: s.isVerified ?? s.is_verified ?? undefined,
    stars: s.stars ?? undefined,
    weeklyDownloads: s.weeklyDownloads ?? s.weekly_downloads ?? undefined,
    npmPackage,
    installCommand: str(s.installCommand) ?? str(s.install_command) ?? (runnableNpm ? `npx -y ${runnableNpm}` : null),
    repositoryUrl: str(s.repositoryUrl) ?? str(s.repository_url),
    safetyScore,
    safetyBand: band === 'safe' || band === 'caution' || band === 'risk' ? band : safetyScore != null ? bandOf(safetyScore) : null,
    safetyFlags: Array.isArray(s.safetyFlags) ? s.safetyFlags.filter((f: unknown) => typeof f === 'string') : [],
    startTest: startTestOf(s),
    source,
  };
  const tier = sourceTier(s.trustTier ?? s.trust_tier);
  if (tier) {
    out.trustTier = tier;
    out.tierBasis = 'source';
  } else if (out.qualityScore != null) {
    out.trustTier = deriveTrustTier(out);
    out.tierBasis = 'surge';
  }
  return out;
}

/** A name that works as a server id: `io.github.owner/thing` → `io-github-owner-thing`. */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

/** A command Surge can run for a registry package, or null (oci, nuget, mcpb and others aren't run). */
function packageCommand(p: any): string | null {
  const transport = p?.transport?.type ?? 'stdio';
  if (transport !== 'stdio') return null;
  const version = str(p?.version);
  switch (p?.registryType) {
    case 'npm': {
      const id = npmPackageName(p?.identifier);
      if (!id) return null;
      if (!version || version === 'latest') return `npx -y ${id}`;
      return VERSION.test(version) ? `npx -y ${id}@${version}` : null;
    }
    case 'pypi': {
      const id = str(p?.identifier);
      return id && PYPI_NAME.test(id) ? `uvx ${id}` : null;
    }
    default:
      return null;
  }
}

/**
 * One entry from the official MCP Registry (`{servers: [{server: {...}, _meta}]}`). The registry lists
 * servers; it doesn't rate them, so there's no score or tier. Returns null for entries that aren't
 * active or aren't the latest version.
 */
export function normalizeRegistryServer(entry: any): IndexServer | null {
  const s = entry?.server ?? entry;
  const name = str(s?.name);
  if (!name) return null;
  const meta = entry?._meta?.['io.modelcontextprotocol.registry/official'];
  if (meta && ((meta.status && meta.status !== 'active') || meta.isLatest === false)) return null;
  const remote = pickRemote(s.remotes);
  const packages: any[] = Array.isArray(s.packages) ? s.packages : [];
  const runnable = packages.map((p) => ({ p, cmd: packageCommand(p) })).find((x) => x.cmd);
  const npm = packages.find((p) => p?.registryType === 'npm' && npmPackageName(p?.identifier));
  const needsSecret = (runnable ? [runnable.p] : []).some((p) =>
    (Array.isArray(p.environmentVariables) ? p.environmentVariables : []).some((e: any) => e?.isRequired && e?.isSecret));
  const slug = slugOf(name);
  return {
    id: slug,
    slug,
    name: str(s.title) ?? name,
    description: s.description || '',
    qualityScore: null,
    remoteUrl: remote?.url ?? null,
    ...(remote ? { remoteTransport: remote.transport } : {}),
    requiresAuth: remote?.needsAuth || needsSecret || undefined,
    npmPackage: npmPackageName(npm?.identifier),
    installCommand: runnable?.cmd ?? null,
    repositoryUrl: str(s.repository?.url),
    safetyFlags: [],
    startTest: null,
    source: 'mcp-registry',
  };
}

/**
 * How to connect to a listed server: its hosted endpoint, its MCPWeb discovery URL, or its install
 * command. Null when the listing has none of them; Surge never makes up a command from a name, since
 * `npx -y <slug>` would run whatever package happens to have that name (or, for `owner/repo`, a
 * GitHub repository).
 */
export function connectConfigFor(s: IndexServer): DiscoveryConnect | null {
  if (s.remoteUrl) return { id: s.slug, name: s.name, transport: s.remoteTransport === 'sse' ? 'sse' : 'streamable-http', url: s.remoteUrl };
  if (s.supportsDiscovery && s.discoveryUrl) return { id: s.slug, name: s.name, transport: 'sse', url: s.discoveryUrl };
  const parts = (s.installCommand || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { id: s.slug, name: s.name, transport: 'stdio', command: parts[0], args: parts.slice(1) };
}

/** True when a base URL points at an official-registry-style API (`/v0/servers`) rather than an index. */
function isRegistryBase(base: string): boolean {
  try {
    const u = new URL(base);
    return u.hostname === new URL(OFFICIAL_MCP_REGISTRY).hostname || /\/v0(\.\d+)?(\/servers)?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** `…/v0/servers` for a registry base given with or without the path. */
function registryServersUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/servers$/.test(b)) return b;
  if (/\/v0(\.\d+)?$/.test(b)) return `${b}/servers`;
  return `${b}/v0/servers`;
}

export interface DiscoveryClientOptions {
  /** The fallback registry (default: the official MCP Registry). */
  registryUrl?: string;
}

export class DiscoveryClient {
  private registryUrl: string;

  /** `baseUrl` is the index; empty means the registry alone. */
  constructor(private baseUrl: string = DEFAULT_MCP_INDEX, opts: DiscoveryClientOptions = {}) {
    this.registryUrl = opts.registryUrl || OFFICIAL_MCP_REGISTRY;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  setRegistryUrl(url: string | undefined): void {
    this.registryUrl = url || OFFICIAL_MCP_REGISTRY;
  }

  private base(): string {
    return (this.baseUrl || '').trim().replace(/\/+$/, '');
  }

  /** The index base, or '' when the configured source is a registry (or empty). */
  private indexBase(): string {
    const base = this.base();
    return base && !isRegistryBase(base) ? base : '';
  }

  async listServers(q: DiscoveryQuery = {}): Promise<DiscoveryResult> {
    const base = this.base();
    if (base && isRegistryBase(base)) return this.fromRegistry(base, q, {});
    if (!base) return this.fromRegistry(this.registryUrl, q, {});
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
      const res = await fetch(`${base}/api/v1/servers?${p.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data: any = await res.json();
        const items: any[] | null = Array.isArray(data?.data) ? data.data : Array.isArray(data?.servers) ? data.servers : null;
        if (items) {
          const servers = items.map((s) => (s?.server ? normalizeRegistryServer(s) : normalizeIndexServer(s))).filter((s): s is IndexServer => !!s);
          return { servers, total: data.total ?? servers.length, from: { kind: 'index', url: base } };
        }
      }
    } catch {
      // fall through to the registry
    }
    return this.fromRegistry(this.registryUrl, q, { fallback: true, failed: base });
  }

  /**
   * A page from an official-registry-style API. It searches names only, has no categories, scores,
   * UI or "official" data, and pages by cursor; so with a filter it can't apply it returns nothing
   * (with a note) rather than results that don't match, and an offset past the first page is empty.
   */
  private async fromRegistry(registry: string, q: DiscoveryQuery, extra: Partial<DiscoveryOrigin>): Promise<DiscoveryResult> {
    const url = registry.replace(/\/+$/, '');
    const origin = (o: Partial<DiscoveryOrigin> = {}): DiscoveryOrigin => ({ kind: 'registry', url, ...extra, ...o });
    const unsupported = [q.category && 'category', q.hasUi && 'UI', q.isOfficial && 'official', q.minScore != null && 'score'].filter(Boolean);
    if (unsupported.length) {
      return { servers: [], total: 0, from: origin({ note: `The official MCP Registry can't filter by ${unsupported.join(', ')}.` }) };
    }
    if ((q.offset ?? 0) > 0) return { servers: [], total: 0, from: origin() };
    try {
      const p = new URLSearchParams({ version: 'latest', limit: String(Math.min(Math.max(q.limit ?? 24, 1), 100)) });
      if (q.search) p.set('search', q.search);
      const res = await fetch(`${registryServersUrl(url)}?${p.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data: any = await res.json();
        const seen = new Set<string>();
        const servers: IndexServer[] = [];
        for (const entry of Array.isArray(data?.servers) ? data.servers : []) {
          const s = normalizeRegistryServer(entry);
          if (!s || seen.has(s.slug)) continue;
          if (q.requiresAuth != null && !!s.requiresAuth !== q.requiresAuth) continue;
          seen.add(s.slug);
          servers.push(s);
        }
        return { servers, total: servers.length, from: origin() };
      }
    } catch {
      /* nothing answered */
    }
    return { servers: [], total: 0, from: { kind: 'none', url, ...extra } };
  }

  async getServer(slug: string): Promise<IndexServer | null> {
    const base = this.indexBase();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/api/v1/servers/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data: any = await res.json();
        return normalizeIndexServer(data.data || data);
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async getSimilar(slug: string): Promise<IndexServer[]> {
    const base = this.indexBase();
    if (!base) return [];
    try {
      const res = await fetch(`${base}/api/v1/servers/${encodeURIComponent(slug)}/similar`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data: any = await res.json();
        const items = data.data || data || [];
        return Array.isArray(items) ? items.map((s: any) => normalizeIndexServer(s)) : [];
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  async listCategories(): Promise<IndexCategory[]> {
    const base = this.indexBase();
    if (!base) return [];
    try {
      const res = await fetch(`${base}/api/v1/categories`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data: any = await res.json();
        const items = data.data || data || [];
        return Array.isArray(items)
          ? items.map((c: any) => ({ id: c.id, name: c.name, slug: c.slug, serverCount: c.serverCount ?? c.server_count }))
          : [];
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  async getStats(): Promise<any> {
    const base = this.indexBase();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/api/v1/stats`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res.json();
    } catch {
      /* ignore */
    }
    return null;
  }
}
