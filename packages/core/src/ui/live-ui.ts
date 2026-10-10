// Live UI: interactive answers the model composes from a small set of native components
// (Surge's take on "intelligent UI"). The model calls the `ui__render` tool with a spec; the host
// validates it here and draws the components; clicks send a follow-up prompt or open a link.
//
// Platform-agnostic and dependency-free on purpose (hand-written validation, no schema library):
// every consumer bundles @surge/core.

import { compileFormula } from './formula.js';

/** What a click does: send this prompt as the user's next message, or open this link. */
export interface LiveUiAction {
  prompt?: string;
  url?: string;
}

export type LiveUiBlock =
  | { type: 'text'; text: string }
  | { type: 'stats'; items: Array<{ label: string; value: string; hint?: string }> }
  | { type: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { type: 'chart'; title?: string; kind: 'bar' | 'line'; labels: string[]; series: Array<{ name: string; values: number[] }> }
  | { type: 'list'; title?: string; items: Array<{ title: string; subtitle?: string } & LiveUiAction> }
  | { type: 'compare'; title?: string; items: Array<{ title: string; points: string[] } & LiveUiAction> }
  | { type: 'buttons'; items: Array<{ label: string } & LiveUiAction> }
  | {
      type: 'form';
      title?: string;
      fields: LiveUiField[];
      /** Optional when the form has computed fields: a calculator needs no model round trip. */
      submit?: { label: string; prompt: string };
    };

export interface LiveUiField {
  name: string;
  label: string;
  /** computed: a read-only value recalculated from the fields above it as the user types. */
  kind: 'text' | 'number' | 'select' | 'slider' | 'computed';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  value?: string | number;
  /** computed: arithmetic over earlier fields (see formula.ts). */
  formula?: string;
  /** Shown with number, slider and computed values: "$" and other currency signs before, the rest after. */
  unit?: string;
}

export interface LiveUiSpec {
  title?: string;
  blocks: LiveUiBlock[];
}

export const LIVE_UI_BLOCK_TYPES = ['text', 'stats', 'table', 'chart', 'list', 'compare', 'buttons', 'form'] as const;

const MAX_BLOCKS = 30;
const FIELD_KINDS = ['text', 'number', 'select', 'slider', 'computed'] as const;

// ── validation ─────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};
const action = (o: Obj): LiveUiAction => {
  const out: LiveUiAction = {};
  const prompt = str(o.prompt, 500);
  const url = httpUrl(o.url);
  if (prompt) out.prompt = prompt;
  if (url) out.url = url;
  return out;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The block type from its fields, for blocks that leave "type" out or misname it. Models get the
 * content right more often than the tag: a local gemma sent a perfect comparison without "type"
 * four times in a row; llama3.2 put the type in "kind".
 */
function inferType(raw: Obj): string | undefined {
  const known = (v: unknown) => typeof v === 'string' && (LIVE_UI_BLOCK_TYPES as readonly string[]).includes(v);
  if (known(raw.kind)) return raw.kind as string;
  if (Array.isArray(raw.columns) || Array.isArray(raw.rows)) return 'table';
  if (Array.isArray(raw.series) || Array.isArray(raw.labels)) return 'chart';
  if (Array.isArray(raw.fields) || isObj(raw.submit)) return 'form';
  const items = arr(raw.items).filter(isObj);
  if (items.length) {
    if (items.some((i) => Array.isArray(i.points))) return 'compare';
    if (items.every((i) => i.label !== undefined && i.value !== undefined)) return 'stats';
    if (items.every((i) => i.label !== undefined && i.title === undefined)) return 'buttons';
    if (items.some((i) => i.title !== undefined)) return 'list';
  }
  if (typeof raw.text === 'string') return 'text';
  return undefined;
}

/** Validates one block; returns it cleaned (sizes capped, unknown fields dropped) or an error. */
function validateBlock(raw: unknown, path: string): { block?: LiveUiBlock; error?: string } {
  if (!isObj(raw)) return { error: `${path}: expected an object` };
  const type = (LIVE_UI_BLOCK_TYPES as readonly string[]).includes(raw.type as string) ? raw.type : inferType(raw);
  const title = str(raw.title, 120);
  const t = title ? { title } : {};
  switch (type) {
    case 'text': {
      const text = str(raw.text, 4000);
      return text ? { block: { type, text } } : { error: `${path}.text: required` };
    }
    case 'stats': {
      const items = arr(raw.items).filter(isObj).slice(0, 8).flatMap((i) => {
        const label = str(i.label, 40), value = str(i.value, 40);
        if (!label || !value) return [];
        const hint = str(i.hint, 80);
        return [{ label, value, ...(hint ? { hint } : {}) }];
      });
      return items.length ? { block: { type, items } } : { error: `${path}.items: 1–8 of { label, value, hint? }` };
    }
    case 'table': {
      // Empty headers stay (a row-label column often has none); dropping them would shift every row.
      const columns = arr(raw.columns).slice(0, 8).map((c) => str(c, 40) ?? '');
      if (!columns.some(Boolean)) return { error: `${path}.columns: 1–8 column names` };
      const rows = arr(raw.rows).filter(Array.isArray).slice(0, 50)
        .map((r) => columns.map((_, i) => str((r as unknown[])[i], 200) ?? ''));
      return rows.length ? { block: { type, ...t, columns, rows } } : { error: `${path}.rows: 1–50 rows (arrays of cells)` };
    }
    case 'chart': {
      const kind = raw.kind === 'line' ? 'line' : raw.kind === 'bar' || raw.kind === undefined ? 'bar' : undefined;
      if (!kind) return { error: `${path}.kind: "bar" or "line"` };
      const labels = arr(raw.labels).map((l) => str(l, 24)).filter((l): l is string => !!l).slice(0, 24);
      if (labels.length < 2) return { error: `${path}.labels: 2–24 labels` };
      const series = arr(raw.series).filter(isObj).slice(0, 4).map((s, k) => ({
        name: str(s.name, 30) ?? `Series ${k + 1}`,
        values: arr(s.values).map(num),
      }));
      if (!series.length) return { error: `${path}.series: 1–4 of { name, values }` };
      // A bad series is skipped, not the chart: while a view streams, the series being written is
      // still short, and the chart shouldn't vanish until it's done.
      const fits = (s: { values: Array<number | undefined> }) => s.values.length === labels.length && s.values.every((v) => v !== undefined);
      const bad = series.findIndex((s) => !fits(s));
      const error = bad >= 0 ? `${path}.series[${bad}].values: expected ${labels.length} numbers, one per label` : undefined;
      const good = series.filter(fits) as Array<{ name: string; values: number[] }>;
      if (!good.length) return { error };
      return { block: { type, ...t, kind, labels, series: good }, ...(error ? { error } : {}) };
    }
    case 'list': {
      const items = arr(raw.items).filter(isObj).slice(0, 20).flatMap((i) => {
        const itemTitle = str(i.title, 120);
        if (!itemTitle) return [];
        const subtitle = str(i.subtitle, 200);
        return [{ title: itemTitle, ...(subtitle ? { subtitle } : {}), ...action(i) }];
      });
      return items.length ? { block: { type, ...t, items } } : { error: `${path}.items: 1–20 of { title, subtitle?, prompt?, url? }` };
    }
    case 'compare': {
      const items = arr(raw.items).filter(isObj).slice(0, 3).flatMap((i) => {
        const itemTitle = str(i.title, 60);
        const points = arr(i.points).map((p) => str(p, 160)).filter((p): p is string => !!p).slice(0, 8);
        return itemTitle && points.length ? [{ title: itemTitle, points, ...action(i) }] : [];
      });
      return items.length >= 2 ? { block: { type, ...t, items } } : { error: `${path}.items: 2–3 of { title, points: [..] }` };
    }
    case 'buttons': {
      const items = arr(raw.items).filter(isObj).slice(0, 6).flatMap((i) => {
        const label = str(i.label, 40);
        const a = action(i);
        return label && (a.prompt || a.url) ? [{ label, ...a }] : [];
      });
      return items.length ? { block: { type, items } } : { error: `${path}.items: 1–6 of { label, prompt or url }` };
    }
    case 'form': {
      const fields: LiveUiField[] = [];
      const fieldErrors: string[] = [];
      arr(raw.fields).filter(isObj).slice(0, 8).forEach((f, i) => {
        const name = typeof f.name === 'string' && /^[a-z][a-z0-9_]{0,23}$/i.test(f.name) ? f.name : undefined;
        const label = str(f.label, 40) ?? name;
        // A formula without a kind is a computed field.
        const kind = FIELD_KINDS.find((k) => k === f.kind) ?? (typeof f.formula === 'string' ? 'computed' : 'text');
        if (!name || !label || fields.some((x) => x.name === name)) return;
        const field: LiveUiField = { name, label, kind };
        if (kind === 'select') {
          const options = arr(f.options).map((o) => str(o, 60)).filter((o): o is string => !!o).slice(0, 12);
          if (options.length < 2) return;
          field.options = options;
        }
        if (kind === 'computed') {
          // A computed field reads only the fields above it, so formulas can't form a cycle.
          const formula = str(f.formula, 300);
          const compiled = formula ? compileFormula(formula, fields.map((x) => x.name)) : { error: 'required' };
          if ('error' in compiled) { fieldErrors.push(`${path}.fields[${i}].formula: ${compiled.error}`); return; }
          field.formula = formula;
        } else {
          const value = kind === 'number' || kind === 'slider' ? num(f.value) : str(f.value, 200);
          if (value !== undefined) field.value = value;
        }
        for (const k of ['min', 'max', 'step'] as const) { const n = num(f[k]); if (n !== undefined) field[k] = n; }
        const unit = kind === 'number' || kind === 'slider' || kind === 'computed' ? str(f.unit, 12) : undefined;
        if (unit) field.unit = unit;
        fields.push(field);
      });
      const submit = isObj(raw.submit) ? { label: str(raw.submit.label, 30) ?? 'Submit', prompt: str(raw.submit.prompt, 500) } : undefined;
      const fail = (error: string) => ({ error: [...fieldErrors, error].join('; ') });
      if (!fields.length) return fail(`${path}.fields: 1–8 of { name, label, kind: ${FIELD_KINDS.join('|')} }`);
      if (!submit?.prompt && !fields.some((x) => x.kind === 'computed')) {
        return fail(`${path}.submit: { label, prompt } (use {field_name} to insert a value), unless the form has computed fields`);
      }
      return {
        block: { type, ...t, fields, ...(submit?.prompt ? { submit: { label: submit.label, prompt: submit.prompt } } : {}) },
        ...(fieldErrors.length ? { error: fieldErrors.join('; ') } : {}),
      };
    }
    default:
      return { error: `${path}: add "type", one of ${LIVE_UI_BLOCK_TYPES.join(', ')}` };
  }
}

/**
 * Lenient validation: keeps the valid blocks and reports the rest, so a mostly-right spec still
 * renders and the model learns what to fix. Fails only when nothing valid is left.
 */
export function validateLiveUi(input: unknown): { spec?: LiveUiSpec; errors: string[] } {
  let raw = input;
  // Some models send the spec as a JSON string.
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return { errors: ['spec: not valid JSON'] }; }
  }
  if (isObj(raw) && isObj(raw.spec)) raw = raw.spec;
  if (!isObj(raw)) return { errors: ['expected { title?, blocks: [...] }'] };
  const errors: string[] = [];
  const blocks: LiveUiBlock[] = [];
  const list = arr(raw.blocks);
  if (!list.length) return { errors: ['blocks: at least one block'] };
  list.slice(0, MAX_BLOCKS).forEach((b, i) => {
    const { block, error } = validateBlock(b, `blocks[${i}]`);
    if (block) blocks.push(block);
    if (error) errors.push(error);
  });
  if (list.length > MAX_BLOCKS) errors.push(`blocks: only the first ${MAX_BLOCKS} are shown`);
  if (!blocks.length) return { errors };
  const title = str(raw.title, 120);
  return { spec: { ...(title ? { title } : {}), blocks }, errors };
}

