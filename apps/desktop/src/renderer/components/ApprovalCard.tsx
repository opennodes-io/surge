import React, { useState } from 'react';
import { IconShield } from './Icons';
import type { ToolCallData } from './McpToolCallBlock';
import './ApprovalCard.css';

/**
 * Asks before the model acts: click, type, submit, run a script, use a site's or server's tool.
 * Allow covers the rest of this chat on the same site (or server); a script asks every time.
 * Deny tells the model the user declined. The answer goes to main (ai:approve), which then runs the
 * call or reports it declined, and this card turns back into the usual tool-call block.
 *
 * The Surge hub uses the same card for other apps' actions (from="hub", drawn over the window and
 * answered through hub:approve). There an Allow lasts until the hub restarts or actions are turned off.
 */

const clip = (s: unknown, n = 200) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What the call would do, in words, with the details the user needs to decide. */
function describe(data: ToolCallData): { title: string; details: Array<[string, string]>; code?: string } {
  const a = (data.args ?? {}) as Record<string, any>;
  switch (data.toolName) {
    case 'clickElement': return { title: 'Click', details: [['Element', clip(a.selector)]] };
    case 'fillInput': return {
      title: a.submit ? 'Type and submit' : 'Type into a field',
      details: [['Field', clip(a.selector)], ['Text', `“${clip(a.value)}”`]],
    };
    case 'selectOption': return { title: 'Choose an option', details: [['Field', clip(a.selector)], ['Option', clip(a.value)]] };
    case 'checkElement': return { title: a.checked === false ? 'Untick a box' : 'Tick a box', details: [['Element', clip(a.selector)]] };
    case 'pressKey': return {
      title: `Press ${[...(Array.isArray(a.modifiers) ? a.modifiers : []), a.key].filter(Boolean).join('+') || 'a key'}`,
      details: a.selector ? [['In', clip(a.selector)]] : [],
    };
    // Moving around asks only when another app drives the browser through the Surge hub.
    case 'navigateTo': return { title: 'Open a page', details: [['Address', clip(a.url)]] };
    case 'scrollPage': return { title: 'Scroll the page', details: a.selector ? [['To', clip(a.selector)]] : [] };
    case 'hoverElement': return { title: 'Point at an element', details: [['Element', clip(a.selector)]] };
    case 'waitForNavigation': return { title: 'Wait for the page to load', details: [] };
    case 'callMcpBTool': return { title: `Use the site's tool “${clip(a.toolName, 60)}”`, details: [['With', clip(a.args ?? {})]] };
    case 'evaluateScript': return { title: 'Run a script', details: [], code: clip(a.script, 1200) };
    case 'bookmark_add': return { title: 'Save a bookmark', details: [['Page', clip(a.title || a.url)], ...(a.url ? [['Address', clip(a.url)] as [string, string]] : [])] };
    case 'history_record': return { title: 'Add a page to your history', details: [['Address', clip(a.url)]] };
    default: return {
      title: `Use ${data.serverName || data.serverId}'s tool “${clip(data.toolName, 60)}”`,
      details: Object.keys(a).length ? [['With', clip(a, 300)]] : [],
    };
  }
}

interface ApprovalCardProps {
  data: ToolCallData;
  /** "hub": another app asks through the Surge hub (it answers through onAnswer). */
  from?: 'chat' | 'hub';
  onAnswer?: (allow: boolean) => Promise<unknown>;
}

const ApprovalCard: React.FC<ApprovalCardProps> = ({ data, from = 'chat', onAnswer }) => {
  const [answered, setAnswered] = useState(false);
  const approval = data.approval ?? { risk: 'action' as const, scope: 'this site', remembers: true };
  const { title, details, code } = describe(data);
  const answer = (allow: boolean) => {
    setAnswered(true);
    (onAnswer ?? ((ok: boolean) => window.surge.ai.approve(data.id, ok)))(allow).catch(() => setAnswered(false));
  };
  const headingId = `approval-${data.id}`;

  return (
    <div className={`approval ${approval.risk}`} role="group" aria-labelledby={headingId}>
      <div className="approval-head">
        <IconShield size={15} className="approval-icon" />
        <span id={headingId} className="approval-title">
          {from === 'hub' ? 'An app using the Surge hub asks: ' : 'Allow this action? '}<b>{title}</b> on <b>{approval.scope}</b>
        </span>
      </div>
      {details.length > 0 && (
        <dl className="approval-details">
          {details.map(([k, v]) => (
            <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
          ))}
        </dl>
      )}
      {code && <pre className="approval-code">{code}</pre>}
      <div className="approval-actions">
        <button className="btn-primary btn-sm" disabled={answered} onClick={() => answer(true)}>
          {approval.remembers ? `Allow on ${approval.scope}` : 'Run once'}
        </button>
        <button className="btn-ghost btn-sm" disabled={answered} onClick={() => answer(false)}>Deny</button>
      </div>
      <p className="approval-hint">
        {approval.remembers
          ? from === 'hub'
            ? `Surge won't ask again for ${approval.scope} until the hub restarts or you turn actions off. Every call is logged in Settings → Advanced → Surge hub.`
            : `Surge won't ask again for ${approval.scope} in this chat. A new chat asks again.`
          : 'A script can do anything on the page, so Surge asks every time.'}
      </p>
    </div>
  );
};

export default ApprovalCard;
