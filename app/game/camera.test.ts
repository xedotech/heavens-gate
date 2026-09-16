import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HeavensGateEngine } from './engine';

describe('camera world clearance', () => {
  it('preserves unobstructed camera smoothing', () => {
    const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 200);
    camera.position.set(0, 2.65, 5);
    const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
      camera, player: new THREE.Group(), playerVelocity: new THREE.Vector3(),
      currentVehicle: null, crouching: false, slideRemaining: 0, photoMode: false,
      cameraYaw: 0, cameraPitch: 0, isAiming: () => false, collisionBoxes: [],
    }) as { updateCamera(delta: number): void };
    engine.updateCamera(0.016);
    expect(camera.position.z).toBeCloseTo(5 + (4.55 - 5) * (1 - Math.exp(-9 * 0.016)));
    expect(camera.position.y).toBeCloseTo(2.65);
  });

  it('leaves the camera to the free cam during photo mode', () => {
    const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 200);
    camera.position.set(0, 2, 5);
    const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
      camera, player: new THREE.Group(), playerVelocity: new THREE.Vector3(),
      currentVehicle: null, crouching: false, slideRemaining: 0, photoMode: true,
      collisionBoxes: [],
    }) as { updateCamera(delta: number): void };
    engine.updateCamera(0.016);
    expect(camera.position.z).toBe(5);
  });
  it('flies the free cam along the view direction in photo mode', () => {
    const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 200);
    const photoCamPos = new THREE.Vector3(0, 3, 8);
    const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
      camera, photoCamPos, photoFov: 55, photoMode: true,
      cameraYaw: 0, cameraPitch: 0, cameraPosition: camera.position,
      isActionHeld: (action: string) => action === 'moveForward',
      gamepadAxes: { moveX: 0, moveY: 0, lookX: 0, lookY: 0, aim: 0, shoot: 0 },
      touchMove: { x: 0, y: 0 }, inspectionKey: null,
      collisionBoxes: [], elapsed: 0,
    }) as { updatePhotoCamera(delta: number): void };
    engine.updatePhotoCamera(0.016);
    // Facing -Z with forward held: the cam pushes forward along the view.
    expect(photoCamPos.z).toBeLessThan(8);
    expect(camera.position.z).toBe(photoCamPos.z);
  });
  it('pulls the interpolated camera in front of a wall behind the player', () => {
    const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 200);
    camera.position.set(0, 2.65, 5);
    const wall = new THREE.Box3(new THREE.Vector3(-5, 0, 2), new THREE.Vector3(5, 8, 3));
    const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
      camera, player: new THREE.Group(), playerVelocity: new THREE.Vector3(),
      currentVehicle: null, crouching: false, slideRemaining: 0, photoMode: false,
      cameraYaw: 0, cameraPitch: 0, isAiming: () => false, collisionBoxes: [wall],
    }) as { updateCamera(delta: number): void };
    engine.updateCamera(0.016);
    expect(camera.position.z).toBeLessThanOrEqual(1.75);
    expect(camera.position.z).toBeGreaterThan(0);
    expect(wall.containsPoint(camera.position)).toBe(false);
  });
});
