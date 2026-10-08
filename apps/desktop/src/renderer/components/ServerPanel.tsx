import React, { useState, useEffect, useCallback } from 'react';
import { IconBolt, IconSearch, IconX, IconPlug, IconChevronDown, IconChevronUp } from './Icons';
import type { ConnectedServer, McpServerConfig, IndexServer, IndexCategory, DiscoveryQuery, SavedAgent, McpAuthStatus } from '../types';
import './ServerPanel.css';

interface ServerPanelProps {
  onClose: () => void;
}

const SORTS: Array<{ key: DiscoveryQuery['sortBy']; label: string }> = [
  { key: 'quality', label: 'Top rated' },
  { key: 'stars', label: 'Stars' },
  { key: 'downloads', label: 'Downloads' },
  { key: 'recent', label: 'Recent' },
  { key: 'name', label: 'Name' },
];

function trustClass(tier?: string): string {
  switch (tier) {
    case 'verified': return 'badge-green';
    case 'trusted': return 'badge-cyan';
    case 'community': return 'badge-yellow';
    default: return 'badge-red';
  }
}

const ServerPanel: React.FC<ServerPanelProps> = ({ onClose }) => {
  const [servers, setServers] = useState<ConnectedServer[]>([]);
  // A connect in progress: its server, and the sign-in page while one is pending (OAuth).
  const [connecting, setConnecting] = useState<{ id: string; name: string; signInUrl?: string } | null>(null);
  const [connectError, setConnectError] = useState('');

  useEffect(() => window.surge.mcp.onAuthStatus((s: McpAuthStatus) => {
    if (s.status === 'waiting') setConnecting((c) => (c && c.id === s.serverId ? { ...c, signInUrl: s.url } : c));
  }), []);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IndexServer[]>([]);
  const [categories, setCategories] = useState<IndexCategory[]>([]);
  const [category, setCategory] = useState<string>('');
  const [sortBy, setSortBy] = useState<DiscoveryQuery['sortBy']>('quality');
  const [hasUi, setHasUi] = useState(false);
  const [officialOnly, setOfficialOnly] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [connectCommand, setConnectCommand] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [similar, setSimilar] = useState<Record<string, IndexServer[]>>({});
  const [agents, setAgents] = useState<SavedAgent[]>([]);

  const refreshServers = useCallback(async () => {
    setServers(await window.surge.mcp.getServers());
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await window.surge.agents.list());
    } catch {
      setAgents([]);
    }
  }, []);

  const removeAgent = async (a: SavedAgent) => {
    await window.surge.agents.remove(a.id, a.spec?.domain);
    refreshAgents();
    refreshServers();
  };

  const runDiscovery = useCallback(async () => {
    setIsSearching(true);
    try {
      const res = await window.surge.discovery.list({
        search: query || undefined,
        category: category || undefined,
        sortBy,
        hasUi: hasUi || undefined,
        isOfficial: officialOnly || undefined,
        limit: 24,
      });
      setResults(res.servers || []);
    } catch {
      setResults([]);
    }
    setIsSearching(false);
  }, [query, category, sortBy, hasUi, officialOnly]);

  useEffect(() => {
    refreshServers();
    refreshAgents();
    const unsub = window.surge.mcp.onServerEvent(() => refreshServers());
    window.surge.discovery.categories().then(setCategories).catch(() => {});
    return unsub;
  }, [refreshServers, refreshAgents]);

  // Re-run discovery when filters change.
  useEffect(() => {
    runDiscovery();
  }, [category, sortBy, hasUi, officialOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildConnectConfig = (s: IndexServer): McpServerConfig => {
    if (s.supportsDiscovery && s.discoveryUrl) {
      return { id: s.slug, name: s.name, transport: 'sse', url: s.discoveryUrl };
    }
    let command = 'npx';
    let args: string[] = ['-y', s.npmPackage || s.slug];
    if (s.installCommand && /\s/.test(s.installCommand)) {
      const parts = s.installCommand.trim().split(/\s+/);
      command = parts[0];
      args = parts.slice(1);
    }
    return { id: s.slug, name: s.name, transport: 'stdio', command, args };
  };

  const handleConnect = async (config: McpServerConfig) => {
    setConnectError('');
    setConnecting({ id: config.id, name: config.name });
    try {
      const res = await window.surge.mcp.connect(config);
      if (res?.error) setConnectError(`Couldn't connect ${config.name}: ${res.error}`);
    } catch (err: any) {
      setConnectError(`Couldn't connect ${config.name}: ${err.message || 'unknown error'}`);
    } finally {
      setConnecting(null);
      refreshServers();
    }
  };

  const handleSignOut = async (serverId: string) => {
    await window.surge.mcp.signOut(serverId);
    refreshServers();
  };

  const handleManualConnect = async () => {
    const input = connectCommand.trim();
    if (!input) return;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const url = new URL(input);
      handleConnect({
        id: `manual-${Date.now()}`,
        name: url.hostname + (url.port ? ':' + url.port : ''),
        transport: input.includes('/mcp') ? 'streamable-http' : 'sse',
        url: input,
      });
    } else {
      const parts = input.split(/\s+/);
      handleConnect({ id: `manual-${Date.now()}`, name: parts[0], transport: 'stdio', command: parts[0], args: parts.slice(1) });
    }
    setConnectCommand('');
    setShowManual(false);
  };

  const handleDisconnect = async (serverId: string) => {
    await window.surge.mcp.disconnect(serverId);
    refreshServers();
  };

  const toggleSimilar = async (slug: string) => {
    if (similar[slug]) {
      setSimilar((m) => { const n = { ...m }; delete n[slug]; return n; });
      return;
    }
    const list = await window.surge.discovery.similar(slug).catch(() => []);
    setSimilar((m) => ({ ...m, [slug]: list }));
  };

  const scoreColor = (score?: number | null): string => {
    if (score === null || score === undefined) return '';
    if (score >= 80) return 'badge-green';
    if (score >= 50) return 'badge-yellow';
    return 'badge-red';
  };

  const uiBadge = (s: IndexServer) =>
    s.uiType ? <span className="badge badge-purple" style={{ fontSize: '0.55rem' }}>{s.uiType === 'mcp-apps' ? 'MCP Apps' : 'MCP-UI'}</span> : null;

  const renderResult = (s: IndexServer) => (
    <div key={s.slug} className="sp-discovery-result">
      <div className="sp-discovery-info">
        <div className="sp-discovery-name">
          {s.name}
          {s.qualityScore != null && (
            <span className={`badge ${scoreColor(s.qualityScore)}`} style={{ marginLeft: 6, fontSize: '0.6rem' }}>
              {Math.round(s.qualityScore)}
            </span>
          )}
          {s.trustTier && (
            <span className={`badge ${trustClass(s.trustTier)}`} style={{ marginLeft: 4, fontSize: '0.55rem' }}>{s.trustTier}</span>
          )}
          {uiBadge(s)}
          {s.requiresAuth && <span className="badge badge-yellow" style={{ marginLeft: 4, fontSize: '0.55rem' }}>🔒 auth</span>}
        </div>
        <div className="sp-discovery-desc">{s.description}</div>
        <div className="sp-discovery-source">
          {typeof s.stars === 'number' ? `★ ${s.stars}  ` : ''}
          {typeof s.weeklyDownloads === 'number' ? `⬇ ${s.weeklyDownloads}/wk  ` : ''}
          {s.source}
          {' · '}
          <button className="btn-link" style={{ background: 'none', border: 'none', color: '#67e8f9', cursor: 'pointer', padding: 0 }} onClick={() => toggleSimilar(s.slug)}>
            {similar[s.slug] ? 'hide similar' : 'similar'}
          </button>
        </div>
        {similar[s.slug] && similar[s.slug].length > 0 && (
          <div className="sp-tools-list" style={{ marginTop: 4 }}>
            {similar[s.slug].map((sim) => (
              <span key={sim.slug} className="badge badge-cyan" title={sim.description}>{sim.name}</span>
            ))}
          </div>
        )}
      </div>
      <button className="btn-primary btn-sm" onClick={() => handleConnect(buildConnectConfig(s))}>
        <IconPlug size={13} /> Connect
      </button>
    </div>
  );

  return (
    <div className="server-panel-overlay">
      <div className="server-panel glass-panel slide-up">
        <div className="sp-header">
          <h3><IconBolt size={16} /> MCP Servers</h3>
          <button className="btn-icon" onClick={onClose}><IconX size={14} /></button>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">Connected ({servers.length})</div>
          {connecting && (
            <div className="sp-connecting" role="status">
              {connecting.signInUrl ? (
                <>
                  <span>Sign in to <strong>{connecting.name}</strong> in your browser to finish connecting.</span>
                  <div className="sp-connecting-actions">
                    <button className="btn-ghost btn-sm" onClick={() => window.surge.browser.openExternal(connecting.signInUrl!)}>Open the sign-in page again</button>
                    <button className="btn-ghost btn-sm" onClick={() => window.surge.mcp.cancelSignIn(connecting.id)}>Cancel</button>
                  </div>
                </>
              ) : (
                <span><span className="spinner spinner-sm" /> Connecting to {connecting.name}…</span>
              )}
            </div>
          )}
          {connectError && <div className="sp-connect-error" role="alert">{connectError}</div>}
          {servers.length === 0 ? (
            <div className="sp-empty">No servers connected</div>
          ) : (
            servers.map((s) => (
              <div key={s.id} className={`sp-server-card ${s.config.isMcpWeb ? 'mcpweb' : ''}`}>
                <div className="sp-server-header">
                  <span className={`sp-status-dot ${s.status}`}></span>
                  <span className="sp-server-name">{s.name}</span>
                  {s.virtual && <span className="badge badge-purple" style={{ fontSize: '0.6rem' }}>{s.source === 'in-process' ? 'local' : s.source === 'codegen' ? 'agent' : 'page'}</span>}
                  {s.config.isMcpWeb && <span className="badge badge-cyan" style={{ fontSize: '0.6rem' }}>MCPWeb</span>}
                  {s.signedIn && <span className="badge badge-green" style={{ fontSize: '0.6rem' }}>Signed in</span>}
                  {s.signedIn && (
                    <button className="btn-ghost btn-sm" title="Forget this server's sign-in and disconnect" onClick={() => handleSignOut(s.id)}>Sign out</button>
                  )}
                  {!s.virtual && (
                    <button className="btn-ghost btn-sm" onClick={() => handleDisconnect(s.id)}>Disconnect</button>
                  )}
                </div>
                <div className="sp-tools-list">
                  {s.tools.slice(0, 5).map((t) => (
                    <span key={t.name} className="badge badge-cyan">{t.name}</span>
                  ))}
                  {s.tools.length > 5 && <span className="sp-more">+{s.tools.length - 5} more</span>}
                </div>
              </div>
            ))
          )}
        </div>

        {agents.length > 0 && (
          <div className="sp-section">
            <div className="sp-section-title">Site Agents ({agents.length})</div>
            {agents.map((a) => (
              <div key={a.id} className="sp-server-card">
                <div className="sp-server-header">
                  <span className="sp-server-name">{a.name}</span>
                  {a.kind === 'codegen' && <span className="badge badge-red" style={{ fontSize: '0.55rem' }}>code</span>}
                  <span className="badge badge-purple" style={{ fontSize: '0.55rem' }}>{a.spec?.domain}</span>
                  <button className="btn-ghost btn-sm" onClick={() => removeAgent(a)}>Remove</button>
                </div>
                <div className="sp-tools-list">
                  {(a.spec?.tools || []).slice(0, 6).map((t) => (
                    <span key={t.name} className="badge badge-cyan">{t.name}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="sp-section">
          <div className="sp-section-title">Discover Servers (MCP Rating)</div>
          <div className="sp-discover-row">
            <input
              className="input"
              placeholder="Search MCP servers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runDiscovery()}
            />
            <button className="btn-primary btn-sm" onClick={runDiscovery} disabled={isSearching}>
              {isSearching ? <div className="spinner spinner-sm" /> : <IconSearch size={14} />}
            </button>
          </div>

          <div className="sp-filters" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
            <select className="input" value={sortBy} onChange={(e) => setSortBy(e.target.value as DiscoveryQuery['sortBy'])} style={{ flex: '0 0 auto' }}>
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} style={{ flex: '0 0 auto' }}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}{c.serverCount ? ` (${c.serverCount})` : ''}</option>)}
            </select>
            <label className="sp-chip" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.7rem' }}>
              <input type="checkbox" checked={hasUi} onChange={(e) => setHasUi(e.target.checked)} /> Has UI
            </label>
            <label className="sp-chip" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.7rem' }}>
              <input type="checkbox" checked={officialOnly} onChange={(e) => setOfficialOnly(e.target.checked)} /> Official
            </label>
          </div>

          {results.length === 0 && !isSearching && <div className="sp-empty">No results — try a search or start the MCP_Index registry.</div>}
          {results.map(renderResult)}
        </div>

        <div className="sp-section">
          <button className="btn-ghost btn-sm" onClick={() => setShowManual(!showManual)} style={{ width: '100%' }}>
            {showManual ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
            &nbsp;Manual Connect
          </button>
          {showManual && (
            <div className="sp-manual fade-in">
              <input
                className="input"
                placeholder="http://localhost:3000/sse or npx -y @mcp/server"
                value={connectCommand}
                onChange={(e) => setConnectCommand(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleManualConnect()}
              />
              <button className="btn-primary btn-sm" onClick={handleManualConnect}>
                <IconPlug size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ServerPanel;
