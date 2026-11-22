# 耳鼻猴：使用者提供的模型（design-source/gashapon/Model-Monkey.glb）→ 撫平大片平面、依模型的凹痕與設計圖分色、
# 外加乾淨的五官零件、手指腳趾凹痕、頭帶背後的蝴蝶結、尾巴改成從披風下襬下方伸出（不穿過披風）
# 由 build_model.py 的 build_monkey2() 呼叫；回傳的零件已經換到和舊版一樣的座標（腳底 z=0，正面朝 −y）
import bpy, bmesh, math, os
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree
import teddy as T

GLB = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', 'Model-Monkey.glb')
REMESH = 0.0075
# 模型 ↔ 設計圖正面（輪廓擬合，scratchpad/monkey/fit.py）：px = cx + s·(x − m)，py = g − s·(z − zmin)
VF = dict(s=532.87, cx=663.46, g=1093.0, m=0.011957)
VB = dict(s=268.84, cx=319.63, g=557.0, m=-0.011957)              # 背面：px = cx + s·(−x − m)
REF_F = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', '耳鼻猴正面.png')
REF_B = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', '耳鼻猴背面.png')
SMOOTH = 300
FACES = 120000


def _ray_front(bvh, x, z):
    return bvh.ray_cast(Vector((x, -5, z)), Vector((0, 1, 0)))


def _ray_back(bvh, x, z):
    return bvh.ray_cast(Vector((x, 5, z)), Vector((0, -1, 0)))


