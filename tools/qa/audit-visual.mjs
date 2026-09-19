#!/usr/bin/env node
// Visual audit: boots the game at high quality and captures a series of
// controlled photo-cam shots — hero close-up, street level, chapel/relic,
// vehicle, civilian, enemy, aerial — to artifacts/audit/.
// Usage: node tools/qa/audit-visual.mjs [--url=http://localhost:3300] [--quality=high]

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(ROOT, 'artifacts/audit');
mkdirSync(outDir, { recursive: true });
const RAW_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://localhost:3300';
const URL_ARG = `${RAW_URL}${RAW_URL.includes('?') ? '&' : '?'}debug=1`;
const QUALITY = process.argv.find((a) => a.startsWith('--quality='))?.slice(10) ?? 'high';

const browserPath = [
  process.env.HG_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((c) => existsSync(c));
if (!browserPath) throw new Error('No Chrome/Edge found');

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  protocolTimeout: 480_000,
  args: ['--use-angle=d3d11', '--window-size=1280,720', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 720 },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => /campaign/i.test(b.textContent || '')),
    { timeout: 120_000 },
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || ''));
    btn?.click();
  });
  await page.waitForFunction(() => window.__hg?.engine?.player, { timeout: 240_000 });
  // Force the audit tier, skip the opening cinematic, let the world settle.
  await page.evaluate((q) => {
    const e = window.__hg.engine;
    if (e.setQualityTier) e.setQualityTier(q);
    e.cinematic = null;
    e.skipCinematic?.();
  }, QUALITY);
  await sleep(9000);

  // Engine conventions (updatePhotoCamera):
  //   forward = (-sin yaw * cos p, -sin p, -cos yaw * cos p)
  // Aim camera at C toward target T:
  //   yaw   = atan2(Cx - Tx, Cz - Tz)
  //   pitch = asin((Cy - Ty) / dist)
  const aim = await page.evaluate(() => {
    const e = window.__hg.engine;
    const vec = (v) => (v ? [v.x, v.y, v.z] : null);
    const actorPos = (kind) => {
      const a = e.actors?.filter((x) => x.kind === kind && x.alive)
        .sort((a, b) => a.group.position.distanceTo(e.player.position) - b.group.position.distanceTo(e.player.position))[0];
      return vec(a?.group.position);
    };
    const chapelCenter = e.chapelZone ? vec(e.chapelZone.getCenter(e.player.position.clone())) : null;
    // World-space hero bounds — bind-pose boxes transformed by matrixWorld.
    const heroBounds = (() => {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      e.player.traverse?.((o) => {
        if (!o.isMesh || !o.geometry) return;
        o.geometry.computeBoundingBox?.();
        const bb = o.geometry.boundingBox;
        if (!bb) return;
        const m = o.matrixWorld.elements;
        for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
          const wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
          const wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
          const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
          if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
          if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
        }
      });
      return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], height: max[1] - min[1] };
    })();
    return {
      player: vec(e.player.position),
      heading: e.playerHeading ?? 0,
      heroBounds,
      civilian: actorPos('civilian'),
      enemy: actorPos('enemy'),
      boss: actorPos('boss'),
      drone: actorPos('drone'),
      vehicle: vec(e.vehicles?.[0]?.group?.position),
      chapel: chapelCenter,
      actorCount: e.actors?.length ?? 0,
      vehicleCount: e.vehicles?.length ?? 0,
      mode: e.mode,
    };
  });
  console.log('anchors:', JSON.stringify(aim));

  // photo(name, cameraPos, targetPos, fov)
  const photo = async (name, cam, target, fov = 55) => {
    const dx = target[0] - cam[0], dy = target[1] - cam[1], dz = target[2] - cam[2];
    const dist = Math.hypot(dx, dy, dz) || 1;
    const yaw = Math.atan2(cam[0] - target[0], cam[2] - target[2]);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy / dist))) * -1;
    await page.evaluate(([cx, cy, cz, y, p, f]) => {
      const e = window.__hg.engine;
      e.photoMode = true;
      e.photoCamPos.set(cx, cy, cz);
      e.cameraYaw = y;
      e.cameraPitch = p;
      e.photoFov = f;
    }, [cam[0], cam[1], cam[2], yaw, pitch, fov]);
    await sleep(1400);
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    console.log('shot', name);
  };

  const [px, py, pz] = aim.player;
  const hd = aim.heading;
  // Engine facing convention: heading 0 faces -Z, forward = (-sin hd, 0, -cos hd).
  const fwdX = -Math.sin(hd), fwdZ = -Math.cos(hd);
  // Hero shots frame off the measured bounds — the authored hero is ~2.35m
  // (HERO_CHARACTER_SCALE), so a fixed 3m camera ends up inside the chest.
  const hb = aim.heroBounds;
  const hc = hb?.center ?? [px, py + 1.2, pz];
  const hh = Math.max(hb?.height ?? 2, 1.6);
  const heroDist = hh * 2.1;
  // The authored GLB faces +Z at heading 0 (opposite the movement forward) —
  // so the "front" camera parks on the -fwd side.
  await photo('hero-front', [hc[0] - fwdX * heroDist, hc[1] + hh * 0.08, hc[2] - fwdZ * heroDist], [hc[0], hc[1], hc[2]], 40);
  // Hero back three-quarter — over-shoulder view down the facing line.
  await photo('hero-follow', [hc[0] - fwdX * heroDist * 1.15 + fwdZ * 0.9, hc[1] + hh * 0.55, hc[2] - fwdZ * heroDist * 1.15 - fwdX * 0.9], [hc[0] + fwdX * 8, hc[1] - hh * 0.1, hc[2] + fwdZ * 8], 55);
  if (aim.civilian) {
    const [cx, cy, cz] = aim.civilian;
    await photo('civilian', [cx + 2.2, cy + 1.45, cz + 2.2], [cx, cy + 1.2, cz], 42);
  }
  if (aim.enemy) {
    const [ex, ey, ez] = aim.enemy;
    await photo('enemy', [ex + 2.4, ey + 1.5, ez + 2.4], [ex, ey + 1.25, ez], 42);
  }
  if (aim.boss) {
    const [bx, by, bz] = aim.boss;
    await photo('boss', [bx + 3.4, by + 1.9, bz + 3.4], [bx, by + 1.6, bz], 46);
  }
  if (aim.vehicle) {
    const [vx, vy, vz] = aim.vehicle;
    await photo('vehicle', [vx + 4.6, vy + 1.8, vz + 4.6], [vx, vy + 0.8, vz], 50);
  }
  if (aim.chapel) {
    const [hx, hy, hz] = aim.chapel;
    await photo('chapel-wide', [hx + 9, hy + 3.5, hz + 9], [hx, hy + 1.6, hz], 55);
    await photo('chapel-front', [hx + 5.5, hy + 2.2, hz], [hx, hy + 1.8, hz], 50);
  }
  // Aerial over the player — high enough to clear roofs.
  await photo('aerial', [px - 18, 46, pz - 18], [px, 0, pz], 55);
  console.log('errors:', errors.length, errors.slice(0, 3));
} finally {
  await browser.close();
}