// ── the tool ───────────────────────────────────────────────

const actionProps = {
  prompt: { type: 'string', description: 'Sent as the user\'s next message when clicked' },
  url: { type: 'string', description: 'http(s) link opened when clicked' },
};

/**
 * The `render` tool of the "ui" virtual server (the model sees it as ui__render). The schema is
 * flat — one object type whose fields each block type uses a subset of — because some providers
 * (Gemini) reject loose or recursive schemas.
 */
export const LIVE_UI_TOOL = {
  name: 'render',
  description: [
    'Show the user an interactive view in the chat when it is clearer than plain text: a comparison (compare),',
    'numbers at a glance (stats), tabular data (table), a trend or breakdown (chart), options or next steps (list, buttons),',
    'or inputs to refine a request (form). Answer simple questions in plain text instead.',
    'Blocks: text {text (markdown)} · stats {items:[{label,value,hint?}]} · table {title?,columns:[..],rows:[[..]]} ·',
    'chart {title?,kind:bar|line,labels:[..],series:[{name,values:[numbers, one per label]}]} ·',
    'list {title?,items:[{title,subtitle?,prompt?,url?}]} · compare {title?,items:[2-3 of {title (names the option),points:[..],prompt?,url?}]} ·',
    'buttons {items:[{label,prompt or url}]} · form {title?,fields:[{name,label,kind:text|number|select|slider|computed,options?,min?,max?,step?,value?,unit?,formula?}],',
    'submit?:{label,prompt with {field_name} placeholders}}. A computed field shows a formula over the fields above it, recalculated as the user types',
    '(e.g. "round(price*qty*(1+tax/100), 2)"; + - * / ^ ( ) min max round floor ceil abs sqrt if): use it for calculators, where submit is optional.',
    'Clicking a button, list item or compare card, or submitting a form, sends its prompt as the user\'s next message (or opens its url).',
    'After rendering, add at most one short sentence; do not repeat the view\'s contents.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional heading for the whole view' },
      blocks: {
        type: 'array',
        description: 'The view, top to bottom (1-30 blocks)',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...LIVE_UI_BLOCK_TYPES] },
            text: { type: 'string' },
            title: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                  hint: { type: 'string' },
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  points: { type: 'array', items: { type: 'string' } },
                  ...actionProps,
                },
              },
            },
            columns: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            kind: { type: 'string', description: 'chart: bar|line; form field kinds go in fields[].kind' },
            labels: { type: 'array', items: { type: 'string' } },
            series: {
              type: 'array',
              items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } } },
            },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  kind: { type: 'string', enum: [...FIELD_KINDS] },
                  options: { type: 'array', items: { type: 'string' } },
                  min: { type: 'number' },
                  max: { type: 'number' },
                  step: { type: 'number' },
                  value: { type: 'string' },
                  unit: { type: 'string' },
                  formula: { type: 'string' },
                },
              },
            },
            submit: { type: 'object', properties: { label: { type: 'string' }, prompt: { type: 'string' } } },
          },
          required: ['type'],
        },
      },
    },
    required: ['blocks'],
  },
};

