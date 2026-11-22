# 泰迪熊 v2（貼圖版；使用者 2026-11-23）：用 v2 原本的貼圖（顏色＋凹凸貼圖，縫線、眼睛、吻部都在貼圖上），網站另外加上毛氈的絨毛材質。
# 形狀只做小幅調整：眼睛、腮紅的凸起壓低（四周的凹陷填平，臉頰不動）、嘴往上移（人中短一點）、肚子側面更圓潤；
# 加上完整的圓眼珠（不被臉吃掉）、尾巴；貼圖上人中的黑點修掉
import bpy, bmesh, math, os, glob
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
import teddy as T

DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', 'Model-Teddy-v2')
OUT_TEX = os.path.join(os.path.dirname(__file__), 'bear_tex.jpg')
OUT_NRM = os.path.join(os.path.dirname(__file__), 'bear_nrm.jpg')
SEEDS = dict(Eyes=[(-0.20, 0.31), (0.19, 0.31)], Cheeks=[(-0.32, 0.18), (0.31, 0.18)], Nose=[(-0.006, 0.235)],
             Mouth=[(-0.006, 0.14)])
CHEEK_KEEP = 0.4          # 腮紅留下原本凸起的幾成
MOUTH_UP = 0.04           # 嘴往上移多少（人中短一點）
BELLY_EXTRA = 0.04        # 肚子中段再往前鼓多少


