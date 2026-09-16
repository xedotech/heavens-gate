#!/usr/bin/env node
// Verifies foot IK on a live engine: stand the player just off the edge of a
// low, step-over collider (top <= 0.42 doesn't block XZ — the classic curb
// case) and face along the edge so one foot lands over the box top. The
// raised foot's ankle must ride ~top+0.09 — planted, not clipping in — while
// the body stays at ground level.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/qa-ik');
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
  await page.evaluate(() => {
    [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || '')).click();
  });
  await page.waitForSelector('.reticle', { timeout: 90_000 });
  await page.keyboard.down('w');
  await new Promise((r) => setTimeout(r, 900));
  await page.keyboard.up('w');
  await page.waitForFunction(() => !window.__hg?.cinematic, { timeout: 60_000 });

  // A step-over box: doesn't block the capsule (top <= floor+0.42), big
  // enough for a foot to land inside, tall enough that a planted ankle is
  // visibly above the street plane.
  const stand = await page.evaluate(() => {
    const engine = window.__hg;
    const boxes = engine['collisionBoxes'] ?? [];
    const spawn = engine.player.position;
    let best = null;
    for (const box of boxes) {
      const h = box.max.y;
      if (h < 0.08 || h > 0.42) continue;
      const wx = box.max.x - box.min.x;
      const wz = box.max.z - box.min.z;
      if (Math.min(wx, wz) < 0.6) continue;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const d = Math.hypot(cx - spawn.x, cz - spawn.z);
      if (!best || d < best.d) best = { minX: box.min.x, cx, cz, top: h, wx, wz, d };
    }
    return best;
  });
  check('found a step-over collider', !!stand, JSON.stringify(stand));

  if (stand) {
    // Root 0.10m west of the box edge, facing north — the east foot's lateral
    // offset carries it over the box top while the capsule stays outside.
    await page.evaluate(({ minX, cz }) => {
      const engine = window.__hg;
      engine.player.position.set(minX - 0.10, 0, cz);
      engine.playerVelocity.x = 0; engine.playerVelocity.y = 0; engine.playerVelocity.z = 0;
      // Face along the curb (+z: lateral spread maps to +-x) with heading
      // AND rotation pre-aligned — otherwise smoothHeading's catch-up reads
      // as turn-in-place 'walk' and IK gates itself off.
      engine['playerHeading'] = 0;
      engine.player.rotation.y = 0;
    }, stand);
    await new Promise((r) => setTimeout(r, 2600));

    const ik = await page.evaluate((box) => {
      const engine = window.__hg;
      const c = engine['heroCharacter'];
      if (!c) return { error: 'no heroCharacter' };
      const feet = [];
      for (const leg of c['legChains'] ?? []) {
        const p = leg.foot.getWorldPosition(new (leg.foot.position.constructor)());
        feet.push({ foot: leg.foot.name, x: p.x, y: p.y, z: p.z, ankleOffset: leg.ankleOffset });
      }
      return { motion: c['activeMotion'], grounded: engine['grounded'], blend: c['ikBlend'], playerY: engine.player.position.y, feet };
    }, stand);
    console.log('ik probe:', JSON.stringify(ik));

    check('hero present, both leg chains', !ik.error && ik.feet.length === 2, JSON.stringify(ik.feet?.map((f) => f.foot)));
    check('idle motion + grounded', ik.motion === 'idle' && ik.grounded === true, `motion=${ik.motion}`);
    check('player root still on the street', ik.playerY < 0.1, `playerY=${ik.playerY}`);

    const onBox = ik.feet.filter((f) =>
      f.x > stand.minX && f.x < stand.minX + stand.wx
      && f.z > stand.cz - stand.wz / 2 && f.z < stand.cz + stand.wz / 2);
    check('a foot lands over the box top', onBox.length >= 1,
      `feet at ${ik.feet.map((f) => `(${f.x.toFixed(2)},${f.z.toFixed(2)})`).join(' ')} vs box x[${stand.minX.toFixed(2)}..${(stand.minX + stand.wx).toFixed(2)}] z~${stand.cz.toFixed(2)}`);
    for (const f of onBox) {
      check(`foot ${f.foot} planted on top`, f.y >= stand.top + 0.05 && f.y <= stand.top + 0.35,
        `worldY=${f.y.toFixed(3)} top=${stand.top}`);
    }
    await page.screenshot({ path: join(outDir, 'ik-curb-plant.png') });
    console.log('captured ik-curb-plant.png');
  }

  console.log('console/page errors:', errors.length ? errors : 'none');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} FAIL` : '\nALL PASS');
  process.exitCode = failed.length || errors.length ? 1 : 0;
} catch (error) {
  console.error('verify-ik crashed:', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