/** What the model gets back from ui__render: confirmation (plus anything that was dropped), or what to fix. */
export function liveUiToolResult(args: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const { spec, errors } = validateLiveUi(args);
  if (!spec) {
    // One retry at most: a model that repeats the same mistake should just answer in text.
    return { isError: true, content: [{ type: 'text', text: `Nothing was shown (${errors.join('; ')}). Fix it and call ui__render once more, or answer in plain text.` }] };
  }
  const shown = `Shown to the user as an interactive view (${spec.blocks.length} block${spec.blocks.length === 1 ? '' : 's'}).`;
  const dropped = errors.length ? ` Skipped: ${errors.join('; ')}.` : '';
  return { content: [{ type: 'text', text: `${shown}${dropped} Add at most one short sentence; don't repeat its contents.` }] };
}

/** A form's prompt with its {field} placeholders filled; fields the prompt doesn't mention are appended. */
export function fillFormPrompt(prompt: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const filled = prompt.replace(/\{([a-z][a-z0-9_]{0,23})\}/gi, (m, name: string) => {
    if (!(name in values)) return m;
    used.add(name);
    return values[name];
  });
  const rest = Object.entries(values).filter(([k, v]) => !used.has(k) && v !== '');
  return rest.length ? `${filled}\n${rest.map(([k, v]) => `${k}: ${v}`).join('\n')}` : filled;
}

