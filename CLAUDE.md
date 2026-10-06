# Surge — working notes for Claude Code

Surge is a desktop "browser for MCP" **and the reference desktop client for OpenNodes**: one app over both discovery layers — *models* via the OpenNodes Protocol (ONP), *tools* via MCP. It is a product that consumes the open standard; it is not where the standard lives.

## Relationship to OpenNodes (read this first)

- The standard, the registry, the Node Kit, and the hosted services live in **github.com/opennodes-io/opennodes** (public, Apache-2.0). This repo (`opennodes-io/surge`, public, Apache-2.0) must stay a *client*: it consumes ONP only through public surfaces.
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

**`@opennodes/ollama-router` 0.1.2** is a desktop-only dependency (it starts an HTTP server, so it never goes in core).
- Private mode starts it in the main process (`apps/desktop/src/main/services/private-router.ts`) on a free loopback port with `registry: null`, so only the local Ollama and LAN peers are served.
- mDNS LAN discovery is off unless `private.mdns` is set, because binding UDP 5353 can trigger a Windows firewall prompt.
- Types live in `apps/desktop/src/main/services/ollama-router.d.ts`.

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
                    (secret-store.ts = safeStorage keychain, private-router.ts = embedded ollama-router)
apps/mobile/        @surge/mobile — Capacitor scaffold (browser features gated off; imports only @surge/core/discovery)
servers/bookmarks-history-mcp/   standalone MCP server (stdio + HTTP), tsup
```

Commands: `pnpm install` · `pnpm typecheck` (all packages) · `pnpm test` (all hermetic verification scripts, via `scripts/test.mjs`) · `pnpm dev` (desktop) · `pnpm build`.
CI (`.github/workflows/ci.yml`, ubuntu) runs install `--frozen-lockfile`, typecheck, `pnpm test`, and the desktop and server builds on every push to `main` and every PR.
Verification scripts for the ONP integration:
- `packages/core/test/verify-onp-invocation.ts`: 38 checks against an in-process mock registry, an offline "admitted" node, and a mock node that serves a schema-valid signed card and signs real Ed25519 receipts; no network. Run `pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-onp-invocation.ts`. Covers:
  - pins and the 409 re-pin/retry, price raises within and beyond the policy, offering-mismatch
  - streaming, including a tool-call round
  - receipts: verified, inflated, foreign key, wrong revision, missing
  - every spend-policy limit
  - tampered-card rejection, and Auto routing with fallback
- `packages/core/test/verify-keys-spend-private.ts`: 21 checks with mock registry, nodes and Ollama, plus the real `@opennodes/ollama-router`; no network. Run `pnpm --filter @surge/bookmarks-history-mcp exec tsx ../../packages/core/test/verify-keys-spend-private.ts`. Covers:
  - per-host keys: sent only to their host; unlock imported offerings; join Auto; forgotten on delete
  - the spend ledger: persistence and the by-day / by-node summary
  - private mode: local models only (auto-private too), everything else refused, zero registry requests
- `packages/core/test/verify-onp.ts`: a **local** registry with the fixture Echo node. Bundle it with esbuild (externals `@google/generative-ai @libsql/client @modelcontextprotocol/sdk openai`), then run it with node.
- `packages/core/test/verify-onp-gateway.mjs`: Step 0, Surge's vllm-custom provider against the `onp` gateway.

**OpenAI SDK quirks on the ONP path:**
- By default the SDK **resends 409s** with the same headers, so ONP clients are built with `maxRetries: 0`.
- On an error, the SDK keeps only an `{error: …}` body, so a node's problem+json `title` (`price_changed` / `offering-mismatch`) never reaches `err.error`. After a 409, Surge re-fetches the card: a newer revision means price_changed, the same revision means offering-mismatch.

**Driving the real app** (no Playwright in the repo): run `pnpm --filter @surge/desktop build`. Then from `apps/desktop` run `electron . --remote-debugging-port=9333 --user-data-dir=<tmp dir>`. Drive the renderer page (`…/renderer/index.html`) over CDP: `Runtime.evaluate` and `Page.captureScreenshot`; Node 24 has a global `WebSocket`. `--user-data-dir` keeps the user's real `surge-settings.json` and `surge.db` untouched. Call `window.surge.window.resize('expanded')` before screenshotting dropdowns.

## Known state (2026-10-07)

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
  - `AiService.getOnpCalls()` keeps the session's records. `onOnpCallSettled` notifies listeners; the desktop persists every call to the `onp_calls` table.
- **Spend dashboard** (Settings → Spend, `SpendDashboard.tsx`), reading `onp:spend` (`SurgeStore.onpCalls.summary` / `list`):
  - Tiles: today vs the daily budget (with a meter), last-14-days total, and receipts verified.
  - A calls-per-day column chart (UTC) with spend in the tooltip, since most calls are free.
  - Tables: by node, and recent calls.
  - Chart colors come from the dataviz validator: `#0ea5c6` on dark, `#0891b2` on light. The app's `#06b6d4` fails the dark lightness band.
