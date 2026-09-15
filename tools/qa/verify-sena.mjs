#!/usr/bin/env node
// Verifies the Sena delivery scene end-to-end on a live engine (dev-only
// __hg hook): teleport beside her -> Talk prompt -> E -> subtitle exchange
// -> E/Q choice -> bell toll + platform echoes. Screenshots every beat.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-sena');
mkdirSync(outDir, { recursive: true });
const URL_ARG = process.argv.find((a) => a.startsWith('--url='))?.slice(6)
  ?? 'http://localhost:3000';

const candidates = [
  process.env.HG_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const browserPath = candidates.find((c) => existsSync(c));
if (!browserPath) throw new Error('No Chrome/Edge found');

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--use-angle=d3d11', '--window-size=1280,720', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 720 },
});

const shot = async (page, name) => {
  await page.screenshot({ path: join(outDir, name) });
  console.log('captured', name);
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
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || ''));
    btn.click();
  });
  await page.waitForFunction(() => window.__hg?.player, { timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 6000)); // world settle

  const state = await page.evaluate(() => {
    const e = window.__hg;
    const s = e.sena?.group?.position;
    if (!s) return { ok: false, reason: 'no sena actor' };
    // Stand 1.6m south of her, camera facing north toward her.
    e.player.position.set(s.x - 0.2, 0.02, s.z + 1.6);
    e.cameraYaw = Math.atan2(e.player.position.x - s.x, e.player.position.z - s.z) + Math.PI;
    return { ok: true, sena: [s.x, s.z], player: [e.player.position.x, e.player.position.z] };
  });
  console.log('teleport:', JSON.stringify(state));
  await new Promise((r) => setTimeout(r, 1600));
  await shot(page, 'sena-1-approach.png');

  const prompt = await page.evaluate(() => document.body.innerText.match(/Talk to Sena/i)?.[0] ?? null);
  console.log('prompt visible:', prompt);

  await page.keyboard.press('KeyE');
  await new Promise((r) => setTimeout(r, 3500));
  await shot(page, 'sena-2-dialogue.png');

  // Headless runs at a fraction of real time (delta-capped). Fast-forward the
  // engine clock to just past the choice mark, then let the loop open it.
  await page.evaluate(() => { const e = window.__hg; e.elapsed = (e.senaChoiceAt ?? e.elapsed) + 0.05; });
  let choiceSeen = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await page.evaluate(() => {
      const e = window.__hg;
      return {
        elapsed: +e.elapsed?.toFixed(1), open: e.senaChoiceOpen,
        choiceUi: !!document.querySelector('.dialogue-choice'),
      };
    });
    console.log('poll', JSON.stringify(s));
    if (s.open || s.choiceUi) { choiceSeen = s; break; }
  }
  await shot(page, 'sena-3-choice.png');
  const choiceVisible = await page.evaluate(() => document.body.innerText.match(/Who was she|signature will do/i)?.[0] ?? null);
  console.log('choice visible:', choiceVisible, 'seen:', JSON.stringify(choiceSeen));

  await page.keyboard.press('KeyE'); // "Who was she?"
  await new Promise((r) => setTimeout(r, 2500));
  await shot(page, 'sena-4-answer.png');

  // Bell at +10s game-time post-choice — fast-forward, then catch the echo window.
  await page.evaluate(() => { const e = window.__hg; e.elapsed = (e.bellAt ?? e.elapsed) + 0.05; });
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const fired = await page.evaluate(() => window.__hg?.bellFired === true);
    if (fired) break;
  }
  await shot(page, 'sena-5-bell.png');
  await new Promise((r) => setTimeout(r, 2500));
  await shot(page, 'sena-6-after.png');

  const finalState = await page.evaluate(() => ({
    narrative: window.__hg?.narrative,
    bellFired: window.__hg?.bellFired,
    prompt: document.body.innerText.match(/Kneel|Talk to|Enter/i)?.[0] ?? null,
  }));
  console.log('final:', JSON.stringify(finalState));
  console.log('errors:', errors.length ? errors : 'none');
  process.exitCode = errors.length ? 1 : 0;
} finally {
  await browser.close().catch(() => {});
}
