"""Render a quick preview of a GLB/OBJ — headless Blender turntable shot."""
import sys, math
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
if src.lower().endswith('.glb') or src.lower().endswith('.gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
else:
    bpy.ops.wm.obj_import(filepath=src)

# frame all meshes
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.view3d.camera_to_view_selected() if False else None

import mathutils
lo = mathutils.Vector((1e9,) * 3); hi = mathutils.Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        lo = mathutils.Vector(map(min, lo, w)); hi = mathutils.Vector(map(max, hi, w))
center = (lo + hi) / 2; size = max((hi - lo).length, 0.01)

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam
d = size * 0.9
cam.location = center + mathutils.Vector((d * 0.7, -d * 0.7, d * 0.45))
direc = center - cam.location
cam.rotation_euler = direc.to_track_quat('-Z', 'Y').to_euler()

sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
bpy.context.collection.objects.link(sun)
w = bpy.data.worlds.new('w'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.05, 0.06, 0.09, 1)
w.node_tree.nodes['Background'].inputs[1].default_value = 0.6
bpy.context.scene.world = w

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = sc.render.resolution_y = 640
sc.render.filepath = dst
bpy.ops.render.render(write_still=True)
print(f'[preview] wrote {dst}')
