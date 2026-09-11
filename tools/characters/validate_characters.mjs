import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const REQUIRED_ACTIONS = [
  'HG_Aim', 'HG_Crouch', 'HG_Death', 'HG_Fire', 'HG_Hit', 'HG_Idle',
  'HG_Jump', 'HG_Reload', 'HG_Run', 'HG_Slide', 'HG_Walk',
];
// Tracks are intentionally sparse: un-authored bones must retain the glTF
// bind pose, otherwise a zero Euler key overwrites the imported rest rotation
// and produces a visible mannequin/T-pose.  These floors protect authored
// intent per clip without demanding every bone on every action.
const MIN_CHANNELS = {
  HG_Aim: 7, HG_Crouch: 8, HG_Death: 8, HG_Fire: 7, HG_Hit: 4,
  HG_Idle: 3, HG_Jump: 7, HG_Reload: 7, HG_Run: 12, HG_Slide: 9, HG_Walk: 11,
};
const MIN_DURATION_SECONDS = {
  HG_Aim: 0.2, HG_Crouch: 0.8, HG_Death: 0.9, HG_Fire: 0.18, HG_Hit: 0.1,
  HG_Idle: 2.5, HG_Jump: 0.4, HG_Reload: 1, HG_Run: 0.6, HG_Slide: 0.5, HG_Walk: 0.8,
};
const root = path.resolve(process.cwd());
const manifestFile = path.resolve(root, process.argv[2] ?? 'public/assets/characters/manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const failures = [];
const results = [];
const expectedIds = ['seraph', 'relic', 'nocturne', 'ash', 'meridian', 'voidborn'];
if (manifest.schemaVersion !== 2 || manifest.characters?.length !== expectedIds.length
  || expectedIds.some((id) => manifest.characters.filter((entry) => entry.id === id).length !== 1)) {
  failures.push('Manifest must contain exactly the six unique schema-2 hero identities');
}

function parseGlb(bytes, file) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${file}: invalid GLB magic`);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/u, ''));
}

for (const entry of manifest.characters ?? []) {
  const file = path.resolve(path.dirname(manifestFile), entry.file);
  try {
    if (!/^aurel-[a-z]+-hero\.glb$/.test(entry.file)) throw new Error('Unsafe character filename');
    const bytes = await readFile(file);
    const document = parseGlb(bytes, file);
    const body = (document.meshes ?? []).find((mesh) => /^base(?:\.|$)/u.test(mesh.name ?? ''));
    const actionNames = (document.animations ?? []).map((animation) => animation.name).sort();
    const expectedActions = [...REQUIRED_ACTIONS].sort();
    const boneCount = document.skins?.[0]?.joints?.length ?? 0;
    const morphTargets = body?.extras?.targetNames?.length ?? body?.primitives?.[0]?.targets?.length ?? 0;
    const roles = new Set((document.materials ?? []).map((material) => material.extras?.hg_material_role));
    const channelCounts = Object.fromEntries((document.animations ?? []).map((animation) => [
      animation.name,
      animation.channels?.length ?? 0,
    ]));
    const animationDurations = Object.fromEntries((document.animations ?? []).map((animation) => {
      const duration = Math.max(0, ...(animation.samplers ?? []).map((sampler) => {
        const accessor = document.accessors?.[sampler.input];
        const minimum = accessor?.min?.[0] ?? 0;
        const maximum = accessor?.max?.[0] ?? minimum;
        return maximum - minimum;
      }));
      return [animation.name, Number(duration.toFixed(4))];
    }));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const checks = {
      bytes: bytes.byteLength === entry.bytes,
      sha256: sha256 === entry.sha256,
      actionNames: JSON.stringify(actionNames) === JSON.stringify(expectedActions),
      bones: boneCount === 53,
      morphTargets: morphTargets === 67,
      meshes: (document.meshes ?? []).length === 9,
      materialRoles: roles.has('skin') && roles.has('hair') && roles.has('cloth') && roles.has('footwear'),
      clothCoating: (document.materials ?? []).filter((material) => material.extras?.hg_material_role === 'cloth')
        .every((material) => (material.extensions?.KHR_materials_clearcoat?.clearcoatFactor ?? 0) === 0),
      eyeOverlayAlpha: (document.materials ?? []).some((material) => material.extras?.hg_material_role === 'eye'
        && ['MASK', 'BLEND'].includes(material.alphaMode)
        && material.pbrMetallicRoughness?.baseColorTexture !== undefined),
      animationChannels: expectedActions.every((name) => {
        const count = channelCounts[name] ?? 0;
        return count >= MIN_CHANNELS[name] && count <= 22;
      }),
      animationDurations: expectedActions.every((name) => (
        (animationDurations[name] ?? 0) >= MIN_DURATION_SECONDS[name]
      )),
      extensions: ['EXT_meshopt_compression', 'EXT_texture_webp'].every((name) => (document.extensionsRequired ?? []).includes(name)),
    };
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedChecks.length) failures.push(`${entry.file}: ${failedChecks.join(', ')}`);
    results.push({ id: entry.id, file: entry.file, bytes: bytes.byteLength, sha256, boneCount, morphTargets, meshCount: document.meshes?.length ?? 0, actionCount: actionNames.length, channelCounts, animationDurations, checks });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

const report = { manifest: manifestFile, characterCount: results.length, failures, results };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
