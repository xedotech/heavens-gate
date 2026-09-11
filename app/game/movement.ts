import { clamp } from './mechanics';

export const MOVEMENT_SPEC = Object.freeze({
  walkSpeed: 6.4,
  aimSpeed: 4.4,
  crouchSpeed: 3.25,
  sprintSpeed: 10.5,
  staminaMaximum: 100,
  sprintDrainPerSecond: 23,
  staminaRecoveryPerSecond: 17,
  slideCost: 16,
  slideSeconds: 0.68,
  slideInitialSpeed: 13.8,
  dodgeCost: 22,
  dodgeSeconds: 0.28,
  dodgeCooldownSeconds: 0.78,
  dodgeSpeed: 15.5,
  turnResponse: 14,
});

export function smoothHeading(current: number, target: number, deltaSeconds: number) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-MOVEMENT_SPEC.turnResponse * Math.max(0, deltaSeconds)));
}

export function resolvePlanarCollision(
  previous: { x: number; z: number },
  requested: { x: number; z: number },
  blocked: (x: number, z: number) => boolean,
) {
  if (!blocked(requested.x, requested.z)) return { ...requested, blockedX: false, blockedZ: false };
  const canMoveX = !blocked(requested.x, previous.z);
  const canMoveZ = !blocked(previous.x, requested.z);
  // At an outside corner both single-axis positions may be safe although the
  // diagonal endpoint is not. Choose one; combining them recreates the collision.
  if (canMoveX && (!canMoveZ || Math.abs(requested.x - previous.x) >= Math.abs(requested.z - previous.z))) {
    return { x: requested.x, z: previous.z, blockedX: false, blockedZ: true };
  }
  if (canMoveZ) return { x: previous.x, z: requested.z, blockedX: true, blockedZ: false };
  return { x: previous.x, z: previous.z, blockedX: true, blockedZ: true };
}

/** Samples a planar move and preserves unblocked motion after contact.
 * Obstacles narrower than maxStep require a smaller step or an expanded collider.
 */
export function sweepPlanarCollision(
  previous: { x: number; z: number },
  requested: { x: number; z: number },
  blocked: (x: number, z: number) => boolean,
  maxStep = 0.1,
) {
  const distance = Math.hypot(requested.x - previous.x, requested.z - previous.z);
  const steps = Math.max(1, Math.ceil(distance / Math.max(0.01, maxStep)));
  let current = { x: previous.x, z: previous.z };
  let blockedX = false;
  let blockedZ = false;
  let swept = false;
  const stepX = (requested.x - previous.x) / steps;
  const stepZ = (requested.z - previous.z) / steps;
  for (let index = 1; index <= steps; index += 1) {
    const candidate = { x: current.x + (blockedX ? 0 : stepX), z: current.z + (blockedZ ? 0 : stepZ) };
    if (!blocked(candidate.x, candidate.z)) {
      current = candidate;
      continue;
    }
    const resolved = resolvePlanarCollision(current, candidate, blocked);
    current = { x: resolved.x, z: resolved.z };
    blockedX ||= resolved.blockedX;
    blockedZ ||= resolved.blockedZ;
    swept = true;
    if (blockedX && blockedZ) break;
  }
  return { ...(swept ? current : { x: requested.x, z: requested.z }), blockedX, blockedZ, swept };
}

export interface MovementSpeedContext {
  aiming: boolean;
  crouching: boolean;
  sprinting: boolean;
}

export function movementSpeed(context: MovementSpeedContext) {
  if (context.crouching) return MOVEMENT_SPEC.crouchSpeed;
  if (context.aiming) return MOVEMENT_SPEC.aimSpeed;
  if (context.sprinting) return MOVEMENT_SPEC.sprintSpeed;
  return MOVEMENT_SPEC.walkSpeed;
}

export function updateStamina(stamina: number, deltaSeconds: number, sprinting: boolean) {
  const delta = Math.max(0, deltaSeconds);
  const next = sprinting
    ? stamina - MOVEMENT_SPEC.sprintDrainPerSecond * delta
    : stamina + MOVEMENT_SPEC.staminaRecoveryPerSecond * delta;
  return clamp(next, 0, MOVEMENT_SPEC.staminaMaximum);
}

export function canStartSlide(stamina: number, grounded: boolean, planarSpeed: number) {
  return grounded && stamina >= MOVEMENT_SPEC.slideCost && planarSpeed >= MOVEMENT_SPEC.walkSpeed * 0.85;
}

export function canStartDodge(stamina: number, grounded: boolean, cooldown: number) {
  return grounded && stamina >= MOVEMENT_SPEC.dodgeCost && cooldown <= 0;
}

export function slideSpeed(remainingSeconds: number) {
  const normalized = clamp(remainingSeconds / MOVEMENT_SPEC.slideSeconds, 0, 1);
  return MOVEMENT_SPEC.crouchSpeed + (MOVEMENT_SPEC.slideInitialSpeed - MOVEMENT_SPEC.crouchSpeed) * normalized * normalized;
}
