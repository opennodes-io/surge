// MCP discovery sources and the stdio server environment. Run via tsx; hermetic: mock index, mock
// official registry and local stdio servers only, no network.
//  1) The index (mcprating.io's shape): its own trust tier and safety cap win; safety, flags and the
//     start test come through; nothing makes up an install command; no key is ever sent.
//  2) The official MCP Registry ({servers:[{server}]}): the fallback when the index doesn't answer, and
//     a source of its own; entries are listed without a tier.
//  3) The settings migration: only the old localhost:3000 default, and only once.
//  4) stdio servers start with the SDK's safe environment plus their own `env`, not Surge's.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DEFAULT_MCP_INDEX,
  DiscoveryClient,
  McpManager,
  OFFICIAL_MCP_REGISTRY,
  connectConfigFor,
  deriveTrustTier,
  stdioServerEnv,
  type IndexServer,
  type SettingsPort,
} from '@surge/core';
import { migrateSettingsData, INDEX_URL_MIGRATED } from '../../../apps/desktop/src/main/services/settings-migrations';

const here = path.dirname(fileURLToPath(import.meta.url));
const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, extra?: string) => checks.push([name, ok, extra]);

const listen = (server: http.Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** A base URL nothing listens on. */
async function closedBase(): Promise<string> {
  const s = http.createServer();
  const base = await listen(s);
  await new Promise((r) => s.close(r));
  return base;
}

type Seen = { url: URL; headers: http.IncomingHttpHeaders };

// ── 1) A mock index with mcprating.io's /api/v1/servers shape ──
const INDEX_ITEMS = [
  { // reputable and safe: the API says trusted, and it passed the start test
    slug: 'premiere-pro-mcp', name: 'premiere-pro-mcp', description: 'Video editing tools', npmPackage: 'premiere-pro-mcp',
    installCommand: 'npx premiere-pro-mcp', accessMethod: 'npm', qualityScore: 93, isOfficial: false, isVerified: false,
    trustTier: 'trusted', safetyScore: 90, safetyBand: 'safe', safetyFlags: ['no-license'],
    repositoryUrl: 'git+https://github.com/example/premiere-pro-mcp.git', category: { name: 'Design & Creative', slug: 'design-creative' },
    verification: { latestOutcome: 'verified', lastAttemptedAt: '2026-10-18T12:38:01Z', lastVerifiedAt: '2026-10-18T12:38:01Z' },
    metadata: { verification: { tools: 12, outcome: 'verified' } },
  },
  { // official with a high score, so Surge's old rule said "verified"; the index caps it for safety
    slug: 'old-official', name: 'Old Official', description: 'Archived and abandoned', npmPackage: '@vendor/old', installCommand: 'npx -y @vendor/old',
    accessMethod: 'npm', qualityScore: 95, isOfficial: true, trustTier: 'community', safetyScore: 45, safetyBand: 'risk',
    safetyFlags: ['archived', 'abandoned'], verification: { latestOutcome: 'failed_to_start', lastAttemptedAt: '2026-11-01T00:00:00Z' },
  },
  { // the index's fourth tier is "unknown"
    slug: 'mystery', name: 'Mystery', description: 'Little known', installCommand: 'npx -y mystery-mcp', accessMethod: 'npm',
    qualityScore: 20, trustTier: 'unknown', safetyScore: 62, safetyBand: 'caution', safetyFlags: ['low-adoption', 'no-repository'], verification: null,
  },
  { // an older index without trustTier: Surge's estimate, capped by the safety score
    slug: 'legacy-risky', name: 'Legacy risky', description: '', installCommand: 'npx -y legacy-risky', qualityScore: 90, safetyScore: 25,
  },
  { slug: 'legacy-fine', name: 'Legacy fine', description: '', installCommand: 'npx -y legacy-fine', qualityScore: 90 },
  { // hosted only: no install command, the endpoint is in metadata.remotes
    slug: 'io-github-example-hosted', name: 'Hosted', description: 'A remote server', accessMethod: 'remote', installCommand: null, npmPackage: null,
    qualityScore: 80, trustTier: 'trusted', safetyScore: 92, safetyBand: 'safe', safetyFlags: [],
    metadata: { remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', isSecret: true }] }] },
    verification: { latestOutcome: 'needs_credentials', lastAttemptedAt: '2026-11-02T00:00:00Z' },
  },
  { // listed from GitHub with no way to run it: no command may be made up from the slug
    slug: 'io-github-someone-tool', name: 'someone/tool', description: 'Build it yourself', accessMethod: 'github-manual', installCommand: null,
    npmPackage: null, qualityScore: 55, trustTier: 'community', safetyScore: 85, safetyBand: 'safe', safetyFlags: [],
  },
  { // an npm package but no command: npx -y <package>
    slug: 'pkg-only', name: 'pkg only', description: '', npmPackage: '@scope/pkg-only', installCommand: null, qualityScore: 75, trustTier: 'trusted',
  },
];

const indexSeen: Seen[] = [];
let indexBroken = false;
const index = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  indexSeen.push({ url, headers: req.headers });
  if (indexBroken) return void res.writeHead(500).end('{"error":"down"}');
  if (url.pathname === '/api/v1/servers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ data: INDEX_ITEMS, total: 104791, limit: 24, offset: 0 }));
  }
  if (url.pathname === '/api/v1/categories') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ data: [{ name: 'Design & Creative', slug: 'design-creative', serverCount: 9 }] }));
  }
  res.writeHead(404).end();
});

