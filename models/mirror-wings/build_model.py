# -*- coding: utf-8 -*-
"""《以碎為翼》（2013）— 碎鏡片拼成的翅膀，裝在木框裡，底襯深咖啡色絨布。

用法：
    /Applications/Blender.app/Contents/MacOS/Blender -b -P build_model.py

輸出（都在這個腳本所在的資料夾）：
    mirror_wings.blend      Blender 檔
    mirror_wings.glb        給網頁用的模型（單位公尺，+y 朝上，正面朝 +z，原點在木框正中央）
    preview_*.png           多角度預覽（正面、側面、背面、3/4 斜角、上方）
    index.html              若存在，會把新的 GLB 以 base64 寫回頁面裡

GLB 裡的 mesh：Shards_Mirror（鏡面，朝前的那一面）、Shards_Edge（鏡片的側邊與背面）、
Velvet（絨布）、Frame（木框）、Backboard（背板）。材質在 room.js / index.html 設定，GLB 不帶材質。

隨機種子固定，每次產生的結果相同。這件作品沒有任何動態。
"""
import bpy, os, sys, math, json, struct, random, base64, re
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20130323
rnd = random.Random(SEED)

# ---------------------------------------------------------------- 尺寸（公尺；x 右、y 上、z 朝前）
FRAME_W, FRAME_H = 0.52, 0.40      # 木框外尺寸
BAR = 0.025                        # 框條寬
DEPTH = 0.05                       # 框深
CHAMFER = 0.0015
IX, IY = FRAME_W / 2 - BAR, FRAME_H / 2 - BAR     # 框內緣半寬、半高
MARGIN = 0.02                      # 翅膀與框內緣至少留的距離
LIMX, LIMY = IX - MARGIN, IY - MARGIN
ZF, ZB = DEPTH / 2, -DEPTH / 2
VELVET_BASE = 0.010                # 絨布平面的 z（框前緣是 +0.025）
CM = 0.01
ZTOP = VELVET_BASE + 0.038          # 碎片最高點（肩部往前隆起約 3–4 公分）

# ---------------------------------------------------------------- 翅膀骨架（右翼，公分；左翼鏡射）
# S：上緣（肩、臂）由中央往外；E：對應的羽毛末端。羽毛沿著 S(u)→E(u) 垂掛。
S_PTS = np.array([(0.3, 6.3), (3.6, 8.0), (7.2, 10.8), (10.6, 12.4), (13.9, 11.2), (16.4, 7.6), (17.9, 2.5), (18.4, -2.5)]) * CM
E_PTS = np.array([(0.3, 0.8), (3.0, 0.3), (5.3, -3.5), (6.8, -8.5), (9.3, -12.4), (13.3, -14.0), (17.3, -14.4), (20.0, -13.6)]) * CM


def cr(pts, u):
    n = len(pts) - 1
    f = min(max(u, 0.0), 1.0) * n
    i = min(int(f), n - 1)
    t = f - i
    p0, p1, p2, p3 = pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, n)]
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def ray(u):
    s, e = cr(S_PTS, u), cr(E_PTS, u)
    v = e - s
    L = float(np.hypot(*v))
    return s, v / L, L


LR_MAX = max(ray(i / 50)[2] for i in range(51))

# ---------------------------------------------------------------- 絨布高度場
# 翅膀底下的絨布微微鼓起（肩部最高），碎片堆在上面才有體積、從側面看不會懸空。
_sp = []
for i in range(41):
    u = i / 40
    s, d, L = ray(u)
    _sp.append((s[0], s[1], 0.016, 0.021))
    for j in range(1, 17):
        v = j / 16
        p = s + d * L * v
        _sp.append((p[0], p[1], 0.0085 * (1 - 0.85 * v), 0.017))
_sp = np.array(_sp)
SPLAT = np.concatenate([_sp, _sp * np.array([-1, 1, 1, 1])])

# 皺褶：多半從框邊、角落往裡走
FOLDS = []
frnd = random.Random(SEED + 7)
for i in range(30):
    side = frnd.choice('LRTTBLR')
    if side == 'L':
        p = (-IX + frnd.uniform(0, .03), frnd.uniform(-IY, IY)); a = frnd.uniform(-0.9, 0.9)
    elif side == 'R':
        p = (IX - frnd.uniform(0, .03), frnd.uniform(-IY, IY)); a = math.pi + frnd.uniform(-0.9, 0.9)
    elif side == 'T':
        p = (frnd.uniform(-IX, IX), IY - frnd.uniform(0, .03)); a = -math.pi / 2 + frnd.uniform(-1.1, 1.1)
    else:
        p = (frnd.uniform(-IX, IX), -IY + frnd.uniform(0, .02)); a = math.pi / 2 + frnd.uniform(-1.1, 1.1)
    FOLDS.append((p[0], p[1], math.cos(a), math.sin(a), frnd.uniform(.06, .18), frnd.uniform(.006, .017), frnd.uniform(.005, .0115)))
