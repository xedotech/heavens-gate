"""OBJ -> GLB converter for photogrammetry output. Runs headless in Blender:
blender -b --python obj_to_glb.py -- <in.obj> <out.glb>
Decimates to a game-ready budget, keeps the baked texture, exports GLB."""
import sys
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=src)

for obj in list(bpy.data.objects):
    if obj.type != 'MESH':
        bpy.data.objects.remove(obj, do_unlink=True)
        continue
    bpy.context.view_layer.objects.active = obj
    # Photogrammetry meshes are dense; decimate to ~30k tris for the browser.
    tri_count = len(obj.data.polygons)
    if tri_count > 30_000:
        mod = obj.modifiers.new('decimate', 'DECIMATE')
        mod.ratio = 30_000 / tri_count
        bpy.ops.object.modifier_apply(modifier='decimate')
    # Recenter on origin, Z-up normalized footprint.
    obj.select_set(True)
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')

bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_yup=True, export_apply=True)
print(f'[obj_to_glb] wrote {dst}')
