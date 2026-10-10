// Live UI: spec validation, the tool result the model sees, form prompts, streaming previews,
// formulas and when the tool is offered (run via tsx).
import {
  validateLiveUi, liveUiToolResult, fillFormPrompt, LIVE_UI_TOOL, parsePartialJson, compileFormula,
  computeFormValues, formatLiveUiNumber, shouldOfferLiveUi, type LiveUiField,
} from '@surge/core/ui';
import { runToolLoop } from '@surge/core/orchestrator';

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

// 6) Streaming: incomplete arguments parse as far as they go.
check('partial JSON: a complete document parses as is', JSON.stringify(parsePartialJson('{"a":[1,2]}')) === '{"a":[1,2]}');
check('partial JSON: a string being written grows', (parsePartialJson('{"blocks":[{"type":"text","text":"Hel') as any)?.blocks[0].text === 'Hel');
check('partial JSON: a half-written key is cut', JSON.stringify(parsePartialJson('{"blocks":[{"type":"text","te')) === '{"blocks":[{"type":"text"}]}');
check('partial JSON: trailing comma and half literal cut', JSON.stringify(parsePartialJson('[1,2,')) === '[1,2]' && JSON.stringify(parsePartialJson('{"a":1,"b":tru')) === '{"a":1}');
check('partial JSON: escapes', (parsePartialJson('{"a":"x\\') as any)?.a === 'x' && (parsePartialJson('{"a":"x\\u00') as any)?.a === 'x'
  && (parsePartialJson('{"a":"say \\"hi') as any)?.a === 'say "hi');
check('partial JSON: nothing yet', parsePartialJson('') === undefined && parsePartialJson('   ') === undefined);
// Stream the full spec a few characters at a time: it never throws, blocks only ever appear, and the
// end is the whole view.
const fullText = JSON.stringify(full);
let lastCount = 0, monotonic = true, sawPartialView = false;
for (let end = 1; end <= fullText.length; end += 5) {
  const count = validateLiveUi(parsePartialJson(fullText.slice(0, end))).spec?.blocks.length ?? 0;
  if (count < lastCount) monotonic = false;
  if (count > 0 && count < 8) sawPartialView = true;
  lastCount = count;
}
check('streamed spec: blocks only appear, never vanish', monotonic && sawPartialView);
check('streamed spec: ends as the whole view', validateLiveUi(parsePartialJson(fullText)).spec?.blocks.length === 8);
const twoSeries = validateLiveUi({ blocks: [{ type: 'chart', labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3] }] }] });
check('a chart keeps its good series and reports the short one', (twoSeries.spec?.blocks[0] as any)?.series.length === 1 && /series\[1\]/.test(twoSeries.errors.join()));

// 7) Formulas: arithmetic only, checked names.
const calc = (src: string, vars: Record<string, number> = {}) => {
  const c = compileFormula(src, Object.keys(vars));
  return 'error' in c ? c.error : c.run(vars);
};
check('formula precedence', calc('2+3*4') === 14 && calc('(2+3)*4') === 20 && calc('-2^2') === -4 && calc('2^-1') === 0.5 && calc('2^3^2') === 512);
check('formula functions', calc('round(2.345, 2)') === 2.35 && calc('round(-2.5)') === -3 && calc('max(1, 7, 3)') === 7 && calc('min(4, 2)') === 2
  && calc('sqrt(16) + abs(-1) + floor(1.9) + ceil(1.1)') === 8);
check('formula comparisons and if', calc('if(qty > 10, 0.9, 1)', { qty: 12 }) === 0.9 && calc('if(qty > 10, 0.9, 1)', { qty: 3 }) === 1 && calc('qty == 3', { qty: 3 }) === 1);
check('formula names come from the form', calc('price * qty', { price: 2.5, qty: 4 }) === 10 && /unknown name "rate"/.test(String(calc('price * rate', { price: 1 }))));
check('formula errors are explained', /unknown function "eval"/.test(String(calc('eval(1)'))) && /round takes 1–2 arguments/.test(String(calc('round()')))
  && /unexpected "\)"/.test(String(calc('1 + )'))) && /empty/.test(String(calc('  '))) && /expected "\)"/.test(String(calc('(1 + 2'))));
check('formula limits: length and nesting', /longer than/.test(String(calc('1+'.repeat(200) + '1'))) && /too deeply nested/.test(String(calc('('.repeat(60) + '1' + ')'.repeat(60)))));
check('formula: no answer is undefined, not Infinity', calc('1 / 0') === undefined && calc('x + 1', { x: NaN }) === undefined);
check('formula: no reaching into objects', /unexpected "\."/.test(String(calc('constructor.name', { constructor: 1 }))) && calc('toString', { toString: 2 }) === 2);

