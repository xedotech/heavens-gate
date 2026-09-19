#!/usr/bin/env node
// Perf capture: plays the game at each quality tier for a window and dumps
// getPerformanceSnapshot() — fps, frame-time percentiles, draw calls, tris.
// Usage: node tools/qa/perf-capture.mjs [--url=http://127.0.0.1:3100] [--seconds=18]

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const RAW_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:3100';
const SECONDS = +(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 18);
const URL_ARG = `${RAW_URL}${RAW_URL.includes('?') ? '&' : '?'}debug=1`;

const browserPath = [
  process.env.HG_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((c) => existsSync(c));

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  protocolTimeout: 480_000,
  args: ['--use-angle=d3d11', '--disable-dev-shm-usage', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 160)));
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => /campaign/i.test(b.textContent || '')),
    { timeout: 120_000 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || ''))?.click();
  });
  await page.waitForFunction(() => window.__hg?.engine?.player, { timeout: 240_000 });
  await page.evaluate(() => { const e = window.__hg.engine; e.cinematic = null; e.skipCinematic?.(); });
  await sleep(4000);

  for (const tier of ['low', 'medium', 'high']) {
    await page.evaluate((q) => {
      const e = window.__hg.engine;
      e.setSettings({ ...e.getSettings(), quality: q });
    }, tier);
    // Let dynamic-res settle, then sample the sampler's own window.
    await sleep(SECONDS * 1000);
    const snap = await page.evaluate(() => {
      const e = window.__hg.engine;
      const s = e.getPerformanceSnapshot ? e.getPerformanceSnapshot() : { fps: e.fps, drawCalls: e.renderer?.info?.render?.calls, triangles: e.renderer?.info?.render?.triangles };
      return s;
    });
    console.log(`[${tier}]`, JSON.stringify(snap));
  }
} finally {
  await browser.close();
}
