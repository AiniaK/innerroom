# 泰迪熊：使用者提供的模型（design-source/gashapon/Model-Teddy.glb）→ 收平五官、撫平表面、依設計圖分材質、照設計圖貼縫線
# 由 build_model.py 的 build_teddy() 呼叫；回傳的零件已經換到和其他角色一樣的座標（腳底 z=0，正面朝 −y）
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

GLB = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', 'Model-Teddy.glb')
REF = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', '泰迪熊三視圖設定稿.png')

# 模型 ↔ 設計圖的對應（用輪廓重疊度擬合出來的；scratchpad/teddy/fit.py）
#   正面 px = cx + s·(x − m)，側面 px = cx + s·(y − m)，背面 px = cx + s·(−x − m)；py = g − s·(z − zmin)
VIEW = {'F': dict(s=338.0, cx=372.12, g=698.0, m=-0.02904),
        'S': dict(s=326.0, cx=881.23, g=688.0, m=-0.00606),
        'B': dict(s=338.0, cx=1407.9, g=698.0, m=0.02904)}
# 收平的程度：留下原本凸起的幾成（設計圖：腮紅幾乎平貼、眼睛是微凸的小珠、嘴是口鼻上的開口）
KEEP = {'Cheeks': 0.0, 'Eyes': 0.0, 'Mouth': 0.0, 'Nose': 0.0}   # 五官全部收平，再換上乾淨的外加零件（使用者 2026-11-23：上色要精準利落）
SIG_BIG, SIG_SMALL = 0.06, 0.022                                 # 柔化的範圍：頭和身體、薄的部位
MOVE_BIG, MOVE_SMALL = 0.035, 0.02 
LIM_OUT, LIM_OUT_S = 0.016, 0.008                                 # 往外推最多這麼多：再多就是在填交界的凹處（耳朵、脖子、手臂），不填
                               # 移動超過這麼多就不採用（那是細節，不是平面）
REMESH = 0.0065                                                   # 重新網格化的格子大小（模型高約 1.9）
NEW_EARS = False                                                  # 使用者要原本的耳朵（重建的那層拿掉）
SMOOTH = 300                                                      # 撫平的次數
FACES = 110000                                                    # 撫平後整隻減到這麼多面（再分材質）
LABELS = ['Body', 'Muzzle', 'Eyes', 'Nose', 'Mouth', 'Cheeks', 'EarIn', 'Wand', 'Star']


def _arrays(me):
    n = len(me.vertices)
    V = np.empty(n * 3); me.vertices.foreach_get('co', V)
    E = np.empty(len(me.edges) * 2, int); me.edges.foreach_get('vertices', E)
    return V.reshape(-1, 3), E.reshape(-1, 2)


def _normals(me, V):
    me.vertices.foreach_set('co', V.ravel()); me.update()
    N = np.empty(len(V) * 3); me.vertices.foreach_get('normal', N)
    return N.reshape(-1, 3)


def _avg(V, E, n):
    cnt = np.bincount(E.ravel(), minlength=n).astype(float)
    acc = np.zeros((n, V.shape[1]))
    for k in range(V.shape[1]):
        acc[:, k] = np.bincount(E[:, 0], V[E[:, 1], k], n) + np.bincount(E[:, 1], V[E[:, 0], k], n)
    return acc / np.maximum(cnt, 1)[:, None]


def _taubin(V, E, it, w, lam=0.5, mu=-0.53):
    V = V.copy()
    for _ in range(it):
        for f in (lam, mu):
            V += f * (_avg(V, E, len(V)) - V) * w[:, None]
    return V


def _load(path=None, remesh=None):
    bpy.ops.import_scene.gltf(filepath=path or GLB)
    ob = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]
    for o in list(bpy.context.selected_objects):
        if o is not ob and o.type != 'MESH':
            bpy.data.objects.remove(o)
    ob.parent = None
    ob.data.transform(ob.matrix_world); ob.matrix_world.identity()
    # 模型檔裡存了每一面自己的法線（一塊塊平面的光影），會蓋過撫平後的形狀：先清掉，改用形狀本身算出來的法線
    bpy.context.view_layer.objects.active = ob
    if ob.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for p_ in ob.data.polygons:
        p_.use_smooth = True
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.verts.ensure_lookup_table()
    seen, kill = set(), []
    for v in bm.verts:                                            # 星星旁的閃光是三個獨立的小零件：拿掉（使用者 2026-11-20）
        if v.index in seen:
            continue
        st, comp = [v], []
        seen.add(v.index)
        while st:
            x = st.pop(); comp.append(x)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen:
                    seen.add(o.index); st.append(o)
        if len(comp) < 2000:
            kill += comp
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(ob.data); bm.free()
    # 重新網格化成均勻細密的網格：原本的平面只由幾個大三角形組成，裡面沒有頂點，撫平磨不圓；換成均勻的網格後才磨得動
    rm = ob.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = remesh or REMESH; rm.adaptivity = 0
    bpy.ops.object.modifier_apply(modifier='rm')
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.quads_convert_to_tris(); bpy.ops.object.mode_set(mode='OBJECT')
    for p_ in ob.data.polygons:
        p_.use_smooth = True
    return ob


def _ref_labels(HL):
    """設計圖 → 每個像素的類別（0 背景、1 毛、2 白、3 黑、4 紅、5 粉紅、6 耳內、7 黃）"""
    A = HL.load_rgb(REF)
    r, g, b = A[..., 0], A[..., 1], A[..., 2]
    Hh, Ww = r.shape
    Yi, Xi = np.mgrid[0:Hh, 0:Ww]
    bg = (np.abs(r - 222) < 14) & (np.abs(g - 220) < 14) & (np.abs(b - 225) < 14)
    sil = ~HL.flood_bg(bg | ((r - b < 25) & (r > 150) & (Yi > 600))) & (Yi < 692)
    clean = lambda m, k=2: HL.blur2(HL.blur2(m.astype(np.float32), k) > 0.5, k + 1) > 0.35   # 毛絨紋理的雜點磨掉
    L = np.zeros((Hh, Ww), np.uint8)
    L[sil] = 1
    L[clean(sil & (r > 238) & (g > 225) & (b > 200), 3)] = 2
    L[clean(sil & (r > 245) & (g > 205) & (b > 140) & (b < 186) & (Yi < 215))] = 6
    L[clean(sil & (r > 230) & (g > 110) & (g < 178) & (b > 128), 3)] = 5
    L[clean(sil & (r > 150) & (g < 80) & (b < 80))] = 4
    L[clean(sil & (r < 95) & (g < 95) & (b < 95))] = 3
    L[clean(sil & (r > 220) & (g > 170) & (b < 90))] = 7
    return L, (r, g, b, sil, Yi, Xi)


def _project(view, P):
    v = VIEW[view]
    h = P[:, 0] if view == 'F' else (P[:, 1] if view == 'S' else -P[:, 0])
    return v['cx'] + v['s'] * (h - v['m']), v['g'] - v['s'] * (P[:, 2] - _project.zmin)


def _ray(view, px, py, mirror=False):
    """設計圖上的一點 → 射線（起點、方向），模型座標"""
    v = VIEW[view]
    h = v['m'] + (px - v['cx']) / v['s']
    z = _project.zmin + (v['g'] - py) / v['s']
    if view == 'F':
        return Vector((h, -5, z)), Vector((0, 1, 0))
    if view == 'B':
        return Vector((-h, 5, z)), Vector((0, -1, 0))
    return (Vector((-5, h, z)), Vector((1, 0, 0))) if mirror else (Vector((5, h, z)), Vector((-1, 0, 0)))


def _label_verts(me, V, N, L, bvh):
    """每個頂點從最正對它的那張設計圖讀類別；被擋住的（例如魔杖後面）不讀"""
    n = len(V)
    lab = np.ones(n, int)
    best = np.zeros(n)
    for view, d, mirror in (('F', Vector((0, 1, 0)), False), ('S', Vector((-1, 0, 0)), False), ('S', Vector((1, 0, 0)), True), ('B', Vector((0, -1, 0)), False)):
        face = -(N @ np.array(d))
        px, py = _project(view, V)
        cand = np.nonzero((face > 0.15) & (face > best))[0]
        for i in cand:
            p = Vector(V[i])
            hit = bvh.ray_cast(p - d * 3, d)
            if hit[0] is None or (hit[0] - p).length > 0.012:
                continue
            x, y = int(round(px[i])), int(round(py[i]))
            if 0 <= y < L.shape[0] and 0 <= x < L.shape[1] and L[y, x]:
                lab[i] = L[y, x]
                best[i] = face[i]
    return lab


def _smooth_labels(lab, E, n, it=3):
    for _ in range(it):
        votes = np.zeros((n, 8))
        for k in range(8):
            m = (lab == k).astype(float)
            votes[:, k] = np.bincount(E[:, 0], m[E[:, 1]], n) + np.bincount(E[:, 1], m[E[:, 0]], n) + m * 1.5
        lab = votes.argmax(1)
    return lab


