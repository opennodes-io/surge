# Surge — a modern MCP client

Surge is a state-of-the-art **Model Context Protocol (MCP)** client for general users and developers — a "browser for MCP." It discovers MCP servers (with quality ratings), connects over stdio/SSE/streamable-HTTP, renders **MCP Apps / MCP-UI** interactive surfaces, turns any website into callable tools, and keeps **bookmarks + history** that other MCP clients can share.

Surge is also a native **[OpenNodes](https://opennodes.io)** client: it discovers AI models from an ONP registry (trust tiers, measured latency, per-MTok pricing), pre-prices prompts with enforceable estimates, and invokes nodes directly with pinned offering/revision headers (`packages/core/src/onp/`). Together that makes Surge one client over both discovery layers — **models via OpenNodes, tools via MCP**.

## Monorepo layout (pnpm workspaces)

```
packages/core/                @surge/core — platform-agnostic logic (source-only TS, bundled by consumers)
  ai/         multi-vendor LLM service (Gemini, Groq, Claude, Mistral, Ollama, vLLM) + tool calling
  mcp/        MCP manager (stdio/SSE/HTTP), MCPWeb detector, virtual-server registry, in-process servers
  orchestrator/ multi-round tool-calling loop
  discovery/  typed MCP_Index REST client (quality scores, uiType, trust tiers) + registry.mcp.so fallback
  onp/        typed OpenNodes registry client (model offerings, trust tiers, estimates) + `onp` AI provider
  storage/    local-first SQLite (@libsql/client) — bookmarks/collections/tags/history/profiles/agents/chat
  ui/         MCP Apps / MCP-UI detection + plugin renderer registry
  webmcp/     Web→MCP ephemeral adapter (browser tools as a virtual MCP server)
  ports/      platform interfaces (settings/browser/secret) — the seam for desktop vs mobile
apps/desktop/                 @surge/desktop — Electron shell (window, WebContentsView, tray, thin IPC bridge)
apps/mobile/                  @surge/mobile — Capacitor scaffold (reuses @surge/core; browser features gated off)
servers/bookmarks-history-mcp/ @surge/bookmarks-history-mcp — standalone, reusable MCP server (stdio + HTTP)
```

## Key design choices

- **Shared core, thin shells.** All MCP/AI/storage/discovery logic lives in `@surge/core`, consumed by the desktop (esbuild bundles it; native deps stay external), the standalone server (tsup), and mobile.
- **Local-first storage via `@libsql/client`** — an N-API module that is ABI-stable across Electron *and* plain Node, so the desktop and the standalone server open the same `surge.db` with no native rebuild. The schema is sync-ready (UUID ids, `updated_at`, tombstones, `rev`, `origin_device_id`) for an optional Turso/libsql sync layer later.
- **Bookmarks + history are an MCP server**, so any MCP client (Claude Desktop, Cursor, …) can use Surge's bookmarks/history — see [`servers/bookmarks-history-mcp`](servers/bookmarks-history-mcp/README.md).
- **MCP-UI is sandboxed.** Inline server HTML renders in a null-origin iframe (`srcdoc` + `allow-scripts` only + strict CSP); the host bridge speaks the MCP-UI action protocol (tool / prompt / link / notify).
- **Web→MCP.** Browser page tools are registered as a virtual `browser` MCP server and routed uniformly; code-gen of persistent per-site agents is a designed seam (`AgentSpec` + `agents` table) for a later phase.

## Develop

```bash
pnpm install
pnpm build                 # build/typecheck every package
pnpm --filter @surge/desktop dev     # run the desktop app
pnpm --filter @surge/bookmarks-history-mcp build   # build the standalone MCP server
```

## Status

First revision milestone implemented: monorepo + shared core, standalone bookmarks/history MCP server, Web→MCP adapter, MCP Apps/MCP-UI rendering, discovery+rating browser, in-app bookmarks/history, mobile scaffold. Deferred (seams in place): agentic code-gen of persistent site servers + agent profiles, profiles/chat-history UI, cloud sync, gateway runtime, diffusion/image models.

## License

Apache License 2.0, the same license as the OpenNodes standard. See [LICENSE](LICENSE).
