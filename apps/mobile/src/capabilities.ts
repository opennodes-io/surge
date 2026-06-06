// On mobile (Capacitor WebView) there is no Electron WebContentsView compositor, so the
// embedded-browser "browser replacement" surface and the Web->MCP adapter (which need a
// BrowserPort) are gated off. Pure-MCP features work over HTTP/SSE transports, and
// discovery + bookmarks/history (via the standalone server over HTTP) remain available.
export const capabilities = {
  browserPort: false,
  embeddedBrowser: false,
  webMcpAdapter: false,
  mcpStdio: false,
  mcpHttp: true,
  discovery: true,
};

export type Capabilities = typeof capabilities;