- **API keys in the OS keychain** (`SecretStore`: Electron `safeStorage`/DPAPI, ciphertext in `<userData>/surge-secrets.json`):
  - **Provider keys** (Gemini, Groq, Claude, Mistral, vLLM; `SECRET_SETTINGS` in `settings-service.ts`) keep their settings names, but `SettingsService` serves them from the keychain.
    - Plaintext values are migrated on first start and removed from `surge-settings.json`.
    - `settings:get` never returns them; the renderer gets only `settings:secrets` (which are saved).
    - Settings fields are write-only (`SecretField`). vLLM model discovery runs in main (`ai:listVllmModels`) so the saved key is used there.
    - Without a real keychain (Linux `basic_text`), provider keys stay in the settings file, and per-host keys can't be saved at all.
  - **Per-host OpenNodes keys:** `onp.key.<hostname>` in the store via `SecretStorePort` (`AiService` constructor arg; `listSecrets` lists names only).
    - Each key is sent only to endpoints on exactly that hostname. It makes the host's imported offerings usable (marked "your key") and adds them to the Auto pool.
    - Managed in Settings → Advanced → API keys by host, with host suggestions from listed imported catalogs.
    - `ai.onpApiKey` is retired: no longer read, only migrated out of plaintext.
- **Private mode** (one click: the lock beside the model picker):
  - `private.enabled` starts the embedded ollama-router. `AiService.setPrivateRouter(origin)` then lists only `private:*` models from its `/router/catalog` (local and LAN tiers), led by `private:auto-private`, the router's advisor restricted to local and LAN.
  - Every other model is refused, and the registry isn't contacted while private mode is on.
  - The previous model is restored when private mode is turned off. Private mode is restored at startup.
  - Static LAN peers and opt-in mDNS are set in Settings → Advanced → Private mode.
  - Scope: model calls only. Connected MCP servers and opened pages are not restricted, and the Settings text says so.
  - Verified in the app against the real local Ollama: `gemma4`, `gemma3:12b` and `llama3.2` were listed, and a tool turn was answered through `auto-private`.
  - Verified live against `demo-node.opennodes.io`, inline and by URL, both from a script and in the running app.
- **Spec conformance gaps (open):**
  - basis fields are ignored: `hardware.basis`, `context_capped_from`, `data_policy` (`auto-private` will need that last one)
  - spend is per device. Calls the user didn't make through `AiService` (e.g. the gateway) aren't counted.
- `OnpTier` includes `attested` / `local` / `lan`. `verified` and `attested` map to the Smart level.
- **Bugs (open):**
  - *Keyed hosts and the top-40 listing.* Imported offerings join Auto (and the key-host suggestions) only if they're in the top-40 listing. Hosts like router.huggingface.co mostly aren't, because the registry has no host filter.
  - *Private mode with tools.* Local models without tool support fail through the router: Surge's prompt-based tool fallback only triggers for `vllm-custom` / `ollama-local`.
  - *Heavy prompts.* The chat sends all 27 browser + bookmarks tool definitions every turn (~3.2k prompt tokens), which is slow on small CPU nodes and inflates paid ceilings.
- **Fixed for the launch kit** (2026-10-06):
  - *Clipped picker.* In the 160px idle window, opening the model list grows the window to its expanded size and shrinks it back on close (unless a chat started meanwhile). The list is positioned against its real containing block: the search bar's `backdrop-filter` makes it the containing block for `position: fixed`. It sits above the hints row and is opaque.
  - *Browser tool hang.* `BrowserService.executeTool` answers "No page is open…" when the view never loaded a page; there, `executeJavaScript` never settles. Every tool also has a ceiling of max(15s, timeoutMs + 5s).
  - *Tool-call header.* The IPC event `mcp:toolCall` now carries `serverId` / `serverName` / `toolName`.
