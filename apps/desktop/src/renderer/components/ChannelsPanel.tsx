import React, { useCallback, useEffect, useState } from 'react';
import { IconX } from './Icons';
import type { SocialChannel } from '../types';
import './HistoryPanel.css';
import './ChannelsPanel.css';

interface ChannelsPanelProps {
  onOpen: (channel: SocialChannel) => void;
  onSummarize: (channel: SocialChannel) => void;
  onClose: () => void;
}

/**
 * Social channels read in Surge's browser with the user's own sign-in: open a feed, summarize it,
 * or make Surge's browser forget a sign-in. Surge never posts, likes or messages.
 */
const ChannelsPanel: React.FC<ChannelsPanelProps> = ({ onOpen, onSummarize, onClose }) => {
  const [channels, setChannels] = useState<SocialChannel[] | null>(null);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setChannels(await window.surge.channels.list().catch(() => []));
  }, []);
  useEffect(() => { load(); }, [load]);

  const forget = async (id: string) => {
    await window.surge.channels.forget(id).catch(() => {});
    setConfirmForget(null);
    load();
  };

  return (
    <div className="history-panel-overlay">
      <div className="history-panel glass-panel slide-up">
        <div className="hp-header">
          <span className="hp-title">Channels</span>
          <button className="btn-icon" onClick={onClose} title="Close"><IconX size={15} /></button>
        </div>
        <p className="ch-intro">
          Read and summarize your feeds in Surge's browser, signed in with your own accounts.
          Surge only reads what you ask it to: it never posts, likes or messages.
        </p>
        <div className="hp-list">
          {(channels ?? []).map((c) => (
            <div key={c.id} className="ch-item">
              <div className="ch-row">
                <span className={`ch-avatar ch-${c.id}`} aria-hidden="true">{c.name.charAt(0)}</span>
                <div className="ch-info">
                  <span className="ch-name">{c.name}</span>
                  <span className={`ch-status ${c.signedIn ? 'on' : ''}`}>{c.signedIn ? 'Signed in' : 'Not signed in'}</span>
                </div>
              </div>
              {confirmForget === c.id ? (
                <div className="hp-confirm">
                  <span>Sign out of {c.name} in Surge's browser?</span>
                  <button className="btn-ghost btn-sm hp-danger" onClick={() => forget(c.id)}>Sign out</button>
                  <button className="btn-ghost btn-sm" onClick={() => setConfirmForget(null)}>Cancel</button>
                </div>
              ) : (
                <div className="ch-actions">
                  <button className="btn-ghost btn-sm" onClick={() => onOpen(c)} title={c.signedIn ? `Open ${c.name}` : `Open ${c.name} to sign in`}>
                    {c.signedIn ? 'Open' : 'Open & sign in'}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => onSummarize(c)}
                    title={c.signedIn ? `Summarize your ${c.name} feed` : `Sign in first for your own feed; without it you'll get ${c.name}'s public page`}>
                    Summarize my feed
                  </button>
                  {c.signedIn && (
                    <button className="btn-ghost btn-sm" onClick={() => setConfirmForget(c.id)} title={`Sign out of ${c.name} in Surge's browser`}>Sign out</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ChannelsPanel;