// ── 2) A mock official registry with /v0/servers ──
const official = (name: string, server: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
  server: { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json', name, description: `${name} server`, version: '1.0.0', ...server },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, publishedAt: '2026-11-20T16:05:37Z', ...meta } },
});
const REGISTRY_ITEMS = [
  official('io.github.example/weather', { title: 'Weather', remotes: [{ type: 'streamable-http', url: 'https://weather.example.com/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }] }),
  official('io.github.example/files', { repository: { url: 'https://github.com/example/files', source: 'github' }, packages: [{ registryType: 'npm', identifier: '@scope/files', version: '1.2.3', runtimeHint: 'npx', transport: { type: 'stdio' }, environmentVariables: [{ name: 'ROOT', isRequired: true }] }] }),
  official('io.github.example/time', { packages: [{ registryType: 'pypi', identifier: 'time-server', version: '0.4.0', transport: { type: 'stdio' } }] }),
  official('io.github.example/container', { packages: [{ registryType: 'oci', identifier: 'ghcr.io/example/container:2.0', transport: { type: 'stdio' } }] }),
  official('com.example/tenant', { remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' }] }),
  official('io.github.example/old', { remotes: [{ type: 'sse', url: 'https://old.example.com/sse' }] }, { status: 'deprecated' }),
  official('io.github.example/files', { version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@scope/files', version: '1.0.0', transport: { type: 'stdio' } }] }, { isLatest: false }),
  official('io.github.example/weather', { title: 'Weather (dupe)', remotes: [{ type: 'sse', url: 'https://weather.example.com/sse' }] }),
];
const registrySeen: Seen[] = [];
const registry = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  registrySeen.push({ url, headers: req.headers });
  if (url.pathname === '/v0/servers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ servers: REGISTRY_ITEMS, metadata: { count: REGISTRY_ITEMS.length } }));
  }
  res.writeHead(404).end();
});

const indexBase = await listen(index);
const registryBase = await listen(registry);
const down = await closedBase();
const by = (list: IndexServer[], slug: string) => list.find((s) => s.slug === slug);

// 1) The index
{
  const client = new DiscoveryClient(indexBase, { registryUrl: registryBase });
  const res = await client.listServers({ search: 'video', limit: 24 });
  check('the index answers: every listing comes from it', res.from.kind === 'index' && res.from.url === indexBase && !res.from.fallback && res.servers.length === INDEX_ITEMS.length,
    JSON.stringify(res.from));
  check("the index's total is kept", res.total === 104791);
  const s = res.servers;
  const trusted = by(s, 'premiere-pro-mcp')!;
  check("the index's own tier is used, marked as the source's", trusted.trustTier === 'trusted' && trusted.tierBasis === 'source');
  check('safety score, band and flags come through', trusted.safetyScore === 90 && trusted.safetyBand === 'safe' && trusted.safetyFlags?.join() === 'no-license');
  check('the start test comes through: outcome, when, tools listed',
    trusted.startTest?.outcome === 'verified' && trusted.startTest.at === '2026-10-18T12:38:01Z' && trusted.startTest.tools === 12, JSON.stringify(trusted.startTest));
  const capped = by(s, 'old-official')!;
  check("Surge's old rule would call the capped server verified", deriveTrustTier({ isOfficial: true, qualityScore: 95 }) === 'verified');
  check('a server the index caps for safety is not shown as trusted or verified', capped.trustTier === 'community' && capped.safetyBand === 'risk',
    `${capped.trustTier} / ${capped.safetyBand}`);
  check('a failed start test is kept', capped.startTest?.outcome === 'failed_to_start');
  const mystery = by(s, 'mystery')!;
  check("the index's 'unknown' tier shows as unverified", mystery.trustTier === 'unverified' && mystery.tierBasis === 'source' && mystery.startTest === null);
  check("without the index's tier, Surge's estimate is capped by the safety score",
    by(s, 'legacy-risky')!.trustTier === 'unverified' && by(s, 'legacy-risky')!.tierBasis === 'surge'
      && by(s, 'legacy-fine')!.trustTier === 'trusted' && by(s, 'legacy-fine')!.tierBasis === 'surge');
  check('a safety score with no band gets one from the same thresholds', by(s, 'legacy-risky')!.safetyBand === 'risk');

  const npm = connectConfigFor(trusted);
  check("an npm listing connects with the index's own command", npm?.transport === 'stdio' && npm.command === 'npx' && npm.args?.join(' ') === 'premiere-pro-mcp');
  const hosted = by(s, 'io-github-example-hosted')!;
  const hostedConnect = connectConfigFor(hosted);
  check('a hosted listing connects to its endpoint, not npx', hostedConnect?.transport === 'streamable-http' && hostedConnect.url === 'https://mcp.example.com/mcp' && !hostedConnect.command,
    JSON.stringify(hostedConnect));
  check('an endpoint that takes an Authorization header needs a sign-in', hosted.requiresAuth === true);
  const manual = by(s, 'io-github-someone-tool')!;
  check('a listing with no command or endpoint gets no Connect (no `npx -y <slug>`)', manual.installCommand === null && connectConfigFor(manual) === null,
    JSON.stringify({ installCommand: manual.installCommand, connect: connectConfigFor(manual) }));
  check('an npm package without a command runs as npx -y <package>', by(s, 'pkg-only')!.installCommand === 'npx -y @scope/pkg-only');

  const cats = await client.listCategories();
  check('categories come from the index', cats.length === 1 && cats[0].slug === 'design-creative');
  const q = indexSeen[0].url.searchParams;
  check('the query reaches the index', indexSeen[0].url.pathname === '/api/v1/servers' && q.get('search') === 'video' && q.get('sortBy') === 'quality');
  check('the default client and index answer without a fallback request', registrySeen.length === 0);
}

// 2) The official registry
{
  const client = new DiscoveryClient(down, { registryUrl: registryBase });
  const res = await client.listServers({ search: 'weather', limit: 24 });
  check("an index that doesn't answer falls back to the registry, and says so",
    res.from.kind === 'registry' && res.from.fallback === true && res.from.failed === down && res.from.url === registryBase, JSON.stringify(res.from));
  const rq = registrySeen.at(-1)!.url;
  check('the registry is asked for latest versions only, with the search', rq.pathname === '/v0/servers' && rq.searchParams.get('version') === 'latest' && rq.searchParams.get('search') === 'weather',
    rq.toString());
  const s = res.servers;
  check('deprecated, older and duplicate entries are dropped', s.length === 5 && !by(s, 'io-github-example-old') && s.filter((x) => x.slug === 'io-github-example-weather').length === 1,
    s.map((x) => x.slug).join());
  const weather = by(s, 'io-github-example-weather')!;
  check('a registry name becomes an id-safe slug; the title is the name shown', weather.id === 'io-github-example-weather' && weather.name === 'Weather');
  check('registry entries carry no tier, score, safety or start test (it rates nothing)',
    s.every((x) => x.trustTier === undefined && x.qualityScore === null && x.safetyScore == null && x.startTest === null && x.source === 'mcp-registry'));
  const wc = connectConfigFor(weather);
  check("a remote entry connects to its endpoint, and a required header means sign-in",
    wc?.transport === 'streamable-http' && wc.url === 'https://weather.example.com/mcp' && weather.requiresAuth === true);
  check('an npm package runs pinned to the listed version', by(s, 'io-github-example-files')!.installCommand === 'npx -y @scope/files@1.2.3'
    && by(s, 'io-github-example-files')!.repositoryUrl === 'https://github.com/example/files');
  check('a pypi package runs with uvx', by(s, 'io-github-example-time')!.installCommand === 'uvx time-server');
  const container = by(s, 'io-github-example-container')!;
  check('an oci-only entry gets no command Surge would run', container.installCommand === null && connectConfigFor(container) === null);
  const tenant = by(s, 'com-example-tenant')!;
  check('an endpoint that is a template is not connected to', tenant.remoteUrl === null && connectConfigFor(tenant) === null);

  indexBroken = true;
  const broken = await new DiscoveryClient(indexBase, { registryUrl: registryBase }).listServers({});
  indexBroken = false;
  check('an index answering 500 falls back too', broken.from.kind === 'registry' && broken.from.fallback === true && broken.servers.length === 5);

  const before = indexSeen.length;
  const only = await new DiscoveryClient('', { registryUrl: registryBase }).listServers({});
  check('an empty source means the registry alone (not a fallback)', only.from.kind === 'registry' && !only.from.fallback && only.servers.length === 5);
  const direct = new DiscoveryClient(`${registryBase}/v0`, { registryUrl: 'http://127.0.0.1:9/unused' });
  const viaPath = await direct.listServers({ search: 'files' });
  check('a source pointing at a /v0 registry is read as a registry', viaPath.from.kind === 'registry' && !viaPath.from.fallback && viaPath.servers.length === 5,
    JSON.stringify(viaPath.from));
  check('index-only calls ask nothing of a registry source', (await direct.getServer('x')) === null && (await direct.listCategories()).length === 0 && indexSeen.length === before);
  check('the official registry is recognized by its host', new URL(OFFICIAL_MCP_REGISTRY).hostname === 'registry.modelcontextprotocol.io');

  const filtered = await new DiscoveryClient('', { registryUrl: registryBase }).listServers({ category: 'design-creative', isOfficial: true });
  check("filters the registry can't apply give no results and a note, not mismatched results",
    filtered.servers.length === 0 && /category/.test(filtered.from.note || '') && /official/.test(filtered.from.note || ''), filtered.from.note);
  const none = await new DiscoveryClient(down, { registryUrl: await closedBase() }).listServers({});
  check('when nothing answers, the result says so', none.from.kind === 'none' && none.servers.length === 0 && none.from.failed === down);

  // McpManager.discoverServers (IPC mcp:discover) goes through the same client.
  const store: Record<string, any> = { 'mcp.indexUrl': down, 'mcp.registryUrl': registryBase };
  const settings: SettingsPort = { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getMaxConnections: () => 10 };
  const viaManager = await new McpManager(settings).discoverServers('weather');
  check('McpManager.discoverServers falls back to the registry too', viaManager.length === 5 && viaManager.every((x) => x.source === 'mcp-registry' && typeof x.hasDiscovery === 'boolean'));
  store['mcp.indexUrl'] = indexBase;
  const fromIndex = await new McpManager(settings).discoverServers('video');
  check('McpManager.discoverServers reads the index with its tiers', fromIndex.find((x) => x.slug === 'old-official')?.trustTier === 'community');
}

const allSeen = [...indexSeen, ...registrySeen];
check('no request to either source carries a partner key, API key or authorization',
  allSeen.length >= 8 && allSeen.every((r) => !r.headers['x-partner-key'] && !r.headers['x-api-key'] && !r.headers.authorization
    && ![...r.url.searchParams.keys()].some((k) => /partner|key|token/i.test(k))));
check('the defaults are mcprating.io and the official MCP Registry', DEFAULT_MCP_INDEX === 'https://mcprating.io' && OFFICIAL_MCP_REGISTRY === 'https://registry.modelcontextprotocol.io');
index.close();
registry.close();

// 3) Settings migration (desktop): only the old default, only once
{
  const legacy: Record<string, any> = { 'mcp.indexUrl': 'http://localhost:3000', 'ui.theme': 'light' };
  check('the old localhost:3000 default is dropped, so the new default applies', migrateSettingsData(legacy) && !('mcp.indexUrl' in legacy) && legacy[INDEX_URL_MIGRATED] === true && legacy['ui.theme'] === 'light');
  const slash: Record<string, any> = { 'mcp.indexUrl': 'http://localhost:3000/' };
  migrateSettingsData(slash);
  check('with a trailing slash too', !('mcp.indexUrl' in slash));
  const own: Record<string, any> = { 'mcp.indexUrl': 'https://index.example.org' };
  check("the user's own source stays", migrateSettingsData(own) && own['mcp.indexUrl'] === 'https://index.example.org');
  const empty: Record<string, any> = { 'mcp.indexUrl': '' };
  migrateSettingsData(empty);
  check("an empty source (the registry alone) stays", empty['mcp.indexUrl'] === '');
  legacy['mcp.indexUrl'] = 'http://localhost:3000'; // chosen deliberately later, in Settings
  check('once migrated, a deliberate localhost:3000 is left alone', !migrateSettingsData(legacy) && legacy['mcp.indexUrl'] === 'http://localhost:3000');
}

// 4) The stdio environment
{
  process.env.FAKE_SECRET = 'leak-me-123';
  process.env.SURGE_FAKE_API_KEY = 'sk-test-not-real';
  const allowed = new Set([...DEFAULT_INHERITED_ENV_VARS, 'SURGE_TEST_VAR'].map((k) => k.toUpperCase()));
  // On Windows, libuv adds the variables a process can't run without when the env block lacks them
  // (uv_spawn's required_vars); none of them is a secret.
  const libuv = new Set(process.platform === 'win32' ? ['LOGONSERVER', 'USERDOMAIN', 'WINDIR', 'SYSTEMDRIVE', 'SYSTEMROOT', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'USERNAME', 'USERPROFILE', 'PATH'] : []);
  const plain = stdioServerEnv({ env: { SURGE_TEST_VAR: 'from-config' } });
  check('stdioServerEnv: the safe list plus the server env, nothing planted',
    !('FAKE_SECRET' in plain) && !('SURGE_FAKE_API_KEY' in plain) && plain.SURGE_TEST_VAR === 'from-config' && Object.keys(plain).every((k) => allowed.has(k.toUpperCase())));
  check('stdioServerEnv keeps PATH', !!plain.PATH);

  const store: Record<string, any> = { 'mcp.autoReconnect': true };
  const settings: SettingsPort = { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getMaxConnections: () => 10 };
  const mcp = new McpManager(settings);
  const fixture = path.join(here, 'fixtures', 'env-echo-server.mjs');
  const config = { id: 'env-echo', name: 'env echo', transport: 'stdio' as const, command: process.execPath, args: [fixture], env: { SURGE_TEST_VAR: 'from-config' } };
  const envOf = async (m: McpManager) => JSON.parse((await m.callTool('env-echo', 'env', {})).content[0].text) as Record<string, string>;
  try {
    await mcp.connectServer(config);
    const env = await envOf(mcp);
    const keys = Object.keys(env);
    check('a planted FAKE_SECRET does not reach a stdio server', !('FAKE_SECRET' in env) && !('SURGE_FAKE_API_KEY' in env) && !keys.some((k) => /^FAKE_SECRET$/i.test(k)));
    check("the server's own env does", env.SURGE_TEST_VAR === 'from-config');
    check('PATH does (so npx and uvx resolve)', keys.some((k) => k.toUpperCase() === 'PATH' && !!env[k]));
    const extra = keys.filter((k) => !allowed.has(k.toUpperCase()) && !libuv.has(k.toUpperCase()));
    check("nothing outside the SDK's safe list, the server's env and what the OS adds", extra.length === 0, `extra: ${extra.join(', ')}`);

    // Saved servers: a later start (here a second manager on the same settings) reconnects them.
    const saved = (store['mcp.savedServers'] || []).find((c: any) => c.id === 'env-echo');
    check('the server was saved with its env', saved?.env?.SURGE_TEST_VAR === 'from-config');
    const again = new McpManager(settings);
    await again.reconnectSaved();
    const env2 = await envOf(again);
    check('a saved server still starts, with the same scoped env', env2.SURGE_TEST_VAR === 'from-config' && !('FAKE_SECRET' in env2));
    await again.disconnectServer('env-echo');
    await mcp.disconnectServer('env-echo');
  } catch (err: any) {
    check('the env fixture server starts', false, err?.message);
  }

  // The standalone bookmarks server (built by scripts/test.mjs) still starts; its DB path now has to
  // come from its own env, since Surge's environment isn't passed through.
  const dist = path.resolve(here, '../../../servers/bookmarks-history-mcp/dist/stdio.js');
  if (!fs.existsSync(dist)) {
    check('the bookmarks server is built (run `pnpm test`, which builds it)', false, dist);
  } else {
    const db = path.join(os.tmpdir(), `surge-discovery-env-${Date.now()}.db`);
    const bm = new McpManager({ get: () => undefined, set: () => {}, getMaxConnections: () => 10 });
    try {
      const server = await bm.connectServer({ id: 'bookmarks-stdio', name: 'bookmarks', transport: 'stdio', command: process.execPath, args: [dist], env: { SURGE_DB_PATH: db } });
      const added = await bm.callTool('bookmarks-stdio', 'bookmark_add', { url: 'https://example.com', title: 'Example' });
      const listed = await bm.callTool('bookmarks-stdio', 'bookmark_list', {});
      check('the bookmarks stdio server starts and works', server.tools.some((t) => t.name === 'bookmark_add') && !added.isError && /example\.com/.test(listed.content[0].text),
        listed.content?.[0]?.text?.slice(0, 120));
      check('its SURGE_DB_PATH came from the server env', fs.existsSync(db));
      await bm.disconnectServer('bookmarks-stdio');
    } catch (err: any) {
      check('the bookmarks stdio server starts', false, err?.message);
    }
    for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
  }
  delete process.env.FAKE_SECRET;
  delete process.env.SURGE_FAKE_API_KEY;
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n❌ DISCOVERY VERIFY FAILED (${failed})` : `\n✅ DISCOVERY VERIFY PASSED (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
