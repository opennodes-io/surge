import React, { useState, useEffect } from 'react';
import { IconX, IconSliders, IconBot, IconWrench, IconKey, IconCpu, IconNetwork, IconFile, IconPlug } from './Icons';
import type { AiModel, ModelLevel, PrivateStatus, HubStatus } from '../types';
import SpendDashboard from './SpendDashboard';
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

// A write-only API key field: a saved key is never read back into the page. Typing a new key
// and leaving the field (or pressing Enter) replaces it; Remove deletes it.
const SecretField: React.FC<{ settingKey: string; placeholder: string; saved: boolean; onChange: (saved: boolean) => void }> = (
  { settingKey, placeholder, saved, onChange },
) => {
  const [value, setValue] = useState('');
  const commit = async () => {
    if (!value.trim()) return;
    await window.surge.settings.set(settingKey, value.trim());
    setValue('');
    onChange(true);
  };
  const remove = async () => {
    await window.surge.settings.set(settingKey, '');
    onChange(false);
  };
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <input className="input" type="password" placeholder={saved ? 'Saved \u2014 type a new key to replace it' : placeholder} value={value}
        onChange={e => setValue(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }} style={{ flex: 1 }} />
      {saved && <button className="btn-ghost btn-sm" onClick={remove} style={{ whiteSpace: 'nowrap' }}>Remove</button>}
    </div>
  );
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({ selectedModel, models, onSelectModel, onModelsChanged, onClose }) => {
  const [tab, setTab] = useState<'general' | 'models' | 'advanced' | 'spend'>('general');
  // Which provider keys are saved (values stay in the main process) and whether the OS keychain holds them
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({});
  const [keysEncrypted, setKeysEncrypted] = useState(true);
  const [ollamaHost, setOllamaHost] = useState('http://localhost:11434');
  const [vllmEndpoint, setVllmEndpoint] = useState('');
  const [vllmModel, setVllmModel] = useState('');
  const [vllmModels, setVllmModels] = useState<string[]>([]);
  const [vllmStatus, setVllmStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [onpRegistryUrl, setOnpRegistryUrl] = useState('');
  const [onpModelCount, setOnpModelCount] = useState(0);
  const [onpStatus, setOnpStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  // OpenNodes spend policy (ONP-5); numbers are edited as text and committed on blur
  const [policy, setPolicy] = useState({ maxRequestUsd: '0', dailyBudgetUsd: '0', maxPricePerMtok: '', minTier: 'unverified', schemes: ONP_SCHEMES });
  const [spentToday, setSpentToday] = useState(0);
  // OpenNodes per-host API keys (host names only; keys are write-only)
  const [onpKeys, setOnpKeys] = useState<{ encrypted: boolean; hosts: string[]; suggestions: Array<{ host: string; offerings: number }> }>({ encrypted: true, hosts: [], suggestions: [] });
  const [newKeyHost, setNewKeyHost] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [onpKeyError, setOnpKeyError] = useState('');
  // Private mode (embedded ollama-router): status, LAN peers, opt-in mDNS discovery
  const [privateStatus, setPrivateStatus] = useState<PrivateStatus | null>(null);
  const [newPeer, setNewPeer] = useState('');
  // Surge hub (local MCP server for other AI apps)
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [hubToken, setHubToken] = useState('');
  const [hubTokenShown, setHubTokenShown] = useState(false);
  const [hubPort, setHubPort] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const load = async () => {
      const s = window.surge.settings;
      const secrets = await s.secrets();
      setSavedKeys(secrets.saved);
      setKeysEncrypted(secrets.encrypted);
      setOnpKeys(await window.surge.onpKeys.list());
      setPrivateStatus(await window.surge.private.status());
      const hubStatus = await window.surge.hub.status();
      setHub(hubStatus);
      setHubPort(String(hubStatus.port));
      if (hubStatus.enabled) setHubToken(await window.surge.hub.token());
      setOllamaHost(await s.get('ai.ollamaHost') || 'http://localhost:11434');
      setVllmEndpoint(await s.get('ai.vllmEndpoint') || '');
      setVllmModel(await s.get('ai.vllmModel') || '');
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
    };
    load();
  }, []);

  const save = async (key: string, value: unknown) => {
    await window.surge.settings.set(key, value);
  };

  // Core re-validates the stored policy (normalizeOnpPolicy); blanks and junk fall back to safe values.
  const savePolicy = async (next: typeof policy) => {
    setPolicy(next);
    const usd = (v: string) => (Number(v) >= 0 ? Number(v) : 0);
    await save('onp.policy', {
      maxRequestUsd: usd(next.maxRequestUsd),
      dailyBudgetUsd: usd(next.dailyBudgetUsd),
      maxPricePerMtok: next.maxPricePerMtok.trim() === '' ? null : usd(next.maxPricePerMtok),
      minTier: next.minTier,
      schemes: next.schemes,
    });
    // The model list marks offerings the policy blocks; reload it so the picker reflects the change.
    onModelsChanged(await window.surge.ai.getModels());
  };

  // Test vLLM connection and discover available models
  const testVllmConnection = async () => {
    if (!vllmEndpoint) return;
    setVllmStatus('checking');
    setVllmModels([]);
    try {
      // Runs in the main process, which adds the saved API key (the page never sees it)
      const result = await window.surge.ai.listVllmModels(vllmEndpoint);
      if (result.error || !result.models) throw new Error(result.error);
      const models = result.models;
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

  const keySaved = (key: string) => (saved: boolean) => setSavedKeys(prev => ({ ...prev, [key]: saved }));

  // A per-host key changes which offerings work (and the Auto pool), so reload the models after.
  const saveOnpKey = async () => {
    setOnpKeyError('');
    const result = await window.surge.onpKeys.set(newKeyHost, newKeyValue);
    if (result.error) { setOnpKeyError(result.error); return; }
    setNewKeyHost('');
    setNewKeyValue('');
    setOnpKeys(await window.surge.onpKeys.list());
    onModelsChanged(await window.surge.ai.getModels());
  };

  const removeOnpKey = async (host: string) => {
    await window.surge.onpKeys.remove(host);
    setOnpKeys(await window.surge.onpKeys.list());
    onModelsChanged(await window.surge.ai.getModels());
  };

  // Peers and mDNS apply on the router's next start; a running router restarts.
  const configurePrivate = async (cfg: { peers?: string[]; mdns?: boolean }) => {
    setPrivateStatus(await window.surge.private.configure(cfg));
    if (privateStatus?.enabled) onModelsChanged(await window.surge.ai.getModels());
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
    { id: 'spend' as const, icon: <IconFile size={14} />, label: 'Spend' },
  ];

  const configureHub = async (cfg: { enabled?: boolean; port?: number; allowActions?: boolean }) => {
    const status = await window.surge.hub.configure(cfg);
    setHub(status);
    setHubPort(String(status.port));
    if (status.enabled && !hubToken) setHubToken(await window.surge.hub.token());
  };

  const copy = async (what: string, text: string) => {
    await window.surge.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(c => (c === what ? '' : c)), 1500);
  };

  const hubUrl = hub?.url ?? `http://127.0.0.1:${hub?.port ?? 4766}/mcp`;
  // Ready-to-paste setups; copying always uses the real token, the preview masks it until "Show".
  const hubSnippets: Array<{ id: string; label: string; text: (token: string) => string }> = [
    {
      id: 'mcpjson',
      label: 'Cursor, LM Studio, VS Code (mcp.json)',
      text: (token) => JSON.stringify({ mcpServers: { surge: { url: hubUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
    {
      id: 'claudecode',
      label: 'Claude Code',
      text: (token) => `claude mcp add --transport http surge ${hubUrl} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: 'claudedesktop',
      label: 'Claude Desktop (claude_desktop_config.json, via mcp-remote)',
      text: (token) => JSON.stringify({ mcpServers: { surge: { command: 'npx', args: ['-y', 'mcp-remote', hubUrl, '--header', 'Authorization:${SURGE_AUTH}'], env: { SURGE_AUTH: `Bearer ${token}` } } } }, null, 2),
    },
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
                    {levelModels.map(m => (
                      <button
                        key={m.id}
                        className={`model-card ${m.id === selectedModel ? 'active' : ''} ${m.needs ? 'needs-setup' : ''}`}
                        aria-disabled={m.needs ? true : undefined}
                        title={m.needs}
                        onClick={() => { if (!m.needs) onSelectModel(m.id); }}
                      >
                        <div className="model-card-icon"><IconBot size={20} /></div>
                        <div className="model-card-name">{m.name}</div>
                        <div className="model-card-desc">{m.description}</div>
                        {m.needs && <div className="model-card-needs">{m.needs}</div>}
                        <div className="model-card-cost">{m.costEstimate}</div>
                      </button>
                    ))}
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
            <p className="settings-hint" style={{ color: keysEncrypted ? 'var(--accent-green)' : 'var(--accent-orange)' }}>
              {keysEncrypted ? 'Keys are kept in your OS keychain and are never shown again after saving.' : 'No OS keychain is available: provider keys are stored in the settings file.'}
            </p>

            <div className="api-key-group">
              <label><IconKey size={13} /> Gemini API Key <a href="https://ai.google.dev" target="_blank" rel="noopener" className="key-link">(get free key)</a></label>
              <SecretField settingKey="ai.geminiApiKey" placeholder="AIza..." saved={!!savedKeys['ai.geminiApiKey']} onChange={keySaved('ai.geminiApiKey')} />
            </div>

            <div className="api-key-group">
              <label><IconKey size={13} /> Groq API Key <a href="https://console.groq.com" target="_blank" rel="noopener" className="key-link">(get free key)</a></label>
              <SecretField settingKey="ai.groqApiKey" placeholder="gsk_..." saved={!!savedKeys['ai.groqApiKey']} onChange={keySaved('ai.groqApiKey')} />
            </div>

            <div className="api-key-group">
              <label><IconKey size={13} /> Claude API Key</label>
              <SecretField settingKey="ai.claudeApiKey" placeholder="sk-ant-..." saved={!!savedKeys['ai.claudeApiKey']} onChange={keySaved('ai.claudeApiKey')} />
            </div>

            <div className="api-key-group">
              <label><IconKey size={13} /> Mistral API Key</label>
              <SecretField settingKey="ai.mistralApiKey" placeholder="" saved={!!savedKeys['ai.mistralApiKey']} onChange={keySaved('ai.mistralApiKey')} />
            </div>
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

            <div className="api-key-group">
              <label><IconKey size={13} /> API keys by host</label>
              <span className="settings-hint">
                Imported catalogs (Hugging Face router, OpenRouter, …) need your own key. Each key is sent only to the host it is saved for,
                and offerings on that host join Auto.{onpKeys.encrypted ? ' Kept in your OS keychain.' : ' No OS keychain is available, so keys cannot be saved.'}
              </span>
              {onpKeys.hosts.map(host => (
                <div key={host} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                  <code style={{ flex: 1 }}>{host}</code>
                  <span className="settings-hint">key saved</span>
                  <button className="btn-ghost btn-sm" onClick={() => removeOnpKey(host)}>Remove</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                <input className="input" list="onp-key-hosts" placeholder="host, e.g. router.huggingface.co" value={newKeyHost}
                  onChange={e => setNewKeyHost(e.target.value)} style={{ flex: 1 }} />
                <datalist id="onp-key-hosts">
                  {onpKeys.suggestions.filter(sg => !onpKeys.hosts.includes(sg.host)).map(sg => (
                    <option key={sg.host} value={sg.host}>{sg.offerings} listed offering{sg.offerings === 1 ? '' : 's'}</option>
                  ))}
                </datalist>
                <input className="input" type="password" placeholder="API key" value={newKeyValue}
                  onChange={e => setNewKeyValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveOnpKey(); }} style={{ flex: 1 }} />
                <button className="btn-primary btn-sm" onClick={saveOnpKey}
                  disabled={!onpKeys.encrypted || !newKeyHost.trim() || !newKeyValue.trim()} style={{ whiteSpace: 'nowrap' }}>
                  Save key
                </button>
              </div>
              {onpKeyError && <span className="settings-hint" style={{ color: 'var(--accent-red)' }}>{onpKeyError}</span>}
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
              <span aria-hidden="true">{'\uD83D\uDD12'}</span> Private mode
              {privateStatus?.running && <span className="badge badge-green" style={{marginLeft: 8, fontSize: '0.6rem'}}>Running</span>}
            </h3>
            <div className="api-key-group">
              <span className="settings-hint">
                The lock beside the model picker switches it on. Model calls then go only to your Ollama ({privateStatus?.ollama ?? 'the host above'}) and
                LAN peers, through an embedded OpenNodes router; the registry is not contacted. Connected MCP servers and pages you open are not affected.
              </span>
              {privateStatus?.error && <span className="settings-hint" style={{ color: 'var(--accent-red)' }}>{privateStatus.error}</span>}
              <label style={{ marginTop: '8px' }}>LAN peers (Ollama servers or OpenNodes nodes)</label>
              {(privateStatus?.peers ?? []).map(peer => (
                <div key={peer} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                  <code style={{ flex: 1 }}>{peer}</code>
                  <button className="btn-ghost btn-sm" onClick={() => configurePrivate({ peers: (privateStatus?.peers ?? []).filter(p => p !== peer) })}>Remove</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                <input className="input" placeholder="http://192.168.1.20:11434" value={newPeer}
                  onChange={e => setNewPeer(e.target.value)} style={{ flex: 1 }} />
                <button className="btn-primary btn-sm" disabled={!/^https?:\/\//.test(newPeer.trim())} style={{ whiteSpace: 'nowrap' }}
                  onClick={() => { configurePrivate({ peers: [...(privateStatus?.peers ?? []), newPeer.trim()] }); setNewPeer(''); }}>
                  Add peer
                </button>
              </div>
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', fontSize: 'var(--text-sm)' }}>
                <input type="checkbox" checked={!!privateStatus?.mdns} onChange={e => configurePrivate({ mdns: e.target.checked })} />
                Discover LAN machines automatically (mDNS; Windows may ask to allow network access)
              </label>
              {(privateStatus?.discoveredPeers.length ?? 0) > 0 && (
                <span className="settings-hint">Reachable: {privateStatus!.discoveredPeers.map(p => `${p.name} (${p.kind})`).join(', ')}</span>
              )}
            </div>

            <h3 style={{marginTop: '24px'}}>
              <IconPlug size={16} /> Surge hub
              {hub?.running && <span className="badge badge-green" style={{marginLeft: 8, fontSize: '0.6rem'}}>Running</span>}
            </h3>
            <div className="api-key-group">
              <span className="settings-hint">
                Lets other AI apps on this computer (Claude Code, Cursor, LM Studio, …) use Surge's browser and your bookmarks,
                through a local MCP server. Only this computer can reach it, and each app needs the token below.
              </span>
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', fontSize: 'var(--text-sm)' }}>
                <input type="checkbox" checked={!!hub?.enabled} onChange={e => configureHub({ enabled: e.target.checked })} />
                Run the Surge hub
              </label>
              {hub?.error && <span className="settings-hint" style={{ color: 'var(--accent-red)' }}>{hub.error}</span>}
              {hub?.enabled && (
                <>
                  <label style={{ marginTop: '8px' }}>Address</label>
                  <div className="hub-row">
                    <code className="hub-value">{hubUrl}</code>
                    <button className="btn-ghost btn-sm" onClick={() => copy('url', hubUrl)}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
                  </div>
                  <label style={{ marginTop: '8px' }}>Token</label>
                  <div className="hub-row">
                    <code className="hub-value">{hubTokenShown ? hubToken : '•'.repeat(24)}</code>
                    <button className="btn-ghost btn-sm" onClick={() => setHubTokenShown(!hubTokenShown)}>{hubTokenShown ? 'Hide' : 'Show'}</button>
                    <button className="btn-ghost btn-sm" onClick={() => copy('token', hubToken)}>{copied === 'token' ? 'Copied' : 'Copy'}</button>
                    <button className="btn-ghost btn-sm" title="Apps using the old token stop working" onClick={async () => setHubToken(await window.surge.hub.regenerateToken())}>New token</button>
                  </div>
                  {!hub.tokenPersisted && (
                    <span className="settings-hint">There's no OS keychain here, so the token changes each time Surge starts.</span>
                  )}
                  <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', fontSize: 'var(--text-sm)' }}>
                    <input type="checkbox" checked={hub.allowActions} onChange={e => configureHub({ allowActions: e.target.checked })} />
                    Let connected apps act in the browser (open pages, click, type, run scripts) and save bookmarks
                  </label>
                  <span className="settings-hint">
                    {hub.allowActions
                      ? `${hub.tools.length} tools: reading and acting in the browser you're signed in to. Turn this off when you don't need it.`
                      : `${hub.tools.length} read-only tools: the open page, your bookmarks and history.`}
                  </span>
                  <label style={{ marginTop: '8px' }}>Port</label>
                  <div className="hub-row">
                    <input className="input" value={hubPort} onChange={e => setHubPort(e.target.value)} style={{ width: '110px' }} />
                    <button className="btn-ghost btn-sm" disabled={hubPort === String(hub.port) || !/^\d{4,5}$/.test(hubPort)}
                      onClick={() => configureHub({ port: Number(hubPort) })}>Apply</button>
                  </div>
                  <label style={{ marginTop: '12px' }}>Connect an app</label>
                  {hubSnippets.map(sn => (
                    <div key={sn.id} className="hub-snippet">
                      <div className="hub-snippet-head">
                        <span>{sn.label}</span>
                        <button className="btn-ghost btn-sm" onClick={() => copy(sn.id, sn.text(hubToken))}>{copied === sn.id ? 'Copied' : 'Copy'}</button>
                      </div>
                      <pre className="hub-code">{sn.text(hubTokenShown ? hubToken : '<token>')}</pre>
                    </div>
                  ))}
                </>
              )}
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
              <SecretField settingKey="ai.vllmApiKey" placeholder="Leave empty if no auth needed" saved={!!savedKeys['ai.vllmApiKey']} onChange={keySaved('ai.vllmApiKey')} />
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

        {tab === 'spend' && (
          <div className="settings-section">
            <SpendDashboard />
          </div>
        )}

      </div>
    </div>
  );
};

export default SettingsPanel;
