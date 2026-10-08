# Surge

[![CI](https://github.com/opennodes-io/surge/actions/workflows/ci.yml/badge.svg)](https://github.com/opennodes-io/surge/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**A desktop "browser for MCP" and the reference [OpenNodes](https://opennodes.io) client** — tools through the Model Context Protocol, models through the OpenNodes Protocol, in one app.

<picture>
  <source srcset="docs/launch-kit/media/surge-browser-receipt-dark.png" media="(prefers-color-scheme: dark)">
  <img src="docs/launch-kit/media/surge-browser-receipt-light.png" width="900" alt="Surge with opennodes.io open in its browser: a page tool read the site, and the answer came from an OpenNodes node chosen by the advisor, with its verified receipt shown under the reply">
</picture>

> **Pre-release.** Tested on Windows 11. **Windows:** [download the installer](https://github.com/opennodes-io/surge/releases). macOS and Linux are untested; build from source.

## What it does

**Tools, through MCP**
- Connect MCP servers over stdio, SSE or streamable HTTP, and find them in a discovery browser: the public registry.mcp.so catalog, or quality ratings and trust tiers from an MCP_Index registry if you point `mcp.indexUrl` at one.
- An embedded browser whose page tools are exposed as an MCP server, plus per-site agents that are declarative, approved before they run, and sandboxed when they use code.
- MCP Apps / MCP-UI surfaces rendered in a sandboxed, null-origin iframe.
- Bookmarks and history that other MCP clients can use too, through a standalone MCP server.

**Models, through OpenNodes**
- A model picker fed live from an OpenNodes registry: trust tier, registry-measured latency and per-MTok price for every node.
- **Auto** runs the OpenNodes advisor on your machine — the prompt never leaves it — picks a node per prompt, and falls back if one is down.
- Every call goes straight to the node, pinned to its card revision; a price change is re-resolved from the node's signed card and re-checked against your policy.
- Every call's signed receipt is verified (`amount = usage × pinned price`) and shown under the reply; a spend dashboard keeps the ledger.
- A spend policy (per request, per day, price cap, schemes, minimum tier) is checked before every call, with spending **off** until you set a budget.
- **Private mode**, one click: model calls go only to your local Ollama and LAN machines, through an embedded OpenNodes router; the registry is not contacted.

**Also**
- Gemini, Groq, Claude, Mistral, Ollama, and any OpenAI-compatible endpoint (vLLM, LM Studio, LocalAI, …).
- API keys kept in the OS keychain (Electron `safeStorage`); imported catalogs get one key per host, sent only to that host.
- **Sign in to remote MCP servers** with OAuth (the MCP authorization spec): Surge opens the sign-in page in your browser and keeps the tokens in the OS keychain; Sign out forgets them.
- **Surge hub:** other AI apps on your computer (Claude Code, Cursor, LM Studio, …) can use Surge's browser and your bookmarks through a local MCP server, protected by a token. It's off by default and read-only unless you allow actions (Settings → Advanced → Surge hub).

## Install (Windows)

Download `Surge-Setup-<version>.exe` from [Releases](https://github.com/opennodes-io/surge/releases) and run it. It installs for your user only, with no admin prompt, into `%LOCALAPPDATA%\Programs\surge`; your data lives in `%APPDATA%\Surge` and is kept if you uninstall.

The installer isn't code-signed yet, so Windows SmartScreen says "Windows protected your PC": choose **More info → Run anyway**. To check the download first, compare `certutil -hashfile Surge-Setup-<version>.exe SHA256` with the release's `SHA256SUMS.txt`.

## Build from source

Needs [Node.js](https://nodejs.org) 22.5 or newer, [pnpm](https://pnpm.io) 10 (`corepack enable`), and Git. A local [Ollama](https://ollama.com) is optional — it backs private mode.

```bash
git clone https://github.com/opennodes-io/surge.git
cd surge
pnpm install
pnpm --filter @surge/desktop dev       # run the desktop app with hot reload
```

Or build and run without the dev server:

```bash
pnpm --filter @surge/desktop build
pnpm --filter @surge/desktop start
```

Or build a Windows installer (on Windows):

```bash
pnpm --filter @surge/desktop dist:win
```

That writes `apps/desktop/release/Surge-Setup-<version>.exe`, the same per-user installer as on Releases. Builds run from source keep their data in `%APPDATA%\Surge Dev`, so they never share a database with an installed Surge.

On first run, the OpenNodes models need no setup: the admitted nodes are free, so they work under the default spending-off policy. For the other providers add a key in **Settings → API Keys** (Gemini and Groq have free tiers). The registry, spend policy, per-host keys and private mode live in **Settings → Advanced**; the ledger is in **Settings → Spend**.

## Checks

```bash
pnpm typecheck     # every package
pnpm test          # the hermetic verification scripts: no network, no API keys
```

`pnpm test` covers storage and the bookmarks server, per-site agents and their sandbox, the OpenNodes client (pins, 409 handling, receipts against a node that signs real Ed25519 receipts, the spend policy, Auto), per-host keys, the spend ledger and private mode. CI runs the same, plus the desktop build.

## Repository layout

pnpm workspaces:

```
packages/core/                  @surge/core — platform-agnostic logic (source-only TypeScript, bundled by consumers)
  ai/            multi-vendor LLM service + tool calling, including the OpenNodes and private-mode providers
  onp/           OpenNodes: offerings, registry client, advisor, receipts (WebCrypto Ed25519), spend policy
  mcp/           MCP manager (stdio/SSE/HTTP), MCPWeb detector, virtual-server registry
  orchestrator/  multi-round tool-calling loop
  discovery/     MCP server discovery client (quality scores, trust tiers)
  storage/       local-first SQLite (@libsql/client): bookmarks, history, profiles, agents, chat, spend ledger
  ui/            MCP Apps / MCP-UI detection and renderer registry
  webmcp/        Web→MCP adapter and per-site agents
  ports/         platform interfaces (settings, browser, secrets) — the seam between desktop and mobile
apps/desktop/                   @surge/desktop — Electron shell (window, WebContentsView, IPC bridge, keychain, embedded router)
apps/mobile/                    @surge/mobile — Capacitor scaffold (reuses @surge/core; browser features gated off)
servers/bookmarks-history-mcp/  standalone bookmarks/history MCP server (stdio + HTTP)
docs/launch-kit/                screenshots, demo and copy; regenerated by scripts/launch-kit/capture.mjs
```

## Design choices

- **Shared core, thin shells.** All MCP, AI, OpenNodes, storage and discovery logic lives in `@surge/core`, consumed by the desktop (esbuild bundles it; native and Node-only dependencies stay external), the standalone server (tsup) and the mobile scaffold.
- **Local-first storage via `@libsql/client`** — an N-API module that is ABI-stable across Electron and plain Node, so the desktop and the standalone server open the same `surge.db` without a native rebuild. The schema is sync-ready (UUID ids, `updated_at`, tombstones, `rev`, `origin_device_id`).
- **Bookmarks and history are an MCP server**, so any MCP client can use them — see [`servers/bookmarks-history-mcp`](servers/bookmarks-history-mcp/README.md).
- **Untrusted content is sandboxed.** MCP-UI HTML renders in a null-origin iframe (`srcdoc`, `allow-scripts` only, strict CSP); generated per-site agents are declarative data, and their optional code path is approved per agent and isolated.
- **The OpenNodes client checks, it doesn't trust.** Receipts and the spend policy are platform-agnostic code (WebCrypto), so they run on desktop and mobile alike; cards are validated against the ONP-2 schema and signature-checked with the published [`@opennodes/core`](https://www.npmjs.com/package/@opennodes/core).

## Contributing and security

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

The OpenNodes Protocol itself — spec, registry, Node Kit — lives in [opennodes-io/opennodes](https://github.com/opennodes-io/opennodes).

## License

Apache License 2.0, the same license as the OpenNodes standard. See [LICENSE](LICENSE).
