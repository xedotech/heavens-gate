// Headless smoke run for Heaven's Gate: launches a real browser, plays a
// scripted session against the dev server, and captures screenshots plus a
// console/error report under artifacts/smoke/<timestamp>/.
//
//   node tools/qa/smoke.mjs [--url=http://localhost:3000] [--quality=medium]
//                           [--switch=ultra] [--seed-settings=full|minimal]
//
// HG_BROWSER overrides the browser executable. Exit code is 1 if the page
// raised an uncaught error or logged a console.error.
//
// Settings seeding (--seed-settings):
//   full    — navigate once, let the app boot to the title screen, open
//             Settings and click a control so the app writes a COMPLETE
//             normalized settings object to localStorage, then patch
//             quality/volume in that JSON and reload. Produces a 'loaded'
//             read on the second boot, so the repair notice does not appear.
//   minimal — pre-seed a partial {quality, volume} object via
//             evaluateOnNewDocument before any app code runs; the app repairs
//             it on boot (exercises the storage repair notice path).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => arg.slice(2).split('=', 2)),
);
const targetUrl = args.url ?? 'http://localhost:3000';
const quality = args.quality ?? 'medium';
const switchTier = args.switch ?? 'ultra';
const seedSettings = args['seed-settings'] ?? 'full';
const VALID_QUALITY = new Set(['low', 'medium', 'high', 'ultra']);
for (const [flag, tier] of [['--quality', quality], ['--switch', switchTier]]) {
  if (!VALID_QUALITY.has(tier)) {
    console.error(`${flag} must be one of ${[...VALID_QUALITY].join(', ')}`);
    process.exit(2);
  }
}
if (!['full', 'minimal'].includes(seedSettings)) {
  console.error('--seed-settings must be full or minimal');
  process.exit(2);
}

const SETTINGS_KEY = 'heavens-gate-settings-v1';
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = process.env.HG_BROWSER ?? BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error('No browser found. Set HG_BROWSER to a Chrome/Edge executable.');
  process.exit(2);
}

const outDir = resolve('artifacts', 'smoke', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });

const consoleMessages = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const failedRequests = [];
// Benign noise seen in headless runs; each entry must be justified here.
// - /favicon.ico 404: the app ships favicon.svg only; Chrome probes .ico anyway.
const EXCLUDED_CONSOLE_ERRORS = [/favicon\.ico/];
const excluded = [];

