#!/usr/bin/env node
// Save → reload → Continue verification. Sets narrative flags + checkpoint,
// reloads the page, clicks Continue, and proves the world state comes back.

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-save-resume');
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
  userDataDir: mkdtempSync(join(tmpdir(), 'hg-qa-save-')),
  args: ['--use-angle=d3d11', '--window-size=1280,720', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 720 },
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const enterCampaign = async (page, preferContinue) => {
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].length > 0,
    { timeout: 120_000 },
  );
  const clicked = await page.evaluate((wantContinue) => {
    const buttons = [...document.querySelectorAll('.title-menu button')];
    const target = wantContinue
      ? buttons.find((b) => /continue/i.test(b.textContent || ''))
      : buttons.find((b) => /campaign/i.test(b.textContent || ''));
    target?.click();
    return target?.textContent?.trim().slice(0, 30) ?? null;
  }, preferContinue);
  await page.waitForFunction(() => window.__hg?.mode === 'playing', { timeout: 90_000 });
  await page.keyboard.down('w');
  await sleep(800);
  await page.keyboard.up('w');
  await page.waitForFunction(() => !window.__hg?.cinematic, { timeout: 60_000 });
  return clicked;
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const fresh = await enterCampaign(page, false);
  check('fresh campaign enters playing', /campaign/i.test(fresh ?? ''), fresh);

  // Plant a distinctive state: mission progress + a narrative flag + position.
  await page.evaluate(() => {
    const engine = window.__hg;
    engine.player.position.set(-30, 0, 20);
    engine.playerVelocity.set(0, 0, 0);
    (engine['narrative'] ??= {}).senaAsked = true;
    (engine['narrative'] ??= {}).cordonSeen = true;
    engine['missionIndex'] = 3;
    engine['defeatedWardens'] = 5;
    engine['saveCheckpoint']?.();
    engine['updateObjectiveMarker']?.();
  });
  const planted = await page.evaluate(() => ({
    mission: window.__hg['missionIndex'],
    flags: { ...window.__hg['narrative'] },
    pos: { x: window.__hg.player.position.x, z: window.__hg.player.position.z },
  }));
  check('checkpoint planted mid-campaign state', planted.mission === 3 && planted.flags.senaAsked === true,
    JSON.stringify({ mission: planted.mission, pos: planted.pos }));

  // Hard reload — the save must survive a full page restart.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  const continued = await enterCampaign(page, true);
  check('"Continue" offered on the title menu', /continue/i.test(continued ?? ''), continued ?? 'none');

  const restored = await page.evaluate(() => ({
    mission: window.__hg['missionIndex'],
    flags: { ...window.__hg['narrative'] },
    wardens: window.__hg['defeatedWardens'],
    pos: { x: window.__hg.player.position.x, z: window.__hg.player.position.z },
  }));
  check('mission index restored', restored.mission === 3, `missionIndex=${restored.mission}`);
  check('narrative flags restored', restored.flags.senaAsked === true && restored.flags.cordonSeen === true,
    JSON.stringify(restored.flags));
  check('warden count restored', restored.wardens === 5, `got ${restored.wardens}`);
  await page.screenshot({ path: join(outDir, 'resumed.png') });

  console.log(`console/page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} FAIL` : 'ALL PASS'} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
