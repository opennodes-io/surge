# surge-bookmarks-mcp

A standalone **MCP server** that exposes **bookmarks** and **browsing/usage history** backed by Surge's local SQLite database. Because it speaks MCP, *any* MCP client (Surge, Claude Desktop, Cursor, MCP Inspector, …) can read and write the same bookmarks/history — turning Surge's history & bookmarks into a shared, browser-like capability across the MCP ecosystem.

## Storage

A single local SQLite file (via `@libsql/client`, an N-API module that loads in both Node and Electron without a rebuild). Path precedence:

1. `--db <path>` CLI arg
2. `SURGE_DB_PATH` env var
3. default `<userData>/Surge/surge.db` (the same file the Surge desktop app uses)

The schema is sync-ready (stable UUID ids, `updated_at`, soft-delete tombstones, `rev`, `origin_device_id`) so a Turso/libsql sync layer can be added later without a migration.

## Run

```bash
# stdio (what MCP clients launch)
npx surge-bookmarks-mcp
# or Streamable HTTP, for MCP clients on this machine (see "HTTP mode")
SURGE_MCP_HTTP_TOKEN=<a long random string> node dist/http.js
```

## HTTP mode

`node dist/http.js` serves MCP at `http://127.0.0.1:3939/mcp`. `PORT` (or `SURGE_MCP_HTTP_PORT`) picks another port. Bookmarks and history are as private as a browser's, so only clients on this machine that have the token get in:

- **Token.** Every request needs `Authorization: Bearer <token>`, or it gets 401.
  - Set `SURGE_MCP_HTTP_TOKEN` (16 characters or more), for example from `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
  - Or leave it unset: the server makes one at start and prints it to stderr. It changes on every start.
- **This machine only.** It listens on 127.0.0.1, and a request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` gets 403. That stops DNS-rebinding pages too.
- **No web pages.** It sends no CORS headers. A request a browser makes for a page carries `Origin`, or a `Sec-Fetch-Site` other than `none`, and gets 403.
  - So browser-based clients can't connect. That includes MCP Inspector's direct mode; its default proxy mode works.
- **Limits.** A body over 4 MiB gets 413. At most 32 sessions are kept:
  - a session idle for 10 minutes is closed;
  - a new one replaces the least recently used idle one;
  - a closed session's id gets 404, and the client starts a new session.

If the Surge app is running, its hub (Settings → Advanced → Surge hub) already gives other apps the same bookmarks and history, and asks before writes.

Client setup for the HTTP mode, with your token:

- Cursor, LM Studio, VS Code (mcp.json):

  ```json
  {
    "mcpServers": {
      "surge-bookmarks": {
        "url": "http://127.0.0.1:3939/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      }
    }
  }
  ```

- Claude Code:

  ```bash
  claude mcp add --transport http surge-bookmarks http://127.0.0.1:3939/mcp --header "Authorization: Bearer <token>"
  ```

- Claude Desktop launches servers over stdio, so use the stdio setup below.

## Use from another MCP client (Claude Desktop)

```json
{
  "mcpServers": {
    "surge-bookmarks": {
      "command": "npx",
      "args": ["-y", "surge-bookmarks-mcp"],
      "env": { "SURGE_DB_PATH": "C:\\Users\\<you>\\AppData\\Roaming\\Surge\\surge.db" }
    }
  }
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `bookmark_add` / `bookmark_remove` | add / soft-delete a bookmark (`kind`: web · mcp-server · mcpweb · chat) |
| `bookmark_list` / `bookmark_search` | list (by collection/kind) / search title+url+description |
| `bookmark_tag` / `bookmark_untag` | manage tags |
| `collection_create` / `collection_list` / `collection_move` | folders/collections |
| `history_record` / `history_search` / `history_list` / `history_clear` | append / query / clear history |

## Resources

- `bookmarks://all` — all bookmarks as JSON
- `bookmarks://collection/{id}` — bookmarks in a collection
- `history://recent` — 100 most recent history entries

All tool results also include machine-readable `structuredContent`.
