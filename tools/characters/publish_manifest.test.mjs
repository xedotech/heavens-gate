import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const publisher = fileURLToPath(new URL('./publish_manifest.mjs', import.meta.url));
const actions = ['Aim', 'Crouch', 'Death', 'Fire', 'Hit', 'Idle', 'Jump', 'Reload', 'Run', 'Slide', 'Walk'];

function fixtureGlb(bones = 53) {
  const json = Buffer.from(JSON.stringify({
    skins: [{ joints: Array.from({ length: bones }, (_, i) => i) }],
    meshes: Array.from({ length: 9 }, (_, i) => ({ name: i ? `mesh${i}` : 'base',
      extras: { targetNames: Array.from({ length: 67 }, (_, n) => `morph${n}`) } })),
    animations: actions.map((name) => ({ name: `HG_${name}` })),
  }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}

for (const failure of ['missing later report', 'invalid later skeleton']) {
  test(`preflight preserves delivered files on ${failure}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hg-publisher-test-'));
    try {
      const source = path.join(directory, 'source');
      const delivery = path.join(directory, 'delivery');
      await mkdir(source);
      await mkdir(delivery);
      await writeFile(path.join(directory, 'definitions.json'), JSON.stringify({
        schemaVersion: 1, characters: [{ id: 'aurel-seraph' }, { id: 'aurel-relic' }],
      }));
      for (const id of ['aurel-seraph', 'aurel-relic']) {
        await writeFile(path.join(source, `${id}-hero.glb`), fixtureGlb(
          id === 'aurel-relic' && failure === 'invalid later skeleton' ? 52 : 53));
        if (id === 'aurel-relic' && failure === 'missing later report') continue;
        await writeFile(path.join(source, `${id}-hero.report.json`), JSON.stringify({ id, actionCount: 11 }));
      }
      const oldAsset = path.join(delivery, 'aurel-seraph-hero.glb');
      const manifest = path.join(delivery, 'manifest.json');
      await writeFile(oldAsset, 'previous matched cast');
      await writeFile(manifest, 'previous manifest');
      const result = spawnSync(process.execPath, [publisher, '--project', directory,
        '--artifacts', 'source', '--public', 'delivery', '--manifest', 'delivery/manifest.json',
        '--definitions', 'definitions.json'], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, failure === 'missing later report' ? /ENOENT/ : /expected 53 bones/);
      assert.equal(await readFile(oldAsset, 'utf8'), 'previous matched cast');
      assert.equal(await readFile(manifest, 'utf8'), 'previous manifest');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
