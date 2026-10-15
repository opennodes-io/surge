// Verifies the per-site agent feature without Electron:
//  1. declarative recipe runs through a mock BrowserPort (templating + saveAs)
//  2. sanitizer drops non-whitelisted actions and any code field
//  3. gated sandbox executes safe code, blocks require, and refuses when unapproved
import {
  buildAgentVirtualServer,
  sanitizeAgentSpec,
  runAgentCodeSandbox,
  type WebAgentSpec,
} from '@surge/core';
import type { BrowserPort } from '@surge/core';

class MockBrowser implements BrowserPort {
  navigated: string[] = [];
  evals: string[] = [];
  navigate(url: string) { this.navigated.push(url); }
  loadURL(url: string) { this.navigated.push(url); }
  getUrl() { return this.navigated[this.navigated.length - 1] || 'https://shop.test/'; }
  getTitle() { return 'Mock'; }
  async evaluate(js: string): Promise<any> {
    this.evals.push(js);
    if (js.includes('document.readyState')) return 'complete';
    if (js.startsWith('!!document.querySelector')) return true;
    if (js.includes("querySelectorAll('tr')")) return [{ name: 'Widget', price: '9.99' }];
    if (js.includes('innerText')) return 'some text';
    if (js.includes("new Event('input'") || js.includes('.click()') || js.includes("new Event('change'")) return { ok: true };
    return null;
  }
}

async function main() {
  let pass = true;
  const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`); pass = pass && cond; };

  // 1) declarative recipe
  const spec: WebAgentSpec = {
    version: 1,
    source: 'web-mcp',
    domain: 'shop.test',
    name: 'Shop agent',
    tools: [
      {
        name: 'search',
        description: 'Search the shop',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        steps: [
          { action: 'navigate', url: 'https://shop.test/?q={query}' },
          { action: 'waitFor', selector: '.results' },
          { action: 'fill', selector: '#q', valueFromParam: 'query' },
          { action: 'click', selector: '#go' },
          { action: 'extractTable', selector: 'table.results', saveAs: 'results' },
        ],
      },
    ],
  };
  const mock = new MockBrowser();
  const vs = buildAgentVirtualServer(spec, mock);
  const res = await vs.callTool('search', { query: 'widgets' });
  const out = JSON.parse(res.content[0].text);
  check('navigate templated url', mock.navigated[0] === 'https://shop.test/?q=widgets');
  check('fill value templated into eval', mock.evals.some((e) => e.includes('widgets') && e.includes("new Event('input'")));
  check('extractTable saved to results', Array.isArray(out.results) && out.results.length === 1 && out.results[0].name === 'Widget');
  check('virtual server id', vs.id === 'agent:shop.test');

  // 2) sanitizer strips bad action + code
  const sanitized = sanitizeAgentSpec(
    {
      name: 'x',
      tools: [
        { name: 'bad name!', description: 'd', parameters: { type: 'object', properties: {} }, steps: [{ action: 'evil' }, { action: 'click', selector: '#a' }], code: 'while(true){}' },
      ],
    },
    'evil.test',
  );
  const t0 = sanitized.tools[0];
  check('sanitized name cleaned', t0?.name === 'bad_name');
  check('non-whitelisted action dropped', !!t0 && t0.steps!.length === 1 && t0.steps![0].action === 'click');
  check('code field dropped by generator gate', !(t0 as any).code);
  check('codeApproved false', sanitized.codeApproved === false);

  // 3) sandbox: safe code runs
  const sum = await runAgentCodeSandbox('return input.a + input.b;', { a: 2, b: 3 }, '');
  check('sandbox runs safe code', sum === 5);

  // sandbox: require is not available
  let blocked = false;
  try {
    await runAgentCodeSandbox('return require("fs");', {}, '');
  } catch {
    blocked = true;
  }
  check('sandbox blocks require', blocked);

  // sandbox: no way out through objects made outside the context. Each probe reports what it
  // reached; a blocked probe throws (code generation is off) and comes back as 'blocked'.
  const probe = async (codeStr: string, input: unknown = { a: 1 }) => {
    try { return JSON.stringify(await runAgentCodeSandbox(codeStr, input, 'page text')); } catch (e: any) { return `blocked: ${e.message}`; }
  };
  const escapes = {
    viaObject: await probe(`return Object.constructor('return typeof process')()`),
    viaInput: await probe(`return input.constructor.constructor('return typeof process')()`),
    viaArray: await probe(`return input.list.constructor.constructor('return typeof process')()`, { list: [1] }),
    viaPage: await probe(`return page.constructor.constructor('return typeof process')()`),
    viaThis: await probe(`return (function () { return this; }).constructor('return typeof process')()`),
    viaError: await probe(`try { null.x } catch (e) { return e.constructor.constructor('return typeof process')() }`),
  };
  check('sandbox: no escape through Object, input, arrays, page text, functions or errors',
    Object.values(escapes).every((r) => r.startsWith('blocked:') && /Code generation from strings disallowed/.test(r)), JSON.stringify(escapes));
  check('sandbox: no Node globals inside', await probe(`return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.Buffer].join()`)
    === JSON.stringify('undefined,undefined,undefined,undefined,undefined'));
  check('sandbox: input and page still arrive, JSON values come back',
    await probe(`return { sum: input.a + input.list.length, words: page.split(' ').length, ok: Array.isArray(input.list) }`, { a: 2, list: [1, 2, 3] })
      === JSON.stringify({ sum: 5, words: 2, ok: true }));
  check('sandbox: undefined comes back as null', (await runAgentCodeSandbox('return;', {}, '')) === null);
  check('sandbox: a runaway loop times out', (await probe('while (true) {}')).startsWith('blocked:'));
  check('sandbox: a runaway promise job times out too', (await probe('Promise.resolve().then(() => { while (true) {} }); return 1;')).startsWith('blocked:'));

  // gated refusal: code tool without approval
  const codeSpec: WebAgentSpec = {
    version: 1, source: 'codegen', domain: 'c.test', name: 'c', codeApproved: false,
    tools: [{ name: 'run', description: 'd', parameters: { type: 'object', properties: {} }, code: 'return 1;' }],
  };
  const vs2 = buildAgentVirtualServer(codeSpec, new MockBrowser(), { runCode: runAgentCodeSandbox });
  const refused = await vs2.callTool('run', {});
  check('unapproved code tool refused', refused.isError === true);

  console.log(pass ? '\n✅ AGENT VERIFY PASSED' : '\n❌ AGENT VERIFY FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
