import type { Client, Row } from '@libsql/client';
import type {
  Bookmark,
  BookmarkKind,
  Collection,
  Tag,
  HistoryEntry,
  HistoryKind,
  Profile,
  Agent,
  AgentKind,
  AgentSpec,
  ChatSession,
  ChatMessage,
} from './types.js';
import { newId, now, toJson, parseJson, num, numOrNull, strOrNull, bool } from './util.js';

// ── Row mappers ─────────────────────────────────────────
function mapBookmark(r: Row, tags: string[] = []): Bookmark {
  return {
    id: String(r.id),
    url: String(r.url),
    title: strOrNull(r.title),
    description: strOrNull(r.description),
    favicon: strOrNull(r.favicon),
    kind: (strOrNull(r.kind) ?? 'web') as BookmarkKind,
    targetRef: strOrNull(r.target_ref),
    collectionId: strOrNull(r.collection_id),
    tags,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapCollection(r: Row): Collection {
  return {
    id: String(r.id),
    name: String(r.name),
    parentId: strOrNull(r.parent_id),
    sortOrder: num(r.sort_order),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapTag(r: Row): Tag {
  return {
    id: String(r.id),
    name: String(r.name),
    color: strOrNull(r.color),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapHistory(r: Row): HistoryEntry {
  return {
    id: String(r.id),
    url: strOrNull(r.url),
    title: strOrNull(r.title),
    kind: (strOrNull(r.kind) ?? 'web') as HistoryKind,
    targetRef: strOrNull(r.target_ref),
    visitedAt: num(r.visited_at),
    dwellMs: numOrNull(r.dwell_ms),
    meta: parseJson<Record<string, unknown> | null>(r.meta, null),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapProfile(r: Row): Profile {
  return {
    id: String(r.id),
    name: String(r.name),
    isActive: bool(r.is_active),
    settings: parseJson<Record<string, unknown> | null>(r.settings, null),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapAgent(r: Row): Agent {
  return {
    id: String(r.id),
    profileId: strOrNull(r.profile_id),
    name: String(r.name),
    description: strOrNull(r.description),
    kind: (strOrNull(r.kind) ?? 'saved-toolset') as AgentKind,
    spec: parseJson<AgentSpec | null>(r.spec, null),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapSession(r: Row): ChatSession {
  return {
    id: String(r.id),
    profileId: strOrNull(r.profile_id),
    title: strOrNull(r.title),
    model: strOrNull(r.model),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

function mapMessage(r: Row): ChatMessage {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    role: String(r.role),
    content: strOrNull(r.content),
    toolCalls: parseJson<unknown[] | null>(r.tool_calls, null),
    toolCallId: strOrNull(r.tool_call_id),
    name: strOrNull(r.name),
    seq: num(r.seq),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: numOrNull(r.deleted_at),
    rev: num(r.rev),
    originDeviceId: strOrNull(r.origin_device_id),
  };
}

// ── Base ────────────────────────────────────────────────
abstract class BaseRepo {
  constructor(
    protected readonly client: Client,
    protected readonly deviceId: string | null,
  ) {}
}

// ── Bookmarks ───────────────────────────────────────────
export interface BookmarkInput {
  url: string;
  title?: string | null;
  description?: string | null;
  favicon?: string | null;
  kind?: BookmarkKind;
  targetRef?: string | null;
  collectionId?: string | null;
  tags?: string[];
}

export class BookmarksRepo extends BaseRepo {
  async add(input: BookmarkInput): Promise<Bookmark> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO bookmarks (id,url,title,description,favicon,kind,target_ref,collection_id,created_at,updated_at,rev,origin_device_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        input.url,
        input.title ?? null,
        input.description ?? null,
        input.favicon ?? null,
        input.kind ?? 'web',
        input.targetRef ?? null,
        input.collectionId ?? null,
        ts,
        ts,
        1,
        this.deviceId,
      ],
    });
    if (input.tags?.length) {
      for (const t of input.tags) await this.tag(id, t);
    }
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Bookmark | null> {
    const rs = await this.client.execute({
      sql: `SELECT * FROM bookmarks WHERE id=? AND deleted_at IS NULL`,
      args: [id],
    });
    if (!rs.rows.length) return null;
    return mapBookmark(rs.rows[0], await this.tagsFor(id));
  }

  async list(opts: { collectionId?: string; kind?: BookmarkKind; limit?: number; offset?: number } = {}): Promise<Bookmark[]> {
    const where: string[] = ['deleted_at IS NULL'];
    const args: (string | number)[] = [];
    if (opts.collectionId) { where.push('collection_id=?'); args.push(opts.collectionId); }
    if (opts.kind) { where.push('kind=?'); args.push(opts.kind); }
    args.push(opts.limit ?? 100, opts.offset ?? 0);
    const rs = await this.client.execute({
      sql: `SELECT * FROM bookmarks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      args,
    });
    return Promise.all(rs.rows.map(async (r) => mapBookmark(r, await this.tagsFor(String(r.id)))));
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<Bookmark[]> {
    const like = `%${query.toLowerCase()}%`;
    const rs = await this.client.execute({
      sql: `SELECT * FROM bookmarks
            WHERE deleted_at IS NULL AND (lower(title) LIKE ? OR lower(url) LIKE ? OR lower(description) LIKE ?)
            ORDER BY created_at DESC LIMIT ?`,
      args: [like, like, like, opts.limit ?? 50],
    });
    return Promise.all(rs.rows.map(async (r) => mapBookmark(r, await this.tagsFor(String(r.id)))));
  }

  async update(id: string, patch: Partial<BookmarkInput>): Promise<Bookmark | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    await this.client.execute({
      sql: `UPDATE bookmarks SET url=?,title=?,description=?,favicon=?,kind=?,target_ref=?,collection_id=?,updated_at=?,rev=rev+1 WHERE id=?`,
      args: [
        patch.url ?? existing.url,
        patch.title ?? existing.title,
        patch.description ?? existing.description,
        patch.favicon ?? existing.favicon,
        patch.kind ?? existing.kind,
        patch.targetRef ?? existing.targetRef,
        patch.collectionId ?? existing.collectionId,
        now(),
        id,
      ],
    });
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE bookmarks SET deleted_at=?, updated_at=?, rev=rev+1 WHERE id=? AND deleted_at IS NULL`,
      args: [now(), now(), id],
    });
    return rs.rowsAffected > 0;
  }

  async tagsFor(bookmarkId: string): Promise<string[]> {
    const rs = await this.client.execute({
      sql: `SELECT t.name AS name FROM tags t JOIN bookmark_tags bt ON bt.tag_id=t.id
            WHERE bt.bookmark_id=? AND t.deleted_at IS NULL ORDER BY t.name`,
      args: [bookmarkId],
    });
    return rs.rows.map((r) => String(r.name));
  }

  async tag(bookmarkId: string, tagName: string): Promise<void> {
    const ts = now();
    let tagId: string;
    const found = await this.client.execute({ sql: `SELECT id FROM tags WHERE name=?`, args: [tagName] });
    if (found.rows.length) {
      tagId = String(found.rows[0].id);
    } else {
      tagId = newId();
      await this.client.execute({
        sql: `INSERT INTO tags (id,name,created_at,updated_at,rev,origin_device_id) VALUES (?,?,?,?,?,?)`,
        args: [tagId, tagName, ts, ts, 1, this.deviceId],
      });
    }
    await this.client.execute({
      sql: `INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) VALUES (?,?)`,
      args: [bookmarkId, tagId],
    });
  }

  async untag(bookmarkId: string, tagName: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM bookmark_tags WHERE bookmark_id=? AND tag_id=(SELECT id FROM tags WHERE name=?)`,
      args: [bookmarkId, tagName],
    });
  }
}

// ── Collections ─────────────────────────────────────────
export class CollectionsRepo extends BaseRepo {
  async create(name: string, parentId: string | null = null, sortOrder = 0): Promise<Collection> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO collections (id,name,parent_id,sort_order,created_at,updated_at,rev,origin_device_id) VALUES (?,?,?,?,?,?,?,?)`,
      args: [id, name, parentId, sortOrder, ts, ts, 1, this.deviceId],
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Collection | null> {
    const rs = await this.client.execute({ sql: `SELECT * FROM collections WHERE id=? AND deleted_at IS NULL`, args: [id] });
    return rs.rows.length ? mapCollection(rs.rows[0]) : null;
  }

  async list(): Promise<Collection[]> {
    const rs = await this.client.execute(`SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY sort_order, name`);
    return rs.rows.map(mapCollection);
  }

  async move(id: string, parentId: string | null): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE collections SET parent_id=?, updated_at=?, rev=rev+1 WHERE id=? AND deleted_at IS NULL`,
      args: [parentId, now(), id],
    });
    return rs.rowsAffected > 0;
  }

  async remove(id: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE collections SET deleted_at=?, updated_at=?, rev=rev+1 WHERE id=? AND deleted_at IS NULL`,
      args: [now(), now(), id],
    });
    return rs.rowsAffected > 0;
  }
}

// ── Tags ────────────────────────────────────────────────
export class TagsRepo extends BaseRepo {
  async list(): Promise<Tag[]> {
    const rs = await this.client.execute(`SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY name`);
    return rs.rows.map(mapTag);
  }
}

// ── History ─────────────────────────────────────────────
export interface HistoryInput {
  url?: string | null;
  title?: string | null;
  kind?: HistoryKind;
  targetRef?: string | null;
  visitedAt?: number;
  dwellMs?: number | null;
  meta?: Record<string, unknown> | null;
}

export class HistoryRepo extends BaseRepo {
  async record(input: HistoryInput): Promise<HistoryEntry> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO history (id,url,title,kind,target_ref,visited_at,dwell_ms,meta,created_at,updated_at,rev,origin_device_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        input.url ?? null,
        input.title ?? null,
        input.kind ?? 'web',
        input.targetRef ?? null,
        input.visitedAt ?? ts,
        input.dwellMs ?? null,
        toJson(input.meta ?? null),
        ts,
        ts,
        1,
        this.deviceId,
      ],
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<HistoryEntry | null> {
    const rs = await this.client.execute({ sql: `SELECT * FROM history WHERE id=? AND deleted_at IS NULL`, args: [id] });
    return rs.rows.length ? mapHistory(rs.rows[0]) : null;
  }

  async list(opts: { kind?: HistoryKind; limit?: number; offset?: number } = {}): Promise<HistoryEntry[]> {
    const where = ['deleted_at IS NULL'];
    const args: (string | number)[] = [];
    if (opts.kind) { where.push('kind=?'); args.push(opts.kind); }
    args.push(opts.limit ?? 100, opts.offset ?? 0);
    const rs = await this.client.execute({
      sql: `SELECT * FROM history WHERE ${where.join(' AND ')} ORDER BY visited_at DESC LIMIT ? OFFSET ?`,
      args,
    });
    return rs.rows.map(mapHistory);
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<HistoryEntry[]> {
    const like = `%${query.toLowerCase()}%`;
    const rs = await this.client.execute({
      sql: `SELECT * FROM history WHERE deleted_at IS NULL AND (lower(title) LIKE ? OR lower(url) LIKE ?)
            ORDER BY visited_at DESC LIMIT ?`,
      args: [like, like, opts.limit ?? 50],
    });
    return rs.rows.map(mapHistory);
  }

  /** Soft-delete history. With no args clears everything; otherwise by kind or olderThan. */
  async clear(opts: { kind?: HistoryKind; olderThan?: number } = {}): Promise<number> {
    const where = ['deleted_at IS NULL'];
    const args: (string | number)[] = [now(), now()];
    if (opts.kind) { where.push('kind=?'); args.push(opts.kind); }
    if (opts.olderThan) { where.push('visited_at<?'); args.push(opts.olderThan); }
    const rs = await this.client.execute({
      sql: `UPDATE history SET deleted_at=?, updated_at=?, rev=rev+1 WHERE ${where.join(' AND ')}`,
      args,
    });
    return rs.rowsAffected;
  }
}

// ── Profiles ────────────────────────────────────────────
export class ProfilesRepo extends BaseRepo {
  async create(name: string, settings: Record<string, unknown> | null = null): Promise<Profile> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO profiles (id,name,is_active,settings,created_at,updated_at,rev,origin_device_id) VALUES (?,?,?,?,?,?,?,?)`,
      args: [id, name, 0, toJson(settings), ts, ts, 1, this.deviceId],
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Profile | null> {
    const rs = await this.client.execute({ sql: `SELECT * FROM profiles WHERE id=? AND deleted_at IS NULL`, args: [id] });
    return rs.rows.length ? mapProfile(rs.rows[0]) : null;
  }

  async list(): Promise<Profile[]> {
    const rs = await this.client.execute(`SELECT * FROM profiles WHERE deleted_at IS NULL ORDER BY created_at`);
    return rs.rows.map(mapProfile);
  }

  async setActive(id: string): Promise<void> {
    await this.client.execute({ sql: `UPDATE profiles SET is_active=0, updated_at=?, rev=rev+1 WHERE is_active=1`, args: [now()] });
    await this.client.execute({ sql: `UPDATE profiles SET is_active=1, updated_at=?, rev=rev+1 WHERE id=?`, args: [now(), id] });
  }

  async getActive(): Promise<Profile | null> {
    const rs = await this.client.execute(`SELECT * FROM profiles WHERE is_active=1 AND deleted_at IS NULL LIMIT 1`);
    return rs.rows.length ? mapProfile(rs.rows[0]) : null;
  }
}

// ── Agents ──────────────────────────────────────────────
export interface AgentInput {
  name: string;
  description?: string | null;
  kind?: AgentKind;
  spec?: AgentSpec | null;
  profileId?: string | null;
}

export class AgentsRepo extends BaseRepo {
  async create(input: AgentInput): Promise<Agent> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO agents (id,profile_id,name,description,kind,spec,created_at,updated_at,rev,origin_device_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [id, input.profileId ?? null, input.name, input.description ?? null, input.kind ?? 'saved-toolset', toJson(input.spec ?? null), ts, ts, 1, this.deviceId],
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Agent | null> {
    const rs = await this.client.execute({ sql: `SELECT * FROM agents WHERE id=? AND deleted_at IS NULL`, args: [id] });
    return rs.rows.length ? mapAgent(rs.rows[0]) : null;
  }

  async list(profileId?: string): Promise<Agent[]> {
    const sql = profileId
      ? `SELECT * FROM agents WHERE deleted_at IS NULL AND profile_id=? ORDER BY created_at DESC`
      : `SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at DESC`;
    const rs = await this.client.execute(profileId ? { sql, args: [profileId] } : sql);
    return rs.rows.map(mapAgent);
  }

  async remove(id: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `UPDATE agents SET deleted_at=?, updated_at=?, rev=rev+1 WHERE id=? AND deleted_at IS NULL`,
      args: [now(), now(), id],
    });
    return rs.rowsAffected > 0;
  }
}

// ── Chat ────────────────────────────────────────────────
export class ChatRepo extends BaseRepo {
  async createSession(input: { title?: string | null; model?: string | null; profileId?: string | null } = {}): Promise<ChatSession> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO chat_sessions (id,profile_id,title,model,created_at,updated_at,rev,origin_device_id) VALUES (?,?,?,?,?,?,?,?)`,
      args: [id, input.profileId ?? null, input.title ?? null, input.model ?? null, ts, ts, 1, this.deviceId],
    });
    return (await this.getSession(id))!;
  }

  async getSession(id: string): Promise<ChatSession | null> {
    const rs = await this.client.execute({ sql: `SELECT * FROM chat_sessions WHERE id=? AND deleted_at IS NULL`, args: [id] });
    return rs.rows.length ? mapSession(rs.rows[0]) : null;
  }

  async listSessions(opts: { limit?: number } = {}): Promise<ChatSession[]> {
    const rs = await this.client.execute({
      sql: `SELECT * FROM chat_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      args: [opts.limit ?? 50],
    });
    return rs.rows.map(mapSession);
  }

  async addMessage(sessionId: string, msg: { role: string; content?: string | null; toolCalls?: unknown[] | null; toolCallId?: string | null; name?: string | null; seq?: number }): Promise<ChatMessage> {
    const ts = now();
    const id = newId();
    await this.client.execute({
      sql: `INSERT INTO chat_messages (id,session_id,role,content,tool_calls,tool_call_id,name,seq,created_at,updated_at,rev,origin_device_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, sessionId, msg.role, msg.content ?? null, toJson(msg.toolCalls ?? null), msg.toolCallId ?? null, msg.name ?? null, msg.seq ?? 0, ts, ts, 1, this.deviceId],
    });
    await this.client.execute({ sql: `UPDATE chat_sessions SET updated_at=?, rev=rev+1 WHERE id=?`, args: [ts, sessionId] });
    const rs = await this.client.execute({ sql: `SELECT * FROM chat_messages WHERE id=?`, args: [id] });
    return mapMessage(rs.rows[0]);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const rs = await this.client.execute({
      sql: `SELECT * FROM chat_messages WHERE session_id=? AND deleted_at IS NULL ORDER BY seq, created_at`,
      args: [sessionId],
    });
    return rs.rows.map(mapMessage);
  }
}
