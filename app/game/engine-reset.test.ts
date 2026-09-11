import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { HeavensGateEngine } from './engine';
import type { SaveState } from './types';

// Invoke real reset logic without constructing a renderer or audio context.
interface ResetHarness {
  resetCampaign(save: SaveState | null): void;
  photoMode: boolean;
  scene: THREE.Scene;
  actors: unknown[];
  rayTargets: THREE.Object3D[];
  boss: unknown;
  heroCharacter: { resetAnimation: ReturnType<typeof vi.fn> };
}
function harness() {
  return Object.assign(Object.create(HeavensGateEngine.prototype), {
    photoMode: true, player: new THREE.Group(), playerVelocity: new THREE.Vector3(),
    scene: new THREE.Scene(), vehicles: [], actors: [], echoes: [], gates: [],
    rayTargets: [], boss: null, setVeil: vi.fn(), applyEndingWorld: vi.fn(),
    heroCharacter: { resetAnimation: vi.fn() },
  }) as ResetHarness;
}
const checkpoint: SaveState = {
  version: 1, missionIndex: 0, health: 80, armor: 20, ammo: 10, reserveAmmo: 100,
  resonance: 80, defeatedWardens: 0, echoesActivated: [], elapsed: 10, updatedAt: 1,
};

describe('campaign reset integration', () => {
  it.each([null, checkpoint])('closes inspection on new/retried campaign', (save) => {
    const engine = harness();
    engine.resetCampaign(save);
    expect(engine.photoMode).toBe(false);
    expect(engine.heroCharacter.resetAnimation).toHaveBeenCalledOnce();
  });

  it('removes old boss targets and disposes shared resources once across repeated resets', () => {
    const engine = harness();
    const worldTarget = new THREE.Object3D();
    engine.scene.add(worldTarget);
    engine.rayTargets.push(worldTarget);
    for (let attempt = 0; attempt < 3; attempt++) {
      const group = new THREE.Group();
      const geometry = new THREE.BoxGeometry();
      const material = new THREE.MeshBasicMaterial();
      const geometryDisposed = vi.fn();
      const materialDisposed = vi.fn();
      geometry.addEventListener('dispose', geometryDisposed);
      material.addEventListener('dispose', materialDisposed);
      const meshes = [new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material)];
      group.add(...meshes);
      const boss = { id: 'boss', kind: 'boss', group, spawn: new THREE.Vector3(), maxHealth: 100 };
      engine.boss = boss;
      engine.actors.push(boss);
      engine.scene.add(group);
      engine.rayTargets.push(...meshes);
      engine.resetCampaign(checkpoint);
      expect(engine.rayTargets).toEqual([worldTarget]);
      expect(engine.scene.children).toEqual([worldTarget]);
      expect(engine.actors).toHaveLength(0);
      expect(engine.boss).toBeNull();
      expect(geometryDisposed).toHaveBeenCalledTimes(1);
      expect(materialDisposed).toHaveBeenCalledTimes(1);
    }
  });
});
