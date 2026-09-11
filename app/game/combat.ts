import { clamp } from './mechanics';
import type { WeaponId } from './types';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  hudLabel: string;
  magazineSize: number;
  startingReserve: number;
  roundsPerMinute: number;
  reloadSeconds: number;
  baseDamage: number;
  pellets: number;
  falloffStartMeters: number;
  falloffEndMeters: number;
  minimumDamageScale: number;
  criticalMultiplier: number;
  bossDamageScale: number;
  hipSpreadDegrees: number;
  aimSpreadDegrees: number;
  movementSpreadDegrees: number;
  recoilSpreadDegrees: number;
  recoilPerShot: number;
  maximumRecoil: number;
  recoilRecoveryPerSecond: number;
  hipCameraKick: number;
  aimCameraKick: number;
  swapSeconds: number;
  tracerColor: number;
}

export const MORROW_SPEC: WeaponSpec = Object.freeze({
  id: 'morrow',
  name: 'Morrow',
  hudLabel: 'Morrow / 9mm smart',
  magazineSize: 18,
  startingReserve: 126,
  roundsPerMinute: 500,
  reloadSeconds: 1.28,
  baseDamage: 38,
  pellets: 1,
  falloffStartMeters: 24,
  falloffEndMeters: 112,
  minimumDamageScale: 0.54,
  criticalMultiplier: 1.72,
  bossDamageScale: 0.52,
  hipSpreadDegrees: 1.35,
  aimSpreadDegrees: 0.22,
  movementSpreadDegrees: 0.92,
  recoilSpreadDegrees: 0.58,
  recoilPerShot: 0.2,
  maximumRecoil: 1,
  recoilRecoveryPerSecond: 3.8,
  hipCameraKick: 0.011,
  aimCameraKick: 0.006,
  swapSeconds: 0.32,
  tracerColor: 0xe8c96f,
});

const PSALM_SPEC: WeaponSpec = Object.freeze({
  id: 'psalm',
  name: 'Psalm',
  hudLabel: 'Psalm / repeater coil',
  magazineSize: 32,
  startingReserve: 160,
  roundsPerMinute: 790,
  reloadSeconds: 1.62,
  baseDamage: 21,
  pellets: 1,
  falloffStartMeters: 30,
  falloffEndMeters: 120,
  minimumDamageScale: 0.5,
  criticalMultiplier: 1.6,
  bossDamageScale: 0.5,
  hipSpreadDegrees: 1.85,
  aimSpreadDegrees: 0.5,
  movementSpreadDegrees: 1.15,
  recoilSpreadDegrees: 0.72,
  recoilPerShot: 0.13,
  maximumRecoil: 1.25,
  recoilRecoveryPerSecond: 4.6,
  hipCameraKick: 0.007,
  aimCameraKick: 0.004,
  swapSeconds: 0.38,
  tracerColor: 0x9fd6ff,
});

const VESPER_SPEC: WeaponSpec = Object.freeze({
  id: 'vesper',
  name: 'Vesper',
  hudLabel: 'Vesper / choir breaker',
  magazineSize: 6,
  startingReserve: 30,
  roundsPerMinute: 96,
  reloadSeconds: 2.05,
  baseDamage: 12.5,
  pellets: 8,
  falloffStartMeters: 7,
  falloffEndMeters: 36,
  minimumDamageScale: 0.16,
  criticalMultiplier: 1.45,
  bossDamageScale: 0.6,
  hipSpreadDegrees: 4.4,
  aimSpreadDegrees: 3.1,
  movementSpreadDegrees: 1.1,
  recoilSpreadDegrees: 0.9,
  recoilPerShot: 0.62,
  maximumRecoil: 1.6,
  recoilRecoveryPerSecond: 2.9,
  hipCameraKick: 0.038,
  aimCameraKick: 0.026,
  swapSeconds: 0.44,
  tracerColor: 0xffa35c,
});

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  morrow: MORROW_SPEC,
  psalm: PSALM_SPEC,
  vesper: VESPER_SPEC,
};

export const WEAPON_ORDER: readonly WeaponId[] = ['morrow', 'psalm', 'vesper'];
export const WEAPON_IDS = WEAPON_ORDER;

export interface ShotContext {
  aiming: boolean;
  movement: number;
  recoil: number;
}

export function shotIntervalSeconds(spec: WeaponSpec = MORROW_SPEC) {
  return 60 / spec.roundsPerMinute;
}

export function weaponDamage(distanceMeters: number, critical = false, boss = false, spec: WeaponSpec = MORROW_SPEC) {
  const falloff = clamp(
    (distanceMeters - spec.falloffStartMeters)
      / (spec.falloffEndMeters - spec.falloffStartMeters),
    0,
    1,
  );
  const distanceScale = 1 - falloff * (1 - spec.minimumDamageScale);
  const criticalScale = critical ? spec.criticalMultiplier : 1;
  const bossScale = boss ? spec.bossDamageScale : 1;
  return spec.baseDamage * distanceScale * criticalScale * bossScale;
}

export function shotSpreadRadians(context: ShotContext, spec: WeaponSpec = MORROW_SPEC) {
  const movement = clamp(context.movement, 0, 1);
  const recoil = clamp(context.recoil, 0, spec.maximumRecoil);
  const base = context.aiming ? spec.aimSpreadDegrees : spec.hipSpreadDegrees;
  const movementPenalty = spec.movementSpreadDegrees * movement * (context.aiming ? 0.42 : 1);
  const recoilPenalty = spec.recoilSpreadDegrees * recoil * (context.aiming ? 0.48 : 1);
  return (base + movementPenalty + recoilPenalty) * Math.PI / 180;
}

export function deterministicShotOffset(shotIndex: number, radius: number) {
  if (radius <= 0) return { x: 0, y: 0 };
  const index = Math.max(0, Math.floor(shotIndex));
  const sequence = ((index + 1) * 0.7548776662466927) % 1;
  const radial = Math.sqrt(((index + 1) * 0.5698402909980532) % 1) * radius;
  const angle = sequence * Math.PI * 2;
  return { x: Math.cos(angle) * radial, y: Math.sin(angle) * radial };
}

export function addShotRecoil(current: number, spec: WeaponSpec = MORROW_SPEC) {
  return clamp(current + spec.recoilPerShot, 0, spec.maximumRecoil);
}

export function recoverShotRecoil(current: number, deltaSeconds: number, aiming: boolean, spec: WeaponSpec = MORROW_SPEC) {
  const recovery = spec.recoilRecoveryPerSecond * (aiming ? 1.22 : 1) * Math.max(0, deltaSeconds);
  return Math.max(0, current - recovery);
}

export function transferReload(ammo: number, reserve: number, spec: WeaponSpec = MORROW_SPEC) {
  const safeAmmo = clamp(Math.floor(ammo), 0, spec.magazineSize);
  const safeReserve = Math.max(0, Math.floor(reserve));
  const loaded = Math.min(spec.magazineSize - safeAmmo, safeReserve);
  return { ammo: safeAmmo + loaded, reserve: safeReserve - loaded, loaded };
}