# 幾條沿著框邊堆起來的皺褶
for (px, py, a, ln) in [(-IX + .022, 0.02, math.pi / 2, .13), (IX - .02, -0.03, math.pi / 2, .12), (0.05, IY - .02, 0.1, .16), (-0.09, IY - .028, -0.12, .1), (0.0, -IY + .018, 0.05, .15)]:
    FOLDS.append((px - math.cos(a) * ln / 2, py - math.sin(a) * ln / 2, math.cos(a), math.sin(a), ln, .011, .0075))
FOLDS = np.array(FOLDS)


def velvet_h(x, y):
    """絨布表面的 z。x、y 可以是純量或陣列。"""
    x = np.asarray(x, dtype=np.float64); y = np.asarray(y, dtype=np.float64)
    shp = x.shape
    xf, yf = x.reshape(-1, 1), y.reshape(-1, 1)
    d2 = (xf - SPLAT[:, 0]) ** 2 + (yf - SPLAT[:, 1]) ** 2
    pad = np.max(SPLAT[:, 2] * np.exp(-d2 / SPLAT[:, 3] ** 2), axis=1)
    wing = np.clip(pad / 0.006, 0, 1)                      # 翅膀底下皺褶變淺
    fx, fy = xf - FOLDS[:, 0], yf - FOLDS[:, 1]
    al = fx * FOLDS[:, 2] + fy * FOLDS[:, 3]
    ac = -fx * FOLDS[:, 3] + fy * FOLDS[:, 2]
    t = np.clip(al / FOLDS[:, 4], 0, 1)
    taper = np.sin(t * math.pi) ** 0.8 * (al > 0) * (al < FOLDS[:, 4])
    fold = np.sum(FOLDS[:, 6] * taper * np.exp(-(ac / FOLDS[:, 5]) ** 2), axis=1)
    xf, yf = xf[:, 0], yf[:, 0]
    low = 0.0022 * np.sin(xf * 21 + 1.3) * np.sin(yf * 17 + 0.4) + 0.0012 * np.sin(xf * 43 + yf * 29 + 2.0) + 0.0006 * np.sin(xf * 90 - yf * 70)
    e = np.minimum(IX - np.abs(xf), IY - np.abs(yf))
    edge_puff = 0.003 * np.exp(-((e - 0.02) / 0.012) ** 2)  # 靠框邊塞進去之前鼓起一圈
    h = VELVET_BASE + pad + (fold + low) * (1 - 0.75 * wing) + edge_puff
    tuck = smooth(0.0, 0.014, e)
    h = 0.001 + (h - 0.001) * tuck
    return h.reshape(shp)


# ---------------------------------------------------------------- 碎片
mir_pos, mir_nrm, mir_idx = [], [], []
edge_pos, edge_idx = [], []
counts = {'feather': 0, 'medium': 0, 'crumb': 0}


def rot(yaw, pitch, roll):
    cy, sy, cp, sp_, cr_, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    Ry = np.array([[cp, 0, sp_], [0, 1, 0], [-sp_, 0, cp]])     # pitch > 0：尖端往下
    Rx = np.array([[1, 0, 0], [0, cr_, -sr], [0, sr, cr_]])
    return Rz @ Ry @ Rx


def plate_world(ring, origin, R, th):
    n = len(ring)
    loc = np.zeros((2 * n, 3))
    loc[:n, :2] = ring; loc[:n, 2] = th
    loc[n:, :2] = ring
    return loc @ R.T + origin


def inside(w):
    return np.all(np.abs(w[:, 0]) <= LIMX - 1e-4) and np.all(np.abs(w[:, 1]) <= LIMY - 1e-4) and np.all(w[:, 0] >= 0.0005)


