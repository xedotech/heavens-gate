import { describe, expect, it } from 'vitest';
import {
  MOVEMENT_SPEC,
  canStartDodge,
  canStartSlide,
  movementSpeed,
  slideSpeed,
  smoothHeading,
  resolvePlanarCollision,
  sweepPlanarCollision,
  updateStamina,
} from './movement';

describe('player movement model', () => {
  it('preserves free movement and slides along either wall axis', () => {
    const from = { x: 0, z: 0 };
    const to = { x: 1, z: 2 };
    expect(resolvePlanarCollision(from, to, () => false)).toEqual({ ...to, blockedX: false, blockedZ: false });
    expect(resolvePlanarCollision(from, to, (x) => x > 0.5)).toEqual({ x: 0, z: 2, blockedX: true, blockedZ: false });
    expect(resolvePlanarCollision(from, to, (_x, z) => z > 0.5)).toEqual({ x: 1, z: 0, blockedX: false, blockedZ: true });
  });

  it('does not recombine individually safe axes into a blocked corner', () => {
    const blocked = (x: number, z: number) => x > 0.5 && z > 0.5;
    const result = resolvePlanarCollision({ x: 0, z: 0 }, { x: 1, z: 2 }, blocked);
    expect(result).toEqual({ x: 0, z: 2, blockedX: true, blockedZ: false });
    expect(blocked(result.x, result.z)).toBe(false);
  });

  it('stops at an inside corner when both directions are blocked', () => {
    expect(resolvePlanarCollision({ x: 0, z: 0 }, { x: 1, z: 2 }, (x, z) => x > 0.5 || z > 0.5))
      .toEqual({ x: 0, z: 0, blockedX: true, blockedZ: true });
  });

  it('detects a thin obstacle crossed between frame endpoints', () => {
    const blocked = (x: number) => x >= 0.45 && x <= 0.55;
    const result = sweepPlanarCollision({ x: 0, z: 0 }, { x: 1, z: 0 }, blocked);
    expect(result.swept).toBe(true);
    expect(result.x).toBeLessThan(0.45);
  });

  it('leaves unobstructed high-speed travel unchanged', () => {
    expect(sweepPlanarCollision({ x: 0, z: 0 }, { x: 8, z: -4 }, () => false)).toEqual({
      x: 8, z: -4, blockedX: false, blockedZ: false, swept: false,
    });
  });

  it('uses the remaining frame motion to slide along a wall after first contact', () => {
    const result = sweepPlanarCollision({ x: 0, z: 0 }, { x: 1, z: 2 }, (x) => x >= 0.45);
    expect(result.x).toBeLessThan(0.45);
    expect(result.z).toBeCloseTo(2);
    expect(result.blockedX).toBe(true);
    expect(result.blockedZ).toBe(false);
  });

  it('turns across the angle boundary along the short arc in both directions', () => {
    const nearPi = Math.PI - 0.05;
    const clockwise = smoothHeading(nearPi, -nearPi, 1 / 60);
    const counterclockwise = smoothHeading(-nearPi, nearPi, 1 / 60);
    expect(clockwise).toBeGreaterThan(nearPi);
    expect(clockwise - nearPi).toBeLessThan(0.1);
    expect(counterclockwise).toBeLessThan(-nearPi);
    expect(-nearPi - counterclockwise).toBeLessThan(0.1);
  });

  it('has frame-rate-independent turn response and does not move at zero delta', () => {
    let sixtyHz = 0;
    let thirtyHz = 0;
    for (let i = 0; i < 60; i++) sixtyHz = smoothHeading(sixtyHz, 2, 1 / 60);
    for (let i = 0; i < 30; i++) thirtyHz = smoothHeading(thirtyHz, 2, 1 / 30);
    expect(sixtyHz).toBeCloseTo(thirtyHz, 10);
    expect(smoothHeading(0.8, -2, 0)).toBe(0.8);
    expect(smoothHeading(0.8, -2, -1)).toBe(0.8);
  });

  it('prioritizes constrained stance speeds over sprint', () => {
    expect(movementSpeed({ aiming: false, crouching: false, sprinting: true })).toBe(MOVEMENT_SPEC.sprintSpeed);
    expect(movementSpeed({ aiming: false, crouching: true, sprinting: true })).toBe(MOVEMENT_SPEC.crouchSpeed);
    expect(movementSpeed({ aiming: true, crouching: true, sprinting: true })).toBe(MOVEMENT_SPEC.crouchSpeed);
    expect(movementSpeed({ aiming: true, crouching: false, sprinting: true })).toBe(MOVEMENT_SPEC.aimSpeed);
  });

  it('drains and regenerates bounded stamina', () => {
    expect(updateStamina(100, 1, true)).toBe(77);
    expect(updateStamina(10, 1, false)).toBe(27);
    expect(updateStamina(2, 10, true)).toBe(0);
    expect(updateStamina(98, 2, false)).toBe(100);
  });

  it('requires grounded momentum and resources for slides', () => {
    expect(canStartSlide(100, true, 8)).toBe(true);
    expect(canStartSlide(15, true, 8)).toBe(false);
    expect(canStartSlide(100, false, 8)).toBe(false);
    expect(canStartSlide(100, true, 1)).toBe(false);
  });

  it('gates dodges by stamina, grounding, and cooldown', () => {
    expect(canStartDodge(100, true, 0)).toBe(true);
    expect(canStartDodge(20, true, 0)).toBe(false);
    expect(canStartDodge(100, false, 0)).toBe(false);
    expect(canStartDodge(100, true, 0.1)).toBe(false);
  });

  it('eases slide velocity into crouch speed', () => {
    expect(slideSpeed(MOVEMENT_SPEC.slideSeconds)).toBe(MOVEMENT_SPEC.slideInitialSpeed);
    expect(slideSpeed(0)).toBe(MOVEMENT_SPEC.crouchSpeed);
    expect(slideSpeed(MOVEMENT_SPEC.slideSeconds / 2)).toBeGreaterThan(MOVEMENT_SPEC.crouchSpeed);
  });
});
