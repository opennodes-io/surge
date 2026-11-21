// Domain types for Surge local-first storage.
// Every row carries sync-ready metadata: stable UUID ids, epoch-ms timestamps,
// soft-delete tombstones (deletedAt), a monotonic `rev`, and an originDeviceId
// so a future sync layer can do last-writer-wins merges across devices.

export interface SyncMeta {
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  rev: number;
  originDeviceId: string | null;
}

export type BookmarkKind = 'web' | 'mcp-server' | 'mcpweb' | 'chat';

export interface Bookmark extends SyncMeta {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  favicon: string | null;
  kind: BookmarkKind;
  /** serverId / mcpweb origin / chat-session id when the bookmark is not a plain URL */
  targetRef: string | null;
  collectionId: string | null;
  tags?: string[];
}

export interface Collection extends SyncMeta {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface Tag extends SyncMeta {
  id: string;
  name: string;
  color: string | null;
}

export type HistoryKind =
  | 'web'
  | 'mcp-server-connect'
  | 'mcpweb-visit'
  | 'chat'
  | 'tool-call';

export interface HistoryEntry extends SyncMeta {
  id: string;
  url: string | null;
  title: string | null;
  kind: HistoryKind;
  targetRef: string | null;
  visitedAt: number;
  dwellMs: number | null;
  meta: Record<string, unknown> | null;
}

export interface Profile extends SyncMeta {
  id: string;
  name: string;
  isActive: boolean;
  settings: Record<string, unknown> | null;
}

export type AgentKind = 'saved-toolset' | 'web-mcp' | 'codegen';

/**
 * Persisted spec for a saved agent. Two shapes share this structure:
 *  - ephemeral/mcp-b: tools with inputSchema (no recipe) — from the Web->MCP adapter.
 *  - web-mcp/codegen: tools with declarative `steps` recipes (the safe generated path),
 *    optionally an opt-in `code` handler (only run when codeApproved === true).
 * Kept loose (`tools?: any[]`) so storage stays decoupled from the strict webmcp types.
 */
export interface AgentSpec {
  version?: number;
  source: 'ephemeral-browser' | 'mcp-b' | 'codegen' | 'web-mcp';
  domain?: string;
  name?: string;
  description?: string;
  tools?: any[];
  /** opt-in arbitrary-code handler (executed only in the gated sandbox when approved) */
  code?: string;
  codeApproved?: boolean;
  [key: string]: unknown;
}

export interface Agent extends SyncMeta {
  id: string;
  profileId: string | null;
  name: string;
  description: string | null;
  kind: AgentKind;
  spec: AgentSpec | null;
}

export interface ChatSession extends SyncMeta {
  id: string;
  profileId: string | null;
  title: string | null;
  model: string | null;
  /** The page the chat was about, reopened with it. */
  pageUrl: string | null;
}

export interface ChatMessage extends SyncMeta {
  id: string;
  sessionId: string;
  role: string;
  content: string | null;
  toolCalls: unknown[] | null;
  toolCallId: string | null;
  name: string | null;
  /** Display data the client keeps with a message (e.g. its tool calls and receipts). */
  meta: unknown | null;
  seq: number;
}

/** A settled OpenNodes call in the spend ledger. */
export interface OnpCallEntry extends SyncMeta {
  id: string;
  at: number;
  offering: string;
  nodeId: string;
  modelName: string | null;
  tier: string | null;
  price: string | null;
  cardRevision: string | null;
  receipt: 'verified' | 'missing' | 'unverified' | 'invalid';
  receiptId: string | null;
  reason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  amount: { currency: string; value: number } | null;
  countedUsd: number;
  durationMs: number | null;
  advisor: Record<string, unknown> | null;
}

/**
 * What happened to a call another app made through the Surge hub:
 * read (ran without asking) · allowed (on the card) · remembered (allowed earlier for that site) ·
 * declined · no-answer (timed out, or the window closed) · cancelled (the app went away first) ·
 * actions-off (refused: actions aren't allowed) · unknown (no such tool).
 */
export type HubDecision = 'read' | 'allowed' | 'remembered' | 'declined' | 'no-answer' | 'cancelled' | 'actions-off' | 'unknown';

/** One call through the Surge hub. Arguments are not kept. */
export interface HubCallEntry extends SyncMeta {
  id: string;
  at: number;
  /** Namespaced, as the app called it: "browser__clickElement". */
  tool: string;
  risk: 'read' | 'action' | 'script';
  /** The site or data it acted on ("example.com"), when it needed an approval. */
  scope: string | null;
  decision: HubDecision;
  /** Whether the tool ran without an error; null when it didn't run. */
  ok: boolean | null;
  durationMs: number | null;
}

/** Spend over a window, by UTC day and by node; `usd` sums what the budget counted. */
export interface OnpSpendSummary {
  since: number;
  totalUsd: number;
  calls: number;
  byDay: Array<{ day: string; usd: number; calls: number }>;
  byNode: Array<{ nodeId: string; usd: number; calls: number; verified: number; invalid: number; unreceipted: number }>;
}