def emit(w, tris, R, mirror):
    """w：2n 個頂點（前 n 個是鏡面那一圈，後 n 個是背面那一圈）。tris：鏡面的三角形。"""
    n = len(w) // 2
    w = w.copy()
    nrm = R[:, 2].copy()
    tris = [tuple(t) for t in tris]
    if mirror:
        w[:, 0] *= -1; nrm[0] *= -1
    flip = (lambda t: (t[0], t[2], t[1])) if mirror else (lambda t: t)
    b = len(mir_pos)
    mir_pos.extend(w[:n].tolist()); mir_nrm.extend([nrm.tolist()] * n)
    mir_idx.extend([tuple(b + i for i in flip(t)) for t in tris])
    b = len(edge_pos)
    edge_pos.extend(w.tolist())
    for i in range(n):
        j = (i + 1) % n
        edge_idx.append(tuple(b + k for k in flip((i, n + i, n + j))))
        edge_idx.append(tuple(b + k for k in flip((i, n + j, j))))
    for t in tris:
        edge_idx.append(tuple(b + n + k for k in flip((t[0], t[2], t[1]))))


def lance(r, L, hw, k, bend, root=0.5):
    """細長、尖端銳利的碎鏡片。回傳逆時針的輪廓與三角形。a 軸沿長度方向，根在 0、尖在 L。"""
    sm = r.uniform(0.18, 0.38)
    p = r.uniform(0.8, 1.35)
    st = [0.0] + sorted((i + r.uniform(0.25, 0.75)) / (k + 0.6) for i in range(k))
    st = [min(s, 0.93) for s in st]

    def f(s):
        if s < sm:
            return root + (1 - root) * (s / sm) ** 0.7
        return max((1 - s) / (1 - sm), 0.0) ** p

    Rr, Ll = [], []
    skew = r.uniform(-0.12, 0.12)
    for i, s in enumerate(st):
        c = bend * L * s * s
        for side, out in ((-1, Rr), (1, Ll)):
            w = hw * f(s) * r.uniform(0.88, 1.08)
            if i > 0 and r.random() < 0.10:
                w *= r.uniform(0.6, 0.82)                   # 缺一角
            a = s * L + r.uniform(-0.02, 0.02) * L * (i > 0) + (side * skew * L * 0.5 if i == 0 else 0)
            out.append((a, c + side * w))
    tip = (L, bend * L + r.uniform(-0.1, 0.1) * hw)
    ring = Rr + [tip] + Ll[::-1]
    K = len(st) - 1
    tris = []
    Li = lambda i: 2 * K + 2 - i
    for i in range(K):
        tris += [(i, i + 1, Li(i + 1)), (i, Li(i + 1), Li(i))]
    tris.append((K, K + 1, Li(K)))
    return np.array(ring), tris


def crumb(r, rad):
    m = r.choice((3, 4, 4, 5, 5, 6))
    off = r.uniform(0, 6.28)
    ang = [off + (i + r.uniform(-0.3, 0.3)) * 2 * math.pi / m for i in range(m)]
    el = r.uniform(1.0, 2.6)
    ring = [(math.cos(a) * rad * r.uniform(0.55, 1.0) * el, math.sin(a) * rad * r.uniform(0.55, 1.0)) for a in ang]
    return np.array(ring), [(0, i, i + 1) for i in range(1, m - 1)]


def pick_u(r, lo=0.0, hi=1.0, weighted=True):
    while True:
        u = r.uniform(lo, hi)
        if not weighted or r.random() < ray(u)[2] / LR_MAX:
            return u


def zones(L):
    return min(0.035, 0.5 * L), min(0.07, 0.75 * L)        # 碎屑帶、中型碎片帶的外緣（離上緣的距離）


