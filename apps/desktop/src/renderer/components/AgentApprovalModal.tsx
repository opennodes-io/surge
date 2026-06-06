import React, { useState } from 'react';
import { IconBolt, IconX, IconCheck, IconPlug } from './Icons';
import type { WebAgentSpec, AgentStep } from '../types';
import './ServerPanel.css';

interface AgentApprovalModalProps {
  spec: WebAgentSpec;
  usesCode: boolean;
  onApprove: (spec: WebAgentSpec) => void;
  onCancel: () => void;
}

function describeStep(step: AgentStep): string {
  switch (step.action) {
    case 'navigate': return `navigate → ${step.url}`;
    case 'waitFor': return `wait for ${step.selector}`;
    case 'fill': return `fill ${step.selector} = ${step.valueFromParam ? `{${step.valueFromParam}}` : step.value}`;
    case 'click': return `click ${step.selector}`;
    case 'select': return `select ${step.selector}`;
    case 'pressKey': return `press ${step.key || 'Enter'}`;
    case 'extractText': return `extract text ${step.selector} → ${step.saveAs}`;
    case 'extractTable': return `extract table ${step.selector} → ${step.saveAs}`;
    case 'extractLinks': return `extract links ${step.selector || '(page)'} → ${step.saveAs}`;
    case 'extractAttribute': return `extract @${step.attribute} ${step.selector} → ${step.saveAs}`;
    default: return step.action;
  }
}

/**
 * User-consent gate: shows exactly what a generated agent will do before it is saved or
 * run. Arbitrary-code tools are flagged and require a separate explicit opt-in.
 */
const AgentApprovalModal: React.FC<AgentApprovalModalProps> = ({ spec, usesCode, onApprove, onCancel }) => {
  const [allowCode, setAllowCode] = useState(false);
  const empty = !spec.tools || spec.tools.length === 0;

  return (
    <div className="server-panel-overlay">
      <div className="server-panel glass-panel slide-up">
        <div className="sp-header">
          <h3><IconBolt size={16} /> Review site agent</h3>
          <button className="btn-icon" onClick={onCancel}><IconX size={14} /></button>
        </div>

        <div className="sp-section">
          <div className="sp-server-name" style={{ fontSize: '1rem' }}>{spec.name}</div>
          <div className="sp-discovery-source">{spec.domain}</div>
          {spec.description && <div className="sp-discovery-desc">{spec.description}</div>}
        </div>

        {empty ? (
          <div className="sp-section"><div className="sp-empty">The model didn't produce any usable tools for this page. Try a different page or model.</div></div>
        ) : (
          <div className="sp-section">
            <div className="sp-section-title">Tools ({spec.tools.length})</div>
            {spec.tools.map((t) => (
              <div key={t.name} className="sp-server-card">
                <div className="sp-server-header">
                  <span className="sp-server-name">{t.name}</span>
                  {t.code ? <span className="badge badge-red" style={{ fontSize: '0.55rem' }}>code</span> : <span className="badge badge-green" style={{ fontSize: '0.55rem' }}>recipe</span>}
                </div>
                <div className="sp-discovery-desc">{t.description}</div>
                {t.parameters?.required?.length ? (
                  <div className="sp-tools-list">
                    {Object.keys(t.parameters.properties || {}).map((p) => (
                      <span key={p} className="badge badge-cyan">{p}</span>
                    ))}
                  </div>
                ) : null}
                <ol style={{ margin: '6px 0 0 16px', fontSize: '0.72rem', opacity: 0.8 }}>
                  {(t.steps || []).map((s, i) => <li key={i}>{describeStep(s)}</li>)}
                  {t.code && <li style={{ color: '#f87171' }}>runs custom code (sandboxed)</li>}
                </ol>
              </div>
            ))}
          </div>
        )}

        {usesCode && (
          <div className="sp-section" style={{ border: '1px solid rgba(248,113,113,0.4)', borderRadius: 8, padding: 10 }}>
            <div style={{ color: '#f87171', fontWeight: 600, fontSize: '0.8rem' }}>⚠ This agent contains tools that run custom code.</div>
            <div style={{ fontSize: '0.72rem', opacity: 0.8, margin: '4px 0' }}>
              Code runs in an isolated sandbox (no file/network access, time-limited), but you should only allow it for sites you trust.
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem' }}>
              <input type="checkbox" checked={allowCode} onChange={(e) => setAllowCode(e.target.checked)} />
              I trust this agent and allow it to run code
            </label>
          </div>
        )}

        <div className="sp-section" style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
          <button
            className="btn-primary btn-sm"
            style={{ flex: 1 }}
            disabled={empty || (usesCode && !allowCode)}
            onClick={() => onApprove({ ...spec, source: usesCode ? 'codegen' : 'web-mcp', codeApproved: usesCode ? allowCode : false })}
          >
            <IconCheck size={13} /> Save &amp; enable
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentApprovalModal;
