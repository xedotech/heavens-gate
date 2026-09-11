"""Audit exported knee articulation and loop seams; not visual approval.

Run in a fresh background Blender process with -- --asset path/to/hero.glb.
Does not modify or export the asset.
"""
import argparse
import json
import math
import sys

import bpy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asset', required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=args.asset)
    rig = next(obj for obj in bpy.data.objects if obj not in before and obj.type == 'ARMATURE')
    actions = [action for action in bpy.data.actions if action not in actions_before]
    failures = []
    results = []
    for name in ('HG_Walk', 'HG_Run'):
        action = next(action for action in actions if action.name == name or action.name.startswith(name + '.'))
        rig.animation_data.action = None
        for bone in rig.pose.bones:
            bone.matrix_basis.identity()
        rig.animation_data.action = action
        if action.slots:
            rig.animation_data.action_slot = action.slots[0]
        start, end = action.frame_range
        samples = {'l': [], 'r': []}
        endpoints = []
        for index in range(33):
            frame = start + (end - start) * index / 32
            bpy.context.scene.frame_set(math.floor(frame), subframe=frame % 1)
            bpy.context.view_layer.update()
            for side in ('l', 'r'):
                thigh = rig.pose.bones['thigh_' + side]
                calf = rig.pose.bones['calf_' + side]
                angle = math.degrees((thigh.tail - thigh.head).angle(calf.tail - calf.head))
                samples[side].append(angle)
            if index in (0, 32):
                endpoints.append({bone.name: bone.matrix.copy() for bone in rig.pose.bones
                                  if bone.name.startswith(('thigh_', 'calf_', 'foot_'))})
        ranges = {side: max(values) - min(values) for side, values in samples.items()}
        seam = max(abs(endpoints[0][name][row][col] - endpoints[1][name][row][col])
                   for name in endpoints[0] for row in range(4) for col in range(4))
        for side, value in ranges.items():
            if not math.isfinite(value) or value < 10:
                failures.append(f'{name}:{side}:insufficient-knee-articulation')
        if not math.isfinite(seam) or seam > 0.001:
            failures.append(f'{name}:loop-seam')
        results.append({'action': name, 'kneeRangeDegrees': ranges, 'loopMatrixMaxDelta': seam})
    print('HG_GAIT_AUDIT=' + json.dumps({'asset': args.asset, 'results': results, 'failures': failures}))
    if failures:
        raise RuntimeError('Gait audit failed: ' + ', '.join(failures))


if __name__ == '__main__':
    main()