// 8) Computed fields and calculators.
const calculator = validateLiveUi({ blocks: [{ type: 'form', title: 'Split the bill', fields: [
  { name: 'bill', label: 'Bill', kind: 'number', value: 120, unit: '$' },
  { name: 'tip', label: 'Tip', kind: 'slider', min: 0, max: 30, value: 15, unit: '%' },
  { name: 'people', label: 'People', kind: 'number', value: 4 },
  { name: 'total', label: 'Total', formula: 'round(bill * (1 + tip / 100), 2)', unit: '$' },
  { name: 'each', label: 'Each pays', kind: 'computed', formula: 'round(total / people, 2)', unit: '$' },
  { name: 'later', label: 'Bad', kind: 'computed', formula: 'nope * 2' },
] }] });
const calcForm = calculator.spec?.blocks[0] as any;
check('a calculator needs no submit', !!calcForm && !calcForm.submit && calcForm.fields.length === 5);
check('a formula without kind is computed', calcForm?.fields[3].kind === 'computed');
check('a bad formula is skipped and explained', /fields\[5\]\.formula: unknown name "nope"/.test(calculator.errors.join()));
const inputs = { bill: '120', tip: '15', people: '4' };
const values = computeFormValues(calcForm.fields as LiveUiField[], inputs);
check('computed fields chain in order', values.total === 138 && values.each === 34.5);
check('a missing input shows no result', computeFormValues(calcForm.fields as LiveUiField[], { ...inputs, people: '' }).each === undefined);
check('a form without submit or computed fields is explained', /unless the form has computed fields/.test(validateLiveUi({ blocks: [{ type: 'form', fields: [{ name: 'a', label: 'A' }] }] }).errors.join()));
check('numbers formatted with units', formatLiveUiNumber(1234.567, '$') === '$1,234.57' && formatLiveUiNumber(-5, '$') === '-$5' && formatLiveUiNumber(34.5, '€') === '€34.50'
  && formatLiveUiNumber(12.5, 'h') === '12.5 h' && formatLiveUiNumber(8, '%') === '8%' && formatLiveUiNumber(0.333333) === '0.33');
check('schema offers the computed kind', (LIVE_UI_TOOL.inputSchema.properties.blocks.items.properties.fields.items.properties.kind as any).enum.includes('computed'));

// 9) When the tool is offered ("When it helps").
check('offered for comparisons, plans, numbers', ['Compare Python and JavaScript', 'Python vs Go', 'Make me a 4-week plan', 'How much is a flight to Lisbon?', 'Show a chart of EV sales', 'Calculate my mortgage']
  .every((q) => shouldOfferLiveUi(q, false)));
check('not offered for plain questions', ['hi there', 'Write a haiku about autumn', 'What is the capital of France?', 'Fix this typo: teh'].every((q) => !shouldOfferLiveUi(q, false)));
check('a follow-up to a view keeps it', shouldOfferLiveUi('and Rust?', true));

// 10) The tool loop passes streaming arguments through, before the call starts.
const events: string[] = [];
await runToolLoop({
  ai: {
    streamChat: async (_c: any, _m: any, cb: any) => {
      if (events.includes('start')) return cb.onEnd();
      cb.onToolCallDelta({ id: 'c1', name: 'ui__render', argsText: '{"blocks":[' });
      cb.onToolCallDelta({ id: 'c1', name: 'ui__render', argsText: '{"blocks":[]}' });
      await cb.onToolCall([{ id: 'c1', functionName: 'ui__render', arguments: { blocks: [] } }]);
    },
  } as any,
  model: 'x',
  conversation: [{ role: 'user', content: 'hi' }],
  toolDefs: [],
  executeTool: async () => ({ resultText: 'ok' }),
  callbacks: {
    onToken: () => {},
    onToolCallDelta: (d) => events.push(`delta:${d.argsText.length}`),
    onToolCallStart: () => events.push('start'),
    onToolCallResult: () => events.push('result'),
    onEnd: () => events.push('end'),
    onError: (e) => events.push(`error:${e}`),
  },
});
check('tool loop: deltas, then start, result, end', events.join() === 'delta:11,delta:13,start,result,end');

for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n❌ LIVE UI VERIFY FAILED (${failed})` : `\n✅ LIVE UI VERIFY PASSED (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