/** A number as a form shows it: grouped, at most two decimals, with its unit ("$1,250.50", "12.5 h", "8%"). */
export function formatLiveUiNumber(n: number, unit?: string): string {
  const money = !!unit && /^[$€£¥₴₹₩₽]/.test(unit);
  const a = Math.abs(n);
  // Money with cents shows both digits ($34.50); whole amounts stay whole ($120).
  const cents = money && Math.round(a * 100) % 100 !== 0;
  const text = a.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
  const sign = n < 0 ? '-' : '';
  if (!unit) return sign + text;
  if (money) return `${sign}${unit}${text}`;
  return unit === '%' ? `${sign}${text}%` : `${sign}${text} ${unit}`;
}

/**
 * Every computed field's value for the form's current inputs, in field order (a computed field can
 * read the ones above it). A missing input, or math without an answer (x / 0), gives undefined.
 */
export function computeFormValues(fields: LiveUiField[], inputs: Record<string, string>): Record<string, number | undefined> {
  const vars: Record<string, number> = {};
  const out: Record<string, number | undefined> = {};
  for (const f of fields) {
    if (f.kind === 'computed') {
      const compiled = f.formula ? compileFormula(f.formula, Object.keys(vars)) : undefined;
      const v = compiled && !('error' in compiled) ? compiled.run(vars) : undefined;
      out[f.name] = v;
      vars[f.name] = v ?? NaN;
    } else {
      const raw = (inputs[f.name] ?? '').trim().replace(/,/g, '');
      vars[f.name] = raw === '' ? NaN : Number(raw);
    }
  }
  return out;
}

