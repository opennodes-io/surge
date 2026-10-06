import React, { useState, useRef, useEffect } from 'react';
import { IconSearch, IconBot, IconChevronDown, IconChevronUp } from './Icons';
import type { AppMode, AiModel, ModelLevel } from '../types';
import './SearchBar.css';

interface SearchBarProps {
  onSubmit: (query: string) => void;
  isStreaming: boolean;
  mode: AppMode;
  selectedModel: string;
  models: AiModel[];
  onSelectModel: (id: string) => void;
  privateMode: boolean;
  onTogglePrivate: () => void;
}

// Level metadata for the Quick/Smart/Best UI
const LEVEL_META: Record<ModelLevel, { icon: string; label: string; tagline: string; className: string }> = {
  quick: { icon: '\u26A1', label: 'Quick', tagline: 'Free, instant responses', className: 'level-quick' },
  smart: { icon: '\uD83E\uDDE0', label: 'Smart', tagline: 'Great for most tasks', className: 'level-smart' },
  best:  { icon: '\uD83D\uDC8E', label: 'Best', tagline: 'Complex reasoning', className: 'level-best' },
};

const SearchBar: React.FC<SearchBarProps> = ({
  onSubmit,
  isStreaming,
  mode,
  selectedModel,
  models,
  onSelectModel,
  privateMode,
  onTogglePrivate,
}) => {
  const [query, setQuery] = useState('');
  const [showModels, setShowModels] = useState(false);
  const [expandedLevel, setExpandedLevel] = useState<ModelLevel | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number }>({ top: 0, right: 16 });

  useEffect(() => {
    if (inputRef.current && mode === 'idle') {
      inputRef.current.focus();
    }
  }, [mode]);

  // The idle window is a 160px strip, too short for the model list: grow it while the list is open
  // (anchoring the list to the button once the window has resized), and shrink it back on close
  // unless a chat started meanwhile.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (!showModels) return;
    // `position: fixed` is relative to the nearest ancestor with a backdrop-filter/transform (the
    // glass search bar), not the viewport, so measure against that box.
    const place = () => {
      const btn = modelBtnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      let box = { top: 0, right: window.innerWidth };
      for (let el = btn.parentElement; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.backdropFilter !== 'none' || s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none') {
          const r = el.getBoundingClientRect();
          box = { top: r.top, right: r.right };
          break;
        }
      }
      setDropdownPos({ top: rect.bottom + 8 - box.top, right: box.right - rect.right });
    };
    // The search bar keeps moving after a resize (a 0.4s padding transition), so follow it a little longer.
    let frame = 0;
    let until = 0;
    const follow = () => { place(); if (performance.now() < until) frame = requestAnimationFrame(follow); };
    const onResize = () => { until = performance.now() + 700; cancelAnimationFrame(frame); follow(); };
    onResize();
    window.addEventListener('resize', onResize);
    const grew = modeRef.current === 'idle';
    if (grew) window.surge?.window?.resize('expanded');
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      if (grew && modeRef.current === 'idle') window.surge?.window?.resize('compact');
    };
  }, [showModels]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModels(false);
        setExpandedLevel(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (query.trim()) {
        onSubmit(query.trim());
        setQuery('');
      }
    }
    if (e.key === 'Escape') {
      setQuery('');
    }
  };

  const currentModel = models.find(m => m.id === selectedModel);
  const currentLevel = currentModel?.level || 'quick';
  const currentLevelMeta = LEVEL_META[currentLevel];

  // Group models by level
  const modelsByLevel: Record<ModelLevel, AiModel[]> = { quick: [], smart: [], best: [] };
  models.forEach(m => {
    const lvl = m.level || 'quick';
    if (modelsByLevel[lvl]) modelsByLevel[lvl].push(m);
  });

  return (
    <div className={`search-bar-wrapper ${mode === 'idle' ? 'compact' : 'inline'}`}>
      <div className={`search-bar glass-panel ${mode === 'idle' ? 'glow' : ''}`}>
        <IconSearch size={16} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="search-input no-drag"
          placeholder={mode === 'idle' ? 'Ask anything, visit a site, or search the web...' : 'Continue the conversation...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          autoFocus
        />

        {/* One-click private mode: only models on this machine and the LAN answer */}
        <button
          className={`private-btn btn-ghost btn-sm no-drag ${privateMode ? 'active' : ''}`}
          onClick={onTogglePrivate}
          aria-pressed={privateMode}
          title={privateMode
            ? 'Private mode is on: only models on your machines answer. Click to turn it off.'
            : 'Private mode: answer only with models on your own machines (local Ollama and LAN)'}
        >
          <span aria-hidden="true">{privateMode ? '\uD83D\uDD12' : '\uD83D\uDD13'}</span>
          {privateMode && <span className="private-label">Private</span>}
        </button>

        {/* Model selector — shows Quick/Smart/Best with real model name */}
        <div className="model-selector no-drag" ref={dropdownRef}>
          <button
            ref={modelBtnRef}
            className={`model-btn btn-ghost btn-sm ${currentLevelMeta.className}`}
            onClick={() => {
              setShowModels(!showModels);
              setExpandedLevel(null);
            }}
            title={`${currentLevelMeta.label} mode — ${currentModel?.name || 'Select model'}`}
          >
            <span className="model-level-icon">{currentLevelMeta.icon}</span>
            <span className="model-name">{currentModel?.name || 'Model'}</span>
            {showModels ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </button>

          {showModels && (
            <div className="model-dropdown glass-panel scale-in" style={{ top: dropdownPos.top, right: dropdownPos.right }}>
              {(['quick', 'smart', 'best'] as ModelLevel[]).map(level => {
                const meta = LEVEL_META[level];
                const levelModels = modelsByLevel[level];
                if (levelModels.length === 0) return null;
                const isExpanded = expandedLevel === level;
                const activeInLevel = levelModels.find(m => m.id === selectedModel);

                return (
                  <div key={level} className={`model-level-group ${meta.className}`}>
                    {/* Level header — clickable to expand/collapse */}
                    <button
                      className={`model-level-header ${activeInLevel ? 'active' : ''}`}
                      onClick={() => setExpandedLevel(isExpanded ? null : level)}
                    >
                      <span className="model-level-icon-lg">{meta.icon}</span>
                      <div className="model-level-info">
                        <div className="model-level-name">
                          {meta.label}
                          {activeInLevel && (
                            <span className="model-level-current"> — {activeInLevel.name}</span>
                          )}
                        </div>
                        <div className="model-level-tagline">{meta.tagline}</div>
                      </div>
                      <div className="model-level-cost">
                        {levelModels[0]?.costEstimate || ''}
                      </div>
                      <span className="model-level-chevron">
                        {isExpanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                      </span>
                    </button>

                    {/* Expanded: show all models in this level */}
                    {isExpanded && (
                      <div className="model-level-models">
                        {levelModels.map(m => (
                          <button
                            key={m.id}
                            className={`model-option ${m.id === selectedModel ? 'active' : ''}`}
                            onClick={() => { onSelectModel(m.id); setShowModels(false); setExpandedLevel(null); }}
                          >
                            <div className="model-option-info">
                              <div className="model-option-name">{m.name}</div>
                              <div className="model-option-desc">{m.description}</div>
                            </div>
                            <span className="model-option-cost">{m.costEstimate}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isStreaming && (
          <div className="search-status">
            <div className="spinner spinner-sm"></div>
          </div>
        )}
      </div>

      {mode === 'idle' && (
        <div className="search-hints fade-in">
          <span className="hint-item"><IconSearch size={12} /> Web & MCPWeb</span>
          <span className="hint-divider">&middot;</span>
          <span className="hint-item"><IconBot size={12} /> AI Chat</span>
          <span className="hint-divider">&middot;</span>
          <span className="hint-item">{'\u26A1'} Power-Ups</span>
          <span className="hint-divider">&middot;</span>
          <span className="hint-shortcut">Ctrl+Shift+Space</span>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
