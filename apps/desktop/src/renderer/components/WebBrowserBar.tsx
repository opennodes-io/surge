import React, { useState, useEffect } from 'react';
import { IconArrowLeft, IconArrowRight, IconRefresh, IconPlug, IconStar, IconX } from './Icons';
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
  onCreateAgent?: () => void;
  creatingAgent?: boolean;
  /** Checks the page for MCPWeb / MCP-B; the parent reports the result through `notice`. */
  onCheckMcpWeb?: (url: string) => Promise<void>;
  /** A message under the bar (why "Create agent" failed, what the MCPWeb check found), with an optional action. */
  notice?: { text: string; tone?: 'error' | 'info' | 'success'; actionLabel?: string; onAction?: () => void } | null;
  onDismissNotice?: () => void;
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
  onCreateAgent,
  creatingAgent,
  onCheckMcpWeb,
  notice,
  onDismissNotice,
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

  // The open page, or what's typed in the bar if no page is open yet.
  const typed = url.trim();
  const checkTarget = currentUrl || (typed && (/^https?:\/\//i.test(typed) ? typed : `https://${typed}`));

  const handleDetectMcpWeb = async () => {
    if (!checkTarget || !onCheckMcpWeb) return;
    setIsDetecting(true);
    try {
      await onCheckMcpWeb(checkTarget);
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <>
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
            title={checkTarget ? 'Check for MCPWeb support' : 'Open a page to check it for MCPWeb support'}
            disabled={isDetecting || !checkTarget}
          >
            {isDetecting ? <div className="spinner spinner-sm" /> : <IconPlug size={15} />}
          </button>
          {onBookmark && currentUrl && (
            <button className="btn-icon" onClick={onBookmark} title="Bookmark this page">
              <IconStar size={15} />
            </button>
          )}
          {onCreateAgent && currentUrl && (
            <button className="btn-icon" onClick={onCreateAgent} title="Create an MCP agent for this site" disabled={creatingAgent}>
              {creatingAgent ? <div className="spinner spinner-sm" /> : <span style={{ fontSize: 14 }}>✨</span>}
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
      {notice && (
        <div className={`wbb-notice tone-${notice.tone || 'error'}`} role={notice.tone === 'info' || notice.tone === 'success' ? 'status' : 'alert'}>
          <span className="wbb-notice-text">{notice.text}</span>
          <div className="wbb-notice-actions">
            {notice.actionLabel && notice.onAction && (
              <button className="btn-ghost btn-sm" onClick={notice.onAction} disabled={creatingAgent}>
                {notice.actionLabel}
              </button>
            )}
            {onDismissNotice && (
              <button className="btn-icon" onClick={onDismissNotice} title="Dismiss" aria-label="Dismiss">
                <IconX size={13} />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default WebBrowserBar;
