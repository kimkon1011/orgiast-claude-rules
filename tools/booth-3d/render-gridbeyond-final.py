"""Deterministic GridBeyond fallback. Blender --background --python FILE -- OUT PLAN.

All booth geometry fits 6 x 6 x 3.6m. Camera matches render-dimension-underlay.py.
No image model is used. Keep scene, texture, geometry audit and render together.
"""
import bpy
import json
import math
import os
import sys
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

args = sys.argv[sys.argv.index('--')+1:]
out = os.path.abspath(args[0])
plan = args[1]
assert plan in ('standard', 'premium', 'impact')
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
booth_objects = []


def linear(v):
    return v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4


def material(name, hexcolor, metal=0, rough=.4, emission=0):
    color = tuple(linear(int(hexcolor[i:i+2],16)/255) for i in (0,2,4))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color,1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Emission Color'].default_value = (*color,1)
    bsdf.inputs['Emission Strength'].default_value = emission
    return mat


navy = material('GridBeyond navy #1c1463','1c1463')
blue = material('GridBeyond blue #0566d8','0566d8',emission=2)
purple = material('GridBeyond purple #9052f3','9052f3',emission=2)
white = material('Porcelain white','f4f6fa')
fabric = material('Internally illuminated white membrane','f4f7ff',rough=.8,emission=2)
silver = material('Brushed aluminium','b9c4d0',metal=.85,rough=.27)
dark = material('Screen frames','080d22',metal=.3)
carpet = material('Navy carpet','33334f',rough=.94)
ink = material('Suit charcoal','242d42',rough=.8)
skin = material('Simplified human skin','baa39b',rough=.8)
letter = material('Illuminated wordmark','f4f8ff',emission=.6)


def finish(obj,name,mat,track=True,bevel=0):
    obj.name=name
    obj.data.materials.append(mat)
    if track: booth_objects.append(obj)
    if bevel:
        mod=obj.modifiers.new('Soft manufactured edges','BEVEL')
        mod.width=bevel; mod.segments=3
        obj.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL')
    return obj


def box(name,p,size,mat,track=True,bevel=.01):
    bpy.ops.mesh.primitive_cube_add(size=1,location=p)
    obj=bpy.context.object; obj.dimensions=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return finish(obj,name,mat,track,bevel)


def rod(name,a,b,r,mat,track=True):
    delta=Vector(b)-Vector(a)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=r,depth=delta.length,location=(Vector(a)+Vector(b))/2)
    obj=bpy.context.object
    obj.rotation_euler=delta.to_track_quat('Z','Y').to_euler()
    return finish(obj,name,mat,track)


def sphere(name,p,scale,mat,track=True):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=1,location=p)
    obj=bpy.context.object; obj.scale=scale
    for poly in obj.data.polygons: poly.use_smooth=True
    return finish(obj,name,mat,track)


def curve(name,points,r,mat,track=True):
    data=bpy.data.curves.new(name,'CURVE'); data.dimensions='3D'
    data.bevel_depth=r; data.bevel_resolution=3
    spline=data.splines.new('POLY'); spline.points.add(len(points)-1)
    for p,co in zip(spline.points,points): p.co=(*co,1)
    obj=bpy.data.objects.new(name,data); bpy.context.collection.objects.link(obj)
    return finish(obj,name,mat,track)


def wordmark(p,size=.32,mat=letter):
    data=bpy.data.curves.new('GridBeyond wordmark','FONT')
    data.body='GridBeyond'; data.size=size; data.align_x='CENTER'; data.extrude=.001
    font='C:/Windows/Fonts/segoeuib.ttf'
    if os.path.exists(font): data.font=bpy.data.fonts.load(font,check_existing=True)
    obj=bpy.data.objects.new('GridBeyond',data); bpy.context.collection.objects.link(obj)
    obj.location=p; obj.rotation_euler=(math.pi/2,0,0)
    return finish(obj,'GridBeyond',mat)