def _grow(mask, E, n, rings):
    m = mask.copy()
    for _ in range(rings):
        m = m | (np.bincount(E[:, 0], m[E[:, 1]].astype(float), n) + np.bincount(E[:, 1], m[E[:, 0]].astype(float), n) > 0)
    return m


def _blur1(A, sig, h, axis):
    r = int(math.ceil(3 * sig / h))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * h / sig) ** 2); k /= k.sum()
    A = np.moveaxis(A, axis, 0)
    P = np.pad(A, ((r, r),) + ((0, 0),) * (A.ndim - 1), mode='edge')
    out = np.zeros_like(A)
    for i, w_ in enumerate(k):
        out += w_ * P[i:i + A.shape[0]]
    return np.moveaxis(out, 0, axis)


def _occupancy(bvh, lo, h, shape):
    """立體格子：每一格在不在熊身體裡面（沿 z 往上射線，穿過表面一次就進出一次）"""
    nx, ny, nz = shape
    occ = np.zeros(shape, np.float32)
    zs = lo[2] + (np.arange(nz) + 0.5) * h
    for i in range(nx):
        x = lo[0] + (i + 0.5) * h
        for j in range(ny):
            y = lo[1] + (j + 0.5) * h
            o = Vector((x, y, lo[2] - 0.05)); hits = []
            for _ in range(40):
                loc = bvh.ray_cast(o, Vector((0, 0, 1)))[0]
                if loc is None:
                    break
                hits.append(loc.z); o = Vector((x, y, loc.z + 1e-5))
            for a_, b_ in zip(hits[0::2], hits[1::2]):
                occ[i, j, (zs > a_) & (zs < b_)] = 1
    return occ


def _project_iso(V, G, lo, h):
    """把每個頂點沿梯度推到柔化後的立體範圍的 0.5 等值面上（就是圓滑後的外形）"""
    gx, gy, gz = np.gradient(G, h)
    def samp(A, P):
        f = (P - lo) / h - 0.5
        i0 = np.clip(np.floor(f).astype(int), 0, np.array(A.shape) - 2); t = np.clip(f - i0, 0, 1)
        out = 0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w_ = (t[:, 0] if dx else 1 - t[:, 0]) * (t[:, 1] if dy else 1 - t[:, 1]) * (t[:, 2] if dz else 1 - t[:, 2])
                    out = out + w_ * A[i0[:, 0] + dx, i0[:, 1] + dy, i0[:, 2] + dz]
        return out
    P = V.copy()
    for _ in range(6):
        f = samp(G, P) - 0.5
        g = np.stack([samp(gx, P), samp(gy, P), samp(gz, P)], 1)
        gg = np.maximum((g * g).sum(1), 1e-6)
        step = (f / gg)[:, None] * g
        nrm = np.linalg.norm(step, axis=1, keepdims=True)
        P -= step * np.minimum(1, 0.03 / np.maximum(nrm, 1e-9))     # 一次最多走 0.03
    return P


def fix_out(ob):
    """每一顆（相連的一塊）各自檢查：面朝內的翻過來（網頁只畫面的正面）"""
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.faces.ensure_lookup_table()
    seen = set()
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        st, comp = [f0], []
        seen.add(f0.index)
        while st:
            f = st.pop(); comp.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index); st.append(g)
        c = sum((f.calc_center_median() for f in comp), Vector()) / len(comp)
        inward = sum(1 for f in comp if (f.calc_center_median() - c).dot(f.normal) < 0)
        if inward > len(comp) / 2:
            bmesh.ops.reverse_faces(bm, faces=comp)
    bm.to_mesh(ob.data); bm.free()
    return ob


