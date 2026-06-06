import React, { useRef, useEffect, useState } from 'react';
import './McpAppRenderer.css';

export type HostAction =
  | { type: 'tool'; payload: { toolName: string; params?: any; serverId?: string } }
  | { type: 'prompt'; payload: { text: string } }
  | { type: 'link'; payload: { url: string } }
  | { type: 'notify'; payload: { message: string } };

interface McpAppRendererProps {
  /** Inline HTML (mcp-ui text/html or Apps-SDK template). */
  htmlContent?: string;
  /** External URL app (mcp-ui text/uri-list). */
  url?: string;
  toolName: string;
  serverName?: string;
  serverId?: string;
  onHostAction?: (action: HostAction) => void;
}

const MIN_H = 100;
const MAX_H = 800;

/**
 * Renders MCP Apps / MCP-UI content. Inline HTML runs in a null-origin sandbox
 * (srcdoc + allow-scripts only, strict CSP) so server-provided markup can never reach
 * the Surge renderer's origin/DOM. External URL apps load in a sandboxed iframe under
 * their own remote origin. The iframe talks to the host via window.mcpUi.postMessage.
 */
const McpAppRenderer: React.FC<McpAppRendererProps> = ({
  htmlContent,
  url,
  toolName,
  serverName,
  serverId,
  onHostAction,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [iframeHeight, setIframeHeight] = useState(200);

  const isUrlApp = !!url && !htmlContent;

  // Build the srcdoc for inline HTML apps.
  const srcDoc = !isUrlApp
    ? `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; media-src data: https:; font-src data: https:; connect-src 'none'; form-action 'none';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: #f1f5f9; background: #111827; padding: 16px; line-height: 1.6; font-size: 14px; }
  a { color: #67e8f9; }
  img, video, audio { max-width: 100%; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { padding: 8px 12px; border: 1px solid rgba(99,102,241,0.15); text-align: left; }
  th { background: rgba(17,24,39,0.9); color: #67e8f9; font-weight: 600; }
  pre { background: #0a0e1a; border: 1px solid rgba(99,102,241,0.15); border-radius: 8px; padding: 12px; overflow-x: auto; }
  button { background: linear-gradient(135deg, #06b6d4, #8b5cf6); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; }
  input, select, textarea { background: rgba(15,20,35,0.9); border: 1px solid rgba(99,102,241,0.15); color: #f1f5f9; padding: 8px 12px; border-radius: 8px; font-family: inherit; }
</style>
</head>
<body>
${htmlContent ?? ''}
<script>
(function(){
  function send(type, payload){ window.parent.postMessage({ __mcpUi: true, type: type, payload: payload || {} }, '*'); }
  // MCP-UI host API
  window.mcpUi = {
    postMessage: function(msg){ if (msg && msg.type) send(msg.type, msg.payload); },
    callTool: function(toolName, params){ send('tool', { toolName: toolName, params: params }); },
    sendPrompt: function(text){ send('prompt', { text: text }); },
    openLink: function(url){ send('link', { url: url }); },
    notify: function(message){ send('notify', { message: message }); }
  };
  // Back-compat with the previous surgeMessage bridge
  window.surgeMessage = function(data){ send('notify', { message: typeof data === 'string' ? data : JSON.stringify(data) }); };
  function reportHeight(){ send('resize', { height: document.body.scrollHeight }); }
  try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) {}
  reportHeight();
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href){ e.preventDefault(); send('link', { url: a.href }); }
  });
})();
</script>
</body>
</html>`
    : undefined;

  // Listen for host messages from the iframe (validated against the iframe's window).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data: any = event.data;
      if (!data || typeof data !== 'object' || !data.__mcpUi) return;
      const payload = data.payload || {};
      switch (data.type) {
        case 'resize':
          setIframeHeight(Math.min(Math.max(payload.height || 200, MIN_H), MAX_H));
          setIsLoading(false);
          break;
        case 'tool':
          onHostAction?.({ type: 'tool', payload: { toolName: payload.toolName, params: payload.params, serverId } });
          break;
        case 'prompt':
          onHostAction?.({ type: 'prompt', payload: { text: payload.text || payload.prompt || '' } });
          break;
        case 'link':
          if (payload.url) onHostAction?.({ type: 'link', payload: { url: payload.url } });
          break;
        case 'notify':
          onHostAction?.({ type: 'notify', payload: { message: payload.message || '' } });
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onHostAction, serverId]);

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
            <span>Loading MCP UI…</span>
          </div>
        )}
        {isUrlApp ? (
          <iframe
            ref={iframeRef}
            className="mar-iframe"
            style={{ height: `${iframeHeight}px`, opacity: isLoading ? 0 : 1 }}
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onLoad={() => setIsLoading(false)}
            title={`MCP App: ${toolName}`}
          />
        ) : (
          <iframe
            ref={iframeRef}
            className="mar-iframe"
            style={{ height: `${iframeHeight}px`, opacity: isLoading ? 0 : 1 }}
            srcDoc={srcDoc}
            sandbox="allow-scripts"
            title={`MCP App: ${toolName}`}
          />
        )}
      </div>
    </div>
  );
};

export default McpAppRenderer;
