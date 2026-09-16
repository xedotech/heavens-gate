#!/usr/bin/env node
// Ability/systems sweep on a live engine: presses every real key and checks
// the state each ability flips — reload, weapon cycle, melee, pulse, charge,
// veil, crouch, slide, dodge, jump. This is the "do the controls actually
// work" harness.

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-systems');
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
  userDataDir: mkdtempSync(join(tmpdir(), 'hg-qa-systems-')),
  args: ['--use-angle=d3d11', '--window-size=1280,720', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 720 },
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Headless rAF is throttled — force frames with screenshots so input edges tick.
const tick = async (page, frames = 3) => {
  for (let i = 0; i < frames; i++) {
    await page.screenshot({ path: join(outDir, 'tick.png') });
    await sleep(120);
  }
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
  const E = (fn) => page.evaluate(fn);

  // Stand the player in open ground, topped up, before the sweep.
  await E(() => {
    const engine = window.__hg;
    engine.player.position.set(0, 0, 96);
    engine.playerVelocity.set(0, 0, 0);
    engine['resonance'] = 100;
    engine['stamina'] = 100;
  });

  // Sample DURING the hold: headless frames carry ~0.3s+ deltas, so sub-second
  // cooldowns/airtime expire between polls. For instantaneous state we instead
  // LATCH the method calls — proof the input edge reached the ability.
  await E(() => {
    const engine = window.__hg;
    window.__abilityLog = [];
    for (const name of ['tryMelee', 'throwCharge', 'usePulse', 'startReload']) {
      const original = engine[name]?.bind(engine);
      if (original) engine[name] = (...a) => { window.__abilityLog.push(name); return original(...a); };
    }
  });
  const pressAndRead = async (key, read) => {
    await page.keyboard.down(key);
    await tick(page, 1);
    const during = await E(read);
    await tick(page, 1);
    const peak = await E(read);
    await page.keyboard.up(key);
    return Math.max(during, peak);
  };

  // Jump — space should unground and raise vertical velocity.
  const beforeY = await E(() => window.__hg.player.position.y);
  const peakY = await pressAndRead(' ', () => window.__hg.player.position.y);
  check('jump raises the player', peakY > beforeY + 0.15, `peak y=${peakY.toFixed(2)}`);
  await tick(page, 6);

  // Crouch toggle.
  await page.keyboard.down('c'); await tick(page, 1); await page.keyboard.up('c'); await tick(page, 1);
  const crouched = await E(() => window.__hg['crouching']);
  check('crouch engages', crouched === true);
  await page.keyboard.down('c'); await tick(page, 1); await page.keyboard.up('c'); await tick(page, 1); // stand back up

  // Slide — sprint forward, then poll slideRemaining hard: the window is
  // ~0.5s of game time and a single throttled frame can eat it.
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await tick(page, 5);
  await page.keyboard.down('c');
  let slid = 0;
  for (let i = 0; i < 10 && slid <= 0; i++) {
    await tick(page, 1);
    slid = Math.max(slid, await E(() => window.__hg['slideRemaining'] ?? 0));
  }
  await page.keyboard.up('c');
  check('sprint+crouch slides', slid > 0, `slideRemaining=${slid.toFixed(2)}`);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await tick(page, 8);

  // Dodge — Alt. A full dodge is ~0.4s of game time, less than one throttled
  // frame, so the remaining window can hit zero inside a single tick. Watch
  // for motion (position moves fast) OR a nonzero remaining window.
  const dodgeFrom = await E(() => ({ x: window.__hg.player.position.x, z: window.__hg.player.position.z, cd: window.__hg['dodgeCooldown'] ?? 0 }));
  await page.keyboard.down('Alt'); await tick(page, 2); await page.keyboard.up('Alt');
  const dodgeAfter = await E(() => ({ x: window.__hg.player.position.x, z: window.__hg.player.position.z, r: window.__hg['dodgeRemaining'] ?? 0, cd: window.__hg['dodgeCooldown'] ?? 0 }));
  const dodgeMoved = Math.hypot(dodgeAfter.x - dodgeFrom.x, dodgeAfter.z - dodgeFrom.z);
  check('dodge roll triggers', dodgeAfter.r > 0 || dodgeAfter.cd > dodgeFrom.cd || dodgeMoved > 0.4,
    `moved=${dodgeMoved.toFixed(2)} cooldown=${dodgeAfter.cd}`);
  await tick(page, 6);

  // Reload — drain the magazine a touch first so reload isn't refused.
  await E(() => { window.__hg['ammo'] = 4; window.__abilityLog.length = 0; });
  await pressAndRead('r', () => window.__hg['reloading'] ?? 0);
  const reloading = await E(() => ({ log: window.__abilityLog, r: window.__hg['reloading'] }));
  check('reload starts', reloading.log.includes('startReload') || reloading.r > 0, JSON.stringify(reloading));
  // Wait out the reload (game-time) then check the magazine refilled.
  const refilled = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      await tick(page, 2);
      const s = await E(() => ({ r: window.__hg['reloading'], a: window.__hg['ammo'] }));
      if (s.r === 0 && s.a > 4) return s;
    }
    return null;
  })();
  check('magazine refills', !!refilled, JSON.stringify(refilled));

  // Weapon cycle — X swaps the active weapon id.
  const w0 = await E(() => window.__hg['weaponId']);
  await page.keyboard.down('x'); await tick(page, 1); await page.keyboard.up('x'); await tick(page, 1);
  const w1 = await E(() => window.__hg['weaponId']);
  check('weapon cycle changes weapon', w0 !== w1, `${w0}→${w1}`);

  // Melee — V, latched by the method call.
  await E(() => { window.__abilityLog.length = 0; });
  await pressAndRead('v', () => window.__hg['meleeCooldown'] ?? 0);
  const melee = await E(() => ({ log: window.__abilityLog, cd: window.__hg['meleeCooldown'] }));
  check('melee swing fires', melee.log.includes('tryMelee') || melee.cd > 0, JSON.stringify(melee.log));
  await tick(page, 6);

  // Pulse — F (needs 24 resonance), latched by the call.
  await E(() => { window.__hg['resonance'] = 100; window.__abilityLog.length = 0; });
  await pressAndRead('f', () => window.__hg['pulseCooldown'] ?? 0);
  const pulse = await E(() => ({ log: window.__abilityLog, cd: window.__hg['pulseCooldown'] }));
  check('resonance pulse fires', pulse.log.includes('usePulse') || pulse.cd > 0, JSON.stringify(pulse));
  await tick(page, 4);

  // Charge — G (needs 18 resonance), latched by the call.
  await E(() => { window.__hg['resonance'] = 100; window.__abilityLog.length = 0; });
  await pressAndRead('g', () => window.__hg['chargeCooldown'] ?? 0);
  const charge = await E(() => ({ log: window.__abilityLog, cd: window.__hg['chargeCooldown'] }));
  check('charge throw fires', charge.log.includes('throwCharge') || charge.cd > 0, JSON.stringify(charge));
  await tick(page, 4);

  // Veil — Q toggles it open (needs 18 resonance, not on cooldown).
  await E(() => { window.__hg['resonance'] = 100; window.__hg['veilCooldown'] = 0; });
  await page.keyboard.down('q'); await tick(page, 1); await page.keyboard.up('q'); await tick(page, 1);
  const veiled = await E(() => window.__hg['veilActive']);
  check('veil opens', veiled === true);
  await page.screenshot({ path: join(outDir, 'veil-open.png') });
  await page.keyboard.down('q'); await tick(page, 1); await page.keyboard.up('q'); await tick(page, 1); // close it
  const unveiled = await E(() => window.__hg['veilActive']);
  check('veil closes', unveiled === false);

  await page.screenshot({ path: join(outDir, 'systems-end.png') });
  console.log(`console/page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} FAIL` : 'ALL PASS'} (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
