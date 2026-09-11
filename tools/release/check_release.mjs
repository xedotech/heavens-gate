import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd());
const requiredFiles = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'public/assets/characters/manifest.json',
];
const failures = [];

for (const relative of requiredFiles) {
  try {
    await access(path.join(root, relative));
  } catch {
    failures.push(`missing ${relative}`);
  }
}

try {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.license !== 'MIT') failures.push('package license must remain MIT');
  if (!/^0\.1\.\d+(?:-[0-9a-z.-]+)?$/iu.test(packageJson.version ?? '')) {
    failures.push(`version ${String(packageJson.version)} is not a pre-release train`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

try {
  const manifest = JSON.parse(await readFile(path.join(root, 'public/assets/characters/manifest.json'), 'utf8'));
  const ids = (manifest.characters ?? []).map((entry) => entry.id).sort();
  const expected = ['ash', 'meridian', 'nocturne', 'relic', 'seraph', 'voidborn'];
  if (manifest.schemaVersion !== 2 || manifest.delivery?.actionCount !== 11) {
    failures.push('character manifest schema or action contract is stale');
  }
  if (JSON.stringify(ids) !== JSON.stringify(expected)) failures.push('character manifest roster is incomplete');
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

const result = { requiredFiles: requiredFiles.length, failures };
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
