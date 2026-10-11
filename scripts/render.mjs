#!/usr/bin/env node
// Render a project to MP4: every frame is captured from window.seek(t) and piped to ffmpeg.
//   node scripts/render.mjs <project-dir> [--out out/video.mp4]
// If <project-dir>/audio.wav (or audio.mp3) exists it is muxed in and trimmed to the picture.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launch, openPage, serveDir, checkContract, projectDir } from './lib.mjs';

const args = process.argv.slice(2);
const dir = projectDir(args, 'scripts/render.mjs');
const outIdx = args.indexOf('--out');
const outFile = path.join(dir, outIdx >= 0 ? args[outIdx + 1] : 'out/video.mp4');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const audio = ['audio.wav', 'audio.mp3'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));

const started = Date.now();
const server = await serveDir(dir);
const browser = await launch();
let code = 0;
try {
  const page = await openPage(browser, `http://127.0.0.1:${server.port}/index.html`);
  const problems = checkContract(page.info);
  if (problems.length) throw new Error('Contract not met: ' + problems.join('; '));
  const { duration, fps, width, height } = page.info;
  const frames = Math.round(duration * fps);

  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    ...(audio ? ['-i', audio] : []),
    '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((resolve, reject) => {
    ff.on('error', () => reject(new Error('ffmpeg not found on PATH')));
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg exited with ' + c))));
  });
  ff.stdin.on('error', () => { /* reported through ffDone */ });

  for (let i = 0; i < frames; i++) {
    await page.seek(i / fps);
    const png = await page.screenshot();
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 60 === 0) process.stderr.write(`frame ${i}/${frames}\n`);
  }
  ff.stdin.end();
  await ffDone;

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name', '-of', 'json', outFile], { encoding: 'utf8' });
  const meta = JSON.parse(probe.stdout || '{}');
  console.log(JSON.stringify({
    ok: true, file: outFile, frames, fps, expectedDuration: duration, size: `${width}x${height}`,
    encodedDuration: Number(meta.format?.duration), bytes: Number(meta.format?.size),
    streams: (meta.streams || []).map((s) => `${s.codec_type}:${s.codec_name}`), audio: audio ? path.basename(audio) : null,
    renderSeconds: Math.round((Date.now() - started) / 1000), pageErrors: [...new Set(page.errors)].slice(0, 12),
  }, null, 2));
} catch (err) {
  console.error('render failed:', err.message);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