def build_wing(mirror, n_feather, n_medium, n_crumb, seed):
    r = random.Random(seed)
    # ---- 羽毛：一排一排往下，越下方越長，上面的壓著下面的
    def feather(u, v, jit=1.0):
        s, d, L = ray(u)
        dc, dm = zones(L)
        vv = min(max((v - 0.25) / 0.65, 0.0), 1.0)
        Lf = (0.032 + 0.068 * vv ** 1.1) * r.uniform(0.85, 1.12)
        Lf = min(Lf, L * (0.5 + 0.38 * float(smooth(0.5, 0.8, u))), 0.102)
        dr = min(v * L - 0.35 * Lf, L - 0.92 * Lf)
        if dr < dc * 0.7:
            return False
        root = s + d * dr + np.array([-d[1], d[0]]) * r.uniform(-0.003, 0.003) * jit
        sweep = math.radians(4 + 38 * u) * (min(dr / L + 0.5 * Lf / L, 1.0) ** 1.4) + math.radians(r.gauss(0, 4.5 * jit))
        yaw = math.atan2(d[1], d[0]) + sweep
        hw = r.uniform(0.0085, 0.0145) * (0.75 + 0.3 * (Lf / 0.08))
        hw = min(hw, Lf * 0.33)
        bend = r.gauss(0.03 + 0.13 * u * vv, 0.04)
        ring, tris = lance(r, Lf, hw, r.choice((2, 3, 3, 4)), bend, root=r.uniform(0.4, 0.75))
        for attempt in range(8):
            dirv = np.array([math.cos(yaw), math.sin(yaw)])
            tip = root + dirv * Lf

            def fb(p):
                dd = float(np.dot(p - s, d))
                t = min(max((dd - dc) / max(L - dc, 1e-6), 0.0), 1.0)
                return 0.0085 * (1 - t) ** 1.2 + 0.0012
            zr = float(velvet_h(root[0], root[1])) + fb(root) + r.uniform(0, 0.002)
            zt = float(velvet_h(tip[0], tip[1])) + fb(tip) + 0.003 + r.uniform(0, 0.005)
            pitch = math.asin(max(min((zr - zt) / Lf, 0.5), -0.5)) + math.radians(r.gauss(0, 4.0))
            R = rot(yaw, pitch, math.radians(r.gauss(0, 8.5)))
            w = plate_world(ring, np.array([root[0], root[1], zr]), R, 0.0025)
            if inside(w):
                lift = float(np.max(velvet_h(w[:, 0], w[:, 1]) + 0.0012 - w[:, 2]))   # 不要插進絨布
                if lift > 0:
                    w[:, 2] += lift
                emit(w, tris, R, mirror); counts['feather'] += 1
                return hw
            if attempt < 4:
                root = root - d * 0.006                      # 往上縮回去
                root[0] = max(root[0], 0.004)
            else:
                ring = ring * 0.85; Lf *= 0.85
        return False

    NR = 7
    for j in range(NR):
        v = 0.26 + 0.66 * j / (NR - 1)
        u, prev, need = 0.0, None, 0.0
        acc = r.uniform(0, 0.01)
        while u <= 1.0:
            s, d, L = ray(u)
            p = s + d * L * v
            if prev is not None:
                acc += float(np.hypot(*(p - prev)))
            prev = p
            if acc >= need:
                # 中央的羽毛短，排與排之間太擠時跳過一些
                row_gap = L * 0.66 / (NR - 1)
                if r.random() < min(1.0, row_gap / 0.012):
                    hw = feather(u, v + r.uniform(-0.03, 0.03))
                    need = (hw or 0.009) * r.uniform(1.45, 2.0)
                else:
                    need = 0.012
                acc = 0.0
            u += 0.004
    for i in range(n_feather):                               # 再補一些不在排上的，打破規律
        feather(pick_u(r), r.uniform(0.3, 0.95), 1.6)
    # ---- 中型碎片：碎屑與羽毛之間
    made = tries = 0
    while made < n_medium and tries < n_medium * 30:
        tries += 1
        u = pick_u(r, weighted=False)
        s, d, L = ray(u)
        dc, dm = zones(L)
        dd = r.uniform(0.006, dm + 0.012)
        Lf = r.uniform(0.016, 0.04) * (0.75 + 0.5 * dd / (dm + 0.012))
        root = s + d * dd + np.array([-d[1], d[0]]) * r.uniform(-0.008, 0.008)
        yaw = math.atan2(d[1], d[0]) + math.radians(r.gauss(0, 22))
        ring, tris = lance(r, Lf, min(r.uniform(0.005, 0.0095), Lf * 0.36), r.choice((2, 2, 3)), r.gauss(0, 0.06), root=r.uniform(0.4, 0.85))
        t = min(dd / (dm + 0.012), 1.0)
        z = float(velvet_h(root[0], root[1])) + 0.003 + r.uniform(0.2, 1.0) * (0.017 - 0.008 * t) * math.exp(-((max(dd - 0.01, 0) / 0.06) ** 2))
        R = rot(yaw, math.radians(r.gauss(-3, 9)), math.radians(r.gauss(0, 12)))
        w = plate_world(ring, np.array([root[0], root[1], z]), R, 0.0025)
        if not inside(w):
            continue
        lift = float(np.max(velvet_h(w[:, 0], w[:, 1]) + 0.001 - w[:, 2]))
        if lift > 0:
            w[:, 2] += min(lift, 0.004)
        over = float(w[:, 2].max()) - ZTOP
        if over > 0:
            w[:, 2] -= over
        emit(w, tris, R, mirror); made += 1; counts['medium'] += 1
    # ---- 肩部與上緣的細碎玻璃：小而密，往前隆起
    made = tries = 0
    while made < n_crumb and tries < n_crumb * 30:
        tries += 1
        u = pick_u(r, weighted=False)
        s, d, L = ray(u)
        dc, dm = zones(L)
        dd = r.gauss(0.008, 0.017)
        if dd < -0.016 or dd > dc + 0.012:
            continue
        nrm2 = np.array([-d[1], d[0]])
        c = s + d * dd + nrm2 * r.uniform(-0.006, 0.006)
        if u < 0.04:
            c[0] = abs(c[0])
        hc = 0.021 * math.exp(-((dd - 0.008) / 0.024) ** 2) * (0.8 + 0.2 * math.sin(u * 9.0 + 1.0))
        q = r.random() ** 0.7
        rad = r.uniform(0.0028, 0.0085) * (1.15 - 0.45 * q)
        ring, tris = crumb(r, rad)
        z = float(velvet_h(c[0], c[1])) + 0.0015 + q * hc
        tilt = 30 if q > 0.4 else 20
        R = rot(r.uniform(0, 6.283), math.radians(r.gauss(0, tilt)), math.radians(r.gauss(0, tilt)))
        w = plate_world(ring, np.array([c[0], c[1], z]), R, 0.002)
        if not (np.all(np.abs(w[:, 0]) <= LIMX - 1e-4) and np.all(np.abs(w[:, 1]) <= LIMY - 1e-4)):
            continue
        over = float(w[:, 2].max()) - ZTOP
        if over > 0:
            w[:, 2] -= over
        emit(w, tris, R, mirror); made += 1; counts['crumb'] += 1


