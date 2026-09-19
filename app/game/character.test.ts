import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HeroCharacter } from './character';

function fixture() {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = 'test_bone';
  root.add(bone);
  const clips = ['Idle', 'Walk', 'Run', 'Fire', 'Reload', 'Death'].map((name, index) => (
    new THREE.AnimationClip(`HG_${name}`, 1, [
      new THREE.NumberKeyframeTrack('test_bone.position[x]', [0, 1], [index + 1, index + 1]),
    ])
  ));
  const hero = new HeroCharacter(root, clips, 1);
  const advance = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 100); i++) hero.update(0.01, i * 0.01, 0);
  };
  return { hero, bone, advance };
}

describe('hero runtime animation transitions', () => {
  it('keeps independent finger curls and bind poses stable across repeated grip updates', () => {
    const rightGripBones = [0.2, 0.7, -0.3].map((curl, i) => ({
      bone: new THREE.Bone(),
      bind: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.15),
      curl,
    }));
    const binds = rightGripBones.map(({ bind }) => bind.clone());
    const expected = rightGripBones.map(({ bind, curl }) => bind.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), curl),
    ));
    const hero = Object.assign(Object.create(HeroCharacter.prototype), {
      rightGripBones, leftGripBones: [], leftGripBlend: 0,
    }) as { applyGripPose(): void };
    for (let frame = 0; frame < 120; frame++) hero.applyGripPose();
    rightGripBones.forEach(({ bone, bind }, i) => {
      expect(bone.quaternion.angleTo(expected[i])).toBeLessThan(1e-7);
      expect(bind.equals(binds[i])).toBe(true);
    });
  });
  it('preserves normalized gait phase when switching between walk and run', () => {
    const { hero, advance } = fixture();
    const actions = (hero as unknown as { actions: Map<string, THREE.AnimationAction> }).actions;
    hero.setMotion('walk', 0);
    advance(0.37);
    const walk = actions.get('walk')!;
    const run = actions.get('run')!;
    // Unequal clip durations must retain phase, not absolute time.
    run.getClip().duration = 0.8;
    const phase = walk.time / walk.getClip().duration;
    hero.setMotion('run', 0.18);
    expect(run.time / run.getClip().duration).toBeCloseTo(phase);
    advance(0.25);
    const returnPhase = run.time / run.getClip().duration;
    hero.setMotion('walk', 0.18);
    expect(walk.time / walk.getClip().duration).toBeCloseTo(returnPhase);
    hero.dispose();
  });
  it('keeps death terminal even if movement and fire requests arrive later', () => {
    const { hero, bone, advance } = fixture();
    hero.playOnce('death', 0);
    advance(2);
    hero.setMotion('run', 0);
    hero.playOnce('fire', 0);
    advance(0.2);
    expect(bone.position.x).toBeCloseTo(6);
    hero.dispose();
  });

  it('clears a death or pending one-shot immediately on campaign reset', () => {
    const { hero, bone, advance } = fixture();
    hero.playOnce('death', 0);
    advance(0.2);
    hero.resetAnimation();
    expect(bone.position.x).toBeCloseTo(1);
    hero.setMotion('walk', 0);
    advance(0.1);
    expect(bone.position.x).toBeCloseTo(2);
    hero.dispose();
  });

  it('starts idle immediately and blends to walking without overshooting either pose', () => {
    const { hero, bone, advance } = fixture();
    advance(0.02);
    expect(bone.position.x).toBeCloseTo(1);
    hero.setMotion('walk', 0.2);
    advance(0.1);
    expect(bone.position.x).toBeGreaterThan(1);
    expect(bone.position.x).toBeLessThan(2);
    advance(0.2);
    expect(bone.position.x).toBeCloseTo(2);
    hero.dispose();
  });

  it('returns from a one-shot to the latest requested locomotion', () => {
    const { hero, bone, advance } = fixture();
    hero.playOnce('reload', 0);
    advance(0.2);
    hero.setMotion('walk');
    hero.setMotion('run');
    advance(0.2);
    expect(bone.position.x).toBeCloseTo(5);
    advance(0.9);
    expect(bone.position.x).toBeCloseTo(3);
    hero.dispose();
  });

  it('restarts repeated fire clips and returns to idle after the newest shot', () => {
    const { hero, bone, advance } = fixture();
    hero.playOnce('fire', 0);
    advance(0.8);
    hero.playOnce('fire', 0);
    advance(0.4);
    expect(bone.position.x).toBeCloseTo(4);
    advance(0.9);
    expect(bone.position.x).toBeCloseTo(1);
    hero.dispose();
  });

  it('holds the final death pose instead of automatically returning to idle', () => {
    const { hero, bone, advance } = fixture();
    hero.playOnce('death', 0);
    advance(2);
    expect(bone.position.x).toBeCloseTo(6);
    hero.dispose();
  });
});
