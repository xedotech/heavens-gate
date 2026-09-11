import { describe, expect, it } from 'vitest';
import {
  MORROW_SPEC,
  addShotRecoil,
  deterministicShotOffset,
  recoverShotRecoil,
  shotIntervalSeconds,
  shotSpreadRadians,
  transferReload,
  weaponDamage,
} from './combat';

describe('Morrow weapon model', () => {
  it('derives its cadence from rounds per minute', () => {
    expect(shotIntervalSeconds()).toBeCloseTo(0.12, 6);
  });

  it('applies continuous range falloff and hit-zone modifiers', () => {
    expect(weaponDamage(0)).toBe(MORROW_SPEC.baseDamage);
    expect(weaponDamage(MORROW_SPEC.falloffStartMeters)).toBe(MORROW_SPEC.baseDamage);
    expect(weaponDamage(MORROW_SPEC.falloffEndMeters)).toBeCloseTo(MORROW_SPEC.baseDamage * MORROW_SPEC.minimumDamageScale, 6);
    expect(weaponDamage(200)).toBeCloseTo(MORROW_SPEC.baseDamage * MORROW_SPEC.minimumDamageScale, 6);
    expect(weaponDamage(12, true)).toBeCloseTo(MORROW_SPEC.baseDamage * MORROW_SPEC.criticalMultiplier, 6);
    expect(weaponDamage(12, false, true)).toBeCloseTo(MORROW_SPEC.baseDamage * MORROW_SPEC.bossDamageScale, 6);
  });

  it('makes aimed stationary fire materially tighter than moving hip fire', () => {
    const aimed = shotSpreadRadians({ aiming: true, movement: 0, recoil: 0 });
    const hip = shotSpreadRadians({ aiming: false, movement: 1, recoil: 1 });
    expect(aimed).toBeLessThan(hip * 0.2);
  });

  it('produces deterministic bounded shot offsets', () => {
    const first = deterministicShotOffset(14, 0.25);
    expect(first).toEqual(deterministicShotOffset(14, 0.25));
    expect(first).not.toEqual(deterministicShotOffset(15, 0.25));
    expect(Math.hypot(first.x, first.y)).toBeLessThanOrEqual(0.25);
  });

  it('accumulates and recovers bounded recoil', () => {
    let recoil = 0;
    for (let shot = 0; shot < 20; shot += 1) recoil = addShotRecoil(recoil);
    expect(recoil).toBe(MORROW_SPEC.maximumRecoil);
    expect(recoverShotRecoil(recoil, 0.1, true)).toBeLessThan(recoverShotRecoil(recoil, 0.1, false));
    expect(recoverShotRecoil(0.1, 10, false)).toBe(0);
  });

  it('transfers only available reserve ammunition', () => {
    expect(transferReload(5, 100)).toEqual({ ammo: 18, reserve: 87, loaded: 13 });
    expect(transferReload(16, 1)).toEqual({ ammo: 17, reserve: 0, loaded: 1 });
    expect(transferReload(18, 40)).toEqual({ ammo: 18, reserve: 40, loaded: 0 });
  });
});