def light(name,p,energy,size,color=(.8,.9,1),target=None):
    bpy.ops.object.light_add(type='AREA',location=p)
    obj=bpy.context.object; obj.name=name; obj.data.energy=energy
    obj.data.shape='DISK'; obj.data.size=size; obj.data.color=color
    if target: obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def truss(a,b):
    # Top chords at 3.575m plus radius .025m = exact 3.6m top.
    axis=(Vector(b)-Vector(a)).normalized()
    side=Vector((-axis.y,axis.x,0))*.11
    for z in (3.325,3.575):
        for sign in (-1,1):
            aa=Vector((*a[:2],z))+side*sign; bb=Vector((*b[:2],z))+side*sign
            rod('Truss chord',aa,bb,.025,silver)
    length=(Vector(b)-Vector(a)).length
    count=math.ceil(length/.5)
    for i in range(count):
        for sign in (-1,1):
            aa=Vector(a).lerp(Vector(b),i/count)+side*sign
            bb=Vector(a).lerp(Vector(b),(i+1)/count)+side*sign
            aa.z=3.325 if i%2==0 else 3.575
            bb.z=3.575 if i%2==0 else 3.325
            rod('Truss diagonal',aa,bb,.012,silver)


box('6m x 6m floor',(3,3,.025),(6,6,.05),carpet,bevel=0)
box('Single navy back wall',(3,5.94,1.45),(6,.12,2.9),navy,bevel=0)
for x in (.14,5.86):
    for y in (.14,5.86):
        for dx,dy in ((-.08,-.08),(.08,-.08),(-.08,.08),(.08,.08)):
            rod('Aluminium upright',(x+dx,y+dy,.05),(x+dx,y+dy,3.575),.022,silver)
        for z in [.1+i*.38 for i in range(9)]:
            rod('Column diagonal',(x-.08,y-.08,z),(x+.08,y-.08,z+.35),.009,silver)
            rod('Column diagonal',(x-.08,y-.08,z),(x-.08,y+.08,z+.35),.009,silver)
for a,b in [((.14,.14,0),(5.86,.14,0)),((.14,5.86,0),(5.86,5.86,0)),((.14,.14,0),(.14,5.86,0)),((5.86,.14,0),(5.86,5.86,0))]:
    truss(a,b)
for y in (.16,5.84):
    box('Glowing white membrane canopy',(3,y,3.34),(5.72,.07,.36),fabric,bevel=.006)
for x in (.16,5.84):
    box('Glowing white membrane canopy',(x,3,3.34),(.07,5.65,.36),fabric,bevel=.006)
wordmark((3,.115,3.25),.3,navy)
if plan=='premium':
    box('Full luminous membrane ceiling',(3,3,3.15),(5.6,5.6,.035),fabric,bevel=0)
wordmark((2.5,5.865,2.49),.4)

# 1.8m staff room in one rear corner; remaining three sides stay open.
box('Cloak room side',(4.2,5,1.3),(.07,1.8,2.5),navy)
box('Cloak room front',(5.05,4.12,1.3),(1.76,.07,2.5),navy)
box('Door',(5.05,4.073,1.18),(.75,.025,2.22),material('Door blue','28275e'))
rod('Door handle',(5.32,4.04,1.02),(5.32,4.04,1.17),.014,silver)

# Emission texture, generated deterministically from a simplified Japan outline.
texture_path=os.path.join(out,'japan-noc.png')
image=bpy.data.images.load(texture_path,check_existing=True)
image.pack()
screen=bpy.data.materials.new('Japan network operations emission texture'); screen.use_nodes=True
nodes=screen.node_tree.nodes; nodes.clear()
tex=nodes.new('ShaderNodeTexImage'); tex.image=image
em=nodes.new('ShaderNodeEmission'); em.inputs['Strength'].default_value=1.3
output=nodes.new('ShaderNodeOutputMaterial')
screen.node_tree.links.new(tex.outputs['Color'],em.inputs['Color'])
screen.node_tree.links.new(em.outputs[0],output.inputs['Surface'])


def screen_panel(cx,y,z,w,h,u0=0,u1=1):
    box('NOC screen frame',(cx,y+.025,z),(w+.045,.07,h+.045),dark)
    vertices=[(cx-w/2,y-.02,z-h/2),(cx+w/2,y-.02,z-h/2),(cx+w/2,y-.02,z+h/2),(cx-w/2,y-.02,z+h/2)]
    mesh=bpy.data.meshes.new('Screen'); mesh.from_pydata(vertices,[],[(0,1,2,3)]); mesh.update()
    obj=bpy.data.objects.new('Japan NOC screen',mesh); bpy.context.collection.objects.link(obj)
    finish(obj,obj.name,screen)
    uv=mesh.uv_layers.new()
    for loop,co in zip(uv.data,[(u0,0),(u1,0),(u1,1),(u0,1)]): loop.uv=co


if plan=='standard':
    for ix in range(2):
        for iz in range(2): screen_panel(1.02+ix*1.48,5.82,1.25+iz*.72,1.43,.67)
