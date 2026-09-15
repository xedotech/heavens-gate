#!/usr/bin/env node
// Verifies combat feedback on a live engine (dev-only __hg hook):
// teleport a Seraph in front of the player, aim, fire until it drops —
// screenshot muzzle/hit/death-fall and read the engine's own counters.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-combat');
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
  // The engine boots while the title shows — wait for it BEFORE clicking, or
  // start() no-ops on a mid-init engine and mode stays 'attract'.
  await page.waitForFunction(() => window.__hg?.player, { timeout: 120_000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || '')).click();
  });
  await page.waitForSelector('.reticle', { timeout: 90_000 });
  // The mission opens with a letterboxed flyover — any movement key skips it,
  // but wait until the chase camera is actually back before teleporting.
  await page.keyboard.down('w');
  await new Promise((r) => setTimeout(r, 900));
  await page.keyboard.up('w');
  await page.waitForFunction(() => !window.__hg?.cinematic, { timeout: 60_000 });
  const hud = await page.evaluate(() => ({
    stats: window.__hg?.stats, heat: window.__hg?.heat,
    missionIndex: window.__hg?.missionIndex,
    hostileCount: (window.__hg?.actors ?? []).filter((a) => a.alive && a.kind !== 'civilian').length,
  }));
  console.log('hud-state:', JSON.stringify(hud));
  await new Promise((r) => setTimeout(r, 6000));

  // A mild downward pitch first — the reticle ray needs to reach torso height.
  await page.evaluate(() => { window.__hg.cameraPitch = 0.38; });
  await new Promise((r) => setTimeout(r, 900));
  // Teleport the nearest hostile onto the reticle ray and face it.
  const setup = await page.evaluate(() => {
    const e = window.__hg;
    const p = e.player.position;
    const hostiles = (e.actors ?? []).filter((a) => a.alive && a.kind !== 'civilian');
    if (!hostiles.length) return { ok: false, reason: 'no hostiles spawned' };
    const yaw = e.cameraYaw ?? 0;
    const target = hostiles[0];
    // Place the target where the reticle ray meets torso height — guaranteed
    // on the crosshair no matter where the chase cam is.
    const cam = e.camera.position;
    const dir = e.camera.getWorldDirection(new e.camera.position.constructor());
    const t = dir.y < -0.05 ? (cam.y - 1.25) / -dir.y : 9;
    const spot = { x: cam.x + dir.x * t, z: cam.z + dir.z * t };
    target.group.position.set(spot.x, 0, spot.z);
    // Idle/posted actors re-derive position from `spawn` each frame — move
    // the spawn too or the engine snaps the target back to its patrol post.
    target.spawn?.copy?.(target.group.position);
    target.targetPosition?.copy?.(target.group.position);
    target.posted = true; // hold it still for the check
    return { ok: true, at: [target.group.position.x.toFixed(1), target.group.position.z.toFixed(1)], kind: target.kind, hp: target.hp };
  });
  console.log('setup:', JSON.stringify(setup));
  await new Promise((r) => setTimeout(r, 800));
  await shot(page, 'combat-1-standoff.png');

  // Aim (right-button hold) + fire bursts; poll hp/alive between shots.
  await page.mouse.move(640, 360);
  const probe = await page.evaluate(() => {
    const e = window.__hg;
    const el = document.elementFromPoint(640, 360);
    return {
      target: el ? `${el.tagName}.${el.className}` : 'none',
      isCanvas: el === e.canvas,
      mode: e.mode, locked: !!e.pointerLocked, fallback: !!e.pointerFallback,
      paused: e.paused,
    };
  });
  console.log('pointer probe:', JSON.stringify(probe));
  const cdp = await page.createCDPSession();
  await page.evaluate(() => {
    window.__pd = [];
    window.addEventListener('pointerdown', (e) => window.__pd.push(`${e.button}:${e.target === window.__hg.canvas}`));
  });
  await page.mouse.down({ button: 'right' });
  await new Promise((r) => setTimeout(r, 600));
  await shot(page, 'combat-2-aim.png');
  let dead = false;
  for (let i = 0; i < 14 && !dead; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 360, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 420));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 360, button: 'left', buttons: 0, clickCount: 1 });
    const s = await page.evaluate(() => {
      const e = window.__hg;
      const h = (e.actors ?? []).find((a) => a.posted);
      return { hp: h?.health, alive: h?.alive, held: e.mouseShootHeld, ammo: e.ammo, kills: e.stats?.kills };
    });
    console.log('burst', i, JSON.stringify(s));
    if (i === 2) await shot(page, 'combat-3-hit.png');
    dead = s.alive === false;
  }
  const pd = await page.evaluate(() => window.__pd);
  console.log('pointerdown events:', JSON.stringify(pd));
  await page.mouse.up({ button: 'right' });
  await new Promise((r) => setTimeout(r, 1200));
  await shot(page, 'combat-4-fallen.png');

  const final = await page.evaluate(() => ({
    kills: window.__hg?.stats?.kills,
    heat: +window.__hg?.heat?.toFixed(1),
    decals: window.__hg?.decalPool ? 'pooled' : 'none',
  }));
  console.log('final:', JSON.stringify(final), '| dead:', dead);
  console.log('errors:', errors.length ? errors : 'none');
  process.exitCode = errors.length || !dead ? 1 : 0;
} finally {
  await browser.close().catch(() => {});
}
