import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { validateLiveUi, fillFormPrompt, type LiveUiAction, type LiveUiBlock } from '@surge/core/ui';
import './LiveUiView.css';

/**
 * Live UI: draws the view the model sent with ui__render, from native components. Clicks become
 * the user's next message (surge:prompt) or open a link in Surge's browser (surge:open-url).
 * Returns null when the spec has nothing valid, so the caller can show the plain tool call.
 */

const act = (a: LiveUiAction) => {
  if (a.prompt) window.dispatchEvent(new CustomEvent('surge:prompt', { detail: a.prompt }));
  else if (a.url) window.dispatchEvent(new CustomEvent('surge:open-url', { detail: a.url }));
};
const clickable = (a: LiveUiAction) => !!(a.prompt || a.url);
const actionHint = (a: LiveUiAction) => (a.prompt ? `Ask: ${a.prompt}` : a.url ? `Open ${a.url}` : undefined);

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

// ── chart (inline SVG) ─────────────────────────────────────
const W = 520, H = 210, PAD = { l: 44, r: 12, t: 12, b: 34 };

function Chart({ block }: { block: Extract<LiveUiBlock, { type: 'chart' }> }) {
  const all = block.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + plotH - ((v - lo) / span) * plotH;
  const ticks = [lo, lo + span / 2, hi];
  const step = plotW / block.labels.length;
  const showEvery = Math.ceil(block.labels.length / 8); // keep x labels from colliding

  return (
    <figure className="lui-chart">
      {block.title && <figcaption className="lui-block-title">{block.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={block.title || `${block.kind} chart`}>
        {ticks.map((tv, i) => (
          <g key={i}>
            <line className="lui-grid" x1={PAD.l} x2={W - PAD.r} y1={y(tv)} y2={y(tv)} />
            <text className="lui-axis" x={PAD.l - 6} y={y(tv) + 4} textAnchor="end">{fmt(tv)}</text>
          </g>
        ))}
        <line className="lui-baseline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        {block.labels.map((label, i) => (i % showEvery === 0 ? (
          <text key={i} className="lui-axis" x={PAD.l + step * i + step / 2} y={H - PAD.b + 16} textAnchor="middle">{label}</text>
        ) : null))}
        {block.kind === 'bar'
          ? block.labels.map((label, i) => {
              const n = block.series.length;
              const groupW = step * 0.7;
              const barW = Math.max(2, (groupW - (n - 1) * 2) / n); // 2px gap between bars
              const x0 = PAD.l + step * i + (step - groupW) / 2;
              return block.series.map((s, k) => {
                const v = s.values[i];
                const top = Math.min(y(v), y(0)), h = Math.max(1, Math.abs(y(v) - y(0)));
                return (
                  <rect key={`${i}-${k}`} className={`lui-c${k + 1}`} x={x0 + k * (barW + 2)} y={top} width={barW} height={h} rx={Math.min(4, barW / 2)}>
                    <title>{`${label} · ${s.name}: ${fmt(v)}`}</title>
                  </rect>
                );
              });
            })
          : block.series.map((s, k) => (
              <g key={k} className={`lui-c${k + 1}`}>
                <polyline className="lui-line" points={s.values.map((v, i) => `${PAD.l + step * i + step / 2},${y(v)}`).join(' ')} />
                {s.values.map((v, i) => (
                  <circle key={i} className="lui-point" cx={PAD.l + step * i + step / 2} cy={y(v)} r={4}>
                    <title>{`${block.labels[i]} · ${s.name}: ${fmt(v)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
      </svg>
      {block.series.length > 1 && (
        <figcaption className="lui-legend">
          {block.series.map((s, k) => (
            <span key={k}><i className={`lui-swatch lui-c${k + 1}`} aria-hidden="true" />{s.name}</span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

// ── form ───────────────────────────────────────────────────
function Form({ block }: { block: Extract<LiveUiBlock, { type: 'form' }> }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(block.fields.map((f) => [f.name, f.value !== undefined ? String(f.value) : f.kind === 'select' ? f.options![0] : f.kind === 'slider' ? String(f.min ?? 0) : ''])));
  const set = (name: string, v: string) => setValues((cur) => ({ ...cur, [name]: v }));
  return (
    <form className="lui-form" onSubmit={(e) => { e.preventDefault(); act({ prompt: fillFormPrompt(block.submit.prompt, values) }); }}>
      {block.title && <div className="lui-block-title">{block.title}</div>}
      {block.fields.map((f) => (
        <label key={f.name} className="lui-field">
          <span>{f.label}{f.kind === 'slider' && <b>{values[f.name]}</b>}</span>
          {f.kind === 'select' ? (
            <select value={values[f.name]} onChange={(e) => set(f.name, e.target.value)}>
              {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              type={f.kind === 'slider' ? 'range' : f.kind === 'number' ? 'number' : 'text'}
              value={values[f.name]}
              min={f.min} max={f.max} step={f.step}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
        </label>
      ))}
      <button type="submit" className="btn-primary btn-sm lui-submit">{block.submit.label}</button>
    </form>
  );
}

// ── blocks ─────────────────────────────────────────────────
function Block({ block }: { block: LiveUiBlock }) {
  switch (block.type) {
    case 'text':
      return <div className="lui-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown></div>;
    case 'stats':
      return (
        <div className="lui-stats">
          {block.items.map((s, i) => (
            <div key={i} className="lui-stat">
              <div className="lui-stat-value">{s.value}</div>
              <div className="lui-stat-label">{s.label}</div>
              {s.hint && <div className="lui-stat-hint">{s.hint}</div>}
            </div>
          ))}
        </div>
      );
    case 'table':
      return (
        <div className="lui-table-wrap">
          {block.title && <div className="lui-block-title">{block.title}</div>}
          <div className="lui-table-scroll">
            <table className="lui-table">
              <thead><tr>{block.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      );
    case 'chart':
      return <Chart block={block} />;
    case 'list':
      return (
        <div className="lui-list">
          {block.title && <div className="lui-block-title">{block.title}</div>}
          {block.items.map((it, i) =>
            clickable(it) ? (
              <button key={i} className="lui-list-item clickable" onClick={() => act(it)} title={actionHint(it)}>
                <span className="lui-list-title">{it.title}</span>
                {it.subtitle && <span className="lui-list-sub">{it.subtitle}</span>}
                <span className="lui-chevron" aria-hidden="true">{it.url ? '↗' : '›'}</span>
              </button>
            ) : (
              <div key={i} className="lui-list-item">
                <span className="lui-list-title">{it.title}</span>
                {it.subtitle && <span className="lui-list-sub">{it.subtitle}</span>}
              </div>
            ))}
        </div>
      );
    case 'compare':
      return (
        <div className="lui-compare-wrap">
          {block.title && <div className="lui-block-title">{block.title}</div>}
          <div className="lui-compare">
            {block.items.map((c, i) => {
              const body = (
                <>
                  <div className="lui-compare-title">{c.title}</div>
                  <ul>{c.points.map((p, j) => <li key={j}>{p}</li>)}</ul>
                </>
              );
              return clickable(c)
                ? <button key={i} className="lui-compare-card clickable" onClick={() => act(c)} title={actionHint(c)}>{body}</button>
                : <div key={i} className="lui-compare-card">{body}</div>;
            })}
          </div>
        </div>
      );
    case 'buttons':
      return (
        <div className="lui-buttons">
          {block.items.map((b, i) => (
            <button key={i} className="btn-ghost btn-sm" onClick={() => act(b)} title={actionHint(b)}>{b.label}{b.url ? ' ↗' : ''}</button>
          ))}
        </div>
      );
    case 'form':
      return <Form block={block} />;
  }
}

const LiveUiView: React.FC<{ args: unknown }> = ({ args }) => {
  const { spec } = useMemo(() => validateLiveUi(args), [args]);
  if (!spec) return null;
  return (
    <section className="lui" aria-label={spec.title || 'Interactive answer'}>
      {spec.title && <h4 className="lui-title">{spec.title}</h4>}
      {spec.blocks.map((b, i) => <Block key={i} block={b} />)}
    </section>
  );
};

export default LiveUiView;
