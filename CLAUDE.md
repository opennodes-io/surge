# Surge — working notes for Claude Code

Surge is a desktop "browser for MCP" **and the reference desktop client for OpenNodes**: one app over both discovery layers — *models* via the OpenNodes Protocol (ONP), *tools* via MCP. It is a product that consumes the open standard; it is not where the standard lives.

## Relationship to OpenNodes (read this first)

- The standard, the registry, the Node Kit, and the hosted services live in **github.com/opennodes-io/opennodes** (public, Apache-2.0). This repo (`opennodes-io/surge`, private for now) must stay a *client*: it consumes ONP only through public surfaces.
- Consume the **published packages**, never copy code from the opennodes repo:
  - `@opennodes/core` — `extractFeatures` / `recommend` (the advisor: task → best node+model, deterministic, prompt never leaves the machine), `estimateBounds`, card/JWS/receipt verification.
  - `@opennodes/cli` — `OnpClient` (search, estimate, pinned invoke with receipt verification) and the gateway / stdio MCP server if ever needed in-process.
  - `@opennodes/ollama-router` — if Surge wants the local/LAN/public Ollama tiers, embed or spawn it rather than reimplementing it.
- Default registry: `https://registry.opennodes.io` (web app + `/v0` API + `/mcp`). A local one is `npx @opennodes/registry` on `http://127.0.0.1:4300`. Setting: `ai.onpRegistryUrl`.
- Protocol facts the client must respect: invocation goes **direct from the client to the node** (no middlebox); every call pins `ONP-Offering` + `ONP-Card-Revision`; a `409 price_changed` means re-resolve the card and retry once; receipts are JWS signed by the node and must satisfy `amount = usage × pinned price`; tiers are `unverified / community / verified / attested` (+ `disputed`, `suspended`); claimed vs measured vs attested values are never blended — show the basis.
- Spec: `spec/ONP-1..6` in the opennodes repo. Composite Nodes (ONP-7) and Node Performance Reports are planned there; Surge should be the first client to surface them when they land.

## Repo layout (pnpm workspaces, `pnpm@10`)

```
packages/core/      @surge/core — platform-agnostic TS, source-only (consumers bundle it); tsc --noEmit is the "build"
  ai/               multi-vendor LLM service (Gemini, Groq, Claude, Mistral, Ollama, vLLM, **onp**) + tool calling
  onp/              OnpRegistryClient + the `onp` AI provider (packages/core/src/onp, packages/core/src/ai/ai-service.ts)
  mcp/ orchestrator/ discovery/ storage/ ui/ webmcp/ ports/
apps/desktop/       @surge/desktop — Electron (electron-vite), thin IPC bridge, WebContentsView
apps/mobile/        @surge/mobile — Capacitor scaffold (browser features gated off)
servers/bookmarks-history-mcp/   standalone MCP server (stdio + HTTP), tsup
```

Commands: `pnpm install` · `pnpm typecheck` (all packages) · `pnpm dev` (desktop) · `pnpm build`.
Verification scripts for the ONP integration: `packages/core/test/verify-onp.ts` (bundle with esbuild, externals `@google/generative-ai @libsql/client @modelcontextprotocol/sdk openai`, then run with node) and `packages/core/test/verify-onp-gateway.mjs` (Step 0: Surge's vllm-custom provider against the `onp` gateway).

## Known state (October 2026)

- **Pre-existing typecheck failure in the desktop app:** `apps/desktop/src/main/browser-service.ts` imports a missing `./mcp-manager` (it should come from `@surge/core/mcp`). It predates the ONP work. Fixing it is the first task of any session that wants to run the Electron app; until then `pnpm --filter @surge/desktop typecheck` fails and `pnpm dev` is unreliable.
- `@surge/core` typechecks clean. The `onp` provider lists registry offerings as models (`onp:<node>/<offering>`, description "TIER · node · measured ms"), pre-prices with `estimateOnp()`, and invokes with pinned headers. It uses a hand-written registry client; **replace it with `@opennodes/core`'s `recommend` + `@opennodes/cli`'s `OnpClient`** so the model picker gets the advisor for free (task-aware default model, `auto-private` semantics).
- No LICENSE file yet — the author's decision is open (Apache-2.0 to match the standard, or a product license). Do not add one unasked.
- `.gitignore` covers `.claude/`, `tmpclaude-*`, `.npmrc` is benign (node-linker=hoisted). Never commit API keys; AI provider keys belong in the settings port / OS keychain.

## Conventions

- Git identity for commits here: `saikousoshite-ai <293202700+saikousoshite-ai@users.noreply.github.com>` (repo-local config is set). Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Branch from `main`; `main` is pushed to `github` (`opennodes-io/surge`). Small, reviewable commits; run `pnpm typecheck` before committing.
- Keep `@surge/core` free of Electron/DOM assumptions — it is shared with the mobile shell and the standalone server.
- Ask before adding dependencies to `@surge/core` (it is bundled by every consumer).

## What a good next session does

1. Fix the `mcp-manager` import so the desktop app runs; confirm ONP models appear in the picker against the hosted registry.
2. Swap the hand-written ONP client for the published packages; add an "auto (advisor)" entry at the top of the model list that routes per prompt; show tier, measured latency, price, and the receipt after each call.
3. Spend dashboard from receipts (`OnpClient.receipts`), per-host API keys for imported providers, and `auto-private` (local/LAN only) as a one-click privacy mode.
4. Screenshots and a short demo for the OpenNodes launch kit (the "desktop client" section of the landing page is still a placeholder).
