/**
 * The minimal browsing surface core needs to expose website content as MCP tools
 * (the Web->MCP adapter). The Electron shell implements this over a WebContentsView
 * (executeJavaScript); a mobile shell may implement it over a WebView, or omit it
 * entirely (in which case the Web->MCP adapter is simply not registered).
 */
export interface BrowserPort {
  evaluate(js: string): Promise<any>;
  navigate(url: string): Promise<void> | void;
  loadURL?(url: string): Promise<void> | void;
  getUrl(): string | null;
  getTitle(): string | null;
}
