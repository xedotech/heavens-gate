import bpy
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]

img = bpy.data.images.load(src)
img.scale(1024, 512)

scene = bpy.context.scene
scene.render.image_settings.file_format = 'HDR'
scene.render.image_settings.color_depth = '32'
img.save_render(dst, scene=scene)
