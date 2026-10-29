# 保有機材 STL を「部材 1 点 = 1 アセット」に分割して library.blend / library.json を作る（Blender 内で実行）。
# 実行: blender -b -P build-library.py -- <stl_dir> <stl-sources.json> <out_dir>
# 処理（STL 1 件ごと）:
#   1. 取り込み → 頂点を統合 → 連結成分(loose parts)に分割
#   2. 成分を束ねて「部材」にする
#        mode=cluster(既定): バウンディングボックスが重なる成分を 1 部材へ（トラスの弦材・斜材・端板を 1 本のトラスにする）
#        mode=grid         : 一体化した大きな床板をグリッド(gridPitch)で切り、床下の脚・斜材を足元のセルへ寄せる（ステージの 1m 角パネル）
#   3. 人型スケールフィギュア（高さ 1880〜1940mm かつ X・Y の幅がともに 800mm 未満）を除外
#   4. 同一寸法（各辺 ±5mm、XY は入れ替え可）の部材を 1 アセットにまとめて count_in_stl を数える
#   5. asset_id を付け、原点を底面中心へ移し、コレクション assets/<asset_id> に入れる
# 寸法の単位は mm（シーン 1 単位 = 1mm）。STL を変更しない。
import bpy, bmesh, sys, os, json, math
from mathutils import Vector, Matrix

HUMAN_H = (1880, 1940)   # 人型の高さ範囲(mm)
HUMAN_W = 800            # 人型の X・Y 幅の上限(mm、未満)
DEDUP_TOL = 5            # 同一寸法とみなす許容(mm)
CLUSTER_TOL = 2          # 成分どうしを束ねる隙間(mm)


def round_to(v, step=10):
    return int(math.floor(v / step + 0.5)) * step


def base_id(slug, kind, dims, step=10):
    """asset-naming.mjs の assetBaseId と同じ規則。"""
    w, d, h = (round_to(v, step) for v in dims)
    if kind == "length":
        return "%s_L%d" % (slug, max(w, d, h))
    if kind == "panel":
        return "%s_%dx%d" % (slug, w, d)
    return "%s_%dx%dx%d" % (slug, w, d, h)


def bbox_of(ob):
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
            Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))))


def union_bbox(objs):
    boxes = [bbox_of(o) for o in objs]
    return (Vector((min(b[0].x for b in boxes), min(b[0].y for b in boxes), min(b[0].z for b in boxes))),
            Vector((max(b[1].x for b in boxes), max(b[1].y for b in boxes), max(b[1].z for b in boxes))))


def is_human(mn, mx):
    d = mx - mn
    return HUMAN_H[0] <= d.z <= HUMAN_H[1] and d.x < HUMAN_W and d.y < HUMAN_W


def object_mode():
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')


def import_and_split(path):
    before = set(bpy.data.objects)
    bpy.ops.wm.stl_import(filepath=path)
    new = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    if not new:
        raise RuntimeError("STL を読めません: " + path)
    ob = new[0]
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.001)
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
    return [o for o in bpy.data.objects if o not in before and o.type == 'MESH']


