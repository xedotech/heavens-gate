import { readFile } from 'node:fs/promises';
import path from 'node:path';

const asset = path.resolve(process.argv[2] ?? 'public/assets/characters/aurel-seraph-hero.glb');
const bytes = await readFile(asset);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

if (view.getUint32(0, true) !== 0x46546c67) {
  throw new Error(`${asset} is not a binary glTF file`);
}

const jsonLength = view.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/u, ''));
const materialMeshes = new Map();

for (const mesh of json.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    if (primitive.material === undefined) continue;
    const names = materialMeshes.get(primitive.material) ?? [];
    names.push(mesh.name ?? `mesh-${materialMeshes.size}`);
    materialMeshes.set(primitive.material, names);
  }
}

const materials = (json.materials ?? []).map((material, index) => ({
  index,
  name: material.name ?? `material-${index}`,
  meshes: [...new Set(materialMeshes.get(index) ?? [])],
  alphaMode: material.alphaMode ?? 'OPAQUE',
  alphaCutoff: material.alphaCutoff ?? null,
  doubleSided: material.doubleSided ?? false,
  baseColorFactor: material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1],
  baseColorTexture: material.pbrMetallicRoughness?.baseColorTexture?.index ?? null,
  normalTexture: material.normalTexture?.index ?? null,
  extras: material.extras ?? {},
}));

console.log(JSON.stringify({
  asset,
  extensionsRequired: json.extensionsRequired ?? [],
  extensionsUsed: json.extensionsUsed ?? [],
  sceneCount: json.scenes?.length ?? 0,
  nodeCount: json.nodes?.length ?? 0,
  meshCount: json.meshes?.length ?? 0,
  meshes: (json.meshes ?? []).map((mesh, index) => ({
    index,
    name: mesh.name ?? `mesh-${index}`,
    weights: mesh.weights?.length ?? 0,
    primitiveTargets: mesh.primitives?.map((primitive) => primitive.targets?.length ?? 0) ?? [],
    extras: mesh.extras ?? {},
  })),
  skinCount: json.skins?.length ?? 0,
  animations: (json.animations ?? []).map((animation) => ({
    name: animation.name,
    channelCount: animation.channels?.length ?? 0,
    targetNodeCount: new Set((animation.channels ?? []).map((channel) => channel.target.node)).size,
    targetPaths: [...new Set((animation.channels ?? []).map((channel) => channel.target.path))].sort(),
  })),
  imageMimeTypes: (json.images ?? []).map((image) => image.mimeType ?? null),
  materials,
}, null, 2));