- **Launch kit:** `docs/launch-kit/` holds the copy, the landing-page snippet, announcement drafts, a fact sheet of allowed claims, and `media/`.
  - `scripts/launch-kit/capture.mjs` regenerates `media/` from the real built app over CDP (needs ffmpeg).
  - The demo is recorded with `Page.startScreencast`, with model waits compressed. Stills are taken at 2× via `Emulation.setDeviceMetricsOverride`, dark and light. The browser shot stitches the app view and the embedded page.
  - Window capture with ffmpeg `gdigrab` returns black frames for this GPU-composited window, which is why the script uses CDP. The window title is `@surge/desktop`.
  - **Capture gotchas:**
    - Long `Runtime.evaluate` awaits can fail with "Promise was collected". Hold the promise on `window` and poll long waits from Node.
    - Screencast frames lag behind acks while animations play. Place them by their render timestamp, shifted onto `Date.now()` by the smallest delivery delay, and drain the backlog before stopping.
    - Make the GIF from the MP4: fed the variable-duration concat directly, ffmpeg played every hold too short.
    - Park a synthetic pointer (`Input.dispatchMouseEvent`) before scenes, because the real pointer's hover state leaks into frames.
- Licensed **Apache-2.0** (`LICENSE`, "Copyright 2026 The Surge Contributors"), matching the OpenNodes standard; every `package.json` declares it.
- **No plans or tiers** (removed before going public). Every provider is listed for everyone; the Settings "Plan" tab, PRO locks, `license.*` / `search.daily*` settings and the 3-server cap are gone.
  - `SettingsPort` is just `get` / `set` / `getMaxConnections`. That reads `mcp.maxConnections` (default 25), a resource guard, not a plan limit.
  - A paid offering, if any, would come back as a hosted service, not client-side gating.
- **Public since 2026-10-06** ([opennodes-io/surge#2](https://github.com/opennodes-io/surge/pull/2) prepared it).
  - Before the flip: gitleaks over all 24 commits, no findings. `PLAN.md` (an obsolete .NET plan) was removed, and `.claude/launch.json` is no longer tracked.
  - `SECURITY.md` points at GitHub private vulnerability reporting; `CONTRIBUTING.md` covers setup, checks and ground rules.
  - Enabled on the repo: secret scanning with push protection, Dependabot alerts, private vulnerability reporting. Description, homepage (opennodes.io) and topics are set. Dependabot security-update PRs are off.
  - Every OpenNodes surface links the repo: the landing page and README ([opennodes-io/opennodes#2](https://github.com/opennodes-io/opennodes/pull/2)), and the registry web app's Desktop & Apps panel, shipped in `@opennodes/registry` 0.1.7 ([opennodes-io/opennodes#3](https://github.com/opennodes-io/opennodes/pull/3)) and live on registry.opennodes.io.
  - The opennodes registry server is deployed over SSH (`deploy/RELEASING.md` step 5). Claude can't reach it from here, so the user runs that step.
- `.gitignore` covers `.claude/` and `tmpclaude-*`. `.npmrc` is benign (`node-linker=hoisted`). Never commit API keys; AI provider keys belong in the settings port / OS keychain.

## Conventions

- Git identity for commits here: `saikousoshite-ai <293202700+saikousoshite-ai@users.noreply.github.com>` (repo-local config is set). Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The local default branch is named `master` (no upstream configured) and corresponds to `github/main` on `opennodes-io/surge`. Branch from it. Keep commits small and reviewable, and run `pnpm typecheck` before committing.
- Keep `@surge/core` free of Electron/DOM assumptions — it is shared with the mobile shell and the standalone server. Node-only ONP code belongs behind the `onp` / `ai` subpaths, never `ui` / `discovery`.
- Ask before adding dependencies to `@surge/core` (it is bundled by every consumer).

## What a good next session does

1. **First installers.** The repo is public and source-only.
   - Next: electron-builder packaging and a Windows release on GitHub Releases. That needs a code-signing certificate, or SmartScreen warns about an unknown publisher.
   - Then macOS and Linux builds, once someone has tested them.
   - The launch kit is live on opennodes.io ([opennodes-io/opennodes#1](https://github.com/opennodes-io/opennodes/pull/1)). To refresh its assets, rerun `scripts/launch-kit/capture.mjs` and open a PR on the opennodes repo; merging to its `main` deploys the site.
2. **Follow-ups:**
   - Fetch keyed hosts' offerings directly, so Auto and the suggestions see more than the top-40 listing.
   - Extend private mode to MCP servers (local-only) if the product wants "nothing leaves the machine" to cover tools.
   - Add a mobile subpath for the platform-agnostic `onp/` modules.
