# @surge/mobile (Capacitor scaffold)

A **scaffold** mobile shell for Surge. It demonstrates the monorepo's shared-core design: the same `@surge/core` package powers desktop, the standalone MCP servers, and (here) mobile.

This milestone ships the scaffold only — **native projects are not generated**. To build the native apps later:

```bash
pnpm --filter @surge/mobile build       # build the web bundle (webDir: dist)
pnpm --filter @surge/mobile cap:add:android
pnpm --filter @surge/mobile cap:add:ios
pnpm --filter @surge/mobile cap:sync
```

## Capability gating

Mobile runs in a Capacitor WebView with no Electron `WebContentsView` compositor, so the
embedded-browser "browser replacement" surface and the **Web→MCP adapter** (which require a
`BrowserPort`) are disabled (see `src/capabilities.ts`). What *does* work on mobile:

- MCP connections over **HTTP/SSE** (not stdio)
- **Discovery + MCP Rating** (via the registry REST API — needs CORS enabled on MCP_Index)
- **Bookmarks & history** via the standalone `surge-bookmarks-mcp` over HTTP

The full chat/MCP UI will be shared via a future `@surge/ui` package; today the desktop
renderer holds the React components.
