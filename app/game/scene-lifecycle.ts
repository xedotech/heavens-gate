import type { Object3D } from 'three';

/** Raycaster ignores Object3D.visible; also reject detached stale targets. */
export function visibleInScene(object: Object3D, scene: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === scene) return true;
    current = current.parent;
  }
  return false;
}

export function withoutSubtree(targets: Object3D[], root: Object3D): Object3D[] {
  const removed = new Set<Object3D>();
  root.traverse((object) => removed.add(object));
  return targets.filter((target) => !removed.has(target));
}
