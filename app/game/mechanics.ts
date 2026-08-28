import type { Difficulty } from './types';

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function damp(current: number, target: number, smoothing: number, delta: number) {
  return current + (target - current) * (1 - Math.exp(-smoothing * delta));
}

export function seeded(index: number, salt = 0) {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export function distance2D(ax: number, az: number, bx: number, bz: number) {
  return Math.hypot(ax - bx, az - bz);
}

export function heatTier(heat: number) {
  if (heat >= 80) return 5;
  if (heat >= 60) return 4;
  if (heat >= 42) return 3;
  if (heat >= 24) return 2;
  if (heat >= 8) return 1;
  return 0;
}

export function difficultyDamage(difficulty: Difficulty) {
  if (difficulty === 'story') return 0.62;
  if (difficulty === 'ascendant') return 1.45;
  return 1;
}

export function objectiveProgress(value: number, target: number) {
  if (target <= 0) return 1;
  return clamp(value / target, 0, 1);
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.max(0, Math.round(meters))} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatTime(hours: number) {
  const wrapped = ((hours % 24) + 24) % 24;
  const hour = Math.floor(wrapped);
  const minutes = Math.floor((wrapped - hour) * 60);
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
