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

/** Spec for a saved agent — the seam the later code-gen phase targets. */
export interface AgentSpec {
  source: 'ephemeral-browser' | 'mcp-b' | 'codegen';
  domain?: string;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** generated server entrypoint / instructions, filled by a future code-gen step */
  code?: string;
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
}

export interface ChatMessage extends SyncMeta {
  id: string;
  sessionId: string;
  role: string;
  content: string | null;
  toolCalls: unknown[] | null;
  toolCallId: string | null;
  name: string | null;
  seq: number;
}