def build(HL, tube, join, link, PATHS, snap_dash):
    ob = _load()
    me = ob.data
    V, E = _arrays(me)
    _project.zmin = V[:, 2].min()
    L, _ = _ref_labels(HL)

    def bvh_of(V_):
        me.vertices.foreach_set('co', V_.ravel()); me.update()
        return BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())

    n = len(V)
    N = _normals(me, V)
    bvh = bvh_of(V)
    nb = [[] for _ in range(n)]
    for i, j in E:
        nb[i].append(j); nb[j].append(i)

    # ---- 1. 模型自己雕出來的凹凸：表面減掉平滑後的表面（再去掉大範圍的偏差）。五官四周、縫線都是一圈凹痕 ----
    def relief(V_):
        S_ = V_.copy()
        for _ in range(100):                                      # 網格變細了，平滑次數跟著加（同樣的實際範圍）
            S_ += 0.5 * (_avg(S_, E, n) - S_)
        h_ = ((V_ - S_) * _normals(me, V_)).sum(1)
        x = h_.copy()
        for _ in range(200):
            x = 0.5 * x + 0.5 * _avg(x[:, None], E, n)[:, 0]
        _normals(me, V_)
        return h_ - x
    h = relief(V)

    # ---- 2. 五官：從中心往外長，長到四周那圈凹痕為止（中心點是在正面看到的位置，scratchpad/teddy/curv_F.png）----
    def seed(px, py):
        o, d = _ray('F', px, py)
        loc = bvh.ray_cast(o, d)[0]
        return int(np.argmin(((V - np.array(loc)) ** 2).sum(1)))
    def region(s0, ok, R):
        c = V[s0]
        inside = ok & (((V - c) ** 2).sum(1) < R * R)
        out = np.zeros(n, bool)
        if not inside[s0]:
            return out
        st = [s0]; out[s0] = True
        while st:
            i = st.pop()
            for j in nb[i]:
                if inside[j] and not out[j]:
                    out[j] = True; st.append(j)
        return out
    def fill(m, R_ball, c):
        """把區域裡被包住的洞補起來（例如口鼻裡的鼻子和嘴）"""
        ball = ((V - V[c]) ** 2).sum(1) < R_ball * R_ball
        rest = ball & ~m
        lab_ = np.full(n, -1); comp = 0
        for s_ in np.nonzero(rest)[0]:
            if lab_[s_] >= 0:
                continue
            st = [s_]; lab_[s_] = comp; mem = [s_]; edge = False
            while st:
                i = st.pop()
                for j in nb[i]:
                    if not ball[j]:
                        edge = True
                    elif rest[j] and lab_[j] < 0:
                        lab_[j] = comp; st.append(j); mem.append(j)
            if not edge:
                m[mem] = True
            comp += 1
        return m
    FEAT = {}
    for k, pts, sign, thr, R in (('Eyes', [(312, 232), (428, 222)], 1, -0.0008, 0.06),   # 眼睛連四周的斜坡
                                 ('Cheeks', [(272, 272), (466, 258)], 1, 0.0, 0.11),
                                 ('Nose', [(378, 240)], 1, 0.0, 0.06),
                                 ('Mouth', [(378, 274)], -1, 0.0, 0.08),
                                 ('EarIn', [(215, 150), (447, 135)], -1, 0.0005, 0.13)):
        m = np.zeros(n, bool)
        for px, py in pts:
            s0 = seed(px, py)
            # 從中心附近最凸（或最凹）的點開始
            near = np.nonzero(((V - V[s0]) ** 2).sum(1) < (R * 0.4) ** 2)[0]
            s0 = near[np.argmax(sign * h[near])]
            m |= region(s0, sign * h > thr, R)
        FEAT[k] = m
    ms = seed(370, 292)
    near = np.nonzero(((V - V[ms]) ** 2).sum(1) < 0.04 ** 2)[0]
    ms = near[np.argmax(h[near])]
    mz = region(ms, (h > -0.0015) | FEAT['Mouth'] | FEAT['Nose'], 0.2)
    FEAT['Muzzle'] = fill(mz, 0.21, ms) & ~FEAT['Mouth'] & ~FEAT['Nose']
    for k, m in FEAT.items():
        print('teddy: feature', k, int(m.sum()))
    FPOS = {k: V[m].copy() for k, m in FEAT.items()}             # 模型本身五官的位置（收平之前），之後外加零件放在這裡
    # 交界（脖子、腋下、兩腿之間、手和身體之間）：大範圍凹進去的地方。這些地方保持原樣，轉折才利落（使用者：不要融化感）
    S_ = V.copy()
    for _ in range(400):
        S_ += 0.5 * (_avg(S_, E, n) - S_)
    hb = ((V - S_) * _normals(me, V)).sum(1)
    hb -= np.median(hb)
    JUNC = hb < -0.02
    print('teddy: junction verts', int(JUNC.sum()), np.percentile(hb, [1, 5, 50]).round(4))
    HC0 = V[V[:, 2] > 0.35].mean(0)                                # 頭的中心
    # 耳朵本身的範圍：從耳內往外長，長到和頭交界的凹痕為止
    PE = V[FEAT['EarIn']]
    ecs = [PE[PE[:, 0] < PE[:, 0].mean()].mean(0), PE[PE[:, 0] >= PE[:, 0].mean()].mean(0)]
    nearE = np.min([((V - c_) ** 2).sum(1) for c_ in ecs], 0) < 0.26 ** 2
    EAR = FEAT['EarIn'].copy()
    for _ in range(60):
        EAR = _grow(EAR, E, n, 1) & ~JUNC & nearE
    # 耳朵的外緣（不是和頭交界那一側）：用來擬合耳朵的圓
    outs = _grow(EAR, E, n, 1) & ~EAR
    rim = EAR & _grow(outs & ~_grow(JUNC, E, n, 2), E, n, 1)
    EARDATA = []
    Ne_ = _normals(me, V)
    for c_ in ecs:
        m_ = EAR & (((V - c_) ** 2).sum(1) < 0.26 ** 2)
        mi = FEAT['EarIn'] & m_
        nvv = Ne_[mi].mean(0); nvv /= np.linalg.norm(nvv)          # 耳朵正面的方向：耳內凹面的平均法線
        EARDATA.append((V[m_].copy(), V[mi].mean(0), nvv, np.nonzero(m_)[0]))

    # 魔杖和星星：從星星頂端往下長，只在舉起的手上方
    top = np.nonzero((V[:, 0] > 0.42) & (V[:, 2] > 0.9))[0]
    top = top[np.argmax(V[top, 2])]
    ws = region(top, (V[:, 2] > 0.36) & (V[:, 0] > 0.3) & (np.abs(V[:, 1] + 0.089) < 0.14), 1.0)
    dax = np.hypot(V[:, 0] - 0.50, V[:, 1] + 0.089)                # 離魔杖中心軸的距離：細棍半徑約 0.03
    star = ws & (((V[:, 2] > 0.6) & (dax > 0.042)) | (V[:, 2] > 0.7))
    stick = ws & ~star

    # ---- 3. 收平五官：把凸起換成從周圍補起來的平順曲面，再留下原本凸起的幾成 ----
    for name in ('Eyes', 'Cheeks', 'Mouth', 'Nose'):
        mask = FEAT[name]
        R = _grow(mask, E, n, 11)                                 # 連四周那圈凹痕一起（設計圖上沒有這圈）
        F_ = V.copy()
        for _ in range(1500):                                     # 邊界固定，裡面一直取鄰居平均：補出一片平順的曲面
            F_[R] = _avg(F_, E, n)[R]
        w = mask.astype(float)
        for _ in range(2):
            w = 0.5 * w + 0.5 * _avg(w[:, None], E, n)[:, 0]
        k = KEEP[name] * w                                        # 五官本身留幾成凸起，四周的凹痕整個填平
        V[R] = F_[R] + (V[R] - F_[R]) * k[R][:, None]

    # ---- 3b. 重塑：大片平面拉成圓弧（使用者 2026-11-23：用球面般的大形狀把平面修圓，五官和細節保留）----
    #  頭、身體用大範圍柔化後的外形；耳朵、手腳這種薄的部位，大範圍柔化會把它磨掉，改用小範圍柔化的外形；兩種都會動太多的地方（細節）保持原樣
    bvh = bvh_of(V)
    lo = V.min(0) - 0.1; hg = 0.008
    shape = tuple(int(x) for x in np.ceil((V.max(0) + 0.1 - lo) / hg))
    occ = _occupancy(bvh, lo, hg, shape)
    Pb = V.copy(); Ps = V.copy()
    for sig, out in ((SIG_BIG, Pb), (SIG_SMALL, Ps)):
        G = occ
        for ax in range(3):
            G = _blur1(G, sig, hg, ax)
        out[:] = _project_iso(V, G, lo, hg)
    db = np.linalg.norm(Pb - V, axis=1); ds = np.linalg.norm(Ps - V, axis=1)
    Nr = _normals(me, V)
    sb = ((Pb - V) * Nr).sum(1); ss = ((Ps - V) * Nr).sum(1)      # 往外（+）還是往內（−）
    # 動得少（只是磨平平面）才採用；往外推的上限小很多：交界的凹處（耳朵和頭、脖子、手臂）不填，轉折才利落、不會像融化
    wb = np.where(sb > 0, np.clip((LIM_OUT - sb) / (LIM_OUT * 0.5), 0, 1), np.clip((MOVE_BIG - db) / (MOVE_BIG * 0.5), 0, 1))
    ws = np.where(ss > 0, np.clip((LIM_OUT_S - ss) / (LIM_OUT_S * 0.5), 0, 1), np.clip((MOVE_SMALL - ds) / (MOVE_SMALL * 0.5), 0, 1))
    for _ in range(20):                                           # 權重抹勻，交界才不會有台階
        wb = 0.5 * wb + 0.5 * _avg(wb[:, None], E, n)[:, 0]
        ws = 0.5 * ws + 0.5 * _avg(ws[:, None], E, n)[:, 0]
    prot = np.zeros(n, bool)
    for k in ('EarIn',):                                          # 五官已收平（之後換成外加零件），只保護耳內
        prot |= FEAT[k]
    prot = _grow(prot | stick | star | JUNC, E, n, 3)
    pw = prot.astype(float)
    for _ in range(25):                                           # 保護的邊界慢慢過渡
        pw = 0.5 * pw + 0.5 * _avg(pw[:, None], E, n)[:, 0]
    pw = np.clip(pw * 2.2, 0, 1)
    tgt = V + wb[:, None] * (Pb - V) + ((1 - wb) * ws)[:, None] * (Ps - V)
    V = V + (1 - np.clip(pw, 0, 1))[:, None] * (tgt - V)
    print('teddy: reshape grid', shape, 'big moves', np.percentile(db, [50, 90, 99]).round(4), 'used big', round(float((wb > 0.5).mean()), 3))

    # ---- 4. 撫平：整隻做不縮水的平滑，把一塊塊的平面磨圓；魔杖、星星、鼻子保持原樣 ----
    w = np.ones(n)
    w[stick | star] = 0
    w[_grow(JUNC, E, n, 2)] = 0.5                                 # 交界：磨掉皺褶（不縮水的平滑不會把轉折磨圓）
    face = FEAT['EarIn'].copy()
    face = _grow(face, E, n, 6)
    w[face] = 0                                                   # 五官、耳內保持原形（周圍漸進過渡）                           # 五官四周磨輕一點，形狀才不會糊掉
    for _ in range(12):
        w = np.minimum(w, _avg(w[:, None], E, n)[:, 0] + 0.09)
    V = _taubin(V, E, SMOOTH, w, 0.5, -0.505)                     # 通過帶設窄一點：大範圍的起伏也磨平，整體大小不變
    # 交界帶（脖子、腋下、手和身體之間、兩腿之間）：磨掉原始模型的凹凸起伏，保留大的轉折（使用者：交界要順暢）
    jw = _grow(JUNC, E, n, 5).astype(float)
    for _ in range(8):
        jw = 0.5 * jw + 0.5 * _avg(jw[:, None], E, n)[:, 0]
    jw = np.clip(jw * 1.5, 0, 1); jw[stick | star] = 0
    V = _taubin(V, E, 300, jw, 0.5, -0.505)
    # 吻部再磨圓一點（使用者：從不同角度看有點凹凸不平）
    mzw = _grow(FEAT['Muzzle'] | FEAT['Mouth'] | FEAT['Nose'], E, n, 4).astype(float)
    for _ in range(10):
        mzw = 0.5 * mzw + 0.5 * _avg(mzw[:, None], E, n)[:, 0]
    V = _taubin(V, E, 400, np.clip(mzw * 1.3, 0, 1), 0.5, -0.505)
    # 耳朵輪廓歪扭（原始模型）：耳朵一帶再多磨幾次
    ear = _grow(FEAT['EarIn'], E, n, 30)
    we = ear.astype(float)
    for _ in range(15):
        we = 0.5 * we + 0.5 * _avg(we[:, None], E, n)[:, 0]
    V = _taubin(V, E, 200, np.clip(we * 1.5, 0, 1) * 0.8, 0.5, -0.505)
    # 腳底壓平
    z0 = V[:, 2].min(); Nf = _normals(me, V)
    zc = z0 + 0.018                                               # 用水平面切平腳底：腳底是平面，邊緣利落
    sole = V[:, 2] < zc
    V[sole, 2] = zc
    for _ in range(4):                                            # 腳底邊緣的毛邊：磨順再切平，重複幾次
        fw_ = np.clip((zc + 0.06 - V[:, 2]) / 0.03, 0, 1)
        V = _taubin(V, E, 40, fw_, 0.5, -0.505)
        V[V[:, 2] < zc, 2] = zc
    print('teddy: sole verts', int(sole.sum()))
    h = relief(V)                                                 # 撫平後的凹槽（縫線要吸附上去）
    V0, h0 = V.copy(), h.copy()
    name0 = np.array(['Body'] * n, object)
    name0[stick] = 'Wand'; name0[star] = 'Star'
    dlo = np.hypot(V[:, 0] - (0.526 + (V[:, 2] + 0.05) * (0.493 - 0.526) / 0.68), V[:, 1] + 0.089)
    name0[(dlo < 0.04) & (V[:, 2] < 0.1)] = 'Wand'
    EAR0 = EAR.copy()                # 拳頭下方露出的那一截魔杖
    me.vertices.foreach_set('co', V.ravel()); me.update()
    from mathutils.kdtree import KDTree
    kd0 = KDTree(n)
    for i, p in enumerate(V0):
        kd0.insert(p, i)
    kd0.balance()

    # ---- 5. 減面（整隻一起減，接縫才不會裂開）；每個新頂點沿用最近的原頂點的材質 ----
    # 撫平後的曲面是圓的，均勻減面不會再變回平面（之前的平面是原始模型本身的，見上面重新網格化）
    md = ob.modifiers.new('dc', 'DECIMATE'); md.ratio = min(1.0, FACES / len(me.polygons))
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier='dc')
    V, E = _arrays(me)
    n = len(V)
    bvh = bvh_of(V)
    nn_ = [kd0.find(p)[1] for p in V]
    name_of = np.array([name0[i] for i in nn_], object)

    # ---- 5b. 顏色交界：每種材質的範圍先抹成 0..1 的平滑值，沿 0.5 那條線把網格切開（交界是平順的曲線，不是三角形的鋸齒）----
    # 口鼻部（白色）：模型本身圓潤隆起的口鼻部直接塗白，邊界是乾淨的橢圓（使用者：外加的厚片接得不順、形狀方）
    def fits(k, split):
        P_ = FPOS[k]
        groups = [P_[P_[:, 0] < P_[:, 0].mean()], P_[P_[:, 0] >= P_[:, 0].mean()]] if split else [P_]
        return [dict(cx=g[:, 0].mean(), cz=g[:, 2].mean(), rx=2 * g[:, 0].std(), rz=2 * g[:, 2].std()) for g in groups if len(g) > 5]
    muz_m = fits('Muzzle', False)[0]
    mp0, mn0, _, _ = bvh.ray_cast(Vector((muz_m['cx'], -5, muz_m['cz'])), Vector((0, 1, 0)))
    mdv = (mn0 * 0.6 + Vector((0, -1, 0)) * 0.4).normalized()
    mup = (Vector((0, 0, 1)) - mdv * mdv.z).normalized(); mright = mup.cross(mdv).normalized()
    Nd = _normals(me, V)
    rel = V - np.array(mp0)
    uu, vv = rel @ np.array(mright), rel @ np.array(mup)
    ell = (uu / (muz_m['rx'] * 1.02)) ** 2 + (vv / (muz_m['rz'] * 0.98)) ** 2
    facing = np.clip((rel @ np.array(mdv) + 0.10) / 0.04, 0, 1)    # 只看前後距離（平滑漸變），不用面的朝向（會在側面切出鋸齒）
    CUSTOM = {'Muzzle': np.clip(0.5 + 1.5 * (1 - ell), 0, 1) * facing}
    # 耳內：耳朵中央的圓（耳朵內面的平面上）和耳朵本身的範圍取交集，直接塗色（交界沿平順的曲線切開）
    earf = np.array([float(EAR0[i]) for i in nn_])
    for _ in range(4):
        earf = 0.5 * earf + 0.5 * _avg(earf[:, None], E, n)[:, 0]
    fe = np.zeros(n)
    P_ = FPOS['EarIn']
    for g in (P_[P_[:, 0] < P_[:, 0].mean()], P_[P_[:, 0] >= P_[:, 0].mean()]):
        c = g.mean(0); U, S2, Wt = np.linalg.svd(g - c, full_matrices=False)
        nv = Wt[2] if Wt[2][1] < 0 else -Wt[2]
        sd = (g - c) @ Wt[:2].T
        R_ = (2 * sd[:, 0].std() + 2 * sd[:, 1].std()) / 2 * 0.95
        rel_ = V - c
        inpl = rel_ - np.outer(rel_ @ nv, nv)
        e_ = (inpl ** 2).sum(1) / R_ ** 2
        ok_ = (Nd @ nv > 0.2) & (np.abs(rel_ @ nv) < 0.08)
        fe = np.maximum(fe, np.where(ok_, np.clip(0.5 + 1.5 * (1 - e_), 0, 1), 0))
    # 耳內：原本耳朵上塗一個半圓（圓弧朝外、平邊朝頭），邊界是乾淨的圓弧和直線
    fe = np.zeros(n)
    for allp, cin, nvv, eidx in EARDATA:
        nv_ = np.array(nvv); c_ = np.array(cin)
        rel_ = V - c_; qd = rel_ @ nv_
        inpl = rel_ - np.outer(qd, nv_)
        hd = np.array(HC0) - c_; hd = hd - nv_ * (hd @ nv_); hd /= np.linalg.norm(hd)
        R_ = 0.135
        disc = np.clip(0.5 + (R_ - np.linalg.norm(inpl - (-hd) * 0.02, axis=1)) * 120, 0, 1)
        half = np.clip(0.5 + (-(inpl @ hd) + 0.03) * 120, 0, 1)    # 偏向頭那一側切掉：平邊
        near = np.clip((0.05 - np.abs(qd)) / 0.02, 0, 1)
        fe = np.maximum(fe, np.minimum(disc, half) * near)
    CUSTOM['EarIn'] = fe
    ORDER = ['Muzzle', 'EarIn', 'Star', 'Wand']
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    lay = {}
    for k in ORDER:
        if k not in CUSTOM and not (name_of == k).any():
            continue
        L_ = bm.verts.layers.float.new('f_' + k); lay[k] = L_
        f = CUSTOM[k] if k in CUSTOM else (name_of == k).astype(float)
        for _ in range(0):
            f = 0.5 * f + 0.5 * _avg(f[:, None], E, n)[:, 0]
        for v_ in bm.verts:
            v_[L_] = f[v_.index]
    for k, L_ in lay.items():
        cut = []
        for e in list(bm.edges):
            a_, b_ = e.verts
            fa, fb = a_[L_] - 0.5, b_[L_] - 0.5
            if fa * fb < 0:
                t_ = fa / (fa - fb)
                vals = {kk: a_[LL] + (b_[LL] - a_[LL]) * t_ for kk, LL in lay.items()}
                ne, nv = bmesh.utils.edge_split(e, a_, t_)
                for kk, LL in lay.items():
                    nv[LL] = vals[kk]
                nv[L_] = 0.5
                cut.append(nv)
        cutset = set(cut)
        for fc in list({f_ for v_ in cut for f_ in v_.link_faces}):
            on = [v_ for v_ in fc.verts if v_ in cutset]
            if len(on) == 2 and not any(e.other_vert(on[0]) is on[1] for e in on[0].link_edges):
                bmesh.ops.connect_verts(bm, verts=on)
    bmesh.ops.triangulate(bm, faces=[f_ for f_ in bm.faces if len(f_.verts) > 3])
    fname = []
    for fc in bm.faces:
        nm = 'Body'
        for k in ORDER:
            if k in lay and sum(v_[lay[k]] for v_ in fc.verts) / len(fc.verts) > 0.5:
                nm = k; break
        fname.append(nm)
    bm.to_mesh(me); bm.free()
    V, E = _arrays(me)
    n = len(V)
    bvh = bvh_of(V)

    # ---- 5c. 五官：乾淨的外加零件（像扭蛋公仔的塗裝與小零件），大小、位置都照設計圖正面量 ----
    VF = VIEW['F']
    X = lambda px: VF['m'] + (px - VF['cx']) / VF['s']
    Z = lambda py: _project.zmin + (VF['g'] - py) / VF['s']
    Hh, Ww = L.shape
    Yi, Xi = np.mgrid[0:Hh, 0:Ww]
    frontm = Xi < 640
    def boxes(mask, minpx=40):
        out = []
        for c in HL.components(mask & frontm, minpx, 10 ** 7):
            y0, y1, x0, x1 = c[:, 0].min(), c[:, 0].max(), c[:, 1].min(), c[:, 1].max()
            out.append(dict(n=len(c), cx=(x0 + x1) / 2, cy=(y0 + y1) / 2, rx=(x1 - x0 + 1) / 2, ry=(y1 - y0 + 1) / 2, top=y0))
        return sorted(out, key=lambda d: -d['n'])
    blk = boxes(L == 3)
    nose_b = [d for d in blk if d['cy'] > 262 and 340 < d['cx'] < 460][:1]
    eyes_b = [d for d in blk if d['cy'] < 285 and d not in nose_b][:2]
    cheek_b = boxes(L == 5)[:2]
    mouth_b = boxes(L == 4)[:1]
    nearc = lambda x, y, r: (Xi - x) ** 2 + (Yi - y) ** 2 < r * r
    ear_b = [boxes((L == 6) & nearc(x, y, 48))[0] for x, y in ((212, 162), (430, 140))]   # 只在兩耳附近找（額頭的反光顏色也很像）
    muz_b = boxes((L == 2) | (L == 4) | ((L == 3) & (Yi > 262)))
    muz_b = [d for d in muz_b if 340 < d['cx'] < 470 and d['cy'] > 270][:1]
    print('teddy: design parts', {k: [(round(d['cx']), round(d['cy']), round(d['rx']), round(d['ry'])) for d in v] for k, v in
                                  dict(eyes=eyes_b, nose=nose_b, cheeks=cheek_b, mouth=mouth_b, ears=ear_b, muzzle=muz_b).items()})
    dg = bpy.context.evaluated_depsgraph_get()

    def decal(name, d, lift, thick, onto, dshape=False, NR=10, NS=72, frame=None, rot=0.0, clip=None):
        """正面看是乾淨的橢圓（或 D 字形）的一片，貼合在 onto 的表面上，邊緣有一圈厚度（像外加的布片）"""
        cx, cz, rx, rz = d['cx'], d['cz'], d['rx'], d['rz']
        # 沿著貼片所在位置的表面方向投影（斜面上也是正圓，不會被拉長）
        if frame:                                                 # 指定的平面（耳朵內凹那塊所在的平面）
            p0, dv, right, up = frame
        else:
            p0, n0, _, _ = onto.ray_cast(Vector((cx, -5, cz)), Vector((0, 1, 0)))
            dv = (n0 * 0.75 + Vector((0, -1, 0)) * 0.25).normalized()
            up = (Vector((0, 0, 1)) - dv * dv.z).normalized(); right = up.cross(dv).normalized()
        if dshape:                                                # D：上緣平、下緣圓（u、v 是貼片平面上的座標，相對 p0）
            vt = d['top'] - cz; H = 2 * rz
            bnd = [(rx * math.cos(t), vt + H * math.sin(t)) for t in np.linspace(math.pi, 2 * math.pi, NS // 2 + 1)]
            bnd += [(rx - 2 * rx * f, vt) for f in np.linspace(0, 1, NS // 2 + 1)[1:-1]]
            c0 = (0.0, vt - 0.45 * H)
        else:
            bnd = [(rx * math.cos(t), rz * math.sin(t)) for t in np.linspace(0, 2 * math.pi, NS, endpoint=False)]
            c0 = (0.0, 0.0)
        if rot:                                                   # 整個形狀在貼片平面上轉一個角度
            cr, sr = math.cos(rot), math.sin(rot)
            R2 = lambda u, v: (u * cr - v * sr, u * sr + v * cr)
            bnd = [R2(u, v) for u, v in bnd]; c0 = R2(*c0)
        bm_ = bmesh.new()
        def place(u, v, off):
            q = p0 + right * u + up * v
            loc, nor, fi_, _ = onto.ray_cast(q + dv * 0.3, -dv)
            if loc is None:
                return None
            if clip is not None and not EARF[fi_]:               # 打到耳朵以外（被頭擋住的部分）：不要
                return None
            return bm_.verts.new(loc + nor * off)
        rings = []
        for r in np.linspace(0, 1, NR + 1)[1:]:
            ring = []
            for bx, bz in bnd:
                ring.append(place(c0[0] + (bx - c0[0]) * r, c0[1] + (bz - c0[1]) * r, lift))
            rings.append(ring)
        cen = place(c0[0], c0[1], lift)
        wall = [place(bx, bz, lift - thick) for bx, bz in bnd]
        m_ = len(bnd)
        def face(vs):
            if all(v is not None for v in vs) and len(set(vs)) == len(vs):
                f_ = bm_.faces.new(vs)
                f_.normal_update()
                if f_.normal.dot(dv) < 0:                         # 朝外
                    f_.normal_flip()
        for i in range(m_):
            j = (i + 1) % m_
            face((cen, rings[0][i], rings[0][j]))
            for a_, b_ in zip(rings, rings[1:]):
                face((a_[i], b_[i], b_[j], a_[j]))
            if thick > 0:
                face((rings[-1][i], wall[i], wall[j], rings[-1][j]))
        me_ = bpy.data.meshes.new(name); bm_.to_mesh(me_); bm_.free()
        for p_ in me_.polygons:
            p_.use_smooth = True
        o_ = link(name, me_)
        return o_

    def bead(name, d, depth, onto, tri=False):
        """亮面小珠：正面看是正圓（鼻子是圓角倒三角），一部分埋進臉裡"""
        cx, cz, rx, rz = d['cx'], d['cz'], d['rx'], d['rz']
        loc, nor, _, _ = onto.ray_cast(Vector((cx, -5, cz)), Vector((0, 1, 0)))
        nor = (nor + Vector((0, -1, 0))).normalized()             # 朝向介於表面法線和正前方之間（正面看才是圓的）
        up = (Vector((0, 0, 1)) - nor * nor.z).normalized(); right = up.cross(nor).normalized()
        bm_ = bmesh.new()
        bmesh.ops.create_uvsphere(bm_, u_segments=40, v_segments=24, radius=1)
        for v_ in bm_.verts:
            a_, b_, c_ = v_.co.x, v_.co.y, v_.co.z
            if tri:
                a_ *= 0.74 + 0.26 * c_                            # 上寬下窄
            v_.co = loc + right * (a_ * rx) + up * (c_ * rz) + nor * (b_ * depth + depth * 0.25)
        bmesh.ops.recalc_face_normals(bm_, faces=bm_.faces)      # 變形後面的方向可能反了（網頁只畫正面）：重新朝外
        me_ = bpy.data.meshes.new(name); bm_.to_mesh(me_); bm_.free()
        for p_ in me_.polygons:
            p_.use_smooth = True
        return link(name, me_)

    # 位置跟著模型本身的五官（設計圖正面其實略偏斜角，直接套位置會錯開）；形狀是乾淨的圓、橢圓、D 字形；大小參考設計圖
    S_ = VF['s']
    dsz = lambda d: (d['rx'] / S_, d['ry'] / S_)
    eye_r = np.mean([dsz(d) for d in eyes_b], 0)
    eyes_m = [dict(e, rx=eye_r[0], rz=eye_r[1]) for e in fits('Eyes', True)]
    nose_m = [dict(e, rx=dsz(nose_b[0])[0], rz=dsz(nose_b[0])[1]) for e in fits('Nose', False)]
    ck_r = dsz(cheek_b[0])
    cheeks_m = [dict(e, rx=ck_r[0], rz=ck_r[1]) for e in fits('Cheeks', True)]
    MW_ = 2 * muz_m['rx']
    mo = fits('Mouth', False)[0]
    nz = nose_m[0]['cz'] - nose_m[0]['rz'] - 0.012                 # 嘴的上緣緊貼在鼻子下方
    mouth_m = dict(cx=mo['cx'], cz=nz - 0.12 * MW_, rx=0.19 * MW_, rz=0.12 * MW_, top=nz)   # 寬約口鼻部的 38%（設計圖）
    ears_m = [dict(e, rx=e['rx'] * 0.85, rz=e['rz'] * 0.85) for e in fits('EarIn', True)]   # 只蓋住凹面，不蓋到耳緣
    print('teddy: parts at', {k: [(round(d['cx'], 3), round(d['cz'], 3), round(d['rx'], 3), round(d['rz'], 3)) for d in v] for k, v in
                              dict(eyes=eyes_m, nose=nose_m, cheeks=cheeks_m, muzzle=[muz_m], mouth=[mouth_m], ears=ears_m).items()})
    HC = V[V[:, 2] > 0.35].mean(0)                                 # 頭的中心
    face_parts = []
    face_parts.append(decal('Bear_Mouth', mouth_m, 0.0018, 0.004, bvh, dshape=True))
    face_parts.append(join([decal('ck', d, 0.0016, 0.004, bvh) for d in cheeks_m], 'Bear_Cheeks'))
    face_parts.append(fix_out(join([bead('ey', d, d['rx'] * 0.55, bvh) for d in eyes_m], 'Bear_Eyes')))
    face_parts.append(bead('Bear_Nose', nose_m[0], nose_m[0]['rx'] * 0.6, bvh, tri=True))
    # 耳朵：照模型耳朵的位置、大小、方向重建一對乾淨的耳朵（圓盤、正面微凹），蓋住原本歪扭的耳朵；
    #       耳內是凹面上一片同心圓，下半埋進頭裡被遮住，看起來就是設計圖上的半圓；耳朵和頭的交界是一條利落的線
    ears, eins = [], []
    EAR_R = 0.2                                                   # 兩耳一樣大（取兩耳量到的較大值，蓋得住原本的耳朵）
    EARV = np.array([EAR0[kd0.find(Vector(p))[1]] for p in V])
    for allp, cin, nvv, eidx in (EARDATA if NEW_EARS else []):
        c = cin
        nv = Vector(nvv).normalized()                                       # 朝前
        a1 = (Vector((1, 0, 0)) - nv * nv.x).normalized(); a2 = nv.cross(a1).normalized()
        A1, A2 = np.array(a1), np.array(a2)
        qa = np.stack([(allp - c) @ A1, (allp - c) @ A2], 1)
        hc_ = np.array(HC) - c; hq = np.array([hc_ @ A1, hc_ @ A2]); hq /= np.linalg.norm(hq)
        ang_ = np.arctan2(qa[:, 1], qa[:, 0]); rr_ = np.hypot(qa[:, 0], qa[:, 1])
        q = []
        for b0 in np.linspace(-math.pi, math.pi, 48, endpoint=False):   # 各方向最外緣的點，只取朝頭以外的方向
            sel = (ang_ >= b0) & (ang_ < b0 + 2 * math.pi / 48)
            dirb = np.array([math.cos(b0 + math.pi / 48), math.sin(b0 + math.pi / 48)])
            if sel.any() and dirb @ hq < 0.1:
                q.append(qa[sel][np.argmax(rr_[sel])])
        q = np.array(q)
        M_ = np.c_[2 * q, np.ones(len(q))]; sol = np.linalg.lstsq(M_, (q ** 2).sum(1), rcond=None)[0]
        cu, cv = sol[0], sol[1]; R = max(EAR_R, math.sqrt(max(1e-6, sol[2] + cu * cu + cv * cv)) * 1.03)
        dep = (allp - c) @ np.array(nv)
        T = 0.45 * R                                                       # 厚度：約半徑的 45%（量到的會連到頭）
        cen = Vector(c) + a1 * cu + a2 * cv + nv * (np.percentile(dep, 97) - T / 2)   # 正面對齊原本耳朵的最前緣
        D = 0.1 * R                                                        # 正面微凹
        dish = lambda rho: D * max(0.0, 1 - (rho / (0.78 * R)) ** 2) ** 1.5
        eb = bmesh.new(); bmesh.ops.create_uvsphere(eb, u_segments=64, v_segments=32, radius=1)
        for v_ in eb.verts:
            x, y, z = v_.co
            rho = math.hypot(x, y) * R
            zz = z * T / 2
            if z > 0:
                zz -= dish(rho)
            v_.co = cen + a1 * (x * R) + a2 * (y * R) + nv * zz
        bmesh.ops.recalc_face_normals(eb, faces=eb.faces)
        em = bpy.data.meshes.new('ear'); eb.to_mesh(em); eb.free()
        for p_ in em.polygons:
            p_.use_smooth = True
        ears.append(link('ear', em))
        # 耳內：凹面上的同心圓（貼著凹面、略浮起）
        RI = 0.66 * R; ib = bmesh.new(); rings_ = []
        hd_ = Vector(HC) - cen; hd_ -= nv * hd_.dot(nv); hd_.normalize()
        ou, ov = 0.38 * R * hd_.dot(a1), 0.38 * R * hd_.dot(a2)   # 往頭的方向移：下半被頭擋住，看起來是半圓（設計圖）
        surf = lambda u, v: cen + a1 * u + a2 * v + nv * (T / 2 * math.sqrt(max(0, 1 - (math.hypot(u, v) / R) ** 2)) - dish(math.hypot(u, v)) + 0.0015)
        for r in np.linspace(0, 1, 13)[1:]:
            ring = []
            for t in np.linspace(0, 2 * math.pi, 96, endpoint=False):
                rho = r * RI
                ring.append(ib.verts.new(surf(ou + rho * math.cos(t), ov + rho * math.sin(t))))
            rings_.append(ring)
        cv_ = ib.verts.new(surf(ou, ov))
        for i in range(96):
            j = (i + 1) % 96
            ib.faces.new((cv_, rings_[0][i], rings_[0][j]))
            for ra, rb in zip(rings_, rings_[1:]):
                ib.faces.new((ra[i], rb[i], rb[j], ra[j]))
        for f_ in ib.faces:
            f_.normal_update()
            if f_.normal.dot(nv) < 0:
                f_.normal_flip()
        im = bpy.data.meshes.new('ein'); ib.to_mesh(im); ib.free()
        for p_ in im.polygons:
            p_.use_smooth = True
        eins.append(link('ein', im))
        print('teddy: ear R', round(R, 3), 'T', round(float(T), 3))
        # 原本的耳朵收進新耳朵裡（藏起來）
        relA = V - np.array(cen); dnA = relA @ np.array(nv)
        inpA = relA - np.outer(dnA, np.array(nv))
        EM = EARV & (np.linalg.norm(inpA, axis=1) < R * 1.25) & (dnA > -T * 1.0)   # 真正屬於耳朵的點（頭後方的不算）
        wv = np.zeros(len(V))                                     # 從耳朵邊緣往內數第幾圈：邊緣不動、往內漸漸收（才不會撕裂）
        for i_ in range(1, 5):
            wv += (EM & ~_grow(~EM, E, len(V), i_)).astype(float) / 4
        tgt_ = np.array(cen) + inpA * 0.55 + np.outer(np.clip(dnA, -T * 0.3, T * 0.3), np.array(nv))
        V = V + wv[:, None] * (tgt_ - V)
        me.vertices.foreach_set('co', V.ravel()); me.update()
    bvh = bvh_of(V)                                               # 原本的耳朵收進去了：縫線要射到新的表面
    if NEW_EARS:
        face_parts.append(join(ears, 'Bear_Ears'))
        face_parts.append(join(eins, 'Bear_EarIn'))
    for o_ in face_parts:
        o_['nocap'] = 1
    # 魔杖：一根乾淨的圓柱，從星星穿過拳頭，下端露出拳頭下方（手的顏色不會蓋到魔杖）
    wand_tube = tube('Bear_WandTube', [Vector((0.525, -0.089, -0.03)), Vector((0.493, -0.089, 0.63))], 0.034, seg=24)
    eb = bmesh.new(); bmesh.ops.create_uvsphere(eb, u_segments=24, v_segments=12, radius=0.034)
    for v_ in eb.verts:
        v_.co += Vector((0.525, -0.089, -0.03))
    em = bpy.data.meshes.new('we'); eb.to_mesh(em); eb.free()
    for p_ in em.polygons:
        p_.use_smooth = True
    wand_tube = join([wand_tube, link('we', em)], 'Bear_WandTube')  # 下端圓頭
    face_parts.append(wand_tube)

    # ---- 6. 縫線（使用者 2026-11-23 的描述）：平貼、不凸起（像秤秤的刻度），每段是圓角矩形，顏色淡一點 ----
    #  1 中線一圈：頭頂→鼻子（不畫在白色吻部）→身體正中→胯下→背部正中（不蓋過尾巴）→後腦勺→頭頂
    #  2 肚子：脖子左邊往下繞到下腹，再繞回脖子右邊    3 垂下的手：肩膀沿手臂前上方到手掌前側，接回貼近身體處（不畫到身體上）
    #  4 拿魔杖的手：沿肩膀到魔杖；從腋下到魔杖        5 雙腿正面：大腿外側根部→腳掌前緣→大腿內前側→腿根
    #  6 背部：後頸左邊往下繞到臀部，再繞回後頸右邊    7 雙腿背面：臀部垂直到腳底
    DL, GP, HW, LIFT_S = 0.033, 0.022, 0.0058, 0.0012
    ob_, od_ = _ray('B', 1424, 522)
    th_ = bvh.ray_cast(ob_, od_)[0]
    TR_ = 38 / VIEW['B']['s']
    tail_c = Vector((th_.x, th_.y - TR_ * 0.45, th_.z))
    def excluded(p):
        rel = np.array(p) - np.array(mp0)
        u_, v_ = rel @ np.array(mright), rel @ np.array(mup)
        if (u_ / muz_m['rx']) ** 2 + (v_ / muz_m['rz']) ** 2 < 1.6 and rel @ np.array(mdv) > -0.14:
            return True                                           # 白色吻部
        return (p - tail_c).length < TR_ * 1.25                   # 尾巴
    sb_ = bmesh.new()
    nd = [0]
    def dashes(pts, nrm):
        if len(pts) < 4:
            return
        Ls = [0.0]
        for i in range(1, len(pts)):
            Ls.append(Ls[-1] + (pts[i] - pts[i - 1]).length)
        def at(sv):
            j = max(1, min(len(Ls) - 1, int(np.searchsorted(Ls, sv))))
            t_ = (sv - Ls[j - 1]) / max(1e-9, Ls[j] - Ls[j - 1])
            return pts[j - 1].lerp(pts[j], t_), nrm[j - 1].lerp(nrm[j], t_).normalized()
        s0 = GP / 2
        while s0 + DL <= Ls[-1]:
            K = 9
            smp = [at(s0 + DL * k / (K - 1)) for k in range(K)]
            ok = (smp[-1][0] - smp[0][0]).length < DL * 1.6 and not any(excluded(p) for p, _ in smp)
            if ok:
                vs = []
                rc = HW * 0.6                                     # 圓角
                for k, (p, nn) in enumerate(smp):
                    a_ = smp[max(0, k - 1)][0]; b_ = smp[min(K - 1, k + 1)][0]
                    tg = (b_ - a_).normalized(); lat = nn.cross(tg).normalized()
                    d_end = min(k, K - 1 - k) / (K - 1) * DL
                    hw = HW if d_end >= rc else HW - rc + math.sqrt(max(0.0, rc * rc - (rc - d_end) ** 2))
                    hw = max(hw, HW * 0.25)
                    base = p + nn * LIFT_S
                    vs.append((sb_.verts.new(base - lat * hw), sb_.verts.new(base + lat * hw), nn))
                for (l0, r0, n0_), (l1, r1, _) in zip(vs, vs[1:]):
                    f_ = sb_.faces.new((l0, r0, r1, l1)); f_.normal_update()
                    if f_.normal.dot(n0_) < 0:
                        f_.normal_flip()
                nd[0] += 1
            s0 += DL + GP
    # 1. 中線一圈：沿著熊自己的中線（頭有偏，不能只用一個直立平面）。關鍵點依序：頭頂 → 鼻子 → 下巴 → 肚子 → 胯下 → 背 → 後頸 → 後腦勺 → 頭頂；
    #    頭的那幾段從頭的中心往外打光線取表面點，身體那幾段從身體中心打
    HCv = Vector(HC0)
    BCa = V[(V[:, 2] > -0.55) & (V[:, 2] < 0.05) & (np.abs(V[:, 0]) < 0.45)].mean(0); BCv = Vector(BCa)
    def surf_from(c, d):
        hit = bvh.ray_cast(c, d.normalized())[0]
        return hit
    nose_p = bvh.ray_cast(Vector((nose_m[0]['cx'], -5, nose_m[0]['cz'])), Vector((0, 1, 0)))[0]
    top_p = surf_from(HCv, Vector((0, 0, 1)) + (nose_p - HCv).normalized() * 0.15)
    crotch = bvh.ray_cast(Vector((BCv.x, BCv.y, -5)), Vector((0, 0, 1)))[0]
    def head_dir(p):
        return (p - HCv).normalized()
    keys = [('H', top_p), ('H', nose_p), ('B', surf_from(BCv, Vector((0, -1, 0.35)))), ('B', surf_from(BCv, Vector((0, -1, -0.2)))),
            ('B', crotch), ('B', surf_from(BCv, Vector((0, 1, -0.2)))), ('B', surf_from(BCv, Vector((0, 1, 0.45)))),
            ('H', surf_from(HCv, Vector((0, 1, -0.1)))), ('H', top_p)]
    loop_pts, loop_n = [], []
    for (va, pa), (vb, pb) in zip(keys, keys[1:]):
        c = HCv if (va == 'H' and vb == 'H') else BCv if (va == 'B' and vb == 'B') else (HCv + BCv) / 2
        da, db = (pa - c).normalized(), (pb - c).normalized()
        for t in np.linspace(0, 1, 40, endpoint=False):
            d = da.slerp(db, t) if da.dot(db) > -0.999 else da.lerp(db, t)
            hit = bvh.ray_cast(c, d)
            if hit[0] is not None:
                loop_pts.append(hit[0]); loop_n.append(hit[1].normalized())
    print('teddy: midline keys', [tuple(round(x, 2) for x in p) for _, p in keys])
    dashes(loop_pts, loop_n)
    # 2–7：設計圖上的走向（正面、背面），射到表面，吸附到模型雕出來的縫線凹槽
    F_, B_ = PATHS['F'], PATHS['B']
    jobs = [('F', F_[4]), ('F', F_[5]),
            ('F', [(463, 360), (490, 333), (520, 310), (547, 297)]),                       # 拿魔杖的手：沿肩膀到魔杖
            ('F', [(442, 378), (477, 423), (523, 407), (550, 390)]),                       # 從腋下到魔杖
            ('F', [(246, 562), (248, 620), (256, 656), (300, 663), (340, 659), (346, 625), (350, 598)]),   # 右腿（圖左）
            ('F', [(480, 562), (475, 620), (470, 656), (445, 661), (415, 660), (412, 625), (410, 598)]),   # 左腿（圖右）
            ('B', B_[3]), ('B', B_[6]), ('B', B_[7])]
    for view, pth in jobs:
        cv = snap_dash(pth)[::2]
        pts, nrm = [], []
        for y, x in cv:
            o, d = _ray(view, x, y)
            loc, nor, fi, _ = bvh.ray_cast(o, d)
            if loc is None or nor.dot(d) > -0.2:
                continue
            cand = kd0.find_range(loc, 0.02)
            if cand:
                hs = np.array([h0[c[1]] for c in cand])
                if hs.min() < -0.0015:
                    loc, nor, _, _ = bvh.find_nearest(loc.lerp(cand[int(np.argmin(hs))][0], 0.7))
            pts.append(loc); nrm.append(nor.normalized())
        n0d = nd[0]
        dashes(pts, nrm)
        print('teddy: seam job', view, len(cv), 'hits', len(pts), 'dashes', nd[0] - n0d)
    sm_ = bpy.data.meshes.new('Bear_Seams'); sb_.to_mesh(sm_); sb_.free()
    for p_ in sm_.polygons:
        p_.use_smooth = True
    seams = link('Bear_Seams', sm_); seams['nocap'] = 1
    st = [None] * nd[0]
    print('teddy: seams', nd[0])
    # 腳底肉球（使用者給的圖樣）：大圓一個、小圓四個，腳趾朝前
    zs = V[:, 2].min()
    solev = V[V[:, 2] < zs + 1e-4]
    pads = bmesh.new()
    PAT = [(372, 415, 174), (142, 218, 57), (291, 132, 57), (454, 132, 57), (602, 218, 57)]
    xmid = solev[:, 0].mean()
    for fm in (solev[solev[:, 0] < xmid], solev[solev[:, 0] >= xmid]):
        if len(fm) < 10:
            continue
        fx, fy = (fm[:, 0].min() + fm[:, 0].max()) / 2, (fm[:, 1].min() + fm[:, 1].max()) / 2
        k = min(0.8 * (fm[:, 0].max() - fm[:, 0].min()) / 575, 0.8 * (fm[:, 1].max() - fm[:, 1].min()) / 514)
        for px, py, pr in PAT:
            c = Vector((fx + (px - 372.5) * k, fy + (py - 332) * k, zs - 0.0012))
            ring = [pads.verts.new(c + Vector((math.cos(t) * pr * k, math.sin(t) * pr * k, 0))) for t in np.linspace(0, 2 * math.pi, 48, endpoint=False)]
            cv_ = pads.verts.new(c)
            for i in range(48):
                f_ = pads.faces.new((cv_, ring[(i + 1) % 48], ring[i])); f_.normal_update()
                if f_.normal.z > 0:
                    f_.normal_flip()                              # 朝下
    pm = bpy.data.meshes.new('Bear_Pads'); pads.to_mesh(pm); pads.free()
    face_parts.append(link('Bear_Pads', pm))
    face_parts[-1]['nocap'] = 1

    # ---- 7. 法線先用整隻算好（分開後接縫處才不會出現折痕），再依材質分成零件 ----
    for p in me.polygons:
        p.use_smooth = True
    Nv = _normals(me, V)
    me.normals_split_custom_set_from_vertices([tuple(x) for x in Nv])
    names = [k for k in LABELS if k in fname]
    me.materials.clear()
    for k in names:
        me.materials.append(bpy.data.materials.get('T_' + k) or bpy.data.materials.new('T_' + k))
    for p, nm in zip(me.polygons, fname):
        p.material_index = names.index(nm)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.mesh.separate(type='MATERIAL')
    parts = []
    for o in [o for o in bpy.context.selected_objects if o.type == 'MESH']:
        k = o.data.materials[0].name[2:] if o.data.materials else 'Body'
        o.name = o.data.name = 'Bear_' + k
        o.data.materials.clear()
        o['nocap'] = 1                                            # 已經減好面了：匯出時不再減
        parts.append(o)
    if seams:
        parts.append(seams)

    for o_ in face_parts:
        o_.select_set(False)
    parts += face_parts

    # ---- 7b. 尾巴：模型的太小，照設計圖背面換成大一點的毛球（設計圖上直徑約 76 像素）----
    o_, d_ = _ray('B', 1424, 522)
    hit_ = bvh.ray_cast(o_, d_)[0]
    TR = 38 / VIEW['B']['s']
    tb = bmesh.new()
    bmesh.ops.create_uvsphere(tb, u_segments=40, v_segments=24, radius=TR)
    for v_ in tb.verts:
        v_.co.y *= 0.9
        v_.co += Vector((hit_.x, hit_.y - TR * 0.45, hit_.z))
    tme = bpy.data.meshes.new('Bear_Tail'); tb.to_mesh(tme); tb.free()
    for p_ in tme.polygons:
        p_.use_smooth = True
    tail = bpy.data.objects.new('Bear_Tail', tme); bpy.context.scene.collection.objects.link(tail)
    parts.append(tail)

    # ---- 8. 換到和其他角色一樣的座標：腳底 z=0，設計圖正面中線 x=0，和舊版同樣大小 ----
    v = VIEW['F']
    K = v['s'] / 150 * 0.48
    off = Vector((((v['cx'] - 356) / v['s'] - v['m']), ((VIEW['S']['cx'] - 882) / VIEW['S']['s'] - VIEW['S']['m']), -_project.zmin))
    for o in parts:
        o.data.transform(__import__('mathutils').Matrix.Translation(off))
        o.data.transform(__import__('mathutils').Matrix.Diagonal((K, K, K, 1)))
    print('teddy: parts', {o.name: len(o.data.polygons) for o in parts})
    return parts


def uv_cover(me, Wc, Hc):
    """貼圖上被 UV 三角形蓋到的像素。"""
    cov = np.zeros((Hc, Wc), bool); uvd = me.uv_layers.active.data
    me.calc_loop_triangles()
    for lt in me.loop_triangles:
        P = np.array([uvd[l].uv[:] for l in lt.loops]) * [Wc - 1, Hc - 1]
        x0, y0 = np.floor(P.min(0)).astype(int); x1, y1 = np.ceil(P.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, Wc - 1), min(y1, Hc - 1)
        if x1 < x0 or y1 < y0:
            continue
        gx_, gy_ = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx2, cy2) = P
        den = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2)
        if abs(den) < 1e-12:
            continue
        l1 = ((by - cy2) * (gx_ - cx2) + (cx2 - bx) * (gy_ - cy2)) / den
        l2 = ((cy2 - ay) * (gx_ - cx2) + (ax - cx2) * (gy_ - cy2)) / den
        ins = (l1 > -0.02) & (l2 > -0.02) & (1 - l1 - l2 > -0.02)
        cov[gy_[ins], gx_[ins]] = True
    return cov


def dilate(img, cov, it=8):
    """UV 區塊邊緣往外補色（縮小顯示時接縫不會破）。"""
    img = img.copy(); cov = cov.copy()
    for _ in range(it):
        acc = np.zeros(img.shape[:2] + (3,)); cnt = np.zeros(img.shape[:2])
        for sh in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cm = np.roll(cov, sh, (0, 1)); acc += np.roll(img[..., :3], sh, (0, 1)) * cm[..., None]; cnt += cm
        new = ~cov & (cnt > 0)
        img[new, :3] = acc[new] / cnt[new][:, None]; cov |= new
    return img


def despeckle(img, cov, protect=None, rounds=5):
    """去掉貼圖上的小雜點：比周圍亮很多的點、周圍是毛色但中間接近全黑的點，換成周圍的顏色。縫線（中等深的褐色）不動。"""
    img = img.copy(); tot = 0
    L = lambda q: q[..., 0] * 0.3 + q[..., 1] * 0.59 + q[..., 2] * 0.11
    for r in (2, 4, 6, 9, 12)[:rounds]:
        offs = [(dy, dx) for dy in (-r, 0, r) for dx in (-r, 0, r) if (dy, dx) != (0, 0)]
        acc = np.zeros(img.shape[:2] + (3,), np.float32); cnt = np.zeros(img.shape[:2], np.float32)
        for sh in offs:
            cm = np.roll(cov, sh, (0, 1)); acc += np.roll(img[..., :3], sh, (0, 1)) * cm[..., None]; cnt += cm
        ok = cnt >= 5
        mean = acc / np.maximum(cnt, 1)[..., None]
        l0, lm = L(img[..., :3]), L(mean)
        dist = np.linalg.norm(img[..., :3] - mean, axis=-1)
        bad = cov & ok & (((dist > 0.1) & (l0 > lm + 0.03)) | ((l0 < 0.2) & (lm > 0.42)))
        if protect is not None:
            bad &= ~protect
        img[bad, :3] = mean[bad]; tot += int(bad.sum())
    print('despeckle texels', tot)
    return img


def fix_tri_specks(me, V, E, n, img, skip=None, light=0.13):
    """逐個三角形檢查：三角形裡的取樣點（頂點、邊中點、中心）比周圍頂點的顏色亮很多或接近全黑，就把這個三角形範圍內異常的像素補成周圍顏色。"""
    H_, W_ = img.shape[:2]; uvd = me.uv_layers.active.data
    L = lambda q: q[..., 0] * 0.3 + q[..., 1] * 0.59 + q[..., 2] * 0.11
    def samp(uv):
        return img[min(H_ - 1, max(0, int(uv[1] * (H_ - 1)))), min(W_ - 1, max(0, int(uv[0] * (W_ - 1)))), :3]
    vc = np.zeros((n, 3)); vk = np.zeros(n)
    for lp in me.loops:
        vc[lp.vertex_index] += samp(uvd[lp.index].uv); vk[lp.vertex_index] += 1
    vc /= np.maximum(vk, 1)[:, None]
    nb = [[] for _ in range(n)]
    for a, b in E:
        nb[a].append(b); nb[b].append(a)
    me.calc_loop_triangles(); fixed = 0; tris = 0
    for lt in me.loop_triangles:
        vs = list(lt.vertices)
        if skip is not None and skip[vs].any():
            continue
        ring = set()
        for v in vs:
            for w in nb[v]:
                ring.update(nb[w])
        ring = list(ring - set(vs)) or vs
        ref = np.median(vc[ring], 0); lr = float(L(ref))
        P = np.array([uvd[l].uv[:] for l in lt.loops])
        pts = [P[0], P[1], P[2], (P[0] + P[1]) / 2, (P[1] + P[2]) / 2, (P[0] + P[2]) / 2, P.mean(0)]
        cs_ = np.array([samp(q) for q in pts]); ls = L(cs_); ds = np.linalg.norm(cs_ - ref, axis=1)
        if not (((ds > 0.1) & (ls > lr + 0.03)).any() or ((ls < 0.2).any() and lr > 0.42)):
            continue
        Q = P * [W_ - 1, H_ - 1]
        x0, y0 = np.floor(Q.min(0)).astype(int) - 2; x1, y1 = np.ceil(Q.max(0)).astype(int) + 2
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W_ - 1), min(y1, H_ - 1)
        blk = img[y0:y1 + 1, x0:x1 + 1, :3]
        lb = L(blk); db_ = np.linalg.norm(blk - ref, axis=-1)
        bad = ((db_ > 0.07) & (lb > lr + 0.02)) | ((lb < 0.2) & (lr > 0.42))
        blk[bad] = ref; fixed += int(bad.sum()); tris += 1
    print('tri specks fixed', tris, 'tris', fixed, 'texels')
    return img


def despeckle_fur(img, cov, furc, protect=None):
    """只在周圍大多是毛色的地方：偏淡（比毛色亮、顏色差 0.07～0.4）或接近全黑的小點，換成周圍毛色的平均。"""
    img = img.copy(); tot = 0
    L = lambda q: q[..., 0] * 0.3 + q[..., 1] * 0.59 + q[..., 2] * 0.11
    lf = float(L(np.asarray(furc)))
    for r in (2, 4, 7, 10):
        furlike = cov & (np.linalg.norm(img[..., :3] - furc, axis=-1) < 0.15)
        offs = [(dy, dx) for dy in (-r, 0, r) for dx in (-r, 0, r) if (dy, dx) != (0, 0)]
        acc = np.zeros(img.shape[:2] + (3,), np.float32); cnt = np.zeros(img.shape[:2], np.float32)
        for sh in offs:
            fm = np.roll(furlike, sh, (0, 1)); acc += np.roll(img[..., :3], sh, (0, 1)) * fm[..., None]; cnt += fm
        d0 = np.linalg.norm(img[..., :3] - furc, axis=-1); l0 = L(img[..., :3])
        bad = cov & (cnt >= 6) & (((d0 > 0.16) & (d0 < 0.4) & (l0 > lf + 0.02)) | (l0 < 0.2))
        if protect is not None:
            bad &= ~protect
        img[bad, :3] = acc[bad] / cnt[bad][:, None]; tot += int(bad.sum())
    print('despeckle_fur texels', tot)
    return img
