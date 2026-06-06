import React, { useRef, useEffect, useState } from 'react';
import './McpAppRenderer.css';

interface McpAppRendererProps {
  htmlContent: string;
  toolName: string;
  serverName?: string;
  onOpenLink?: (url: string) => void;
  onMessage?: (data: any) => void;
}

/**
 * Renders MCP App UI content in a sandboxed iframe.
 * Supports rich HTML including images, tables, video, audio, and interactive elements.
 * All content runs in a secure sandboxed environment.
 */
const McpAppRenderer: React.FC<McpAppRendererProps> = ({
  htmlContent,
  toolName,
  serverName,
  onOpenLink,
  onMessage,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [iframeHeight, setIframeHeight] = useState(200);

  useEffect(() => {
    if (!iframeRef.current || !htmlContent) return;

    // Wrap the HTML content with styling and message passing
    const wrappedHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            color: #f1f5f9;
            background: #111827;
            padding: 16px;
            line-height: 1.6;
            font-size: 14px;
          }
          a { color: #67e8f9; }
          img { max-width: 100%; border-radius: 8px; }
          video, audio { max-width: 100%; border-radius: 8px; }
          table { width: 100%; border-collapse: collapse; margin: 8px 0; }
          th, td { padding: 8px 12px; border: 1px solid rgba(99,102,241,0.15); text-align: left; }
          th { background: rgba(17,24,39,0.9); color: #67e8f9; font-weight: 600; }
          tr:hover { background: rgba(99,102,241,0.05); }
          pre { background: #0a0e1a; border: 1px solid rgba(99,102,241,0.15); border-radius: 8px; padding: 12px; overflow-x: auto; }
          code { font-family: 'JetBrains Mono', monospace; font-size: 13px; }
          h1, h2, h3 { color: #f1f5f9; margin: 12px 0 8px; }
          button { background: linear-gradient(135deg, #06b6d4, #8b5cf6); color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; }
          button:hover { opacity: 0.9; }
          input, select, textarea { background: rgba(15,20,35,0.9); border: 1px solid rgba(99,102,241,0.15); color: #f1f5f9; padding: 8px 12px; border-radius: 8px; font-family: inherit; }
          input:focus, textarea:focus { outline: none; border-color: #06b6d4; }
          .chart, .dashboard { border: 1px solid rgba(99,102,241,0.15); border-radius: 8px; padding: 16px; margin: 8px 0; }
        </style>
      </head>
      <body>
        ${htmlContent}
        <script>
          // Report height to parent for auto-sizing
          function reportHeight() {
            const height = document.body.scrollHeight;
            window.parent.postMessage({ type: 'surge:resize', height }, '*');
          }

          // Observe size changes
          const observer = new ResizeObserver(reportHeight);
          observer.observe(document.body);
          reportHeight();

          // Intercept link clicks
          document.addEventListener('click', (e) => {
            const anchor = e.target.closest('a');
            if (anchor && anchor.href) {
              e.preventDefault();
              window.parent.postMessage({ type: 'surge:openLink', url: anchor.href }, '*');
            }
          });

          // Allow content to send messages to host
          window.surgeMessage = (data) => {
            window.parent.postMessage({ type: 'surge:message', data }, '*');
          };
        </script>
      </body>
      </html>
    `;

    const blob = new Blob([wrappedHtml], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    iframeRef.current.src = blobUrl;

    return () => URL.revokeObjectURL(blobUrl);
  }, [htmlContent]);

  // Listen for messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'surge:resize':
          setIframeHeight(Math.min(Math.max(data.height || 200, 100), 800));
          setIsLoading(false);
          break;
        case 'surge:openLink':
          if (data.url && onOpenLink) onOpenLink(data.url);
          break;
        case 'surge:message':
          if (onMessage) onMessage(data.data);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onOpenLink, onMessage]);

  return (
    <div className="mcp-app-renderer">
      <div className="mar-header">
        <span className="mar-icon">📱</span>
        <span className="mar-label">MCP App</span>
        {serverName && <span className="badge badge-cyan">{serverName}</span>}
        <span className="mar-tool-name">{toolName}</span>
      </div>

      <div className="mar-content">
        {isLoading && (
          <div className="mar-loading">
            <div className="spinner"></div>
            <span>Loading MCP UI...</span>
          </div>
        )}
        <iframe
          ref={iframeRef}
          className="mar-iframe"
          style={{ height: `${iframeHeight}px`, opacity: isLoading ? 0 : 1 }}
          sandbox="allow-scripts allow-same-origin"
          title={`MCP App: ${toolName}`}
        />
      </div>
    </div>
  );
};

export default McpAppRenderer;
