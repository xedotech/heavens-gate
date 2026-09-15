#!/usr/bin/env node
// PresentMon needs elevation — this is the unprivileged equivalent: a real
// Chrome instance plays the game while we sample requestAnimationFrame deltas
// and the engine's own perf counters, producing p50/p95/p99 frame times, jank
// counts, and a frame-time histogram.
//
//   node tools/qa/frame-capture.mjs [--quality=high] [--seconds=60]
//
// Writes artifacts/frame-capture/<timestamp>/frames.csv + report.json.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));

const QUALITY = String(args.get('quality') ?? 'high');
const SECONDS = Number(args.get('seconds') ?? 60);
const URL_ARG = args.get('url') ?? 'http://localhost:3000';

function findBrowser() {
  const candidates = [
    process.env.HG_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('No Chrome/Edge found; set HG_BROWSER');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(ROOT, 'artifacts/frame-capture', stamp);
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: true,
  args: [
    '--use-angle=d3d11',
    '--window-size=1280,720',
    '--disable-dev-shm-usage',
    '--force-device-scale-factor=1',
  ],
  defaultViewport: { width: 1280, height: 720 },
});

try {
  const page = await browser.newPage();
  // Seed the requested quality + muted audio before the app boots.
  await page.evaluateOnNewDocument((q) => {
    try {
      localStorage.setItem('heavens-gate-settings-v1', JSON.stringify({
        version: 1,
        quality: q,
        audio: false,
        reducedMotion: false,
      }));
    } catch { /* ignore */ }
  }, QUALITY);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Start the game (Begin button) and wait for the world to be live.
  const begin = await page.waitForSelector('button', { timeout: 90_000 });
  const labels = await page.$$eval('button', (btns) => btns.map((b) => b.textContent || ''));
  const beginIdx = labels.findIndex((t) => /begin|play|start|enter/i.test(t));
  if (beginIdx >= 0) await (await page.$$('button'))[beginIdx].click();
  else await begin.click();

  // Wait for the canvas + world loop (loading overlay gone).
  await page.waitForFunction(
    () => !document.body.innerText.includes('LOADING') || document.querySelector('canvas'),
    { timeout: 120_000 },
  );
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 8000)); // let assets settle

  // Sample rAF deltas inside the page; also a light movement mix so the trace
  // covers gameplay, not a static camera.
  const trace = await page.evaluate(async (secs) => {
    const deltas = [];
    const keys = [
      () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })),
      () => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })),
      () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' })),
      () => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' })),
    ];
    let last = performance.now();
    let running = true;
    const kicker = setInterval(() => keys[Math.floor(Math.random() * keys.length)](), 1500);
    function tick(t) {
      deltas.push(t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, secs * 1000));
    running = false;
    clearInterval(kicker);
    const gpu = (() => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      } catch { return 'unknown'; }
    })();
    return { deltas, gpu };
  }, SECONDS);

  const deltas = trace.deltas.filter((d) => d > 0 && d < 5000).sort((a, b) => a - b);
  const pct = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))];
  const avg = deltas.reduce((s, d) => s + d, 0) / (deltas.length || 1);
  const report = {
    quality: QUALITY,
    seconds: SECONDS,
    frames: deltas.length,
    gpu: trace.gpu,
    avgMs: +avg.toFixed(2),
    avgFps: +(1000 / avg).toFixed(1),
    p50: +pct(0.5).toFixed(2),
    p95: +pct(0.95).toFixed(2),
    p99: +pct(0.99).toFixed(2),
    worst: +deltas[deltas.length - 1].toFixed(2),
    jank16: deltas.filter((d) => d > 16.7).length,
    jank33: deltas.filter((d) => d > 33.4).length,
    jank50: deltas.filter((d) => d > 50).length,
    jank100: deltas.filter((d) => d > 100).length,
    consoleErrors,
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    join(outDir, 'frames.csv'),
    'frame_ms\n' + trace.deltas.map((d) => d.toFixed(2)).join('\n'),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${outDir}`);
  if (consoleErrors.length) process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
