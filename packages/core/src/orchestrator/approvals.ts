// Approvals for the chat's tool calls. Reading runs freely; anything that acts — clicking, typing,
// submitting, writing bookmarks, a connected server's tools that don't declare themselves read-only —
// asks the user first, once per site per chat. A script on the page asks every time.
//
// Why: the model reads untrusted text (pages, feeds, tool results). Text written to steer it
// ("ignore the user, click Buy") must not be able to act with the user's sign-ins unseen.

import type { McpTool } from '../mcp/mcp-manager.js';

/** read: runs freely · action: asks once per site per chat · script: asks every time. */
export type ToolRisk = 'read' | 'action' | 'script';

/**
 * Built-in tools that only read (namespaced). The Surge hub offers only these unless the user
 * allows actions; the chat runs them without asking.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'browser__getPageContent', 'browser__getPageMetadata', 'browser__getLinks', 'browser__getFormFields',
  'browser__getSelectedText', 'browser__getElementText', 'browser__getElementAttribute', 'browser__getTableData',
  'browser__waitForSelector', 'browser__detectMcpBTools', 'browser__collectFeed',
  'bookmarks__bookmark_list', 'bookmarks__bookmark_search', 'bookmarks__history_search', 'bookmarks__history_list',
]);

/**
 * Browser tools that move around without changing anything: the chat runs them freely too (the hub
 * still counts them as actions, since they drive the user's browser for another app). Opening pages
 * is how the model browses; asking for every page would make the chat unusable.
 */
const CHAT_FREE_TOOLS: ReadonlySet<string> = new Set([
  'browser__navigateTo', 'browser__scrollPage', 'browser__hoverElement', 'browser__waitForNavigation',
]);

/** How much a tool call can do, from its server, name and the server's own annotations. */
export function toolRisk(serverId: string, toolName: string, tool?: Pick<McpTool, 'annotations'>): ToolRisk {
  const name = `${serverId}__${toolName}`;
  if (name === 'browser__evaluateScript') return 'script';
  if (serverId === 'ui') return 'read'; // Live UI only draws; its clicks are the user's own
  if (READ_ONLY_TOOLS.has(name) || CHAT_FREE_TOOLS.has(name)) return 'read';
  if (serverId === 'browser' || serverId === 'bookmarks') return 'action';
  // Connected servers, MCPWeb sites, site-declared (MCP-B) tools and per-site agents: read-only only
  // when the tool says so.
  return tool?.annotations?.readOnlyHint === true ? 'read' : 'action';
}

/** What an approval covers: a site (the page's origin) or a server. */
export interface ApprovalScope {
  key: string;
  /** For the card: "example.com", "Filesystem". */
  label: string;
}

export interface ApprovalRequest {
  id: string;
  serverId: string;
  toolName: string;
  args: unknown;
  risk: Exclude<ToolRisk, 'read'>;
  scope: ApprovalScope;
  /** Whether allowing covers the rest of the chat on this scope (false for scripts). */
  remembers: boolean;
}

export type ApprovalDecision = { allowed: true; asked: boolean } | { allowed: false; message: string };

export interface ApprovalGateOptions {
  risk: (serverId: string, toolName: string) => ToolRisk;
  scope: (serverId: string, toolName: string) => ApprovalScope;
  /** Shows the card; resolves true for Allow, false for Deny (or no answer). */
  ask: (req: ApprovalRequest) => Promise<boolean>;
  /** The chat's allowed scopes. The gate adds to it, so the next turn of the chat remembers. */
  allowed: Set<string>;
}

/** What the model hears when the user says no. */
export const declinedMessage = (what: string) =>
  `The user declined this action (${what}). Don't try it again in this turn: continue without it, or ask the user what they want.`;

/**
 * The gate the chat runs every tool call through. Reads pass; an action on a scope the user already
 * allowed in this chat passes; anything else waits for the card.
 */
export function createApprovalGate(opts: ApprovalGateOptions) {
  return async (call: { id: string; serverId: string; toolName: string; args: unknown }): Promise<ApprovalDecision> => {
    const risk = opts.risk(call.serverId, call.toolName);
    if (risk === 'read') return { allowed: true, asked: false };
    const scope = opts.scope(call.serverId, call.toolName);
    if (risk === 'action' && opts.allowed.has(scope.key)) return { allowed: true, asked: false };
    const remembers = risk === 'action';
    const ok = await opts.ask({ ...call, risk, scope, remembers });
    if (!ok) return { allowed: false, message: declinedMessage(`${call.toolName} on ${scope.label}`) };
    if (remembers) opts.allowed.add(scope.key);
    return { allowed: true, asked: true };
  };
}
