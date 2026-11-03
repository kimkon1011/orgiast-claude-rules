import bpy, json, math, os, sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
from parametric import booth_shell, make_param, material


def dims_collection():
    coll=bpy.data.collections.get('dims')
    if not coll:
        coll=bpy.data.collections.new('dims'); bpy.context.scene.collection.children.link(coll)
    return coll


def point_camera(camera, target):
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat('-Z', 'Y').to_euler()


def line(name, points, bevel=8, mat=None):
    curve = bpy.data.curves.new(name, 'CURVE'); curve.dimensions = '3D'; curve.bevel_depth = bevel; curve.bevel_resolution = 0
    spl = curve.splines.new('POLY'); spl.points.add(len(points)-1)
    for p, co in zip(spl.points, points): p.co = (*co, 1)
    ob = bpy.data.objects.new(name, curve); dims_collection().objects.link(ob)
    if mat: ob.data.materials.append(mat)
    return ob


def text(name, body, location, size, rotation=(0,0,0), align='CENTER'):
    curve = bpy.data.curves.new(name, 'FONT'); curve.body = body; curve.align_x = align; curve.size = size; curve.extrude = 1
    ob = bpy.data.objects.new(name, curve); dims_collection().objects.link(ob); ob.location = location; ob.rotation_euler = rotation
    curve.materials.append(material('dimension ink', (0.02, 0.02, 0.02))); return ob


def clear_dims():
    for ob in list(bpy.data.objects):
        if ob.get('booth_dimension'): bpy.data.objects.remove(ob, do_unlink=True)


def tag(ob): ob['booth_dimension'] = True; return ob


def dimension(a, b, offset, label, plane):
    ink = material('dimension ink', (0.02,0.02,0.02)); aa=Vector(a); bb=Vector(b); off=Vector(offset); p=aa+off; q=bb+off
    for ob in [line('dim_line',[p,q],6,ink), line('dim_ext_a',[aa,p],4,ink), line('dim_ext_b',[bb,q],4,ink)]: tag(ob)
    mid=(p+q)/2
    rot=(0,0,0) if plane=='top' else (math.radians(90),0,0)
    tag(text('dim_text',label,mid+(Vector((0,0,20)) if plane=='top' else Vector((0,-20,0))),90,rot))


def add_dimensions(spec, view):
    w=spec['booth']['w_mm']; d=spec['booth']['d_mm']; h=spec['booth']['height_limit_mm']
    if view=='top':
        dimension((0,0,50),(w,0,50),(0,-350,0),f'{w:.0f} mm','top'); dimension((0,0,50),(0,d,50),(-350,0,0),f'{d:.0f} mm','top')
        dimension((0,d+180,50),(1000,d+180,50),(0,0,0),'scale 1000 mm','top')
        major=next((i for i in spec['items'] if i.get('w_mm')),None)
        if major:
            mw=major['w_mm']; x,y,_=major['pos_mm']; dimension((x-mw/2,y,80),(x+mw/2,y,80),(0,220,0),f'item W {mw:.0f} mm','top')
    elif view=='front':
        dimension((0,0,0),(w,0,0),(0,-100,-300),f'{w:.0f} mm','front'); dimension((0,0,0),(0,0,h),(-350,-100,0),f'{h:.0f} mm','front')
        dimension((w-1000,0,100),(w,0,100),(0,-100,0),'scale 1000 mm','front')
    else:
        dimension((0,0,0),(0,d,0),(-100,0,-300),f'{d:.0f} mm','side'); dimension((0,0,0),(0,0,h),(-100,-350,0),f'{h:.0f} mm','side')
        dimension((0,d-1000,100),(0,d,100),(-100,0,0),'scale 1000 mm','side')


def load_templates(library_blend, ids):
    with bpy.data.libraries.load(library_blend, link=False) as (src, dst): dst.objects = [x for x in ids if x in src.objects]
    return {ob.name: ob for ob in dst.objects if ob}


