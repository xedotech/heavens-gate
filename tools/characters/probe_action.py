"""Temporary probe: import a hero GLB and dump the imported leg fcurves + pose."""
import math
import sys

import bpy

asset = sys.argv[sys.argv.index('--') + 1]
bpy.ops.import_scene.gltf(filepath=asset)
rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')

print('HG_RIG=', rig.name)
for name in ('thigh_l', 'calf_l', 'foot_l'):
    b = rig.data.bones[name]
    print(f'BONE {name} head={tuple(round(v,3) for v in b.head_local)} '
          f'tail={tuple(round(v,3) for v in b.tail_local)} matrix_local=')
    for row in b.matrix_local:
        print('    ', tuple(round(v, 4) for v in row))

for action in bpy.data.actions:
    if not action.name.startswith(('HG_Walk', 'HG_Run')):
        continue
    print('=== ACTION', action.name, 'frame_range=', tuple(action.frame_range), 'slots=', len(action.slots))
    # Blender 4.4+ slotted actions: curves live in layers->strips->channelbags
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    if any(tok in fc.data_path for tok in ('thigh_', 'calf_', 'foot_')):
                        keys = [(round(k.co.x, 1), round(k.co.y, 4)) for k in fc.keyframe_points]
                        print(f'  {fc.data_path}[{fc.array_index}] keys={keys}')

    rig.animation_data_create()
    rig.animation_data.action = action
    if action.slots:
        rig.animation_data.action_slot = action.slots[0]
    start, end = action.frame_range
    for i in range(9):
        frame = start + (end - start) * i / 8
        bpy.context.scene.frame_set(math.floor(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        thigh = rig.pose.bones['thigh_l']
        calf = rig.pose.bones['calf_l']
        angle = math.degrees((thigh.tail - thigh.head).angle(calf.tail - calf.head))
        e = calf.rotation_euler
        print(f'  f={frame:.2f} knee_l={angle:.2f}deg calf_euler=({e.x:.3f},{e.y:.3f},{e.z:.3f}) '
              f'thigh_euler=({thigh.rotation_euler.x:.3f},{thigh.rotation_euler.y:.3f},{thigh.rotation_euler.z:.3f})')
