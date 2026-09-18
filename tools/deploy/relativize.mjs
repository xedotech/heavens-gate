#!/usr/bin/env node
// Rewrites absolute asset URLs in the static export to relative ones so the
// bundle works from any hosting path (project Pages /<repo>/, user-site root,
// itch.io iframes). Covers quoted href/src attrs, JSON-escaped RSC payloads,
// and unquoted CSS url() sources. Run after `npm run build`.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'dist/client';
const FILES = ['index.html', '404.html'];
const PAIRS = [
  ['"/_next/', '"./_next/'],
  ["'/_next/", "'./_next/"],
  ['url(/_next/', 'url(./_next/'],
  ['url("/_next/', 'url("./_next/'],
  ["url('/_next/", "url('./_next/"],
  ['"/favicon.svg', '"./favicon.svg'],
  ['"/index.rsc', '"./index.rsc'],
];

let total = 0;
for (const file of FILES) {
  const path = join(outDir, file);
  let data;
  try {
    data = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  let count = 0;
  for (const [from, to] of PAIRS) {
    const hits = data.split(from).length - 1;
    data = data.split(from).join(to);
    count += hits;
  }
  writeFileSync(path, data);
  console.log(`${file}: ${count} absolute URLs made relative`);
  total += count;
}
console.log(`relativize: ${total} total rewrites`);
