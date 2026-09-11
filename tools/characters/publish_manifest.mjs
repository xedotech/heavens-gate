import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const REQUIRED_ACTIONS = [
  'HG_Aim',
  'HG_Crouch',
  'HG_Death',
  'HG_Fire',
  'HG_Hit',
  'HG_Idle',
  'HG_Jump',
  'HG_Reload',
  'HG_Run',
  'HG_Slide',
  'HG_Walk',
];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function glbJson(bytes, file) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${file}: expected a binary glTF`);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/u, ''));
}

function assertExactActions(document, file) {
  const actual = (document.animations ?? []).map((animation) => animation.name).sort();
  const expected = [...REQUIRED_ACTIONS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${file}: expected ${expected.join(', ')}, received ${actual.join(', ')}`);
  }
}

function bodyMorphCount(document) {
  const body = (document.meshes ?? []).find((mesh) => /^base(?:\.|$)/u.test(mesh.name ?? ''));
  return body?.extras?.targetNames?.length ?? body?.primitives?.[0]?.targets?.length ?? 0;
}

const projectRoot = path.resolve(argument('--project', '.'));
const artifactsDirectory = path.resolve(projectRoot, argument('--artifacts', 'artifacts/characters'));
const publicDirectory = path.resolve(projectRoot, argument('--public', 'public/assets/characters'));
const manifestFile = path.resolve(projectRoot, argument('--manifest', 'public/assets/characters/manifest.json'));
const definitionsFile = path.resolve(projectRoot, argument('--definitions', 'tools/characters/characters.json'));
const definitions = JSON.parse(await readFile(definitionsFile, 'utf8'));

if (definitions.schemaVersion !== 1 || !Array.isArray(definitions.characters)) {
  throw new Error(`${definitionsFile}: unsupported character definition schema`);
}

await mkdir(publicDirectory, { recursive: true });
const characters = [];
const contracts = new Set();
const pendingCopies = [];

for (const definition of definitions.characters) {
  const file = `${definition.id}-hero.glb`;
  const artifactFile = path.join(artifactsDirectory, file);
  const reportFile = path.join(artifactsDirectory, `${definition.id}-hero.report.json`);
  const [bytes, reportText] = await Promise.all([readFile(artifactFile), readFile(reportFile, 'utf8')]);
  const document = glbJson(bytes, artifactFile);
  const report = JSON.parse(reportText);
  assertExactActions(document, artifactFile);

  const boneCount = document.skins?.[0]?.joints?.length ?? 0;
  const morphTargets = bodyMorphCount(document);
  const meshCount = document.meshes?.length ?? 0;
  const contract = `${boneCount}:${morphTargets}:${meshCount}`;
  contracts.add(contract);
  if (boneCount !== 53 || morphTargets !== 67 || meshCount !== 9) {
    throw new Error(`${file}: expected 53 bones, 67 facial morphs, and 9 meshes; received ${contract}`);
  }
  if (report.id !== definition.id || report.actionCount !== REQUIRED_ACTIONS.length) {
    throw new Error(`${reportFile}: report does not match the compiled asset`);
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Preflight the entire cast before replacing any delivered binary. A missing
  // or invalid later character must not leave the destination half-upgraded.
  pendingCopies.push([artifactFile, path.join(publicDirectory, file)]);
  characters.push({
    id: definition.id.replace(/^aurel-/, ''),
    file,
    bytes: bytes.byteLength,
    vertices: report.vertexCount,
    morphTargets,
    actions: REQUIRED_ACTIONS.length,
    bones: boneCount,
    meshes: meshCount,
    specSha256: report.specSha256,
    sha256,
  });
}

if (contracts.size !== 1) throw new Error(`Character contracts differ: ${[...contracts].join(', ')}`);

const manifest = {
  schemaVersion: 2,
  generatedBy: "Heaven's Gate Blender/MPFB character compiler",
  compilerVersion: 'hg-character-compiler-2',
  license: definitions.license,
  source: definitions.source,
  delivery: {
    format: 'glTF 2.0 binary',
    requiredExtensions: ['EXT_meshopt_compression', 'EXT_texture_webp'],
    boneCount: 53,
    actionCount: REQUIRED_ACTIONS.length,
    facialContract: '52 ARKit face units + 15 Meta visemes',
    morphTargetCount: 67,
    meshCount: 9,
  },
  characters,
};

for (const [source, destination] of pendingCopies) await copyFile(source, destination);
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ manifest: manifestFile, characters: characters.length, contracts: [...contracts] }));
