import bpy


def material(name, color, emission=0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    if emission:
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*color, 1)
        bsdf.inputs['Emission Color'].default_value = (*color, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    return mat


def box(name, dims, loc, mat=None):
    bpy.ops.mesh.primitive_cube_add(location=(loc[0], loc[1], loc[2] + dims[2] / 2))
    ob = bpy.context.object; ob.name = name; ob.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat: ob.data.materials.append(mat)
    return ob


def make_param(item, name):
    p = item['param']; w = item.get('w_mm', 400); d = item.get('d_mm', item.get('t_mm', 120)); h = item.get('h_mm', 18)
    if p == 'ledup':
        frame = material('LEDUP frame', (0.08, 0.08, 0.09)); glow = material('LEDUP face', (0.8, 0.95, 1.0), 0.35)
        parts = [box(name + '_face', (w - 50, 15, h - 50), (0, -d / 2 - 8, 0), glow)]
        for x in (-w / 2 + 25, w / 2 - 25): parts.append(box(name + '_post', (50, d, h), (x, 0, 0), frame))
        for z in (0, h - 50): parts.append(box(name + '_rail', (w, d, 50), (0, 0, z), frame))
        return parts
    color = (0.75, 0.75, 0.78) if p == 'system_panel' else (0.32, 0.32, 0.34)
    return [box(name, (w, d, h), (0, 0, 0), material(p, color))]


def booth_shell(booth):
    floor = box('booth_floor', (booth['w_mm'], booth['d_mm'], 20), (booth['w_mm']/2, booth['d_mm']/2, -20), material('floor', (0.2, 0.22, 0.24)))
    walls = [floor]; t = 35; h = booth['height_limit_mm']; white = material('wall', (0.82, 0.84, 0.87))
    for side in booth.get('walls', []):
        if side == 'back': walls.append(box('wall_back', (booth['w_mm'], t, h), (booth['w_mm']/2, booth['d_mm']-t/2, 0), white))
        elif side == 'front': walls.append(box('wall_front', (booth['w_mm'], t, h), (booth['w_mm']/2, t/2, 0), white))
        elif side == 'left': walls.append(box('wall_left', (t, booth['d_mm'], h), (t/2, booth['d_mm']/2, 0), white))
        elif side == 'right': walls.append(box('wall_right', (t, booth['d_mm'], h), (booth['w_mm']-t/2, booth['d_mm']/2, 0), white))
    return walls