else:
    for i in range(7):
        x=.65+i*.47
        y=5.78-.22*((x-2.05)/1.5)**2
        screen_panel(x,y,1.58,.474,1.52,i/7,(i+1)/7)


def chair(x,y,angle):
    seat=box('Meeting chair seat',(x,y,.47),(.43,.43,.09),white,bevel=.045)
    seat.rotation_euler.z=angle
    dx,dy=-math.sin(angle)*.19,math.cos(angle)*.19
    back=box('Meeting chair back',(x+dx,y+dy,.72),(.43,.065,.43),navy,bevel=.04)
    back.rotation_euler.z=angle
    for a,b in ((-.15,-.15),(.15,-.15),(-.15,.15),(.15,.15)):
        rod('Chair leg',(x+a,y+b,.07),(x+a,y+b,.44),.014,silver)


for x,y in ((1.05,1.4),(2.75,1.75),(1.1,3.45),(2.9,3.6)):
    rod('Low table pedestal',(x,y,.07),(x,y,.69),.04,silver)
    rod('Table foot',(x,y,.065),(x,y,.085),.25,dark)
    rod('Low round table',(x,y,.69),(x,y,.735),.39,white)
    chair(x-.58,y,math.pi/2); chair(x+.58,y,-math.pi/2)
    if plan=='premium':
        box('Low meeting privacy panel',(x,y+.54,.58),(1.38,.06,1.05),navy,bevel=.03)
        box('Pod blue edge',(x,y+.495,1.09),(1.38,.02,.025),blue,bevel=0)

box('Explanation counter',(4.85,.85,.54),(1.55,.6,.98),navy,bevel=.055)
box('Luminous counter top',(4.85,.85,1.05),(1.62,.67,.075),fabric,bevel=.025)
wordmark((4.85,.535,.59),.18)
box('Laptop keyboard',(4.8,.84,1.1),(.4,.26,.025),dark)
lap=box('Laptop display',(4.8,1,1.24),(.4,.025,.28),dark)
lap.rotation_euler.x=math.radians(12)
box('Pamphlet rack base',(5.68,2.48,.08),(.42,.42,.06),silver)
rod('Pamphlet rack stem',(5.68,2.48,.1),(5.68,2.48,1.42),.025,silver)
for z in (.55,.85,1.15,1.42):
    shelf=box('Pamphlet shelf',(5.68,2.42,z),(.38,.26,.025),silver)
    shelf.rotation_euler.x=.22
    box('Blank navy brochures',(5.68,2.4,z+.035),(.27,.19,.025),navy)

if plan=='standard':
    box('Illuminated entrance logo cube',(.55,.55,.27),(.45,.45,.45),fabric)
    wordmark((.55,.31,.25),.06)
elif plan=='premium':
    curve('Halo within 3.6m envelope',[(3+1.35*math.cos(t*2*math.pi/96),3+1.35*math.sin(t*2*math.pi/96),3.02) for t in range(97)],.045,fabric)
    for x in (.45,3.9,5.55): box('Recessed floor light',(x,3,.053),(.023,5.4,.006),blue,bevel=0)
elif plan=='impact':
    # Figure-eight light gate under the roof, entirely inside the footprint.
    points=[(1.85+1.57*math.cos(t*2*math.pi/160),.38,1.63+1.35*math.sin(2*t*2*math.pi/160)) for t in range(161)]
    curve('Infinity gate aluminium core',points,.085,silver)
    curve('Infinity blue half',[(x,y-.075,z) for x,y,z in points[:81]],.045,blue)
    curve('Infinity purple half',[(x,y-.075,z) for x,y,z in points[80:]],.045,purple)


def person(x,y):
    # Simplified clothed figure: total height exactly 1.70m above hall floor.
    for dx in (-.09,.09):
        rod('Human leg',(x+dx,y,.09),(x+dx,y,.82),.065,ink,False)
        box('Human shoe',(x+dx,y-.045,.075),(.13,.25,.1),dark,False,.03)
    body=sphere('Human torso',(x,y,1.075),(.22,.13,.33),ink,False)
    sphere('Human head',(x,y,1.575),(.105,.1,.125),skin,False)
    rod('Human neck',(x,y,1.36),(x,y,1.49),.055,skin,False)
    for side in (-1,1):
        rod('Human arm',(x+side*.19,y,1.28),(x+side*.27,y-.02,.94),.055,ink,False)
        sphere('Human hand',(x+side*.27,y-.02,.9),(.046,.045,.08),skin,False)
    box('White shirt',(x,y-.126,1.23),(.08,.012,.24),white,False,0)


