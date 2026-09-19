#!/usr/bin/env node
// Scene probe: boots the game, waits for play, dumps measurements —
// actor/vehicle/hero bounding boxes, renderer stats, draw calls, quality.
// Usage: node tools/qa/probe-scene.mjs [--url=http://127.0.0.1:3100]

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const RAW_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:3100';
const URL_ARG = `${RAW_URL}${RAW_URL.includes('?') ? '&' : '?'}debug=1`;

const browserPath = [
  process.env.HG_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((c) => existsSync(c));

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  protocolTimeout: 480_000,
  args: ['--use-angle=d3d11', '--disable-dev-shm-usage'],
  defaultViewport: { width: 960, height: 540 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 200)));
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => /campaign/i.test(b.textContent || '')),
    { timeout: 120_000 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || ''))?.click();
  });
  await page.waitForFunction(() => window.__hg?.engine?.player, { timeout: 240_000 });
  await page.evaluate(() => { const e = window.__hg.engine; e.cinematic = null; e.skipCinematic?.(); e.photoMode = true; });
  await sleep(6000);

  const r = await page.evaluate(() => {
    const e = window.__hg.engine;
    const measure = (root) => {
      const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
      let n = 0;
      root.traverse?.((o) => {
        if (!(o.isMesh || o.isSkinnedMesh) || o.visible === false) return;
        n++;
        const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        for (const cx of [bb.min.x, bb.max.x])
          for (const cy of [bb.min.y, bb.max.y])
            for (const cz of [bb.min.z, bb.max.z]) {
              const w = o.localToWorld(new o.position.constructor(cx, cy, cz));
              box.min[0] = Math.min(box.min[0], w.x); box.min[1] = Math.min(box.min[1], w.y); box.min[2] = Math.min(box.min[2], w.z);
              box.max[0] = Math.max(box.max[0], w.x); box.max[1] = Math.max(box.max[1], w.y); box.max[2] = Math.max(box.max[2], w.z);
            }
      });
      const f = (v) => +v.toFixed(2);
      return n ? {
        n,
        size: [f(box.max[0] - box.min[0]), f(box.max[1] - box.min[1]), f(box.max[2] - box.min[2])],
        yTop: f(box.max[1]), yBot: f(box.min[1]),
        center: [f((box.min[0] + box.max[0]) / 2), f((box.min[1] + box.max[1]) / 2), f((box.min[2] + box.max[2]) / 2)],
      } : null;
    };
    const actorBox = (kind) => {
      const a = e.actors?.find((x) => x.kind === kind && x.alive);
      return a ? { pos: [a.group.position.x, a.group.position.z].map((v) => +v.toFixed(1)), box: measure(a.group) } : null;
    };
    const info = e.renderer?.info;
    return {
      heroPos: [e.player.position.x, e.player.position.y, e.player.position.z].map((v) => +v.toFixed(2)),
      heroBox: measure(e.player),
      civilian: actorBox('civilian'),
      enemy: actorBox('enemy'),
      drone: actorBox('drone'),
      vehicle: e.vehicles?.[0] ? { pos: [e.vehicles[0].group.position.x, e.vehicles[0].group.position.z].map((v) => +v.toFixed(1)), box: measure(e.vehicles[0].group) } : null,
      renderer: info ? { calls: info.render.calls, tris: info.render.triangles, geoms: info.memory.geometries, tex: info.memory.textures, progs: info.programs?.length } : null,
      sceneChildren: e.scene?.children?.length,
      quality: e.qualityTier ?? e.settings?.quality,
    };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
