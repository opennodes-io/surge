# Surge — working notes for Claude Code

Surge is a desktop "browser for MCP" **and the reference desktop client for OpenNodes**: one app over both discovery layers — *models* via the OpenNodes Protocol (ONP), *tools* via MCP. It is a product that consumes the open standard; it is not where the standard lives.

## Relationship to OpenNodes (read this first)

- The standard, the registry, the Node Kit, and the hosted services live in **github.com/opennodes-io/opennodes** (public, Apache-2.0). This repo (`opennodes-io/surge`, private for now) must stay a *client*: it consumes ONP only through public surfaces.
- Consume the **published packages**, never copy code from the opennodes repo:
  - `@opennodes/core` — `extractFeatures` / `recommend` (the advisor: task → best node+model, deterministic, prompt never leaves the machine), `estimateBounds`, `costForUsage`, card/JWS/receipt verification.
  - `@opennodes/cli` — `OnpClient` (search, estimate, `resolveCard`, `checkPolicy`, pinned invoke with receipt verification, `receipts` / `spendTotal()`) and the gateway / stdio MCP server if ever needed in-process. `src/gateway.js` is the reference for streaming + receipts + per-host keys.
  - `@opennodes/ollama-router` — if Surge wants the local/LAN/public Ollama tiers, embed or spawn it rather than reimplementing it.
