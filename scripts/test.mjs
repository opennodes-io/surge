#!/usr/bin/env node
// `pnpm test`: the hermetic verification scripts — no network, no API keys, mock servers only.
// This is what CI runs. Each script prints its checks and exits non-zero on the first failure.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'servers/bookmarks-history-mcp');
// tsx and tsup are dev dependencies of the standalone server; resolve them from there.
const requireFromServer = createRequire(path.join(SERVER, 'package.json'));
const tsx = requireFromServer.resolve('tsx/cli');
const tsup = path.join(path.dirname(requireFromServer.resolve('tsup/package.json')), 'dist/cli-default.js');

const tests = [
  ['packages/core', 'test/verify-core.ts', 'storage, bookmarks MCP server, MCP-UI detection'],
  ['packages/core', 'test/verify-agents.ts', 'per-site agents: declarative runtime, sanitizer, code sandbox'],
  ['packages/core', 'test/verify-onp-invocation.ts', 'OpenNodes: pins, 409 handling, receipts, spend policy, Auto'],
  ['packages/core', 'test/verify-keys-spend-private.ts', 'per-host keys, spend ledger, private mode'],
  ['servers/bookmarks-history-mcp', 'test/smoke.ts', 'standalone bookmarks/history MCP server'],
];

// The server smoke test drives the built dist/stdio.js, so build it first (tsup, well under a second).
const build = spawnSync(process.execPath, [tsup], { cwd: SERVER, stdio: ['ignore', 'ignore', 'inherit'] });
if (build.status !== 0) {
  console.error('building servers/bookmarks-history-mcp failed');
  process.exit(1);
}

let failed = 0;
for (const [dir, file, what] of tests) {
  console.log(`\n── ${path.posix.join(dir, file)} — ${what}`);
  const r = spawnSync(process.execPath, [tsx, file], { cwd: path.join(ROOT, dir), stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} of ${tests.length} test scripts failed` : `\nall ${tests.length} test scripts passed`);
process.exit(failed ? 1 : 0);
