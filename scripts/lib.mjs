// Shared plumbing: find a browser, serve a folder, drive a page over the DevTools protocol.
// No npm packages: Node 22+ (global WebSocket) and a local Chromium-family browser are enough.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export function findBrowser() {
  const fromEnv = process.env.MOTION_CHROME;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const home = os.homedir();
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome, Chromium, Edge or Brave found. Set MOTION_CHROME to the browser executable.');
}

export function projectDir(args, tool) {
  const dir = args[0];
  if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`usage: node ${tool} <project-dir> ...   (needs <project-dir>/index.html)`);
    process.exit(2);
  }
  return dir;
}

export function serveDir(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    if (rel === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, '.' + rel);
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}

async function waitForPortFile(dir, timeoutMs) {
  const file = path.join(dir, 'DevToolsActivePort');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Browser did not start in time.');
}

export async function launch() {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22 or newer is required (global WebSocket).');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'open-motion-'));
  const proc = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', '--window-size=1920,1080',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  const ws = new WebSocket(await waitForPortFile(profile, 20000));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`)); else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const close = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const exited = new Promise((r) => proc.once('exit', r));
    // The browser may drop the socket before answering Browser.close, so never wait on the reply alone.
    await Promise.race([send('Browser.close').catch(() => {}), wait(2000)]);
    try { ws.close(); } catch { /* ignore */ }
    await Promise.race([exited, wait(3000)]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    // The browser can still be flushing its profile for a moment after exit.
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await wait(200); }
    }
  };
  return { send, on: (fn) => listeners.push(fn), close };
}

// Opens `url`, waits for load, fonts and an optional window.ready promise, then sizes the viewport
// to window.SIZE (default 1920x1080). Returns page helpers.
export async function openPage(browser, url, size) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  let loaded;
  const loadPromise = new Promise((r) => { loaded = r; });
  browser.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Page.loadEventFired') loaded();
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`${d.exception?.description || d.text} (line ${d.lineNumber})`.slice(0, 400));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`.slice(0, 400));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 400));
    }
  });
  const setSize = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await setSize(size?.width || 1920, size?.height || 1080);
  await send('Page.navigate', { url });
  await Promise.race([loadPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('Page load timed out after 60 s')), 60000))]);

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed').slice(0, 600));
    return r.result.value;
  };
  const info = await evaluate(`(async () => {
    if (window.ready && typeof window.ready.then === 'function') await window.ready;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const s = Array.isArray(window.SIZE) ? window.SIZE : [1920, 1080];
    return { hasSeek: typeof window.seek === 'function', duration: Number(window.DURATION), fps: Number(window.FPS) || 30,
             width: Number(s[0]) || 1920, height: Number(s[1]) || 1080, hasContent: window.CONTENT != null && typeof window.CONTENT === 'object' };
  })()`);
  if (!size) await setSize(info.width, info.height);
  const seek = (t) => evaluate(`(async () => {
    await window.seek(${t});
    await new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } };
      requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 120); });
  })()`);
  const screenshot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
  return { info, errors, evaluate, seek, screenshot, send };
}

export function checkContract(info) {
  const problems = [];
  if (!info.hasSeek) problems.push('window.seek(t) is not defined');
  if (!(info.duration > 0)) problems.push('window.DURATION must be a positive number of seconds');
  if (info.width % 2 || info.height % 2) problems.push('window.SIZE must use even numbers (H.264 needs them)');
  return problems;
}
