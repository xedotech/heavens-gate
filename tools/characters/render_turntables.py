"""Render deterministic close-range turntable evidence for the hero assets.

This is a local QA utility. It imports the generated GLBs, renders a neutral
three-quarter portrait and writes one PNG per skin. It deliberately does not
modify the source binaries.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in tuple(collection):
            if block.users == 0:
                collection.remove(block)


def add_area_light(name: str, location: tuple[float, float, float], energy: float, size: float, color: tuple[float, float, float]) -> None:
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    light = bpy.data.objects.new(name, data)
    light.location = location
    bpy.context.collection.objects.link(light)


def point_at(object_: bpy.types.Object, target: Vector) -> None:
    object_.rotation_euler = (target - object_.location).to_track_quat("-Z", "Y").to_euler()


def render_asset(
    asset: Path,
    output: Path,
    dump_materials: bool = False,
    inspect_only: bool = False,
    opaque_materials: bool = False,
    resolution: tuple[int, int] = (640, 800),
    fast_workbench: bool = False,
    dump_bounds: bool = False,
    dump_components: bool = False,
) -> None:
    reset_scene()
    previous_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(asset))
    for object_ in tuple(bpy.context.scene.objects):
        if object_.type in {"MESH", "ARMATURE"} and not object_.name.startswith("HG_"):
            bpy.data.objects.remove(object_, do_unlink=True)
    imported = [object_ for object_ in bpy.context.scene.objects if object_.type in {"MESH", "ARMATURE"}]
    root = next((object_ for object_ in imported if object_.name.startswith("HG_") and object_.type == "ARMATURE"), None)
    if root is None:
        root = next((object_ for object_ in imported if object_.type == "ARMATURE"), None)
    if root is None:
        raise RuntimeError(f"No armature found in {asset}")

    # The importer selects the first action (Aim). Clear its residual channels
    # before evaluating sparse Idle tracks so the preview has a defined pose.
    root.animation_data_create()
    root.animation_data.action = None
    for track in root.animation_data.nla_tracks:
        track.mute = True
    for bone in root.pose.bones:
        bone.matrix_basis.identity()
    idle = next((action for action in bpy.data.actions if action not in previous_actions
                 and (action.name == 'HG_Idle' or action.name.startswith('HG_Idle.'))), None)
    if idle is None:
        raise RuntimeError(f"Missing HG_Idle action in {asset}")
    root.animation_data.action = idle
    if idle.slots:
        root.animation_data.action_slot = idle.slots[0]
    bpy.context.scene.frame_set(1)

    # Match the gameplay normalization in app/game/character.ts.
    root.scale = (2.35, 2.35, 2.35)
    root.location = (0.0, 0.0, 0.0)
    # Blender's glTF importer presents the Y-up asset as Z-up.
    root.rotation_euler = (0.0, 0.0, math.radians(7.0))
    if opaque_materials:
        for material in bpy.data.materials:
            if hasattr(material, "surface_render_method"):
                material.surface_render_method = "DITHERED"
            elif hasattr(material, "blend_method"):
                material.blend_method = "HASHED"
    bpy.context.view_layer.update()
    if dump_materials:
        for material in sorted((material for material in bpy.data.materials if material is not None), key=lambda item: item.name):
            print(
                f"HG_MATERIAL={material.name} "
                f"surface={getattr(material, 'surface_render_method', 'n/a')} "
                f"blend={getattr(material, 'blend_method', 'n/a')} "
                f"diffuse={tuple(round(value, 3) for value in material.diffuse_color)}"
            )
    if dump_bounds:
        for mesh in sorted((object_ for object_ in bpy.context.scene.objects if object_.type == "MESH"), key=lambda item: item.name):
            points = [mesh.matrix_world @ Vector(corner) for corner in mesh.bound_box]
            minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
            maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
            print(f"HG_MESH_BOUNDS={mesh.name} min={tuple(round(value, 4) for value in minimum)} max={tuple(round(value, 4) for value in maximum)}")
    if dump_components:
        for mesh in sorted((object_ for object_ in bpy.context.scene.objects if object_.type == "MESH"), key=lambda item: item.name):
            adjacency = [set() for _ in mesh.data.vertices]
            for polygon in mesh.data.polygons:
                vertices = tuple(polygon.vertices)
                for index in vertices:
                    adjacency[index].update(other for other in vertices if other != index)
            seen = set()
            components = []
            for start in range(len(adjacency)):
                if start in seen:
                    continue
                stack = [start]
                seen.add(start)
                size = 0
                members = []
                while stack:
                    current = stack.pop()
                    size += 1
                    members.append(current)
                    for neighbor in adjacency[current]:
                        if neighbor not in seen:
                            seen.add(neighbor)
                            stack.append(neighbor)
                components.append((size, members))
            tiny = sorted(size for size, _ in components if size < 100)
            if tiny:
                print(f"HG_MESH_COMPONENTS={mesh.name} total={len(components)} tiny={tiny}")
            for size, members in components:
                if size >= 100:
                    continue
                points = [mesh.matrix_world @ mesh.data.vertices[index].co for index in members]
                minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
                maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
                if maximum.z < 0.18 and (maximum - minimum).length < 0.5:
                    print(f"HG_NEAR_GROUND_COMPONENT={mesh.name} size={size} min={tuple(round(value, 4) for value in minimum)} max={tuple(round(value, 4) for value in maximum)}")
    if inspect_only:
        return
    world_points = [object_.matrix_world @ Vector(corner) for object_ in imported if object_.type == "MESH" for corner in object_.bound_box]
    if not world_points:
        raise RuntimeError(f"No mesh bounds found in {asset}")
    minimum = Vector((min(point.x for point in world_points), min(point.y for point in world_points), min(point.z for point in world_points)))
    maximum = Vector((max(point.x for point in world_points), max(point.y for point in world_points), max(point.z for point in world_points)))
    center = (minimum + maximum) * 0.5
    height = max(1.0, maximum.z - minimum.z)

    floor_data = bpy.data.materials.new("HG QA neutral floor")
    floor_data.diffuse_color = (0.025, 0.032, 0.035, 1.0)
    bpy.ops.mesh.primitive_plane_add(size=20.0, location=(center.x, center.y, minimum.z - 0.01))
    floor = bpy.context.object
    floor.data.materials.append(floor_data)
    floor.is_shadow_catcher = False

    camera_data = bpy.data.cameras.new("HG QA camera")
    camera = bpy.data.objects.new("HG QA camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (center.x + height * 0.75, center.y - height * 2.0, center.z + height * 0.16)
    camera_data.lens = 64.0
    camera_data.sensor_width = 36.0
    point_at(camera, center + Vector((0.0, height * 0.02, 0.0)))
    bpy.context.scene.camera = camera

    add_area_light("HG QA key", (center.x + height * 0.8, center.y - height * 1.5, center.z + height * 1.1), 850.0, height * 0.8, (1.0, 0.86, 0.68))
    add_area_light("HG QA fill", (center.x - height * 0.9, center.y - height * 0.6, center.z + height * 0.7), 520.0, height * 0.9, (0.52, 0.68, 1.0))
    add_area_light("HG QA rim", (center.x, center.y + height * 1.3, center.z - height * 1.0), 700.0, height * 0.7, (0.72, 0.55, 1.0))
    for light in bpy.context.scene.objects:
        if light.type == 'LIGHT':
            point_at(light, center)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH" if fast_workbench else "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new('HG QA world')
    scene.world.color = (0.012, 0.018, 0.024)
    if fast_workbench:
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "TEXTURE"
        scene.display.shading.show_shadows = True
        scene.display.shading.show_cavity = True
        scene.display.shading.cavity_type = "WORLD"
    else:
        scene.view_settings.look = "AgX - Medium High Contrast"
        scene.view_settings.exposure = 0.8
    scene.render.filepath = str(output)
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    bpy.ops.render.render(write_still=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, default=Path("public/assets/characters"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/characters/turntables"))
    parser.add_argument("--id", type=str, default=None, help="Render only one asset id, e.g. aurel-seraph")
    parser.add_argument("--dump-materials", action="store_true")
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--opaque-materials", action="store_true", help="Use masked/dithered surfaces for a blend regression probe")
    parser.add_argument("--resolution", type=int, nargs=2, metavar=("WIDTH", "HEIGHT"), default=(640, 800))
    parser.add_argument("--fast-workbench", action="store_true", help="Use a deterministic textured Workbench render for quick contact sheets")
    parser.add_argument("--dump-bounds", action="store_true")
    parser.add_argument("--dump-components", action="store_true")
    blender_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(blender_args)
    args.output.mkdir(parents=True, exist_ok=True)
    assets = sorted(args.assets.glob("aurel-*-hero.glb"))
    if args.id:
        assets = [asset for asset in assets if asset.stem == f"{args.id}-hero"]
    if not assets:
        raise SystemExit(f"No hero binaries found under {args.assets}")
    for asset in assets:
        output = args.output / f"{asset.stem}.png"
        render_asset(asset.resolve(), output.resolve(), args.dump_materials, args.inspect_only, args.opaque_materials, tuple(args.resolution), args.fast_workbench, args.dump_bounds, args.dump_components)
        print(f"HG_TURNTABLE={output}")


if __name__ == "__main__":
    main()