- Default registry: `https://registry.opennodes.io` (web app + `/v0` API + `/mcp`; ~8.7k offerings). A local one is `npx @opennodes/registry` on `http://127.0.0.1:4300`. Setting: `ai.onpRegistryUrl` (empty → hosted).
- Protocol facts the client must respect (spec MUSTs in **bold**):
  - Invocation goes **direct from the client to the node** (no middlebox); every call pins `ONP-Offering` + `ONP-Card-Revision`.
  - **On `409 price_changed`: re-fetch the card, re-apply the user's spend policy, then retry once or surface** (ONP-4).
  - Receipts arrive in the `ONP-Receipt` response header, inline JWS **or a URL**. Streaming responses carry the URL, which is materialized after the stream ends. Verify the node's JWS (`/.well-known/jwks.json`), `amount = usage × pinned price`, and `card_revision` = the pinned one. With the OpenAI SDK, use `.withResponse()` to read headers.
  - **Enforce a user-configured spend policy before invocation**: max price per MTok, per-request ceiling (`max_tokens` × pinned price), per-day budget, allowed schemes, minimum tier (ONP-5).
  - Tiers: `unverified / community / verified / attested` (+ `disputed`, `suspended`). `@opennodes/core` ≥0.1.1 adds client-side `local` / `lan` tiers (your own machines, fully trusted).
  - Claimed vs measured vs attested values are never blended — show the basis (`hardware.basis`, `observed.*`, `serving.context_capped_from`).
  - `POST /v0/recommend` accepts `features` only, so the prompt never leaves the machine.
  - Credentials are per upstream **hostname** (the gateway's `keys` map). Never send one key to every node: registration is open.
- Spec: `spec/ONP-1..6` in the opennodes repo (still the full set as of 2026-10-06). Composite Nodes (ONP-7) and Node Performance Reports are planned there; Surge should be the first client to surface them when they land.

### Using the published packages (checked 2026-10-06: core 0.1.1, cli 0.1.2, ollama-router 0.1.2, registry 0.1.6)

- Plain ESM JavaScript with **no `.d.ts`**. Strict `tsc` needs a `declare module` shim.
- The `@opennodes/core` barrel is **Node-only**. It imports `node:crypto` and `node:http`, plus `node:fs`, which reads `schema/open-node.schema.json` relative to `import.meta.url` at load. Keep it external: never bundle it, or the schema path breaks. Use it from the Electron main process only, never from the renderer or the mobile shell.
- `engines: node >=22.5`. Electron 35 ships Node 22, so that's fine; the root `engines` still says `>=20`.
- `OnpClient.invoke` is **non-streaming and drops tools** (it sends only `{model, messages, max_tokens}`). Don't route Surge chat through it. Instead:
  - Use `OnpClient` for search, estimates, `resolveCard`, `checkPolicy` and receipt math.
  - Use `extractFeatures` + `recommend` (or `/v0/recommend`) for the advisor.
  - Keep the OpenAI SDK streaming path and add the 409 retry and receipt-by-URL verification there, the way `gateway.js` does.
- Surge fetches only the top 40 text offerings, which is a thin pool for a client-side `recommend`. Prefer `/v0/recommend` with features, or fetch wider.
- They pull in `ajv` / `ajv-formats`. Adding them to `@surge/core` needs the owner's OK (see Conventions).

## Repo layout (pnpm workspaces, `pnpm@10`)

```
packages/core/      @surge/core — platform-agnostic TS, source-only (consumers bundle it); tsc --noEmit is the "build"
  ai/               multi-vendor LLM service (Gemini, Groq, Claude, Mistral, Ollama, vLLM, **onp**) + tool calling
  onp/              OnpRegistryClient + ONP_DEFAULT_REGISTRY; the `onp` provider lives in ai/ai-service.ts
  mcp/ orchestrator/ discovery/ storage/ ui/ webmcp/ ports/
apps/desktop/       @surge/desktop — Electron 35 (electron-vite), thin IPC bridge, WebContentsView; main-process code in src/main/services/
apps/mobile/        @surge/mobile — Capacitor scaffold (browser features gated off; imports only @surge/core/discovery)
servers/bookmarks-history-mcp/   standalone MCP server (stdio + HTTP), tsup
```

Commands: `pnpm install` · `pnpm typecheck` (all packages) · `pnpm dev` (desktop) · `pnpm build`.
Verification scripts for the ONP integration: `packages/core/test/verify-onp.ts` (a **local** registry with the fixture Echo node; bundle with esbuild, externals `@google/generative-ai @libsql/client @modelcontextprotocol/sdk openai`, then run with node) and `packages/core/test/verify-onp-gateway.mjs` (Step 0: Surge's vllm-custom provider against the `onp` gateway).

**Driving the real app** (no Playwright in the repo): run `pnpm --filter @surge/desktop build`. Then from `apps/desktop` run `electron . --remote-debugging-port=9333 --user-data-dir=<tmp dir>`. Drive the renderer page (`…/renderer/index.html`) over CDP: `Runtime.evaluate` and `Page.captureScreenshot`; Node 24 has a global `WebSocket`. `--user-data-dir` keeps the user's real `surge-settings.json` and `surge.db` untouched. Call `window.surge.window.resize('expanded')` before screenshotting dropdowns.

## Known state (2026-10-06)

- **All four packages typecheck clean**, and `pnpm --filter @surge/desktop build` succeeds. The old `./mcp-manager` import in `apps/desktop/src/main/services/browser-service.ts` now comes from `@surge/core/mcp`.
- **ONP discovery works against the hosted registry by default**, verified in the running app: 40 ONP models in the picker, each with the description "TIER · node · measured ms" and a price.
  - Settings → Advanced has an **OpenNodes Registry** field; *Test & Refresh* saves it and reloads the picker.
  - Registry search times out after 8s, so an unreachable registry falls back to the static models instead of hanging the picker.
  - `estimateOnp()` pre-prices; invocation sends the pinned headers.
  - Discovery still uses the hand-written `OnpRegistryClient`.
- **Spec conformance gaps (open):**
  - no `409 price_changed` handling
  - no receipt verification (`ONP-Receipt` is never read)
  - no spend policy
  - `OnpTier` lacks `attested` / `local` / `lan`, and `level` maps only `verified` → smart
  - basis fields are ignored: `hardware.basis`, `context_capped_from`, `data_policy` (`auto-private` will need that last one)
- **Bugs (open):**
  - *Stale pin.* `AiService.onpClients` caches one OpenAI client per offering, with `onp-card-revision` baked into its default headers. `refreshOnpModels()` never clears that cache, so after a node revises its card Surge keeps sending the old revision and gets a 409 every time.
  - *Single global key.* `ai.onpApiKey` is sent to every node. It has no UI yet, so it's dormant; replace it with per-host keys before adding any key UI.
  - *Plaintext keys.* Provider keys sit in plaintext in `surge-settings.json`. `SecretStorePort` (`packages/core/src/ports/secret-store-port.ts`) exists, but the desktop doesn't implement it (Electron `safeStorage`).
  - *Clipped picker (UX, pre-existing).* In the compact idle window (680×160) the model dropdown is clipped; nothing resizes the window when it opens.
- No LICENSE file yet — the author's decision is open (Apache-2.0 to match the standard, or a product license). Do not add one unasked.
- `.gitignore` covers `.claude/` and `tmpclaude-*`. `.npmrc` is benign (`node-linker=hoisted`). Never commit API keys; AI provider keys belong in the settings port / OS keychain.

## Conventions

- Git identity for commits here: `saikousoshite-ai <293202700+saikousoshite-ai@users.noreply.github.com>` (repo-local config is set). Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The local default branch is named `master` (no upstream configured) and corresponds to `github/main` on `opennodes-io/surge`. Branch from it. Keep commits small and reviewable, and run `pnpm typecheck` before committing.
- Keep `@surge/core` free of Electron/DOM assumptions — it is shared with the mobile shell and the standalone server. Node-only ONP code belongs behind the `onp` / `ai` subpaths, never `ui` / `discovery`.
- Ask before adding dependencies to `@surge/core` (it is bundled by every consumer).

## What a good next session does

1. **Make invocation safe.** Clear `onpClients` on refresh, or pin per request. Add the `409 price_changed` re-resolve-and-retry-once on the streaming path. Add `attested` / `local` / `lan` to `OnpTier`.
2. **Receipts and policy.** Read `ONP-Receipt` via `.withResponse()`, fetch it by URL after streams, and verify JWS, amount and revision. Add a minimal spend policy (per-request ceiling + minimum tier, then a daily budget). Show tier, measured latency, price and the receipt after each call.
3. **Swap in the published packages**, following "Using the published packages" above. Then add an "auto (advisor)" entry at the top of the model list that routes per prompt.
4. **Per-host API keys** through `SecretStorePort` backed by `safeStorage`; retire `ai.onpApiKey`. Then a spend dashboard from receipts, and `auto-private` (local/LAN only) as a one-click privacy mode.
5. **Launch kit.** Screenshots and a short demo for the OpenNodes launch kit (the "desktop client" section of the landing page is still a placeholder). Fix the clipped compact-mode picker first.
