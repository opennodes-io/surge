import type { BrowserPort } from '../ports/browser-port.js';
import type { McpTool, VirtualServer } from '../mcp/mcp-manager.js';
import type { AgentSpec } from '../storage/types.js';
import { agentServerId, type AgentStep, type AgentToolDef, type WebAgentSpec } from './agent-types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const j = (v: unknown) => JSON.stringify(v ?? null);

export interface AgentRuntimeOptions {
  /**
   * Injected gated runner for the opt-in arbitrary-code path. Only invoked for tools
   * that carry `code` AND when the spec's codeApproved flag is true. Left undefined,
   * code tools simply refuse to run.
   */
  runCode?: (code: string, input: any, pageText: string) => Promise<any>;
  /** delay applied after a navigate step before continuing (ms) */
  navWaitMs?: number;
}

function resolveTemplate(str: string | undefined, args: Record<string, any>): string {
  if (!str) return '';
  return str.replace(/\{(\w+)\}/g, (_m, k) => (args[k] != null ? String(args[k]) : ''));
}

function valueForStep(step: AgentStep, args: Record<string, any>): string {
  if (step.valueFromParam) return args[step.valueFromParam] != null ? String(args[step.valueFromParam]) : '';
  return resolveTemplate(step.value, args);
}

async function safeEval(browser: BrowserPort, js: string): Promise<any> {
  try {
    return await browser.evaluate(js);
  } catch (err: any) {
    return { __evalError: err?.message || String(err) };
  }
}

async function waitForSelector(browser: BrowserPort, selector: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const sel = j(selector);
  while (Date.now() < deadline) {
    const present = await safeEval(browser, `!!document.querySelector(${sel})`);
    if (present === true) return true;
    await sleep(150);
  }
  return false;
}

async function executeStep(
  browser: BrowserPort,
  step: AgentStep,
  args: Record<string, any>,
): Promise<unknown> {
  const sel = j(step.selector || null);
  const timeout = step.timeoutMs ?? 8000;

  switch (step.action) {
    case 'navigate': {
      const url = resolveTemplate(step.url, args);
      if (!url) return { ok: false, error: 'navigate: empty url' };
      await browser.navigate(url);
      // wait for the document to be ready
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const ready = await safeEval(browser, `document.readyState`);
        if (ready === 'complete' || ready === 'interactive') break;
        await sleep(150);
      }
      return { ok: true, url };
    }
    case 'waitFor': {
      if (!step.selector) return { ok: false, error: 'waitFor: no selector' };
      return { ok: await waitForSelector(browser, step.selector, timeout) };
    }
    case 'fill': {
      const val = j(valueForStep(step, args));
      return safeEval(
        browser,
        `(function(){var el=document.querySelector(${sel});if(!el)return{ok:false,error:'not found'};if(el.focus)el.focus();el.value=${val};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true}})()`,
      );
    }
    case 'click':
      return safeEval(
        browser,
        `(function(){var el=document.querySelector(${sel});if(!el)return{ok:false,error:'not found'};el.click();return{ok:true}})()`,
      );
    case 'select': {
      const val = j(valueForStep(step, args));
      return safeEval(
        browser,
        `(function(){var el=document.querySelector(${sel});if(!el)return{ok:false};el.value=${val};el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true}})()`,
      );
    }
    case 'pressKey': {
      const key = j(step.key || 'Enter');
      return safeEval(
        browser,
        `(function(){var el=${step.selector ? `document.querySelector(${sel})` : 'document.activeElement'}||document.body;['keydown','keypress','keyup'].forEach(function(t){el.dispatchEvent(new KeyboardEvent(t,{key:${key},bubbles:true}))});return{ok:true}})()`,
      );
    }
    case 'extractText':
      return safeEval(
        browser,
        `(function(){var el=document.querySelector(${sel});return el?(el.innerText||'').trim():null})()`,
      );
    case 'extractAttribute': {
      const attr = j(step.attribute || 'href');
      return safeEval(
        browser,
        `(function(){var el=document.querySelector(${sel});return el?el.getAttribute(${attr}):null})()`,
      );
    }
    case 'extractLinks':
      return safeEval(
        browser,
        `(function(){var sc=${step.selector ? `document.querySelector(${sel})` : 'document'};if(!sc)return[];return Array.from(sc.querySelectorAll('a[href]')).slice(0,100).map(function(a){return{text:(a.innerText||'').trim(),href:a.href}})})()`,
      );
    case 'extractTable':
      return safeEval(
        browser,
        `(function(){var t=document.querySelector(${sel});if(!t)return[];var rows=Array.from(t.querySelectorAll('tr'));if(!rows.length)return[];var headers=Array.from(rows[0].querySelectorAll('th,td')).map(function(c){return (c.innerText||'').trim()});var data=[];for(var i=1;i<rows.length;i++){var cells=Array.from(rows[i].querySelectorAll('td,th'));var obj={};cells.forEach(function(c,idx){obj[headers[idx]||('col'+idx)]=(c.innerText||'').trim()});data.push(obj)}return data})()`,
      );
    default:
      return { ok: false, error: `unknown action ${(step as any).action}` };
  }
}

async function runDeclarativeTool(
  browser: BrowserPort,
  tool: AgentToolDef,
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  let i = 0;
  for (const step of tool.steps || []) {
    const result = await executeStep(browser, step, args);
    if (step.saveAs) output[step.saveAs] = result;
    else output[`step${i}_${step.action}`] = result;
    i++;
  }
  return output;
}

const okText = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const errText = (msg: string) => ({ content: [{ type: 'text', text: msg }], isError: true });

/**
 * Build a virtual MCP server from a saved web-agent spec. Declarative recipes run safely
 * through the BrowserPort; the opt-in code path runs only via an injected, approved runner.
 */
export function buildAgentVirtualServer(
  spec: WebAgentSpec,
  browser: BrowserPort,
  opts: AgentRuntimeOptions = {},
): VirtualServer {
  const id = agentServerId(spec.domain);
  const tools: McpTool[] = spec.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    serverId: id,
  }));

  return {
    id,
    name: spec.name || `${spec.domain} (agent)`,
    source: 'codegen',
    tools,
    persist: () => spec as unknown as AgentSpec,
    callTool: async (toolName: string, args: any) => {
      const tool = spec.tools.find((t) => t.name === toolName);
      if (!tool) return errText(`Unknown agent tool: ${toolName}`);
      const a = args || {};

      if (tool.code && tool.code.trim()) {
        if (!spec.codeApproved || !opts.runCode) {
          return errText('This tool uses arbitrary code, which is not approved for execution.');
        }
        const pageText = await safeEval(browser, `document.body ? document.body.innerText.slice(0,5000) : ''`);
        try {
          const result = await opts.runCode(tool.code, a, typeof pageText === 'string' ? pageText : '');
          return okText(result);
        } catch (err: any) {
          return errText(`Agent code error: ${err?.message || err}`);
        }
      }

      try {
        const result = await runDeclarativeTool(browser, tool, a);
        if (opts.navWaitMs) await sleep(0);
        return okText(result);
      } catch (err: any) {
        return errText(`Agent error: ${err?.message || err}`);
      }
    },
  };
}