for x,y in ((-.65,-.5),(6.7,-.35),(4.8,1.55),(3.65,4.7)):
    person(x,y)

hall=material('Exhibition hall concrete','777f8d',rough=.82)
box('Hall floor',(3,3,-.06),(60,60,.12),hall,False,0)
box('Hall rear wall',(3,19,6),(60,.2,12),hall,False,0)
box('Hall ceiling',(3,3,11.1),(60,60,.15),material('Ceiling','353e4d'),False,0)
for x in range(-18,25,4):
    rod('High hall roof beam',(x,-15,10.7),(x,22,10.7),.10,silver,False)
for y in range(-12,23,4):
    rod('High hall cross beam',(-20,y,10.5),(24,y,10.5),.09,silver,False)
for x in (-4.5,10.5):
    box('Neighbour low wall',(x,6.5,1.35),(3.8,.12,2.7),white,False)
    box('Neighbour front desk',(x,4,.5),(1.5,.6,1),hall,False)
    for dx in (-1.7,1.7): box('Neighbour upright',(x+dx,5,1.35),(.1,.1,2.7),silver,False)
    box('Neighbour header',(x,5,2.55),(3.5,.15,.3),white,False)
world=bpy.data.worlds.new('Exhibition ambient'); world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.32,.39,.52,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.4
bpy.context.scene.world=world
light('Large frontal softbox',(-3,-4,8),2100,9,target=(3,3,0))
light('Overhead hall',(3,5,9),2600,10)
light('Membrane interior',(3,3,3.25),450,4)
light('Blue accent',(5.6,4,2.5),90,2,(.08,.25,1),target=(3,5.9,1.5))
light('Purple accent',(.5,4,2.5),70,2,(.48,.15,1),target=(2,5.9,1.5))
bpy.ops.object.camera_add(location=(-8.2,-10.5,1.6))
camera=bpy.context.object; camera.data.lens=32; camera.data.sensor_width=36
camera.rotation_euler=(Vector((3,3,2.65))-camera.location).to_track_quat('-Z','Y').to_euler()
scene=bpy.context.scene; scene.camera=camera
scene.render.engine='BLENDER_EEVEE'
scene.render.threads_mode='FIXED'; scene.render.threads=6
scene.render.resolution_x=1600; scene.render.resolution_y=900; scene.render.resolution_percentage=100
# Match underlay's effective 1344:768 aspect without changing the camera.
scene.render.pixel_aspect_x=1; scene.render.pixel_aspect_y=64/63
scene.view_settings.view_transform='AgX'; scene.view_settings.look='AgX - Medium High Contrast'
scene.render.image_settings.file_format='PNG'
scene.render.filepath=os.path.join(out,f'blender-{plan}.png')
bpy.context.view_layer.update()
bounds=[obj.matrix_world @ Vector(corner) for obj in booth_objects for corner in obj.bound_box]
minimum=[min(p[i] for p in bounds) for i in range(3)]
maximum=[max(p[i] for p in bounds) for i in range(3)]
assert minimum[0]>=-1e-4 and minimum[1]>=-1e-4, minimum
assert maximum[0]<=6.0001 and maximum[1]<=6.0001 and maximum[2]<=3.6001, maximum
def px(point):
    q=world_to_camera_view(scene,camera,Vector(point))
    return [q.x*1600,(1-q.y)*900]
with open(os.path.join(out,'underlay-meta.json'),encoding='utf-8') as handle:
    reference=json.load(handle)
expected_y=sum(p[1] for p in reference['front_top_edge_px'])/2/reference['height']
actual_y=sum(px(p)[1] for p in ((0,0,3.6),(6,0,3.6)))/2/900
shift=(expected_y-actual_y)/(reference['booth_height_px']/reference['height'])*100
assert abs(shift)<.01, shift
audit={'plan':plan,'method':'Blender Eevee','booth_bounds_min':minimum,'booth_bounds_max':maximum,
       'height_m':3.6,'person_height_m':1.7,'camera_location':list(camera.location),'camera_mm':32,
       'width':1600,'height':900,'front_top_edge_px':[px((0,0,3.6)),px((6,0,3.6))],
       'top_shift_percent_geometry':shift,'readable_text':['GridBeyond']}
with open(os.path.join(out,f'geometry-{plan}.json'),'w',encoding='utf-8') as handle:
    json.dump(audit,handle,indent=2)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,f'GridBeyond-{plan}-v5.blend'))
bpy.ops.render.render(write_still=True)
