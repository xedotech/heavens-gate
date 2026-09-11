export interface SoundPosition { x: number; y: number; z: number }

/** Camera-relative stereo cue with bounded attenuation; not an HRTF renderer. */
export function spatialGunshotMix(source: SoundPosition, listener: SoundPosition, yaw: number, occluded: boolean) {
  const x = source.x - listener.x;
  const y = source.y - listener.y;
  const z = source.z - listener.z;
  const distance = Math.hypot(x, y, z);
  const planarDistance = Math.hypot(x, z);
  const pan = planarDistance > 0.001
    ? Math.max(-1, Math.min(1, (x * Math.cos(yaw) - z * Math.sin(yaw)) / planarDistance))
    : 0;
  const gain = distance >= 140 ? 0 : 1 / (1 + (distance / 18) ** 2);
  return { pan, gain: gain * (occluded ? 0.35 : 1), cutoff: occluded ? 850 : 9000 };
}