const GPU_ATTEMPTS = [
  { name: 'd3d11', flags: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  { name: 'swiftshader', flags: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(flags) {
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--mute-audio', '--window-size=1280,720', ...flags],
    defaultViewport: { width: 1280, height: 720 },
  });
}

async function openPage(browser) {
  const page = await browser.newPage();
  page.on('console', (message) => {
    const url = message.location()?.url ?? '';
    const entry = { level: message.type(), text: message.text(), url };
    consoleMessages.push(entry);
    if (message.type() === 'error') {
      const line = `error: ${message.text()}${url ? ` (${url})` : ''}`;
      if (EXCLUDED_CONSOLE_ERRORS.some((pattern) => pattern.test(url) || pattern.test(message.text()))) {
        excluded.push(line);
      } else {
        consoleErrors.push(line);
      }
    } else if (message.type() === 'warning' || message.type() === 'warn') {
      consoleWarnings.push(`warning: ${message.text()}${url ? ` (${url})` : ''}`);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(String(error.stack ?? error)));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.url()} — HTTP ${response.status()}`);
  });
  if (seedSettings === 'minimal') {
    // Partial object on purpose: normalizeSettings repairs it on boot.
    await page.evaluateOnNewDocument((key, tier) => {
      try {
        window.localStorage.setItem(key, JSON.stringify({ quality: tier, volume: 0 }));
      } catch { /* storage may be unavailable */ }
    }, SETTINGS_KEY, quality);
  }
  return page;
}

// 'full' seeding: force the app to persist its complete normalized settings,
// patch quality/volume into that object, and reload so the boot sees 'loaded'.
async function seedFullSettings(page) {
  await page.waitForSelector('section.title-screen', { timeout: 120_000 });
  const stored = await page.evaluate((key) => window.localStorage.getItem(key), SETTINGS_KEY);
  if (!stored) {
    await clickButtonWithText(page, '.title-menu', 'Settings');
    await page.waitForSelector('.quality-control', { timeout: 15_000 });
    await clickButtonWithText(page, '.quality-control', 'high');
    await clickButtonWithText(page, '.settings-screen', 'Back');
    await page.waitForSelector('section.title-screen', { timeout: 15_000 });
  }
  const patched = await page.evaluate((key, tier) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const settings = JSON.parse(raw);
    settings.quality = tier;
    settings.volume = 0;
    window.localStorage.setItem(key, JSON.stringify(settings));
    return settings;
  }, SETTINGS_KEY, quality);
  if (!patched) throw new Error('Settings seeding failed: app never wrote settings');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  return patched;
}

async function webglInfo(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { webgl2: false, renderer: null };
    let renderer = null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    return { webgl2: true, renderer };
  });
}

async function clickButtonWithText(page, scope, text) {
  const found = await page.evaluate(({ scope, text }) => {
    const buttons = [...document.querySelectorAll(`${scope} button`)];
    const button = buttons.find((candidate) => candidate.textContent.toLowerCase().includes(text.toLowerCase()));
    if (!button) return false;
    button.click();
    return true;
  }, { scope, text });
  if (!found) throw new Error(`No "${text}" button inside ${scope}`);
}

async function main() {
  const started = Date.now();
  let browser = null;
  let page = null;
  let gpuPath = null;
  let renderer = null;

  for (const attempt of GPU_ATTEMPTS) {
    // A failed GPU attempt can log GL errors that say nothing about the page;
    // keep only what the surviving browser session produces.
    const marks = [consoleMessages, consoleErrors, consoleWarnings, pageErrors, failedRequests, excluded].map((list) => list.length);
    browser = await launch(attempt.flags);
    page = await openPage(browser);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const info = await webglInfo(page);
    if (info.webgl2) {
      gpuPath = attempt.name;
      renderer = info.renderer;
      break;
    }
    [consoleMessages, consoleErrors, consoleWarnings, pageErrors, failedRequests, excluded]
      .forEach((list, index) => { list.length = marks[index]; });
    await browser.close();
    browser = null;
    page = null;
  }
  if (!browser || !page) {
    console.error('WebGL2 unavailable under both d3d11 and swiftshader.');
    process.exit(2);
  }

  if (seedSettings === 'full') await seedFullSettings(page);

  const steps = [];
  const shot = async (label) => {
    const file = `${label}.png`;
    await page.screenshot({ path: join(outDir, file) });
    return file;
  };
  const step = async (label, action) => {
    const t0 = Date.now();
    await action();
    const file = await shot(label);
    steps.push({ label, file, wallMs: Date.now() - t0 });
    console.log(`  ${label} (${Date.now() - t0} ms)`);
  };

  // Title screen → begin a new campaign.
  await page.waitForSelector('section.title-screen', { timeout: 120_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.title-menu button')].some((b) => b.textContent.includes('campaign')),
    { timeout: 30_000 },
  );
  await clickButtonWithText(page, '.title-menu', 'campaign');
  await page.waitForSelector('.reticle', { timeout: 60_000 });

  await step('01-spawn', () => sleep(500));
  await step('02-walk', async () => {
    await page.keyboard.down('w');
    await sleep(4000);
    await page.keyboard.up('w');
  });
  await step('03-look', async () => {
    const canvas = await page.$('canvas.world-canvas');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Pointer fallback is hover-look: motion over the canvas rotates the view,
    // and any mouse button fires — so move only, never press.
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx + 300, cy, { steps: 20 });
    await sleep(300);
    await page.keyboard.press('r');
    await sleep(2500);
  });
  await step('04-sprint', async () => {
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await sleep(3000);
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
  });
  await step('05-jump', async () => {
    await page.keyboard.down('w');
    await page.keyboard.press('Space');
    await sleep(600);
    await page.keyboard.up('w');
  });
  await step('06-fire', async () => {
    const canvas = await page.$('canvas.world-canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sleep(1500);
    await page.mouse.up();
  });
  await step('07-pause', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pause-screen', { timeout: 10_000 });
  });
  await step(`08-${switchTier}-settings`, async () => {
    await clickButtonWithText(page, '.pause-menu', 'Settings');
    await page.waitForSelector('.quality-control', { timeout: 10_000 });
    await clickButtonWithText(page, '.quality-control', switchTier);
    await sleep(700);
  });
  await step(`09-${switchTier}-play`, async () => {
    await clickButtonWithText(page, '.settings-screen', 'Back');
    await page.waitForSelector('.pause-screen', { timeout: 10_000 });
    await clickButtonWithText(page, '.pause-menu', 'Return to Aethel');
    await page.waitForSelector('.reticle', { timeout: 15_000 });
    await sleep(3000);
  });
  const renderBuffer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.world-canvas');
    return canvas ? `${canvas.width}x${canvas.height}` : null;
  });
  await step(`10-${switchTier}-play-late`, () => sleep(9000));
  // Walk the approach toward Saint Orison (0, -54): swing the view back off
  // the look step's yaw, then run the road. Sena's lamp is the last before
  // the gate — the shot lands wherever the keys actually reach.
  await step('11-sena', async () => {
    const canvas = await page.$('canvas.world-canvas');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx + 300, cy);
    await page.mouse.move(cx, cy, { steps: 20 });
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await sleep(4500);
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
  });

  const report = {
    browser: executablePath,
    url: targetUrl,
    quality,
    switchTier,
    seedSettings,
    gpuPath,
    renderer,
    renderBuffer,
    console: consoleMessages,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    failedRequests,
    excluded,
    steps,
    totalWallMs: Date.now() - started,
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();

  console.log(`\nSmoke report: ${join(outDir, 'report.json')}`);
  console.log(`GPU path: ${gpuPath} · renderer: ${renderer} · render buffer: ${renderBuffer}`);
  console.log(`console: ${consoleMessages.length} messages · errors: ${consoleErrors.length} · warnings: ${consoleWarnings.length} · pageerror: ${pageErrors.length} · failed requests: ${failedRequests.length}`);
  consoleWarnings.forEach((warning) => console.log(`  warn: ${warning}`));
  consoleErrors.forEach((error) => console.log(`  error: ${error}`));
  pageErrors.forEach((error) => console.log(`  pageerror: ${error}`));
  if (consoleErrors.length || pageErrors.length) process.exit(1);
}

main().catch((error) => {
  console.error(`Smoke run failed: ${error.stack ?? error}`);
  process.exit(1);
});
