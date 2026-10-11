#!/usr/bin/env node
// Check an animation with measurements, because Claude cannot watch it. Exit code 1 if any check fails.
//   node scripts/check.mjs <project-dir>
// Writes <project-dir>/out/check.json.
//
// Checks
//   contract  index.html defines window.DURATION and window.seek(t)
//   page      no script errors, no files that failed to load
//   pure      asking for the same time twice gives the same frame (nothing runs on its own clock)
//   content   content.json exists and every word on screen comes from it (or from a file in data/),
//             so one edit there is one change on screen
//   cut-off   no resting text is cut by the frame edge or by a clipping box
//   small     resting text is readable on a phone (390 px wide): fail under 5.5 px, warn under 8 px
//   video     out/video.mp4, if rendered: right length and size, no blank frames, no long freeze
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch, openPage, serveDir, checkContract, projectDir } from './lib.mjs';

const dir = projectDir(process.argv.slice(2), 'scripts/check.mjs');
const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const short = (s) => (s.length > 44 ? s.slice(0, 43) + '…' : s);

// Runs in the page: every visible piece of text with its box, size and whether something cuts it.
const COLLECT = `(() => {
  const W = innerWidth, H = innerHeight, items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = n.nodeValue.replace(/\\s+/g, ' ').trim();
    const el = n.parentElement;
    if (!text || !el || el.closest('script,style,noscript,template,title,desc')) continue;
    let opacity = 1, shown = true;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') { shown = false; break; }
      opacity *= parseFloat(cs.opacity);
    }
    if (!shown || opacity < 0.05) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const b = range.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    if (b.right <= 0 || b.bottom <= 0 || b.left >= W || b.top >= H) continue;      // fully off stage
    let scale = 1;
    if (typeof el.getScreenCTM === 'function') { const m = el.getScreenCTM(); if (m) scale = Math.hypot(m.a, m.b); }
    else if (el.offsetWidth) scale = el.getBoundingClientRect().width / el.offsetWidth;
    const font = parseFloat(getComputedStyle(el).fontSize) * (scale || 1);
    const slack = font * 0.24 + 2;       // a text box is taller than its letters: allow the empty part to stick out
    let cut = (b.left < -2 || b.top < -slack || b.right > W + 2 || b.bottom > H + slack) ? 'the frame edge' : '';
    for (let e = el; !cut && e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (!/hidden|clip/.test(cs.overflowX + cs.overflowY)) continue;
      const c = e.getBoundingClientRect();
      const inside = b.right > c.left && b.left < c.right && b.bottom > c.top && b.top < c.bottom;
      if (!inside) { cut = 'hidden'; break; }                                        // masked out on purpose
      if (b.left < c.left - 2 || b.right > c.right + 2 || b.top < c.top - slack || b.bottom > c.bottom + slack) cut = 'a clipping box';
    }
    if (cut === 'hidden') continue;
    items.push({ text: text.slice(0, 120), x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
                 font, opacity, cut });
  }
  return items;
})()`;

// Share of pixels that differ by more than 3 levels between two PNGs. The renderer's own noise is 1 level.
function changedShare(pngA, pngB) {
  const raw = (png) => spawnSync('ffmpeg', ['-v', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input: png, maxBuffer: 1 << 28 }).stdout || Buffer.alloc(0);
  const x = raw(pngA), y = raw(pngB);
  if (!x.length || x.length !== y.length) return 1;
  let n = 0;
  for (let i = 0; i < x.length; i += 3) if (Math.abs(x[i] - y[i]) > 3 || Math.abs(x[i + 1] - y[i + 1]) > 3 || Math.abs(x[i + 2] - y[i + 2]) > 3) n++;
  return n / (x.length / 3);
}

const wordsOf = (s) => (String(s).toLowerCase().match(/\p{L}{3,}/gu) || []);
function collectValues(v, bag) {
  if (v == null) return;
  if (typeof v === 'object') { for (const x of Object.values(v)) collectValues(x, bag); return; }
  for (const w of wordsOf(v)) bag.add(w);
}

