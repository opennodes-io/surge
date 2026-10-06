# Security policy

Surge is pre-release. Fixes land on `main`; there are no maintained release branches yet.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through GitHub: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/opennodes-io/surge/security/advisories/new)). Include what you found, how to reproduce it, and what an attacker gains. We'll acknowledge the report, keep you updated while we fix it, and credit you in the advisory unless you'd rather stay anonymous.

## What we especially want to hear about

- **API keys** — a provider key or a per-host OpenNodes key leaking out of the OS keychain store, over IPC to the renderer, into logs, or being sent to any host other than the one it was saved for.
- **OpenNodes spend and trust** — a call that bypasses the spend policy; Surge accepting a forged or tampered receipt or node card; a receipt that doesn't match `usage × pinned price` being shown as verified.
- **Private mode** — a model call, or a request to the registry, leaving your machine and LAN while private mode is on.
- **Sandboxes** — escaping the MCP-UI iframe sandbox or the per-site agent code sandbox, or a page or MCP server reaching Electron's main process.

Out of scope here: vulnerabilities in third-party MCP servers or in OpenNodes nodes and registries themselves (report those to their operators; protocol issues go to [opennodes-io/opennodes](https://github.com/opennodes-io/opennodes)), and attacks that need an already-compromised OS account.

## Where Surge keeps sensitive data

- **API keys:** encrypted with the OS keychain (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) in `surge-secrets.json` in the app's data folder. Without a real keychain, provider keys stay in the settings file and per-host keys can't be saved.
- **Settings:** `surge-settings.json` in the same folder (no keys when a keychain is available).
- **Local data:** `surge.db` (bookmarks, history, chat, the OpenNodes spend ledger) in the same folder. Receipts in the ledger hold token counts and amounts, never prompt or reply text.
