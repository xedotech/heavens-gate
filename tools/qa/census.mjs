#!/usr/bin/env node
// Scene census: counts visible meshes bucketed by material+geometry signature
// to plan draw-call merging. Usage: node tools/qa/census.mjs [--url=...]

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const RAW_URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:3100';
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
  defaultViewport: { width: 640, height: 360 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.goto(`${RAW_URL}${RAW_URL.includes('?') ? '&' : '?'}debug=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => /campaign/i.test(b.textContent || '')),
    { timeout: 120_000 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('.title-menu button')].find((b) => /campaign/i.test(b.textContent || ''))?.click();
  });
  await page.waitForFunction(() => window.__hg?.engine?.player, { timeout: 240_000 });
  await page.evaluate(() => {
    const e = window.__hg.engine;
    e.cinematic = null;
    e.skipCinematic?.();
    const q = new URLSearchParams(location.search).get('tier');
    if (q) e.setSettings?.({ ...e.settings, quality: q });
  });
  await sleep(7000);

  const r = await page.evaluate(() => {
    const e = window.__hg.engine;
    let total = 0, instanced = 0, skinned = 0, points = 0, lines = 0;
    const byMat = {};
    const byTop = {};
    const actorMeshes = { civilian: 0, enemy: 0, drone: 0, boss: 0 };
    e.scene.traverse((o) => {
      if (o.isInstancedMesh) instanced++;
      if (o.isSkinnedMesh) skinned++;
      if (o.isPoints) { points++; return; }
      if (o.isLine || o.isLineSegments) { lines++; return; }
      if (!(o.isMesh || o.isSkinnedMesh || o.isInstancedMesh)) return;
      total++;
      const m = o.material;
      const key = Array.isArray(m) ? 'multi' : `${m?.type}|${m?.color?.getHexString?.() ?? ''}|${m?.emissive?.getHexString?.() ?? ''}|tex:${m?.map ? 1 : 0}`;
      byMat[key] = (byMat[key] || 0) + 1;
      // nearest ancestor that is a direct child of the scene
      let top = o;
      while (top.parent && top.parent !== e.scene) top = top.parent;
      const tn = top.name || top.userData?.name || top.type;
      byTop[tn] = (byTop[tn] || 0) + 1;
      if (o.userData?.actorId) {
        const a = e.actors?.find((x) => x.id === o.userData.actorId);
        if (a) actorMeshes[a.kind] = (actorMeshes[a.kind] || 0) + 1;
      }
    });
    const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
    return {
      totalMeshObjects: total, instanced, skinned, points, lines,
      actorMeshes,
      topLevelBuckets: sort(byTop).slice(0, 20),
      materialBuckets: sort(byMat).length,
      topMaterials: sort(byMat).slice(0, 20),
    };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
}
