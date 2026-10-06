#!/usr/bin/env node
// Launch-kit capture: drives the real, built Surge desktop app over the Chrome DevTools Protocol
// and writes the demo and the stills to docs/launch-kit/media/. Nothing is staged: the registry,
// the OpenNodes nodes, their signed receipts and the local Ollama answers are all live.
//
//   pnpm --filter @surge/desktop build
//   node scripts/launch-kit/capture.mjs            # demo (GIF + MP4) and stills
//   node scripts/launch-kit/capture.mjs --stills   # stills only
//   node scripts/launch-kit/capture.mjs --demo     # demo only
//
// Needs Node >= 22 (global WebSocket), ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg), network access,
// and a local Ollama for the private-mode scenes (skipped when it isn't running). The app runs in
// a throwaway --user-data-dir, so your own settings, keys and history are never touched.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP = path.join(ROOT, 'apps/desktop');
const OUT = path.join(ROOT, 'docs/launch-kit/media');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const PORT = Number(process.env.CDP_PORT || 9334);
const flags = new Set(process.argv.slice(2));
const WANT_DEMO = !flags.has('--stills');
const WANT_STILLS = !flags.has('--demo');
const WAIT_MAX_S = 1.4;   // a model wait is compressed to at most this in the demo
const HOLD_END_S = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hover state follows the real mouse pointer if it happens to rest over the window (a chart
// tooltip in the middle of a scene); a synthetic move to the corner clears it.
const park = (target) => target.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }).catch(() => {});
const log = (...a) => console.log('[kit]', ...a);

