import React, { useEffect, useState } from 'react';
import { DiscoveryClient, type IndexServer } from '@surge/core/discovery';
import { capabilities } from './capabilities';

// Scaffold mobile shell. It reuses platform-neutral @surge/core (here: the discovery
// client) to prove the shared-core architecture. The full chat/MCP UI will be shared
// via @surge/ui once extracted; embedded-browser features stay desktop-only.
const REGISTRY_URL = 'http://localhost:3000';

const App: React.FC = () => {
  const [servers, setServers] = useState<IndexServer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = new DiscoveryClient(REGISTRY_URL);
    client
      .listServers({ sortBy: 'quality', limit: 10 })
      .then((r) => setServers(r.servers))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0e1a', color: '#f1f5f9', minHeight: '100vh', padding: 16 }}>
      <h1 style={{ background: 'linear-gradient(135deg,#06b6d4,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        SURGE
      </h1>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Mobile shell (scaffold). Shared <code>@surge/core</code> is reused; embedded browser &amp; Web→MCP are{' '}
        {capabilities.browserPort ? 'enabled' : 'disabled on mobile'}.
      </p>

      <h2 style={{ fontSize: 15, marginTop: 20 }}>Top-rated MCP servers</h2>
      {error && <p style={{ color: '#f87171', fontSize: 12 }}>Registry unreachable ({error}). Start MCP_Index or enable CORS.</p>}
      {servers.length === 0 && !error && <p style={{ opacity: 0.5, fontSize: 12 }}>Loading…</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {servers.map((s) => (
          <li key={s.slug} style={{ border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <strong>{s.name}</strong>{' '}
            {s.qualityScore != null && <span style={{ fontSize: 11, opacity: 0.7 }}>· {Math.round(s.qualityScore)}</span>}
            {s.uiType && <span style={{ fontSize: 11, color: '#8b5cf6' }}> · {s.uiType}</span>}
            <div style={{ fontSize: 12, opacity: 0.65 }}>{s.description}</div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default App;
