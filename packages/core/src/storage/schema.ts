// SQL schema for the Surge local-first SQLite database.
// Hand-written CREATE TABLE statements (rather than an ORM/migration tool) keep
// the schema portable across the Electron desktop and the standalone Node MCP
// server, both of which open the same file via @libsql/client (an N-API module
// that is ABI-stable across runtimes, so no native rebuild is required).

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    favicon TEXT,
    kind TEXT NOT NULL DEFAULT 'web',
    target_ref TEXT,
    collection_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bookmark_tags (
    bookmark_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, tag_id)
  )`,

  `CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    url TEXT,
    title TEXT,
    kind TEXT NOT NULL DEFAULT 'web',
    target_ref TEXT,
    visited_at INTEGER NOT NULL,
    dwell_ms INTEGER,
    meta TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    settings TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'saved-toolset',
    spec TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    title TEXT,
    model TEXT,
    page_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    name TEXT,
    meta TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  // Settled OpenNodes calls: the spend ledger behind the dashboard (one row per model round).
  `CREATE TABLE IF NOT EXISTS onp_calls (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    offering TEXT NOT NULL,
    node_id TEXT NOT NULL,
    model_name TEXT,
    tier TEXT,
    price TEXT,
    card_revision TEXT,
    receipt TEXT NOT NULL,
    receipt_id TEXT,
    reason TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    amount_currency TEXT,
    amount_value REAL,
    counted_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    advisor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 1,
    origin_device_id TEXT
  )`,

  // Reserved for the future sync layer (push/pull bookkeeping per table).
  `CREATE TABLE IF NOT EXISTS sync_state (
    table_name TEXT PRIMARY KEY,
    last_pushed_rev INTEGER,
    last_pulled_at INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_history_visited ON history(visited_at)`,
  `CREATE INDEX IF NOT EXISTS idx_history_url ON history(url)`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_collection ON bookmarks(collection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_onp_calls_at ON onp_calls(at)`,
];

/**
 * Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS leaves an existing table
 * alone, so SurgeStore.init adds any of these that an older surge.db is missing.
 */
export const COLUMN_ADDITIONS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  { table: 'chat_sessions', column: 'page_url', type: 'TEXT' }, // the page the chat was about
  { table: 'chat_messages', column: 'meta', type: 'TEXT' }, // display data as JSON: tool calls, receipts
];
