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

### Using the published packages (adopted 2026-10-06: `@opennodes/core` 0.1.1, `@opennodes/cli` 0.1.2)

Both are dependencies of `@surge/core` **and** `apps/desktop`; the desktop entry is what keeps electron-vite from bundling them.

**What Surge uses**
- `OnpClient`: search, estimate, and `resolveCard` (ONP-2 schema validation plus card-signature verification).
- `extractFeatures` + `recommend`: the Auto model.
- Kept as Surge's own code: streaming, receipt checks and the spend policy.

**Constraints that still apply**
- **No types.** The packages ship plain ESM JavaScript, so `packages/core/src/onp/opennodes.d.ts` declares the surface Surge uses. Files that import the packages pull it in with `/// <reference path="./opennodes.d.ts" />`, so it also works inside the desktop's TypeScript program.
- **Node-only.** The `@opennodes/core` barrel imports `node:crypto`, `node:http` and `node:fs`; at load, `node:fs` reads `schema/open-node.schema.json` relative to `import.meta.url`.
  - **Never bundle them**, or the schema path breaks.
  - The desktop main process is CJS and loads them with `require()`. This works because Electron 35 ships Node 22.16, which can `require()` ESM.
  - Root `engines` is now `>=22.5`.
- **Module split in `onp/`.**
  - Platform-agnostic (no Node APIs, no `@opennodes` imports): `onp-offerings.ts`, `onp-receipts.ts`, `onp-policy.ts`.
  - Node-only: `onp-client.ts`, `onp-advisor.ts`.
  - The `@surge/core/onp` barrel is therefore Node-only. Mobile would need its own subpath for the agnostic modules.
- **No timeouts in `OnpClient`.** Its fetches take no `AbortSignal`, so `onp-client.ts` races each call against an 8s timeout and the request finishes in the background.
- **Don't route chat through `OnpClient.invoke`.** It doesn't stream and drops tools (it sends only `{model, messages, max_tokens}`).

**Upstream feedback** (to file on opennodes-io/opennodes)
- `OnpClient` methods should accept an `AbortSignal`.
- Ship `.d.ts` files.
- `extractFeatures` misdetects English as Portuguese, e.g. "Write a python function…" → `pt`.
- `/v0/recommend` with `max_total_usd: 0` ranks HF-router imports first, but they need an API key. A "keyless only" filter (or a key-requirement field on offerings) would help clients without BYOK.

## Repo layout (pnpm workspaces, `pnpm@10`)

```
packages/core/      @surge/core — platform-agnostic TS, source-only (consumers bundle it); tsc --noEmit is the "build"
  ai/               multi-vendor LLM service (Gemini, Groq, Claude, Mistral, Ollama, vLLM, **onp**) + tool calling
  onp/              offerings model, registry client (@opennodes/cli), advisor (@opennodes/core), receipts (WebCrypto Ed25519), spend policy; the `onp` provider lives in ai/ai-service.ts
  mcp/ orchestrator/ discovery/ storage/ ui/ webmcp/ ports/
apps/desktop/       @surge/desktop — Electron 35 (electron-vite), thin IPC bridge, WebContentsView; main-process code in src/main/services/
apps/mobile/        @surge/mobile — Capacitor scaffold (browser features gated off; imports only @surge/core/discovery)
servers/bookmarks-history-mcp/   standalone MCP server (stdio + HTTP), tsup
```

Commands: `pnpm install` · `pnpm typecheck` (all packages) · `pnpm dev` (desktop) · `pnpm build`.
Verification scripts for the ONP integration:
- `packages/core/test/verify-onp-invocation.ts`: 38 checks against an in-process mock registry, an offline "admitted" node, and a mock node that serves a schema-valid signed card and signs real Ed25519 receipts; no network. Run `pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-onp-invocation.ts`. Covers:
  - pins and the 409 re-pin/retry, price raises within and beyond the policy, offering-mismatch
  - streaming, including a tool-call round
  - receipts: verified, inflated, foreign key, wrong revision, missing
  - every spend-policy limit
  - tampered-card rejection, and Auto routing with fallback
- `packages/core/test/verify-onp.ts`: a **local** registry with the fixture Echo node. Bundle it with esbuild (externals `@google/generative-ai @libsql/client @modelcontextprotocol/sdk openai`), then run it with node.
- `packages/core/test/verify-onp-gateway.mjs`: Step 0, Surge's vllm-custom provider against the `onp` gateway.