// ── when to offer the tool ─────────────────────────────────

// Messages that tend to read better as a view: comparing, planning, numbers, choosing, calculating.
const LIVE_UI_CUES = new RegExp(
  '\\b(?:' +
    [
      'compar\\w*', 'vs\\.?', 'versus', 'differen\\w*', 'pros', 'cons', 'better', 'which',
      'plan\\w*', 'schedul\\w*', 'itinerar\\w*', 'roadmap', 'checklist', 'timeline', 'steps?', 'routine',
      'charts?', 'graphs?', 'tables?', 'stats?', 'statistics?', 'trends?', 'breakdown', 'data', 'growth', 'numbers',
      'options?', 'alternatives?', 'recommend\\w*', 'suggest\\w*', 'best', 'top \\d+', 'choose', 'pick', 'rank\\w*', 'should i',
      'calculat\\w*', 'estimat\\w*', 'convert\\w*', 'budget\\w*', 'how much', 'how many', 'costs?', 'prices?', 'pricing',
      'mortgage', 'loans?', 'split', 'salary', 'savings?', 'interest',
      'summar\\w*', 'overview', 'feeds?',
    ].join('|') +
    ')\\b',
  'i',
);

/**
 * Whether to offer ui__render this turn in "When it helps" mode (the default): when the user's
 * message looks like a comparison, plan, data, choice or calculation question, or when the previous
 * answer was a view, so follow-ups like "and Rust?" keep it. Other turns save the tool's ~900
 * prompt tokens. English cues only, for now.
 */
export function shouldOfferLiveUi(userText: string, previousAnswerWasView: boolean): boolean {
  return previousAnswerWasView || LIVE_UI_CUES.test(userText);
}
