// Live UI: spec validation, the tool result the model sees, and form prompt filling (run via tsx).
import { validateLiveUi, liveUiToolResult, fillFormPrompt, LIVE_UI_TOOL } from '@surge/core/ui';

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// 1) Every block type, valid.
const full = {
  title: 'Python vs JavaScript',
  blocks: [
    { type: 'text', text: 'Both are great **first languages**.' },
    { type: 'stats', items: [{ label: 'Users', value: 12, hint: 'millions' }, { label: 'Jobs', value: '8.1k' }] },
    { type: 'table', title: 'At a glance', columns: ['Topic', 'Python', 'JS'], rows: [['Typing', 'dynamic', 'dynamic'], ['Runs in', 'anywhere']] },
    { type: 'chart', kind: 'bar', labels: ['2023', '2024', '2025'], series: [{ name: 'Python', values: [1, 2, 3] }, { name: 'JS', values: ['2', 2.5, 3] }] },
    { type: 'list', items: [{ title: 'Docs', url: 'https://docs.python.org/' }, { title: 'Try it', prompt: 'Give me a 10-minute exercise' }] },
    { type: 'compare', items: [{ title: 'Python', points: ['Readable', 'Huge stdlib'] }, { title: 'JS', points: ['Runs in browsers'] }] },
    { type: 'buttons', items: [{ label: 'More', prompt: 'Tell me more' }, { label: 'Nothing', }] },
    { type: 'form', fields: [{ name: 'hours', label: 'Hours a week', kind: 'slider', min: 1, max: 20, value: '5' }, { name: 'goal', label: 'Goal', kind: 'select', options: ['Web', 'Data'] }], submit: { label: 'Plan it', prompt: 'Plan {hours} hours a week for {goal}' } },
  ],
};
const v = validateLiveUi(full);
check('all 8 block types accepted', v.spec?.blocks.length === 8 && v.errors.length === 0);
const table = v.spec!.blocks[2] as any;
check('table rows padded to the columns', table.rows[1].length === 3 && table.rows[1][2] === '');
const labelled = validateLiveUi({ blocks: [{ type: 'table', columns: ['', 'Python', 'JS'], rows: [['Typing', 'dynamic', 'dynamic']] }] }).spec!.blocks[0] as any;
check('an empty header column keeps rows aligned', labelled.columns.length === 3 && labelled.rows[0][1] === 'dynamic');
const chart = v.spec!.blocks[3] as any;
check('chart values coerced to numbers', chart.series[1].values[0] === 2);
const buttons = v.spec!.blocks[6] as any;
check('a button without prompt or url is dropped', buttons.items.length === 1);
const stats = v.spec!.blocks[1] as any;
check('numbers become strings in stats', stats.items[0].value === '12');

// 2) Lenient: a bad block is skipped and reported, the rest renders.
const partial = validateLiveUi({ blocks: [{ type: 'text', text: 'ok' }, { type: 'chart', labels: ['a', 'b', 'c'], series: [{ name: 'x', values: [1, 2] }] }, { type: 'pie' }] });
check('bad blocks skipped, good kept', partial.spec?.blocks.length === 1);
check('chart length mismatch explained', partial.errors.some((e) => /series\[0\]\.values: expected 3 numbers/.test(e)));
check('unknown type explained', partial.errors.some((e) => /blocks\[2\]: add "type", one of/.test(e)));

// 2b) Missing or misplaced "type" is inferred from the block's fields.
const inferred = validateLiveUi({ blocks: [
  { items: [{ title: 'Python', points: ['Readable'] }, { title: 'JS', points: ['Browsers'] }] },
  { kind: 'stats', items: [{ label: 'Users', value: 1 }] },
  { columns: ['a', 'b'], rows: [['1', '2']] },
  { labels: ['x', 'y'], series: [{ name: 's', values: [1, 2] }] },
  { items: [{ label: 'Go', prompt: 'go' }] },
  { items: [{ title: 'Docs', url: 'https://example.com/' }] },
  { text: 'hello' },
] });
check('types inferred from fields', inferred.spec?.blocks.map((b) => b.type).join() === 'compare,stats,table,chart,buttons,list,text' && inferred.errors.length === 0);

// 3) Safety and limits.
const unsafe = validateLiveUi({ blocks: [{ type: 'list', items: [{ title: 'x', url: 'javascript:alert(1)' }, { title: 'y', url: 'file:///etc/passwd' }] }] });
check('only http(s) links survive', (unsafe.spec?.blocks[0] as any).items.every((i: any) => !i.url));
const big = validateLiveUi({ blocks: Array.from({ length: 40 }, () => ({ type: 'text', text: 'x'.repeat(5000) })) });
check('at most 30 blocks, text capped', big.spec?.blocks.length === 30 && (big.spec!.blocks[0] as any).text.length === 4000);
check('spec as a JSON string accepted', validateLiveUi(JSON.stringify({ blocks: [{ type: 'text', text: 'hi' }] })).spec?.blocks.length === 1);
check('nothing valid is an error', !validateLiveUi({ blocks: [{ type: 'stats', items: [] }] }).spec);

// 4) What the model sees.
const ok = liveUiToolResult(full);
check('tool result confirms and asks for brevity', !ok.isError && /Shown to the user/.test(ok.content[0].text));
const bad = liveUiToolResult({ blocks: [] });
check('tool result allows one retry, then plain text', !!bad.isError && /once more, or answer in plain text/.test(bad.content[0].text));
check('tool is named render with a flat schema', LIVE_UI_TOOL.name === 'render' && LIVE_UI_TOOL.inputSchema.properties.blocks.items.properties.type.enum.length === 8);

// 5) Forms.
check('form placeholders filled', fillFormPrompt('Plan {hours} hours for {goal}', { hours: '6', goal: 'Web' }) === 'Plan 6 hours for Web');
check('unused fields appended', fillFormPrompt('Plan it', { hours: '6' }) === 'Plan it\nhours: 6');

for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n❌ LIVE UI VERIFY FAILED (${failed})` : `\n✅ LIVE UI VERIFY PASSED (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
