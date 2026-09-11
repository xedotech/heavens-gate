import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { visibleInScene, withoutSubtree } from './scene-lifecycle';

describe('shot target lifecycle', () => {
  it('rejects hidden ancestors and detached targets even though Three raycasts them', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(group);
    group.add(mesh);
    scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, -1));
    expect(visibleInScene(mesh, scene)).toBe(true);
    group.visible = false;
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    expect(visibleInScene(mesh, scene)).toBe(false);
    group.visible = true;
    scene.remove(group);
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    expect(visibleInScene(mesh, scene)).toBe(false);
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it('removes every nested target by object identity, not a reused actor id', () => {
    const oldBoss = new THREE.Group();
    const nested = new THREE.Group();
    const child = new THREE.Object3D();
    oldBoss.add(nested);
    nested.add(child);
    const newBoss = new THREE.Object3D();
    child.userData.actorId = newBoss.userData.actorId = 'boss';
    const targets = [oldBoss, nested, child, child, newBoss];
    expect(withoutSubtree(targets, oldBoss)).toEqual([newBoss]);
    expect(targets).toHaveLength(5);
  });
});
