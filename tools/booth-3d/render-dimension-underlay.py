import argparse, bpy, json, os, sys
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

SIDES = ('front', 'right', 'left', 'back')
parser = argparse.ArgumentParser()
parser.add_argument('out_png'); parser.add_argument('out_json')
parser.add_argument('--width', type=float, default=6.0); parser.add_argument('--depth', type=float, default=6.0); parser.add_argument('--height', type=float, default=3.6)
parser.add_argument('--open', dest='open_sides', default='front,left,right')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
if args.width <= 0 or args.depth <= 0 or args.height <= 0: parser.error('--width, --depth, --height must be positive')
open_sides = [side.strip() for side in args.open_sides.split(',') if side.strip()]
if len(open_sides) != len(set(open_sides)) or any(side not in SIDES for side in open_sides): parser.error('--open must be a comma-separated subset of front,right,left,back')
out_png, out_json = map(os.path.abspath, (args.out_png, args.out_json)); w, d, h = args.width, args.depth, args.height
bpy.ops.wm.read_factory_settings(use_empty=True)
def mat(n,c): m=bpy.data.materials.new(n); m.diffuse_color=(*c,1); return m
grey,dark,blue,skin=mat('structure',(.35,.4,.45)),mat('wall',(.08,.12,.2)),mat('floor',(.65,.68,.7)),mat('people',(.95,.42,.16))
def cube(n,p,s,m): bpy.ops.mesh.primitive_cube_add(location=p); o=bpy.context.object; o.name=n; o.scale=tuple(v/2 for v in s); o.data.materials.append(m)
def person(n,x,y):
 bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=.16,depth=1.25,location=(x,y,.825)); bpy.context.object.data.materials.append(skin)
 bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,radius=.125,location=(x,y,1.575)); bpy.context.object.data.materials.append(skin)
cube('booth_floor',(w/2,d/2,.025),(w,d,.05),blue)
wall_h,wall_t=2.9,.12
if 'back' not in open_sides: cube('rear_wall',(w/2,d-wall_t/2,wall_h/2),(w,wall_t,wall_h),dark)
if 'left' not in open_sides: cube('left_wall',(wall_t/2,d/2,wall_h/2),(wall_t,d,wall_h),dark)
if 'right' not in open_sides: cube('right_wall',(w-wall_t/2,d/2,wall_h/2),(wall_t,d,wall_h),dark)
for x in (0,w):
 for y in (0,d): cube(f'column_{x}_{y}',(x,y,h/2),(.18,.18,h),grey)
for y in (0,d): cube(f'top_x_{y}',(w/2,y,h-.09),(w,.18,.18),grey)
for x in (0,w): cube(f'top_y_{x}',(x,d/2,h-.09),(.18,d,.18),grey)
hall_size=max(28,w+22,d+22); cube('hall_floor',(w/2,d/2,-.04),(hall_size,hall_size,.08),mat('hallfloor',(.18,.2,.22)))
cube('left_neighbour',(-3.1,d/2,1.35),(4.5,d,2.7),mat('n1',(.25,.3,.34))); cube('right_neighbour',(w+3.1,d/2,1.35),(4.5,d,2.7),mat('n2',(.3,.32,.35)))
for i,(x,y) in enumerate([(-.65,-.5),(w+.7,-.35),(w*1.6/6,d*1.4/6),(w*3.2/6,d*3.5/6),(w*4.7/6,d*1.8/6)]): person(str(i),x,y)
world=bpy.data.worlds.new('World'); bpy.context.scene.world=world; world.color=(.055,.065,.08); bpy.ops.object.light_add(type='AREA',location=(w/2,-d/6,max(8,h+4.4))); bpy.context.object.data.energy=1800; bpy.context.object.data.shape='RECTANGLE'; bpy.context.object.data.size=12
side_x=-8.2*w/6 if 'left' in open_sides else (w+8.2*w/6 if 'right' in open_sides else w/2); camera_location=(side_x,-10.5*d/6,1.6)
bpy.ops.object.camera_add(location=camera_location); cam=bpy.context.object; bpy.context.scene.camera=cam; cam.data.lens=32; cam.data.sensor_width=36; cam.rotation_euler=(Vector((w/2,d/2,min(2.65,h-.2)))-cam.location).to_track_quat('-Z','Y').to_euler()
sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE'; sc.render.resolution_x=1344; sc.render.resolution_y=768; sc.render.resolution_percentage=100; sc.render.image_settings.file_format='PNG'; sc.render.filepath=out_png; sc.view_settings.look='AgX - Medium High Contrast'; bpy.ops.render.render(write_still=True)
def px(p): q=world_to_camera_view(sc,cam,Vector(p)); return [q.x*1344,(1-q.y)*768]
foot,top,ptop=px((0,0,0)),px((0,0,h)),px((0,0,1.7)); bh=abs(foot[1]-top[1]); ph=abs(foot[1]-ptop[1])
meta={'width':1344,'height':768,'camera_mm':32,'camera_location':list(cam.location),'booth_top_m':h,'person_height_m':1.7,'projection_point_m':[0,0],'foot_px':foot,'booth_top_px':top,'person_top_px':ptop,'booth_height_px':bh,'person_height_px':ph,'projected_ratio':bh/ph,'front_top_edge_px':[px((0,0,h)),px((w,0,h))],'width_m':w,'depth_m':d,'open_sides':open_sides}
with open(out_json,'w',encoding='utf-8') as f: json.dump(meta,f,ensure_ascii=False,indent=2)
print(json.dumps(meta,ensure_ascii=False))
