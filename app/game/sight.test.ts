import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { HeavensGateEngine } from './engine';

function sight(boxes: THREE.Box3[], from: THREE.Vector3, to: THREE.Vector3) {
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), { collisionBoxes: boxes }) as {
    hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean;
  };
  return engine.hasLineOfSight(from, to);
}
const box = (min: number[], max: number[]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

describe('world sight occlusion', () => {
  it('blocks player damage when the camera sees a target but the muzzle is behind cover', () => {
    const scene = new THREE.Scene();
    const target = new THREE.Mesh(new THREE.SphereGeometry(2), new THREE.MeshBasicMaterial());
    target.position.set(0, 1.6, -10);
    target.userData.actorId = 'target';
    scene.add(target);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    camera.position.set(0, 1.6, 0);
    camera.updateMatrixWorld(true);
    const player = new THREE.Group();
    player.position.set(3, 0, 0);
    const damageActor = vi.fn();
    const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
      scene, camera, player, playerVelocity: new THREE.Vector3(),
      shotCooldown: 0, reloading: 0, currentVehicle: null, paused: false,
      ammo: 10, reserveAmmo: 0, weaponRecoil: 0, cameraPitch: 0, elapsed: 0, shotIndex: 0,
      isAiming: () => true, pulseGamepad: vi.fn(),
      audio: { shoot: vi.fn(), hit: vi.fn() },
      rayTargets: [target], actors: [{ id: 'target', alive: true, kind: 'warden' }],
      collisionBoxes: [box([1, 0, -5], [2, 3, 1])],
      createMuzzleFlash: vi.fn(), createTracer: vi.fn(), createImpact: vi.fn(), damageActor,
    }) as { tryShoot(): void; collisionBoxes: THREE.Box3[]; shotCooldown: number };
    engine.tryShoot();
    expect(damageActor).not.toHaveBeenCalled();
    engine.collisionBoxes = [];
    engine.shotCooldown = 0;
    engine.tryShoot();
    expect(damageActor).toHaveBeenCalledOnce();
    target.geometry.dispose();
    target.material.dispose();
  });
  it('returns the nearest obstruction independent of collider order', () => {
    const near = box([2, 0, -1], [3, 3, 1]);
    const far = box([6, 0, -1], [7, 3, 1]);
    const from = new THREE.Vector3(0, 1.5, 0);
    const to = new THREE.Vector3(10, 1.5, 0);
    for (const collisionBoxes of [[far, near], [near, far]]) {
      const engine = Object.assign(Object.create(HeavensGateEngine.prototype), { collisionBoxes }) as {
        firstWorldObstruction(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 | null;
      };
      expect(engine.firstWorldObstruction(from, to)?.x).toBe(2);
      expect(from.toArray()).toEqual([0, 1.5, 0]);
      expect(to.toArray()).toEqual([10, 1.5, 0]);
    }
  });

  it('blocks shots originating inside overlapping cover', () => {
    expect(sight([box([-1, 0, -1], [1, 3, 1]), box([0, 0, -1], [2, 3, 1])],
      new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(4, 1.5, 0))).toBe(false);
  });
  it('stops enemy damage and tracers at intervening cover', () => {
    const player = new THREE.Group();
    player.position.set(10, 0, 0);
    const damage = vi.fn();
    const tracer = vi.fn();
    const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
      player, currentVehicle: null, camera: new THREE.PerspectiveCamera(), cameraYaw: 0,
      audio: { enemyShot: vi.fn() }, settings: { difficulty: 'normal' },
      collisionBoxes: [box([4, -10, -10], [4.1, 10, 10])],
      takePlayerDamage: damage, createTracer: tracer, elapsed: 0,
    }) as { enemyFire(actor: unknown, damage: number): void; elapsed: number; collisionBoxes: THREE.Box3[] };
    const actor = { group: new THREE.Group(), kind: 'boss', id: 'test-guard' };
    for (let index = 0; index < 20; index++) {
      engine.elapsed = index;
      engine.enemyFire(actor, 10);
    }
    expect(damage).not.toHaveBeenCalled();
    expect(tracer).toHaveBeenCalledTimes(20);
    for (const call of tracer.mock.calls) expect((call[1] as THREE.Vector3).x).toBeCloseTo(4);
    engine.collisionBoxes = [];
    for (let index = 0; index < 20; index++) {
      engine.elapsed = index;
      engine.enemyFire(actor, 10);
    }
    expect(damage).toHaveBeenCalled();
  });
  it('detects thin walls between the old sample intervals', () => {
    expect(sight([box([0.9, 0, -1], [1, 3, 1])], new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(4, 1.5, 0))).toBe(false);
  });
  it('sees over low obstacles', () => {
    expect(sight([box([1, 0, -1], [3, 0.7, 1])], new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(4, 1.5, 0))).toBe(true);
  });
  it('blocks vertical sight through an overhead slab', () => {
    expect(sight([box([-1, 2, -1], [1, 2.2, 1])], new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 4, 0))).toBe(false);
  });
  it('ignores geometry beyond the target', () => {
    expect(sight([box([5, 0, -1], [6, 3, 1])], new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(4, 1.5, 0))).toBe(true);
  });
});
