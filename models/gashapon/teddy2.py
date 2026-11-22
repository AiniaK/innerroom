# 泰迪熊 v2：使用者提供的 Tripo 模型（Model-Teddy-v2/*.fbx，兩手垂下、不拿魔杖；使用者 2026-11-23）
# 顏色、材質照舊版泰迪熊；模型原本雕出的縫線凹痕改成微凸、塗縫線色；眼睛、腮紅改扁平；肚子側面改圓潤；加尾巴、腳底肉球
# 由 build_model.py 的 build_teddy2() 呼叫；回傳的零件已經換到和其他角色一樣的座標（腳底 z=0，正面朝 −y）
import bpy, bmesh, math, os, glob
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree
import teddy as T

DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', 'Model-Teddy-v2')
REMESH = 0.0065
FACES = 110000
# 五官的位置（模型座標，正面看；scratchpad/v2/rel_F.png 量的）
SEEDS = dict(Eyes=[(-0.20, 0.31), (0.19, 0.31)], Cheeks=[(-0.32, 0.18), (0.31, 0.18)], Nose=[(-0.006, 0.235)],
             Mouth=[(-0.006, 0.14)], EarIn=[(-0.35, 0.57), (0.34, 0.57)])
RIDGE = 0.0035                                   # 縫線凸起的高度


def _load():
    fbx = glob.glob(os.path.join(DIR, '*.fbx'))[0]
    bpy.ops.import_scene.fbx(filepath=fbx)
    ob = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]
    for o in list(bpy.context.selected_objects):
        if o is not ob:
            bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = ob.data
    me.materials.clear()
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me); bm.free()
    V, E = T._arrays(me)
    V = V * 1.7; V[:, 2] -= 0.951                                   # 高 1.7、腳底 z=−0.951（和舊模型同一個框）
    me.vertices.foreach_set('co', V.ravel()); me.update()
    rm = ob.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = REMESH; rm.adaptivity = 0
    bpy.ops.object.modifier_apply(modifier='rm')
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.quads_convert_to_tris(); bpy.ops.object.mode_set(mode='OBJECT')
    for p_ in me.polygons:
        p_.use_smooth = True
    return ob


