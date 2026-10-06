import React, { useState, useEffect } from 'react';
import { IconX, IconSliders, IconBot, IconBolt, IconWrench, IconCreditCard, IconKey, IconCpu, IconNetwork } from './Icons';
import type { AiModel, ModelLevel } from '../types';
import './SettingsPanel.css';

interface SettingsPanelProps {
  selectedModel: string;
  models: AiModel[];
  onSelectModel: (id: string) => void;
  onModelsChanged: (models: AiModel[]) => void;
  onClose: () => void;
}

// ONP-5 §2 payment schemes (mirrors ONP_SCHEMES in @surge/core/onp)
const ONP_SCHEMES = ['free', 'prepaid', 'x402'];

const LEVEL_INFO: Record<ModelLevel, { icon: string; label: string; description: string; className: string }> = {
  quick: { icon: '\u26A1', label: 'Quick', description: 'Free, instant responses for simple questions', className: 'level-quick' },
  smart: { icon: '\uD83E\uDDE0', label: 'Smart', description: 'Great for most tasks — coding, writing, analysis', className: 'level-smart' },
  best:  { icon: '\uD83D\uDC8E', label: 'Best', description: 'Maximum quality for complex reasoning', className: 'level-best' },
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({ selectedModel, models, onSelectModel, onModelsChanged, onClose }) => {
  const [tab, setTab] = useState<'general' | 'models' | 'advanced' | 'subscription'>('general');
  const [geminiKey, setGeminiKey] = useState('');
  const [groqKey, setGroqKey] = useState('');
  const [claudeKey, setClaudeKey] = useState('');
  const [mistralKey, setMistralKey] = useState('');
  const [ollamaHost, setOllamaHost] = useState('http://localhost:11434');
  const [vllmEndpoint, setVllmEndpoint] = useState('');
  const [vllmModel, setVllmModel] = useState('');
  const [vllmApiKey, setVllmApiKey] = useState('');
  const [vllmModels, setVllmModels] = useState<string[]>([]);
  const [vllmStatus, setVllmStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [onpRegistryUrl, setOnpRegistryUrl] = useState('');
  const [onpModelCount, setOnpModelCount] = useState(0);
  const [onpStatus, setOnpStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  // OpenNodes spend policy (ONP-5); numbers are edited as text and committed on blur
  const [policy, setPolicy] = useState({ maxRequestUsd: '0', dailyBudgetUsd: '0', maxPricePerMtok: '', minTier: 'unverified', schemes: ONP_SCHEMES });
  const [spentToday, setSpentToday] = useState(0);
  const [tier, setTier] = useState('free');

  useEffect(() => {
    const load = async () => {
      const s = window.surge.settings;
      setGeminiKey(await s.get('ai.geminiApiKey') || '');
      setGroqKey(await s.get('ai.groqApiKey') || '');
      setClaudeKey(await s.get('ai.claudeApiKey') || '');
      setMistralKey(await s.get('ai.mistralApiKey') || '');
      setOllamaHost(await s.get('ai.ollamaHost') || 'http://localhost:11434');
      setVllmEndpoint(await s.get('ai.vllmEndpoint') || '');
      setVllmModel(await s.get('ai.vllmModel') || '');
      setVllmApiKey(await s.get('ai.vllmApiKey') || '');
      setOnpRegistryUrl(await s.get('ai.onpRegistryUrl') || '');
      const p = await s.get('onp.policy') || {};
      setPolicy({
        maxRequestUsd: String(p.maxRequestUsd ?? 0),
        dailyBudgetUsd: String(p.dailyBudgetUsd ?? 0),
        maxPricePerMtok: p.maxPricePerMtok == null ? '' : String(p.maxPricePerMtok),
        minTier: p.minTier || 'unverified',
        schemes: Array.isArray(p.schemes) ? p.schemes : ONP_SCHEMES,
      });
      const spend = await s.get('onp.spend');
      setSpentToday(spend?.day === new Date().toISOString().slice(0, 10) ? Number(spend.usd) || 0 : 0);
      setTier(await s.getTier());
    };
    load();
  }, []);

  const save = async (key: string, value: unknown) => {
    await window.surge.settings.set(key, value);
  };

  // Core re-validates the stored policy (normalizeOnpPolicy); blanks and junk fall back to safe values.
  const savePolicy = (next: typeof policy) => {
    setPolicy(next);
    const usd = (v: string) => (Number(v) >= 0 ? Number(v) : 0);
    save('onp.policy', {
      maxRequestUsd: usd(next.maxRequestUsd),
      dailyBudgetUsd: usd(next.dailyBudgetUsd),
      maxPricePerMtok: next.maxPricePerMtok.trim() === '' ? null : usd(next.maxPricePerMtok),
      minTier: next.minTier,
      schemes: next.schemes,
    });
  };

  // Test vLLM connection and discover available models
  const testVllmConnection = async () => {
    if (!vllmEndpoint) return;
    setVllmStatus('checking');
    setVllmModels([]);
    try {
      // Normalize endpoint: ensure it ends with /v1
      let endpoint = vllmEndpoint.trim().replace(/\/+$/, '');
      if (!endpoint.endsWith('/v1')) endpoint += '/v1';

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (vllmApiKey) headers['Authorization'] = `Bearer ${vllmApiKey}`;

      const response = await fetch(`${endpoint}/models`, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const models = (data.data || []).map((m: any) => m.id);
      setVllmModels(models);
      setVllmStatus('connected');
      // Auto-select first model if none set
      if (models.length > 0 && !vllmModel) {
        setVllmModel(models[0]);
        save('ai.vllmModel', models[0]);
      }
    } catch (err: any) {
      setVllmStatus('error');
      setVllmModels([]);
    }
  };

  // Save the registry URL, then reload the model list through the main process (which owns
  // ONP discovery) so the picker reflects the new registry immediately.
  const refreshOnpModels = async () => {
    setOnpStatus('checking');
    try {
      await save('ai.onpRegistryUrl', onpRegistryUrl.trim());
      const fresh: AiModel[] = await window.surge.ai.getModels();
      onModelsChanged(fresh);
      const count = fresh.filter(m => m.provider === 'onp').length;
      setOnpModelCount(count);
      setOnpStatus(count > 0 ? 'connected' : 'error');
    } catch {
      setOnpStatus('error');
    }
  };

  // Group models by level
  const modelsByLevel: Record<ModelLevel, AiModel[]> = { quick: [], smart: [], best: [] };
  models.forEach(m => {
    const lvl = (m.level || 'quick') as ModelLevel;
    if (modelsByLevel[lvl]) modelsByLevel[lvl].push(m);
  });

  const tabs = [
    { id: 'general' as const, icon: <IconSliders size={14} />, label: 'Models' },
    { id: 'models' as const, icon: <IconKey size={14} />, label: 'API Keys' },
    { id: 'advanced' as const, icon: <IconWrench size={14} />, label: 'Advanced' },
    { id: 'subscription' as const, icon: <IconCreditCard size={14} />, label: 'Plan' },
  ];

  return (
    <div className="settings-panel slide-up">
      <div className="settings-header">
        <h2><IconSliders size={18} /> Settings</h2>
        <button className="btn-icon" onClick={onClose}><IconX size={15} /></button>
      </div>

      <div className="settings-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`settings-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        {tab === 'general' && (
          <div className="settings-section">
            <h3>Appearance</h3>
            <div className="theme-toggle-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Theme</span>
              <button
                className={`theme-btn ${document.documentElement.getAttribute('data-theme') !== 'light' ? 'active' : ''}`}
                onClick={() => { document.documentElement.removeAttribute('data-theme'); window.surge.settings.set('ui.theme', 'dark'); }}
                style={{ padding: '6px 16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', background: document.documentElement.getAttribute('data-theme') !== 'light' ? 'var(--accent-cyan-glow)' : 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)' }}
              >
                🌙 Dark
              </button>
              <button
                className={`theme-btn ${document.documentElement.getAttribute('data-theme') === 'light' ? 'active' : ''}`}
                onClick={() => { document.documentElement.setAttribute('data-theme', 'light'); window.surge.settings.set('ui.theme', 'light'); }}
                style={{ padding: '6px 16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', background: document.documentElement.getAttribute('data-theme') === 'light' ? 'var(--accent-cyan-glow)' : 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)' }}
              >
                ☀️ Light
              </button>
            </div>

            <h3>Model Preferences</h3>
            <p className="settings-hint" style={{ marginBottom: '16px' }}>
              Choose which AI model powers each level. The active model is used when you select that level in the search bar.
            </p>

            {(['quick', 'smart', 'best'] as ModelLevel[]).map(level => {
              const info = LEVEL_INFO[level];
              const levelModels = modelsByLevel[level];
              if (levelModels.length === 0) return null;

              return (
                <div key={level} className={`model-level-section ${info.className}`}>
                  <div className="model-level-section-header">
                    <span className="model-level-section-icon">{info.icon}</span>
                    <div>
                      <div className="model-level-section-name">{info.label}</div>
                      <div className="model-level-section-desc">{info.description}</div>
                    </div>
                  </div>
                  <div className="model-grid">
                    {levelModels.map(m => {
                      const isLocked = m.tier !== 'free' && tier === 'free';
                      return (
                        <button
                          key={m.id}
                          className={`model-card ${m.id === selectedModel ? 'active' : ''} ${isLocked ? 'locked' : ''}`}
                          onClick={() => { if (!isLocked) onSelectModel(m.id); }}
                        >
                          <div className="model-card-icon"><IconBot size={20} /></div>
                          <div className="model-card-name">{m.name}</div>
                          <div className="model-card-desc">{m.description}</div>
                          <div className="model-card-cost">{m.costEstimate}</div>
                          {isLocked && (
                            <span className="badge badge-purple" style={{marginTop: '4px'}}>PRO</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'models' && (
          <div className="settings-section">
            <h3>API Keys</h3>
            <p className="settings-hint">Free models (Gemini Flash-Lite, Groq) need free API keys. Get them in seconds — no credit card required.</p>

            <div className="api-key-group">
              <label><IconKey size={13} /> Gemini API Key <a href="https://ai.google.dev" target="_blank" rel="noopener" className="key-link">(get free key)</a></label>
              <input className="input" type="password" placeholder="AIza..." value={geminiKey}
                onChange={e => setGeminiKey(e.target.value)}
                onBlur={() => save('ai.geminiApiKey', geminiKey)} />
            </div>

            <div className="api-key-group">
              <label><IconKey size={13} /> Groq API Key <a href="https://console.groq.com" target="_blank" rel="noopener" className="key-link">(get free key)</a></label>
              <input className="input" type="password" placeholder="gsk_..." value={groqKey}
                onChange={e => setGroqKey(e.target.value)}
                onBlur={() => save('ai.groqApiKey', groqKey)} />
            </div>

            {tier !== 'free' && (
              <>
                <div className="api-key-group">
                  <label><IconKey size={13} /> Claude API Key</label>
                  <input className="input" type="password" placeholder="sk-ant-..." value={claudeKey}
                    onChange={e => setClaudeKey(e.target.value)}
                    onBlur={() => save('ai.claudeApiKey', claudeKey)} />
                </div>

                <div className="api-key-group">
                  <label><IconKey size={13} /> Mistral API Key</label>
                  <input className="input" type="password" placeholder="" value={mistralKey}
                    onChange={e => setMistralKey(e.target.value)}
                    onBlur={() => save('ai.mistralApiKey', mistralKey)} />
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'advanced' && (
          <div className="settings-section">
            <h3>
              <IconNetwork size={16} /> OpenNodes Registry
              {onpStatus === 'connected' && <span className="badge badge-green" style={{marginLeft: 8, fontSize: '0.6rem'}}>Connected</span>}
              {onpStatus === 'error' && <span className="badge badge-red" style={{marginLeft: 8, fontSize: '0.6rem'}}>Error</span>}
            </h3>
            <div className="api-key-group">
              <label>Registry URL</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input className="input" placeholder="https://registry.opennodes.io" value={onpRegistryUrl}
                  onChange={e => setOnpRegistryUrl(e.target.value)}
                  onBlur={() => save('ai.onpRegistryUrl', onpRegistryUrl.trim())}
                  style={{ flex: 1 }} />
                <button className="btn-primary btn-sm" onClick={refreshOnpModels}
                  disabled={onpStatus === 'checking'}
                  style={{ whiteSpace: 'nowrap' }}>
                  {onpStatus === 'checking' ? <div className="spinner spinner-sm" /> : 'Test & Refresh'}
                </button>
              </div>
              <span className="settings-hint">
                Models from OpenNodes nodes appear in the model picker with their trust tier, measured latency, and price.
                Leave empty for the hosted registry; a local one runs with <code>npx @opennodes/registry</code> on http://127.0.0.1:4300
              </span>
              {onpStatus === 'connected' && (
                <span className="settings-hint" style={{ color: 'var(--accent-green)' }}>
                  {onpModelCount} OpenNodes model{onpModelCount !== 1 ? 's' : ''} now in the picker
                </span>
              )}
              {onpStatus === 'error' && (
                <span className="settings-hint" style={{ color: 'var(--accent-red)' }}>
                  No models from this registry. Check the URL and that the registry is reachable.
                </span>
              )}
            </div>

            <div className="api-key-group">
              <label>Spend policy</label>
              <span className="settings-hint">
                Checked before every OpenNodes call. Free offerings always run; with both limits at $0, anything paid is blocked.
                Disputed and suspended nodes are always blocked. Spent today (UTC): ${spentToday.toFixed(6)}
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginTop: '8px' }}>
                {([
                  ['maxRequestUsd', 'Per request ($)', '0'],
                  ['dailyBudgetUsd', 'Per day ($)', '0'],
                  ['maxPricePerMtok', 'Max price per MTok ($)', 'no cap'],
                ] as const).map(([field, label, placeholder]) => (
                  <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span className="settings-hint">{label}</span>
                    <input className="input" inputMode="decimal" placeholder={placeholder} value={policy[field]}
                      onChange={e => setPolicy({ ...policy, [field]: e.target.value })}
                      onBlur={() => savePolicy(policy)} />
                  </label>
                ))}
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span className="settings-hint">Minimum tier</span>
                  <select className="input" value={policy.minTier}
                    onChange={e => savePolicy({ ...policy, minTier: e.target.value })}>
                    {['unverified', 'community', 'verified', 'attested'].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '8px', alignItems: 'center' }}>
                <span className="settings-hint">Payment schemes</span>
                {ONP_SCHEMES.map(scheme => (
                  <label key={scheme} style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: 'var(--text-sm)' }}>
                    <input type="checkbox" checked={policy.schemes.includes(scheme)}
                      onChange={e => savePolicy({
                        ...policy,
                        schemes: e.target.checked ? [...policy.schemes, scheme] : policy.schemes.filter(s => s !== scheme),
                      })} />
                    {scheme}
                  </label>
                ))}
              </div>
            </div>

            <h3 style={{marginTop: '24px'}}><IconCpu size={16} /> Ollama (Local)</h3>
            <div className="api-key-group">
              <label>Ollama Host URL</label>
              <input className="input" placeholder="http://localhost:11434" value={ollamaHost}
                onChange={e => setOllamaHost(e.target.value)}
                onBlur={() => save('ai.ollamaHost', ollamaHost)} />
              <span className="settings-hint">Install Ollama at ollama.ai — runs models locally, 100% free & private</span>
            </div>

            <h3 style={{marginTop: '24px'}}>
              <IconNetwork size={16} /> vLLM / OpenAI-Compatible (Local Network)
              {vllmStatus === 'connected' && <span className="badge badge-green" style={{marginLeft: 8, fontSize: '0.6rem'}}>Connected</span>}
              {vllmStatus === 'error' && <span className="badge badge-red" style={{marginLeft: 8, fontSize: '0.6rem'}}>Error</span>}
            </h3>
            <div className="api-key-group">
              <label>Endpoint URL</label>
              <input className="input" placeholder="http://192.168.1.100:8000/v1 or http://localhost:8000/v1" value={vllmEndpoint}
                onChange={e => setVllmEndpoint(e.target.value)}
                onBlur={() => save('ai.vllmEndpoint', vllmEndpoint)} />
              <span className="settings-hint">
                Works with vLLM, TGI, LocalAI, LM Studio, or any OpenAI-compatible server on your LAN
              </span>
            </div>
            <div className="api-key-group">
              <label>API Key (optional — if your server requires auth)</label>
              <input className="input" type="password" placeholder="Leave empty if no auth needed" value={vllmApiKey}
                onChange={e => setVllmApiKey(e.target.value)}
                onBlur={() => save('ai.vllmApiKey', vllmApiKey)} />
            </div>
            <div className="api-key-group">
              <label>Model</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {vllmModels.length > 0 ? (
                  <select className="input" value={vllmModel}
                    onChange={e => { setVllmModel(e.target.value); save('ai.vllmModel', e.target.value); }}
                    style={{ flex: 1 }}>
                    {vllmModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input className="input" placeholder="meta-llama/Llama-3.3-70B-Instruct" value={vllmModel}
                    onChange={e => setVllmModel(e.target.value)}
                    onBlur={() => save('ai.vllmModel', vllmModel)}
                    style={{ flex: 1 }} />
                )}
                <button className="btn-primary btn-sm" onClick={testVllmConnection}
                  disabled={!vllmEndpoint || vllmStatus === 'checking'}
                  style={{ whiteSpace: 'nowrap' }}>
                  {vllmStatus === 'checking' ? <div className="spinner spinner-sm" /> : 'Test & Discover'}
                </button>
              </div>
              {vllmModels.length > 0 && (
                <span className="settings-hint" style={{ color: 'var(--accent-green)' }}>
                  Found {vllmModels.length} model{vllmModels.length !== 1 ? 's' : ''} on server
                </span>
              )}
              {vllmStatus === 'error' && (
                <span className="settings-hint" style={{ color: 'var(--accent-red)' }}>
                  Could not connect. Check the endpoint URL and ensure the server is running.
                </span>
              )}
            </div>
          </div>
        )}

        {tab === 'subscription' && (
          <div className="settings-section">
            <div className="tier-current">
              <span className="tier-badge"><IconBolt size={24} /></span>
              <div>
                <div className="tier-name">Surge {tier.charAt(0).toUpperCase() + tier.slice(1)}</div>
                <div className="tier-desc">
                  {tier === 'free' ? 'Free forever — Quick models, 3 MCP connections' : 'All premium features unlocked'}
                </div>
              </div>
            </div>

            {tier === 'free' && (
              <div className="upgrade-section">
                <h3>Upgrade to Pro</h3>
                <div className="upgrade-comparison">
                  <div className="upgrade-col">
                    <h4>Free</h4>
                    <ul>
                      <li>{'\u26A1'} Quick models (Gemini, Groq, Ollama)</li>
                      <li>3 MCP connections</li>
                      <li>50 searches/day</li>
                      <li>MCPWeb detection</li>
                      <li>Browser AI tools</li>
                    </ul>
                  </div>
                  <div className="upgrade-col pro">
                    <h4>Pro — $9.99/mo</h4>
                    <ul>
                      <li>Everything in Free</li>
                      <li>{'\uD83E\uDDE0'} Smart models (Claude Sonnet, GPT-4o, Gemini Pro)</li>
                      <li>{'\uD83D\uDC8E'} Best models (Claude Opus)</li>
                      <li>Unlimited MCP connections</li>
                      <li>Unlimited search</li>
                      <li>Power-Up Packs</li>
                    </ul>
                    <button className="btn-primary" style={{width: '100%', marginTop: '16px'}}>
                      Upgrade Now
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPanel;
