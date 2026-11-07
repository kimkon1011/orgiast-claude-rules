import bpy, json, os, sys
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
argv=sys.argv[sys.argv.index('--')+1:]; out_png,out_json=map(os.path.abspath,argv[:2]); bpy.ops.wm.read_factory_settings(use_empty=True)
def mat(n,c): m=bpy.data.materials.new(n); m.diffuse_color=(*c,1); return m
grey,dark,blue,skin=mat('structure',(.35,.4,.45)),mat('wall',(.08,.12,.2)),mat('floor',(.65,.68,.7)),mat('people',(.95,.42,.16))
def cube(n,p,s,m): bpy.ops.mesh.primitive_cube_add(location=p); o=bpy.context.object; o.name=n; o.scale=tuple(v/2 for v in s); o.data.materials.append(m)
def person(n,x,y):
 bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=.16,depth=1.25,location=(x,y,.825)); bpy.context.object.data.materials.append(skin)
 bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,radius=.125,location=(x,y,1.575)); bpy.context.object.data.materials.append(skin)
cube('booth_floor',(3,3,.025),(6,6,.05),blue); cube('rear_wall',(3,5.94,1.45),(6,.12,2.9),dark)
for x in (0,6):
 for y in (0,6): cube(f'column_{x}_{y}',(x,y,1.8),(.18,.18,3.6),grey)
for y in (0,6): cube(f'top_x_{y}',(3,y,3.51),(6,.18,.18),grey)
for x in (0,6): cube(f'top_y_{x}',(x,3,3.51),(.18,6,.18),grey)
cube('hall_floor',(3,3,-.04),(28,28,.08),mat('hallfloor',(.18,.2,.22))); cube('left_neighbour',(-3.1,3,1.35),(4.5,6,2.7),mat('n1',(.25,.3,.34))); cube('right_neighbour',(9.1,3,1.35),(4.5,6,2.7),mat('n2',(.3,.32,.35)))
for i,(x,y) in enumerate([(-.65,-.5),(6.7,-.35),(1.6,1.4),(3.2,3.5),(4.7,1.8)]): person(str(i),x,y)
world=bpy.data.worlds.new('World'); bpy.context.scene.world=world; world.color=(.055,.065,.08); bpy.ops.object.light_add(type='AREA',location=(3,-1,8)); bpy.context.object.data.energy=1800; bpy.context.object.data.shape='RECTANGLE'; bpy.context.object.data.size=12
bpy.ops.object.camera_add(location=(-8.2,-10.5,1.6)); cam=bpy.context.object; bpy.context.scene.camera=cam; cam.data.lens=32; cam.data.sensor_width=36; cam.rotation_euler=(Vector((3,3,2.65))-cam.location).to_track_quat('-Z','Y').to_euler()
sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE'; sc.render.resolution_x=1344; sc.render.resolution_y=768; sc.render.resolution_percentage=100; sc.render.image_settings.file_format='PNG'; sc.render.filepath=out_png; sc.view_settings.look='AgX - Medium High Contrast'; bpy.ops.render.render(write_still=True)
def px(p): q=world_to_camera_view(sc,cam,Vector(p)); return [q.x*1344,(1-q.y)*768]
foot,top,ptop=px((0,0,0)),px((0,0,3.6)),px((0,0,1.7)); bh=abs(foot[1]-top[1]); ph=abs(foot[1]-ptop[1])
meta={'width':1344,'height':768,'camera_mm':32,'camera_location':list(cam.location),'booth_top_m':3.6,'person_height_m':1.7,'projection_point_m':[0,0],'foot_px':foot,'booth_top_px':top,'person_top_px':ptop,'booth_height_px':bh,'person_height_px':ph,'projected_ratio':bh/ph,'front_top_edge_px':[px((0,0,3.6)),px((6,0,3.6))]}
json.dump(meta,open(out_json,'w',encoding='utf-8'),ensure_ascii=False,indent=2); print(json.dumps(meta,ensure_ascii=False))
