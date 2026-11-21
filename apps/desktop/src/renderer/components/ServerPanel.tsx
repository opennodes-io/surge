import React, { useState, useEffect, useCallback } from 'react';
import { IconBolt, IconSearch, IconX, IconPlug, IconChevronDown, IconChevronUp } from './Icons';
import { connectConfigFor } from '@surge/core/discovery';
import type { ConnectedServer, McpServerConfig, IndexServer, IndexCategory, DiscoveryQuery, DiscoveryOrigin, SavedAgent, McpAuthStatus } from '../types';
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

const hostOf = (url?: string): string => {
  try { return url ? new URL(url).host : ''; } catch { return url || ''; }
};

const SAFETY_CLASS: Record<string, string> = { safe: 'badge-green', caution: 'badge-yellow', risk: 'badge-red' };

// The index's safety flags, in a few words (its own reasons are longer).
const FLAG_LABELS: Record<string, string> = {
  abandoned: 'abandoned',
  stale: 'stale',
  archived: 'archived repo',
  deprecated: 'deprecated',
  'no-license': 'no license',
  'no-repository': 'no public repo',
  'no-install-command': 'no install command',
  'unverified-publisher': 'unverified publisher',
  'install-script-risk': 'risky install script',
  'possible-typosquat': 'possible typosquat',
  'low-adoption': 'little use',
};
const flagLabel = (f: string) => FLAG_LABELS[f] || f.replace(/[-_]+/g, ' ');

// The index's start test: did its harness start the server and list its tools.
const START_TEST: Record<string, { label: string; cls: string }> = {
  verified: { label: 'start test: passed', cls: 'badge-green' },
  needs_credentials: { label: 'start test: needs credentials', cls: 'badge-yellow' },
  failed_to_start: { label: 'start test: failed', cls: 'badge-red' },
};

