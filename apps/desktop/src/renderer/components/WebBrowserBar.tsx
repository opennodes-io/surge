import React, { useState, useEffect } from 'react';
import { IconArrowLeft, IconArrowRight, IconRefresh, IconPlug, IconStar } from './Icons';
import type { McpWebCapabilities } from '../types';
import './WebBrowserBar.css';

interface WebBrowserBarProps {
  onNavigate: (url: string) => void;
  onBack?: () => void;
  onForward?: () => void;
  onRefresh?: () => void;
  currentUrl?: string;
  mcpWebCapabilities?: McpWebCapabilities | null;
  mcpWebConnected?: boolean;
  onShowMcpWeb?: () => void;
  onOpenInBrowser?: () => void;
  onOpenExternal?: () => void;
  onBookmark?: () => void;
}

const WebBrowserBar: React.FC<WebBrowserBarProps> = ({
  onNavigate,
  onBack,
  onForward,
  onRefresh,
  currentUrl = '',
  mcpWebCapabilities,
  mcpWebConnected = false,
  onShowMcpWeb,
  onOpenInBrowser,
  onOpenExternal,
  onBookmark,
}) => {
  const [url, setUrl] = useState(currentUrl);
  const [isDetecting, setIsDetecting] = useState(false);

  useEffect(() => {
    setUrl(currentUrl);
  }, [currentUrl]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let navigateUrl = url.trim();
    if (!navigateUrl) return;

    if (!/^https?:\/\//i.test(navigateUrl)) {
      if (navigateUrl.includes('.') && !navigateUrl.includes(' ')) {
        navigateUrl = `https://${navigateUrl}`;
      } else {
        return;
      }
    }

    setUrl(navigateUrl);
    onNavigate(navigateUrl);
  };

  const handleDetectMcpWeb = async () => {
    if (!url) return;
    setIsDetecting(true);
    try {
      await window.surge?.mcpweb?.detect(url);
    } catch {}
    setIsDetecting(false);
  };

  return (
    <div className="web-browser-bar">
      <div className="wbb-controls">
        <button className="btn-icon" onClick={onBack} title="Back">
          <IconArrowLeft size={15} />
        </button>
        <button className="btn-icon" onClick={onForward} title="Forward">
          <IconArrowRight size={15} />
        </button>
        <button className="btn-icon" onClick={onRefresh} title="Refresh">
          <IconRefresh size={15} />
        </button>
      </div>

      <form className="wbb-url-form" onSubmit={handleSubmit}>
        <div className="wbb-url-wrapper">
          {/* MCPWeb indicator — shows connection status */}
          {mcpWebCapabilities?.supported && (
            <button
              type="button"
              className={`wbb-mcp-indicator ${mcpWebConnected ? 'connected' : ''}`}
              onClick={onShowMcpWeb}
              title={mcpWebConnected ? 'MCPWeb connected — click to toggle tools' : 'MCPWeb detected'}
            >
              <span className="wbb-mcp-dot"></span>
              {mcpWebConnected ? '⚡MCP' : 'MCP'}
            </button>
          )}
          <input
            type="text"
            className="wbb-url-input"
            placeholder="Enter URL or search..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {isDetecting && <div className="spinner spinner-sm"></div>}
        </div>
      </form>

      <div className="wbb-actions">
        <button
          className="btn-icon"
          onClick={handleDetectMcpWeb}
          title="Check for MCPWeb support"
          disabled={isDetecting}
        >
          <IconPlug size={15} />
        </button>
        {onBookmark && currentUrl && (
          <button className="btn-icon" onClick={onBookmark} title="Bookmark this page">
            <IconStar size={15} />
          </button>
        )}
        {onOpenExternal && currentUrl && (
          <button
            className="btn-icon"
            onClick={onOpenExternal}
            title="Open in system browser"
          >
            &#8599;
          </button>
        )}
      </div>
    </div>
  );
};

export default WebBrowserBar;
