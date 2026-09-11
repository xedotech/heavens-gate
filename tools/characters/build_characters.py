"""Build Heaven's Gate game-ready human characters inside Blender.

The script is intentionally deterministic. Run it through the checked Blender/MPFB
toolchain; it does not import Python packages from the host machine.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import sys
import time

import bpy
from mathutils import Matrix, Vector


def dynamic_import(package_suffix: str, key: str):
    """Resolve a service from Blender's extension namespace."""
    for module_name in tuple(sys.modules):
        if module_name.endswith(package_suffix):
            module = importlib.import_module(module_name)
            return getattr(module, key)
    raise RuntimeError(f"MPFB service not loaded: {package_suffix}.{key}")


HumanService = dynamic_import("mpfb.services.humanservice", "HumanService")
AssetService = dynamic_import("mpfb.services.assetservice", "AssetService")
FaceService = dynamic_import("mpfb.services.faceservice", "FaceService")
TargetService = dynamic_import("mpfb.services.targetservice", "TargetService")
ExportService = dynamic_import("mpfb.services.exportservice", "ExportService")


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

HAIR_TOKENS = ("hair", "short", "bob", "braid", "ponytail")

# The imported MakeHuman game rig has a spread-arm rest pose. Keep the global
# base empty: Idle solves its own relaxed arms, while action clips retain their
# authored rotations. A shared guessed Euler stance previously crossed limbs.
BASE_STANCE = {}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--character", default="aurel-seraph")
    parser.add_argument("--lod", choices=("hero", "crowd"), default="hero")
    parser.add_argument("--no-facial", action="store_true")
    parser.add_argument("--no-animations", action="store_true")
    return parser.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.actions, bpy.data.materials, bpy.data.images):
        for block in tuple(collection):
            if block.users == 0:
                collection.remove(block)


def find_asset(filename: str, subdir: str) -> str:
    path = AssetService.find_asset_absolute_path(filename, asset_subdir=subdir)
    if path is None:
        raise FileNotFoundError(f"Missing CC0 asset: {subdir}/{filename}")
    return path


def add_part(basemesh, subdir: str, filename: str, asset_type: str, subdiv: int):
    return HumanService.add_mhclo_asset(
        find_asset(filename, subdir),
        basemesh,
        asset_type=asset_type,
        subdiv_levels=subdiv,
        material_type="GAMEENGINE",
    )


def add_outfit_clearance(mesh, distance: float) -> None:
    """Move fitted garments slightly above the body to avoid pose-time z-fighting.

    Legacy MakeHuman garments were authored against the neutral base. Their
    interpolated weights can settle a few millimetres inside a macro-shaped
    body once shoulders and hips leave the source A-pose. A small normal-space
    clearance is cheaper and more deterministic than runtime depth bias, and
    keeps the full facial shape-key contract intact.
    """
    for vertex in mesh.data.vertices:
        vertex.co += vertex.normal * distance
    mesh.data.update()


