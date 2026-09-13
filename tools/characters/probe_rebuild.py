"""Temporary experiment: re-author HG_Walk on the imported rig, dump fcurve
keys BEFORE export, then export with the same settings and audit the result.

Run: blender --background --python probe_rebuild.py -- <input.glb> <output.glb>
"""
import math
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=src)
rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
for action in tuple(bpy.data.actions):
    bpy.data.actions.remove(action)
rig.animation_data_create()
rig.animation_data.action = None

# --- copied verbatim from build_characters.py ---
ANIMATED_BONES = (
    "Root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
    "clavicle_l", "clavicle_r", "upperarm_l", "upperarm_r", "lowerarm_l",
    "lowerarm_r", "hand_l", "hand_r", "thigh_l", "thigh_r", "calf_l",
    "calf_r", "foot_l", "foot_r",
)
BASE_STANCE = {}


def reset_pose(rig):
    for bone_name in ANIMATED_BONES:
        bone = rig.pose.bones.get(bone_name)
        if bone is None:
            continue
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = (0.0, 0.0, 0.0)
        bone.location = (0.0, 0.0, 0.0)


def key_pose(rig, frame, rotations=None, locations=None):
    reset_pose(rig)
    merged_rotations = dict(BASE_STANCE)
    merged_rotations.update(rotations or {})
    for bone_name, values in merged_rotations.items():
        bone = rig.pose.bones.get(bone_name)
        if bone is not None:
            bone.rotation_euler = values
    for bone_name, values in (locations or {}).items():
        bone = rig.pose.bones.get(bone_name)
        if bone is not None:
            bone.location = values
    keyed_bones = set(merged_rotations) | set(locations or {})
    for bone_name in sorted(keyed_bones):
        bone = rig.pose.bones.get(bone_name)
        if bone is None:
            continue
        if bone_name in merged_rotations:
            bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone_name)
        if bone_name in (locations or {}):
            bone.keyframe_insert(data_path="location", frame=frame, group=bone_name)


def build_action(rig, name, fps, poses, loop=False):
    action = bpy.data.actions.new(name=name)
    action["hg_fps"] = fps
    action["hg_loop"] = loop
    rig.animation_data_create()
    rig.animation_data.action = action
    for pose in poses:
        key_pose(rig, pose["frame"], rotations=pose.get("rotations", {}),
                 locations=pose.get("locations", {}))
    rig.animation_data.action = None


walk_a = {
    "thigh_l": (0.18, 0.0, 0.0), "thigh_r": (-0.18, 0.0, 0.0),
    "calf_l": (0.08, 0.0, 0.0), "calf_r": (0.08, 0.0, 0.0),
    "upperarm_l": (-0.16, 0.0, 0.0), "upperarm_r": (0.16, 0.0, 0.0),
    "lowerarm_l": (-0.04, 0.0, 0.0), "lowerarm_r": (-0.04, 0.0, 0.0),
    "pelvis": (0.02, 0.0, -0.035), "spine_02": (-0.025, 0.0, 0.025),
}
walk_b = {
    "thigh_l": (-0.18, 0.0, 0.0), "thigh_r": (0.18, 0.0, 0.0),
    "calf_l": (0.08, 0.0, 0.0), "calf_r": (0.08, 0.0, 0.0),
    "upperarm_l": (0.16, 0.0, 0.0), "upperarm_r": (-0.16, 0.0, 0.0),
    "lowerarm_l": (-0.04, 0.0, 0.0), "lowerarm_r": (-0.04, 0.0, 0.0),
    "pelvis": (0.02, 0.0, 0.035), "spine_02": (-0.025, 0.0, -0.025),
}
build_action(rig, "HG_Walk", 30, [
    {"frame": 1, "rotations": walk_a, "locations": {"Root": (0.0, 0.0, 0.01)}},
    {"frame": 9, "rotations": {**walk_a, "thigh_l": (0.0, 0.0, 0.0), "thigh_r": (-0.12, 0.0, 0.0), "calf_l": (0.04, 0.0, 0.0), "calf_r": (0.62, 0.0, 0.0), "pelvis": (-0.035, 0.0, 0.0)}, "locations": {"Root": (0.0, 0.0, 0.035)}},
    {"frame": 17, "rotations": walk_b, "locations": {"Root": (0.0, 0.0, 0.01)}},
    {"frame": 25, "rotations": {**walk_b, "thigh_r": (0.0, 0.0, 0.0), "thigh_l": (-0.12, 0.0, 0.0), "calf_r": (0.04, 0.0, 0.0), "calf_l": (0.62, 0.0, 0.0), "pelvis": (-0.035, 0.0, 0.0)}, "locations": {"Root": (0.0, 0.0, 0.035)}},
    {"frame": 33, "rotations": walk_a, "locations": {"Root": (0.0, 0.0, 0.01)}},
], loop=True)
# --- end copy ---

# Dump the authored fcurve keys before export.
action = bpy.data.actions.get('HG_Walk')
print('HG_ACTION_SLOTS=', [s.identifier for s in action.slots] if hasattr(action, 'slots') else 'n/a')
for layer in action.layers:
    for strip in layer.strips:
        for bag in strip.channelbags:
            for fc in bag.fcurves:
                if 'calf_l' in fc.data_path or 'thigh_l' in fc.data_path:
                    keys = [(round(k.co.x, 1), round(k.co.y, 4)) for k in fc.keyframe_points]
                    print(f'FCURVE {fc.data_path}[{fc.array_index}] {keys}')

# Evaluate pose directly (pre-export truth).
rig.animation_data.action = action
if action.slots:
    rig.animation_data.action_slot = action.slots[0]
for frame in (1, 5, 9, 13, 17, 21, 25, 29, 33):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    thigh = rig.pose.bones['thigh_l']
    calf = rig.pose.bones['calf_l']
    knee = math.degrees((thigh.tail - thigh.head).angle(calf.tail - calf.head))
    print(f'POSE f={frame} knee_l={knee:.2f} calf_e=({calf.rotation_euler.x:.3f},{calf.rotation_euler.y:.3f},{calf.rotation_euler.z:.3f})')

bpy.context.scene.render.fps = 30
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format='GLB',
    use_selection=True,
    export_apply=False,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_merge_animation='ACTION',
    export_force_sampling=False,
    export_skins=True,
    export_yup=True,
    export_extras=True,
    export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True,
)
print('HG_EXPORTED=', dst)
