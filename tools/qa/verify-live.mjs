#!/usr/bin/env node
// Live deploy verification: boots the shipped site, reaches the title menu,
// starts play, and captures a screenshot. Usage: node tools/qa/verify-live.mjs --url=https://xedotech.github.io/heavens-gate/

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-live');
mkdirSync(outDir, { recursive: true });
const RAW_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6)
  ?? 'https://xedotech.github.io/heavens-gate/';
const URL_ARG = RAW_URL.includes('?') ? RAW_URL : `${RAW_URL}?qa=1`;

const browserPath = [
  process.env.HG_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((c) => existsSync(c));
if (!browserPath) throw new Error('No Chrome/Edge found');

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--use-angle=d3d11', '--window-size=1280,720', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 720 },
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const failed = [];
  page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.url().slice(0, 140)}`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 140)}`); });

  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => /campaign/i.test(b.textContent || '')),
    { timeout: 120_000 },
  );
  check('title menu reached', true);
  await page.screenshot({ path: join(outDir, 'live-title.png') });

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || ''));
    btn?.click();
  });
  await page.waitForFunction(() => window.__hg?.player, { timeout: 180_000 });
  const state = await page.evaluate(() => ({
    mode: window.__hg.mode,
    hp: window.__hg.player?.health,
    quality: window.__hg.qualityTier,
  }));
  check('engine playing', String(state.mode).toUpperCase() === 'PLAYING', JSON.stringify(state));
  await sleep(4000);
  await page.screenshot({ path: join(outDir, 'live-gameplay.png') });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('no failed requests', failed.length === 0, failed.slice(0, 3).join(' | '));
} catch (err) {
  check('boot completed', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failedCount}/${results.length} live checks passed`);
  process.exit(failedCount ? 1 : 0);
}
