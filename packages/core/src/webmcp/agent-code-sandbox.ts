// Gated sandbox for the opt-in arbitrary-code agent path.
//
// THREAT MODEL / LIMITS: arbitrary JS is risky. This runner applies defense-in-depth:
//  - runs in a separate worker_threads Worker (isolated heap; killable)
//  - the user code executes in a vm context whose globals are an allow-list only
//    (input, page, JSON, Math, String/Number/Array/Object/Boolean/RegExp) — NO require,
//    process, fs, net, fetch, global, Buffer, timers
//  - codeGeneration.strings/wasm disabled in the context (blocks nested eval/new Function)
//  - hard wall-clock timeout (parent terminates the worker)
//  - constrained heap via resourceLimits
// This is NOT a perfect security boundary; it is only ever reached when the user has
// explicitly approved code execution for a specific agent (spec.codeApproved === true).

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
try {
  const { code, input, page } = workerData;
  const sandbox = Object.create(null);
  sandbox.input = input;
  sandbox.page = page;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.String = String;
  sandbox.Number = Number;
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.Boolean = Boolean;
  sandbox.RegExp = RegExp;
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script('(function(input, page){ "use strict";\\n' + String(code) + '\\n})');
  const fn = script.runInContext(ctx, { timeout: 3000 });
  const result = fn(input, page);
  parentPort.postMessage({ ok: true, result: result === undefined ? null : result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
`;

export interface CodeSandboxOptions {
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
}

/**
 * Execute an approved agent code handler in an isolated worker. `input` is the tool's
 * arguments; `page` is read-only truncated page text. Returns the handler's JSON-able value.
 */
export async function runAgentCodeSandbox(
  code: string,
  input: unknown,
  page: string,
  opts: CodeSandboxOptions = {},
): Promise<unknown> {
  const { Worker } = await import('node:worker_threads');
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { code, input, page },
      resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? 64 },
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('agent code timed out'))), opts.timeoutMs ?? 5000);
    worker.once('message', (msg: any) => finish(() => (msg?.ok ? resolve(msg.result) : reject(new Error(msg?.error || 'agent code failed')))));
    worker.once('error', (err) => finish(() => reject(err)));
  });
}
