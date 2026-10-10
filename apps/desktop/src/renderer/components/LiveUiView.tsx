import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  validateLiveUi, fillFormPrompt, computeFormValues, formatLiveUiNumber,
  type LiveUiAction, type LiveUiBlock, type LiveUiField,
} from '@surge/core/ui';
import './LiveUiView.css';

/**
 * Live UI: draws the view the model sent with ui__render, from native components. Clicks become
 * the user's next message (surge:prompt) or open a link in Surge's browser (surge:open-url).
 * Sorting and filtering a table and recomputing a form's computed fields happen right here,
 * without a model round trip. While the model is still writing the view (pending), it is drawn
 * as far as it goes and nothing is clickable yet. Returns null when the spec has nothing valid,
 * so the caller can show the plain tool call.
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

// ── table: sort by a column, filter rows ───────────────────

const FILTER_MIN_ROWS = 6;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** The number a cell starts with ("$1,200", "41k", "5–8", "12 months"), if it starts with one. */
function cellNumber(cell: string): number | undefined {
  const m = cell.trim().match(/^[^\d.+-]{0,3}([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*([kmb])?\b/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? SCALE[m[2].toLowerCase()] : 1);
  return Number.isFinite(n) ? n : undefined;
}

/** Numbers by value and before text; text in natural order ("item 2" before "item 10"); empty cells last. */
function compareCells(a: string, b: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const na = cellNumber(a), nb = cellNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  if (na !== undefined || nb !== undefined) return na !== undefined ? -1 : 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function Table({ block, pending }: { block: Extract<LiveUiBlock, { type: 'table' }>; pending: boolean }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q ? block.rows.filter((r) => r.some((c) => c.toLowerCase().includes(q))) : block.rows;
    return sort ? [...shown].sort((a, b) => sort.dir * compareCells(a[sort.col], b[sort.col])) : shown;
  }, [block.rows, query, sort]);
  // Ascending, descending, then back to the model's order.
  const cycle = (col: number) => setSort((s) => (!s || s.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  const filterable = block.rows.length >= FILTER_MIN_ROWS;

  return (
    <div className="lui-table-wrap">
      {(block.title || filterable) && (
        <div className="lui-table-head">
          {block.title && <div className="lui-block-title">{block.title}</div>}
          {filterable && (
            <input className="lui-filter" type="search" placeholder="Filter rows" aria-label="Filter rows"
              value={query} onChange={(e) => setQuery(e.target.value)} disabled={pending} />
          )}
        </div>
      )}
      <div className="lui-table-scroll">
        <table className="lui-table">
          <thead>
            <tr>
              {block.columns.map((c, i) => {
                const dir = sort?.col === i ? sort.dir : 0;
                return (
                  <th key={i} aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : undefined}>
                    <button type="button" className={`lui-sort${dir ? ' active' : ''}`} onClick={() => cycle(i)} disabled={pending}
                      title={`Sort by ${c || 'this column'}`}>
                      {c}<span className="lui-sort-mark" aria-hidden="true">{dir === 1 ? '▲' : dir === -1 ? '▼' : '↕'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {query && <div className="lui-table-count">{rows.length} of {block.rows.length} rows</div>}
    </div>
  );
}

// ── form: inputs, computed fields, submit ──────────────────

const initialValue = (f: LiveUiField): string =>
  f.value !== undefined ? String(f.value) : f.kind === 'select' ? f.options![0] : f.kind === 'slider' ? String(f.min ?? 0) : '';

function Form({ block, pending }: { block: Extract<LiveUiBlock, { type: 'form' }>; pending: boolean }) {
  // Only what the user changed; the rest follows the spec (fields still arrive while it streams).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const inputs = useMemo(
    () => Object.fromEntries(block.fields.filter((f) => f.kind !== 'computed').map((f) => [f.name, edits[f.name] ?? initialValue(f)])),
    [block.fields, edits],
  );
  const computed = useMemo(() => computeFormValues(block.fields, inputs), [block.fields, inputs]);
  const shown = (f: LiveUiField) => (computed[f.name] === undefined ? '—' : formatLiveUiNumber(computed[f.name]!, f.unit));
  const set = (name: string, v: string) => setEdits((cur) => ({ ...cur, [name]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!block.submit) return;
    const values = { ...inputs };
    for (const f of block.fields) if (f.kind === 'computed') values[f.name] = shown(f);
    act({ prompt: fillFormPrompt(block.submit.prompt, values) });
  };

  return (
    <form className="lui-form" onSubmit={submit}>
      <fieldset disabled={pending}>
        {block.title && <legend className="lui-block-title">{block.title}</legend>}
        {block.fields.map((f) => f.kind === 'computed' ? (
          <div key={f.name} className="lui-field lui-computed">
            <span>{f.label}</span>
            <output aria-live="polite">{shown(f)}</output>
          </div>
        ) : (
          <label key={f.name} className="lui-field">
            <span>
              {f.label}{f.kind === 'number' && f.unit ? ` (${f.unit})` : ''}
              {f.kind === 'slider' && <b>{inputs[f.name] === '' ? '—' : formatLiveUiNumber(Number(inputs[f.name]), f.unit)}</b>}
            </span>
            {f.kind === 'select' ? (
              <select value={inputs[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type={f.kind === 'slider' ? 'range' : f.kind === 'number' ? 'number' : 'text'}
                value={inputs[f.name]}
                min={f.min} max={f.max} step={f.step}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
          </label>
        ))}
        {block.submit && <button type="submit" className="btn-primary btn-sm lui-submit">{block.submit.label}</button>}
      </fieldset>
    </form>
  );
}

// ── blocks ─────────────────────────────────────────────────
function Block({ block, pending }: { block: LiveUiBlock; pending: boolean }) {
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
      return <Table block={block} pending={pending} />;
    case 'chart':
      return <Chart block={block} />;
    case 'list':
      return (
        <div className="lui-list">
          {block.title && <div className="lui-block-title">{block.title}</div>}
          {block.items.map((it, i) =>
            clickable(it) ? (
              <button key={i} className="lui-list-item clickable" onClick={() => act(it)} title={actionHint(it)} disabled={pending}>
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
                ? <button key={i} className="lui-compare-card clickable" onClick={() => act(c)} title={actionHint(c)} disabled={pending}>{body}</button>
                : <div key={i} className="lui-compare-card">{body}</div>;
            })}
          </div>
        </div>
      );
    case 'buttons':
      return (
        <div className="lui-buttons">
          {block.items.map((b, i) => (
            <button key={i} className="btn-ghost btn-sm" onClick={() => act(b)} title={actionHint(b)} disabled={pending}>{b.label}{b.url ? ' ↗' : ''}</button>
          ))}
        </div>
      );
    case 'form':
      return <Form block={block} pending={pending} />;
  }
}

const LiveUiView: React.FC<{ args: unknown; pending?: boolean }> = ({ args, pending = false }) => {
  const { spec } = useMemo(() => validateLiveUi(args), [args]);
  if (!spec) return null;
  return (
    <section className={`lui${pending ? ' lui-pending' : ''}`} aria-label={spec.title || 'Interactive answer'} aria-busy={pending}>
      {spec.title && <h4 className="lui-title">{spec.title}</h4>}
      {spec.blocks.map((b, i) => <Block key={`${i}-${b.type}`} block={b} pending={pending} />)}
      {pending && <div className="lui-building" role="status">Building the view…</div>}
    </section>
  );
};

export default LiveUiView;
