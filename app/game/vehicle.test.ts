import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { HeavensGateEngine } from './engine';

function harness(wall: boolean) {
  const vehicle = { group: new THREE.Group(), speed: 38, heading: 0, occupied: true, bodyMaterial: new THREE.MeshStandardMaterial() };
  const player = new THREE.Group();
  player.visible = false;
  const audio = { explosion: vi.fn(), setEngine: vi.fn(), ui: vi.fn() };
  const takePlayerDamage = vi.fn();
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
    currentVehicle: vehicle, player, audio, takePlayerDamage,
    playerVelocity: new THREE.Vector3(), emitToast: vi.fn(),
    gamepadAxes: { moveX: 0, moveY: 0 },
    isActionHeld: (action: string) => action === 'moveForward',
    collisionBoxes: wall ? [new THREE.Box3(new THREE.Vector3(-5, 0, -3), new THREE.Vector3(5, 8, -2.9))] : [],
  }) as { updateVehicle(delta: number): void; exitVehicle(): void; currentVehicle: typeof vehicle | null; collisionBoxes: THREE.Box3[]; collides(x: number, z: number, radius: number): boolean };
  return { engine, vehicle, player, audio, takePlayerDamage };
}

describe('vehicle engine collision integration', () => {
  it('finds a clear exit when both sides are blocked', () => {
    const { engine, player } = harness(false);
    engine.collisionBoxes = [
      new THREE.Box3(new THREE.Vector3(2.5, 0, -2), new THREE.Vector3(4, 8, 2)),
      new THREE.Box3(new THREE.Vector3(-4, 0, -2), new THREE.Vector3(-2.5, 8, 2)),
    ];
    engine.exitVehicle();
    expect(engine.currentVehicle).toBeNull();
    expect(engine.collides(player.position.x, player.position.z, 1.05)).toBe(false);
  });

  it('preserves occupancy when every exit is blocked', () => {
    const { engine, vehicle, player, audio } = harness(false);
    engine.collisionBoxes = [new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 8, 10))];
    engine.exitVehicle();
    expect(engine.currentVehicle).toBe(vehicle);
    expect(vehicle.occupied).toBe(true);
    expect(player.visible).toBe(false);
    expect(audio.setEngine).not.toHaveBeenCalled();
    expect(audio.ui).not.toHaveBeenCalled();
  });

  it('rotates the preferred exit with vehicle heading', () => {
    const { engine, vehicle, player } = harness(false);
    vehicle.heading = Math.PI / 2;
    engine.exitVehicle();
    expect(player.position.x).toBeCloseTo(0);
    expect(player.position.z).toBeCloseTo(-3.3);
  });

  it('rejects a clear destination reached through a wall', () => {
    const { engine, player } = harness(false);
    engine.collisionBoxes = [new THREE.Box3(new THREE.Vector3(1.5, 0, -2), new THREE.Vector3(1.6, 8, 2))];
    // The preferred endpoint is clear; only its path intersects this wall.
    expect(engine.collides(3.3, 0, 1.05)).toBe(false);
    engine.exitVehicle();
    expect(player.position.x).toBeCloseTo(-3.3);
  });

  it('chooses an inward exit at the world boundary', () => {
    const { engine, vehicle, player } = harness(false);
    vehicle.group.position.set(167, 0, 0);
    engine.exitVehicle();
    expect(player.position.x).toBeCloseTo(163.7);
    expect(engine.currentVehicle).toBeNull();
  });
  it('advances to a safe pre-impact position, rebounds, and emits one impact', () => {
    const { engine, vehicle, player, audio, takePlayerDamage } = harness(true);
    engine.updateVehicle(0.05);
    expect(vehicle.group.position.z).toBeLessThan(0);
    expect(vehicle.group.position.z).toBeGreaterThanOrEqual(-0.65);
    expect(vehicle.speed).toBeLessThan(0);
    expect(player.position.equals(vehicle.group.position)).toBe(true);
    expect(takePlayerDamage).toHaveBeenCalledOnce();
    expect(audio.explosion).toHaveBeenCalledOnce();
    expect(audio.setEngine).toHaveBeenCalledWith(vehicle.speed, true);
  });

  it('preserves free driving without impact damage or collision audio', () => {
    const { engine, vehicle, player, audio, takePlayerDamage } = harness(false);
    engine.updateVehicle(0.05);
    expect(vehicle.group.position.z).toBeCloseTo(-1.9);
    expect(vehicle.speed).toBe(38);
    expect(player.position.equals(vehicle.group.position)).toBe(true);
    expect(takePlayerDamage).not.toHaveBeenCalled();
    expect(audio.explosion).not.toHaveBeenCalled();
  });
});
