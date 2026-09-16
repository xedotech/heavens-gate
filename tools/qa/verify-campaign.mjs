#!/usr/bin/env node
// End-to-end campaign verification: drives all eight missions in sequence on
// a live engine and proves every kind completes — reach, eliminate, vehicle,
// drive, echoes, boss, choice, complete. Uses the ?qa=1 hook for state and
// real keyboard input where a gesture is required.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-campaign');
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
  // Real click — trusted gesture so audio unlock doesn't stall start().
  const btn = await page.$('.title-menu button');
  if (btn) await btn.click();
  await page.waitForFunction(() => window.__hg?.mode === 'playing', { timeout: 90_000 });
  await page.keyboard.down('w');
  await sleep(900);
  await page.keyboard.up('w');
  await page.waitForFunction(() => !window.__hg?.cinematic, { timeout: 60_000 });

  const missionNow = () => page.evaluate(() => window.__hg['missionIndex']);
  const skipCinematic = async () => {
    await page.keyboard.down('w'); await sleep(700); await page.keyboard.up('w');
    await pollUntil(page, () => !window.__hg?.cinematic, (v) => v === true, 45_000);
  };

  check('campaign starts at mission 0', (await missionNow()) === 0, `missionIndex=${await missionNow()}`);

  // ── M0 · The Bell Below (reach) ─────────────────────────────────────────
  await page.evaluate(() => {
    const engine = window.__hg;
    engine.player.position.set(0, 0, -54);
    engine.playerVelocity.set(0, 0, 0);
  });
  await skipCinematic();
  const m1 = await missionNow();
  check('M0 reach completes → mission 1', m1 === 1, `missionIndex=${m1}`);
  await page.screenshot({ path: join(outDir, 'm1-no-saints.png') });

  // ── M1 · No Saints in Crown (eliminate 5 wardens) ───────────────────────
  const wardenCount = await page.evaluate(() =>
    window.__hg['actors'].filter((a) => a.id.startsWith('warden-')).length);
  check('five wardens posted', wardenCount === 5, `got ${wardenCount}`);
  await page.evaluate(() => {
    const engine = window.__hg;
    engine['actors'].filter((a) => a.id.startsWith('warden-'))
      .forEach((a) => engine['damageActor'](a, 9999, false));
  });
  await skipCinematic();
  const m2 = await missionNow();
  check('M1 eliminate completes → mission 2', m2 === 2, `missionIndex=${m2}`);

  // ── M2 · Borrowed Wings (enter the interceptor) ──────────────────────────
  const seraph = await page.evaluate(() => {
    const engine = window.__hg;
    const v = engine['vehicles'][0];
    if (!v) return null;
    engine['enterVehicle'](v);
    return { x: v.group.position.x, z: v.group.position.z };
  });
  check('Seraph interceptor entered', !!seraph, JSON.stringify(seraph));
  await skipCinematic();
  const m3 = await missionNow();
  check('M2 vehicle completes → mission 3', m3 === 3, `missionIndex=${m3}`);
  await page.screenshot({ path: join(outDir, 'm3-long-ascension.png') });

  // ── M3 · The Long Ascension (drive to Meridian) ──────────────────────────
  await page.evaluate(() => {
    const engine = window.__hg;
    const v = engine['currentVehicle'];
    if (v) { v.group.position.set(92, 0, 76); engine['updateMission']?.(); }
  });
  await skipCinematic();
  const m4 = await missionNow();
  check('M3 drive completes → mission 4', m4 === 4, `missionIndex=${m4}`);

  // ── M4 · A City That Remembers (3 Veil echoes) ──────────────────────────
  // Exit must be verified — a blocked exit silently keeps currentVehicle set
  // and every interact() call just retries the exit instead of firing echoes.
  await page.evaluate(() => {
    const engine = window.__hg;
    const v = engine['currentVehicle'];
    if (v) {
      v.group.position.set(0, 0, 96); // open field so the exit isn't blocked
      engine['exitVehicle']?.();
    }
    engine.player.visible = true;
    engine['resonance'] = 100;
    engine['setVeil']?.(true, true); // silent — avoids toast spam
  });
  const onFoot = await page.evaluate(() => window.__hg['currentVehicle'] === null);
  check('player dismounted for the Veil walk', onFoot);
  const echoes = await page.evaluate(() =>
    window.__hg['echoes'].map((e) => ({ id: e.id, x: e.group.position.x, z: e.group.position.z })));
  check('three memory echoes exist', echoes.length === 3, JSON.stringify(echoes.map((e) => e.id)));
  for (const echo of echoes) {
    // interact() can be consumed by a nearer vehicle/actor — retry until the
    // echo actually registers in echoesActivated.
    await pollUntil(page, ({ x, z }) => {
      const engine = window.__hg;
      engine.player.position.set(x + 0.6, 0, z + 0.6);
      engine.playerVelocity.set(0, 0, 0);
      engine['resonance'] = 100;
      if (!engine['veilActive']) engine['setVeil']?.(true, true);
      if (engine['currentVehicle']) engine['exitVehicle']?.();
      else engine['interact']();
      return window.__hg['echoesActivated'].size;
    }, (count) => count >= echoes.indexOf(echo) + 1, 8_000, 600, echo);
  }
  const activated = await page.evaluate(() => window.__hg['echoesActivated'].size);
  check('all three echoes activated', activated >= 3, `got ${activated}`);
  await skipCinematic();
  const m5 = await missionNow();
  check('M4 echoes completes → mission 5', m5 === 5, `missionIndex=${m5}`);
  await page.screenshot({ path: join(outDir, 'm5-false-archon.png') });

  // ── M5 · The False Archon (boss) ─────────────────────────────────────────
  const bossSpawned = await pollUntil(page,
    () => !!window.__hg['boss'], (v) => v === true, 30_000);
  check('False Archon spawned', bossSpawned === true);
  await page.evaluate(() => {
    const engine = window.__hg;
    const boss = engine['boss'];
    if (boss) engine['damageActor'](boss, 99999, false);
  });
  await skipCinematic();
  const m6 = await missionNow();
  check('M5 boss completes → mission 6', m6 === 6, `missionIndex=${m6}`);

  // ── M6 · The Last Door (ending choice) ───────────────────────────────────
  const choiceShown = await pollUntil(page,
    () => !!document.querySelector('.choice-screen button'), (v) => v === true, 30_000);
  check('final verdict choice screen shown', choiceShown === true);
  await page.screenshot({ path: join(outDir, 'm6-choice.png') });
  if (choiceShown) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.choice-screen button')];
      const open = buttons.find((b) => /open the gates/i.test(b.textContent || '')) ?? buttons[0];
      open?.click();
    });
    const ended = await pollUntil(page,
      () => document.body.innerText, (t) => /ending|epilogue|afterlight|verdict|complete/i.test(t), 30_000);
    check('campaign resolves to ending screen', /verdict|open the gates|aethel/i.test(ended));
    const idx = await missionNow();
    check('epilogue reached (mission 7)', idx === 7, `missionIndex=${idx}`);
    await page.screenshot({ path: join(outDir, 'm7-ending.png') });
  }

  await page.screenshot({ path: join(outDir, 'final.png') });
  console.log(`console/page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} FAIL` : 'ALL PASS'} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
