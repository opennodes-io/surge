import React, { useEffect, useState } from 'react';
import { IconRefresh } from './Icons';
import type { OnpSpend, OnpCall } from '../types';
import './SpendDashboard.css';

const DAYS = 14;

// Micro-costs need their digits; whole amounts don't.
const usd = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(2)}`);

const RECEIPT: Record<OnpCall['receipt'], { icon: string; label: string }> = {
  verified: { icon: '✓', label: 'verified' },
  missing: { icon: '!', label: 'no receipt' },
  unverified: { icon: '!', label: 'not checked' },
  invalid: { icon: '✗', label: 'invalid' },
};

const ReceiptStatus: React.FC<{ status: OnpCall['receipt']; reason?: string | null }> = ({ status, reason }) => (
  <span className={`sd-receipt ${status}`} title={reason ?? undefined}>
    <span aria-hidden="true">{RECEIPT[status].icon}</span> {RECEIPT[status].label}
  </span>
);

/** The last DAYS UTC days, oldest first, with zero-call days filled in. */
function dayRange(byDay: OnpSpend['summary']['byDay']) {
  const found = new Map(byDay.map((d) => [d.day, d]));
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (DAYS - 1) * 86_400_000;
  return Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return found.get(day) ?? { day, usd: 0, calls: 0 };
  });
}

// One series (calls per day) → one hue, no legend; the title names it. Spend rides in the tooltip
// because most OpenNodes calls are free, and a $0 column chart says nothing.
const CallsByDay: React.FC<{ byDay: OnpSpend['summary']['byDay'] }> = ({ byDay }) => {
  const days = dayRange(byDay);
  const max = Math.max(1, ...days.map((d) => d.calls));
  const peak = days.reduce((best, d) => (d.calls > best.calls ? d : best), days[0]);
  const [hover, setHover] = useState<number | null>(null);
  const label = (d: (typeof days)[number]) => `${d.day} · ${d.calls} call${d.calls === 1 ? '' : 's'} · ${usd(d.usd)} counted`;
  return (
    <figure className="sd-chart">
      <figcaption className="sd-chart-title">Calls per day (UTC), last {DAYS} days</figcaption>
      <div className="sd-plot" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <div key={d.day} className="sd-slot" tabIndex={0} aria-label={label(d)}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            {d === peak && d.calls > 0 && <span className="sd-cap">{d.calls}</span>}
            <div className="sd-col" style={{ height: `${(d.calls / max) * 100}%` }} />
            {hover === i && <div className="sd-tip" role="tooltip">{label(d)}</div>}
          </div>
        ))}
      </div>
      <div className="sd-axis">
        <span>{days[0].day.slice(5)}</span>
        <span>today</span>
      </div>
    </figure>
  );
};

const SpendDashboard: React.FC = () => {
  const [data, setData] = useState<OnpSpend | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setData(await window.surge.onp.spend());
      setError('');
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  useEffect(() => { load(); }, []);

  if (error) return <p className="settings-hint" style={{ color: 'var(--accent-red)' }}>Could not read the spend ledger: {error}</p>;
  if (!data) return <div className="spinner spinner-sm" />;

  const { policy, todayUsd, summary, recent } = data;
  const verified = summary.byNode.reduce((n, r) => n + r.verified, 0);
  const invalid = summary.byNode.reduce((n, r) => n + r.invalid, 0);
  const unreceipted = summary.byNode.reduce((n, r) => n + r.unreceipted, 0);
  const share = policy.dailyBudgetUsd > 0 ? todayUsd / policy.dailyBudgetUsd : 0;
  const meterState = share >= 1 ? 'danger' : share >= 0.8 ? 'warning' : 'ok';

  return (
    <div className="spend-dashboard">
      <div className="sd-head">
        <h3>OpenNodes spend</h3>
        <button className="btn-ghost btn-sm" onClick={load} title="Reload"><IconRefresh size={13} /> Refresh</button>
      </div>

      <div className="sd-kpis">
        <div className="sd-tile">
          <div className="sd-tile-label">Spent today (UTC)</div>
          <div className="sd-tile-value">{usd(todayUsd)}</div>
          {policy.dailyBudgetUsd > 0 ? (
            <>
              <div className={`sd-meter ${meterState}`} role="meter" aria-valuemin={0} aria-valuemax={policy.dailyBudgetUsd} aria-valuenow={todayUsd}>
                <div style={{ width: `${Math.min(100, share * 100)}%` }} />
              </div>
              <div className="sd-tile-note">of {usd(policy.dailyBudgetUsd)} daily budget</div>
            </>
          ) : (
            <div className="sd-tile-note">Spending off: only free offerings run</div>
          )}
        </div>
        <div className="sd-tile">
          <div className="sd-tile-label">Last {DAYS} days</div>
          <div className="sd-tile-value">{usd(summary.totalUsd)}</div>
          <div className="sd-tile-note">{summary.calls} call{summary.calls === 1 ? '' : 's'}</div>
        </div>
        <div className="sd-tile">
          <div className="sd-tile-label">Receipts verified</div>
          <div className="sd-tile-value">{summary.calls ? `${verified} of ${summary.calls}` : '—'}</div>
          <div className="sd-tile-note">
            {invalid > 0 && <ReceiptStatus status="invalid" />} {invalid > 0 && `${invalid} `}
            {unreceipted > 0 && <ReceiptStatus status="missing" />} {unreceipted > 0 && `${unreceipted}`}
            {invalid === 0 && unreceipted === 0 && (summary.calls ? 'all signed and priced as pinned' : 'no calls yet')}
          </div>
        </div>
      </div>

      {summary.calls === 0 ? (
        <p className="settings-hint">No OpenNodes calls in the last {DAYS} days. Pick an OpenNodes model (or Auto) and chat; every call lands here with its receipt.</p>
      ) : (
        <>
          <CallsByDay byDay={summary.byDay} />

          <h4 className="sd-subhead">By node</h4>
          <table className="sd-table">
            <thead><tr><th>Node</th><th className="num">Calls</th><th className="num">Counted</th><th>Receipts</th></tr></thead>
            <tbody>
              {summary.byNode.map((n) => (
                <tr key={n.nodeId}>
                  <td><code>{n.nodeId}</code></td>
                  <td className="num">{n.calls}</td>
                  <td className="num">{usd(n.usd)}</td>
                  <td>
                    <ReceiptStatus status="verified" /> {n.verified}
                    {n.invalid > 0 && <> · <ReceiptStatus status="invalid" /> {n.invalid}</>}
                    {n.unreceipted > 0 && <> · <ReceiptStatus status="missing" /> {n.unreceipted}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="sd-subhead">Recent calls</h4>
          <table className="sd-table">
            <thead><tr><th>When</th><th>Model</th><th>Node</th><th>Price</th><th>Receipt</th><th className="num">Tokens</th><th className="num">Counted</th></tr></thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{c.advisor ? 'auto → ' : ''}{c.modelName ?? c.offering}</td>
                  <td><code>{c.nodeId}</code></td>
                  <td>{c.price}</td>
                  <td><ReceiptStatus status={c.receipt} reason={c.reason} /></td>
                  <td className="num">{c.promptTokens != null ? `${c.promptTokens}+${c.completionTokens ?? 0}` : '—'}</td>
                  <td className="num">{usd(c.countedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="settings-hint">Counted is the verified receipt amount, or the request's ceiling when no receipt verified, which is what the daily budget uses.</p>
        </>
      )}
    </div>
  );
};

export default SpendDashboard;
