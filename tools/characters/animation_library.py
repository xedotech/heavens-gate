"""Procedural clip authoring for the MakeHuman game rig.

The eleven HG_* actions are authored here exactly once.  Two entry points
consume this module:

* ``build_characters.py`` — the full MPFB compile that produces a hero from
  the CC0 source assets.
* ``rebuild_animations.py`` — an MPFB-free re-author that imports a shipped
  GLB, drops its actions, re-runs this library on the same rig, and re-exports
  with the pipeline's glTF settings.

Leg and foot channels use the rig's bone-local X axis: positive X swings the
bone tail toward the back of the character (hip extension, knee flexion,
ankle plantar-flexion); negative X swings it forward (hip flexion, knee
extension, ankle dorsi-flexion).  Arms follow the same convention, so a
negative upperarm Euler X is a forward arm swing.

Gait targets (measured as the thigh/calf knee angle by audit_gait.py):

* ``HG_Walk`` — thigh swing ~±17 degrees, swing-leg knee flexing to roughly
  35-45 degrees at mid-stride.
* ``HG_Run`` — thigh swing ~±30 degrees, swing-leg knee flexing to roughly
  60-75 degrees at mid-stride.
* Feet pitch through the cycle: dorsi-flexed at heel strike and through
  swing, plantar-flexed at toe-off.
"""

from __future__ import annotations

import bpy
from mathutils import Matrix, Vector


ANIMATED_BONES = (
    "Root",
    "pelvis",
    "spine_01",
    "spine_02",
    "spine_03",
    "neck_01",
    "head",
    "clavicle_l",
    "clavicle_r",
    "upperarm_l",
    "upperarm_r",
    "lowerarm_l",
    "lowerarm_r",
    "hand_l",
    "hand_r",
    "thigh_l",
    "thigh_r",
    "calf_l",
    "calf_r",
    "foot_l",
    "foot_r",
)


# The imported MakeHuman game rig has a spread-arm rest pose. Keep the global
# base empty: Idle solves its own relaxed arms, while action clips retain their
# authored rotations. A shared guessed Euler stance previously crossed limbs.
BASE_STANCE = {}


def reset_pose(rig) -> None:
    for bone_name in ANIMATED_BONES:
        bone = rig.pose.bones.get(bone_name)
        if bone is None:
            continue
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = (0.0, 0.0, 0.0)
        bone.location = (0.0, 0.0, 0.0)


def key_pose(rig, frame: int, rotations=None, locations=None) -> None:
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
    # Only authored bones receive tracks.  Keying every bone at Euler identity
    # overwrites the glTF bind rotation on import and visibly pulls the arms
    # into a T/crossed pose.  Unauthored bones correctly retain the verified
    # source rest pose while still allowing each clip's explicit limbs to
    # interpolate between its key poses.
    keyed_bones = set(merged_rotations) | set(locations or {})
    # Set iteration changes with Python's per-process hash seed. Stable curve
    # insertion also stabilizes the exported glTF channel/sampler ordering.
    for bone_name in sorted(keyed_bones):
        bone = rig.pose.bones.get(bone_name)
        if bone is None:
            continue
        if bone_name in merged_rotations:
            bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone_name)
        if bone_name in (locations or {}):
            bone.keyframe_insert(data_path="location", frame=frame, group=bone_name)


def build_action(rig, name: str, fps: int, poses: list[dict], loop: bool = False) -> None:
    action = bpy.data.actions.new(name=name)
    action["hg_fps"] = fps
    action["hg_loop"] = loop
    rig.animation_data_create()
    rig.animation_data.action = action
    for pose in poses:
        key_pose(
            rig,
            pose["frame"],
            rotations=pose.get("rotations", {}),
            locations=pose.get("locations", {}),
        )
    # Blender 4.4+ stores animation curves inside layered action channelbags
    # instead of exposing ``Action.fcurves``. The inserted keys already use
    # Bezier interpolation, and Three.js owns runtime looping, so no legacy
    # F-curve mutation is required here.
    rig.animation_data.action = None


