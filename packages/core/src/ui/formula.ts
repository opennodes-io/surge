// Formulas for Live UI's computed form fields ("price * qty", "round(total / people, 2)").
// A tiny arithmetic language, parsed by hand and evaluated over the form's numbers: no eval, no
// property access, no strings, no loops. What a formula can do is exactly what this file lets it.
//
//   numbers and names · + - * / ^ ( ) · < <= > >= == != (1 or 0)
//   min max round(x, digits?) floor ceil abs sqrt if(condition, then, else)

type Node =
  | { k: 'num'; v: number }
  | { k: 'ref'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

/**
 * Half away from zero, in decimal: round(2.345, 2) is 2.35 (x * 100 would be 234.49999… in binary
 * floating point). Shifting through the exponent ("2.345e2") avoids that.
 */
function roundTo(x: number, digits = 0): number {
  const d = Math.max(0, Math.min(6, Math.trunc(digits)));
  const a = Math.abs(x);
  if (!Number.isFinite(a) || String(a).includes('e')) return Math.sign(x) * (Math.round(a * 10 ** d) / 10 ** d);
  return Math.sign(x) * Number(`${Math.round(Number(`${a}e${d}`))}e-${d}`);
}

const FUNCTIONS: Record<string, { min: number; max: number; f: (...a: number[]) => number }> = {
  min: { min: 1, max: 20, f: (...a) => Math.min(...a) },
  max: { min: 1, max: 20, f: (...a) => Math.max(...a) },
  round: { min: 1, max: 2, f: roundTo },
  floor: { min: 1, max: 1, f: Math.floor },
  ceil: { min: 1, max: 1, f: Math.ceil },
  abs: { min: 1, max: 1, f: Math.abs },
  sqrt: { min: 1, max: 1, f: Math.sqrt },
  if: { min: 3, max: 3, f: (c, a, b) => (c ? a : b) },
};

const MAX_LENGTH = 300;
const MAX_DEPTH = 40;

class FormulaError extends Error {}

function parse(src: string): Node {
  const tokens = src.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z_][a-z0-9_]*|<=|>=|==|!=|[-+*/^(),<>]|\S/gi) ?? [];
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    const tok = tokens[i];
    if (t !== undefined && tok !== t) throw new FormulaError(tok === undefined ? `expected "${t}" at the end` : `expected "${t}", found "${tok}"`);
    i++;
    return tok;
  };
  const nest = <T>(fn: () => T): T => {
    if (++depth > MAX_DEPTH) throw new FormulaError('too deeply nested');
    try { return fn(); } finally { depth--; }
  };

  const compare = (): Node => {
    const a = add();
    const op = peek();
    if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=') { take(); return { k: 'bin', op, a, b: add() }; }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (peek() === '+' || peek() === '-') { const op = take(); a = { k: 'bin', op, a, b: mul() }; }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (peek() === '*' || peek() === '/') { const op = take(); a = { k: 'bin', op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => nest(() => {
    if (peek() === '-') { take(); return { k: 'neg', a: unary() }; }
    if (peek() === '+') { take(); return unary(); }
    return power();
  });
  // Right-associative and tighter than unary minus on its left: -2^2 = -4, 2^-1 = 0.5.
  const power = (): Node => {
    const a = primary();
    if (peek() === '^') { take(); return { k: 'bin', op: '^', a, b: unary() }; }
    return a;
  };
  const primary = (): Node => nest(() => {
    const tok = take();
    if (tok === undefined) throw new FormulaError('ends too early');
    if (tok === '(') { const e = compare(); take(')'); return e; }
    if (/^[\d.]/.test(tok)) {
      const v = Number(tok);
      if (!Number.isFinite(v)) throw new FormulaError(`bad number "${tok}"`);
      return { k: 'num', v };
    }
    if (/^[a-z_]/i.test(tok)) {
      if (peek() !== '(') return { k: 'ref', name: tok };
      const fn = FUNCTIONS[tok.toLowerCase()];
      if (!fn) throw new FormulaError(`unknown function "${tok}"`);
      take('(');
      const args: Node[] = [];
      if (peek() !== ')') { args.push(compare()); while (peek() === ',') { take(); args.push(compare()); } }
      take(')');
      if (args.length < fn.min || args.length > fn.max) throw new FormulaError(`${tok.toLowerCase()} takes ${fn.min === fn.max ? fn.min : `${fn.min}–${fn.max}`} argument${fn.max === 1 ? '' : 's'}`);
      return { k: 'call', fn: tok.toLowerCase(), args };
    }
    throw new FormulaError(`unexpected "${tok}"`);
  });

  if (!tokens.length) throw new FormulaError('empty');
  const node = compare();
  if (i < tokens.length) throw new FormulaError(`unexpected "${tokens[i]}"`);
  return node;
}

function refs(node: Node, out = new Set<string>()): Set<string> {
  if (node.k === 'ref') out.add(node.name);
  else if (node.k === 'neg') refs(node.a, out);
  else if (node.k === 'bin') { refs(node.a, out); refs(node.b, out); }
  else if (node.k === 'call') node.args.forEach((a) => refs(a, out));
  return out;
}

function evaluate(node: Node, vars: Record<string, number>): number {
  switch (node.k) {
    case 'num': return node.v;
    case 'ref': return Object.prototype.hasOwnProperty.call(vars, node.name) ? vars[node.name] : NaN;
    case 'neg': return -evaluate(node.a, vars);
    case 'call': return FUNCTIONS[node.fn].f(...node.args.map((a) => evaluate(a, vars)));
    case 'bin': {
      const a = evaluate(node.a, vars), b = evaluate(node.b, vars);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return a ** b;
        case '<': return +(a < b);
        case '<=': return +(a <= b);
        case '>': return +(a > b);
        case '>=': return +(a >= b);
        case '==': return +(a === b);
        case '!=': return +(a !== b);
      }
      return NaN;
    }
  }
}

export interface CompiledFormula {
  /** The names the formula reads. */
  refs: string[];
  /** The result, or undefined when an input is missing or the math has no answer (x / 0). */
  run: (vars: Record<string, number>) => number | undefined;
}

/** Parses a formula. `names` are the values it may read; anything else is an error. */
export function compileFormula(src: string, names: readonly string[]): CompiledFormula | { error: string } {
  if (src.length > MAX_LENGTH) return { error: `longer than ${MAX_LENGTH} characters` };
  let node: Node;
  try {
    node = parse(src);
  } catch (err) {
    if (err instanceof FormulaError) return { error: err.message };
    throw err;
  }
  const used = [...refs(node)];
  const unknown = used.find((n) => !names.includes(n));
  if (unknown) return { error: `unknown name "${unknown}"${names.length ? ` (use ${names.join(', ')})` : ''}` };
  return {
    refs: used,
    run: (vars) => {
      const v = evaluate(node, vars);
      return Number.isFinite(v) ? v : undefined;
    },
  };
}
