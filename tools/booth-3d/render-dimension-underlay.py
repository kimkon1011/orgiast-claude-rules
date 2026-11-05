import bpy, json, math, os, sys
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

argv = sys.argv[sys.argv.index('--') + 1:]
out_png, out_json = os.path.abspath(argv[0]), os.path.abspath(argv[1])
bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, color):
    m = bpy.data.materials.new(name); m.diffuse_color = (*color, 1); return m
grey, dark, blue, skin = mat('structure', (.35,.4,.45)), mat('wall', (.08,.12,.2)), mat('floor', (.65,.68,.7)), mat('people', (.95,.42,.16))

def cube(name, loc, scale, material):
    bpy.ops.mesh.primitive_cube_add(location=loc); o=bpy.context.object; o.name=name; o.scale=(scale[0]/2,scale[1]/2,scale[2]/2); o.data.materials.append(material); return o

def person(name, x, y):
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=.16, depth=1.25, location=(x,y,.825)); body=bpy.context.object; body.name=name+'_body'; body.data.materials.append(skin)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=.125, location=(x,y,1.575)); head=bpy.context.object; head.name=name+'_head'; head.scale.z=1.0; head.data.materials.append(skin)

# 6 x 6 m floor and one 2.9 m rear wall.
cube('booth_floor',(3,3,.025),(6,6,.05),blue)
cube('rear_wall',(3,5.94,1.45),(6,.12,2.9),dark)
# Four columns and a square top frame whose absolute top is exactly 3.6 m.
for x in (0,6):
  for y in (0,6): cube(f'column_{x}_{y}',(x,y,1.8),(.18,.18,3.6),grey)
for y in (0,6): cube(f'top_x_{y}',(3,y,3.51),(6,.18,.18),grey)
for x in (0,6): cube(f'top_y_{x}',(x,3,3.51),(.18,6,.18),grey)
# Adjacent 2.7 m booths and hall floor; ceiling is intentionally outside the frame at 10.5 m.
cube('hall_floor',(3,3,-.04),(28,28,.08),mat('hallfloor',(.18,.2,.22)))
cube('left_neighbour',(-3.1,3,1.35),(4.5,6,2.7),mat('neighbour1',(.25,.3,.34)))
cube('right_neighbour',(9.1,3,1.35),(4.5,6,2.7),mat('neighbour2',(.3,.32,.35)))
for i,(x,y) in enumerate([(-.65,-.5),(6.7,-.35),(1.6,1.4),(3.2,3.5),(4.7,1.8)]): person(f'person_{i+1}',x,y)

world=bpy.context.scene.world or bpy.data.worlds.new('World'); bpy.context.scene.world=world; world.color=(.055,.065,.08)
bpy.ops.object.light_add(type='AREA', location=(3,-1,8)); bpy.context.object.data.energy=1800; bpy.context.object.data.shape='RECTANGLE'; bpy.context.object.data.size=12
bpy.ops.object.camera_add(location=(-8.2,-10.5,1.6)); cam=bpy.context.object; bpy.context.scene.camera=cam; cam.data.lens=32; cam.data.sensor_width=36
target=Vector((3,3,2.65)); cam.rotation_euler=(target-Vector(cam.location)).to_track_quat('-Z','Y').to_euler()
scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE_NEXT'; scene.render.resolution_x=1344; scene.render.resolution_y=768; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'; scene.render.filepath=out_png; scene.render.film_transparent=False
scene.view_settings.look='AgX - Medium High Contrast'; scene.render.image_settings.color_mode='RGBA'
bpy.ops.wm.save_as_mainfile(filepath=os.path.splitext(out_png)[0]+'.blend')
bpy.ops.render.render(write_still=True)

def px(point):
    p=world_to_camera_view(scene,cam,Vector(point)); return [p.x*scene.render.resolution_x,(1-p.y)*scene.render.resolution_y]
foot, booth_top, person_top = px((0,0,0)), px((0,0,3.6)), px((0,0,1.7))
booth_px=abs(foot[1]-booth_top[1]); person_px=abs(foot[1]-person_top[1])
meta={'width':1344,'height':768,'camera_mm':32,'camera_location':list(cam.location),'booth_top_m':3.6,'person_height_m':1.7,'projection_point_m':[0,0], 'foot_px':foot,'booth_top_px':booth_top,'person_top_px':person_top,'booth_height_px':booth_px,'person_height_px':person_px,'projected_ratio':booth_px/person_px,
      'front_top_edge_px':[px((0,0,3.6)),px((6,0,3.6))],'rear_top_edge_px':[px((0,6,3.6)),px((6,6,3.6))]}
with open(out_json,'w',encoding='utf-8') as f: json.dump(meta,f,ensure_ascii=False,indent=2)
print(json.dumps(meta,ensure_ascii=False))