**OpenAI SDK quirks on the ONP path:**
- By default the SDK **resends 409s** with the same headers, so ONP clients are built with `maxRetries: 0`.
- On an error, the SDK keeps only an `{error: …}` body, so a node's problem+json `title` (`price_changed` / `offering-mismatch`) never reaches `err.error`. After a 409, Surge re-fetches the card: a newer revision means price_changed, the same revision means offering-mismatch.

**Driving the real app** (no Playwright in the repo): run `pnpm --filter @surge/desktop build`. Then from `apps/desktop` run `electron . --remote-debugging-port=9333 --user-data-dir=<tmp dir>`. Drive the renderer page (`…/renderer/index.html`) over CDP: `Runtime.evaluate` and `Page.captureScreenshot`; Node 24 has a global `WebSocket`. `--user-data-dir` keeps the user's real `surge-settings.json` and `surge.db` untouched. Call `window.surge.window.resize('expanded')` before screenshotting dropdowns.

## Known state (2026-10-06)

- **All four packages typecheck clean**, and `pnpm --filter @surge/desktop build` succeeds. The old `./mcp-manager` import in `apps/desktop/src/main/services/browser-service.ts` now comes from `@surge/core/mcp`.
- **ONP discovery works against the hosted registry by default**, verified in the running app: 40 ONP models in the picker, each with the description "TIER · node · measured ms" and a price.
  - Settings → Advanced has an **OpenNodes Registry** field; *Test & Refresh* saves it and reloads the picker.
  - Registry search times out after 8s, so an unreachable registry falls back to the static models instead of hanging the picker.
  - `estimateOnp()` pre-prices.
  - Discovery goes through `OnpRegistryClient` (`onp/onp-client.ts`), a thin typed wrapper over `@opennodes/cli`'s `OnpClient` that adds timeouts.
  - Offerings the spend policy would block (at a nominal 1k-token request) are marked "blocked by your spend policy" when listed. Live, 35 of 41 are marked under the default policy. Settings reloads the list after a policy edit.
- **Invocation is pinned per request and handles 409** (`AiService.createCompletion`, both `chat()` and `streamChat()`):
  - Pin headers are built from the current offering on every call. OpenAI clients are cached per node endpoint, not per offering.
  - On a 409, Surge re-resolves the offering from the node's card (`OnpRegistryClient.resolveCardOffering` → `OnpClient.resolveCard`), re-pins, and updates the picker price.
  - Then it re-applies the spend policy at the new price: allowed → retry exactly once; blocked → surface the price change together with the policy reason.
  - Same revision: surfaced as offering-mismatch.
  - A re-resolved pin survives model-list refreshes while the registry still lists an older revision (compared with `Date.parse`).
  - Verified with the mock script and once against the live `demo-node.opennodes.io` using a deliberately stale pin.
  - The re-resolved card must pass the ONP-2 schema and verify against the node's JWKS, and `card.node.id` must match; otherwise the 409 is surfaced ("could not be verified").
- **Auto (advisor)** — `onp:auto`, listed first among ONP models (`onp/onp-advisor.ts`, `AiService.createCompletion`):
  - Pool: the registry's admitted nodes (`tier=community` search, 3 today). They serve without an API key; imported listings don't.
  - `extractFeatures` runs on the latest user turn, and `recommend` ranks on this device within the policy's tier and price cap.
  - Each pick still goes through the full policy check. The next pick is tried when one is blocked or fails before its response starts, which matters because the lab node is often offline.
  - The `OnpCallRecord.advisor` field (task class, score, reasons, skipped picks) shows as an "auto · chat → model (reason)" line.
  - Verified live: chat → lab gemma4 (price-led), code → lab gemma3-12b, and a multi-round tool turn in the app.
- **Spend policy, ONP-5 §3** (`onp/onp-policy.ts`):
  - Covers the per-request ceiling, daily budget (UTC), price cap per MTok, allowed schemes and minimum tier.
  - Checked in `createCompletion` before every ONP request, the 409 retry included, so a blocked call never reaches the node.
  - The ceiling is the estimated input (~3 chars/token, tools included) plus `max_tokens`, at the pinned price.
  - Default is **spending off**: $0 per request and $0 per day, so free offerings run and paid ones are blocked. Disputed and suspended nodes are always blocked.
  - Stored as `onp.policy` and `onp.spend` through the settings port. `onp.*` keys don't trigger `refreshConfig`, which `ai.*` keys do.
  - Edited in Settings → Advanced → Spend policy.