def add_animation_library(rig) -> None:
    # Solve in armature space, then store the resulting local Euler rotations.
    # Fixed guessed Euler angles depend on the bone's authored roll and previously
    # crossed the arms. This preserves the bind skeleton and only authors Idle.
    reset_pose(rig)
    bpy.context.view_layer.update()
    idle_arms = {}
    for name, spread, forward in (
        ("upperarm_l", 0.22, -0.03), ("upperarm_r", -0.22, -0.03),
        ("lowerarm_l", 0.08, -0.15), ("lowerarm_r", -0.08, -0.15),
    ):
        bone = rig.pose.bones[name]
        head = bone.head.copy()
        rotation = (bone.tail - bone.head).normalized().rotation_difference(
            Vector((spread, forward, -1.0)).normalized())
        bone.matrix = (Matrix.Translation(head) @ rotation.to_matrix().to_4x4()
                       @ Matrix.Translation(-head) @ bone.matrix)
        bpy.context.view_layer.update()
        idle_arms[name] = tuple(bone.rotation_euler)
    reset_pose(rig)

    # Stride contacts: thigh swing, the trailing leg's knee already bent at
    # toe-off, the leading leg near-straight at heel strike, and feet pitched
    # to match (plantar behind, dorsal in front).  Mid poses put the deep knee
    # flex on the leg swinging through, not on the planted support leg, so the
    # cycle reads as steps instead of a shuffle.
    walk_a = {
        "thigh_l": (0.30, 0.0, 0.0), "thigh_r": (-0.30, 0.0, 0.0),
        "calf_l": (0.30, 0.0, 0.0), "calf_r": (0.06, 0.0, 0.0),
        "foot_l": (0.34, 0.0, 0.0), "foot_r": (-0.16, 0.0, 0.0),
        "upperarm_l": (-0.16, 0.0, 0.0), "upperarm_r": (0.16, 0.0, 0.0),
        "lowerarm_l": (-0.04, 0.0, 0.0), "lowerarm_r": (-0.04, 0.0, 0.0),
        "pelvis": (0.02, 0.0, -0.035), "spine_02": (-0.025, 0.0, 0.025),
    }
    walk_b = {
        "thigh_l": (-0.30, 0.0, 0.0), "thigh_r": (0.30, 0.0, 0.0),
        "calf_l": (0.06, 0.0, 0.0), "calf_r": (0.30, 0.0, 0.0),
        "foot_l": (-0.16, 0.0, 0.0), "foot_r": (0.34, 0.0, 0.0),
        "upperarm_l": (0.16, 0.0, 0.0), "upperarm_r": (-0.16, 0.0, 0.0),
        "lowerarm_l": (-0.04, 0.0, 0.0), "lowerarm_r": (-0.04, 0.0, 0.0),
        "pelvis": (0.02, 0.0, 0.035), "spine_02": (-0.025, 0.0, -0.025),
    }
    walk_pass_l = {
        **walk_a,
        # Left leg swings past the planted right leg: thigh near vertical,
        # knee flexed, toe pulled up to clear the ground.
        "thigh_l": (-0.06, 0.0, 0.0), "thigh_r": (0.04, 0.0, 0.0),
        "calf_l": (0.45, 0.0, 0.0), "calf_r": (0.10, 0.0, 0.0),
        "foot_l": (-0.12, 0.0, 0.0), "foot_r": (0.02, 0.0, 0.0),
        "upperarm_l": (-0.02, 0.0, 0.0), "upperarm_r": (0.02, 0.0, 0.0),
        "pelvis": (-0.035, 0.0, 0.0), "spine_02": (-0.02, 0.0, 0.0),
    }
    walk_pass_r = {
        **walk_b,
        "thigh_r": (-0.06, 0.0, 0.0), "thigh_l": (0.04, 0.0, 0.0),
        "calf_r": (0.45, 0.0, 0.0), "calf_l": (0.10, 0.0, 0.0),
        "foot_r": (-0.12, 0.0, 0.0), "foot_l": (0.02, 0.0, 0.0),
        "upperarm_l": (0.02, 0.0, 0.0), "upperarm_r": (-0.02, 0.0, 0.0),
        "pelvis": (-0.035, 0.0, 0.0), "spine_02": (-0.02, 0.0, 0.0),
    }
    build_action(rig, "HG_Idle", 30, [
        {"frame": 1, "rotations": {**idle_arms, "spine_02": (-0.018, 0.0, -0.012), "head": (0.01, 0.0, 0.018)}},
        {"frame": 45, "rotations": {**idle_arms, "spine_02": (0.024, 0.0, 0.012), "spine_03": (0.012, 0.0, 0.0), "head": (-0.012, 0.025, -0.018)}},
        {"frame": 90, "rotations": {**idle_arms, "spine_02": (-0.018, 0.0, -0.012), "head": (0.01, 0.0, 0.018)}},
    ], loop=True)
    build_action(rig, "HG_Walk", 30, [
        {"frame": 1, "rotations": walk_a, "locations": {"Root": (0.0, 0.0, 0.01)}},
        {"frame": 9, "rotations": walk_pass_l, "locations": {"Root": (0.0, 0.0, 0.035)}},
        {"frame": 17, "rotations": walk_b, "locations": {"Root": (0.0, 0.0, 0.01)}},
        {"frame": 25, "rotations": walk_pass_r, "locations": {"Root": (0.0, 0.0, 0.035)}},
        {"frame": 33, "rotations": walk_a, "locations": {"Root": (0.0, 0.0, 0.01)}},
    ], loop=True)
    run_a = {
        "thigh_l": (0.52, 0.0, 0.0), "thigh_r": (-0.52, 0.0, 0.0),
        "calf_l": (0.32, 0.0, 0.0), "calf_r": (0.18, 0.0, 0.0),
        "foot_l": (0.50, 0.0, 0.0), "foot_r": (-0.20, 0.0, 0.0),
        "upperarm_l": (-0.45, 0.0, 0.0), "upperarm_r": (0.45, 0.0, 0.0),
        "lowerarm_l": (-0.55, 0.0, 0.0), "lowerarm_r": (-0.55, 0.0, 0.0),
        "pelvis": (0.04, 0.0, -0.05), "spine_01": (0.10, 0.0, 0.0),
        "spine_02": (-0.04, 0.0, 0.03),
    }
    run_b = {
        "thigh_l": (-0.52, 0.0, 0.0), "thigh_r": (0.52, 0.0, 0.0),
        "calf_l": (0.18, 0.0, 0.0), "calf_r": (0.32, 0.0, 0.0),
        "foot_l": (-0.20, 0.0, 0.0), "foot_r": (0.50, 0.0, 0.0),
        "upperarm_l": (0.45, 0.0, 0.0), "upperarm_r": (-0.45, 0.0, 0.0),
        "lowerarm_l": (-0.55, 0.0, 0.0), "lowerarm_r": (-0.55, 0.0, 0.0),
        "pelvis": (0.04, 0.0, 0.05), "spine_01": (0.10, 0.0, 0.0),
        "spine_02": (-0.04, 0.0, -0.03),
    }
    run_pass_l = {
        **run_a,
        # Left knee drives up and forward through the flight phase while the
        # right leg absorbs the stance.
        "thigh_l": (-0.18, 0.0, 0.0), "thigh_r": (0.12, 0.0, 0.0),
        "calf_l": (1.05, 0.0, 0.0), "calf_r": (0.30, 0.0, 0.0),
        "foot_l": (-0.28, 0.0, 0.0), "foot_r": (0.10, 0.0, 0.0),
        "upperarm_l": (-0.08, 0.0, 0.0), "upperarm_r": (0.08, 0.0, 0.0),
        "spine_01": (0.14, 0.0, 0.0), "pelvis": (-0.08, 0.0, 0.0),
        "spine_02": (-0.02, 0.0, 0.0),
    }
    run_pass_r = {
        **run_b,
        "thigh_r": (-0.18, 0.0, 0.0), "thigh_l": (0.12, 0.0, 0.0),
        "calf_r": (1.05, 0.0, 0.0), "calf_l": (0.30, 0.0, 0.0),
        "foot_r": (-0.28, 0.0, 0.0), "foot_l": (0.10, 0.0, 0.0),
        "upperarm_l": (0.08, 0.0, 0.0), "upperarm_r": (-0.08, 0.0, 0.0),
        "spine_01": (0.14, 0.0, 0.0), "pelvis": (-0.08, 0.0, 0.0),
        "spine_02": (-0.02, 0.0, 0.0),
    }
    build_action(rig, "HG_Run", 30, [
        {"frame": 1, "rotations": run_a, "locations": {"Root": (0.0, 0.0, 0.025)}},
        {"frame": 7, "rotations": run_pass_l, "locations": {"Root": (0.0, 0.0, 0.075)}},
        {"frame": 13, "rotations": run_b, "locations": {"Root": (0.0, 0.0, 0.025)}},
        {"frame": 19, "rotations": run_pass_r, "locations": {"Root": (0.0, 0.0, 0.075)}},
        {"frame": 25, "rotations": run_a, "locations": {"Root": (0.0, 0.0, 0.025)}},
    ], loop=True)
    crouch = {
        "pelvis": (0.08, 0.0, 0.0), "spine_01": (0.19, 0.0, 0.0),
        "thigh_l": (0.56, 0.0, 0.055), "thigh_r": (0.56, 0.0, -0.055),
        "calf_l": (0.88, 0.0, 0.0), "calf_r": (0.88, 0.0, 0.0),
    }
    build_action(rig, "HG_Crouch", 30, [
        {"frame": 1, "rotations": crouch, "locations": {"Root": (0.0, 0.0, -0.34)}},
        {"frame": 18, "rotations": {**crouch, "spine_02": (-0.025, 0.0, 0.014)}, "locations": {"Root": (0.0, 0.0, -0.35)}},
        {"frame": 36, "rotations": crouch, "locations": {"Root": (0.0, 0.0, -0.34)}},
    ], loop=True)
    slide = {
        "pelvis": (0.2, 0.0, -0.08), "spine_01": (0.48, 0.0, 0.04),
        "thigh_l": (-0.18, 0.0, 0.08), "thigh_r": (0.66, 0.0, -0.08),
        "calf_l": (0.18, 0.0, 0.0), "calf_r": (1.04, 0.0, 0.0),
        "upperarm_l": (-0.24, 0.0, -0.92), "upperarm_r": (0.36, 0.0, 0.88),
    }
    build_action(rig, "HG_Slide", 30, [
        {"frame": 1, "rotations": crouch, "locations": {"Root": (0.0, 0.0, -0.34)}},
        {"frame": 5, "rotations": slide, "locations": {"Root": (0.0, 0.0, -0.48)}},
        {"frame": 18, "rotations": slide, "locations": {"Root": (0.0, 0.0, -0.48)}},
        {"frame": 22, "rotations": crouch, "locations": {"Root": (0.0, 0.0, -0.34)}},
    ])
    aim = {
        "spine_02": (-0.05, 0.0, 0.08), "clavicle_r": (0.08, -0.08, 0.0),
        "upperarm_r": (-1.22, 0.12, 0.18), "lowerarm_r": (-0.38, -0.06, 0.0),
        "upperarm_l": (-0.82, -0.16, -0.46), "lowerarm_l": (-0.82, 0.08, 0.08),
        "head": (0.02, 0.0, -0.06),
    }
    build_action(rig, "HG_Aim", 30, [{"frame": 1, "rotations": aim}, {"frame": 12, "rotations": aim}], loop=True)
    recoil = dict(aim)
    recoil.update({"spine_02": (-0.12, 0.0, 0.08), "upperarm_r": (-1.08, 0.12, 0.2), "head": (-0.04, 0.0, -0.06)})
    build_action(rig, "HG_Fire", 30, [
        {"frame": 1, "rotations": aim}, {"frame": 3, "rotations": recoil}, {"frame": 8, "rotations": aim},
    ])
    reload_pose = {
        "spine_02": (-0.08, 0.0, 0.12), "head": (0.12, 0.08, -0.1),
        "clavicle_r": (0.08, -0.08, 0.0), "upperarm_r": (-1.0, 0.2, 0.34),
        "lowerarm_r": (-0.92, -0.08, 0.16), "upperarm_l": (-1.0, -0.2, -0.52),
        "lowerarm_l": (-1.12, 0.14, 0.2),
    }
    build_action(rig, "HG_Reload", 30, [
        {"frame": 1, "rotations": aim},
        {"frame": 7, "rotations": reload_pose},
        {"frame": 26, "rotations": reload_pose},
        {"frame": 36, "rotations": aim},
    ])
    build_action(rig, "HG_Jump", 30, [
        {"frame": 1, "rotations": {"spine_01": (0.14, 0.0, 0.0), "thigh_l": (0.25, 0.0, 0.06), "thigh_r": (0.25, 0.0, -0.06), "calf_l": (0.62, 0.0, 0.0), "calf_r": (0.62, 0.0, 0.0)}},
        {"frame": 9, "rotations": {"spine_01": (-0.05, 0.0, 0.0), "thigh_l": (-0.15, 0.0, 0.06), "thigh_r": (-0.15, 0.0, -0.06), "upperarm_l": (-0.4, 0.0, -0.95), "upperarm_r": (-0.4, 0.0, 0.95)}},
        {"frame": 18, "rotations": {"spine_01": (0.1, 0.0, 0.0), "thigh_l": (0.18, 0.0, 0.06), "thigh_r": (0.18, 0.0, -0.06), "calf_l": (0.48, 0.0, 0.0), "calf_r": (0.48, 0.0, 0.0)}},
    ])
    hit_recovery = {
        "spine_01": (-0.012, 0.0, 0.015), "spine_02": (-0.008, 0.0, 0.008),
        "head": (0.008, 0.0, -0.012), "upperarm_l": (0.018, 0.0, -0.012),
    }
    build_action(rig, "HG_Hit", 30, [
        # Explicitly key the near-rest pose so the exporter preserves a
        # playable pre-impact and recovery interval instead of collapsing the
        # sparse reaction to a zero-duration pose at the impact frame.
        {"frame": 1, "rotations": hit_recovery},
        {"frame": 4, "rotations": {"spine_01": (-0.12, 0.0, 0.34), "spine_02": (-0.08, 0.0, 0.18), "head": (0.08, 0.0, -0.2), "upperarm_l": (0.45, 0.0, -0.2)}},
        {"frame": 14, "rotations": hit_recovery},
    ])
    build_action(rig, "HG_Death", 30, [
        {"frame": 1},
        {"frame": 12, "rotations": {"pelvis": (0.15, 0.0, 0.35), "spine_01": (-0.3, 0.0, 0.25), "head": (0.22, 0.0, -0.18), "thigh_l": (0.28, 0.0, 0.12), "thigh_r": (-0.18, 0.0, -0.1)}},
        {"frame": 32, "rotations": {"pelvis": (0.3, 0.0, 0.24), "spine_01": (-0.42, 0.0, 0.18), "head": (0.28, 0.0, -0.2), "upperarm_l": (0.34, 0.0, -0.58), "upperarm_r": (-0.18, 0.0, 0.42)}, "locations": {"Root": (0.0, 1.28, 0.42)}},
        {"frame": 45, "rotations": {"pelvis": (0.28, 0.0, 0.22), "spine_01": (-0.44, 0.0, 0.18), "head": (0.3, 0.0, -0.2), "upperarm_l": (0.34, 0.0, -0.58), "upperarm_r": (-0.18, 0.0, 0.42)}, "locations": {"Root": (0.0, 1.48, 0.44)}},
    ])
    reset_pose(rig)