def build(HL, tube, join, link):
    ob = _load()
    me = ob.data
    V, E = T._arrays(me)
    n = len(V)
    zmin = V[:, 2].min()

    def bvh_of(V_):
        me.vertices.foreach_set('co', V_.ravel()); me.update()
        return BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
    bvh = bvh_of(V)
    N = T._normals(me, V)
    nb = [[] for _ in range(n)]
    for i, j in E:
        nb[i].append(j); nb[j].append(i)

    def relief(V_, a=60, b=120):
        S_ = V_.copy()
        for _ in range(a):
            S_ += 0.5 * (T._avg(S_, E, n) - S_)
        h_ = ((V_ - S_) * T._normals(me, V_)).sum(1)
        x = h_.copy()
        for _ in range(b):
            x = 0.5 * x + 0.5 * T._avg(x[:, None], E, n)[:, 0]
        T._normals(me, V_)
        return h_ - x
    h = relief(V)

    def region(seeds, ok, R, c):
        inside = ok & (((V - c) ** 2).sum(1) < R * R)
        out = np.zeros(n, bool); st = []
        for s0 in seeds:
            if inside[s0]:
                out[s0] = True; st.append(s0)
        while st:
            i = st.pop()
            for j in nb[i]:
                if inside[j] and not out[j]:
                    out[j] = True; st.append(j)
        return out

    def fvid(x, z):
        loc = bvh.ray_cast(Vector((x, -5, z)), Vector((0, 1, 0)))[0]
        return int(np.argmin(((V - np.array(loc)) ** 2).sum(1)))

    # ---- 1. 五官（模型雕出來的凸起）：從中心往外長，長到四周那圈凹痕為止 ----
    FEAT = {}
    for k, sign, thr, R in (('Eyes', 1, -0.0008, 0.08), ('Cheeks', 1, 0.0, 0.12), ('Nose', 1, 0.0, 0.07),
                            ('Mouth', -1, 0.0, 0.09), ('EarIn', -1, 0.0005, 0.14)):
        m = np.zeros(n, bool)
        for x, z in SEEDS[k]:
            s0 = fvid(x, z)
            near = np.nonzero(((V - V[s0]) ** 2).sum(1) < (R * 0.4) ** 2)[0]
            s0 = near[np.argmax(sign * h[near])]
            m |= region([s0], sign * h > thr, R, V[s0])
        FEAT[k] = m
    ms = fvid(-0.006, 0.17)
    FEAT['Muzzle'] = region([ms], (h > -0.0015) | FEAT['Mouth'] | FEAT['Nose'], 0.24, V[ms]) & ~FEAT['Mouth'] & ~FEAT['Nose']
    FPOS = {k: V[m].copy() for k, m in FEAT.items()}
    for k, m in FEAT.items():
        print('teddy2: feature', k, int(m.sum()))
    HC = V[V[:, 2] > 0.0].mean(0)

    # ---- 2. 原本雕出的縫線凹痕（細長的凹線；五官、耳朵四周的凹痕不算）----
    faceish = T._grow(FEAT['Eyes'] | FEAT['Cheeks'] | FEAT['Nose'] | FEAT['Mouth'] | FEAT['Muzzle'] | FEAT['EarIn'], E, n, 22)
    ears = (V[:, 2] > 0.45) & (np.abs(V[:, 0]) > 0.24)
    hf = relief(V, 25, 60)                                         # 細的凹線用小範圍的凹凸看
    groove = (hf < -0.0016) & ~faceish & ~ears
    # 去掉零碎的小點：只留夠長的
    lab = np.full(n, -1); keep = np.zeros(n, bool)
    for s0 in np.nonzero(groove)[0]:
        if lab[s0] >= 0:
            continue
        st = [s0]; lab[s0] = s0; mem = [s0]
        while st:
            i = st.pop()
            for j in nb[i]:
                if groove[j] and lab[j] < 0:
                    lab[j] = s0; st.append(j); mem.append(j)
        P = V[mem]
        if len(mem) > 60 and np.ptp(P, 0).max() > 0.15:
            keep[mem] = True
    groove = keep
    print('teddy2: seam groove verts', int(groove.sum()))

    # ---- 3. 收平眼睛、腮紅、鼻子、嘴（之後換成扁平的外加零件）；四周的凹陷一起填平 ----
    MOUTH0 = FEAT['Mouth'].copy()
    for name in ('Eyes', 'Cheeks', 'Mouth', 'Nose'):
        R_ = T._grow(FEAT[name], E, n, {'Mouth': 6, 'Cheeks': 26}.get(name, 12))   # 腮紅的底邊比較寬
        F_ = V.copy()
        for _ in range(3000):
            F_[R_] = T._avg(F_, E, n)[R_]
        if name == 'Mouth':                                       # 嘴：只填一半，保留舌頭和微微凹進去的口腔（使用者）
            Nm = T._normals(me, V)
            MDEP = np.zeros(n); MDEP[R_] = ((F_[R_] - V[R_]) * Nm[R_]).sum(1)   # 比填平的表面低多少（口腔的深度）
            V[R_] = F_[R_] + (V[R_] - F_[R_]) * 0.3                 # 微微凹陷
        else:
            V[R_] = F_[R_]

    # 吻部磨圓（嘴洞填平後的起伏）
    mzw = T._grow(FEAT['Muzzle'] | FEAT['Mouth'] | FEAT['Nose'], E, n, 4).astype(float)
    for _ in range(10):
        mzw = 0.5 * mzw + 0.5 * T._avg(mzw[:, None], E, n)[:, 0]
    mzw[T._grow(MOUTH0, E, n, 3)] *= 0.15                          # 口腔、舌頭保留
    V = T._taubin(V, E, 400, np.clip(mzw * 1.3, 0, 1), 0.5, -0.505)

    # ---- 4. 肚子：側面看下垂 → 改成圓潤（只前後推，正面輪廓不變）----
    tor = (np.abs(V[:, 0]) < 0.22) & (V[:, 2] > -0.66) & (V[:, 2] < -0.02)
    zs = np.linspace(-0.64, -0.04, 31)
    prof = []
    for z in zs:
        m = tor & (np.abs(V[:, 2] - z) < 0.012)
        prof.append(V[m, 1].min() if m.any() else np.nan)
    prof = np.array(prof)
    ok_ = ~np.isnan(prof); prof = np.interp(zs, zs[ok_], prof[ok_])
    za, zb = zs[0], zs[-1]
    base = prof[0] + (prof[-1] - prof[0]) * (zs - za) / (zb - za)
    D = (base - prof).max()
    zc, Hh = -0.33, 0.31                                          # 最鼓的地方放在肚子中段（設計圖側面）
    tgt = base - D * np.sqrt(np.clip(1 - ((zs - zc) / Hh) ** 2, 0, 1))
    dy = 0.6 * (tgt - prof)                                       # 往圓潤的形狀靠，不要一次推太多
    front = V[:, 1] < np.interp(V[:, 2], zs, prof) + 0.25
    wz = np.clip((V[:, 2] - za) / 0.06, 0, 1) * np.clip((zb - V[:, 2]) / 0.06, 0, 1)
    wx = np.clip(1 - (np.abs(V[:, 0]) / 0.24) ** 2, 0, 1)        # 只推身體正中一帶（手臂不動）
    V[:, 1] += np.interp(V[:, 2], zs, dy) * wz * wx * front
    print('teddy2: belly dy range', dy.min().round(4), dy.max().round(4))

    # ---- 5. 撫平（輕微；v2 本來就平順）；縫線凹痕改成微凸 ----
    w = np.ones(n); w[T._grow(groove, E, n, 2)] = 0.2
    V = T._taubin(V, E, 60, w, 0.5, -0.53)
    Nn = T._normals(me, V)
    gw = groove.astype(float)
    for _ in range(2):
        gw = 0.5 * gw + 0.5 * T._avg(gw[:, None], E, n)[:, 0]
    gw = np.clip(gw * 2, 0, 1)
    hf2 = np.minimum(relief(V, 25, 60), 0)
    V += Nn * ((-hf2 + RIDGE) * gw)[:, None]                       # 凹痕填平再微微凸起
    # 腳底切平
    zc_ = zmin + 0.012
    V[V[:, 2] < zc_, 2] = zc_
    me.vertices.foreach_set('co', V.ravel()); me.update()
    V0 = V.copy()
    kd0 = KDTree(n)
    for i, p in enumerate(V0):
        kd0.insert(p, i)
    kd0.balance()

    # ---- 6. 減面、分色（吻部白、耳內半圓、縫線色），沿平順的曲線切開 ----
    md = ob.modifiers.new('dc', 'DECIMATE'); md.ratio = min(1.0, FACES / len(me.polygons))
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier='dc')
    V, E = T._arrays(me)
    n2 = len(V)
    nn_ = np.array([kd0.find(p)[1] for p in V])
    Nd = T._normals(me, V)
    bvh = bvh_of(V)
    def fits(k, split):
        P_ = FPOS[k]
        groups = [P_[P_[:, 0] < P_[:, 0].mean()], P_[P_[:, 0] >= P_[:, 0].mean()]] if split else [P_]
        return [dict(cx=g[:, 0].mean(), cz=g[:, 2].mean(), rx=2 * g[:, 0].std(), rz=2 * g[:, 2].std()) for g in groups if len(g) > 5]
    CUSTOM = {}
    muz = fits('Muzzle', False)[0]
    mp0, mn0, _, _ = bvh.ray_cast(Vector((muz['cx'], -5, muz['cz'])), Vector((0, 1, 0)))
    mdv = (mn0 * 0.6 + Vector((0, -1, 0)) * 0.4).normalized()
    mup = (Vector((0, 0, 1)) - mdv * mdv.z).normalized(); mright = mup.cross(mdv).normalized()
    rel = V - np.array(mp0)
    ell = ((rel @ np.array(mright)) / (muz['rx'] * 1.02)) ** 2 + ((rel @ np.array(mup)) / (muz['rz'] * 0.98)) ** 2
    CUSTOM['Muzzle'] = np.clip(0.5 + 1.5 * (1 - ell), 0, 1) * np.clip((rel @ np.array(mdv) + 0.10) / 0.04, 0, 1)
    fe = np.zeros(n2)
    P_ = FPOS['EarIn']
    for g in (P_[P_[:, 0] < P_[:, 0].mean()], P_[P_[:, 0] >= P_[:, 0].mean()]):
        c_ = g.mean(0); U, S2, Wt = np.linalg.svd(g - c_, full_matrices=False)
        nv = Wt[2] if Wt[2][1] < 0 else -Wt[2]
        rel_ = V - c_; qd = rel_ @ nv
        inpl = rel_ - np.outer(qd, nv)
        hd = np.array(HC) - c_; hd = hd - nv * (hd @ nv); hd /= np.linalg.norm(hd)
        R_ = 0.9 * (2 * np.sqrt(((g - c_) @ Wt[0]).var()) + 2 * np.sqrt(((g - c_) @ Wt[1]).var())) / 2
        disc = np.clip(0.5 + (R_ - np.linalg.norm(inpl + hd * 0.02, axis=1)) * 120, 0, 1)
        half = np.clip(0.5 + (-(inpl @ hd) + 0.025) * 120, 0, 1)
        fe = np.maximum(fe, np.minimum(disc, half) * np.clip((0.05 - np.abs(qd)) / 0.02, 0, 1))
    CUSTOM['EarIn'] = fe
    sf = groove[nn_].astype(float)
    for _ in range(2):
        sf = 0.5 * sf + 0.5 * T._avg(sf[:, None], E, n2)[:, 0]
    CUSTOM['Seams'] = np.clip(sf * 1.4, 0, 1)
    ncz = FPOS['Nose'][:, 2].min()
    cav = (MDEP > 0.006) & (V0[:, 2] < ncz - 0.01)                  # 口腔：比填平的表面低的那一整塊（邊界就是嘴唇的邊緣；鼻子的 V 形凹痕不算）
    dmax = MDEP[cav].max() if cav.any() else 1
    mcz0 = V0[cav, 2].mean() if cav.any() else 0
    tng = cav & (MDEP < 0.55 * dmax) & (V0[:, 2] < mcz0)           # 舌頭：口腔下半比較淺（凸起）的那塊
    print('teddy2: mouth cavity', int(cav.sum()), 'tongue', int(tng.sum()), 'depth', round(float(dmax), 4))
    MOUTH0 = T._grow(cav, E, n, 1)
    mf = MOUTH0[nn_].astype(float)                                  # 口腔（紅）
    for _ in range(3):
        mf = 0.5 * mf + 0.5 * T._avg(mf[:, None], E, n2)[:, 0]
    CUSTOM['Mouth'] = np.clip(mf * 1.3, 0, 1)
    mcz = FPOS['Mouth'][:, 2].mean()
    hm = relief_on(V) if False else None
    tf = tng[nn_].astype(float)                                     # 舌頭（粉紅）
    for _ in range(3):
        tf = 0.5 * tf + 0.5 * T._avg(tf[:, None], E, n2)[:, 0]
    CUSTOM['Tongue'] = np.clip(tf * 1.6, 0, 1)
    below = (V[:, 2] < ncz - 0.006).astype(float)                   # 口腔、舌頭只在鼻子以下
    CUSTOM['Mouth'] *= below; CUSTOM['Tongue'] *= below
    ORDER = ['Tongue', 'Mouth', 'Muzzle', 'EarIn', 'Seams']
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    lay = {}
    for k in ORDER:
        L_ = bm.verts.layers.float.new('f_' + k); lay[k] = L_
        for v_ in bm.verts:
            v_[L_] = float(CUSTOM[k][v_.index])
    for k, L_ in lay.items():
        cut = []
        for e in list(bm.edges):
            a_, b_ = e.verts
            fa, fb = a_[L_] - 0.5, b_[L_] - 0.5
            if fa * fb < 0:
                t_ = fa / (fa - fb)
                vals = {kk: a_[LL] + (b_[LL] - a_[LL]) * t_ for kk, LL in lay.items()}
                ne, nv_ = bmesh.utils.edge_split(e, a_, t_)
                for kk, LL in lay.items():
                    nv_[LL] = vals[kk]
                nv_[L_] = 0.5
                cut.append(nv_)
        cs = set(cut)
        for fc in list({f_ for v_ in cut for f_ in v_.link_faces}):
            on = [v_ for v_ in fc.verts if v_ in cs]
            if len(on) == 2 and not any(e.other_vert(on[0]) is on[1] for e in on[0].link_edges):
                bmesh.ops.connect_verts(bm, verts=on)
    bmesh.ops.triangulate(bm, faces=[f_ for f_ in bm.faces if len(f_.verts) > 3])
    fname = []
    for fc in bm.faces:
        nm = 'Body'
        for k in ORDER:
            if sum(v_[lay[k]] for v_ in fc.verts) / len(fc.verts) > 0.5:
                nm = k; break
        fname.append(nm)
    bm.to_mesh(me); bm.free()
    V, E = T._arrays(me)
    bvh = bvh_of(V)

    # ---- 7. 外加零件：扁平的眼珠、鼻子、嘴（上緣貼近鼻子）、扁平的腮紅；尾巴；腳底肉球 ----
    def bead(name, d, depth, tri=False):
        loc, nor, _, _ = bvh.ray_cast(Vector((d['cx'], -5, d['cz'])), Vector((0, 1, 0)))
        nor = (nor + Vector((0, -1, 0))).normalized()
        up = (Vector((0, 0, 1)) - nor * nor.z).normalized(); right = up.cross(nor).normalized()
        b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=40, v_segments=24, radius=1)
        for v_ in b_.verts:
            a, bb, c = v_.co
            if tri:
                a *= 0.74 + 0.26 * c
            v_.co = loc + right * (a * d['rx']) + up * (c * d['rz']) + nor * (bb * depth + depth * 0.1)
        bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
        m_ = bpy.data.meshes.new(name); b_.to_mesh(m_); b_.free()
        for p_ in m_.polygons:
            p_.use_smooth = True
        return link(name, m_)
    def decal(name, d, lift, thick, dshape=False, NR=10, NS=72):
        p0, n0, _, _ = bvh.ray_cast(Vector((d['cx'], -5, d['cz'])), Vector((0, 1, 0)))
        dv = (n0 * 0.75 + Vector((0, -1, 0)) * 0.25).normalized()
        up = (Vector((0, 0, 1)) - dv * dv.z).normalized(); right = up.cross(dv).normalized()
        rx, rz = d['rx'], d['rz']
        if dshape:
            vt = d['top'] - d['cz']; H = 2 * rz
            bnd = [(rx * math.cos(t), vt + H * math.sin(t)) for t in np.linspace(math.pi, 2 * math.pi, NS // 2 + 1)]
            bnd += [(rx - 2 * rx * f, vt) for f in np.linspace(0, 1, NS // 2 + 1)[1:-1]]
            c0 = (0.0, vt - 0.45 * H)
        else:
            bnd = [(rx * math.cos(t), rz * math.sin(t)) for t in np.linspace(0, 2 * math.pi, NS, endpoint=False)]
            c0 = (0.0, 0.0)
        b_ = bmesh.new()
        def place(u, v, off):
            q = p0 + right * u + up * v
            loc, nor, _, _ = bvh.ray_cast(q + dv * 0.3, -dv)
            return None if loc is None else b_.verts.new(loc + nor * off)
        rings = [[place(c0[0] + (bx - c0[0]) * r, c0[1] + (bz - c0[1]) * r, lift) for bx, bz in bnd] for r in np.linspace(0, 1, NR + 1)[1:]]
        cen = place(c0[0], c0[1], lift)
        wall = [place(bx, bz, lift - thick) for bx, bz in bnd]
        m_ = len(bnd)
        def face(vs):
            if all(v is not None for v in vs) and len(set(vs)) == len(vs):
                f_ = b_.faces.new(vs); f_.normal_update()
                if f_.normal.dot(dv) < 0:
                    f_.normal_flip()
        for i in range(m_):
            j = (i + 1) % m_
            face((cen, rings[0][i], rings[0][j]))
            for a_, bb_ in zip(rings, rings[1:]):
                face((a_[i], bb_[i], bb_[j], a_[j]))
            if thick > 0:
                face((rings[-1][i], wall[i], wall[j], rings[-1][j]))
        mm = bpy.data.meshes.new(name); b_.to_mesh(mm); b_.free()
        for p_ in mm.polygons:
            p_.use_smooth = True
        return link(name, mm)
    eyes = fits('Eyes', True)
    nose = fits('Nose', False)[0]
    mo = fits('Mouth', False)[0]
    MW = 2 * muz['rx']
    ntop = nose['cz'] - nose['rz'] - 0.004                         # 上唇貼近鼻子（使用者：上唇曲線自然一點）
    mouth = dict(cx=mo['cx'], cz=ntop - 0.12 * MW, rx=0.2 * MW, rz=0.12 * MW, top=ntop)
    face_parts = [T.fix_out(join([bead('ey', e, e['rx'] * 0.3) for e in eyes], 'Bear_Eyes')),     # 扁平的眼珠
                  bead('Bear_Nose', nose, nose['rx'] * 0.5, tri=True),
                  join([decal('ck', d, 0.0012, 0.003) for d in fits('Cheeks', True)], 'Bear_Cheeks')]
    # 尾巴：背後腰下方中央（設計圖背面）
    bc = V[(V[:, 2] > -0.55) & (V[:, 2] < -0.35)]
    hit = bvh.ray_cast(Vector((bc[:, 0].mean(), 5, -0.45)), Vector((0, -1, 0)))[0]
    TR = 0.1
    tb = bmesh.new(); bmesh.ops.create_uvsphere(tb, u_segments=40, v_segments=24, radius=TR)
    for v_ in tb.verts:
        v_.co.y *= 0.9
        v_.co += Vector((hit.x, hit.y - TR * 0.45, hit.z))
    tm = bpy.data.meshes.new('Bear_Tail'); tb.to_mesh(tm); tb.free()
    for p_ in tm.polygons:
        p_.use_smooth = True
    face_parts.append(link('Bear_Tail', tm))
    # 腳底肉球（使用者給的圖樣）
    zs_ = V[:, 2].min(); solev = V[V[:, 2] < zs_ + 1e-4]
    pads = bmesh.new()
    PAT = [(372, 415, 174), (142, 218, 57), (291, 132, 57), (454, 132, 57), (602, 218, 57)]
    xmid = solev[:, 0].mean()
    for fm in (solev[solev[:, 0] < xmid], solev[solev[:, 0] >= xmid]):
        if len(fm) < 10:
            continue
        fx, fy = (fm[:, 0].min() + fm[:, 0].max()) / 2, (fm[:, 1].min() + fm[:, 1].max()) / 2
        k = min(0.8 * np.ptp(fm[:, 0]) / 575, 0.8 * np.ptp(fm[:, 1]) / 514)
        for px, py, pr in PAT:
            c = Vector((fx + (px - 372.5) * k, fy + (py - 332) * k, zs_ - 0.0012))
            ring = [pads.verts.new(c + Vector((math.cos(t) * pr * k, math.sin(t) * pr * k, 0))) for t in np.linspace(0, 2 * math.pi, 48, endpoint=False)]
            cv_ = pads.verts.new(c)
            for i in range(48):
                f_ = pads.faces.new((cv_, ring[(i + 1) % 48], ring[i])); f_.normal_update()
                if f_.normal.z > 0:
                    f_.normal_flip()
    pm = bpy.data.meshes.new('Bear_Pads'); pads.to_mesh(pm); pads.free()
    face_parts.append(link('Bear_Pads', pm))
    for o_ in face_parts:
        o_['nocap'] = 1

    # ---- 8. 法線先整隻算好，再依顏色分成零件 ----
    for p in me.polygons:
        p.use_smooth = True
    me.normals_split_custom_set_from_vertices([tuple(x) for x in T._normals(me, V)])
    names = sorted(set(fname))
    me.materials.clear()
    for k in names:
        me.materials.append(bpy.data.materials.new('T_' + k))
    for p, nm in zip(me.polygons, fname):
        p.material_index = names.index(nm)
    for o_ in face_parts:
        o_.select_set(False)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.mesh.separate(type='MATERIAL')
    parts = []
    for o in [o for o in bpy.context.selected_objects if o.type == 'MESH']:
        k = o.data.materials[0].name[2:].split('.')[0] if o.data.materials else 'Body'
        o.name = o.data.name = 'Bear_' + k
        o.data.materials.clear()
        o['nocap'] = 1
        parts.append(o)
    parts += face_parts

    # ---- 9. 換到和其他角色一樣的座標：腳底 z=0，正中 x=0，和舊版同樣大小 ----
    K = 338 / 150 * 0.48
    off = Vector((0, 0, -zs_))
    for o in parts:
        o.data.transform(Matrix.Translation(off))
        o.data.transform(Matrix.Diagonal((K, K, K, 1)))
    print('teddy2: parts', {o.name: len(o.data.polygons) for o in parts})
    return parts
