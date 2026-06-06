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
# or streamable HTTP for remote clients
PORT=3939 node dist/http.js
```

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