def strip_export_helper_geometry(mesh) -> dict:
    """Remove authoring shells and joint cubes only after all MPFB fitting.

    ``mask_helpers=False`` exposes (rather than removes) MakeHuman's helper
    skirt, tights, hair shell and joint cubes. A glTF export that retains
    shape keys does not bake the authoring MASK modifiers, so those shells
    otherwise cover the real human mesh. MPFB's export service deletes its
    semantic helper groups in edit mode, preserving every facial shape key.
    Run this after asset fitting/face interpolation: those operations rely
    on the original basemesh vertex indices and helper vertices.
    """
    def group_vertices(predicate) -> set[int]:
        indices = {group.index for group in mesh.vertex_groups if predicate(group.name)}
        return {
            vertex.index
            for vertex in mesh.data.vertices
            if any(group.group in indices and group.weight > 0 for group in vertex.groups)
        }

    def is_helper_group(name: str) -> bool:
        return name in {"HelperGeometry", "JointCubes"} or name.startswith(("helper-", "joint-"))

    vertices_before = len(mesh.data.vertices)
    helper_vertices_before = group_vertices(is_helper_group)
    body_vertices_before = group_vertices(lambda name: name == "body")
    if not body_vertices_before or helper_vertices_before & body_vertices_before:
        raise RuntimeError("Body/helper groups are missing or overlap; refusing destructive export cleanup")
    shape_keys_before = tuple(key.name for key in mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else ()

    ExportService.bake_modifiers_remove_helpers(
        mesh, bake_masks=False, bake_subdiv=False, remove_helpers=True, also_proxy=False,
    )

    vertices_after = len(mesh.data.vertices)
    helper_vertices_after = group_vertices(is_helper_group)
    body_vertices_after = group_vertices(lambda name: name == "body")
    shape_keys_after = tuple(key.name for key in mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else ()
    if helper_vertices_after or vertices_before - vertices_after != len(helper_vertices_before):
        raise RuntimeError("Export helper cleanup did not remove exactly the semantic helper vertices")
    if len(body_vertices_before) != len(body_vertices_after):
        raise RuntimeError("Export helper cleanup changed the renderable body topology")
    if shape_keys_before != shape_keys_after:
        raise RuntimeError("Export helper cleanup changed the facial shape-key contract")
    if mesh.data.shape_keys and any(len(key.data) != vertices_after for key in mesh.data.shape_keys.key_blocks):
        raise RuntimeError("Facial shape-key topology differs from the cleaned body")

    return {
        "method": "MPFB semantic helper-group removal",
        "vertexCountBefore": vertices_before,
        "vertexCountAfter": vertices_after,
        "removedVertices": vertices_before - vertices_after,
        "remainingHelperVertices": len(helper_vertices_after),
        "bodyVerticesPreserved": len(body_vertices_after),
        "facialMorphsPreserved": max(0, len(shape_keys_after) - 1),
    }


def bake_clothing_occlusion(mesh) -> dict:
    """Bake authored clothing masks while retaining the facial shape library."""
    masks = [modifier for modifier in mesh.modifiers if modifier.type == 'MASK']
    names = [modifier.name for modifier in masks]
    before = len(mesh.data.vertices)
    keys = tuple(key.name for key in mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else ()
    if masks:
        ExportService.bake_modifiers_remove_helpers(
            mesh, bake_masks=True, bake_subdiv=False, remove_helpers=False, also_proxy=False,
        )
    after = len(mesh.data.vertices)
    remaining_keys = tuple(key.name for key in mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else ()
    if after == 0 or after > before or remaining_keys != keys:
        raise RuntimeError('Clothing mask bake violated body/shape-key contract')
    if mesh.data.shape_keys and any(len(key.data) != after for key in mesh.data.shape_keys.key_blocks):
        raise RuntimeError('Clothing mask bake produced inconsistent morph topology')
    return {'masks': names, 'verticesBefore': before, 'verticesAfter': after,
            'occludedVerticesRemoved': before - after, 'morphsPreserved': max(0, len(keys) - 1)}


def validate_character_spec(spec: dict) -> None:
    required = {
        "id", "label", "masculinity", "age", "muscle", "weight", "height",
        "proportions", "race", "skin", "hair", "eyebrows", "eyelashes", "clothes", "accent",
    }
    missing = sorted(required.difference(spec))
    if missing:
        raise ValueError(f"{spec.get('id', 'character')}: missing fields: {', '.join(missing)}")
    for key in ("masculinity", "age", "muscle", "weight", "height", "proportions"):
        if not 0.0 <= float(spec[key]) <= 1.0:
            raise ValueError(f"{spec['id']}: {key} must be between 0 and 1")
    if set(spec["race"]) != {"african", "asian", "caucasian"}:
        raise ValueError(f"{spec['id']}: race must define african, asian, and caucasian weights")
    if abs(sum(float(value) for value in spec["race"].values()) - 1.0) > 0.0001:
        raise ValueError(f"{spec['id']}: race weights must sum to 1")
    body_role = "male" if float(spec["masculinity"]) >= 0.5 else "female"
    if body_role not in spec["skin"].lower():
        raise ValueError(f"{spec['id']}: {body_role} body preset is incompatible with {spec['skin']}")
    gendered_clothes = [name for name in spec["clothes"] if "male_" in name.lower() or "female_" in name.lower()]
    if any(not name.lower().startswith(f"{body_role}_") for name in gendered_clothes):
        raise ValueError(f"{spec['id']}: clothing is incompatible with the {body_role} body preset")


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
    walk_a = {
        # Small sagittal swings keep the feet planted and the shoulders
        # readable on the MakeHuman game rig.  Large z-axis values look like
        # crossed limbs because the imported clavicle basis is already rotated.
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
    build_action(rig, "HG_Idle", 30, [
        {"frame": 1, "rotations": {**idle_arms, "spine_02": (-0.018, 0.0, -0.012), "head": (0.01, 0.0, 0.018)}},
        {"frame": 45, "rotations": {**idle_arms, "spine_02": (0.024, 0.0, 0.012), "spine_03": (0.012, 0.0, 0.0), "head": (-0.012, 0.025, -0.018)}},
        {"frame": 90, "rotations": {**idle_arms, "spine_02": (-0.018, 0.0, -0.012), "head": (0.01, 0.0, 0.018)}},
    ], loop=True)
    build_action(rig, "HG_Walk", 30, [
        {"frame": 1, "rotations": walk_a, "locations": {"Root": (0.0, 0.0, 0.01)}},
        {"frame": 9, "rotations": {**walk_a, "thigh_l": (0.0, 0.0, 0.0), "thigh_r": (-0.12, 0.0, 0.0), "calf_l": (0.04, 0.0, 0.0), "calf_r": (0.62, 0.0, 0.0), "pelvis": (-0.035, 0.0, 0.0)}, "locations": {"Root": (0.0, 0.0, 0.035)}},
        {"frame": 17, "rotations": walk_b, "locations": {"Root": (0.0, 0.0, 0.01)}},
        {"frame": 25, "rotations": {**walk_b, "thigh_r": (0.0, 0.0, 0.0), "thigh_l": (-0.12, 0.0, 0.0), "calf_r": (0.04, 0.0, 0.0), "calf_l": (0.62, 0.0, 0.0), "pelvis": (-0.035, 0.0, 0.0)}, "locations": {"Root": (0.0, 0.0, 0.035)}},
        {"frame": 33, "rotations": walk_a, "locations": {"Root": (0.0, 0.0, 0.01)}},
    ], loop=True)
    run_a = dict(walk_a)
    run_b = dict(walk_b)
    run_a.update({"thigh_l": (0.3, 0.0, 0.0), "thigh_r": (-0.3, 0.0, 0.0), "upperarm_l": (-0.24, 0.0, 0.0), "upperarm_r": (0.24, 0.0, 0.0), "spine_01": (0.08, 0.0, 0.0)})
    run_b.update({"thigh_l": (-0.3, 0.0, 0.0), "thigh_r": (0.3, 0.0, 0.0), "upperarm_l": (0.24, 0.0, 0.0), "upperarm_r": (-0.24, 0.0, 0.0), "spine_01": (0.08, 0.0, 0.0)})
    build_action(rig, "HG_Run", 30, [
        {"frame": 1, "rotations": run_a, "locations": {"Root": (0.0, 0.0, 0.025)}},
        {"frame": 7, "rotations": {**run_a, "thigh_l": (0.0, 0.0, 0.0), "thigh_r": (-0.25, 0.0, 0.0), "calf_l": (0.12, 0.0, 0.0), "calf_r": (1.05, 0.0, 0.0), "spine_01": (0.14, 0.0, 0.0), "pelvis": (-0.08, 0.0, 0.0)}, "locations": {"Root": (0.0, 0.0, 0.075)}},
        {"frame": 13, "rotations": run_b, "locations": {"Root": (0.0, 0.0, 0.025)}},
        {"frame": 19, "rotations": {**run_b, "thigh_r": (0.0, 0.0, 0.0), "thigh_l": (-0.25, 0.0, 0.0), "calf_r": (0.12, 0.0, 0.0), "calf_l": (1.05, 0.0, 0.0), "spine_01": (0.14, 0.0, 0.0), "pelvis": (-0.08, 0.0, 0.0)}, "locations": {"Root": (0.0, 0.0, 0.075)}},
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


def configure_materials(accent: str) -> None:
    accent_rgb = tuple(int(accent[i : i + 2], 16) / 255 for i in (1, 3, 5))
    for material in bpy.data.materials:
        name = material.name.lower()
        if name.endswith(".body"):
            role = "skin"
        elif "high-poly" in name or name.endswith(".eye"):
            role = "eye"
        elif any(token in name for token in HAIR_TOKENS):
            role = "hair"
        elif "eyebrow" in name:
            role = "eyebrow"
        elif "eyelash" in name:
            role = "eyelash"
        elif "teeth" in name:
            role = "teeth"
        elif "tongue" in name:
            role = "tongue"
        elif "shoe" in name or "boot" in name:
            role = "footwear"
        elif any(token in name for token in ("suit", "coat", "shirt", "trouser")):
            role = "cloth"
        else:
            role = "surface"
        material.use_nodes = True
        material["hg_source_license"] = "CC0-1.0"
        material["hg_accent"] = accent
        material["hg_material_role"] = role
        material.diffuse_color = (*material.diffuse_color[:3], 1.0)
        # MPFB's GAMEENGINE materials default to BLEND.  That is correct for
        # authoring previews but causes depth-sorted skin/hair to read as a
        # dark mask in Three.js and in offline turntables.  Dithered surfaces
        # preserve cutout lashes/hair while keeping opaque skin and cloth
        # stable in the depth buffer; Blender's legacy fallback is HASHED.
        if hasattr(material, "surface_render_method"):
            material.surface_render_method = "DITHERED"
        elif hasattr(material, "blend_method"):
            material.blend_method = "HASHED"
        if material.node_tree:
            for node in material.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    if role not in {"hair", "eyebrow", "eyelash", "eye"} and "Alpha" in node.inputs:
                        # Skin/cloth/body maps are opaque albedo data.  MPFB
                        # links their image alpha into Principled Alpha, which
                        # makes the glTF exporter mark the entire material as
                        # BLEND and causes dark depth-sorted face masks.  Keep
                        # alpha cutouts for hair, lashes and the eye overlay.
                        for link in tuple(node.inputs["Alpha"].links):
                            node.id_data.links.remove(link)
                        node.inputs["Alpha"].default_value = 1.0
                    if role in ("cloth", "footwear") and "Base Color" in node.inputs:
                        node.inputs["Base Color"].default_value = (*accent_rgb, 1.0)
                    if "Roughness" in node.inputs:
                        node.inputs["Roughness"].default_value = max(0.32, min(0.88, node.inputs["Roughness"].default_value))
                    if "Coat Weight" in node.inputs:
                        # Woven clothing has no glossy varnish layer. The old
                        # universal coat produced broad sharp highlight patches.
                        node.inputs["Coat Weight"].default_value = 0.0 if role == 'cloth' else 0.08
        if role in ("cloth", "footwear"):
            material.diffuse_color = (*accent_rgb, 1.0)


def select_hierarchy(root) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in tuple(bpy.data.objects):
        cursor = obj.parent
        while cursor is not None:
            if cursor == root:
                obj.select_set(True)
                break
            cursor = cursor.parent
    bpy.context.view_layer.objects.active = root


def build_character(spec: dict, output: Path, lod: str, facial: bool, animations: bool) -> dict:
    started = time.perf_counter()
    reset_scene()
    validate_character_spec(spec)
    macro = {
        "gender": spec["masculinity"], "age": spec["age"], "muscle": spec["muscle"],
        "weight": spec["weight"], "proportions": spec["proportions"], "height": spec["height"],
        "cupsize": 0.36 if spec["masculinity"] < 0.5 else 0.5,
        "firmness": 0.56,
        "race": spec["race"],
    }
    basemesh = HumanService.create_human(
        # Keep original helper topology through rig/garment/face fitting, but
        # hide it during authoring. strip_export_helper_geometry removes the
        # actual helper vertices before export without losing facial morphs.
        mask_helpers=True,
        detailed_helpers=lod == "hero",
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=macro,
    )
    basemesh.name = f"HG_{spec['id']}_body"
    removed_identity_targets = len(basemesh.data.shape_keys.key_blocks) - 1 if basemesh.data.shape_keys else 0
    if removed_identity_targets:
        TargetService.bake_targets(basemesh)
    HumanService.set_character_skin(find_asset(spec["skin"], "skins"), basemesh, skin_type="GAMEENGINE")
    rig = HumanService.add_builtin_rig(basemesh, "game_engine")
    rig.name = f"HG_{spec['id']}_rig"
    rig["hg_character_id"] = spec["id"]
    rig["hg_character_label"] = spec["label"]
    rig["hg_source_license"] = "CC0-1.0"
    subdiv = 1 if lod == "hero" else 0
    add_part(basemesh, "eyes", "high-poly.mhclo" if lod == "hero" else "low-poly.mhclo", "Eyes", subdiv)
    add_part(basemesh, "eyebrows", spec["eyebrows"], "Eyebrows", subdiv)
    add_part(basemesh, "eyelashes", spec["eyelashes"], "Eyelashes", subdiv)
    add_part(basemesh, "teeth", "teeth_base.mhclo", "Teeth", subdiv)
    add_part(basemesh, "tongue", "tongue01.mhclo", "Tongue", subdiv)
    add_part(basemesh, "hair", spec["hair"], "Hair", subdiv)
    for clothing in spec["clothes"]:
        garment = add_part(basemesh, "clothes", clothing, "Clothes", subdiv)
        add_outfit_clearance(garment, 0.006 if "shoe" in clothing.lower() else 0.014)
    if facial:
        FaceService.load_targets(
            basemesh,
            load_microsoft_visemes=False,
            load_meta_visemes=True,
            load_arkit_faceunits=True,
        )
        FaceService.interpolate_targets(basemesh)
    helper_removal = strip_export_helper_geometry(basemesh)
    clothing_occlusion = bake_clothing_occlusion(basemesh)
    if animations:
        add_animation_library(rig)
    configure_materials(spec["accent"])
    bpy.context.scene.render.fps = 30
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 90
    select_hierarchy(rig)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_image_format="WEBP",
        export_image_quality=88,
        use_selection=True,
        export_apply=False,
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_merge_animation="ACTION",
        export_force_sampling=False,
        export_skins=True,
        export_tangents=True,
        export_morph=facial,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=True,
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
    )
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    used_materials = {
        material.name
        for mesh in meshes
        for material in mesh.data.materials
        if material is not None
    }
    report = {
        "schemaVersion": 2,
        "compilerVersion": "hg-character-compiler-2",
        "blenderVersion": bpy.app.version_string,
        "specSha256": hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "id": spec["id"],
        "label": spec["label"],
        "lod": lod,
        "output": output.name,
        "bytes": output.stat().st_size,
        "meshCount": len(meshes),
        "vertexCount": sum(len(obj.data.vertices) for obj in meshes),
        "materialCount": len(used_materials),
        "boneCount": len(rig.data.bones),
        "actionCount": len(bpy.data.actions),
        "bodyMorphCount": len(basemesh.data.shape_keys.key_blocks) - 1 if basemesh.data.shape_keys else 0,
        "strippedIdentityMorphCount": removed_identity_targets,
        "helperRemoval": helper_removal,
        "clothingOcclusion": clothing_occlusion,
        "buildSeconds": round(time.perf_counter() - started, 2),
        "license": "CC0-1.0",
    }
    report_path = output.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("HG_CHARACTER_REPORT=" + json.dumps(report, separators=(",", ":")))
    return report


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    specs = {item["id"]: item for item in manifest["characters"]}
    selected = list(specs.values()) if args.character == "all" else [specs[args.character]]
    output_dir = Path(args.output).resolve()
    reports = []
    for spec in selected:
        suffix = "hero" if args.lod == "hero" else "crowd"
        reports.append(build_character(
            spec,
            output_dir / f"{spec['id']}-{suffix}.glb",
            args.lod,
            not args.no_facial and args.lod == "hero",
            not args.no_animations,
        ))
    (output_dir / "build-report.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
