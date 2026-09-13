"""Re-author the HG_* animation clips inside shipped hero GLBs.

``build_characters.py`` compiles characters from the MPFB/MakeHuman source
assets.  When only the procedural animation library changed, that toolchain is
not required: this tool imports each published GLB, drops its baked actions,
re-runs the shared ``animation_library`` on the unchanged rig, and re-exports
with the pipeline's glTF settings (meshopt + WebP).  Everything else in the
file — meshes, morph targets, materials, textures, skin — rides through the
importer untouched.

Run (PowerShell):

    & $BlenderExe --background --python-exit-code 1 `
      --python tools/characters/rebuild_animations.py -- `
      --manifest tools/characters/characters.json `
      --input public/assets/characters `
      --output artifacts/characters

Then publish and validate:

    node tools/characters/publish_manifest.mjs
    node tools/characters/validate_characters.mjs
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from animation_library import add_animation_library


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, help="characters.json definition file")
    parser.add_argument("--input", required=True, help="Directory holding the shipped <id>-hero.glb files")
    parser.add_argument("--output", required=True, help="Artifact directory for rebuilt GLBs and reports")
    parser.add_argument("--character", default="all")
    return parser.parse_args(argv)


def glb_node_names(path: Path) -> set[str]:
    """Read the GLB JSON chunk and return every node name in the file."""
    data = path.read_bytes()
    if int.from_bytes(data[0:4], "little") != 0x46546C67:
        raise RuntimeError(f"{path}: not a binary glTF")
    json_length = int.from_bytes(data[12:16], "little")
    document = json.loads(data[20 : 20 + json_length])
    return {node["name"] for node in document.get("nodes", []) if node.get("name")}


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.actions, bpy.data.meshes, bpy.data.armatures,
        bpy.data.materials, bpy.data.images,
    ):
        for block in tuple(collection):
            if block.users == 0:
                collection.remove(block)


def spec_sha256(spec: dict) -> str:
    return hashlib.sha256(
        json.dumps(spec, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def rebuild(spec: dict, source: Path, output: Path) -> dict:
    started = time.perf_counter()
    reset_scene()
    # The importer can surface scene-bookkeeping objects that are not glTF
    # nodes (a default icosphere has been observed on some hosts). Only keep
    # objects that correspond to real nodes in the source file.
    allowed_names = glb_node_names(source)
    bpy.ops.import_scene.gltf(filepath=str(source))
    for obj in tuple(bpy.data.objects):
        if obj.name not in allowed_names:
            bpy.data.objects.remove(obj)
    rigs = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(rigs) != 1:
        raise RuntimeError(f"{source}: expected exactly one armature, found {len(rigs)}")
    rig = rigs[0]

    # Drop every imported clip; the shared library re-authors all eleven.
    if rig.animation_data is not None:
        rig.animation_data.action = None
        for track in tuple(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(track)
    for action in tuple(bpy.data.actions):
        bpy.data.actions.remove(action)

    add_animation_library(rig)

    bpy.context.scene.render.fps = 30
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 90
    bpy.ops.object.select_all(action="SELECT")
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_image_format="WEBP",
        export_image_quality=88,
        use_selection=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_merge_animation="ACTION",
        export_force_sampling=False,
        export_skins=True,
        export_tangents=True,
        export_morph=True,
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
    body = max(
        meshes,
        key=lambda mesh: len(mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else 0,
    )
    report = {
        "schemaVersion": 2,
        "compilerVersion": "hg-character-compiler-2",
        "blenderVersion": bpy.app.version_string,
        "specSha256": spec_sha256(spec),
        "id": spec["id"],
        "label": spec["label"],
        "lod": "hero",
        "output": output.name,
        "bytes": output.stat().st_size,
        "meshCount": len(meshes),
        "vertexCount": sum(len(obj.data.vertices) for obj in meshes),
        "materialCount": len(used_materials),
        "boneCount": len(rig.data.bones),
        "actionCount": len(bpy.data.actions),
        "bodyMorphCount": len(body.data.shape_keys.key_blocks) - 1 if body.data.shape_keys else 0,
        "regeneration": {
            "method": "glTF round-trip re-author (animation_library.py); MPFB source assets untouched",
            "source": source.name,
        },
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
    input_dir = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()
    reports = []
    for spec in selected:
        source = input_dir / f"{spec['id']}-hero.glb"
        reports.append(rebuild(spec, source, output_dir / source.name))
    (output_dir / "build-report.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