N_FEATHER, N_MEDIUM, N_CRUMB = 28, 210, 1300
build_wing(False, N_FEATHER, N_MEDIUM, N_CRUMB, SEED + 1)
build_wing(True, N_FEATHER, N_MEDIUM, N_CRUMB, SEED + 2)

mir_pos = np.array(mir_pos, dtype=np.float32); mir_nrm = np.array(mir_nrm, dtype=np.float32); mir_idx = np.array(mir_idx, dtype=np.uint32)
edge_pos = np.array(edge_pos, dtype=np.float32); edge_idx = np.array(edge_idx, dtype=np.uint32)

# ---------------------------------------------------------------- 自動檢查：所有碎片都在框的內緣範圍內
allp = np.concatenate([mir_pos, edge_pos])
mx, my = float(np.max(np.abs(allp[:, 0]))), float(np.max(np.abs(allp[:, 1])))
print('[檢查] 碎片範圍 x ±%.4f（框內緣 ±%.4f） y %.4f ~ %.4f（框內緣 ±%.4f） z %.4f ~ %.4f（框前緣 %.3f）' % (
    mx, IX, float(allp[:, 1].min()), float(allp[:, 1].max()), IY, float(allp[:, 2].min()), float(allp[:, 2].max()), ZF))
if mx > IX - MARGIN + 1e-6 or my > IY - MARGIN + 1e-6:
    print('[錯誤] 有碎片超出框的內緣範圍（需留 %.0f 公分）' % (MARGIN * 100))
    sys.exit(1)
if float(allp[:, 2].min()) < 0.0:
    print('[錯誤] 有碎片沉到絨布底下'); sys.exit(1)
print('[檢查] 通過：所有碎片都在框內，四周至少留 %.1f 公分' % (min(IX - mx, IY - my) * 100))

# ---------------------------------------------------------------- 絨布
NXV, NYV = 150, 112
gx = np.linspace(-IX - 0.0005, IX + 0.0005, NXV)
gy = np.linspace(-IY - 0.0005, IY + 0.0005, NYV)
GX, GY = np.meshgrid(gx, gy)
GZ = velvet_h(np.clip(GX, -IX, IX), np.clip(GY, -IY, IY))
dzdy, dzdx = np.gradient(GZ, gy, gx)
vn = np.stack([-dzdx, -dzdy, np.ones_like(GZ)], axis=-1)
vn /= np.linalg.norm(vn, axis=-1, keepdims=True)
vel_pos = np.stack([GX, GY, GZ], axis=-1).reshape(-1, 3).astype(np.float32)
vel_nrm = vn.reshape(-1, 3).astype(np.float32)
vel_uv = np.stack([(GX + IX) / (2 * IX), (GY + IY) / (2 * IX)], axis=-1).reshape(-1, 2).astype(np.float32)
ii = np.arange(NXV * NYV).reshape(NYV, NXV)
a, b, c, d = ii[:-1, :-1].ravel(), ii[:-1, 1:].ravel(), ii[1:, 1:].ravel(), ii[1:, :-1].ravel()
vel_idx = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)]).astype(np.uint32)