def build(HL, tube, join, link):
    fbx = glob.glob(os.path.join(DIR, '*.fbx'))[0]
    bpy.ops.import_scene.fbx(filepath=fbx)
    ob = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]
    for o in list(bpy.context.selected_objects):
        if o is not ob:
            bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = ob.data
    # 貼圖：顏色、凹凸
    imgs = sorted(glob.glob(os.path.join(DIR, '*.fbm', 'tripo_image_*_0_*.jpg')))
    col_path = [p for p in imgs if p.endswith('_0_0.jpg')][0]; nrm_path = [p for p in imgs if p.endswith('_0_3.jpg')][0]
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me); bm.free()
    me.materials.clear()
    for p_ in me.polygons:
        p_.use_smooth = True
    V, E = T._arrays(me)
    V = V * 1.7; V[:, 2] -= 0.951
    n = len(V)
    zmin = V[:, 2].min()
    me.vertices.foreach_set('co', V.ravel()); me.update()
    bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
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
    FEAT = {}
    for k, sign, thr, R in (('Eyes', 1, -0.0008, 0.08), ('Cheeks', 1, 0.0, 0.12), ('Nose', 1, 0.0, 0.07), ('Mouth', -1, 0.0, 0.09)):
        m = np.zeros(n, bool)
        for x, z in SEEDS[k]:
            s0 = fvid(x, z)
            near = np.nonzero(((V - V[s0]) ** 2).sum(1) < (R * 0.4) ** 2)[0]
            s0 = near[np.argmax(sign * h[near])]
            m |= region([s0], sign * h > thr, R, V[s0])
        FEAT[k] = m
        print('teddy3: feature', k, int(m.sum()))
    FPOS = {k: V[m].copy() for k, m in FEAT.items()}

    # ---- 貼圖：人中的黑點修掉（鼻子下緣到嘴上緣之間、正中一條，暗的像素換成旁邊吻部的顏色）----
    uvl = me.uv_layers.active.data
    vuv = np.zeros((n, 2))
    for loop in me.loops:
        vuv[loop.vertex_index] = uvl[loop.index].uv
    img = bpy.data.images.load(col_path, check_existing=False); W, H = img.size
    px = np.array(img.pixels[:]).reshape(H, W, 4)
    nz0, mz1 = FPOS['Nose'][:, 2].min(), FPOS['Mouth'][:, 2].max()
    phil = (np.abs(V[:, 0] + 0.006) < 0.045) & (V[:, 2] < nz0 + 0.002) & (V[:, 2] > mz1 - 0.015) & (V[:, 1] < -0.2) & ~T._grow(FEAT['Nose'], E, n, 1)
    ref_i = np.nonzero((np.abs(V[:, 0] - 0.06) < 0.015) & (np.abs(V[:, 2] - (nz0 + mz1) / 2) < 0.02) & (V[:, 1] < -0.2))[0]
    if phil.any() and len(ref_i):
        rc = np.median([px[int(vuv[i, 1] * (H - 1)), int(vuv[i, 0] * (W - 1)), :3] for i in ref_i], 0)
    def texel(i):
        return int(vuv[i, 1] * (H - 1)), int(vuv[i, 0] * (W - 1))
    me.calc_loop_triangles()
    _uvd = me.uv_layers.active.data
    TRV = np.array([lt.vertices[:] for lt in me.loop_triangles])
    TRUV = np.array([[_uvd[l].uv[:] for l in lt.loops] for lt in me.loop_triangles]) * [W - 1, H - 1]
    def paint(mask, color, cond=None, rad=None):
        # 只塗這些頂點所在三角形在貼圖上實際蓋到的像素（方塊塗法會溢到 UV 上相鄰、模型上卻在別處的區塊）
        cnt = 0
        for P in TRUV[mask[TRV].any(1)]:
            x0, y0 = np.floor(P.min(0)).astype(int) - 1; x1, y1 = np.ceil(P.max(0)).astype(int) + 1
            x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W - 1), min(y1, H - 1)
            gx_, gy_ = np.meshgrid(np.arange(x0, x1 + 1) + 0.5 - 0.5, np.arange(y0, y1 + 1))
            (ax, ay), (bx, by), (cx2, cy2) = P
            den = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2)
            if abs(den) < 1e-12:
                continue
            l1 = ((by - cy2) * (gx_ - cx2) + (cx2 - bx) * (gy_ - cy2)) / den
            l2 = ((cy2 - ay) * (gx_ - cx2) + (ax - cx2) * (gy_ - cy2)) / den
            tol = 1.2 / max(abs(den), 1e-6) ** 0.5
            ins = (l1 > -tol) & (l2 > -tol) & (1 - l1 - l2 > -tol)
            blk = px[y0:y1 + 1, x0:x1 + 1, :3]
            m_ = ins & (cond(blk) if cond else True)
            if isinstance(color, np.ndarray) and color.ndim == 3:
                blk[m_] = color[y0:y1 + 1, x0:x1 + 1][m_]
            else:
                blk[m_] = color
            cnt += int(m_.sum())
        return cnt
    luma = lambda q: q[..., 0] * 0.3 + q[..., 1] * 0.59 + q[..., 2] * 0.11
    if phil.any() and len(ref_i):
        print('teddy3: philtrum texels painted', paint(phil, rc, lambda b: b.sum(-1) < rc.sum() * 0.9))
    Vn_ = V
    # 眼睛（貼圖上原本畫的）：換成周圍的毛色（圓眼珠蓋在上面，邊緣才不會露出黑點）
    for g in (FPOS['Eyes'][FPOS['Eyes'][:, 0] < FPOS['Eyes'][:, 0].mean()], FPOS['Eyes'][FPOS['Eyes'][:, 0] >= FPOS['Eyes'][:, 0].mean()]):
        c_ = g.mean(0); r_ = (np.ptp(g[:, 0]) + np.ptp(g[:, 2])) / 4
        d_ = np.linalg.norm(Vn_ - c_, axis=1)
        ring = np.nonzero((d_ > r_ * 1.6) & (d_ < r_ * 2.0))[0]
        fur = np.median([px[texel(i)][:3] for i in ring], 0)
        print('teddy3: eye texels → fur', paint(d_ < r_ * 2.4, fur, lambda b, f=fur: luma(b) < luma(f) * 0.88))   # 眼角的髒點也一起清掉
    # 鼻子：整個塗黑（下緣原本有一點發白）
    nblack = np.array([0.05, 0.045, 0.045])
    print('teddy3: nose texels → black', paint(FEAT['Nose'], nblack, lambda b: (luma(b) > 0.12) & (luma(b) < 0.75) | (np.ptp(b, axis=-1) < 0.06), 3))
    # 腳底的灰色色塊 → 腳的毛色
    sole = V[:, 2] < zmin + 0.025
    leg = np.nonzero((V[:, 2] > zmin + 0.08) & (V[:, 2] < zmin + 0.15))[0]
    legc = np.median([px[texel(i)][:3] for i in leg], 0)
    print('teddy3: sole texels → fur', paint(sole, legc, None, 5))
    def fill0(R_, it=2000):
        F_ = V.copy()
        for _ in range(it):
            F_[R_] = T._avg(F_, E, n)[R_]
        return F_
    # 口腔重新上色：整塊乾淨的紅色，下半的舌頭粉紅（嘴角原本有一塊白色）
    Rm = T._grow(FEAT['Mouth'], E, n, 5); Fm = fill0(Rm); Nn0 = T._normals(me, V)
    dep = np.zeros(n); dep[Rm] = ((Fm[Rm] - V[Rm]) * Nn0[Rm]).sum(1)
    # 嘴洞裡面和外面不一定相連：另外用嘴唇一圈擬合的平面，平面後面的也算口腔
    mc = FPOS['Mouth'].mean(0)
    rm = np.percentile(np.hypot(FPOS['Mouth'][:, 0] - mc[0], FPOS['Mouth'][:, 2] - mc[2]), 95)
    dxz = np.hypot(V[:, 0] - mc[0], V[:, 2] - mc[2])
    lipr = V[(dxz > rm * 1.15) & (dxz < rm * 1.6) & (V[:, 1] < mc[1] + 0.02)]
    pc = lipr.mean(0); _, _, Wt = np.linalg.svd(lipr - pc, full_matrices=False)
    pn = Wt[2] if Wt[2][1] < 0 else -Wt[2]
    sd = (V - pc) @ pn
    # 嘴洞：從正面投影找。嘴周圍一圈擬合一個二次曲面當「吻部表面」，比它深 1.5mm 以上、和嘴中心相連的區域就是洞
    mc = mc.copy(); mc[0] = FPOS['Nose'][:, 0].mean()                # 嘴在鼻子正下方
    print('teddy3: mouth rm', round(float(rm), 3))
    st = 0.004; gx = np.arange(mc[0] - rm * 3, mc[0] + rm * 3, st); gz = np.arange(mc[2] - rm * 3, mc[2] + rm * 3, st)
    GY = np.full((len(gz), len(gx)), np.nan)
    for iz, z in enumerate(gz):
        for ix, x in enumerate(gx):
            h_ = bvh.ray_cast(Vector((x, -5, z)), Vector((0, 1, 0)))
            if h_[0] is not None:
                GY[iz, ix] = h_[0].y
    XX, ZZ = np.meshgrid(gx, gz); RR = np.hypot(XX - mc[0], ZZ - mc[2])
    ringm = (RR > rm * 1.5) & (RR < rm * 2.6) & ~np.isnan(GY)
    def design(x, z):
        x = x - mc[0]; z = z - mc[2]
        return np.stack([np.ones_like(x), x, z, x * x, x * z, z * z], -1)
    sel = ringm.copy()
    for _ in range(3):
        cf = np.linalg.lstsq(design(XX[sel], ZZ[sel]), GY[sel], rcond=None)[0]
        res = GY - design(XX, ZZ) @ cf
        sel = ringm & (np.abs(res) < 0.01)
    SURF = lambda x, z: design(np.asarray(x), np.asarray(z)) @ cf
    deep = (res > 0.015) & (RR < rm * 2.4)
    from collections import deque
    lab = np.zeros_like(deep); iz0, ix0 = np.unravel_index(np.argmax(np.where(deep, res, -1) * (RR < rm * 1.2)), deep.shape)
    q = deque([(iz0, ix0)]); lab[iz0, ix0] = True
    while q:
        a_, b_ = q.popleft()
        for da, db_ in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            u_, w_ = a_ + da, b_ + db_
            if 0 <= u_ < deep.shape[0] and 0 <= w_ < deep.shape[1] and deep[u_, w_] and not lab[u_, w_]:
                lab[u_, w_] = True; q.append((u_, w_))
    for _ in range(2):                                             # 往外多一格（嘴唇內緣）
        lab = lab | np.roll(lab, 1, 0) | np.roll(lab, -1, 0) | np.roll(lab, 1, 1) | np.roll(lab, -1, 1)
    vix = np.clip(np.round((V[:, 0] - gx[0]) / st).astype(int), 0, len(gx) - 1)
    viz = np.clip(np.round((V[:, 2] - gz[0]) / st).astype(int), 0, len(gz) - 1)
    inproj = lab[viz, vix] & (np.abs(V[:, 0] - gx[0] - vix * st) < st) & (np.abs(V[:, 2] - gz[0] - viz * st) < st)
    vsurf = SURF(V[:, 0], V[:, 2])
    HOLE = inproj & (V[:, 1] > vsurf + 0.002) & (V[:, 1] < vsurf + 0.4)
    HOLE_SURF = vsurf
    INM = HOLE
    cav = HOLE.copy()
    print('teddy3: mouth hole verts', int(HOLE.sum()), 'x', np.round(V[HOLE, 0].min(), 3), np.round(V[HOLE, 0].max(), 3))
    if cav.any():
        dmax = dep.max(); czm = V[cav, 2].mean()
        tng = cav & (dep < 0.55 * dmax) & (V[:, 2] < czm)
        tc = np.array([px[texel(i)][:3] for i in np.nonzero(cav)[0]])
        redish = tc[(tc[:, 0] > tc[:, 1] + 0.25)]
        redc = np.median(redish, 0) if len(redish) else np.array([0.75, 0.15, 0.15])
        tgc = np.array([px[texel(i)][:3] for i in np.nonzero(tng)[0]])
        pk = tgc[(tgc[:, 0] > tgc[:, 1] + 0.12) & (tgc[:, 1] > 0.3)]
        pinkc = np.median(pk, 0) if len(pk) else np.array([0.93, 0.5, 0.5])
        # 貼圖上的口腔整塊改成吻部的米白色（之後另外貼一片乾淨的口腔＋舌頭）
        ringv = np.nonzero((dxz > rm * 1.6) & (dxz < rm * 2.4) & (V[:, 1] < mc[1] + 0.02) & (V[:, 2] < mc[2]))[0]   # 嘴下方的吻部
        rcol = np.array([px[texel(i)][:3] for i in ringv]); rcol = rcol[luma(rcol) > np.percentile(luma(rcol), 80)]
        mzc = np.median(rcol, 0) if len(rcol) else rc
        print('teddy3: mouth texels → muzzle', paint(cav, mzc, None, 4), np.round(mzc, 3), np.round(rc, 3))
        lipring = T._grow(cav, E, n, 5) & ~cav & ~T._grow(FEAT['Nose'], E, n, 1)
        print('teddy3: mouth outline line → muzzle', paint(lipring, mzc, lambda b: luma(b) < luma(mzc) - 0.06, 3))   # 原本嘴邊畫的褐色線
        # 唇珠：上唇正中的暗點改成吻部的米白色
        mtop = V[cav, 2].max(); mxc = V[cav, 0].mean()
        lip = (np.abs(V[:, 0] - mxc) < 0.05) & (V[:, 2] > mtop - 0.012) & (V[:, 2] < mtop + 0.03) & ~cav & (V[:, 1] < -0.2)
        print('teddy3: lip texels', paint(lip, rc, lambda b: luma(b) < luma(rc) * 0.85, 3))
    MCAV = cav
    MOUTH2D = V[cav][:, [0, 2]].copy()
    vcol = np.array([px[texel(i)][:3] for i in range(n)])
    MUZ0 = (vcol.min(1) > 0.55) & (luma(vcol) > 0.68) & (V[:, 1] < -0.15)
    MUZ = T._grow(MUZ0, E, n, 2)   # 吻部（米白色）
    # 腮紅：貼圖上的粉紅改成毛色（之後貼兩片扁平的圓餅）
    CHK = []
    for g in (FPOS['Cheeks'][FPOS['Cheeks'][:, 0] < FPOS['Cheeks'][:, 0].mean()], FPOS['Cheeks'][FPOS['Cheeks'][:, 0] >= FPOS['Cheeks'][:, 0].mean()]):
        c_ = g.mean(0); r_ = (np.ptp(g[:, 0]) + np.ptp(g[:, 2])) / 4
        d_ = np.linalg.norm(V - c_, axis=1)
        ring = np.nonzero((d_ > r_ * 1.5) & (d_ < r_ * 1.9))[0]
        fur = np.median([px[texel(i)][:3] for i in ring], 0)
        pk = [px[texel(i)][:3] for i in np.nonzero(d_ < r_ * 0.5)[0]]
        CHK.append((c_, r_, np.median(pk, 0)))
        print('teddy3: cheek texels → fur', paint((d_ < r_ * 2.8) & ~MUZ, fur, lambda b, f=fur: (b[..., 2] > f[2] + 0.05) & (b[..., 1] < f[1] + 0.12) & (b[..., 0] > b[..., 1] + 0.1) & (luma(b) < luma(f) + 0.06), 5))   # 只換粉紅（吻部的米白色不動）
    pk_ = np.clip(np.mean([c[2] for c in CHK], 0) * 1.16 + 0.03, 0, 1)   # 腮紅圓餅的顏色（和貼圖一起調亮）
    print('teddy3: CHEEK_HEX #%02X%02X%02X' % tuple(int(round(float(x) * 255)) for x in pk_))
    # 貼圖區塊的邊緣往外補色（縮小顯示時接縫才不會破，例如耳朵內側）
    uv_cover = lambda Wc, Hc: T.uv_cover(me, Wc, Hc); dilate = T.dilate
    COV = uv_cover(W, H)
    print('teddy3: uv coverage', round(float(COV.mean()), 3))
    prot = np.zeros((H, W), bool)
    for i in np.nonzero(T._grow(MUZ, E, n, 2))[0]:
        cy, cx = texel(i); prot[max(0, cy - 8):cy + 9, max(0, cx - 8):cx + 9] = True
    bk = np.nonzero((V[:, 1] > 0.15) & (np.abs(V[:, 0]) < 0.3))[0]
    furc = np.median(np.array([px[texel(i)][:3] for i in bk]), 0)
    px = dilate(px, COV)
    # 整體調亮一點
    px[..., :3] = np.clip(px[..., :3] * 1.16 + 0.03, 0, 1)
    out = bpy.data.images.new('bear_tex', W, H); out.pixels = px.ravel()
    out.filepath_raw = OUT_TEX; out.file_format = 'JPEG'; out.save()
    # 凹凸貼圖：嘴洞一帶改成平的（口腔深度大多是這張圖畫出來的陰影）
    nim = bpy.data.images.load(nrm_path, check_existing=False); NW, NH = nim.size
    npx = np.array(nim.pixels[:]).reshape(NH, NW, 4)
    mreg = T._grow(cav | INM, E, n, 2)
    flat = np.zeros((NH, NW)); rad = 5
    for i in np.nonzero(mreg)[0]:
        cy, cx = int(vuv[i, 1] * (NH - 1)), int(vuv[i, 0] * (NW - 1))
        flat[max(0, cy - rad):cy + rad + 1, max(0, cx - rad):cx + rad + 1] = 1
    k_ = 0.8                                                       # 留 20% 的起伏
    npx[..., 0] += (0.5 - npx[..., 0]) * flat * k_; npx[..., 1] += (0.5 - npx[..., 1]) * flat * k_; npx[..., 2] += (1.0 - npx[..., 2]) * flat * k_
    npx = dilate(npx, COV if (NW, NH) == (W, H) else uv_cover(NW, NH))
    nout = bpy.data.images.new('bear_nrm_out', NW, NH, is_data=True); nout.pixels = npx.ravel()
    nout.filepath_raw = OUT_NRM; nout.file_format = 'JPEG'; nout.save()
    print('teddy3: normal map flattened texels', int(flat.sum()))

    # ---- 形狀：眼睛的凸起收平（之後放圓眼珠）、腮紅壓低，四周的凹陷填平 ----
    def fill(R_, it=2000):
        F_ = V.copy()
        for _ in range(it):
            F_[R_] = T._avg(F_, E, n)[R_]
        return F_
    # 鼻子：原本的凸起收平（之後放黑色鼻珠，才不會疊兩個鼻子）
    R_ = T._grow(FEAT['Nose'], E, n, 3); F_ = fill(R_); V[R_] = F_[R_]
    # 眼睛：凸起和四周的凹陷整個填平（之後放圓眼珠）
    R_ = T._grow(FEAT['Eyes'], E, n, 14); F_ = fill(R_); V[R_] = F_[R_]
    # 腮紅：凸起收平（之後貼扁平的圓餅），吻部的形狀不動
    for c_, r_, _ in CHK:
        d_ = np.linalg.norm(V - c_, axis=1)
        R_ = (d_ < r_ * 1.5) & ~MUZ
        F_ = fill(R_)
        V[R_] = F_[R_]
    # 嘴：口腔深度只留原本的 6%（30% 再減 80%）
    # 嘴洞內部和外面不一定相連：用嘴唇一圈擬合一個平面，平面後面（嘴洞裡）的點拉到只剩 6% 的深度
    mc = FPOS['Mouth'].mean(0)
    rm = np.percentile(np.hypot(FPOS['Mouth'][:, 0] - mc[0], FPOS['Mouth'][:, 2] - mc[2]), 95)
    dxz = np.hypot(V[:, 0] - mc[0], V[:, 2] - mc[2])
    lipr = V[(dxz > rm * 1.15) & (dxz < rm * 1.6) & (V[:, 1] < mc[1] + 0.02)]
    pc = lipr.mean(0); U_, S_, Wt = np.linalg.svd(lipr - pc, full_matrices=False)
    pn = Wt[2] if Wt[2][1] < 0 else -Wt[2]                          # 朝前
    sd = (V - pc) @ pn
    # 嘴洞範圍：原本口腔點的 (x,z) 輪廓（每個方向的最遠距離）再放大一點
    m2c = MOUTH2D.mean(0); a2 = np.arctan2(MOUTH2D[:, 1] - m2c[1], MOUTH2D[:, 0] - m2c[0]); r2 = np.hypot(*(MOUTH2D - m2c).T)
    NB2 = 36; b2 = ((a2 + math.pi) / (2 * math.pi) * NB2).astype(int) % NB2
    rmax = np.array([r2[b2 == k].max() if (b2 == k).any() else np.nan for k in range(NB2)]); ok2 = ~np.isnan(rmax)
    rmax = np.interp(np.arange(NB2), np.arange(NB2)[ok2], rmax[ok2], period=NB2)
    av = np.arctan2(V[:, 2] - m2c[1], V[:, 0] - m2c[0]); rv = np.hypot(V[:, 0] - m2c[0], V[:, 2] - m2c[1])
    inside = rv < rmax[((av + math.pi) / (2 * math.pi) * NB2).astype(int) % NB2] * 1.15 + 0.004
    inm = HOLE
    V[inm, 1] = HOLE_SURF[inm] + (V[inm, 1] - HOLE_SURF[inm]) * 0.06     # 深度只留 6%（嘴洞的點全部拉到吻部表面附近）
    MIDX = inm | (MCAV & inside)
    print('teddy3: mouth verts lifted', int(inm.sum()), 'max depth', round(float(-sd[inm].min()), 3) if inm.any() else 0)
    # 唇珠往上移，讓上唇平滑
    if MCAV.any():
        mtop = V[MCAV, 2].max(); mxc = V[MCAV, 0].mean()
        dx = np.abs(V[:, 0] - mxc)
        lw = np.clip(1 - (dx / 0.05) ** 2, 0, 1) * np.clip(1 - np.abs(V[:, 2] - (mtop - 0.01)) / 0.03, 0, 1) * (V[:, 1] < -0.2)
        V[:, 2] += 0.012 * lw
    # 嘴往上移（人中短一點）：嘴和嘴唇一起，往外漸進
    mw = T._grow(FEAT['Mouth'], E, n, 4).astype(float)
    for _ in range(8):
        mw = np.maximum(mw, 0.5 * mw + 0.5 * T._avg(mw[:, None], E, n)[:, 0] * 0.97)
    mw *= (V[:, 2] < FPOS['Nose'][:, 2].min() + 0.01)
    V[:, 2] += MOUTH_UP * np.clip(mw, 0, 1)
    # 肚子：側面更圓潤（中段往前鼓；只前後推，正面輪廓不變）
    tor = (np.abs(V[:, 0]) < 0.2) & (V[:, 2] > -0.66) & (V[:, 2] < -0.02)
    zs = np.linspace(-0.64, -0.2, 23); prof = []                   # 只到胸口以下（脖子不動）
    for z in zs:
        m = tor & (np.abs(V[:, 2] - z) < 0.012)
        prof.append(V[m, 1].min() if m.any() else np.nan)
    prof = np.array(prof); ok_ = ~np.isnan(prof); prof = np.interp(zs, zs[ok_], prof[ok_])
    base = prof[0] + (prof[-1] - prof[0]) * (zs - zs[0]) / (zs[-1] - zs[0])
    D = (base - prof).max() + BELLY_EXTRA
    uu = np.clip((zs + 0.42) / 0.24, -1, 1)
    tgt = base - D * (0.5 + 0.5 * np.cos(np.pi * uu))                # 平滑的圓弧，不是直的一段
    dy = np.minimum(tgt - prof, 0)                                 # 只往前推
    for _ in range(6):
        dy = np.convolve(np.pad(dy, 2, mode='edge'), np.array([1, 4, 6, 4, 1]) / 16, 'valid')
    front = V[:, 1] < np.interp(V[:, 2], zs, prof) + 0.2
    sm = lambda t: (lambda c: c * c * (3 - 2 * c))(np.clip(t, 0, 1))
    wz = sm((V[:, 2] - zs[0]) / 0.1) * sm((zs[-1] - V[:, 2]) / 0.14)
    wx = np.clip(1 - (np.abs(V[:, 0]) / 0.42) ** 2, 0, 1) ** 1.5   # 鼓的範圍寬一點（不是中間一條凸起）
    V[:, 1] += np.interp(V[:, 2], zs, dy) * wz * wx * front
    print('teddy3: belly push max', round(float(-dy.min()), 3))
    zc_ = zmin + 0.012
    V[V[:, 2] < zc_, 2] = zc_
    me.vertices.foreach_set('co', V.ravel()); me.update()
    bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())

    # ---- 圓眼珠：完整的正圓，往外放（不被臉吃掉）----
    def fit(P_):
        return dict(cx=P_[:, 0].mean(), cz=P_[:, 2].mean(), r=1.0 * (np.ptp(P_[:, 0]) + np.ptp(P_[:, 2])) / 4)
    P_ = FPOS['Eyes']
    beads = []
    for g in (P_[P_[:, 0] < P_[:, 0].mean()], P_[P_[:, 0] >= P_[:, 0].mean()]):
        d = fit(g)
        loc, nor, _, _ = bvh.ray_cast(Vector((d['cx'], -5, d['cz'])), Vector((0, 1, 0)))
        nor = (nor + Vector((0, -1, 0))).normalized()
        up = (Vector((0, 0, 1)) - nor * nor.z).normalized(); right = up.cross(nor).normalized()
        r = d['r'] * 1.05; depth = r * 0.42
        b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=48, v_segments=28, radius=1)
        for v_ in b_.verts:
            a, bb, c = v_.co
            v_.co = loc + right * (a * r) + up * (c * r) + nor * (bb * depth + depth * 0.6)
        bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
        m_ = bpy.data.meshes.new('ey'); b_.to_mesh(m_); b_.free()
        for p_ in m_.polygons:
            p_.use_smooth = True
        beads.append(link('ey', m_))
    eyes = T.fix_out(join(beads, 'Bear_Eyes'))
    # 鼻子：乾淨的亮面黑色小珠（圓角倒三角），蓋住貼圖上粗糙的鼻子
    g = FPOS['Nose']
    loc, nor, _, _ = bvh.ray_cast(Vector((g[:, 0].mean(), -5, g[:, 2].mean())), Vector((0, 1, 0)))
    nor = (nor + Vector((0, -1, 0))).normalized()
    up = (Vector((0, 0, 1)) - nor * nor.z).normalized(); right = up.cross(nor).normalized()
    rx, rz = np.ptp(g[:, 0]) / 2 * 1.15, np.ptp(g[:, 2]) / 2 * 1.1; depth = rx * 0.55
    b_ = bmesh.new(); bmesh.ops.create_uvsphere(b_, u_segments=40, v_segments=24, radius=1)
    for v_ in b_.verts:
        a, bb, c = v_.co
        a *= 0.74 + 0.26 * c
        v_.co = loc + right * (a * rx) + up * (c * rz) + nor * (bb * depth + depth * 0.35)
    bmesh.ops.recalc_face_normals(b_, faces=b_.faces)
    m_ = bpy.data.meshes.new('Bear_Nose'); b_.to_mesh(m_); b_.free()
    for p_ in m_.polygons:
        p_.use_smooth = True
    nose = link('Bear_Nose', m_)
    # 腮紅：兩片扁扁的正圓圓餅（像眼睛一樣），顏色取原本的腮紅；UV 指到貼圖上腮紅最典型的那一點
    ci = np.nonzero(FEAT['Cheeks'])[0]
    ccol = np.array([px[int(vuv[i, 1] * (H - 1)), int(vuv[i, 0] * (W - 1)), :3] for i in ci])
    pink_i0 = int(ci[np.argmin(((ccol - np.median(ccol, 0)) ** 2).sum(1))])
    discs = []
    for c_, r_, _ in CHK:
        loc, nor, _, _ = bvh.ray_cast(Vector((c_[0], -5, c_[2])), Vector((0, 1, 0)))
        dv = (nor * 0.8 + Vector((0, -1, 0)) * 0.2).normalized()
        up = (Vector((0, 0, 1)) - dv * dv.z).normalized(); right = up.cross(dv).normalized()
        R = r_ * 1.25; NS, NR = 72, 8
        db = bmesh.new()
        def place(u, v, off):
            hit = bvh.ray_cast(loc + right * u + up * v + dv * 0.3, -dv)
            return db.verts.new((hit[0] if hit[0] is not None else loc + right * u + up * v) + dv * off)
        cen = place(0, 0, 0.004)
        rings = [[place(R * r * math.cos(t), R * r * math.sin(t), 0.004 * (1 - 0.25 * r ** 4)) for t in np.linspace(0, 2 * math.pi, NS, endpoint=False)] for r in np.linspace(0, 1, NR + 1)[1:]]
        wall = [place(R * math.cos(t), R * math.sin(t), -0.002) for t in np.linspace(0, 2 * math.pi, NS, endpoint=False)]
        for i in range(NS):
            j = (i + 1) % NS
            db.faces.new((cen, rings[0][i], rings[0][j]))
            for ra, rb in zip(rings, rings[1:]):
                db.faces.new((ra[i], rb[i], rb[j], ra[j]))
            db.faces.new((rings[-1][i], wall[i], wall[j], rings[-1][j]))
        for f_ in db.faces:
            f_.normal_update()
            if f_.normal.dot(dv) < 0:
                f_.normal_flip()
        dm = bpy.data.meshes.new('ck'); db.to_mesh(dm); db.free()
        for p_ in dm.polygons:
            p_.use_smooth = True
        discs.append(link('ck', dm))
    cheeks = join(discs, 'Bear_Cheeks')
    # 口腔：照原本嘴洞的輪廓做一片乾淨的紅色口腔，下面一片粉紅舌頭，貼在填淺的嘴上
    M2 = V[MCAV][:, [0, 2]]                                         # 嘴往上移之後的位置
    mcx, mcz = M2.mean(0)
    ang = np.arctan2(M2[:, 1] - mcz, M2[:, 0] - mcx); rad_ = np.hypot(M2[:, 0] - mcx, M2[:, 1] - mcz)
    NB = 48; rb = np.full(NB, np.nan)
    bi = ((ang + math.pi) / (2 * math.pi) * NB).astype(int) % NB
    for k in range(NB):
        if (bi == k).sum() >= 2:
            rb[k] = np.percentile(rad_[bi == k], 92)
    ok = ~np.isnan(rb); idx = np.arange(NB)
    rb = np.interp(idx, idx[ok], rb[ok], period=NB)
    for _ in range(3):
        rb = (np.roll(rb, 1) + 2 * rb + np.roll(rb, -1)) / 4
    th = -math.pi + (idx + 0.5) * 2 * math.pi / NB
    outline = np.stack([mcx + rb * np.cos(th), mcz + rb * np.sin(th)], 1)
    # 換成平滑的張嘴形：上緣微微的弧（上唇平順），下緣圓
    ox0, ox1 = np.percentile(outline[:, 0], [4, 96]); oz0, oz1 = outline[:, 1].min(), np.percentile(outline[:, 1], 85)
    mcx = (ox0 + ox1) / 2; a_w = (ox1 - ox0) / 2 * 0.8; h_t = (oz1 - oz0) * 0.82
    ztop = oz1 + 0.004; tt = np.linspace(0, 2 * math.pi, NB, endpoint=False)
    outline = np.stack([mcx + a_w * np.cos(tt), np.where(np.sin(tt) > 0, ztop + (np.sin(tt) - 1) * 0.12 * h_t, ztop + (np.sin(tt)) * h_t * 1.04)], 1)
    mcz = outline[:, 1].mean()
    rb = np.hypot(outline[:, 0] - mcx, outline[:, 1] - mcz); th = np.arctan2(outline[:, 1] - mcz, outline[:, 0] - mcx)
    order = np.argsort(th); th = th[order]; rb = rb[order]
    idx = np.arange(NB)
    # 嘴周圍一圈擬合平滑曲面，口腔片貼在這個曲面上（不跟著底下不平的網格起伏）
    ring_pts = []
    for t_ in np.linspace(0, 2 * math.pi, 64, endpoint=False):
        for sc_ in (1.25, 1.45, 1.65):
            x_ = mcx + math.cos(t_) * a_w * sc_; z_ = mcz + math.sin(t_) * h_t * 0.75 * sc_
            h_ = bvh.ray_cast(Vector((x_, -5, z_)), Vector((0, 1, 0)))
            if h_[0] is not None:
                ring_pts.append((x_, z_, h_[0].y))
    ring_pts = np.array(ring_pts)
    dsg = lambda x, z: np.stack([np.ones_like(x), x - mcx, z - mcz, (x - mcx) ** 2, (x - mcx) * (z - mcz), (z - mcz) ** 2], -1)
    cfm = np.linalg.lstsq(dsg(ring_pts[:, 0], ring_pts[:, 1]), ring_pts[:, 2], rcond=None)[0]
    MS = lambda x, z: float(dsg(np.array(x), np.array(z)) @ cfm)
    # 口腔範圍內往前凸的臉部網格壓到曲面後面
    def in_poly(P, poly):
        x, z = P[:, 0], P[:, 1]; res_ = np.zeros(len(P), bool)
        for (x1, z1), (x2, z2) in zip(poly, np.roll(poly, -1, 0)):
            c_ = ((z1 > z) != (z2 > z)) & (x < (x2 - x1) * (z - z1) / (z2 - z1 + 1e-12) + x1)
            res_ ^= c_
        return res_
    DEPTH = 0.022                                                    # 嘴微微往內凹（像耳鼻猴）
    DISH = lambda r: DEPTH * (1 - min(r, 1.0) ** 2) ** 1.5 if r < 1.0 else 0.0
    # 嘴周圍的臉部網格：輪廓內完全貼到曲面（稍微在口腔片後面），輪廓外 1.0～1.5 倍之間平滑過渡
    av_ = np.arctan2(V[:, 2] - mcz, V[:, 0] - mcx); rv_ = np.hypot(V[:, 0] - mcx, V[:, 2] - mcz)
    ratio = rv_ / np.interp(av_, th, rb, period=2 * math.pi)
    front = V[:, 1] < -0.1
    pushed = 0
    for i in np.nonzero(front & (ratio < 1.5))[0]:
        tgt_ = MS(V[i, 0], V[i, 2]) + 0.0015 + DISH(ratio[i])
        w_ = 1.0 if ratio[i] <= 1.05 else (1 - (ratio[i] - 1.05) / 0.45)
        w_ = w_ * w_ * (3 - 2 * w_)
        if abs(V[i, 1] - tgt_) < 0.12:
            me.vertices[i].co.y = V[i, 1] + (tgt_ - V[i, 1]) * w_; pushed += 1
    me.update()
    print('teddy3: verts pushed behind mouth patch', pushed)
    def flat_patch(poly, off, name):
        db = bmesh.new(); NR = 6; cx_, cz_ = poly.mean(0)
        def place(x, z, o):
            r_ = math.hypot(x - mcx, z - mcz) / np.interp(math.atan2(z - mcz, x - mcx), th, rb, period=2 * math.pi)
            return db.verts.new(Vector((x, MS(x, z) - o + DISH(r_), z)))
        cen = place(cx_, cz_, off)
        rings = [[place(cx_ + (x - cx_) * t, cz_ + (z - cz_) * t, off) for x, z in poly] for t in np.linspace(0, 1, NR + 1)[1:]]
        wall = [place(x, z, -0.008) for x, z in poly]
        m = len(poly)
        for i in range(m):
            j = (i + 1) % m
            db.faces.new((cen, rings[0][i], rings[0][j]))
            for ra, rb_ in zip(rings, rings[1:]):
                db.faces.new((ra[i], rb_[i], rb_[j], ra[j]))
            db.faces.new((rings[-1][i], wall[i], wall[j], rings[-1][j]))
        for f_ in db.faces:
            f_.normal_update()
            if f_.normal.y > 0:
                f_.normal_flip()
        dm = bpy.data.meshes.new(name); db.to_mesh(dm); db.free()
        for p_ in dm.polygons:
            p_.use_smooth = True
        return link(name, dm)
    mouth_o = flat_patch(outline, 0.0015, 'Bear_Mouth')
    w_ = np.ptp(outline[:, 0]); h_ = np.ptp(outline[:, 1]); zb = outline[:, 1].min()
    tt = np.linspace(0, 2 * math.pi, 48, endpoint=False)
    tpoly = np.stack([mcx + 0.3 * w_ * np.cos(tt), zb + 0.24 * h_ + 0.2 * h_ * np.sin(tt)], 1)
    for i, (x, z) in enumerate(tpoly):                               # 舌頭不超出口腔輪廓
        a_ = math.atan2(z - mcz, x - mcx)
        rr = math.hypot(x - mcx, z - mcz); lim = np.interp(a_, th, rb, period=2 * math.pi) * 0.9
        if rr > lim:
            tpoly[i] = [mcx + (x - mcx) * lim / rr, mcz + (z - mcz) * lim / rr]
    tongue_o = flat_patch(tpoly, 0.0028, 'Bear_Tongue')
    print('teddy3: mouth patch w/h', round(float(w_), 3), round(float(h_), 3))
    # ---- 尾巴：背後腰下方中央；貼圖取背上的毛色 ----
    hit = bvh.ray_cast(Vector((0.0, 5, -0.45)), Vector((0, -1, 0)))[0]
    cand = np.nonzero((V[:, 1] > 0.15) & (np.abs(V[:, 0]) < 0.25) & (V[:, 2] > -0.5) & (V[:, 2] < -0.1))[0]
    cols = np.array([px[int(vuv[i, 1] * (H - 1)), int(vuv[i, 0] * (W - 1)), :3] for i in cand])
    med = np.median(cols, 0)
    back_i = int(cand[np.argmin(((cols - med) ** 2).sum(1))])       # 背上顏色最接近整體毛色的那一點
    TR = 0.1
    tb = bmesh.new(); bmesh.ops.create_uvsphere(tb, u_segments=40, v_segments=24, radius=TR)
    for v_ in tb.verts:
        v_.co += Vector((hit.x, hit.y + TR / 3, hit.z))             # 2/3 的球露在外面（高度 4/3 R）
    tm = bpy.data.meshes.new('Bear_Tail'); tb.to_mesh(tm); tb.free()
    uvt = tm.uv_layers.new(name='UVMap')
    for lp in uvt.data:
        lp.uv = vuv[back_i]
    for p_ in tm.polygons:
        p_.use_smooth = True
    tail = link('Bear_Tail', tm)

    # ---- 腳底肉球（使用者給的圖樣），顏色和腮紅一樣：UV 指到貼圖上腮紅最典型的那一點 ----
    ci = np.nonzero(FEAT['Cheeks'])[0]
    ccol = np.array([px[int(vuv[i, 1] * (H - 1)), int(vuv[i, 0] * (W - 1)), :3] for i in ci])
    pink_i = int(ci[np.argmin(((ccol - np.median(ccol, 0)) ** 2).sum(1))])
    Vn = np.array([v.co[:] for v in me.vertices])
    zs_ = Vn[:, 2].min(); solev = Vn[Vn[:, 2] < zs_ + 1e-4]
    pads = bmesh.new()
    PAT = [(372, 415, 174), (142, 218, 57), (291, 132, 57), (454, 132, 57), (602, 218, 57)]
    xmid = solev[:, 0].mean()
    for fm in (solev[solev[:, 0] < xmid], solev[solev[:, 0] >= xmid]):
        if len(fm) < 10:
            continue
        fx, fy = (fm[:, 0].min() + fm[:, 0].max()) / 2, (fm[:, 1].min() + fm[:, 1].max()) / 2
        k = min(0.8 * np.ptp(fm[:, 0]) / 575, 0.8 * np.ptp(fm[:, 1]) / 514)
        for px_, py_, pr in PAT:
            c = Vector((fx + (px_ - 372.5) * k, fy + (py_ - 332) * k, zs_ - 0.0012))
            ring = [pads.verts.new(c + Vector((math.cos(t) * pr * k, math.sin(t) * pr * k, 0))) for t in np.linspace(0, 2 * math.pi, 48, endpoint=False)]
            cv_ = pads.verts.new(c)
            for i in range(48):
                f_ = pads.faces.new((cv_, ring[(i + 1) % 48], ring[i])); f_.normal_update()
                if f_.normal.z > 0:
                    f_.normal_flip()
    pm = bpy.data.meshes.new('Bear_Pads'); pads.to_mesh(pm); pads.free()
    uvp = pm.uv_layers.new(name='UVMap')
    for lp in uvp.data:
        lp.uv = vuv[pink_i]
    padso = link('Bear_Pads', pm)
    print('teddy3: soles', len(solev), 'pad color', np.round(px[int(vuv[pink_i, 1] * (H - 1)), int(vuv[pink_i, 0] * (W - 1)), :3], 3))

    ob.name = me.name = 'Bear_Skin'
    # 耳朵內側的粉色分出來（網站用和秤秤腮紅同一種霧面材質，顏色還是貼圖）
    uvd_ = me.uv_layers.active.data
    Vz = np.array([v.co[:] for v in me.vertices]); ztop_ = Vz[:, 2].max(); hgt = ztop_ - Vz[:, 2].min()
    FCb = np.array([p_.center[:] for p_ in me.polygons])
    COLb = np.array([np.array([px[int(uvd_[l].uv[1] * (H - 1)), int(uvd_[l].uv[0] * (W - 1)), :3] for l in p_.loop_indices]).mean(0) for p_ in me.polygons])
    NRb = np.array([p_.normal[:] for p_ in me.polygons])
    earin = (FCb[:, 2] > ztop_ - hgt * 0.22) & (np.abs(FCb[:, 0]) > 0.28) & (NRb[:, 1] < -0.2) & (COLb[:, 0] - COLb[:, 1] > 0.3) & (COLb[:, 1] < 0.52)
    print('teddy3: ear-inner faces', int(earin.sum()), 'col', np.round(np.median(COLb[earin], 0), 3) if earin.any() else None)
    NKEYb = {tuple(np.round(v_.co[:], 5)): v_.normal.copy() for v_ in me.vertices}
    for v_ in me.vertices:
        v_.select = False
    for e_ in me.edges:
        e_.select = False
    for p_, m_ in zip(me.polygons, earin):
        p_.select = bool(m_)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.separate(type='SELECTED'); bpy.ops.object.mode_set(mode='OBJECT')
    earo = [o for o in bpy.context.selected_objects if o is not ob][0]
    earo.name = earo.data.name = 'Bear_EarIn'
    for o2 in (ob, earo):
        o2.data.normals_split_custom_set_from_vertices([NKEYb.get(tuple(np.round(v_.co[:], 5)), v_.normal) for v_ in o2.data.vertices])
    parts = [ob, eyes, tail, padso, nose, cheeks, mouth_o, tongue_o, earo]
    for o in parts:
        o['nocap'] = 1
    K = 338 / 150 * 0.48
    off = Vector((0, 0, -zc_))
    for o in parts:
        o.data.transform(Matrix.Translation(off))
        o.data.transform(Matrix.Diagonal((K, K, K, 1)))
    print('teddy3: parts', {o.name: len(o.data.polygons) for o in parts})
    return parts
