import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IconX, IconSearch, IconEdit, IconTrash } from './Icons';
import type { ChatSessionSummary } from '../types';
import './HistoryPanel.css';

interface HistoryPanelProps {
  /** The chat on screen, highlighted in the list. */
  currentId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** A chat was deleted (the app starts a new one if it was the open chat). */
  onDeleted: (id: string) => void;
}

const DAY = 86_400_000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function groupLabel(ts: number, today: number): string {
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return 'Previous 7 days';
  return 'Older';
}

function timeLabel(ts: number, today: number): string {
  const d = new Date(ts);
  return ts >= today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const hostOf = (url: string) => {
  try { return new URL(url).hostname; } catch { return url; }
};

/** Saved conversations (local, in surge.db): search, reopen, rename, delete. */
const HistoryPanel: React.FC<HistoryPanelProps> = ({ currentId, onOpen, onClose, onDeleted }) => {
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    const list = await window.surge.chats.list({ limit: 200, query: q.trim() || undefined }).catch(() => []);
    setSessions(list);
  }, []);

  // Search as you type (debounced); the first load is immediate.
  useEffect(() => {
    const t = setTimeout(() => load(query), query ? 200 : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  const today = startOfToday();
  const groups = useMemo(() => {
    const out: Array<[string, ChatSessionSummary[]]> = [];
    for (const s of sessions ?? []) {
      const label = groupLabel(s.updatedAt, today);
      const last = out[out.length - 1];
      if (last && last[0] === label) last[1].push(s);
      else out.push([label, [s]]);
    }
    return out;
  }, [sessions, today]);

  const saveRename = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    setRenaming(null);
    if (title) {
      await window.surge.chats.update(renaming.id, { title }).catch(() => {});
      load(query);
    }
  };

  const doDelete = async (id: string) => {
    await window.surge.chats.remove(id).catch(() => {});
    setConfirmDelete(null);
    onDeleted(id);
    load(query);
  };

  return (
    <div className="history-panel-overlay">
      <div className="history-panel glass-panel slide-up">
        <div className="hp-header">
          <span className="hp-title">Chat history</span>
          <button className="btn-icon" onClick={onClose} title="Close"><IconX size={15} /></button>
        </div>

        <div className="hp-search">
          <IconSearch size={14} />
          <input
            autoFocus
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
        </div>

        <div className="hp-list">
          {sessions !== null && sessions.length === 0 && (
            <div className="hp-empty">
              {query.trim() ? 'No chats match.' : 'No chats yet. Conversations are saved here as you go.'}
            </div>
          )}
          {groups.map(([label, items]) => (
            <div key={label} className="hp-group">
              <div className="hp-group-label">{label}</div>
              {items.map((s) => (
                <div key={s.id} className={`hp-item ${s.id === currentId ? 'active' : ''}`}>
                  {renaming?.id === s.id ? (
                    <input
                      className="hp-rename"
                      autoFocus
                      value={renaming.title}
                      onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={saveRename}
                    />
                  ) : confirmDelete === s.id ? (
                    <div className="hp-confirm">
                      <span>Delete this chat?</span>
                      <button className="btn-ghost btn-sm hp-danger" onClick={() => doDelete(s.id)}>Delete</button>
                      <button className="btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <button className="hp-open" onClick={() => onOpen(s.id)} title={s.title || 'Untitled chat'}>
                        <span className="hp-item-title">{s.title || 'Untitled chat'}</span>
                        <span className="hp-item-meta">
                          {timeLabel(s.updatedAt, today)}
                          {s.pageUrl ? ` · ${hostOf(s.pageUrl)}` : ''}
                        </span>
                      </button>
                      <div className="hp-actions">
                        <button className="btn-icon" title="Rename" onClick={() => setRenaming({ id: s.id, title: s.title || '' })}>
                          <IconEdit size={13} />
                        </button>
                        <button className="btn-icon" title="Delete" onClick={() => setConfirmDelete(s.id)}>
                          <IconTrash size={13} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default HistoryPanel;
