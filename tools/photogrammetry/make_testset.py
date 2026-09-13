"""Synthetic photogrammetry test set. Renders a textured gothic obelisk on a
noise-textured plinth/ground from two orbit rings — enough parallax and surface
features for COLMAP SfM. Runs headless:
blender -b --python make_testset.py -- <out_dir>"""
import math
import os
import sys

import bpy
from mathutils import Vector

out_dir = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 960
scene.render.resolution_y = 720
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality = 92


def speckle_material(name, base, scale):
    """High-contrast high-frequency surface — SIFT needs features to track."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    tex = mat.node_tree.nodes.new('ShaderNodeTexNoise')
    tex.noise_dimensions = '3D'
    tex.inputs['Scale'].default_value = scale
    tex.inputs['Detail'].default_value = 4.0
    tex.inputs['Roughness'].default_value = 0.9
    vor = mat.node_tree.nodes.new('ShaderNodeTexVoronoi')
    vor.distance = 'EUCLIDEAN'
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = scale * 0.4
    mix = mat.node_tree.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs[0].default_value = 0.6
    ramp = mat.node_tree.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (base[0] * 0.08, base[1] * 0.08, base[2] * 0.08, 1)
    ramp.color_ramp.elements[1].color = (min(base[0] * 2.2, 1), min(base[1] * 2.2, 1), min(base[2] * 2.2, 1), 1)
    mat.node_tree.links.new(tex.outputs['Fac'], mix.inputs[1])
    mat.node_tree.links.new(vor.outputs['Distance'], mix.inputs[2])
    mat.node_tree.links.new(mix.outputs['Color'], ramp.inputs['Fac'])
    mat.node_tree.links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    bump = mat.node_tree.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.6
    mat.node_tree.links.new(mix.outputs['Color'], bump.inputs['Height'])
    mat.node_tree.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.85
    return mat


stone = speckle_material('weathered_stone', (0.42, 0.40, 0.38), 22.0)
dark_stone = speckle_material('dark_plinth', (0.26, 0.25, 0.24), 30.0)
ground_mat = speckle_material('gravel_ground', (0.30, 0.29, 0.27), 55.0)

# Ground — big, textured, gives SfM static reference points.
bpy.ops.mesh.primitive_plane_add(size=60)
ground = bpy.context.object
ground.data.materials.append(ground_mat)

# Plinth.
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.55))
plinth = bpy.context.object
plinth.scale = (1.6, 1.6, 1.1)
bpy.ops.object.transform_apply(scale=True)
plinth.data.materials.append(dark_stone)

# Obelisk — tapered octagonal shaft + pyramidion, unmistakably dimensional.
bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.55, radius2=0.34, depth=3.4, location=(0, 0, 2.8))
shaft = bpy.context.object
shaft.data.materials.append(stone)
bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.34, radius2=0.02, depth=0.7, location=(0, 0, 4.85))
cap = bpy.context.object
cap.data.materials.append(stone)

# Collar bands — silhouette detail the reconstruction should recover.
for z in (1.35, 4.28):
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.62 if z < 2 else 0.42, depth=0.18, location=(0, 0, z))
    bpy.context.object.data.materials.append(dark_stone)

# Scattered debris — real geometry gives SIFT the strongest trackable features.
import random
random.seed(7)
for i in range(90):
    r = random.uniform(1.8, 9.0)
    a = random.uniform(0, math.tau)
    bpy.ops.mesh.primitive_ico_sphere_add(radius=random.uniform(0.04, 0.16), location=(r * math.cos(a), r * math.sin(a), 0.03))
    pebble = bpy.context.object
    pebble.scale.z = random.uniform(0.4, 0.8)
    pebble.data.materials.append(dark_stone if i % 3 else stone)

# Lighting: broad diffuse key + fill, overcast feel (no hard shadows baked in).
bpy.ops.object.light_add(type='AREA', location=(6, -4, 9))
key = bpy.context.object
key.data.energy = 1400
key.data.shape = 'DISK'
key.data.size = 6
bpy.ops.object.light_add(type='AREA', location=(-5, 5, 7))
fill = bpy.context.object
fill.data.energy = 900
fill.data.size = 7
bpy.ops.object.light_add(type='POINT', location=(0, 0, 12))
bpy.context.object.data.energy = 350

world = bpy.data.worlds.new('overcast')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.45, 0.5, 0.55, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
scene.world = world

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 42
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Two rings: 24 shots at eye height + 12 elevated — classic object-scan orbit.
shots = [(3.4, math.radians(12), i * 15) for i in range(24)]
shots += [(4.6, math.radians(38), i * 30 + 15) for i in range(12)]
for i, (radius, elev, azim) in enumerate(shots):
    az = math.radians(azim)
    cam.location = (radius * math.cos(az), radius * math.sin(az), radius * math.tan(elev) + 2.4)
    direction = Vector((0, 0, 2.2)) - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(out_dir, f'shot_{i:03d}.jpg')
    bpy.ops.render.render(write_still=True)

print(f'[make_testset] {len(shots)} shots -> {out_dir}')