- **Receipts, ONP-5 §5** (`onp/onp-receipts.ts`): no new dependency, because Ed25519 is verified with WebCrypto.
  - `createCompletion` reads `ONP-Receipt` via `.withResponse()`. Inline JWS and URL receipts are both handled; a URL must be on the node's origin, with a short retry on 404.
  - The node key comes from `/.well-known/jwks.json` (cached per origin, 10 min).
  - Checks: node and offering, the pinned `card_revision`, currency, and `amount = usage × pinned price` within 1.5e-6, which tolerates differing rounding modes.
  - Statuses: `verified` / `missing` / `unverified` (couldn't fetch) / `invalid`.
  - Spend counts the verified amount, or the request ceiling when there's no verified receipt.
  - ONP streams send `stream_options.include_usage`, so receipts carry real engine token counts instead of the node's approximation.
  - `streamChat` reads the stream to the end before dispatching tool calls. Leaving early aborted the response and the node never settled the receipt.
  - Each settled call is an `OnpCallRecord` that travels `streamChat` → `onOnpCall` → tool loop → IPC `ai:onpCall` → renderer. It's shown under the reply: tier · node · registry p50 · this call's duration · price · receipt status · tokens · amount.
  - `AiService.getOnpCalls()` keeps the session's records for the future dashboard.
  - Verified live against `demo-node.opennodes.io`, inline and by URL, both from a script and in the running app.
- **Spec conformance gaps (open):**
  - basis fields are ignored: `hardware.basis`, `context_capped_from`, `data_policy` (`auto-private` will need that last one)
  - spend is per device. Calls the user didn't make through `AiService` (e.g. the gateway) aren't counted.
- `OnpTier` includes `attested` / `local` / `lan`. `verified` and `attested` map to the Smart level.
- **Bugs (open):**
  - *Single global key.* `ai.onpApiKey` is sent to every node. It has no UI yet, so it's dormant; replace it with per-host keys before adding any key UI.
  - *Plaintext keys.* Provider keys sit in plaintext in `surge-settings.json`. `SecretStorePort` (`packages/core/src/ports/secret-store-port.ts`) exists, but the desktop doesn't implement it (Electron `safeStorage`).
  - *Clipped picker (UX, pre-existing).* In the compact idle window (680×160) the model dropdown is clipped; nothing resizes the window when it opens.
  - *Browser tool hangs with no page (pre-existing).* If a model calls `browser__getPageContent` while no page is loaded, the tool never returns and the chat stays "streaming" forever.
  - *Empty tool-call header (pre-existing).* The IPC event `mcp:toolCall` sends `name`, but `McpToolCallBlock` reads `toolName` / `serverName`.
  - *Heavy prompts.* The chat sends all 27 browser + bookmarks tool definitions every turn (~3.2k prompt tokens), which is slow on small CPU nodes and inflates paid ceilings.
- No LICENSE file yet — the author's decision is open (Apache-2.0 to match the standard, or a product license). Do not add one unasked.
- `.gitignore` covers `.claude/` and `tmpclaude-*`. `.npmrc` is benign (`node-linker=hoisted`). Never commit API keys; AI provider keys belong in the settings port / OS keychain.

## Conventions

- Git identity for commits here: `saikousoshite-ai <293202700+saikousoshite-ai@users.noreply.github.com>` (repo-local config is set). Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The local default branch is named `master` (no upstream configured) and corresponds to `github/main` on `opennodes-io/surge`. Branch from it. Keep commits small and reviewable, and run `pnpm typecheck` before committing.
- Keep `@surge/core` free of Electron/DOM assumptions — it is shared with the mobile shell and the standalone server. Node-only ONP code belongs behind the `onp` / `ai` subpaths, never `ui` / `discovery`.
- Ask before adding dependencies to `@surge/core` (it is bundled by every consumer).

## What a good next session does

1. **Per-host API keys** through `SecretStorePort` backed by `safeStorage`; retire `ai.onpApiKey`. Then a spend dashboard from `getOnpCalls()` (persist the records), and `auto-private` (local/LAN only) as a one-click privacy mode: the advisor's `prefer_local` / `preset: 'private'` plus the local and LAN tiers. Once keys exist, widen the Auto pool beyond admitted nodes to imported listings the user has keys for.
2. **Launch kit.** Screenshots and a short demo for the OpenNodes launch kit (the "desktop client" section of the landing page is still a placeholder). Fix the clipped compact-mode picker and the browser-tool hang first.
