import { describe, expect, it } from 'vitest';
import {
  clamp,
  cordonConeDetect,
  damp,
  difficultyDamage,
  distance2D,
  formatDistance,
  formatTime,
  heatTier,
  objectiveProgress,
  seeded,
} from './mechanics';

describe('core mechanics', () => {
  it('clamps simulation values to safe ranges', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
    expect(clamp(140, 0, 100)).toBe(100);
  });

  it('damps toward a target without overshooting', () => {
    const next = damp(0, 10, 8, 1 / 60);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
    let value = 0;
    for (let frame = 0; frame < 300; frame += 1) value = damp(value, 10, 8, 1 / 60);
    expect(value).toBeCloseTo(10, 4);
  });

  it('produces deterministic world seeds in the unit interval', () => {
    expect(seeded(81, 4)).toBe(seeded(81, 4));
    expect(seeded(81, 4)).not.toBe(seeded(82, 4));
    expect(seeded(81, 4)).toBeGreaterThanOrEqual(0);
    expect(seeded(81, 4)).toBeLessThan(1);
  });

  it('calculates planar distance for navigation', () => {
    expect(distance2D(0, 0, 3, 4)).toBe(5);
    expect(distance2D(-2, -3, -2, -3)).toBe(0);
  });

  it('reads a posted cordon cone as facing + range, not a radius', () => {
    const yaw = 0; // facing +z — the station-approach cordon watches north.
    expect(cordonConeDetect(0, -45, yaw, 0, -35, 24, 0.62)).toBe(true);
    // Same distance, behind the line: outside the half-angle.
    expect(cordonConeDetect(0, -45, yaw, 0, -55, 24, 0.62)).toBe(false);
    // Just inside the edge of the cone and just past it.
    const edge = 0.6;
    expect(cordonConeDetect(0, -45, yaw, Math.sin(edge) * 10, -45 + Math.cos(edge) * 10, 24, 0.62)).toBe(true);
    expect(cordonConeDetect(0, -45, yaw, Math.sin(0.8) * 10, -45 + Math.cos(0.8) * 10, 24, 0.62)).toBe(false);
    // Out of range still fails even dead ahead; point-blank always reads.
    expect(cordonConeDetect(0, -45, yaw, 0, -20, 24, 0.62)).toBe(false);
    expect(cordonConeDetect(0, -45, yaw, 0, -45, 24, 0.62)).toBe(true);
    // A rotated watch direction follows the yaw.
    expect(cordonConeDetect(0, -45, Math.PI / 2, 8, -45, 24, 0.62)).toBe(true);
  });

  it('maps Choir heat to five response tiers', () => {
    expect(heatTier(0)).toBe(0);
    expect(heatTier(8)).toBe(1);
    expect(heatTier(24)).toBe(2);
    expect(heatTier(42)).toBe(3);
    expect(heatTier(60)).toBe(4);
    expect(heatTier(80)).toBe(5);
    expect(heatTier(100)).toBe(5);
  });

  it('applies the selected incoming-damage curve', () => {
    expect(difficultyDamage('story')).toBe(0.62);
    expect(difficultyDamage('normal')).toBe(1);
    expect(difficultyDamage('ascendant')).toBe(1.45);
  });

  it('normalizes objective progress and guards invalid targets', () => {
    expect(objectiveProgress(2, 4)).toBe(0.5);
    expect(objectiveProgress(8, 4)).toBe(1);
    expect(objectiveProgress(-2, 4)).toBe(0);
    expect(objectiveProgress(2, 0)).toBe(1);
  });

  it('formats HUD distance and clock values', () => {
    expect(formatDistance(142.4)).toBe('142 m');
    expect(formatDistance(1640)).toBe('1.6 km');
    expect(formatTime(3.5)).toBe('03:30');
    expect(formatTime(25.25)).toBe('01:15');
    expect(formatTime(-0.5)).toBe('23:30');
  });
});
