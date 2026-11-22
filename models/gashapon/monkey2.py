# 耳鼻猴 v2（貼圖版；使用者 2026-11-23）：Model-Monkey-v2.glb（Meshy，網格和舊檔相同、多了貼圖）。
# 用模型原本的貼圖（顏色＋凹凸），網站另外加上毛氈的絨毛材質；頭帶上的藍色改成白色；頭帶背後的扣環換成白色蝴蝶結
import bpy, bmesh, math, os
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
import teddy as T

GLB = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', 'Model-Monkey-v2.glb')
OUT_TEX = os.path.join(os.path.dirname(__file__), 'monkey_tex.jpg')
OUT_NRM = os.path.join(os.path.dirname(__file__), 'monkey_nrm.jpg')
VF = dict(s=532.87, cx=663.46, m=0.011957)        # 和舊版同一個網格：沿用舊版對齊設計圖的數字（monkey.py）
FACES = 70000


def build(HL, tube, join, link):
    bpy.ops.import_scene.gltf(filepath=GLB)
    ob = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]
    for o in list(bpy.context.selected_objects):
        if o is not ob:
            bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    ob.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = ob.data
    mat = me.materials[0]
    col_img = [l.from_node.image for l in mat.node_tree.links if l.to_socket.name == 'Base Color'][0]
    nrm_img = [l.from_node.image for l in mat.node_tree.links if l.to_node.type == 'NORMAL_MAP'][0]
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for p_ in me.polygons:
        p_.use_smooth = True
    V = np.array([v.co[:] for v in me.vertices]); n = len(V)
    zmin = V[:, 2].min()

    # ---- 貼圖：頭帶上的藍色改成白色（只在頭部，披風不動）----
    W, H = col_img.size
    px = np.array(col_img.pixels[:]).reshape(H, W, 4)
    uvl = me.uv_layers.active.data
    head_loops = [lp for lp in me.loops if V[lp.vertex_index, 2] > 0.25]
    uvs = np.array([uvl[lp.index].uv[:] for lp in head_loops])
    xs = np.clip((uvs[:, 0] * (W - 1)).astype(int), 0, W - 1); ys = np.clip((uvs[:, 1] * (H - 1)).astype(int), 0, H - 1)
    c = px[ys, xs, :3]
    whiteish = (c.min(1) > 0.72) & (np.ptp(c, 1) < 0.08)
    white = np.median(c[whiteish], 0) if whiteish.any() else np.array([0.95, 0.95, 0.95])
    isblue = lambda q: (q[..., 2] > q[..., 0] + 0.12) & (q[..., 2] > 0.35)
    # 只塗頭部三角形在貼圖上實際蓋到的像素（方塊塗法會溢到 UV 相鄰的披風，變成白點）
    me.calc_loop_triangles(); painted = 0
    for lt in me.loop_triangles:
        if min(V[v, 2] for v in lt.vertices) <= 0.25:
            continue
        P = np.array([uvl[l].uv[:] for l in lt.loops]) * [W - 1, H - 1]
        x0, y0 = np.floor(P.min(0)).astype(int) - 1; x1, y1 = np.ceil(P.max(0)).astype(int) + 1
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W - 1), min(y1, H - 1)
        gx_, gy_ = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx2, cy2) = P
        den = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2)
        if abs(den) < 1e-12:
            continue
        l1 = ((by - cy2) * (gx_ - cx2) + (cx2 - bx) * (gy_ - cy2)) / den
        l2 = ((cy2 - ay) * (gx_ - cx2) + (ax - cx2) * (gy_ - cy2)) / den
        tol = 1.2 / max(abs(den), 1e-6) ** 0.5
        ins = (l1 > -tol) & (l2 > -tol) & (1 - l1 - l2 > -tol)
        blk = px[y0:y1 + 1, x0:x1 + 1, :3]
        m_ = ins & isblue(blk)
        blk[m_] = white; painted += int(m_.sum())
    COV = T.uv_cover(me, W, H)
    px = T.dilate(px, COV)
    print('monkey2: band blue texels → white', painted, 'white', np.round(white, 3))
    out = bpy.data.images.new('monkey_tex', W, H); out.pixels = px.ravel()
    out.filepath_raw = OUT_TEX; out.file_format = 'JPEG'; out.save()
    NW, NH = nrm_img.size
    npx = np.array(nrm_img.pixels[:]).reshape(NH, NW, 4)
    npx = T.dilate(npx, COV if (NW, NH) == (W, H) else T.uv_cover(me, NW, NH))
    nimg = bpy.data.images.new('monkey_nrm', NW, NH, is_data=True); nimg.pixels = npx.ravel()
    nimg.filepath_raw = OUT_NRM; nimg.file_format = 'JPEG'; nimg.save()
    me.materials.clear()

    # ---- 減面（整隻一起減；貼圖座標會保留）----
    md = ob.modifiers.new('dc', 'DECIMATE'); md.ratio = min(1.0, FACES / len(me.polygons))
    bpy.ops.object.modifier_apply(modifier='dc')
    V = np.array([v.co[:] for v in me.vertices])
    bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())

    # ---- 依貼圖顏色把面分成幾個部分（網站各自用不同材質，顏色都還是用貼圖）----
    #   Eyes：眼睛、鼻子（眼寶瞳孔的材質）；Cloth：腮紅、白頭帶、披風（秤秤腮紅的霧面材質）；
    #   Cream：淺膚色（眼寶身體的材質）；其餘（橘色毛、嘴巴、耳內）留在 Skin（毛氈）
    uvl = me.uv_layers.active.data
    PROTO = {'fur': (0.80, 0.45, 0.15), 'cream': (1.0, 0.82, 0.64), 'white': (0.96, 0.95, 0.99), 'blue': (0.15, 0.62, 1.0),
             'dark': (0.08, 0.07, 0.07), 'nose': (0.42, 0.11, 0.03), 'red': (0.80, 0.31, 0.26), 'tongue': (0.92, 0.42, 0.36), 'pink': (1.0, 0.57, 0.49)}
    PK = list(PROTO); PC = np.array([PROTO[k] for k in PK])
    # 先在完整的網格上分類一次，再用相鄰面多數決讓邊界平順
    FC = np.array([p_.center[:] for p_ in me.polygons])
    COLS = np.array([np.array([px[int(uvl[l].uv[1] * (H - 1)), int(uvl[l].uv[0] * (W - 1)), :3] for l in p_.loop_indices]).mean(0) for p_ in me.polygons])
    face = (np.abs(FC[:, 0]) < 0.45) & (FC[:, 1] < -0.2)
    # 鼻子頭飾（頭帶上的大鼻子）：頭的正前上方、比毛色亮的橘色；鼻孔在頭飾範圍內也算
    oreg = (np.abs(FC[:, 0]) < 0.25) & (FC[:, 2] > 0.47) & (FC[:, 1] < -0.25)
    ORN = oreg & (COLS[:, 1] > 0.56) & (COLS[:, 0] > 0.9) & (COLS[:, 2] < 0.45)
    if ORN.any():
        oc = np.median(FC[ORN], 0); orr = np.percentile(np.linalg.norm(FC[ORN] - oc, axis=1), 97)
        ORN |= oreg & (np.linalg.norm(FC - oc, axis=1) < orr) & (COLS[:, 0] < 0.75)   # 鼻孔（較暗）
    print('monkey2: nose ornament faces', int(ORN.sum()))
    # 腮紅：顏色很確定的粉紅面找出左右兩個中心，取正圓範圍（邊緣才會圓順）
    strict = face & (((COLS - np.array(PROTO['pink'])) ** 2).sum(1) < 0.01)
    CHEEK = np.zeros(len(FC), bool)
    for sgn in (-1, 1):
        m_ = strict & (np.sign(FC[:, 0] + 0.03) == sgn) & (np.abs(FC[:, 0] + 0.03) > 0.12)
        if m_.sum() < 5:
            continue
        cc = np.median(FC[m_], 0); rr = np.percentile(np.linalg.norm(FC[m_] - cc, axis=1), 85)
        CHEEK |= face & (np.linalg.norm(FC - cc, axis=1) < rr * 1.15)
        print('monkey2: cheek', sgn, np.round(cc, 3), round(float(rr), 3))
    cls = []
    for i, cs in enumerate(COLS):
        dd = ((PC - cs) ** 2).sum(1); k = PK[int(np.argmin(dd))]
        c_ = FC[i]
        mouth = abs(c_[0] + 0.03) < 0.11 and 0.13 < c_[2] < 0.29 and c_[1] < -0.3   # 嘴的位置（量過耳鼻猴的嘴）
        if ORN[i]:
            k = 'orn'
        elif CHEEK[i]:
            k = 'pink'
        elif k in ('red', 'tongue', 'pink'):
            if mouth and k != 'pink':
                pass
            elif face[i]:
                k = 'cream' if dd[PK.index('cream')] < dd[PK.index('fur')] else 'fur'   # 臉上其他的過渡色
            else:
                k = 'earpink'                                        # 耳朵內側的粉紅
        cls.append(k)
    GRP = {'dark': 'Eyes', 'nose': 'Eyes', 'red': 'Eyes', 'tongue': 'Eyes', 'white': 'Cloth', 'blue': 'Cloth', 'pink': 'Cloth', 'earpink': 'Cream', 'cream': 'Cream', 'orn': 'Cream'}
    g = np.array([GRP.get(k, 'Skin') for k in cls], dtype=object)
    fe = {}
    for p_ in me.polygons:
        for ek in p_.edge_keys:
            fe.setdefault(ek, []).append(p_.index)
    nbr = [[] for _ in me.polygons]
    for fs in fe.values():
        for f1 in fs:
            for f2 in fs:
                if f1 != f2:
                    nbr[f1].append(f2)
    for _ in range(3):
        g2 = g.copy()
        for i, nb in enumerate(nbr):
            if not nb:
                continue
            vals, cnts = np.unique(g[nb], return_counts=True)
            j = int(np.argmax(cnts))
            if cnts[j] > len(nb) / 2 and vals[j] != g[i]:
                g2[i] = vals[j]
        g = g2
    GKEY = {tuple(np.round(p_.center[:], 5)): gg for p_, gg in zip(me.polygons, g)}
    def separate(grp, name):
        for v_ in me.vertices:
            v_.select = False
        for e_ in me.edges:
            e_.select = False
        cnt = 0
        for p_ in me.polygons:
            p_.select = GKEY.get(tuple(np.round(p_.center[:], 5))) == grp; cnt += p_.select
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = ob; ob.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.separate(type='SELECTED'); bpy.ops.object.mode_set(mode='OBJECT')
        o2 = [o for o in bpy.context.selected_objects if o is not ob][0]
        o2.name = o2.data.name = name
        print('monkey2:', name, cnt, 'faces')
        return o2
    NKEY = {tuple(np.round(v_.co[:], 5)): v_.normal.copy() for v_ in me.vertices}   # 切開前的頂點法線（切開後邊界才不會有明暗接縫）
    eyes_o = separate('Eyes', 'Monkey_Eyes')
    cloth_o = separate('Cloth', 'Monkey_Cloth')
    cream_o = separate('Cream', 'Monkey_Cream')
    neyes = len(eyes_o.data.polygons)
    for o2 in (ob, eyes_o, cloth_o, cream_o):
        m2 = o2.data
        m2.normals_split_custom_set_from_vertices([NKEY.get(tuple(np.round(v_.co[:], 5)), v_.normal) for v_ in m2.vertices])
    print('monkey2: eye faces', neyes)

    # ---- 蝴蝶結：頭帶背後中央（扣環的位置），兩個圈外側較寬，中間一個圓結（使用者給的圖）----
    loc, nor, _, _ = bvh.ray_cast(Vector((-0.03, 5, 0.41)), Vector((0, -1, 0)))
    nv = (nor + Vector((0, 1, 0))).normalized()
    up = (Vector((0, 0, 1)) - nv * nv.z).normalized(); rt = up.cross(nv).normalized()
    bow = []
    for sx in (-1, 1):
        b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=48, v_segments=24, radius=1)
        for v_ in b_.verts:
            a, bb, cc = v_.co
            wgt = 0.6 + 0.7 * (a * sx * 0.5 + 0.5)                  # 外側比較寬
            puff = 1.0 - 0.25 * abs(cc) ** 2                          # 鼓鼓的
            v_.co = loc + rt * (sx * 0.17 + a * 0.165) + up * (cc * 0.1 * wgt + 0.008) + nv * (bb * 0.06 * puff + 0.022)   # 貼近頭帶
        bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
        m_ = bpy.data.meshes.new('bw'); b_.to_mesh(m_); b_.free(); bow.append(link('bw', m_))
    b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=40, v_segments=20, radius=1)
    for v_ in b_.verts:
        a, bb, cc = v_.co
        v_.co = loc + rt * (a * 0.08) + up * (cc * 0.115 + 0.004) + nv * (bb * 0.06 + 0.045)   # 中間的結：蓋住底下的方形扣環
    bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
    m_ = bpy.data.meshes.new('bk'); b_.to_mesh(m_); b_.free(); bow.append(link('bk', m_))
    for p_ in [p for o in bow for p in o.data.polygons]:
        p_.use_smooth = True
    bowo = T.fix_out(join(bow, 'Monkey_Bow'))

    ob.name = me.name = 'Monkey_Skin'
    parts = [ob, bowo, eyes_o, cloth_o, cream_o]
    for o in parts:
        o['nocap'] = 1
    K = VF['s'] / 200 * 0.394
    off = Vector(((VF['cx'] - 650) / VF['s'] - VF['m'], 0, -zmin))
    for o in parts:
        o.data.transform(Matrix.Translation(off))
        o.data.transform(Matrix.Diagonal((K, K, K, 1)))
    print('monkey2: parts', {o.name: len(o.data.polygons) for o in parts})
    return parts
