import React, { useState, useEffect } from 'react';
import { IconBolt, IconSearch, IconX, IconPlug, IconChevronDown, IconChevronUp } from './Icons';
import type { ConnectedServer, McpServerConfig } from '../types';
import './ServerPanel.css';

interface ServerPanelProps {
  onClose: () => void;
}

const ServerPanel: React.FC<ServerPanelProps> = ({ onClose }) => {
  const [servers, setServers] = useState<ConnectedServer[]>([]);
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const [discoveryResults, setDiscoveryResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [connectCommand, setConnectCommand] = useState('');
  const [showManual, setShowManual] = useState(false);

  const refreshServers = async () => {
    const list = await window.surge.mcp.getServers();
    setServers(list);
  };

  useEffect(() => {
    refreshServers();
    const unsub = window.surge.mcp.onServerEvent(() => refreshServers());
    return unsub;
  }, []);

  const handleDiscover = async () => {
    if (!discoveryQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await window.surge.mcp.discover(discoveryQuery);
      setDiscoveryResults(results);
    } catch {
      setDiscoveryResults([]);
    }
    setIsSearching(false);
  };

  const handleConnect = async (config: McpServerConfig) => {
    try {
      await window.surge.mcp.connect(config);
      refreshServers();
    } catch (err: any) {
      alert(err.message || 'Failed to connect');
    }
  };

  const handleManualConnect = async () => {
    if (!connectCommand.trim()) return;
    const input = connectCommand.trim();

    // Detect if user pasted a URL (SSE/streamable-http endpoint)
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const url = new URL(input);
      // Use 'sse' transport which auto-tries streamable-http first, then falls back to SSE
      handleConnect({
        id: `manual-${Date.now()}`,
        name: url.hostname + (url.port ? ':' + url.port : ''),
        transport: input.includes('/mcp') ? 'streamable-http' : 'sse',
        url: input,
      });
    } else {
      // Stdio: split command and args
      const parts = input.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);
      handleConnect({
        id: `manual-${Date.now()}`,
        name: cmd,
        transport: 'stdio',
        command: cmd,
        args,
      });
    }
    setConnectCommand('');
    setShowManual(false);
  };

  const handleDisconnect = async (serverId: string) => {
    await window.surge.mcp.disconnect(serverId);
    refreshServers();
  };

  // Build connect config from discovery result
  const buildConnectConfig = (result: any): McpServerConfig => {
    // If the server has a discovery URL (MCPWeb endpoint), use SSE transport
    if (result.hasDiscovery && result.discoveryUrl) {
      return {
        id: result.id,
        name: result.name,
        transport: 'sse',
        url: result.discoveryUrl,
      };
    }
    // Default: use stdio with npx
    return {
      id: result.id,
      name: result.name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', result.id],
    };
  };

  // Quality score color
  const scoreColor = (score: number | null): string => {
    if (score === null || score === undefined) return '';
    if (score >= 80) return 'badge-green';
    if (score >= 50) return 'badge-yellow';
    return 'badge-red';
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
          {servers.length === 0 ? (
            <div className="sp-empty">No servers connected</div>
          ) : (
            servers.map(s => (
              <div key={s.id} className={`sp-server-card ${s.config.isMcpWeb ? 'mcpweb' : ''}`}>
                <div className="sp-server-header">
                  <span className={`sp-status-dot ${s.status}`}></span>
                  <span className="sp-server-name">{s.name}</span>
                  {s.config.isMcpWeb && <span className="badge badge-cyan" style={{ fontSize: '0.6rem' }}>MCPWeb</span>}
                  <button className="btn-ghost btn-sm" onClick={() => handleDisconnect(s.id)}>
                    Disconnect
                  </button>
                </div>
                <div className="sp-tools-list">
                  {s.tools.slice(0, 5).map(t => (
                    <span key={t.name} className="badge badge-cyan">{t.name}</span>
                  ))}
                  {s.tools.length > 5 && (
                    <span className="sp-more">+{s.tools.length - 5} more</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="sp-section">
          <div className="sp-section-title">Discover Servers</div>
          <div className="sp-discover-row">
            <input
              className="input"
              placeholder="Search MCP servers..."
              value={discoveryQuery}
              onChange={e => setDiscoveryQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleDiscover()}
            />
            <button className="btn-primary btn-sm" onClick={handleDiscover} disabled={isSearching}>
              {isSearching ? <div className="spinner spinner-sm" /> : <IconSearch size={14} />}
            </button>
          </div>

          {discoveryResults.map((r, i) => (
            <div key={i} className="sp-discovery-result">
              <div className="sp-discovery-info">
                <div className="sp-discovery-name">
                  {r.name}
                  {r.qualityScore !== null && r.qualityScore !== undefined && (
                    <span className={`badge ${scoreColor(r.qualityScore)}`} style={{ marginLeft: 6, fontSize: '0.6rem' }}>
                      {Math.round(r.qualityScore)}
                    </span>
                  )}
                  {r.hasDiscovery && (
                    <span className="badge badge-cyan" style={{ marginLeft: 4, fontSize: '0.55rem' }}>MCPWeb</span>
                  )}
                </div>
                <div className="sp-discovery-desc">{r.description}</div>
                {r.source && (
                  <div className="sp-discovery-source">{r.source}</div>
                )}
              </div>
              <button
                className="btn-primary btn-sm"
                onClick={() => handleConnect(buildConnectConfig(r))}
              >
                <IconPlug size={13} /> Connect
              </button>
            </div>
          ))}
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
                placeholder="http://localhost:3000/sse or npx -y @mcp/server ."
                value={connectCommand}
                onChange={e => setConnectCommand(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleManualConnect()}
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
