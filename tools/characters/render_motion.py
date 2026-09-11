"""Render one imported hero action frame for animation review.

This is a deterministic visual QA probe, not part of the runtime build. It
keeps animation regressions reviewable without opening Blender interactively.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--action", default="HG_Idle")
    parser.add_argument("--frame", type=int, default=1)
    parser.add_argument("--dump-pose", action="store_true", help="Print key pose-bone transforms before rendering")
    parser.add_argument(
        "--pose",
        default="",
        help="Optional semicolon-separated bone Euler probe, e.g. upperarm_l:-0.3,0,0;upperarm_r:0.3,0,0",
    )
    return parser.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def main() -> None:
    args = parse_args()
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError("No armature found in imported hero")
    armature = armatures[0]
    if args.action.lower() != "none":
        action = bpy.data.actions.get(args.action)
        if action is None:
            raise RuntimeError(f"Action {args.action!r} was not found")
        armature.animation_data_create()
        armature.animation_data.action = action
    bpy.context.scene.frame_set(max(1, args.frame))
    if args.pose:
        for item in args.pose.split(";"):
            name, _, values = item.partition(":")
            if not _:
                raise ValueError(f"Invalid --pose item {item!r}")
            bone = armature.pose.bones.get(name.strip())
            if bone is None:
                raise ValueError(f"Unknown --pose bone {name.strip()!r}")
            angles = [float(value.strip()) for value in values.split(",")]
            if len(angles) != 3:
                raise ValueError(f"--pose values for {name.strip()!r} must be x,y,z")
            bone.rotation_mode = "XYZ"
            bone.rotation_euler = angles
        bpy.context.view_layer.update()
    if args.dump_pose:
        for bone_name in ("clavicle_l", "clavicle_r", "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"):
            bone = armature.pose.bones.get(bone_name)
            if bone is None:
                continue
            print(
                f"HG_POSE_BONE={bone_name} "
                f"rotation=({bone.rotation_euler.x:.6f},{bone.rotation_euler.y:.6f},{bone.rotation_euler.z:.6f}) "
                f"location=({bone.location.x:.6f},{bone.location.y:.6f},{bone.location.z:.6f})"
            )

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.scale *= 2.35
            # Blender's glTF importer presents the Y-up asset as Z-up.
            obj.rotation_euler[2] = math.radians(7.0)
    bpy.context.view_layer.update()
    for mesh in meshes:
        mesh.select_set(False)
        mesh.hide_viewport = False
        mesh.hide_render = False
    # Use the imported mesh bounds after animation has evaluated.
    min_corner = Vector((float("inf"), float("inf"), float("inf")))
    max_corner = Vector((float("-inf"), float("-inf"), float("-inf")))
    for mesh in meshes:
        for corner in mesh.bound_box:
            world = mesh.matrix_world @ Vector(corner)
            min_corner.x = min(min_corner.x, world.x)
            min_corner.y = min(min_corner.y, world.y)
            min_corner.z = min(min_corner.z, world.z)
            max_corner.x = max(max_corner.x, world.x)
            max_corner.y = max(max_corner.y, world.y)
            max_corner.z = max(max_corner.z, world.z)
    center = (min_corner + max_corner) * 0.5
    height = max(1.0, max_corner.z - min_corner.z)
    radius = max(2.8, height * 1.18)

    floor = bpy.data.meshes.new("HG_QA_Floor_Mesh")
    floor.from_pydata([(-8, -8, 0), (8, -8, 0), (8, 8, 0), (-8, 8, 0)], [], [(0, 1, 2, 3)])
    floor.update()
    floor_obj = bpy.data.objects.new("HG_QA_Floor", floor)
    bpy.context.collection.objects.link(floor_obj)
    floor_obj.location.z = min_corner.z - 0.01

    camera_data = bpy.data.cameras.new("HG_QA_Camera")
    camera = bpy.data.objects.new("HG_QA_Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (center.x + height * 0.75, center.y - height * 2.0, center.z + height * 0.16)
    camera.data.lens = 58
    bpy.context.scene.camera = camera
    direction = center - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    for name, location, energy, size in (
        ("Key", (center.x + height * 0.8, center.y - height * 1.5, center.z + height * 1.1), 850, 4),
        ("Fill", (center.x - height * 0.9, center.y - height * 0.6, center.z + height * 0.7), 520, 5),
        ("Rim", (center.x, center.y + height * 1.3, center.z - height * 1.0), 900, 3),
    ):
        light_data = bpy.data.lights.new(name, type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light = bpy.data.objects.new(name, light_data)
        bpy.context.collection.objects.link(light)
        light.location = location
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()

    floor_material = bpy.data.materials.new("HG_QA_Floor_Material")
    floor_material.diffuse_color = (0.055, 0.065, 0.07, 1)
    floor_obj.data.materials.append(floor_material)
    floor_obj.hide_render = False

    scene = bpy.context.scene
    # Workbench keeps the probe deterministic and fast; this tool judges
    # skeletal pose and clipping, while the turntable tool covers materials.
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 240
    scene.render.resolution_y = 320
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(output_path)
    scene.world.color = (0.012, 0.015, 0.018)
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    bpy.ops.render.render(write_still=True)
    print(f"HG_MOTION_RENDER={scene.render.filepath} action={args.action} frame={args.frame}")


if __name__ == "__main__":
    main()
