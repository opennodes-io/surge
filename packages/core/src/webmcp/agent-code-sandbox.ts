// Gated sandbox for the opt-in arbitrary-code agent path.
//
// THREAT MODEL / LIMITS: arbitrary JS is risky. This runner applies defense-in-depth:
//  - runs in a separate worker_threads Worker (isolated heap; killable), with an empty environment
//  - the user code executes in a fresh vm context that holds no object from outside it: only the
//    context's own built-ins (JSON, Math, Array, …) and two strings, the input and the page text,
//    parsed inside the context. NO require, process, fs, net, fetch, global, Buffer, timers.
//  - codeGeneration.strings/wasm disabled in the context (blocks nested eval/new Function)
//  - hard wall-clock timeout (parent terminates the worker), and the vm timeout covers the whole
//    run, microtasks included
//  - constrained heap via resourceLimits
//
// Why no outside objects: an object made outside the context leads back to the outside Function
// constructor (`Object.constructor`, `input.constructor.constructor`), which the context's
// code-generation switch doesn't cover. Handing in the worker's own Object, or a structured-clone
// `input`, let agent code reach the worker's process, fetch and require. A string is a primitive:
// its methods come from the context's own String, whose Function stays blocked.
//
// Still NOT a perfect security boundary (V8 bugs, resource exhaustion); it is only ever reached
// when the user has explicitly approved code execution for a specific agent (spec.codeApproved).

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
try {
  const { code, inputJson, page } = workerData;
  const sandbox = Object.create(null);
  sandbox.__input = inputJson;
  sandbox.__page = page;
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  // Parse, run and serialize inside the context, under one timeout: only a string comes back out.
  const script = new vm.Script(
    '(function () { "use strict";\\n' +
    '  const run = function (input, page) { "use strict";\\n' + String(code) + '\\n};\\n' +
    '  const out = run(JSON.parse(__input), __page);\\n' +
    '  return out === undefined ? "null" : JSON.stringify(out);\\n' +
    '})()'
  );
  const json = script.runInContext(ctx, { timeout: 3000 });
  parentPort.postMessage({ ok: true, json: typeof json === 'string' ? json : 'null' });
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
      workerData: { code, inputJson: JSON.stringify(input ?? null), page: String(page ?? '') },
      env: {},
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
    worker.once('message', (msg: any) => finish(() => {
      if (!msg?.ok) return reject(new Error(msg?.error || 'agent code failed'));
      try { resolve(JSON.parse(msg.json)); } catch { reject(new Error('agent code returned something that is not JSON')); }
    }));
    worker.once('error', (err) => finish(() => reject(err)));
  });
}
