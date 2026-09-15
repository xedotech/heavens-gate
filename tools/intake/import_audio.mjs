#!/usr/bin/env node
// Copy licensed foley into public/assets/audio with a sha256 manifest.
// Kenney impact/footstep OGGs are CC0 (Sources/Kenney-Source.html);
// Owlish Media recorded foley WAVs are CC0 (Sources/Owlish-CC0.html).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIO_ROOT = path.join(ROOT, 'production-resources', 'Audio');
const OUTPUT_ROOT = path.join(ROOT, 'public', 'assets', 'audio');
const BYTE_BUDGET = 8 * 1024 * 1024;

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

const KENNEY = path.join(AUDIO_ROOT, 'Impact-Sounds', 'Audio');
const OWLISH = path.join(AUDIO_ROOT, 'Recorded-Foley', 'Owlish-Media');

const entries = [
  ...range(5, (i) => ({ dir: KENNEY, file: `footstep_concrete_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...range(5, (i) => ({ dir: KENNEY, file: `footstep_wood_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...range(5, (i) => ({ dir: KENNEY, file: `impactMetal_light_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...range(5, (i) => ({ dir: KENNEY, file: `impactGeneric_light_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...range(5, (i) => ({ dir: KENNEY, file: `impactSoft_medium_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...range(5, (i) => ({ dir: KENNEY, file: `impactPunch_medium_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...range(3, (i) => ({ dir: KENNEY, file: `impactGlass_light_00${i}.ogg`, license: 'CC0-1.0 (Kenney)' })),
  ...['hard-footstep1', 'hard-footstep2', 'hard-footstep3', 'hard-footstep4', 'heel-reverb2', 'heel-reverb4']
    .map((f) => ({ dir: path.join(OWLISH, 'Footsteps'), file: `${f}.wav`, license: 'CC0-1.0 (Owlish Media)' })),
];

// Three shortest cloth-rustle WAVs.
const rustleDir = path.join(OWLISH, 'Cloth, Rustle');
const rustles = fs.readdirSync(rustleDir)
  .filter((f) => f.endsWith('.wav'))
  .map((f) => ({ file: f, bytes: fs.statSync(path.join(rustleDir, f)).size }))
  .sort((a, b) => a.bytes - b.bytes)
  .slice(0, 3);
for (const r of rustles) {
  entries.push({ dir: rustleDir, file: r.file, license: 'CC0-1.0 (Owlish Media)' });
}

// OGG duration from the last page's granule position / stream sample rate.
function oggDurationSeconds(file) {
  const buf = fs.readFileSync(file);
  let sampleRate = 0;
  let lastGranule = 0;
  let offset = 0;
  while (offset + 27 <= buf.length) {
    if (buf.readUInt32BE(offset) !== 0x4f676753) break; // 'OggS'
    const granule = Number(buf.readBigUInt64LE(offset + 6));
    const pageSegments = buf[offset + 26];
    const segStart = offset + 27;
    let body = 0;
    for (let i = 0; i < pageSegments; i++) body += buf[segStart + i];
    const bodyStart = segStart + pageSegments;
    // Vorbis identification header: \x01vorbis, uint32 sample rate at +12.
    if (buf[bodyStart] === 0x01 && buf.toString('ascii', bodyStart + 1, bodyStart + 7) === 'vorbis') {
      sampleRate = buf.readUInt32LE(bodyStart + 12);
    }
    if (granule > lastGranule) lastGranule = granule;
    offset = bodyStart + body;
  }
  return sampleRate > 0 ? lastGranule / sampleRate : 0;
}

const rainDir = path.join(AUDIO_ROOT, 'Rain', 'OGG');
const rainFiles = fs.readdirSync(rainDir).filter((f) => f.endsWith('.ogg'));
console.log('Rain candidates:');
let rainPick = null;
for (const f of rainFiles) {
  const p = path.join(rainDir, f);
  const dur = oggDurationSeconds(p);
  console.log(`  ${f}  ${(fs.statSync(p).size / 1024).toFixed(0)} KiB  ${dur.toFixed(1)} s`);
  if (dur >= 15 && (!rainPick || dur > rainPick.dur)) rainPick = { file: f, dur };
}
if (!rainPick) throw new Error('no rain OGG ≥ 15 s found');
entries.push({ dir: rainDir, file: rainPick.file, license: 'CC0-1.0' });
console.log(`Picked rain loop: ${rainPick.file} (${rainPick.dur.toFixed(1)} s)\n`);

fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
const manifest = { schemaVersion: 1, clips: [] };
let total = 0;
for (const e of entries) {
  const src = path.join(e.dir, e.file);
  if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
  const buffer = fs.readFileSync(src);
  const id = e.file.replace(/\.(ogg|wav)$/i, '').replaceAll('_', '-').toLowerCase();
  fs.writeFileSync(path.join(OUTPUT_ROOT, e.file), buffer);
  manifest.clips.push({
    id,
    file: e.file,
    sha256: sha256Hex(buffer),
    bytes: buffer.length,
    license: e.license,
  });
  total += buffer.length;
}

const temp = path.join(OUTPUT_ROOT, 'manifest.json.tmp');
fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
fs.renameSync(temp, path.join(OUTPUT_ROOT, 'manifest.json'));

console.log(`Wrote ${manifest.clips.length} clips, total ${(total / 1048576).toFixed(2)} MB`);
if (total > BYTE_BUDGET) console.warn(`WARN: exceeds ${BYTE_BUDGET / 1048576} MB budget`);