# ---------------------------------------------------------------- 木框與背板（平面著色，帶 UV）
class Quads:
    def __init__(self):
        self.p, self.n, self.uv, self.i = [], [], [], []

    def quad(self, A, B, C, D, uvs, outward):
        A, B, C, D = (np.array(v, dtype=np.float64) for v in (A, B, C, D))
        n = np.cross(B - A, D - A); n /= np.linalg.norm(n)
        pts, uv = [A, B, C, D], list(uvs)
        if np.dot(n, outward) < 0:
            pts, uv, n = [A, D, C, B], [uv[0], uv[3], uv[2], uv[1]], -n
        b = len(self.p)
        self.p += [q.tolist() for q in pts]; self.n += [n.tolist()] * 4; self.uv += uv
        self.i += [(b, b + 1, b + 2), (b, b + 2, b + 3)]

    def arrays(self):
        return np.array(self.p, np.float32), np.array(self.n, np.float32), np.array(self.uv, np.float32), np.array(self.i, np.uint32)


fr = Quads()
prof = [(0, ZB), (0, ZF - CHAMFER), (CHAMFER, ZF), (BAR - CHAMFER, ZF), (BAR, ZF - CHAMFER), (BAR, ZB)]
plen = [0.0]
for j in range(len(prof)):
    p, q = prof[j], prof[(j + 1) % len(prof)]
    plen.append(plen[-1] + math.hypot(q[0] - p[0], q[1] - p[1]))
corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
UVS, UVS_V = 2.2, 13.0                             # 木紋貼圖：沿框條約 45 公分一個週期，橫向約 7.7 公分
for k in range(4):
    c0, c1 = corners[k], corners[(k + 1) % 4]
    ax = np.array([c1[0] - c0[0], c1[1] - c0[1], 0.0]) / 2.0
    uoff = k * 0.37
    P = lambda cn, pr: np.array([cn[0] * (FRAME_W / 2 - pr[0]), cn[1] * (FRAME_H / 2 - pr[0]), pr[1]])
    mid = (P(c0, (BAR / 2, 0)) + P(c1, (BAR / 2, 0))) / 2
    for j in range(len(prof)):
        p, q = prof[j], prof[(j + 1) % len(prof)]
        A, B, C, D = P(c0, p), P(c1, p), P(c1, q), P(c0, q)
        cen = (A + B + C + D) / 4
        out = cen - mid; out -= ax * np.dot(out, ax)
        uv = [(float(np.dot(X, ax)) * UVS + uoff, plen[j if n < 2 else j + 1] * UVS_V) for n, X in enumerate((A, B, C, D))]
        fr.quad(A, B, C, D, uv, out)
frame_pos, frame_nrm, frame_uv, frame_idx = fr.arrays()

bb = Quads()
BX, BY, BZ0, BZ1 = IX + 0.001, IY + 0.001, ZB + 0.002, ZB + 0.008
for z, o in ((BZ1, (0, 0, 1)), (BZ0, (0, 0, -1))):
    bb.quad((-BX, -BY, z), (BX, -BY, z), (BX, BY, z), (-BX, BY, z), [(0, 0), (1, 0), (1, BY / BX), (0, BY / BX)], np.array(o, float))
back_pos, back_nrm, back_uv, back_idx = bb.arrays()

MESHES = [
    ('Shards_Mirror', mir_pos, mir_nrm, None, mir_idx),
    ('Shards_Edge', edge_pos, None, None, edge_idx),     # 不存法線：載入後自動計算
    ('Velvet', vel_pos, vel_nrm, vel_uv, vel_idx),
    ('Frame', frame_pos, frame_nrm, frame_uv, frame_idx),
    ('Backboard', back_pos, back_nrm, back_uv, back_idx),
]


