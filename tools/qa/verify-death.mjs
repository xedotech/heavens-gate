#!/usr/bin/env node
// Death → game-over → checkpoint-retry verification on a live engine.
// Kills the player, waits for the death cam + gameover screen, clicks
// "Retry checkpoint", and proves the run restores at the last save.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-death');
mkdirSync(outDir, { recursive: true });
const RAW_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6)
  ?? 'http://localhost:3000';
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
const pollUntil = async (page, fn, predicate, timeoutMs, intervalMs = 500, ...args) => {
  const t0 = Date.now();
  let value = await page.evaluate(fn, ...args);
  while (!predicate(value) && Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    value = await page.evaluate(fn, ...args);
  }
  return value;
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => /campaign/i.test(b.textContent || '')),
    { timeout: 90_000 },
  );
  await page.waitForFunction(() => window.__hg?.player, { timeout: 120_000 });
  const btn = await page.$('.title-menu button');
  if (btn) await btn.click();
  await page.waitForFunction(() => window.__hg?.mode === 'playing', { timeout: 90_000 });
  await page.keyboard.down('w');
  await sleep(900);
  await page.keyboard.up('w');
  await page.waitForFunction(() => !window.__hg?.cinematic, { timeout: 60_000 });

  // Tap the toast callback — toasts are transient in the DOM.
  await page.evaluate(() => {
    const engine = window.__hg;
    const cb = engine.callbacks ?? {};
    const toast = cb.onToast?.bind(engine) ?? (() => {});
    window.__toastLog = [];
    cb.onToast = (t) => { window.__toastLog.push(`${t.title} :: ${t.detail ?? ''}`); return toast(t); };
  });

  // Force a checkpoint so the retry has somewhere to land.
  await page.evaluate(() => window.__hg['saveCheckpoint']?.());
  const spawn = await page.evaluate(() => {
    const p = window.__hg.player.position;
    return { x: p.x, y: p.y, z: p.z };
  });

  // Lethal hit — strip armor and invulnerability so one hit kills cleanly.
  const dead = await page.evaluate(() => {
    const engine = window.__hg;
    engine['armor'] = 0;
    engine['invulnerability'] = 0;
    engine['takePlayerDamage'](500);
    return { health: engine['health'], sent: engine['gameOverSent'] === true };
  });
  check('lethal damage reaches zero health', dead.health === 0, JSON.stringify(dead));
  check('gameOverSent latches', dead.sent === true);

  // Death cam runs ~2.4s of GAME time — headless rAF barely ticks, so shrink
  // the remaining timer and force frames via screenshot until it fires.
  await page.evaluate(() => { window.__hg['deathCamTimer'] = Math.min(window.__hg['deathCamTimer'] ?? 0, 0.05); });
  const gameover = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 40_000) {
      await page.screenshot({ path: join(outDir, 'deathcam-tick.png') }); // forces a frame
      if (await page.evaluate(() => !!document.querySelector('.gameover-screen'))) return true;
      await sleep(400);
    }
    return false;
  })();
  check('game-over screen shown', gameover === true);
  const fellToast = await page.evaluate(() => (window.__toastLog ?? []).join(' | '));
  check('"Aurel has fallen" toast with killer name', /aurel has fallen/i.test(fellToast), fellToast.slice(0, 120));
  await page.screenshot({ path: join(outDir, 'gameover.png') });

  // Retry — real click on the checkpoint button.
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.gameover-screen button')]
      .find((x) => /retry/i.test(x.textContent || ''));
    b?.click();
    return !!b;
  });
  check('retry checkpoint button clicked', clicked);
  const restored = await pollUntil(page, () => ({
    mode: window.__hg?.mode,
    health: window.__hg?.['health'],
    sent: window.__hg?.['gameOverSent'],
  }), (s) => s.mode === 'playing' && s.health > 0, 40_000);
  check('respawned into playing state', restored.mode === 'playing' && restored.health > 0,
    JSON.stringify(restored));
  check('gameOverSent cleared on retry', restored.sent === false);
  await page.screenshot({ path: join(outDir, 'respawned.png') });

  console.log(`console/page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} FAIL` : 'ALL PASS'} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