/** One line under the section title: where these listings come from, and who runs that source. */
function sourceNote(from: DiscoveryOrigin | null): { text: string; warn?: boolean } | null {
  if (!from) return null;
  const change = 'Change the source in Settings → Advanced.';
  const host = hostOf(from.url);
  if (from.kind === 'none') {
    return { text: `Couldn't reach ${from.failed ? `${hostOf(from.failed)} or ` : ''}${host}. ${change}`, warn: true };
  }
  if (from.kind === 'registry') {
    const what = host === 'registry.modelcontextprotocol.io' ? 'the official MCP Registry' : host;
    return from.fallback
      ? { text: `${hostOf(from.failed)} didn't answer, so these come from ${what} (listings only, no ratings).`, warn: true }
      : { text: `Listings from ${what}, which doesn't rate servers. ${change}` };
  }
  if (host === 'mcprating.io') return { text: `Listings and ratings from mcprating.io, which has the same maintainer as Surge. ${change}` };
  return { text: `Listings from ${host}. ${change}` };
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
  const [origin, setOrigin] = useState<DiscoveryOrigin | null>(null);
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
      setOrigin(res.from || null);
    } catch {
      setResults([]);
      setOrigin(null);
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

  // The listing's endpoint or install command; null when it gives neither (no command is made up
  // from a name, which could run an unrelated package).
  const buildConnectConfig = (s: IndexServer): McpServerConfig | null => connectConfigFor(s);

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

  // A manual server's id comes from its address (FNV-1a), so adding the same URL or command again is
  // the same server, not another saved copy. It stays within tool-name characters ([a-z0-9-]).
  const manualId = (address: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 0x01000193) >>> 0;
    return `manual-${h.toString(36)}`;
  };

  const handleManualConnect = async () => {
    const input = connectCommand.trim();
    if (!input) return;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const url = new URL(input);
      handleConnect({
        id: manualId(input),
        name: url.hostname + (url.port ? ':' + url.port : ''),
        transport: input.includes('/mcp') ? 'streamable-http' : 'sse',
        url: input,
      });
    } else {
      const parts = input.split(/\s+/);
      handleConnect({ id: manualId(input), name: parts[0], transport: 'stdio', command: parts[0], args: parts.slice(1) });
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

  const sourceHost = hostOf(origin?.url);
  const indexName = sourceHost || 'the index';

  const tierTitle = (s: IndexServer) =>
    s.tierBasis === 'source'
      ? `Trust tier from ${indexName}, capped by its safety score`
      : 'Estimated by Surge from the quality score; the source sent no tier';

  const startTestBadge = (s: IndexServer) => {
    if (s.source !== 'mcp-index') return null; // only an index runs start tests
    const t = s.startTest;
    const known = t ? START_TEST[t.outcome] : undefined;
    const when = t?.at ? ` on ${t.at.slice(0, 10)}` : '';
    let title: string;
    if (!t || !known) title = `${indexName} hasn't started this server${t?.outcome === 'unsupported' ? " (its harness can't test this transport)" : ''}`;
    else if (t.outcome === 'verified') title = `${indexName}'s harness started it${when}${t.tools != null ? ` and listed ${t.tools} tools` : ''}`;
    else title = `${indexName}'s harness tried it${when}: ${known.label.replace('start test: ', '')}`;
    return (
      <span className={`badge ${known?.cls || 'badge-muted'}`} title={title} style={{ fontSize: '0.55rem' }}>
        {known?.label || 'start test: not run'}
      </span>
    );
  };

  // The evidence behind the tier: safety score and flags, and the start test.
  const evidence = (s: IndexServer) => {
    const flags = s.safetyFlags || [];
    if (s.source !== 'mcp-index' && s.safetyScore == null && !flags.length) return null;
    return (
      <div className="sp-discovery-evidence">
        {s.safetyScore != null && (
          <span className={`badge ${SAFETY_CLASS[s.safetyBand || ''] || 'badge-muted'}`} title={`Safety score from ${indexName}: risk signals from public data, not a malware scan`} style={{ fontSize: '0.55rem' }}>
            safety {Math.round(s.safetyScore)}
          </span>
        )}
        {flags.map((f) => (
          <span key={f} className="sp-flag" title={f}>{flagLabel(f)}</span>
        ))}
        {startTestBadge(s)}
      </div>
    );
  };

  const renderResult = (s: IndexServer) => {
    const connect = buildConnectConfig(s);
    return (
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
            <span className={`badge ${trustClass(s.trustTier)}`} title={tierTitle(s)} style={{ marginLeft: 4, fontSize: '0.55rem' }}>{s.trustTier}</span>
          )}
          {uiBadge(s)}
          {s.requiresAuth && <span className="badge badge-yellow" style={{ marginLeft: 4, fontSize: '0.55rem' }}>🔒 auth</span>}
        </div>
        <div className="sp-discovery-desc">{s.description}</div>
        {evidence(s)}
        <div className="sp-discovery-source">
          {typeof s.stars === 'number' ? `★ ${s.stars}  ` : ''}
          {typeof s.weeklyDownloads === 'number' ? `⬇ ${s.weeklyDownloads}/wk  ` : ''}
          {s.source === 'mcp-registry' ? 'MCP Registry · not rated' : sourceHost || s.source}
          {s.source === 'mcp-index' && (
            <>
              {' · '}
              <button className="btn-link" style={{ background: 'none', border: 'none', color: 'var(--text-accent)', cursor: 'pointer', padding: 0, font: 'inherit' }} onClick={() => toggleSimilar(s.slug)}>
                {similar[s.slug] ? 'hide similar' : 'similar'}
              </button>
            </>
          )}
        </div>
        {similar[s.slug] && similar[s.slug].length > 0 && (
          <div className="sp-tools-list" style={{ marginTop: 4 }}>
            {similar[s.slug].map((sim) => (
              <span key={sim.slug} className="badge badge-cyan" title={sim.description}>{sim.name}</span>
            ))}
          </div>
        )}
      </div>
      <button
        className="btn-primary btn-sm"
        disabled={!connect}
        title={connect ? (connect.url ? `Connect to ${connect.url}` : `Runs: ${[connect.command, ...(connect.args || [])].join(' ')}`) : 'The listing gives no install command or endpoint. Add the server under Manual Connect.'}
        onClick={() => connect && handleConnect(connect)}
      >
        <IconPlug size={13} /> Connect
      </button>
    </div>
    );
  };

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
          <div className="sp-section-title">Discover Servers</div>
          {(() => {
            const note = sourceNote(origin);
            return note ? <div className={`sp-source-note${note.warn ? ' warn' : ''}`}>{note.text}</div> : null;
          })()}
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

          {results.length === 0 && !isSearching && (
            <div className="sp-empty">{origin?.note || (origin?.kind === 'none' ? 'No servers to show.' : 'No results. Try another search.')}</div>
          )}
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