# ---------------------------------------------------------------- 寫 GLB（自己寫，檔案小、結構固定）
def write_glb(path):
    binb = bytearray(); views, accs, meshes, nodes = [], [], [], []

    def add(arr, target, typ, ctype, minmax=False):
        while len(binb) % 4:
            binb.append(0)
        raw = arr.tobytes()
        views.append({'buffer': 0, 'byteOffset': len(binb), 'byteLength': len(raw), 'target': target})
        binb.extend(raw)
        a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': int(arr.shape[0] if typ != 'SCALAR' else arr.size), 'type': typ}
        if minmax:
            a['min'] = [float(v) for v in arr.min(axis=0)]; a['max'] = [float(v) for v in arr.max(axis=0)]
        accs.append(a)
        return len(accs) - 1

    for name, pos, nrm, uv, idx in MESHES:
        attr = {'POSITION': add(pos.astype(np.float32), 34962, 'VEC3', 5126, True)}
        if nrm is not None:
            attr['NORMAL'] = add(nrm.astype(np.float32), 34962, 'VEC3', 5126)
        if uv is not None:
            u2 = uv.astype(np.float32).copy(); u2[:, 1] = 1 - u2[:, 1]         # glTF 的 v 軸朝下
            attr['TEXCOORD_0'] = add(u2, 34962, 'VEC2', 5126)
        flat = idx.ravel()
        if len(pos) < 65535:
            ia = add(flat.astype(np.uint16), 34963, 'SCALAR', 5123)
        else:
            ia = add(flat.astype(np.uint32), 34963, 'SCALAR', 5125)
        meshes.append({'name': name, 'primitives': [{'attributes': attr, 'indices': ia, 'mode': 4}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
    while len(binb) % 4:
        binb.append(0)
    nodes.append({'name': 'MirrorWings', 'children': list(range(len(MESHES))),
                  'extras': {'frame': [FRAME_W, FRAME_H, DEPTH], 'shards': sum(counts.values())}})
    doc = {'asset': {'version': '2.0', 'generator': 'mirror-wings build_model.py'}, 'scene': 0,
           'scenes': [{'name': 'Scene', 'nodes': [len(MESHES)]}], 'nodes': nodes, 'meshes': meshes,
           'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(binb)}]}
    js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)


glb_path = os.path.join(HERE, 'mirror_wings.glb')
write_glb(glb_path)
total_v = sum(len(m[1]) for m in MESHES)
print('[GLB] %s  %.2f MB  頂點 %d  三角形 %d' % (glb_path, os.path.getsize(glb_path) / 1e6, total_v, sum(len(m[4]) for m in MESHES)))
for m in MESHES:
    print('      %-14s 頂點 %6d  三角形 %6d' % (m[0], len(m[1]), len(m[4])))
print('[碎片] 羽毛 %d、中型 %d、細碎 %d，共 %d 片' % (counts['feather'], counts['medium'], counts['crumb'], sum(counts.values())))
print('[尺寸] 木框外尺寸 %.1f × %.1f × %.1f 公分；翅膀寬 %.1f 公分、高 %.1f 公分' % (
    FRAME_W * 100, FRAME_H * 100, DEPTH * 100, 2 * mx * 100, (float(allp[:, 1].max()) - float(allp[:, 1].min())) * 100))
if total_v > 150000 or os.path.getsize(glb_path) > 2.5e6:
    print('[錯誤] 超過頂點數或檔案大小上限'); sys.exit(1)

# 把 GLB 寫回單獨檢視頁
html_path = os.path.join(HERE, 'index.html')
if os.path.exists(html_path):
    with open(html_path, encoding='utf-8') as f:
        html = f.read()
    b64 = base64.b64encode(open(glb_path, 'rb').read()).decode('ascii')
    new, n = re.subn(r'(<script id="glb-data" type="application/octet-stream">)[^<]*(</script>)', lambda m: m.group(1) + b64 + m.group(2), html)
    if n == 1:
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(new)
        print('[index.html] 已更新內嵌的 GLB')

# ---------------------------------------------------------------- Blender 場景（z 朝上、正面朝 -y）
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
to_b = lambda p: np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1)


def principled(name, color, metallic, rough, **kw):
    m = bpy.data.materials.new(name); m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1); bsdf.inputs['Metallic'].default_value = metallic; bsdf.inputs['Roughness'].default_value = rough
    for k, v in kw.items():
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = v
    return m


mats = {
    'Shards_Mirror': principled('Mirror', (0.80, 0.81, 0.83), 1.0, 0.04),
    'Shards_Edge': principled('MirrorEdge', (0.42, 0.44, 0.46), 0.8, 0.3),
    'Velvet': principled('Velvet', (0.022, 0.013, 0.008), 0.0, 1.0, **{'Sheen Weight': 0.25, 'Sheen Roughness': 0.6, 'Specular IOR Level': 0.0}),
    'Frame': principled('Wood', (0.62, 0.40, 0.20), 0.0, 0.55),
    'Backboard': principled('Backboard', (0.16, 0.11, 0.08), 0.0, 0.85),
}
# 木紋（沿框條方向拉長的雜訊）
nt = mats['Frame'].node_tree
tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); nz = nt.nodes.new('ShaderNodeTexNoise'); rp = nt.nodes.new('ShaderNodeValToRGB')
mp.inputs['Scale'].default_value = (0.4, 8, 1); nz.inputs['Scale'].default_value = 4; nz.inputs['Detail'].default_value = 6
rp.color_ramp.elements[0].color = (0.50, 0.27, 0.11, 1); rp.color_ramp.elements[1].color = (0.72, 0.46, 0.22, 1)
nt.links.new(tc.outputs['UV'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], nz.inputs['Vector'])
nt.links.new(nz.outputs[0], rp.inputs['Fac']); nt.links.new(rp.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])

