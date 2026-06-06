import React, { useState } from 'react';
import { IconBolt, IconFile, IconGlobe } from './Icons';
import type { McpWebCapabilities, McpTool } from '../types';
import './McpWebPanel.css';

interface McpWebPanelProps {
  capabilities: McpWebCapabilities;
  connected?: boolean;
  connecting?: boolean;
  connectedTools?: McpTool[];
  onCallTool?: (toolName: string) => void;
  onBrowse?: () => void;
  onOpenExternal?: () => void;
  onDisconnect?: () => void;
}

// Map common tool name patterns to friendly labels and icons
function friendlyToolLabel(name: string): { label: string; icon: string } {
  const lower = name.toLowerCase();
  if (lower.includes('search') || lower.includes('find') || lower.includes('query'))
    return { label: prettify(name, 'Search'), icon: '\uD83D\uDD0D' };
  if (lower.includes('create') || lower.includes('add') || lower.includes('new') || lower.includes('post'))
    return { label: prettify(name, 'Create'), icon: '\u2795' };
  if (lower.includes('update') || lower.includes('edit') || lower.includes('modify'))
    return { label: prettify(name, 'Edit'), icon: '\u270F\uFE0F' };
  if (lower.includes('delete') || lower.includes('remove'))
    return { label: prettify(name, 'Remove'), icon: '\uD83D\uDDD1\uFE0F' };
  if (lower.includes('get') || lower.includes('read') || lower.includes('fetch') || lower.includes('list'))
    return { label: prettify(name, 'View'), icon: '\uD83D\uDCC4' };
  if (lower.includes('send') || lower.includes('submit'))
    return { label: prettify(name, 'Send'), icon: '\uD83D\uDCE8' };
  if (lower.includes('translate'))
    return { label: 'Translate', icon: '\uD83C\uDF10' };
  if (lower.includes('summarize') || lower.includes('summary'))
    return { label: 'Summarize', icon: '\uD83D\uDCDD' };
  if (lower.includes('book') || lower.includes('reserve'))
    return { label: prettify(name, 'Book'), icon: '\uD83D\uDCB3' };
  if (lower.includes('download') || lower.includes('export'))
    return { label: prettify(name, 'Download'), icon: '\u2B07\uFE0F' };
  if (lower.includes('upload') || lower.includes('import'))
    return { label: prettify(name, 'Upload'), icon: '\u2B06\uFE0F' };
  if (lower.includes('analyze') || lower.includes('chart') || lower.includes('stats'))
    return { label: prettify(name, 'Analyze'), icon: '\uD83D\uDCCA' };
  if (lower.includes('convert') || lower.includes('transform'))
    return { label: prettify(name, 'Convert'), icon: '\uD83D\uDD04' };
  if (lower.includes('login') || lower.includes('auth') || lower.includes('sign'))
    return { label: 'Sign In', icon: '\uD83D\uDD10' };
  if (lower.includes('play') || lower.includes('stream'))
    return { label: prettify(name, 'Play'), icon: '\u25B6\uFE0F' };
  return { label: prettify(name, ''), icon: '\u26A1' };
}

function prettify(name: string, fallbackAction: string): string {
  const cleaned = name
    .replace(/^(search|get|list|create|update|delete|find|fetch|add|remove|send|submit|post|read)[-_]?/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!cleaned) return fallbackAction || name;
  return (fallbackAction ? fallbackAction + ' ' : '') + cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

const McpWebPanel: React.FC<McpWebPanelProps> = ({
  capabilities,
  connected = false,
  connecting = false,
  connectedTools = [],
  onCallTool,
  onBrowse,
  onOpenExternal,
  onDisconnect,
}) => {
  const [activeTool, setActiveTool] = useState<string | null>(null);

  if (!capabilities.supported) return null;

  const displayTools = connectedTools.length > 0
    ? connectedTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    : capabilities.tools || [];

  return (
    <div className="mcpweb-panel glass-panel scale-in">
      {/* Header */}
      <div className="mwp-header">
        <div className="mwp-header-left">
          <span className={`mwp-indicator ${connected ? 'connected' : connecting ? 'connecting' : ''}`}></span>
          <span className="mwp-label">
            {connecting ? 'Connecting...' : connected ? 'AI-Powered Site' : 'AI Features Detected'}
          </span>
        </div>
        <div className="mwp-header-right">
          <button className="btn-ghost btn-sm" onClick={onBrowse} title="View as regular website">
            <IconGlobe size={13} /> Browse
          </button>
          {onOpenExternal && (
            <button className="btn-ghost btn-sm" onClick={onOpenExternal} title="Open in system browser">
              &#8599;
            </button>
          )}
          {connected && onDisconnect && (
            <button className="btn-ghost btn-sm btn-disconnect" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Site info */}
      {capabilities.serverInfo && (
        <div className="mwp-info">
          <div className="mwp-server-name">{capabilities.serverInfo.name}</div>
          {capabilities.serverInfo.description && (
            <div className="mwp-server-desc">{capabilities.serverInfo.description}</div>
          )}
          {connected && (
            <div className="mwp-site-hint">
              Click an action below or just ask in chat — AI will handle the rest
            </div>
          )}
        </div>
      )}

      {connecting && (
        <div className="mwp-connecting">
          <div className="spinner spinner-sm" />
          <span>Detecting AI capabilities...</span>
        </div>
      )}

      {/* Action buttons — friendly, non-technical */}
      {displayTools.length > 0 && (
        <div className="mwp-section">
          <div className="mwp-section-title">
            {connected ? 'What would you like to do?' : 'Available Actions'}
          </div>
          <div className="mwp-actions">
            {displayTools.map((tool, i) => {
              const friendly = friendlyToolLabel(tool.name);
              return (
                <button
                  key={i}
                  className={`mwp-action-btn ${activeTool === tool.name ? 'active' : ''} ${connected ? 'live' : ''}`}
                  onClick={() => {
                    setActiveTool(tool.name);
                    onCallTool?.(tool.name);
                  }}
                  disabled={!connected && !onCallTool}
                  title={tool.description || tool.name}
                >
                  <span className="mwp-action-icon">{friendly.icon}</span>
                  <span className="mwp-action-label">{friendly.label}</span>
                </button>
              );
            })}
          </div>

          {/* Technical detail for power users on selection */}
          {activeTool && (
            <div className="mwp-tool-detail fade-in">
              <span className="mwp-detail-name">{activeTool}</span>
              <span className="mwp-detail-desc">
                {displayTools.find(t => t.name === activeTool)?.description || ''}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Resources */}
      {capabilities.resources && capabilities.resources.length > 0 && (
        <div className="mwp-section">
          <div className="mwp-section-title">Data Sources</div>
          <div className="mwp-resources">
            {capabilities.resources.map((res, i) => (
              <div key={i} className="mwp-resource-item">
                <span className="mwp-resource-icon"><IconFile size={14} /></span>
                <div className="mwp-resource-info">
                  <div className="mwp-resource-name">{res.name}</div>
                  {res.description && <div className="mwp-resource-desc">{res.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default McpWebPanel;
