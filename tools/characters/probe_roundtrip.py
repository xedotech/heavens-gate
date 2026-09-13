"""Temporary probe: check glTF->Blender->glTF contract fidelity."""
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=src)
for obj in set(bpy.data.objects) - before:
    pass
imported = set(bpy.data.objects) - before
for stray in set(bpy.data.objects) - imported:
    bpy.data.objects.remove(stray)
rig = next(obj for obj in bpy.data.objects if obj.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
print('HG_MESHES', [(m.name, m.data.name) for m in meshes])
print('HG_RIG_PROPS', {k: rig.get(k) for k in rig.keys()})
body = max(meshes, key=lambda m: len(m.data.shape_keys.key_blocks) if m.data.shape_keys else 0)
print('HG_BODY', body.name, 'data=', body.data.name, 'shapekeys=', len(body.data.shape_keys.key_blocks) if body.data.shape_keys else 0)
if body.data.shape_keys:
    print('HG_KEYS', [k.name for k in body.data.shape_keys.key_blocks][:8], '...')
for mat in bpy.data.materials:
    print('HG_MAT', mat.name, 'props=', {k: mat.get(k) for k in mat.keys()},
          'surface_method=', getattr(mat, 'surface_render_method', None),
          'blend=', getattr(mat, 'blend_method', None))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=dst, export_format='GLB',
    export_image_format='WEBP', export_image_quality=88,
    use_selection=True, export_apply=False,
    export_animations=False, export_skins=True, export_tangents=True,
    export_morph=True, export_morph_normal=False, export_morph_tangent=False,
    export_yup=True, export_extras=True,
    export_meshopt_compression_enable=True,
    export_meshopt_extension='EXT_meshopt_compression',
)
print('HG_EXPORTED', dst)