for name, pos, nrm, uv, idx in MESHES:
    me = bpy.data.meshes.new(name)
    me.from_pydata(to_b(pos).tolist(), [], idx.tolist())
    if uv is not None:
        ul = me.uv_layers.new(name='UVMap')
        li = np.zeros(len(me.loops), dtype=np.int32); me.loops.foreach_get('vertex_index', li)
        ul.data.foreach_set('uv', uv[li].ravel())
    me.polygons.foreach_set('use_smooth', [name == 'Velvet'] * len(me.polygons))
    me.update()
    ob = bpy.data.objects.new(name, me); scene.collection.objects.link(ob)
    me.materials.append(mats[name])
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'mirror_wings.blend'))
print('[blend] 已儲存')

# ---------------------------------------------------------------- 預覽圖
if '--no-preview' not in sys.argv:
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 40
    try:
        scene.cycles.use_denoising = True
    except Exception:
        pass
    scene.render.resolution_x, scene.render.resolution_y = 1200, 950
    scene.render.image_settings.file_format = 'PNG'
    try:
        scene.view_settings.view_transform = 'Standard'
    except Exception:
        pass
    world = bpy.data.worlds.new('W'); scene.world = world; world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.42, 0.40, 0.38, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.9

    def panel(loc, size, strength):
        bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
        o = bpy.context.object; o.scale = (size[0], size[1], 1)
        o.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        m = bpy.data.materials.new('Light'); m.use_nodes = True
        nt2 = m.node_tree; nt2.nodes.clear()
        em = nt2.nodes.new('ShaderNodeEmission'); out = nt2.nodes.new('ShaderNodeOutputMaterial')
        em.inputs['Strength'].default_value = strength; nt2.links.new(em.outputs[0], out.inputs[0])
        o.data.materials.append(m)
        o.visible_camera = False
    panel((-0.5, -1.2, 1.0), (0.5, 0.5), 22)
    panel((0.9, -1.0, 0.3), (0.25, 0.7), 14)
    panel((0.1, -1.5, -0.4), (0.12, 0.12), 60)
    panel((-0.9, -0.6, -0.2), (0.15, 0.5), 12)
    panel((0.3, 1.2, 0.9), (0.6, 0.6), 14)
    panel((0.0, -0.2, 1.4), (0.8, 0.5), 8)
    prnd = random.Random(5)
    for i in range(26):
        a, e = prnd.uniform(0, 6.283), prnd.uniform(-0.9, 1.2)
        panel((1.9 * math.cos(a) * math.cos(e), -abs(1.9 * math.sin(a) * math.cos(e)) - 0.3, 1.9 * math.sin(e)), (prnd.uniform(.3, .8), prnd.uniform(.3, .8)), prnd.choice((0.0, 0.0, 0.15, 1.5, 3.0)))

    cam_d = bpy.data.cameras.new('Cam'); cam_d.lens = 70; cam = bpy.data.objects.new('Cam', cam_d); scene.collection.objects.link(cam); scene.camera = cam
    cam_d.clip_start = 0.05
    views = {
        'front': (0.0, -1.55, 0.0),
        'side': (1.5, -0.12, 0.0),
        'back': (0.0, 1.55, 0.0),
        'threequarter': (0.95, -1.15, 0.38),
        'top': (0.0, -0.45, 1.45),
        'closeup': (0.28, -0.62, -0.18),
    }
    for nm, loc in views.items():
        cam.location = loc
        tgt = Vector((0.06, 0, 0.02)) if nm == 'closeup' else Vector((0, 0, 0))
        cam.rotation_euler = (tgt - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(HERE, 'preview_%s.png' % nm)
        bpy.ops.render.render(write_still=True)
        print('[預覽] preview_%s.png' % nm)
