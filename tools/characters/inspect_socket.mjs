import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const asset = path.resolve(process.argv[2] ?? 'public/assets/characters/aurel-seraph-hero.glb');
const bytes = await readFile(asset);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${asset} is not a binary glTF file`);

const jsonLength = view.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/u, ''));
const binHeader = 20 + jsonLength;
const binLength = view.getUint32(binHeader, true);
const binStart = binHeader + 8;
const bin = bytes.subarray(binStart, binStart + binLength);
const itemSizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const decodedBufferViews = new Map();
await MeshoptDecoder.ready;

function resolveBufferView(index) {
  const bufferView = json.bufferViews[index];
  const extension = bufferView.extensions?.EXT_meshopt_compression;
  if (!extension) {
    return {
      bytes: bin,
      byteOffset: bufferView.byteOffset ?? 0,
      byteStride: bufferView.byteStride,
    };
  }
  if (!decodedBufferViews.has(index)) {
    const source = bin.subarray(extension.byteOffset ?? 0, (extension.byteOffset ?? 0) + extension.byteLength);
    const decoded = new Uint8Array(extension.count * extension.byteStride);
    MeshoptDecoder.decodeGltfBuffer(decoded, extension.count, extension.byteStride, source, extension.mode, extension.filter);
    decodedBufferViews.set(index, decoded);
  }
  return {
    bytes: decodedBufferViews.get(index),
    byteOffset: 0,
    byteStride: extension.byteStride,
  };
}

function readAccessor(index) {
  const accessor = json.accessors[index];
  const bufferView = json.bufferViews[accessor.bufferView];
  const resolved = resolveBufferView(accessor.bufferView);
  const componentSizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const componentSize = componentSizes[accessor.componentType];
  if (!componentSize) throw new Error(`Unsupported component type ${accessor.componentType} in accessor ${index}`);
  const itemSize = itemSizes[accessor.type];
  const byteOffset = resolved.byteOffset + (accessor.byteOffset ?? 0);
  const stride = resolved.byteStride ?? bufferView.byteStride ?? itemSize * componentSize;
  const output = [];
  const data = new DataView(resolved.bytes.buffer, resolved.bytes.byteOffset, resolved.bytes.byteLength);
  const readComponent = (offset) => {
    let value;
    if (accessor.componentType === 5120) value = data.getInt8(offset);
    else if (accessor.componentType === 5121) value = data.getUint8(offset);
    else if (accessor.componentType === 5122) value = data.getInt16(offset, true);
    else if (accessor.componentType === 5123) value = data.getUint16(offset, true);
    else if (accessor.componentType === 5125) value = data.getUint32(offset, true);
    else value = data.getFloat32(offset, true);
    if (!accessor.normalized) return value;
    if (accessor.componentType === 5120) return Math.max(value / 127, -1);
    if (accessor.componentType === 5121) return value / 255;
    if (accessor.componentType === 5122) return Math.max(value / 32767, -1);
    if (accessor.componentType === 5123) return value / 65535;
    return value;
  };
  for (let item = 0; item < accessor.count; item += 1) {
    const values = [];
    for (let component = 0; component < itemSize; component += 1) {
      values.push(readComponent(byteOffset + item * stride + component * componentSize));
    }
    output.push(values);
  }
  return output;
}

const objects = json.nodes.map((node) => {
  const object = new THREE.Object3D();
  object.name = node.name ?? '';
  if (node.matrix) object.matrix.fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
  else {
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
  }
  return object;
});

json.nodes.forEach((node, index) => {
  for (const child of node.children ?? []) objects[index].add(objects[child]);
});
const childNodes = new Set(json.nodes.flatMap((node) => node.children ?? []));
const root = new THREE.Group();
objects.forEach((object, index) => { if (!childNodes.has(index)) root.add(object); });

function sample(values, times, time, interpolation, isQuaternion) {
  if (time <= times[0][0]) return values[interpolation === 'CUBICSPLINE' ? 1 : 0];
  const finalIndex = times.length - 1;
  if (time >= times[finalIndex][0]) return values[interpolation === 'CUBICSPLINE' ? finalIndex * 3 + 1 : finalIndex];
  let upper = 1;
  while (times[upper][0] < time) upper += 1;
  const lower = upper - 1;
  const alpha = (time - times[lower][0]) / (times[upper][0] - times[lower][0]);
  if (interpolation === 'STEP') return values[lower];
  const lowerValue = values[interpolation === 'CUBICSPLINE' ? lower * 3 + 1 : lower];
  const upperValue = values[interpolation === 'CUBICSPLINE' ? upper * 3 + 1 : upper];
  if (isQuaternion) {
    return new THREE.Quaternion().fromArray(lowerValue).slerp(new THREE.Quaternion().fromArray(upperValue), alpha).toArray();
  }
  return lowerValue.map((value, component) => THREE.MathUtils.lerp(value, upperValue[component], alpha));
}

function applyAnimation(name, time) {
  const animation = json.animations.find((candidate) => candidate.name === name);
  if (!animation) return false;
  for (const channel of animation.channels) {
    const target = objects[channel.target.node];
    if (!target) continue;
    const sampler = animation.samplers[channel.sampler];
    const values = readAccessor(sampler.output);
    const times = readAccessor(sampler.input);
    const sampled = sample(values, times, time, sampler.interpolation ?? 'LINEAR', channel.target.path === 'rotation');
    if (channel.target.path === 'translation') target.position.fromArray(sampled);
    else if (channel.target.path === 'rotation') target.quaternion.fromArray(sampled).normalize();
    else if (channel.target.path === 'scale') target.scale.fromArray(sampled);
  }
  return true;
}

const handIndex = json.nodes.findIndex((node) => node.name === 'hand_r');
if (handIndex < 0) throw new Error(`hand_r was not found in ${asset}`);
const hand = objects[handIndex];

function describe(label) {
  root.updateMatrixWorld(true);
  const worldPosition = hand.getWorldPosition(new THREE.Vector3());
  const worldQuaternion = hand.getWorldQuaternion(new THREE.Quaternion());
  const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(worldQuaternion).toArray().map((value) => Number(value.toFixed(5)));
  console.log(JSON.stringify({
    label,
    parent: hand.parent?.name,
    localPosition: hand.position.toArray().map((value) => Number(value.toFixed(5))),
    localQuaternion: hand.quaternion.toArray().map((value) => Number(value.toFixed(5))),
    worldPosition: worldPosition.toArray().map((value) => Number(value.toFixed(5))),
    worldQuaternion: worldQuaternion.toArray().map((value) => Number(value.toFixed(5))),
    worldLocalX: axis(1, 0, 0),
    worldLocalY: axis(0, 1, 0),
    worldLocalZ: axis(0, 0, 1),
  }, null, 2));
}

describe('bind');
const idleName = json.animations.map((animation) => animation.name).find((name) => /idle/i.test(name));
if (idleName && applyAnimation(idleName, 0.5)) describe(`${idleName}@0.5`);
else console.log(JSON.stringify({ animations: json.animations.map((animation) => animation.name) }, null, 2));
