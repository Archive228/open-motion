#!/usr/bin/env node
// Claude can't watch a video. This captures still frames and tiles them into one contact sheet it can open.
//   node scripts/look.mjs <project-dir> --sheet 12            12 evenly spaced frames
//   node scripts/look.mjs <project-dir> --at 0,1.5,3.2         frames at chosen times
//   node scripts/look.mjs <project-dir> --range 4.0-5.0 --every 0.1
// Writes <project-dir>/out/stills/t_<seconds>.png and <project-dir>/out/sheet.png
import fs from 'node:fs';
import path from 'node:path';
import { launch, openPage, serveDir, checkContract, projectDir } from './lib.mjs';

const args = process.argv.slice(2);
const dir = projectDir(args, 'scripts/look.mjs');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const server = await serveDir(dir);
const browser = await launch();
let code = 0;
try {
  const page = await openPage(browser, `http://127.0.0.1:${server.port}/index.html`);
  const problems = checkContract(page.info);
  if (problems.length) throw new Error('Contract not met: ' + problems.join('; '));
  const { duration: D, fps, width, height } = page.info;

  let times;
  if (opt('--at')) times = opt('--at').split(',').map(Number);
  else if (opt('--range')) {
    const [a, b] = opt('--range').split('-').map(Number);
    const step = Number(opt('--every') || 0.1);
    times = [];
    for (let t = a; t <= b + 1e-9; t += step) times.push(Number(t.toFixed(4)));
  } else {
    const n = Math.max(2, Math.min(24, Number(opt('--sheet') || 12)));
    times = Array.from({ length: n }, (_, i) => Number(((D - 1 / fps) * i / (n - 1)).toFixed(3)));
  }
  times = times.filter((t) => Number.isFinite(t) && t >= 0 && t <= D).slice(0, 24);
  if (!times.length) throw new Error(`No valid times inside 0..${D}`);

  const outDir = path.join(dir, 'out', 'stills');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const t of times) {
    await page.seek(t);
    const name = `t_${t.toFixed(2).padStart(6, '0')}.png`;
    fs.writeFileSync(path.join(outDir, name), await page.screenshot());
    files.push({ t, name });
  }

  // Contact sheet: tiles keep the frame's shape, with a time label, on mid-grey so transparency is not mistaken for white.
  const wide = width >= height;
  const cols = Math.min(wide ? 4 : 6, files.length);
  const rows = Math.ceil(files.length / cols);
  const tileW = wide ? 480 : 270, tileH = Math.round(tileW * height / width), label = 26;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#777;font:600 15px/26px -apple-system,Helvetica,Arial,sans-serif;color:#fff}
    .g{display:grid;grid-template-columns:repeat(${cols},${tileW}px)} .c{height:${tileH + label}px;overflow:hidden}
    img{display:block;width:${tileW}px;height:${tileH}px} .l{height:${label}px;padding:0 8px;background:#222}
  </style><div class="g">${files.map((f) => `<div class="c"><img src="stills/${f.name}"><div class="l">${f.t.toFixed(2)} s</div></div>`).join('')}</div>`;
  fs.writeFileSync(path.join(dir, 'out', 'sheet.html'), html);
  const sheet = await openPage(browser, `http://127.0.0.1:${server.port}/out/sheet.html`, { width: cols * tileW, height: rows * (tileH + label) });
  await sheet.evaluate(`Promise.all([...document.images].map((i) => i.decode().catch(() => {})))`);
  fs.writeFileSync(path.join(dir, 'out', 'sheet.png'), await sheet.screenshot());
  fs.rmSync(path.join(dir, 'out', 'sheet.html'), { force: true });

  console.log(JSON.stringify({
    ok: true, duration: D, fps, size: `${width}x${height}`,
    sheet: path.join(dir, 'out', 'sheet.png'), stills: files.map((f) => path.join(outDir, f.name)),
    pageErrors: [...new Set(page.errors)].slice(0, 12),
  }, null, 2));
} catch (err) {
  console.error('look failed:', err.message);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
