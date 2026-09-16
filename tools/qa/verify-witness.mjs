#!/usr/bin/env node
// Verifies the quiet Seraph + chapel witness beats on a live engine:
// spawn the post-cordon Seraph, approach + interact, read the branching
// lines; then walk to Saint Orison and stand beside the witness echo.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-witness');
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
// Subtitles emit one at a time (~3.6s each) — poll the log, don't guess timing.
const pollUntil = async (page, fn, predicate, timeoutMs, intervalMs = 400) => {
  const t0 = Date.now();
  let value = await page.evaluate(fn);
  while (!predicate(value) && Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    value = await page.evaluate(fn);
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
  await new Promise((r) => setTimeout(r, 900));
  await page.keyboard.up('w');
  await page.waitForFunction(() => !window.__hg?.cinematic, { timeout: 60_000 });

  // Tap the subtitle callback so queued lines are captured even when the
  // visible caption has already rotated out.
  await page.evaluate(() => {
    const engine = window.__hg;
    const cb = engine.callbacks ?? {};
    const sub = cb.onSubtitle?.bind(engine) ?? (() => {});
    window.__subLog = [];
    cb.onSubtitle = (line) => { window.__subLog.push(`${line.speaker}: ${line.text}`); return sub(line); };
  });

  // Fast-forward the story state: the delivery + cordon resolved, then let
  // the spawn path raise the quiet Seraph exactly as the resolved branch does.
  await page.evaluate(() => {
    const engine = window.__hg;
    engine['narrative'] ??= {};
    engine['narrative'].senaDelivered = true;
    engine['narrative'].senaAsked = true;
    engine['narrative'].cordonSeen = true;
    engine['narrative'].voxHeard = true;
    engine['narrative'].exitReleased = true;
    engine['narrative'].aftermathHeard = true;
    engine['spawnQuietSeraph']();
  });
  const seraph = await page.evaluate(() => {
    const s = window.__hg['quietSeraph'];
    return s ? { x: s.group.position.x, z: s.group.position.z, posted: s.posted, vignette: s.vignette } : null;
  });
  check('quiet Seraph spawned posted at the clearing', !!seraph?.posted, JSON.stringify(seraph));

  // Stand beside him — the prompt should offer the approach.
  await page.evaluate(({ x, z }) => {
    const engine = window.__hg;
    engine.player.position.set(x + 1.4, 0, z + 0.8);
    engine.playerVelocity.x = 0; engine.playerVelocity.y = 0; engine.playerVelocity.z = 0;
  }, seraph);
  const promptText = await pollUntil(page,
    () => document.querySelector('.interaction-prompt')?.textContent ?? '',
    (text) => /approach the seraph/i.test(text), 10_000);
  check('"Approach the Seraph" prompt shown', /approach the seraph/i.test(promptText), promptText);
  await page.screenshot({ path: join(outDir, 'quiet-seraph.png') });

  await page.keyboard.press('KeyE');
  await new Promise((r) => setTimeout(r, 1400));
  const heard = await page.evaluate(() => window.__hg['narrative']?.seraphHeard === true);
  check('seraphHeard persisted on interact', heard);
  // Lines queue at 2.7s and emit one at a time — poll until all six land.
  const seraphLog = await pollUntil(page, () => window.__subLog ?? [],
    (log) => log.filter((l) => /Seraph:|Aurel:/.test(l)).length >= 6, 45_000);
  check('all 6 Seraph lines delivered', seraphLog.filter((l) => /Seraph:|Aurel:/.test(l)).length >= 6,
    `got ${seraphLog.length}`);
  check('released-variant line captioned', seraphLog.some((l) => /below,?\s*that counts/i.test(l)),
    seraphLog.slice(-3).join(' | '));
  check('"Ask the chapel" signpost delivered', seraphLog.some((l) => /ask the chapel/i.test(l)), '');

  // --- Chapel witness ---
  await page.evaluate(() => {
    const engine = window.__hg;
    engine.player.position.set(-72, 0, 48); // inside Saint Orison's footprint
    engine.playerVelocity.x = 0; engine.playerVelocity.y = 0; engine.playerVelocity.z = 0;
  });
  await new Promise((r) => setTimeout(r, 1200));
  const witness = await page.evaluate(() => {
    const w = window.__hg['chapelWitness'];
    return w ? { x: w.group.position.x, z: w.group.position.z, opacity: w.materials[0]?.opacity } : null;
  });
  check('witness echo spawned at the altar', !!witness, JSON.stringify(witness));
  await page.screenshot({ path: join(outDir, 'witness-idle.png') });

  await page.evaluate(({ x, z }) => {
    window.__hg.player.position.set(x + 0.9, 0, z + 0.6);
  }, witness);
  await new Promise((r) => setTimeout(r, 1500));
  const witnessed = await page.evaluate(() => window.__hg['narrative']?.chapelWitnessed === true);
  check('chapelWitnessed persisted on approach', witnessed);
  const witLog = await pollUntil(page,
    () => (window.__subLog ?? []).filter((l) => /Witness|Another ghost|bell did/i.test(l)),
    (log) => log.length >= 4, 45_000);
  check('witness line: "Signed your name"', witLog.some((l) => /signed your name/i.test(l)), witLog.join(' | '));
  check('witness line: "The bell did"', witLog.some((l) => /the bell did/i.test(l)), '');
  await page.screenshot({ path: join(outDir, 'witness-triggered.png') });

  // Headless rAF is throttled — `elapsed` only creeps when screenshots force
  // frames. Jump the game clock past the fade window, force a frame, verify.
  await page.evaluate(() => { window.__hg['elapsed'] = (window.__hg['elapsed'] ?? 0) + 30; });
  await page.screenshot({ path: join(outDir, 'witness-fade-forced.png') });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: join(outDir, 'witness-after.png') });
  const gone = await page.evaluate(() => window.__hg['chapelWitness'] === null);
  check('witness faded and disposed', gone);

  console.log('console/page errors:', errors.length ? errors : 'none');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAIL` : '\nALL PASS');
  process.exitCode = failed.length || errors.length ? 1 : 0;
} catch (error) {
  console.error('verify-witness crashed:', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