def place_item(item, index, templates):
    count=item.get('count',1); made=[]
    for n in range(count):
        if item.get('asset_id'):
            tpl=templates.get(item['asset_id'])
            if not tpl: raise RuntimeError('asset object not in library.blend: '+item['asset_id'])
            ob=tpl.copy(); ob.data=tpl.data; ob.name=f"item_{index+1}_{n+1}_{item['asset_id']}"; bpy.context.scene.collection.objects.link(ob); obs=[ob]
        else: obs=make_param(item,f"item_{index+1}_{n+1}_{item['param']}")
        # count means inventory/BOM multiplicity; if rendered, offset copies slightly to keep them visible.
        for ob in obs:
            ob.location += Vector(item['pos_mm']); ob.location.x += n * 30
            ob.rotation_euler.z += math.radians(item.get('rot_deg',0)); ob.rotation_euler.x += math.radians(item.get('pitch_deg',0)); made.append(ob)
    return made


def render_view(spec, view, out_dir, camera, subjects):
    clear_dims(); w=spec['booth']['w_mm']; d=spec['booth']['d_mm']; h=spec['booth']['height_limit_mm']; center=(w/2,d/2,h*.42); span=max(w,d,h)
    ortho=view in ('top','front','side_left','side_right','back')
    if view=='persp_front_left': camera.location=(w*.12,-span*1.15,h*.72); point_camera(camera,center)
    elif view=='persp_front_right': camera.location=(w*.88,-span*1.15,h*.72); point_camera(camera,center)
    elif view=='top': camera.location=(w/2,d/2,h+span*2); camera.rotation_euler=(0,0,0); camera.rotation_euler.x=0; point_camera(camera,(w/2,d/2,0)); add_dimensions(spec,'top')
    elif view=='front': camera.location=(w/2,-span*2,h/2); point_camera(camera,(w/2,d/2,h/2)); add_dimensions(spec,'front')
    elif view in ('side_left','side_right'): camera.location=((-span*2 if view=='side_left' else w+span*2),d/2,h/2); point_camera(camera,(w/2,d/2,h/2)); add_dimensions(spec,'side')
    elif view=='back': camera.location=(w/2,d+span*2,h/2); point_camera(camera,(w/2,d/2,h/2)); add_dimensions(spec,'front')
    camera.data.type='ORTHO' if ortho else 'PERSP'; camera.data.ortho_scale=max(w,d,h)*1.45; camera.data.lens=48
    scene=bpy.context.scene; scene.render.resolution_x=1600; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'; scene.render.filepath=os.path.abspath(os.path.join(out_dir,view+'.png')); bpy.ops.render.render(write_still=True)


def main():
    args=sys.argv[sys.argv.index('--')+1:]; spec_path, library_blend, out_dir=args[:3]
    with open(spec_path,encoding='utf8') as f: spec=json.load(f)
    os.makedirs(out_dir,exist_ok=True); bpy.ops.wm.read_factory_settings(use_empty=True); scene=bpy.context.scene
    scene.unit_settings.system='METRIC'; scene.unit_settings.length_unit='MILLIMETERS'; scene.unit_settings.scale_length=.001
    scene.render.engine='BLENDER_WORKBENCH'; scene.display.shading.light='STUDIO'; scene.display.shading.show_shadows=True; scene.display.shading.show_cavity=True; scene.display.shading.color_type='MATERIAL'; scene.render.film_transparent=False
    scene.world = bpy.data.worlds.new('World'); scene.world.color=(.92,.92,.92); booth_shell(spec['booth'])
    ids={i['asset_id'] for i in spec['items'] if i.get('asset_id')}; templates=load_templates(library_blend,ids); subjects=[]
    for index,item in enumerate(spec['items']): subjects.extend(place_item(item,index,templates))
    camera_data=bpy.data.cameras.new('Camera'); camera_data.clip_start=1; camera_data.clip_end=100000
    camera=bpy.data.objects.new('Camera',camera_data); scene.collection.objects.link(camera); scene.camera=camera
    for view in spec['views']: render_view(spec,view,out_dir,camera,subjects)
    clear_dims(); bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(out_dir,'scene.blend')),compress=True)
    print('BOOTH_DONE views=%d objects=%d out=%s' % (len(spec['views']),len(subjects),out_dir))

main()