def join(objs):
    if len(objs) == 1:
        return objs[0]
    object_mode()
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def cluster_units(parts):
    """バウンディングボックスが CLUSTER_TOL 以内で重なる成分を連結して束ねる。"""
    boxes = [bbox_of(p) for p in parts]
    parent = list(range(len(parts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            a, b = boxes[i], boxes[j]
            if all(a[0][k] - CLUSTER_TOL <= b[1][k] and b[0][k] - CLUSTER_TOL <= a[1][k] for k in range(3)):
                parent[find(i)] = find(j)
    groups = {}
    for i, p in enumerate(parts):
        groups.setdefault(find(i), []).append(p)
    return [join(g) for g in groups.values()]


def grid_units(parts, pitch):
    """一体化した大きな床板を pitch のグリッドで切り、周辺の小成分を重心のあるセルへ束ねる。"""
    decks = []
    rest = []
    for p in parts:
        mn, mx = bbox_of(p)
        d = mx - mn
        (decks if max(d.x, d.y) > 1.5 * pitch and d.z < 0.7 * pitch else rest).append((p, mn, mx))
    cells = []  # [x0, x1, y0, y1, [objs]]
    for p, mn, mx in decks:
        d = mx - mn
        nx, ny = max(1, round(d.x / pitch)), max(1, round(d.y / pitch))
        cw, ch = d.x / nx, d.y / ny
        bm = bmesh.new()
        bm.from_mesh(p.data)
        buckets = {}
        for f in bm.faces:
            c = f.calc_center_median()
            key = (min(nx - 1, int((c.x - mn.x) // cw)), min(ny - 1, int((c.y - mn.y) // ch)))
            buckets.setdefault(key, set()).add(f.index)
        for (ix, iy), keep in sorted(buckets.items()):
            b2 = bm.copy()
            b2.faces.ensure_lookup_table()
            doomed = [f for f in b2.faces if f.index not in keep]
            bmesh.ops.delete(b2, geom=doomed, context='FACES')
            me = bpy.data.meshes.new("cell")
            b2.to_mesh(me)
            b2.free()
            ob = bpy.data.objects.new("cell", me)
            bpy.context.scene.collection.objects.link(ob)
            cells.append([mn.x + ix * cw, mn.x + (ix + 1) * cw, mn.y + iy * ch, mn.y + (iy + 1) * ch, [ob]])
        bm.free()
        bpy.data.objects.remove(p, do_unlink=True)
    units = []
    for p, mn, mx in rest:
        c = (mn + mx) / 2
        cell = next((cl for cl in cells if cl[0] <= c.x <= cl[1] and cl[2] <= c.y <= cl[3]), None)
        # セル外へ張り出す脚・斜材はパネル寸法を歪めるため、独立した付属部材にする。
        # 重心だけで寄せると端の6枚だけ 1000x1083mm になってしまう。
        contained = (cell is not None and
                     mn.x >= cell[0] - CLUSTER_TOL and mx.x <= cell[1] + CLUSTER_TOL and
                     mn.y >= cell[2] - CLUSTER_TOL and mx.y <= cell[3] + CLUSTER_TOL)
        if contained and mx.z - mn.z < 0.7 * pitch:
            cell[4].append(p)
        else:
            units.append([p])
    out = [join(cl[4]) for cl in cells]
    for ob in out:
        ob["booth3d_grid_cell"] = True
    # セルへ寄せなかった残りは通常の束ね方へ
    leftovers = [u[0] for u in units]
    accessories = cluster_units(leftovers) if leftovers else []
    for ob in accessories:
        ob["booth3d_grid_cell"] = False
    return out + accessories


def faces_of(ob):
    return len(ob.data.polygons)


def purge(objs):
    for o in objs:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0:
            bpy.data.meshes.remove(me)


def same_dims(a, b):
    # W/D/H は library.json の契約上それぞれ別の軸。回転配置された部材を
    # 勝手に同一視せず、各辺が許容内のときだけ同寸法としてまとめる。
    return all(abs(x - y) <= DEDUP_TOL for x, y in zip(a, b))


def ground_to_bottom_center(ob):
    mn, mx = bbox_of(ob)
    c = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    ob.data.transform(Matrix.Translation(-c))
    ob.matrix_world.identity()
    ob.location = (0, 0, 0)
    ob.rotation_euler = (0, 0, 0)
    ob.scale = (1, 1, 1)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    stl_dir, sources_path, out_dir = argv[0], argv[1], argv[2]
    os.makedirs(out_dir, exist_ok=True)
    with open(sources_path, encoding="utf-8") as f:
        sources = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.length_unit = 'MILLIMETERS'
    sc.unit_settings.scale_length = 0.001
    root = bpy.data.collections.new("assets")
    sc.collection.children.link(root)

    library, used_ids, saved_human = [], set(), None
    for src in sources:
        path = os.path.join(stl_dir, src["name"])
        parts = import_and_split(path)
        n_parts = len(parts)
        mode = src.get("mode", "cluster")
        if mode == "grid":
            units = grid_units(parts, src.get("gridPitch", 1000))
        elif mode == "loose":
            units = parts
        else:
            units = cluster_units(parts)

        kept, humans = [], []
        for u in units:
            mn, mx = bbox_of(u)
            (humans if is_human(mn, mx) else kept).append(u)
        # パースの縮尺確認用として、ステージ STL に同梱された人型を 1 体だけ残す。
        # それ以外の複製は従来どおり除外する。
        if saved_human is None and humans and src["slug"] == "stage_panel":
            saved_human = (humans.pop(0), src["name"])
        purge(humans)

        groups = []  # [dims, [objs]]
        for u in kept:
            mn, mx = bbox_of(u)
            d = mx - mn
            # ステージは床下の脚・斜材が公称 1m 角から張り出すため、
            # セルの XY は原本の gridPitch を正本とする。高さは実形状を使う。
            dims = ((src.get("gridPitch", 1000), src.get("gridPitch", 1000), d.z)
                    if mode == "grid" and u.get("booth3d_grid_cell", False)
                    else (d.x, d.y, d.z))
            for g in groups:
                if same_dims(g[0], dims):
                    g[1].append(u)
                    break
            else:
                groups.append([dims, [u]])
        groups.sort(key=lambda g: (g[0][2], g[0][0], g[0][1]))

        for dims, members in groups:
            rep = members[0]
            purge(members[1:])
            aid = base_id(src["slug"], src["kind"], dims, src.get("step", 10))
            n = 2
            unique = aid
            while unique in used_ids:
                unique = "%s_%d" % (aid, n)
                n += 1
            used_ids.add(unique)
            ground_to_bottom_center(rep)
            rep.name = unique
            rep.data.name = unique
            coll = bpy.data.collections.new(unique)
            root.children.link(coll)
            for c in list(rep.users_collection):
                c.objects.unlink(rep)
            coll.objects.link(rep)
            mn, mx = bbox_of(rep)
            d = mx - mn
            library.append({"asset_id": unique, "source_file": src["name"],
                            "dims_mm": [round(v, 3) for v in dims],
                            "count_in_stl": len(members), "faces": faces_of(rep),
                            "inventory": None, "thumb": "thumbs/%s.png" % unique})
        print("SRC %s parts=%d units=%d humans=%d assets=%d" % (src["slug"], n_parts, len(units), len(humans), len(groups)))

    if saved_human:
        rep, source_name = saved_human
        ground_to_bottom_center(rep)
        rep.name = "scale_figure_1913"
        rep.data.name = rep.name
        coll = bpy.data.collections.new(rep.name)
        root.children.link(coll)
        for c in list(rep.users_collection):
            c.objects.unlink(rep)
        coll.objects.link(rep)
        mn, mx = bbox_of(rep)
        dims = mx - mn
        library.append({"asset_id": rep.name, "source_file": source_name,
                        "dims_mm": [round(v, 3) for v in dims], "count_in_stl": 1,
                        "faces": faces_of(rep), "inventory": 1,
                        "thumb": "thumbs/%s.png" % rep.name})

    blend = os.path.join(out_dir, "library.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)
    with open(os.path.join(out_dir, "library.json"), "w", encoding="utf-8") as f:
        json.dump(library, f, ensure_ascii=False, indent=1)
    print("LIBRARY_DONE assets=%d blend=%s" % (len(library), blend))


main()
