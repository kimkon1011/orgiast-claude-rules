# library.blend の各アセット（コレクション assets/<asset_id>）を 600x450 の PNG に描画する（Workbench・白背景）。
# 実行: blender -b <library.blend> -P render-thumbs.py -- <thumbs_dir(絶対パス)>
# 注意: render.filepath に相対パスを渡すと Blender はドライブ直下へ解決するため、必ず絶対パスで受け取る。
import bpy, sys, os, math
from mathutils import Vector

out_dir = sys.argv[sys.argv.index("--") + 1]
if not os.path.isabs(out_dir):
    raise SystemExit("thumbs_dir は絶対パスで指定してください: " + out_dir)
os.makedirs(out_dir, exist_ok=True)

sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.render.resolution_x, sc.render.resolution_y = 600, 450
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
sc.view_settings.view_transform = 'Standard'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'SINGLE'
sc.display.shading.single_color = (0.55, 0.62, 0.75)
sc.display.shading.show_cavity = True
sc.display.shading.show_shadows = True
world = bpy.data.worlds.new("thumb_white")
world.color = (1, 1, 1)  # Workbench の背景は world.color（ノードではない）
sc.world = world

cam_data = bpy.data.cameras.new("thumb_cam")
cam = bpy.data.objects.new("thumb_cam", cam_data)
sc.collection.objects.link(cam)
sc.camera = cam
cam_data.lens = 35

assets = bpy.data.collections.get("assets")
if assets is None:
    raise SystemExit("コレクション assets がありません")
objs = []
for coll in assets.children:
    for ob in coll.objects:
        if ob.type == 'MESH':
            objs.append(ob)

count = 0
for target in objs:
    for ob in objs:
        ob.hide_render = ob is not target
    pts = [target.matrix_world @ Vector(c) for c in target.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (mn + mx) / 2
    size = max((mx - mn).length, 1.0)
    cam.location = center + Vector((1.0, -1.3, 0.75)).normalized() * size * 1.35
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.clip_end = size * 10 + 1000
    sc.render.filepath = os.path.join(out_dir, target.name + ".png")
    bpy.ops.render.render(write_still=True)
    count += 1
print("THUMBS_DONE", count)