const server = await serveDir(dir);
const browser = await launch();
try {
  const page = await openPage(browser, `http://127.0.0.1:${server.port}/index.html`);
  const { duration: D, fps, width, height } = page.info;
  const problems = checkContract(page.info);
  if (problems.length) add('FAIL', 'contract', problems.join('; '));
  else add('PASS', 'contract', `seek(t), ${D} s, ${fps} fps, ${width}x${height}`);

  if (!problems.length) {
    // pure: three times, each asked twice with the other times in between
    const times = [D * 0.31, D * 0.62, D * 0.87], first = [];
    for (const t of times) { await page.seek(t); first.push(await page.screenshot()); }
    let worst = 0, worstAt = 0;
    for (let k = times.length - 1; k >= 0; k--) {
      await page.seek(times[k]);
      const again = await page.screenshot();
      const share = first[k].equals(again) ? 0 : changedShare(first[k], again);
      if (share > worst) { worst = share; worstAt = times[k]; }
    }
    if (worst < 0.0005) add('PASS', 'pure', 'same frame when asked twice');
    else add('FAIL', 'pure', `${(worst * 100).toFixed(2)}% of the picture at ${worstAt.toFixed(2)} s changes between two requests: something runs on its own clock (CSS animation, timer, Date.now, unseeded random)`);

    // sample the timeline; text that sits in the same place 0.25 s later counts as resting
    const N = 16, step = 0.25, samples = [];
    for (let i = 0; i < N; i++) {
      const t = Number((0.3 + (Math.max(0.6, D - 0.7)) * i / (N - 1)).toFixed(3));
      if (t + step > D) continue;
      await page.seek(t); const now = await page.evaluate(COLLECT);
      await page.seek(t + step); const later = await page.evaluate(COLLECT);
      const key = (it) => `${it.text}|${Math.round(it.x / 3)}|${Math.round(it.y / 3)}`;
      const still = new Set(later.map(key));
      samples.push({ t, items: now.map((it) => ({ ...it, resting: still.has(key(it)) && it.opacity > 0.6 })) });
    }

    // content: every word on screen must come from content.json (or data/)
    const contentFile = path.join(dir, 'content.json');
    if (!fs.existsSync(contentFile)) add('FAIL', 'content', 'content.json is missing: put every word, number and scene length there');
    else {
      const bag = new Set();
      try { collectValues(JSON.parse(fs.readFileSync(contentFile, 'utf8')), bag); } catch (e) { add('FAIL', 'content', 'content.json is not valid JSON: ' + e.message); }
      const dataDir = path.join(dir, 'data');
      if (fs.existsSync(dataDir)) for (const f of fs.readdirSync(dataDir)) if (/\.(json|csv|txt|md)$/i.test(f)) collectValues(fs.readFileSync(path.join(dataDir, f), 'utf8'), bag);
      const stray = new Map();
      for (const s of samples) for (const it of s.items) for (const w of wordsOf(it.text)) if (!bag.has(w) && !stray.has(w)) stray.set(w, { t: s.t, text: it.text });
      if (!page.info.hasContent) add('WARN', 'content', 'window.CONTENT is not set: load content.json into it so edits reach the screen');
      if (stray.size) add('FAIL', 'content', `${stray.size} on-screen word(s) are not in content.json: ` + [...stray].slice(0, 8).map(([w, x]) => `"${w}" (${x.t.toFixed(1)} s)`).join(', '));
      else add('PASS', 'content', `every on-screen word comes from content.json (${bag.size} words)`);
    }

    // cut-off and small text, on resting text only
    const phone = 390 / width, cutSeen = new Map(), small = new Map();
    for (const s of samples) for (const it of s.items) {
      if (!it.resting) continue;
      if (it.cut && !cutSeen.has(it.text)) cutSeen.set(it.text, { t: s.t, by: it.cut });
      const px = it.font * phone;
      if (px < 8 && (!small.has(it.text) || small.get(it.text).px > px)) small.set(it.text, { t: s.t, px, font: it.font });
    }
    if (cutSeen.size) add('FAIL', 'cut-off', [...cutSeen].slice(0, 6).map(([txt, x]) => `"${short(txt)}" is cut by ${x.by} at ${x.t.toFixed(2)} s`).join('; '));
    else add('PASS', 'cut-off', 'no resting text is cut');
    const tooSmall = [...small].filter(([, x]) => x.px < 5.5), smallish = [...small].filter(([, x]) => x.px >= 5.5);
    const fmt = ([txt, x]) => `"${short(txt)}" ${Math.round(x.font)} px = ${x.px.toFixed(1)} px on a phone (${x.t.toFixed(1)} s)`;
    if (tooSmall.length) add('FAIL', 'small', tooSmall.slice(0, 6).map(fmt).join('; '));
    if (smallish.length) add('WARN', 'small', smallish.slice(0, 6).map(fmt).join('; '));
    if (!tooSmall.length && !smallish.length) add('PASS', 'small', 'all resting text is 8 px or more on a phone');
  }

  const errs = [...new Set(page.errors)];
  if (errs.length) add('FAIL', 'page', errs.slice(0, 5).join(' | '));
  else add('PASS', 'page', 'no script errors or failed loads');

  // video: measured on a 96-px-wide grey copy of every frame
  const video = path.join(dir, 'out', 'video.mp4');
  if (!fs.existsSync(video)) add('WARN', 'video', 'not rendered yet: run scripts/render.mjs, then check again');
  else if (!problems.length) {
    const sources = ['index.html', 'content.json'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
    const stale = sources.some((f) => fs.statSync(f).mtimeMs > fs.statSync(video).mtimeMs);
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', video], { encoding: 'utf8' }).stdout || '{}');
    const vw = probe.streams?.[0]?.width, vh = probe.streams?.[0]?.height, vd = Number(probe.format?.duration);
    const W = 96, H = Math.max(2, Math.round(96 * height / width / 2) * 2), n = W * H;
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 }).stdout || Buffer.alloc(0);
    const frames = Math.floor(raw.length / n);
    let run = 0, longest = 0, longestAt = 0, start = 0, blankRun = 0; const blanks = [];
    for (let f = 0; f < frames; f++) {
      let sum = 0, sq = 0, d = 0; const o = f * n, p = (f - 1) * n;
      for (let i = 0; i < n; i++) { const v = raw[o + i]; sum += v; sq += v * v; if (f > 0) d += Math.abs(v - raw[p + i]); }
      const mean = sum / n, spread = Math.sqrt(Math.max(0, sq / n - mean * mean));
      if (f > 0 && d / n <= 0.15) { if (run === 0) start = f; run++; if (run > longest) { longest = run; longestAt = start; } } else run = 0;
      const inside = f > fps * 0.5 && f < frames - fps * 0.5;
      if (spread < 1.0 && inside) { blankRun++; if (blankRun === 3) blanks.push(((f - 2) / fps).toFixed(2)); } else blankRun = 0;
    }
    const bad = [], warn = [];
    if (vw !== width || vh !== height) bad.push(`size is ${vw}x${vh}, expected ${width}x${height}`);
    if (!(Math.abs(vd - D) <= 2.5 / fps)) bad.push(`length is ${vd.toFixed(2)} s, expected ${D} s`);
    if (blanks.length) bad.push(`blank picture at ${blanks.slice(0, 5).join(', ')} s`);
    const stillS = longest / fps, stillAt = (longestAt / fps).toFixed(1);
    if (stillS > 5) bad.push(`nothing moves for ${stillS.toFixed(1)} s from ${stillAt} s`);
    else if (stillS > 2.5) warn.push(`nothing moves for ${stillS.toFixed(1)} s from ${stillAt} s`);
    if (stale) warn.push('the video is older than index.html or content.json: render again');
    if (bad.length) add('FAIL', 'video', bad.join('; '));
    if (warn.length) add('WARN', 'video', warn.join('; '));
    if (!bad.length && !warn.length) add('PASS', 'video', `${vd.toFixed(2)} s, ${vw}x${vh}, no blank frames, longest freeze ${stillS.toFixed(1)} s`);
  }
} catch (err) {
  add('FAIL', 'check', 'could not finish: ' + err.message);
} finally {
  await browser.close();
  server.close();
}

for (const r of results) console.log(`${r.level}  ${r.name.padEnd(9)} ${r.detail}`);
const fails = results.filter((r) => r.level === 'FAIL').length, warns = results.filter((r) => r.level === 'WARN').length;
console.log(`\n${fails ? 'FAILED' : 'OK'}: ${fails} fail, ${warns} warn, ${results.length - fails - warns} pass`);
fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
fs.writeFileSync(path.join(dir, 'out', 'check.json'), JSON.stringify({ ok: !fails, results }, null, 2));
process.exit(fails ? 1 : 0);