// ── CDP ────────────────────────────────────────────────────────────
class Cdp {
  static async connect(match, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const t = targets.find((x) => x.type === 'page' && match(x.url));
        if (t) return await new Cdp(t.webSocketDebuggerUrl).open();
      } catch { /* app still starting */ }
      await sleep(300);
    }
    throw new Error('DevTools target not found');
  }

  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map(); this.handlers = new Map(); }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: ok, reject: fail } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? fail(new Error(m.error.message)) : ok(m.result);
        } else if (m.method) {
          for (const fn of this.handlers.get(m.method) ?? []) fn(m.params);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) { this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]); }

  // The promise is held on window: an unreferenced one can be garbage-collected mid-await
  // ("Promise was collected"), which long UI steps would otherwise hit.
  async eval(expression) {
    const held = `(window.__kitHeld = (async () => (${expression}))())`;
    const r = await this.send('Runtime.evaluate', { expression: held, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  // Long waits (model replies take minutes on CPU nodes) poll a cheap check from here instead.
  async waitFor(check, timeoutMs = 300_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.eval(check)) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for: ${check}`);
  }

  close() { this.ws?.close(); }
}

const replyAfter = (n) => `!document.querySelector('.cursor-blink') && __kit.replies() > ${n}`;

// Helpers injected into the renderer: they act through the real UI (clicks, typing, tabs).
const PAGE_HELPERS = String.raw`window.__kit = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text)); },
  input() { return document.querySelector('input[placeholder*="Ask anything"], input[placeholder*="conversation"]'); },
  async type(text, perChar = 32) {
    const el = this.input();
    el.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (let i = 1; i <= text.length; i++) {
      set.call(el, text.slice(0, i));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await this.sleep(perChar);
    }
    await this.sleep(300);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  },
  async openPicker(level) {
    if (!document.querySelector('.model-dropdown')) document.querySelector('.model-btn').click();
    await this.sleep(900);
    if (level) { this.byText('.model-level-header', level)?.click(); await this.sleep(600); }
  },
  async pick(name) { this.byText('.model-option', name).click(); await this.sleep(500); },
  async settings(tab) {
    if (!document.querySelector('.settings-panel')) { document.querySelector('button[title="Settings"]').click(); await this.sleep(700); }
    this.byText('.settings-tab', tab).click();
    await this.sleep(700);
  },
  async closeSettings() { document.querySelector('.settings-header .btn-icon')?.click(); await this.sleep(600); },
  async newChat() { document.querySelector('button[title="New Chat"]')?.click(); await this.sleep(600); },
  replies() { return document.querySelectorAll('.chat-message.assistant:not(.streaming)').length; },
  theme(t) { t === 'light' ? document.documentElement.setAttribute('data-theme', 'light') : document.documentElement.removeAttribute('data-theme'); },
}`; // an expression: Cdp.eval wraps it

// ── app lifecycle ──────────────────────────────────────────────────
function launchApp() {
  const electron = createRequire(path.join(DESKTOP, 'package.json'))('electron');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-kit-'));
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { cwd: DESKTOP, stdio: 'ignore' });
  return { child, profile };
}

async function quitApp({ child, profile }) {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = await new Cdp(webSocketDebuggerUrl).open();
    browser.send('Browser.close').catch(() => {});
    await sleep(1500);
  } catch { /* already gone */ }
  child.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}

const ollamaUp = async () => {
  try { return (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
};

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

// ── recording ──────────────────────────────────────────────────────
// Screencast frames arrive only when pixels change, but animations (the typing indicator) make
// many, and they queue behind acks: a frame can arrive seconds after it was drawn. So each frame
// is placed by its own render timestamp, moved onto Date.now()'s clock (which the wait marks use)
// by the smallest observed delivery delay, and the backlog is drained before stopping. Waits for a
// model are marked so the assembly can compress them; everything else plays in real time.
async function record(app, scenes) {
  const frames = [];
  const waits = [];
  app.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, drawn: f.metadata.timestamp, arrived: Date.now() / 1000 });
    app.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await app.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 2 });
  const wait = async (fn) => {
    const start = Date.now() / 1000;
    await fn();
    waits.push([start, Date.now() / 1000]);
  };
  await scenes(wait);
  await sleep(HOLD_END_S * 1000);
  const end = Date.now() / 1000;
  // The end state, captured directly, so it shows even if the screencast had nothing new to send.
  const { data } = await app.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  const offset = () => Math.min(...frames.filter((x) => x.drawn).map((x) => x.arrived - x.drawn));
  for (let i = 0; i < 40 && frames.length && frames.at(-1).drawn + offset() < end; i++) await sleep(250);
  await app.send('Page.stopScreencast');
  const shift = frames.some((x) => x.drawn) ? offset() : 0;
  const placed = frames
    .map((x) => ({ data: x.data, t: x.drawn ? x.drawn + shift : x.arrived }))
    .filter((x) => x.t < end - 0.05)
    .sort((a, b) => a.t - b.t);
  placed.push({ data, t: end - 0.05 });
  return { frames: placed, waits, end };
}

// Map recorded time onto the compressed timeline: every marked wait lasts at most WAIT_MAX_S.
function compressor(waits) {
  return (t) => {
    let shift = 0;
    for (const [a, b] of waits) {
      const span = b - a;
      if (span <= WAIT_MAX_S || t <= a) continue;
      if (t >= b) shift += span - WAIT_MAX_S;
      else return t - shift - (t - a) + ((t - a) / span) * WAIT_MAX_S;
    }
    return t - shift;
  };
}

function assemble({ frames, waits, end }) {
  if (frames.length < 2) throw new Error('no frames recorded');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-kit-frames-'));
  const map = compressor(waits);
  const lines = [];
  let last = null;
  frames.forEach((f, i) => {
    const t0 = map(f.t);
    const t1 = map(i + 1 < frames.length ? frames[i + 1].t : end);
    const dur = t1 - t0;
    if (dur < 0.005) return; // superseded within the same instant
    const file = path.join(tmp, `f${String(i).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    lines.push(`file '${file.replace(/\\/g, '/')}'`, `duration ${dur.toFixed(3)}`);
    last = file;
  });
  lines.push(`file '${last.replace(/\\/g, '/')}'`); // concat demuxer: repeat the last frame so its duration counts
  const list = path.join(tmp, 'frames.txt');
  fs.writeFileSync(list, lines.join('\n'));
  // The launcher bar (680x160) is padded, never upscaled, into the 900x700 frame of the expanded window.
  const fit = "scale='min(900,iw)':'min(700,ih)':force_original_aspect_ratio=decrease,pad=900:700:(ow-iw)/2:(oh-ih)/2:color=0x0a0e1a";
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `${fit},fps=30,format=yuv420p`, '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', path.join(OUT, 'surge-demo.mp4')]);
  // The GIF is made from the MP4: fed the variable-duration concat directly, the GIF path dropped
  // repeated frames without lengthening the previous one and played every hold too short.
  ffmpeg(['-i', path.join(OUT, 'surge-demo.mp4'), '-vf',
    'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    path.join(OUT, 'surge-demo.gif')]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── stills ─────────────────────────────────────────────────────────
async function shoot(target, file) {
  await park(target);
  const { w, h } = await target.eval('({ w: innerWidth, h: innerHeight })');
  await target.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const { data } = await target.send('Page.captureScreenshot', { format: 'png' });
  await target.send('Emulation.clearDeviceMetricsOverride');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

// Dark and light, at 2x. With `web`, the embedded browser view (right of the 400px app view) is
// captured too and the two are stitched into the window as it appears on screen.
async function still(app, name, web = null) {
  for (const theme of ['dark', 'light']) {
    await app.eval(`__kit.theme('${theme}')`);
    await sleep(500);
    const file = path.join(OUT, `${name}-${theme}.png`);
    if (!web) { await shoot(app, file); continue; }
    const left = `${file}.left.png`;
    const right = `${file}.right.png`;
    await shoot(app, left);
    await shoot(web, right);
    ffmpeg(['-i', left, '-i', right, '-filter_complex', 'hstack=inputs=2', file]);
    fs.rmSync(left);
    fs.rmSync(right);
  }
  await app.eval(`__kit.theme('dark')`);
  log('still', name);
}

// ── the run ────────────────────────────────────────────────────────
const AUTO_PROMPT = 'In two sentences: what does a signed usage receipt prove to the person who paid?';
const PRIVATE_PROMPT = 'Summarize privately in one sentence: our Q3 revenue grew 12% and churn fell to 3%.';
const PAGE_PROMPT = 'In one sentence, what does this page say OpenNodes is?';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const proc = launchApp();
  let app;
  try {
    app = await Cdp.connect((u) => u.includes('renderer/index.html'));
    await app.send('Page.enable');
    await app.eval(PAGE_HELPERS);
    await app.waitFor(`window.surge.ai.getModels().then((m) => m.some((x) => x.id === 'onp:auto'))`, 60_000);
    await sleep(1200);
    const privateOk = await ollamaUp();
    if (!privateOk) log('no local Ollama on :11434 — private-mode scenes are skipped');

    if (WANT_DEMO) {
      log('recording the demo…');
      const rec = await record(app, async (wait) => {
        await park(app);
        await app.eval(`__kit.openPicker('Smart')`);
        await sleep(2200);
        await app.eval(`__kit.pick('Auto (OpenNodes')`);
        await app.eval(`__kit.type(${JSON.stringify(AUTO_PROMPT)})`);
        await wait(() => app.waitFor(replyAfter(0)));
        await sleep(3500);
        await park(app); // a resize re-sends the real pointer position: park right before the chart renders
        await app.eval(`__kit.settings('Spend')`);
        await park(app);
        await sleep(3500);
        await app.eval(`__kit.closeSettings()`);
        if (privateOk) {
          await app.eval(`document.querySelector('.private-btn').click(), true`);
          await app.waitFor(`!!document.querySelector('.private-btn.active') && document.querySelector('.model-btn').textContent.includes('Auto (private)')`, 30_000);
          await sleep(1500);
          const before = await app.eval(`__kit.replies()`);
          await app.eval(`__kit.type(${JSON.stringify(PRIVATE_PROMPT)})`);
          await wait(() => app.waitFor(replyAfter(before)));
          await sleep(1000);
        }
      });
      assemble(rec);
      log('demo written:', rec.frames.length, 'frames');
    }

    if (WANT_STILLS) {
      log('stills…');
      if (privateOk) {
        if (!(await app.eval(`!!document.querySelector('.private-btn.active')`))) {
          await app.eval(`document.querySelector('.private-btn').click(), true`);
          await app.waitFor(`document.querySelector('.model-btn').textContent.includes('Auto (private)')`, 30_000);
          const before = await app.eval(`__kit.replies()`);
          await app.eval(`__kit.type(${JSON.stringify(PRIVATE_PROMPT)})`);
          await app.waitFor(replyAfter(before));
        }
        await still(app, 'surge-private');
        await app.eval(`document.querySelector('.private-btn').click(), true`);
        await app.waitFor(`!document.querySelector('.private-btn.active')`, 30_000);
        await sleep(2500);
      }

      // Hero: a page in the embedded browser, read with an MCP tool, answered by an OpenNodes node
      // the advisor picked, with its verified receipt under the reply.
      await app.eval(`__kit.newChat()`);
      await app.eval(`window.surge.window.resize('expanded'), true`);
      await sleep(800);
      await app.eval(`__kit.openPicker('Smart').then(() => __kit.pick('Auto (OpenNodes'))`);
      await app.eval(`__kit.type('opennodes.io')`);
      await sleep(7000);
      await app.eval(`__kit.type(${JSON.stringify(PAGE_PROMPT)})`);
      await app.waitFor(replyAfter(0));
      await app.eval(`[...document.querySelectorAll('.chat-message.user')].pop().scrollIntoView({ block: 'start' }), true`);
      await sleep(1500);
      const web = await Cdp.connect((u) => u.startsWith('https://opennodes.io'), 10_000);
      await still(app, 'surge-browser-receipt', web);
      web.close();

      await app.eval(`window.surge.browser.hide(), true`);
      await app.eval(`__kit.settings('Spend')`);
      await still(app, 'surge-spend');
      await app.eval(`__kit.settings('Advanced')`);
      await app.eval(`__kit.byText('.api-key-group', 'Spend policy').scrollIntoView({ block: 'start' }), true`);
      await sleep(400);
      await still(app, 'surge-policy-keys');
      await app.eval(`__kit.closeSettings()`);

      await app.eval(`__kit.newChat()`);
      await app.eval(`window.surge.window.resize('expanded'), true`);
      await sleep(1000);
      await app.eval(`__kit.openPicker('Smart')`);
      await sleep(600);
      await still(app, 'surge-picker');
    }
  } finally {
    app?.close();
    await quitApp(proc);
  }
  log('done →', path.relative(ROOT, OUT));
}

main().catch((err) => { console.error('[kit]', err); process.exit(1); });
