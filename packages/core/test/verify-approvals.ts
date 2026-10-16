// Approvals for the chat's tool calls: what counts as an action, and the gate that asks once per
// site per chat (scripts every time). Run via tsx.
import { toolRisk, createApprovalGate, runToolLoop, READ_ONLY_TOOLS, type ApprovalRequest } from '@surge/core/orchestrator';

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, extra?: string) => checks.push([name, ok, extra]);

// 1) Risk: reads run, actions ask, scripts always ask.
const risks = (serverId: string, names: string[]) => names.map((n) => toolRisk(serverId, n)).join();
check('page reads and moving around run freely',
  risks('browser', ['getPageContent', 'getLinks', 'getFormFields', 'collectFeed', 'navigateTo', 'scrollPage', 'hoverElement', 'waitForNavigation']) === Array(8).fill('read').join());
check('clicking, typing, choosing, ticking, keys and site tools are actions',
  risks('browser', ['clickElement', 'fillInput', 'selectOption', 'checkElement', 'pressKey', 'callMcpBTool']) === Array(6).fill('action').join());
check('a script on the page is its own risk', toolRisk('browser', 'evaluateScript') === 'script');
check('Live UI only draws', toolRisk('ui', 'render') === 'read');
check('bookmarks: reads run, writes ask', risks('bookmarks', ['bookmark_list', 'bookmark_search', 'history_search', 'history_list']) === 'read,read,read,read'
  && risks('bookmarks', ['bookmark_add', 'history_record']) === 'action,action');
check("a connected server's tool is read-only only when it says so",
  toolRisk('fs', 'read_file', { annotations: { readOnlyHint: true } }) === 'read'
    && toolRisk('fs', 'write_file', { annotations: { destructiveHint: true } }) === 'action'
    && toolRisk('fs', 'move_file', { annotations: { readOnlyHint: false } }) === 'action'
    && toolRisk('fs', 'mystery') === 'action');
const ACTIONS = ['browser__clickElement', 'browser__fillInput', 'browser__evaluateScript', 'browser__pressKey', 'browser__selectOption',
  'browser__checkElement', 'browser__callMcpBTool', 'browser__navigateTo', 'bookmarks__bookmark_add', 'bookmarks__history_record'];
check('the shared read-only list (the hub uses it) holds no action', !ACTIONS.some((n) => READ_ONLY_TOOLS.has(n)));

// 2) The gate: once per site per chat; scripts every time; a denial is not remembered.
let page = 'https://shop.example';
const asked: ApprovalRequest[] = [];
let answer = true;
const allowed = new Set<string>();
const makeGate = () => createApprovalGate({
  allowed,
  risk: (s, t) => toolRisk(s, t),
  scope: (s) => (s === 'browser' ? { key: `site:${page}`, label: new URL(page).host } : { key: `server:${s}`, label: s }),
  ask: async (req) => { asked.push(req); return answer; },
});
const gate = makeGate();
const run = (serverId: string, toolName: string, args: unknown = {}) => gate({ id: `c${asked.length}-${toolName}`, serverId, toolName, args });

let d = await run('browser', 'getPageContent');
check('a read passes without asking', d.allowed && !asked.length);
d = await run('browser', 'clickElement', { selector: '#buy' });
check('the first action on a site asks, with the site and what it remembers',
  d.allowed && asked.length === 1 && asked[0].scope.label === 'shop.example' && asked[0].risk === 'action' && asked[0].remembers === true
    && (asked[0].args as any).selector === '#buy');
d = await run('browser', 'fillInput', { selector: '#q', value: 'x' });
check('…then other actions on that site run without asking', d.allowed && asked.length === 1);
page = 'https://bank.example';
d = await run('browser', 'clickElement');
check('a different site asks again', d.allowed && asked.length === 2 && asked[1].scope.label === 'bank.example');
page = 'https://mail.example';
answer = false;
d = await run('browser', 'fillInput', { selector: '#to', value: 'someone' });
check('Deny: not allowed, and the model is told it was declined',
  !d.allowed && /declined/.test(d.message) && /mail\.example/.test(d.message) && !allowed.has('site:https://mail.example'));
answer = true;
d = await run('browser', 'clickElement');
check('…and not remembered: the next action there asks again', d.allowed && asked.length === 4);
page = 'https://shop.example';
d = await run('browser', 'evaluateScript', { script: 'document.cookie' });
check('a script asks even on an allowed site, and remembers nothing', d.allowed && asked.length === 5 && asked[4].risk === 'script' && asked[4].remembers === false);
const sizeBefore = allowed.size;
d = await run('browser', 'evaluateScript', { script: '1' });
check('…every time', d.allowed && asked.length === 6 && allowed.size === sizeBefore);
answer = false;
d = await run('browser', 'evaluateScript', { script: '2' });
check('…and a denied script is declined', !d.allowed && asked.length === 7);
answer = true;
d = await run('fs', 'write_file');
check('a server is its own scope', d.allowed && asked.length === 8 && asked[7].scope.key === 'server:fs');
d = await run('fs', 'write_file');
check('…asked once', d.allowed && asked.length === 8);
const nextTurn = makeGate();
d = await nextTurn({ id: 'n1', serverId: 'browser', toolName: 'clickElement', args: {} });
check("the chat's next turn remembers its sites", d.allowed && asked.length === 8);
const otherChat = createApprovalGate({ allowed: new Set(), risk: (s, t) => toolRisk(s, t), scope: () => ({ key: 'site:https://shop.example', label: 'shop.example' }), ask: async (req) => { asked.push(req); return true; } });
await otherChat({ id: 'o1', serverId: 'browser', toolName: 'clickElement', args: {} });
check('a new chat asks again', asked.length === 9);

// 3) In the tool loop, as the desktop wires it: a denied action reaches the model as a failed call.
const seen: string[] = [];
const conversation: any[] = [{ role: 'user', content: 'buy it' }];
const denyAll = createApprovalGate({ allowed: new Set(), risk: (s, t) => toolRisk(s, t), scope: () => ({ key: 'site:x', label: 'x.example' }), ask: async () => false });
let round = 0;
await runToolLoop({
  ai: {
    streamChat: async (_c: any, _m: any, cb: any) => {
      if (round++ === 0) return cb.onToolCall([{ id: 't1', functionName: 'browser__clickElement', arguments: { selector: '#buy' } }]);
      cb.onToken('ok'); cb.onEnd();
    },
  } as any,
  model: 'x', conversation, toolDefs: [],
  executeTool: async (tc) => {
    const [serverId, toolName] = tc.functionName.split('__');
    const decision = await denyAll({ id: tc.id, serverId, toolName, args: tc.arguments });
    if (!decision.allowed) throw new Error(decision.message);
    seen.push('ran');
    return { resultText: 'clicked' };
  },
  callbacks: { onToken: () => {}, onToolCallStart: () => {}, onToolCallResult: (i) => seen.push(`result:${i.status}`), onEnd: () => {}, onError: () => {} },
});
const toolTurn = conversation.find((m) => m.role === 'tool');
check('a denied action never runs; the model hears it was declined', !seen.includes('ran') && seen.includes('result:error') && /declined/.test(toolTurn?.content ?? ''),
  `${seen.join()} | ${toolTurn?.content}`);

for (const [name, ok, extra] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n❌ APPROVALS VERIFY FAILED (${failed})` : `\n✅ APPROVALS VERIFY PASSED (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