def build(HL, tube, join, link):
    ob = T._load(GLB, REMESH)
    me = ob.data
    V, E = T._arrays(me)
    n = len(V)
    zmin = V[:, 2].min()
    DX = lambda px: VF['m'] + (px - VF['cx']) / VF['s']           # 設計圖正面的像素 → 模型座標
    DZ = lambda py: zmin + (VF['g'] - py) / VF['s']
    DR = lambda r: r / VF['s']

    def bvh_of(V_):
        me.vertices.foreach_set('co', V_.ravel()); me.update()
        return BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
    bvh = bvh_of(V)
    N = T._normals(me, V)
    nb = [[] for _ in range(n)]
    for i, j in E:
        nb[i].append(j); nb[j].append(i)

    # ---- 1. 模型的凹凸（凹痕＝各部位的邊界）、厚度（披風是薄片）----
    def relief(V_):
        S_ = V_.copy()
        for _ in range(100):
            S_ += 0.5 * (T._avg(S_, E, n) - S_)
        h_ = ((V_ - S_) * T._normals(me, V_)).sum(1)
        x = h_.copy()
        for _ in range(200):
            x = 0.5 * x + 0.5 * T._avg(x[:, None], E, n)[:, 0]
        T._normals(me, V_)
        return h_ - x
    h = relief(V)
    th = np.full(n, 9.0)
    for i in range(n):
        p = Vector(V[i]); d = -Vector(N[i])
        hit = bvh.ray_cast(p + d * 1e-4, d)[0]
        if hit is not None:
            th[i] = (hit - p).length
    S_ = V.copy()
    for _ in range(400):
        S_ += 0.5 * (T._avg(S_, E, n) - S_)
    hb = ((V - S_) * N).sum(1); hb -= np.median(hb)
    JUNC = hb < -0.02

    def region(seeds, ok, R=None, c=None):
        out = np.zeros(n, bool); st = []
        for s0 in seeds:
            if ok[s0]:
                out[s0] = True; st.append(s0)
        lim = (((V - c) ** 2).sum(1) < R * R) if R is not None else np.ones(n, bool)
        while st:
            i = st.pop()
            for j in nb[i]:
                if ok[j] and lim[j] and not out[j]:
                    out[j] = True; st.append(j)
        return out

    def vid(p):
        return int(np.argmin(((V - np.array(p)) ** 2).sum(1)))

    def front_vid(x, z):
        loc = _ray_front(bvh, x, z)[0]
        return vid(loc)

    def back_vid(x, z):
        loc = _ray_back(bvh, x, z)[0]
        return vid(loc)

    # 頭帶（凸起的一圈，上下緣是凹痕）、鼻子裝飾、背後的扣環
    band_z = 0.558
    band = region([front_vid(-0.46, band_z), front_vid(0.30, 0.56), back_vid(0.32, band_z), back_vid(-0.30, band_z)],
                  (h > -0.0022) & (np.abs(V[:, 2] - band_z) < 0.13) & ~JUNC)
    orn = region([front_vid(-0.08, 0.80), front_vid(-0.04, 0.70)], (h > -0.0025) & ~JUNC, 0.32, np.array(V[front_vid(-0.06, 0.74)]))
    orn &= ~band
    bc = np.array(V[back_vid(-0.03, 0.41)])
    buckle = (np.abs(V[:, 0] - bc[0]) < 0.075) & (np.abs(V[:, 2] - bc[2]) < 0.085) & (V[:, 1] > bc[1] - 0.12)   # 背後的扣環一帶
    def close(m, k):                                              # 補洞、去掉零碎：先長 k 圈再縮 k 圈，只留最大的一塊
        m = ~T._grow(~T._grow(m, E, n, k), E, n, k)
        lab_ = np.full(n, -1); best = (0, None)
        for s0 in np.nonzero(m)[0]:
            if lab_[s0] >= 0:
                continue
            st = [s0]; lab_[s0] = s0; mem = [s0]
            while st:
                i = st.pop()
                for j in nb[i]:
                    if m[j] and lab_[j] < 0:
                        lab_[j] = s0; st.append(j); mem.append(j)
            if len(mem) > 1500:
                best = (best[0] + len(mem), (best[1] or []) + mem)
        out = np.zeros(n, bool); out[best[1] or []] = True
        return out
    # 設計圖的顏色投影：朝向那一面、沒被擋住的點，讀設計圖上那一點的顏色
    def design_masks(path):
        A = HL.load_rgb(path); r_, g_, b_ = A[..., 0], A[..., 1], A[..., 2]
        cl = lambda m, k=2: HL.blur2(HL.blur2(m.astype(np.float32), k) > 0.5, k + 1) > 0.35
        mx_, mn_ = np.maximum(np.maximum(r_, g_), b_), np.minimum(np.minimum(r_, g_), b_)
        return dict(blue=cl((b_ > 150) & (b_ - r_ > 60)), white=cl((mn_ > 190) & (mx_ - mn_ < 22)))
    MF, MB = design_masks(REF_F), design_masks(REF_B)
    def proj(view, mask):
        out = np.zeros(n, bool)
        if view == 'F':
            px = VF['cx'] + VF['s'] * (V[:, 0] - VF['m']); py = VF['g'] - VF['s'] * (V[:, 2] - zmin); d = Vector((0, 1, 0)); fac = N[:, 1] < -0.15
        else:
            px = VB['cx'] + VB['s'] * (-V[:, 0] - VB['m']); py = VB['g'] - VB['s'] * (V[:, 2] - zmin); d = Vector((0, -1, 0)); fac = N[:, 1] > 0.15
        H_, W_ = mask.shape
        xi, yi = np.round(px).astype(int), np.round(py).astype(int)
        inb = (xi >= 0) & (xi < W_) & (yi >= 0) & (yi < H_)
        cand = np.nonzero(fac & inb)[0]
        cand = cand[mask[yi[cand], xi[cand]]]
        for i in cand:
            p = Vector(V[i]); hit = bvh.ray_cast(p - d * 3, d)[0]
            if hit is not None and (hit - p).length < 0.01:
                out[i] = True
        return out
    band = close(band | (proj('F', MF['white']) & T._grow(band, E, n, 6)), 5)   # 模型的凸起＋設計圖正面的白色（只採用頭帶附近的）
    # 拳頭：從拳頭往外長，長到和身體交界的凹痕為止
    FIST = np.zeros(n, bool)
    for fx in (-0.407, 0.351):
        s0 = front_vid(fx, -0.46)
        FIST |= region([s0], ~JUNC, 0.14, V[s0])
    print('monkey: fist verts', int(FIST.sum()))
    # 披風：薄片
    # 尾巴：從尾巴上的一點往外長（只走粗 0.06～0.2 的地方，不會長進薄薄的披風）
    tc = np.nonzero((((V - np.array((0.57, 0.50, -0.20))) ** 2).sum(1) < 0.06 ** 2) & (th > 0.06) & (th < 0.2))[0]
    TAIL = region(list(tc), ~JUNC & (th > 0.06) & (th < 0.2) & ((V[:, 1] > 0.1) | (V[:, 0] > 0.45)))
    # 下段和披風下襬的褶子連在一起：只算離尾巴中心線 0.075 以內的（中心線是量的截面中心）
    TL = np.array([(0.50, 0.47, -0.30), (0.478, 0.47, -0.40), (0.465, 0.47, -0.45), (0.38, 0.48, -0.50), (0.34, 0.49, -0.55), (0.30, 0.50, -0.60), (0.27, 0.50, -0.66)])
    dmin = np.full(n, 9.0)
    for a_, b_ in zip(TL[:-1], TL[1:]):
        ab = b_ - a_; t_ = np.clip(((V - a_) @ ab) / (ab @ ab), 0, 1)
        dmin = np.minimum(dmin, np.linalg.norm(V - (a_ + np.outer(t_, ab)), axis=1))
    TAIL &= (V[:, 2] > -0.3) | (dmin < 0.075)
    print('monkey: tail verts', int(TAIL.sum()))
    thin = close((th < 0.075) & (V[:, 2] > -0.75) & (V[:, 2] < 0.05) & ~TAIL, 5)
    # 披風：從薄片往外長（領口比較厚），長到和身體交界的凹痕為止
    cape = region(list(np.nonzero(thin)[0]), (th < 0.17) & ~JUNC & ~TAIL & (V[:, 2] > -0.78) & (V[:, 2] < 0.12)) | thin
    cape = close(cape | proj('F', MF['blue']) | (proj('B', MB['blue']) & ~T._grow(TAIL, E, n, 2)), 12) & ~TAIL
    # 臉上的凸起（眼睛、鼻子、嘴）：位置是正面看到的（scratchpad/monkey/rel_F.png）
    feats = {}
    for k, pts, sign, R in (('Eyes', [(-0.231, 0.407), (0.164, 0.407)], 1, 0.07), ('Nose', [(-0.033, 0.336)], 1, 0.045),
                            ('Mouth', [(-0.044, 0.22)], -1, 0.09)):
        m = np.zeros(n, bool)
        for x, z in pts:
            s0 = front_vid(x, z)
            near = np.nonzero(((V - V[s0]) ** 2).sum(1) < (R * 0.4) ** 2)[0]
            s0 = near[np.argmax(sign * h[near])]
            m |= region([s0], sign * h > 0.0, R, V[s0])
        feats[k] = m
        print('monkey: feature', k, int(m.sum()))
    FPOS = {k: V[m].copy() for k, m in feats.items()}
    print('monkey: band', int(band.sum()), 'orn', int(orn.sum()), 'buckle', int(buckle.sum()), 'cape', int(cape.sum()))

    # ---- 2. 收平臉上的凸起（之後換成外加零件）、扣環（換成蝴蝶結）----
    for mask in (feats['Eyes'], feats['Nose'], feats['Mouth'], buckle):
        R_ = T._grow(mask, E, n, 8)
        F_ = V.copy()
        for _ in range(1500):
            F_[R_] = T._avg(F_, E, n)[R_]
        V[R_] = F_[R_]

    # ---- 3. 重塑：大片平面拉圓；交界、披風、尾巴、耳朵薄的地方、頭帶與裝飾保持原樣 ----
    bvh = bvh_of(V)
    lo = V.min(0) - 0.1; hg = 0.009
    shape = tuple(int(x) for x in np.ceil((V.max(0) + 0.1 - lo) / hg))
    occ = T._occupancy(bvh, lo, hg, shape)
    Pb = V.copy(); Ps = V.copy()
    for sig, out in ((0.06, Pb), (0.022, Ps)):
        G = occ
        for ax in range(3):
            G = T._blur1(G, sig, hg, ax)
        out[:] = T._project_iso(V, G, lo, hg)
    Nr = T._normals(me, V)
    db = np.linalg.norm(Pb - V, axis=1); ds = np.linalg.norm(Ps - V, axis=1)
    sb = ((Pb - V) * Nr).sum(1); ss = ((Ps - V) * Nr).sum(1)
    wb = np.where(sb > 0, np.clip((0.016 - sb) / 0.008, 0, 1), np.clip((0.035 - db) / 0.0175, 0, 1))
    ws = np.where(ss > 0, np.clip((0.008 - ss) / 0.004, 0, 1), np.clip((0.02 - ds) / 0.01, 0, 1))
    for _ in range(20):
        wb = 0.5 * wb + 0.5 * T._avg(wb[:, None], E, n)[:, 0]
        ws = 0.5 * ws + 0.5 * T._avg(ws[:, None], E, n)[:, 0]
    prot = T._grow(JUNC | cape | band | orn | (th < 0.11), E, n, 3)
    pw = prot.astype(float)
    for _ in range(25):
        pw = 0.5 * pw + 0.5 * T._avg(pw[:, None], E, n)[:, 0]
    pw = np.clip(pw * 2.2, 0, 1)
    tgt = V + wb[:, None] * (Pb - V) + ((1 - wb) * ws)[:, None] * (Ps - V)
    V = V + (1 - pw)[:, None] * (tgt - V)

    # ---- 4. 撫平（頭帶、裝飾的邊緣保持利落）----
    w = np.ones(n)
    w[T._grow(band | orn, E, n, 1)] = 0.3
    w[T._grow(JUNC, E, n, 2)] = 0.5
    V = T._taubin(V, E, SMOOTH, w, 0.5, -0.505)
    bi = band & ~T._grow(~band, E, n, 3)                          # 頭帶內部的橫向凹線（原始模型）磨平，邊緣不動
    V = T._taubin(V, E, 150, bi.astype(float), 0.5, -0.505)

    # ---- 5. 手指、腳趾的凹痕（使用者給的參考圖）----
    Nn = T._normals(me, V)
    def groove(p0, p1, depth, width):
        nonlocal V
        a, b = np.array(p0), np.array(p1); ab = b - a; L2 = ab @ ab
        t_ = np.clip(((V - a) @ ab) / L2, 0, 1)
        d = np.linalg.norm(V - (a + np.outer(t_, ab)), axis=1)
        m = d < width
        fall = (1 - (d[m] / width) ** 2) ** 2 * np.sin(np.pi * np.clip(t_[m], 0, 1)) ** 0.35
        V[m] -= Nn[m] * (depth * fall)[:, None]
    bvh = bvh_of(V)
    for fx in ():                                                 # （拳頭改成外加的乾淨零件，見第 7 步）
        fz_ = V[FIST & (np.abs(V[:, 0] - fx) < 0.1), 2]
        ztop, zbot = np.percentile(fz_, 70), np.percentile(fz_, 3)
        for k in (-1, 0, 1):
            top = Vector((fx + k * 0.03, -5, ztop)); bot = Vector((fx + k * 0.032, -5, zbot + 0.005))
            pt = _ray_front(bvh, top.x, top.z)[0]; pb = _ray_front(bvh, bot.x, bot.z)[0]
            if pt is not None and pb is not None:
                groove(pt, pb, 0.018, 0.014)
    feet_x = []
    fz = V[:, 2] < zmin + 0.09
    for side in (-1, 1):
        fm = fz & (np.sign(V[:, 0] - VF['m']) == side)
        fx = (V[fm, 0].min() + V[fm, 0].max()) / 2; fw = V[fm, 0].max() - V[fm, 0].min()
        feet_x.append((fx, fw))
        for k in (-1, 0, 1):                                      # 腳掌前面三道凹痕（四根腳趾）
            x = fx + k * fw * 0.2
            pt = _ray_front(bvh, x, zmin + 0.065)[0]; pb = _ray_front(bvh, x, zmin + 0.004)[0]
            if pt is not None and pb is not None:
                groove(pt, pb, 0.016, 0.014)
    # 原本凹凸不平的拳頭收進之後要放的乾淨拳頭裡（離中心 0.07 內收到 55%，0.11 以外不動）
    for fx in (-0.407, 0.351):
        loc = _ray_front(bvh, fx, -0.455)[0]
        c = np.array(loc + Vector((0, 1, 0)) * 0.058)
        d = np.linalg.norm(V - c, axis=1)
        sc_ = 0.55 + 0.45 * np.clip((d - 0.07) / 0.04, 0, 1)
        m = d < 0.11
        V[m] = c + (V[m] - c) * sc_[m][:, None]
    me.vertices.foreach_set('co', V.ravel()); me.update()

    # ---- 5b. 尾巴：截掉下襬上方以下垂著的那段（之後接一段從下襬下方彎進屁股的新尾巴）----
    bvh = bvh_of(V)
    hang = TAIL & (V[:, 2] < -0.42)
    print('monkey: hanging tail verts', int(hang.sum()))
    if 200 < hang.sum() < 40000:
        bm_ = bmesh.new(); bm_.from_mesh(me); bm_.verts.ensure_lookup_table()
        bmesh.ops.delete(bm_, geom=[bm_.verts[i] for i in np.nonzero(hang)[0]], context='VERTS')
        bm_.to_mesh(me); bm_.free()
        keep = ~hang
        band, orn, cape = band[keep], orn[keep], cape[keep]
        V, E = T._arrays(me)
        n = len(V)
    # ---- 6. 減面，分色（每種顏色的範圍抹成 0..1，沿 0.5 那條線切開）----
    V0 = V.copy()
    kd0 = KDTree(n)
    for i, p in enumerate(V0):
        kd0.insert(p, i)
    kd0.balance()
    md = ob.modifiers.new('dc', 'DECIMATE'); md.ratio = min(1.0, FACES / len(me.polygons))
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier='dc')
    V, E = T._arrays(me)
    n2 = len(V)
    nn_ = np.array([kd0.find(p)[1] for p in V])
    Nd = T._normals(me, V)
    bvh = bvh_of(V)
    F = {}
    for k, m in (('Band', band), ('Orn', orn), ('Cape', cape)):
        f = m[nn_].astype(float)
        for _ in range(2):
            f = 0.5 * f + 0.5 * T._avg(f[:, None], E, n2)[:, 0]
        F[k] = f
    def ell_field(cx, cz, rx, rz, dv, maxd=0.25):
        p0 = _ray_front(bvh, cx, cz)[0]
        up = (Vector((0, 0, 1)) - dv * dv.z).normalized(); rt = up.cross(dv).normalized()
        rel = V - np.array(p0)
        e = ((rel @ np.array(rt)) / rx) ** 2 + ((rel @ np.array(up)) / rz) ** 2
        ok = (Nd @ np.array(dv) > 0.05) & (np.abs(rel @ np.array(dv)) < maxd)
        return np.where(ok, np.clip(0.5 + 1.5 * (1 - e), 0, 1), 0.0)
    fwd = Vector((0, -1, 0))
    # 臉（米色）：上緣沿頭帶下緣切齊（每一段 x 找頭帶最低處）
    bf = V0[band & (V0[:, 1] < 0)]
    edges_x = np.linspace(-0.7, 0.7, 71)
    low = np.array([np.percentile(bf[np.abs(bf[:, 0] - ex) < 0.025, 2], 4) if (np.abs(bf[:, 0] - ex) < 0.025).sum() > 5 else np.nan for ex in edges_x])
    ok_ = ~np.isnan(low); low = np.interp(edges_x, edges_x[ok_], low[ok_])
    low = np.convolve(np.pad(low, 3, mode='edge'), np.ones(7) / 7, mode='valid')
    zcut = np.interp(V[:, 0], edges_x, low) - 0.004
    F['Face'] = ell_field(DX(658), DZ(400), DR(250), DR(140), fwd, 0.3) * np.clip((zcut - V[:, 2]) * 200 + 0.5, 0, 1)
    F['Belly'] = ell_field(DX(667), DZ(751), DR(142), DR(96), fwd, 0.3)             # 肚子
    # 拳頭（米色）：以拳頭中心的球
    hands = np.zeros(n2)
    for fx in (-0.407, 0.351):
        loc, nor, _, _ = _ray_front(bvh, fx, -0.46)
        c = np.array(loc) - np.array(nor) * 0.085
        fm_ = FIST[nn_] & (np.abs(V[:, 0] - fx) < 0.15)
        wrist = c[2] + 0.05                                       # 手腕：拳頭中心上方一個水平面（交界是乾淨的一圈）
        hands = np.maximum(hands, np.where(fm_, np.clip(0.5 + (wrist - V[:, 2]) * 80, 0, 1), 0))
    F['Cream'] = np.clip(0.5 + (zmin + 0.085 - V[:, 2]) * 40, 0, 1)   # 腳掌：腳踝以下（拳頭另外做乾淨的零件）
    # 耳朵：米色圓、外側的粉色 C 形
    ears = []
    HC = V[(V[:, 2] > 0.1) & (np.abs(V[:, 0]) < 0.45)].mean(0)
    for ex, ez in ((-0.673, 0.50), (0.71, 0.533)):
        loc, nor, _, _ = _ray_front(bvh, ex, ez)
        c0 = np.array(loc)
        m = (np.linalg.norm(V - c0, axis=1) < 0.15) & (Nd[:, 1] < -0.3)
        nv = Nd[m].mean(0); nv = nv / np.linalg.norm(nv)
        a1 = np.array([1, 0, 0]) - nv * nv[0]; a1 /= np.linalg.norm(a1); a2 = np.cross(nv, a1)
        rel = V - c0
        q1, q2, qd = rel @ a1, rel @ a2, rel @ nv
        R = 0.235                                                 # 耳朵半徑（正面量的，scratchpad/monkey/rel_F.png）
        hd = np.array(HC) - c0; hd = hd - nv * (hd @ nv); hd /= np.linalg.norm(hd); h1, h2 = hd @ a1, hd @ a2
        face_ok = (Nd @ nv > 0.2) & (np.abs(qd) < 0.12)
        r_ = np.hypot(q1, q2)
        cream = np.where(face_ok, np.clip(0.5 + (0.76 * R - r_) * 30, 0, 1), 0)
        po = np.hypot(q1 + 0.10 * R * h1, q2 + 0.10 * R * h2)      # 粉色 C：中心往外側偏，挖掉偏向頭的一個圓
        pi = np.hypot(q1 - 0.08 * R * h1, q2 - 0.08 * R * h2)
        pink = np.where(face_ok, np.clip(np.minimum(0.5 + (0.56 * R - po) * 30, 0.5 + (pi - 0.40 * R) * 30), 0, 1), 0)
        ears.append((cream, pink))
        print('monkey: ear R', round(float(R), 3))
    F['EarIn'] = np.maximum(ears[0][0], ears[1][0])
    F['EarPink'] = np.maximum(ears[0][1], ears[1][1])
    ORDER = ['Orn', 'Band', 'EarPink', 'EarIn', 'Cape', 'Face', 'Belly', 'Cream']
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    lay = {}
    for k in ORDER:
        L_ = bm.verts.layers.float.new('f_' + k); lay[k] = L_
        for v_ in bm.verts:
            v_[L_] = float(F[k][v_.index])
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
    Nd = T._normals(me, V)

    # ---- 7. 外加零件：眼睛（直立的亮面黑珠）、鼻子、嘴＋舌頭、腮紅 ----
    def fit(P_):
        return dict(cx=P_[:, 0].mean(), cz=P_[:, 2].mean(), rx=2 * P_[:, 0].std(), rz=2 * P_[:, 2].std())
    def bead(name, d, depth, tri=False):
        loc, nor, _, _ = _ray_front(bvh, d['cx'], d['cz'])
        nor = (nor + Vector((0, -1, 0))).normalized()
        up = (Vector((0, 0, 1)) - nor * nor.z).normalized(); right = up.cross(nor).normalized()
        b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=40, v_segments=24, radius=1)
        for v_ in b_.verts:
            a, bb, c = v_.co
            v_.co = loc + right * (a * d['rx']) + up * (c * d['rz']) + nor * (bb * depth + depth * 0.2)
        bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
        m_ = bpy.data.meshes.new(name); b_.to_mesh(m_); b_.free()
        for p_ in m_.polygons:
            p_.use_smooth = True
        return link(name, m_)
    def decal(name, d, lift, thick, dshape=False, NR=10, NS=72):
        p0, n0, _, _ = _ray_front(bvh, d['cx'], d['cz'])
        dv = (n0 * 0.7 + Vector((0, -1, 0)) * 0.3).normalized()
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
    P_ = FPOS['Eyes']
    eyes = [fit(P_[P_[:, 0] < P_[:, 0].mean()]), fit(P_[P_[:, 0] >= P_[:, 0].mean()])]
    eyes = [dict(e, rx=DR(28), rz=DR(36.5)) for e in eyes]                        # 大小照設計圖
    nose = dict(fit(FPOS['Nose']), rx=DR(24), rz=DR(15))
    mo = fit(FPOS['Mouth'])
    mouth = dict(cx=mo['cx'], cz=mo['cz'], rx=DR(46), rz=DR(36), top=mo['cz'] + DR(30))
    tongue = dict(cx=mo['cx'], cz=mo['cz'] - DR(22), rx=DR(30), rz=DR(14))
    face_parts = [T.fix_out(join([bead('ey', e, e['rx'] * 0.5) for e in eyes], 'Monkey_Eyes')),
                  bead('Monkey_Nose', nose, nose['rx'] * 0.5),
                  decal('Monkey_Mouth', mouth, 0.0018, 0.004, dshape=True)]
    face_parts.append(decal('Monkey_Tongue', tongue, 0.0032, 0.004))
    ck = [dict(cx=DX(483), cz=DZ(421), rx=DR(46), rz=DR(42)), dict(cx=DX(2 * 658 - 483), cz=DZ(421), rx=DR(46), rz=DR(42))]
    face_parts.append(join([decal('ck', d, 0.0016, 0.004) for d in ck], 'Monkey_Cheeks'))
    # 拳頭：乾淨的米色拳頭（三道手指凹痕：四根手指），蓋住原本凹凸不平的拳頭
    fists = []
    for fx in (-0.407, 0.351):
        loc, nor, _, _ = _ray_front(bvh, fx, -0.455)
        c = loc + Vector((0, 1, 0)) * 0.058
        RX, RY, RZ = 0.074, 0.07, 0.068
        b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=128, v_segments=80, radius=1)
        for v_ in b_.verts:
            x, y, z = v_.co
            sq = 1.0 + 0.12 * (1 - abs(z))                       # 有點方的圓（拳頭）
            p = Vector((x * RX * sq, y * RY, z * RZ))
            wz = max(0.0, 1 - ((z + 0.2) / 0.5) ** 2)             # 正面中下段（指節）的三道短凹痕，兩端漸淡
            wy = min(1.0, max(0.0, (-y - 0.3) / 0.35))
            if wz > 0 and wy > 0:
                for gx in (-0.3, 0.0, 0.3):
                    d = abs(x - gx)
                    if d < 0.09:
                        p += Vector((0, 1, 0)) * (0.009 * (1 - (d / 0.09) ** 2) ** 2 * wz * wy)
            v_.co = c + p
        bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
        m_ = bpy.data.meshes.new('fist'); b_.to_mesh(m_); b_.free()
        for p_ in m_.polygons:
            p_.use_smooth = True
        fists.append(link('fist', m_))
    face_parts.append(join(fists, 'Monkey_Fists'))

    # ---- 8. 頭帶背後的蝴蝶結（設計圖背面）----
    loc, nor, _, _ = _ray_back(bvh, -0.03, 0.41)
    nv = (nor + Vector((0, 1, 0))).normalized()
    up = (Vector((0, 0, 1)) - nv * nv.z).normalized(); rt = up.cross(nv).normalized()
    bow = []
    for sx in (-1, 1):                                           # 兩個圈：扁的橢圓，往外上斜
        b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=40, v_segments=20, radius=1)
        for v_ in b_.verts:
            a, bb, c = v_.co
            a2 = a * 0.16; c2 = c * (0.095 * (0.7 + 0.5 * (a * sx * 0.5 + 0.5)))   # 外側比較寬（蝴蝶結的形狀）
            v_.co = loc + rt * (sx * 0.15 + a2) + up * (c2 + 0.01) + nv * (bb * 0.05 + 0.035)
        bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
        m_ = bpy.data.meshes.new('bw'); b_.to_mesh(m_); b_.free(); bow.append(link('bw', m_))
    b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=32, v_segments=16, radius=1)
    for v_ in b_.verts:
        a, bb, c = v_.co
        v_.co = loc + rt * (a * 0.06) + up * (c * 0.068 + 0.008) + nv * (bb * 0.045 + 0.055)
    bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
    m_ = bpy.data.meshes.new('bk'); b_.to_mesh(m_); b_.free(); bow.append(link('bk', m_))
    for p_ in [p for o in bow for p in o.data.polygons]:
        p_.use_smooth = True
    face_parts.append(join(bow, 'Monkey_Bow'))

    # ---- 9. 尾巴下段：從截斷處沿披風外側往下，繞過下襬下緣，再彎進屁股（設計圖背面：尾巴從下襬下方長出來）----
    # 控制點（量的）：截斷處尾巴中心 → 下襬外側 → 下襬下緣 → 往內彎 → 屁股裡
    ctrl = [Vector(p_) for p_ in ((0.50, 0.47, -0.28), (0.478, 0.48, -0.38), (0.46, 0.54, -0.48), (0.43, 0.62, -0.60), (0.38, 0.58, -0.71),
                                  (0.29, 0.42, -0.765), (0.19, 0.24, -0.755), (0.11, 0.09, -0.71))]
    def catmull(P, k=10):
        P = [P[0]] + P + [P[-1]]; out = []
        for i in range(1, len(P) - 2):
            p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
            for t in np.linspace(0, 1, k, endpoint=False):
                out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
        out.append(P[-2]); return out
    if len(ctrl) >= 4:
        tp = catmull(ctrl)
        tail2 = tube('Monkey_Tail2', tp, 0.05, seg=24)
        for p_ in tail2.data.polygons:
            p_.use_smooth = True
        face_parts.append(tail2)
        print('monkey: tail ctrl', [tuple(round(c, 3) for c in v) for v in ctrl])

    for o_ in face_parts:
        o_['nocap'] = 1

    # ---- 10. 法線先整隻算好，再依顏色分成零件 ----
    for p in me.polygons:
        p.use_smooth = True
    me.normals_split_custom_set_from_vertices([tuple(x) for x in T._normals(me, V)])
    names = sorted(set(fname))
    me.materials.clear()
    for k in names:
        me.materials.append(bpy.data.materials.new('M_' + k))
    for p, nm in zip(me.polygons, fname):
        p.material_index = names.index(nm)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.mesh.separate(type='MATERIAL')
    parts = []
    for o in [o for o in bpy.context.selected_objects if o.type == 'MESH']:
        k = o.data.materials[0].name[2:].split('.')[0] if o.data.materials else 'Body'
        o.name = o.data.name = 'Monkey_' + k
        o.data.materials.clear()
        o['nocap'] = 1
        parts.append(o)
    parts += face_parts

    # ---- 11. 換到舊版的座標（設計圖正面 px 650 是 x=0、腳底 z=0；舊版每 200 像素 = 0.394）----
    K = VF['s'] / 200 * 0.394
    off = Vector(((VF['cx'] - 650) / VF['s'] - VF['m'], 0, -zmin))
    for o in parts:
        o.data.transform(Matrix.Translation(off))
        o.data.transform(Matrix.Diagonal((K, K, K, 1)))
    print('monkey: parts', {o.name: len(o.data.polygons) for o in parts})
    return parts
