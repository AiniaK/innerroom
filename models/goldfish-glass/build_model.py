# -*- coding: utf-8 -*-
"""
金魚酒杯 — Blender 建模腳本
執行： /Applications/Blender.app/Contents/MacOS/Blender -b -P build_model.py

產出（與本檔同一資料夾）：
  goldfish_glass.blend   場景檔
  goldfish_glass.glb     給 three.js 用的模型
  preview.png            Workbench 快速預覽（比對形狀用）
  preview_*.png          金魚的多角度特寫（正面、側面、背面、上方、下方、斜角）
  index.html             若已存在，會把最新的 GLB 以 base64 重新嵌入

單位：參考圖像素 / 100。Blender 內 Z 朝上、杯口在 z=0、鏡頭在 -Y 方向。
"""
import bpy
import json
import bmesh
import math
import os
import re
import base64
from math import sin, cos, pi, sqrt

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- 基本工具


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def bezier(p0, p1, p2, p3, n, skip_first=True):
    out = []
    for i in range(1 if skip_first else 0, n + 1):
        t = i / n
        a = (1 - t) ** 3
        b = 3 * (1 - t) ** 2 * t
        c = 3 * (1 - t) * t * t
        d = t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def arc(cx, cy, r, a0, a1, n, skip_first=True, ry=None):
    ry = r if ry is None else ry
    out = []
    for i in range(1 if skip_first else 0, n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        out.append((cx + r * cos(a), cy + ry * sin(a)))
    return out


def catmull(points, u):
    """均勻 Catmull-Rom，u∈[0,1] 通過所有控制點。"""
    n = len(points) - 1
    x = max(0.0, min(0.99999, u)) * n
    i = int(x)
    t = x - i
    p0 = points[max(i - 1, 0)]
    p1 = points[i]
    p2 = points[min(i + 1, n)]
    p3 = points[min(i + 2, n)]
    res = []
    for k in range(len(p1)):
        a = 2 * p1[k]
        b = p2[k] - p0[k]
        c = 2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]
        d = -p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]
        res.append(0.5 * (a + b * t + c * t * t + d * t * t * t))
    return res


def finish(bm, name, parent=None, color=(1, 1, 1, 1), merge=True):
    if merge:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.color = color
    if parent is not None:
        ob.parent = parent
    return ob


def revolve(name, profile, segs=96, color=(1, 1, 1, 1)):
    """把 (r, h) 輪廓繞 Z 軸旋轉成封閉實體；r=0 的點變成單一極點。"""
    bm = bmesh.new()
    rings = []
    for (r, h) in profile:
        if r < 1e-6:
            rings.append([bm.verts.new((0, 0, h))])
        else:
            rings.append([bm.verts.new((r * cos(2 * pi * j / segs),
                                        r * sin(2 * pi * j / segs), h))
                          for j in range(segs)])
    for i in range(len(rings) - 1):
        A, B = rings[i], rings[i + 1]
        for j in range(segs):
            k = (j + 1) % segs
            if len(A) == 1 and len(B) == 1:
                continue
            if len(A) == 1:
                bm.faces.new((A[0], B[j], B[k]))
            elif len(B) == 1:
                bm.faces.new((A[j], A[k], B[0]))
            else:
                bm.faces.new((A[j], A[k], B[k], B[j]))
    return finish(bm, name, color=color)


def grid(name, nu, nv, fn, parent=None, color=(1, 1, 1, 1), wrap_v=False):
    """參數曲面：fn(u, v) -> (x, y, z)，UV = (u, v)。wrap_v 時 v 方向首尾相接。"""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    cols = nv if wrap_v else nv + 1
    V = [[bm.verts.new(fn(i / nu, j / nv)) for j in range(cols)]
         for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            j2 = (j + 1) % cols if wrap_v else j + 1
            quad = [(i, j, j), (i + 1, j, j), (i + 1, j2, j + 1), (i, j2, j + 1)]
            vs = [V[a][b] for a, b, _ in quad]
            # 極點處的退化面
            uniq = []
            for v in vs:
                if all((v.co - w.co).length > 1e-7 for w in uniq):
                    uniq.append(v)
            if len(uniq) < 3:
                continue
            try:
                f = bm.faces.new(vs)
            except ValueError:
                continue
            for loop, (a, _, c) in zip(f.loops, quad):
                loop[uvl].uv = (a / nu, c / nv)
    return finish(bm, name, parent=parent, color=color, merge=wrap_v)


# ---------------------------------------------------------------- 場景重置
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- 玻璃杯
R_OUT = 3.10          # 杯身外半徑
WALL = 0.08           # 壁厚
R_IN = R_OUT - WALL
H_CYL = 3.8           # 直筒高度（圓頂起點）
DOME_OUT = 3.10       # 外圓頂高 -> 頂點 6.9
DOME_IN = 2.85        # 內圓頂高 -> 頂點 6.65（頂部玻璃較厚）
R_STEM = 0.35
H_FOOT = 12.20

th = math.degrees(math.acos(0.8 / R_OUT))        # 圓頂接杯柱處的角度
jx, jy = R_OUT * cos(math.radians(th)), H_CYL + DOME_OUT * sin(math.radians(th))
tx, ty = sin(math.radians(th)), -cos(math.radians(th))

glass_profile = [(0.0, H_FOOT), (1.5, H_FOOT), (3.05, H_FOOT)]
glass_profile += arc(3.05, H_FOOT - 0.09, 0.09, 90, -90, 10)          # 杯腳圓邊
glass_profile += [(2.2, H_FOOT - 0.235), (1.3, H_FOOT - 0.30)]        # 杯腳斜面
glass_profile += bezier((1.3, 11.90), (0.62, 11.85), (0.35, 11.60), (0.35, 10.95), 18)
glass_profile += [(R_STEM, 9.5), (R_STEM, 8.4), (R_STEM, 7.65)]       # 杯柱
glass_profile += bezier((R_STEM, 7.65), (R_STEM, 7.15),
                        (jx - 0.36 * tx, jy - 0.36 * ty), (jx, jy), 16)
glass_profile += arc(0, H_CYL, R_OUT, th, 0, 40, ry=DOME_OUT)         # 外圓頂
glass_profile += [(R_OUT, 2.5), (R_OUT, 1.2), (R_OUT, 0.04)]          # 外直筒
glass_profile += arc(R_OUT - WALL / 2, 0.04, WALL / 2, 0, -180, 10)   # 杯口圓邊
glass_profile += [(R_IN, 1.2), (R_IN, 2.5), (R_IN, H_CYL)]            # 內直筒
glass_profile += arc(0, H_CYL, R_IN, 0, 90, 44, ry=DOME_IN)[:-1]      # 內圓頂
glass_profile += [(0.0, H_CYL + DOME_IN)]
glass = revolve("Glass", glass_profile, 96, color=(0.75, 0.8, 0.85, 0.22))

# ---------------------------------------------------------------- 液體
GAP = 0.02
LIQ_R = R_IN - GAP
LIQ_TOP = H_CYL + DOME_IN - GAP
LIQ_LEVEL = 2.55
MEN = 0.09            # 彎月面半徑
liq_profile = [(0.0, LIQ_TOP)]
liq_profile += arc(0, H_CYL, LIQ_R, 90, 0, 44, ry=DOME_IN - GAP)
liq_profile += [(LIQ_R, 3.2), (LIQ_R, LIQ_LEVEL + MEN)]
liq_profile += arc(LIQ_R - MEN, LIQ_LEVEL + MEN, MEN, 0, -90, 8)
liq_profile += [(2.0, LIQ_LEVEL), (1.0, LIQ_LEVEL), (0.0, LIQ_LEVEL)]
liquid = revolve("Liquid", liq_profile, 96, color=(0.95, 0.80, 0.30, 0.38))

# ---------------------------------------------------------------- 金魚
# 紅色長尾金魚（琉金體型）。魚的本地座標：+X 朝頭、+Z 朝背、±Y 是左右。
# 身體長 2.0（x 由 -1 尾柄到 +1 吻部），建好之後整條魚會自動縮放、移位，確保完全待在液體裡。
import random
import numpy as np
from mathutils import Vector, Euler

fish = bpy.data.objects.new("Fish", None)
scene.collection.objects.link(fish)

FISH_SCALE_MAX = 0.90
REACH_OUT_MIN = 0.25                                                # 靜態時那片鰭至少要伸出液面這麼多
BODY_K = 0.70                                                       # 魚身（含頭）相對於鰭的大小：縮小來突顯尾巴

RED = (0.80, 0.07, 0.05, 1.0)
FINC = (0.92, 0.16, 0.10, 0.72)
FINC_CLEAR = (0.98, 0.42, 0.32, 0.45)

# 鰭的擺動幅度（本地單位；room.js / index.html 的 FIN 參數表第一個數字要和這裡一致，邊界檢查會把它算進去）
SWAY = {
    "Fin_Tail_UL": 0.15, "Fin_Tail_UR": 0.15, "Fin_Tail_ML": 0.16, "Fin_Tail_MR": 0.16,
    "Fin_Tail_LL": 0.15, "Fin_Tail_LR": 0.15,
    "Fin_Dorsal": 0.05, "Fin_Ventral_L": 0.07, "Fin_Ventral_R": 0.06,
    "Fin_Anal_L": 0.06, "Fin_Anal_R": 0.06, "Fin_Pectoral_L": 0.04, "Fin_Pectoral_R": 0.04,
}
MARGIN = 0.12


def grid_uv(name, nu, nv, fn, parent=None, color=(1, 1, 1, 1), wrap_v=False, umap=None):
    """和 grid 一樣，但 UV 的 u 可以另外指定（umap），取樣可以不均勻。"""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    cols = nv if wrap_v else nv + 1
    V = [[bm.verts.new(fn(i / nu, j / nv)) for j in range(cols)]
         for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            j2 = (j + 1) % cols if wrap_v else j + 1
            quad = [(i, j, j), (i + 1, j, j), (i + 1, j2, j + 1), (i, j2, j + 1)]
            vs = [V[a][b] for a, b, _ in quad]
            uniq = []
            for v in vs:
                if all((v.co - w.co).length > 1e-7 for w in uniq):
                    uniq.append(v)
            if len(uniq) < 3:
                continue
            try:
                f = bm.faces.new(vs)
            except ValueError:
                continue
            for loop, (a, _, c) in zip(f.loops, quad):
                uu = a / nu
                loop[uvl].uv = (umap(uu) if umap else uu, c / nv)
    return finish(bm, name, parent=parent, color=color, merge=wrap_v)


# --- 魚身：上緣、下緣、半寬三條輪廓掃出的截面 ---------------------------
BODY_X0, BODY_X1 = -1.0, -1.0 + 2.0 * BODY_K
#            t = 0     .125   .25    .375   .5     .625   .75    .875   1
BODY_TOP = [0.130, 0.250, 0.460, 0.630, 0.690, 0.640, 0.500, 0.365, 0.250]
BODY_BOT = [0.115, 0.225, 0.410, 0.545, 0.590, 0.550, 0.440, 0.320, 0.215]
BODY_WID = [0.050, 0.115, 0.245, 0.360, 0.425, 0.430, 0.370, 0.290, 0.205]


def _prof(vals, t):
    return catmull([(v,) for v in vals], t)[0]


def _cap(t):
    f = 1.0
    if t > 0.86:                       # 鈍鈍的圓頭
        k = (t - 0.86) / 0.14
        f *= sqrt(max(0.0, 1 - k * k))
    if t < 0.03:
        f *= sqrt(max(0.0, 1 - (1 - t / 0.03) ** 2))
    return f


def body_dims(t):
    c = _cap(t)
    c *= BODY_K
    return _prof(BODY_TOP, t) * c, _prof(BODY_BOT, t) * c, _prof(BODY_WID, t) * c


def body_zc(t):
    return 0.07 * BODY_K * (1 - t) ** 2          # 尾柄略為上翹


def body_tmap(p):
    return 1 - (1 - p) ** 1.7           # 頭部取樣較密，圓頭才圓


def body_fn(p, v):
    t = body_tmap(p)
    top, bot, wid = body_dims(t)
    a = 2 * pi * v                      # v=0 腹部、v=0.5 背部
    ca, sa = cos(a), sin(a)
    # 側面稍微鼓一點（超橢圓），看起來更圓胖
    k = abs(sa) ** 0.86 * (1 if sa >= 0 else -1)
    return (BODY_X0 + (BODY_X1 - BODY_X0) * t, wid * k,
            body_zc(t) - ca * (bot if ca > 0 else top))


grid_uv("FishBody", 60, 36, body_fn, parent=fish, color=RED, wrap_v=True, umap=body_tmap)


def body_point(t, side, up):
    """身體表面上的一點：side=±1 左右、up∈[-1,1] 腹→背。"""
    top, bot, wid = body_dims(t)
    return np.array((BODY_X0 + (BODY_X1 - BODY_X0) * t,
                     side * wid * sqrt(max(0.0, 1 - up * up)),
                     body_zc(t) + (top if up > 0 else bot) * up))


# --- 眼睛：略凸的小球，u 從瞳孔中心（0）往外（1），貼圖畫瞳孔與金色虹膜 ----
def eye(name, side):
    c = body_point(0.875, side, 0.20)
    c[1] -= side * 0.045 * BODY_K
    A = np.array((0.22, side, 0.10))
    A /= np.linalg.norm(A)
    e1 = np.cross(A, (0, 0, 1.0))
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(A, e1)
    r = 0.092 * BODY_K

    def fn(u, v):
        th_, ph = u * pi, 2 * pi * v
        p = c + r * (cos(th_) * A + sin(th_) * (cos(ph) * e1 + sin(ph) * e2))
        return tuple(p)
    return grid_uv(name, 9, 14, fn, parent=fish, color=(0.03, 0.02, 0.02, 1), wrap_v=True)


eye("FishEye_L", -1)
eye("FishEye_R", 1)


# --- 彩帶狀的鰭：沿一條 3D 曲線掃出，帶扭轉、波浪褶皺與破碎的末端 --------
class Spine:
    """3D Catmull-Rom 脊線＋沿線平移的座標框（T 切線、B 鰭寬方向、N 法線）。"""

    def __init__(self, pts, b0, n=200):
        self.n = n
        self.P = np.array([catmull(pts, i / n) for i in range(n + 1)])
        T = np.gradient(self.P, axis=0)
        T /= np.linalg.norm(T, axis=1)[:, None]
        B = np.zeros_like(T)
        b = np.array(b0, float)
        for i in range(n + 1):
            b = b - T[i] * np.dot(b, T[i])
            b /= np.linalg.norm(b)
            B[i] = b
        self.T, self.B = T, B

    def at(self, s):
        x = max(0.0, min(1.0, s)) * self.n
        i = min(int(x), self.n - 1)
        f = x - i
        P = self.P[i] * (1 - f) + self.P[i + 1] * f
        T = self.T[i] * (1 - f) + self.T[i + 1] * f
        B = self.B[i] * (1 - f) + self.B[i + 1] * f
        T /= np.linalg.norm(T)
        B -= T * np.dot(B, T)
        B /= np.linalg.norm(B)
        return P, T, B, np.cross(T, B)


def ribbon(name, pts, b0, w_root, w_max, grow=0.65, twist=0.0, twist_pow=1.0,
           ruffle=0.08, ruf_freq=1.5, ruf_phase=0.0, ruf_travel=3.0, cup=0.0,
           tip_round=0.30, tip_pow=2.2, jag=0.06, notches=(), seed=1,
           nu=40, nv=22, color=FINC):
    """u：根部 0 → 末端 1；v：橫跨鰭寬。
    twist：末端相對根部繞脊線扭轉的弧度；ruffle：垂直鰭面的波浪褶皺；cup：鰭面橫向彎成弧形；
    tip_round / jag / notches：末端的圓弧、鋸齒與裂口（每一條鰭條長度不同）。"""
    sp = Spine(pts, b0)
    rnd = random.Random(seed)
    lens = []
    for j in range(nv + 1):
        v = j / nv
        L = 1 - tip_round * abs(2 * v - 1) ** tip_pow
        L *= 1 - jag * rnd.random()
        for (pos, depth, wid) in notches:
            L *= 1 - depth * max(0.0, 1 - abs(v - pos) / wid)
        lens.append(L)

    def fn(u, v):
        s = u * lens[int(round(v * nv))]
        P, T, B, N = sp.at(s)
        w = w_root + (w_max - w_root) * smooth(s / grow)
        w *= 1 + 0.05 * s * sin(7 * pi * s + ruf_phase)
        phi = twist * s ** twist_pow
        Bt = cos(phi) * B + sin(phi) * N
        Nt = -sin(phi) * B + cos(phi) * N
        d = (v - 0.5) * w
        h = (ruffle * s ** 1.2 * sin(2 * pi * ruf_freq * v + ruf_travel * s + ruf_phase)
             + 0.4 * ruffle * s * sin(2 * pi * 2.7 * ruf_freq * v + 5 * s + 2 * ruf_phase)
             + cup * w * s * (4 * (v - 0.5) ** 2 - 0.5))
        return tuple(P + d * Bt + h * Nt)
    return grid_uv(name, nu, nv, fn, parent=fish, color=color)


# --- 尾鰭：六片彩帶從尾柄出發，往上、往兩側、往下各自散開（尾巴是主角，比身體長得多） ---
UPZ = (0, 0, 1)
# 每一片都往後、往上或往兩側飄，沒有往下垂的（靜態時魚貼近液面，尾巴像火焰一樣往上散開）
ribbon("Fin_Tail_UL",      # 上左：往後上方再向外翻
       [(-0.90, -0.02, 0.08), (-1.40, -0.22, 0.44), (-1.98, -0.56, 0.80),
        (-2.58, -0.84, 0.98), (-3.12, -0.94, 0.92)],
       UPZ, 0.15, 1.10, twist=-1.00, ruffle=0.10, ruf_freq=1.4, ruf_phase=0.3, cup=0.22,
       notches=((0.34, 0.20, 0.10), (0.72, 0.12, 0.08)), seed=11)
ribbon("Fin_Tail_UR",      # 上右：比較直立，往上捲
       [(-0.90, 0.02, 0.08), (-1.34, 0.18, 0.56), (-1.80, 0.44, 1.06),
        (-2.20, 0.64, 1.46), (-2.46, 0.68, 1.80)],
       UPZ, 0.15, 1.05, twist=0.80, ruffle=0.10, ruf_freq=1.6, ruf_phase=1.9, cup=-0.20,
       notches=((0.60, 0.18, 0.10),), seed=12)
ribbon("Fin_Tail_ML",      # 中左：像翅膀一樣往側邊攤平、末端微微上揚
       [(-0.90, -0.03, 0.05), (-1.42, -0.40, 0.14), (-1.98, -0.84, 0.26),
        (-2.50, -1.16, 0.40), (-2.90, -1.30, 0.56)],
       UPZ, 0.15, 1.10, twist=-1.30, twist_pow=0.7, ruffle=0.10, ruf_freq=1.3, ruf_phase=3.0, cup=0.15,
       notches=((0.45, 0.22, 0.10),), seed=13)
ribbon("Fin_Tail_MR",      # 中右：最長的一片，往側後方飄
       [(-0.90, 0.03, 0.05), (-1.44, 0.38, 0.14), (-2.08, 0.76, 0.24),
        (-2.76, 1.00, 0.34), (-3.32, 1.06, 0.48)],
       UPZ, 0.15, 1.15, twist=1.25, twist_pow=0.7, ruffle=0.10, ruf_freq=1.5, ruf_phase=4.4, cup=-0.15,
       notches=((0.30, 0.16, 0.08), (0.66, 0.22, 0.10)), seed=14)
ribbon("Fin_Tail_LL",      # 下左：貼著軸線往後長長地飄，鰭面攤平
       [(-0.90, -0.02, 0.03), (-1.42, -0.18, 0.04), (-2.02, -0.34, 0.08),
        (-2.66, -0.40, 0.16), (-3.26, -0.30, 0.28)],
       UPZ, 0.13, 0.95, twist=1.35, twist_pow=0.6, ruffle=0.08, ruf_freq=1.5, ruf_phase=5.2, cup=0.14,
       notches=((0.52, 0.20, 0.10),), seed=15)
ribbon("Fin_Tail_LR",      # 下右：往後、末端上揚
       [(-0.90, 0.02, 0.03), (-1.36, 0.20, 0.04), (-1.84, 0.44, 0.08),
        (-2.32, 0.58, 0.18), (-2.74, 0.56, 0.32)],
       UPZ, 0.13, 0.90, twist=-1.30, twist_pow=0.6, ruffle=0.08, ruf_freq=1.7, ruf_phase=0.9, cup=-0.14,
       notches=((0.40, 0.18, 0.09),), seed=16)


# --- 背鰭：沿背部一整排鰭條，前高、後段拉長往後飄 -----------------------
def sail(name, t0, t1, ang0, ang1, len0, len1, bend, ruffle, freq, phase, lean,
         seed=3, nu=22, nv=30, color=FINC):
    rnd = random.Random(seed)
    Ls = []
    for j in range(nv + 1):
        v = j / nv
        L = (len0 + (len1 - len0) * v ** 1.2) * (0.62 + 0.38 * smooth(v / 0.18))
        L *= 1 - 0.07 * rnd.random()
        L *= 1 - 0.16 * max(0.0, 1 - abs(v - 0.55) / 0.07)
        Ls.append(L)

    def fn(u, v):
        t = t0 + (t1 - t0) * v
        root = body_point(t, 0, 1.0)
        root[2] -= 0.05 * BODY_K
        a = math.radians(ang0 + (ang1 - ang0) * v + bend * u * 0.5)
        L = Ls[int(round(v * nv))]
        y = (ruffle * u ** 1.3 * sin(2 * pi * freq * v + 3.0 * u + phase)
             + lean * u * u * (0.4 + 0.6 * v))
        return (root[0] + u * L * cos(a), y, root[2] + u * L * sin(a))
    return grid_uv(name, nu, nv, fn, parent=fish, color=color)


sail("Fin_Dorsal", 0.70, 0.18, 100, 158, 0.50, 0.88, bend=34, ruffle=0.06, freq=1.6,
     phase=0.7, lean=-0.13)

# --- 腹鰭：左右兩片一樣大、一樣的輪廓，只是垂的角度不同（朝鏡頭那一側自然往下垂，另一側往後貼著腹部飄）。
# 靜態時魚停得很貼近液面、身體微微側傾，往下垂的那一片（REACH）就順勢穿過液面；鰭本身沒有任何伸縮形變。
REACH = "Fin_Ventral_L"
for nm, side, droop in (("Fin_Ventral_L", -1, math.radians(74)), ("Fin_Ventral_R", 1, math.radians(3))):
    r0 = body_point(0.55, side * 0.50, -0.92)
    r0[2] += 0.05
    pts = [tuple(r0)]
    for dist, out in ((0.33, 0.07), (0.68, 0.14), (1.05, 0.17)):
        a_ = droop * (1.0 - 0.10 * dist)          # 末端稍微往後飄
        pts.append((r0[0] - dist * math.cos(a_), r0[1] + side * out, r0[2] - dist * math.sin(a_)))
    ribbon(nm, pts, (1, 0, 0), 0.09, 0.40, grow=0.6, twist=side * 0.4, ruffle=0.045, ruf_freq=1.2,
           ruf_phase=1.0 + side, cup=side * 0.2, tip_round=0.42, jag=0.05,
           notches=((0.45, 0.12, 0.09),), seed=21, nu=28, nv=14)
for nm, side in (("Fin_Anal_L", -1), ("Fin_Anal_R", 1)):
    r0 = body_point(0.20, side * 0.35, -0.90)
    r0[2] += 0.04
    k = 1.0 if side < 0 else 0.86
    ribbon(nm, [tuple(r0),
                (r0[0] - 0.26 * k, r0[1] + side * 0.08, r0[2] - 0.10 * k),
                (r0[0] - 0.56 * k, r0[1] + side * 0.15, r0[2] - 0.14 * k),
                (r0[0] - 0.86 * k, r0[1] + side * 0.16, r0[2] - 0.10 * k)],
           (1, 0, 0), 0.08, 0.32, grow=0.6, twist=side * 0.35, ruffle=0.04, ruf_freq=1.2,
           ruf_phase=2.2 + side, cup=side * 0.15, tip_round=0.45, jag=0.05,
           seed=31 + side, nu=22, nv=12)
# --- 胸鰭：小而透明 -----------------------------------------------------
for nm, side in (("Fin_Pectoral_L", -1), ("Fin_Pectoral_R", 1)):
    r0 = body_point(0.735, side, -0.38)
    r0[1] -= side * 0.02
    ribbon(nm, [tuple(r0),
                (r0[0] - 0.09, r0[1] + side * 0.14, r0[2] - 0.06),
                (r0[0] - 0.21, r0[1] + side * 0.25, r0[2] - 0.13),
                (r0[0] - 0.32, r0[1] + side * 0.30, r0[2] - 0.22)],
           (0.3, 0, 1), 0.05, 0.26, grow=0.7, twist=side * 0.3, ruffle=0.02, ruf_freq=1.0,
           ruf_phase=side, cup=side * 0.25, tip_round=0.5, jag=0.04,
           seed=41 + side, nu=14, nv=10, color=FINC_CLEAR)

# ---------------------------------------------------------------- 靜態姿勢、游動路徑與邊界檢查
# 液體的範圍（模型單位）：液面 z=2.55，直筒半徑 2.95 到 z=3.8，再往上是半橢球（半徑 2.95、高 2.8）。
# 液面以下是杯子裡的空氣（同樣半徑的直筒，一直到杯口 z=0）。
#
# 魚永遠「躺在一條軌道上」：本地 x（沿身體）對應到軌道上的弧長，本地 y/z 是離軌道的橫向偏移，
# 所以身體和尾巴會順著路徑彎。軌道是一圈一圈的環形路徑，每一圈都經過同一個「閘口」：
#   一般的圈（LAP_VAR 幾種形狀輪流）：整圈都離邊界夠遠，游動時整條魚含擺動都在液體裡。
#   下潛圈：有一段往下貼近液面。魚停在這一圈的最低點就是靜態姿勢——尾鰭張開、
#           REACH 那片鰭穿過液面伸進空氣。起游 = 從停的地方沿這一圈繼續往前游回閘口；
#           停下來 = 游到閘口後轉進下潛圈，一路游到最低點、減速停住。
# 這些折線由這支腳本算好、逐步檢查過，放進 Fish 的自訂屬性 swim（JSON），room.js / index.html 照著走。
LQ_LEVEL, LQ_R, LQ_CYL, LQ_DOME = 2.55, 2.95, 3.8, 2.8
AIR_FLOOR = 0.0

NS = 28                    # 軌道取樣點數（shader 裡的陣列長度）
WIG = 0.10                 # 游動時身體與尾巴左右擺的幅度（尾端，本地單位）
BANK = 0.25                # 轉彎時往內側傾斜的程度
A_IDLE = 0.35              # 停在靜態位置、鰭還在擺時的擺動量（起游前、到位後）
D1, D2 = 0.80, 1.20        # 起游：游出這段距離內擺動加到最大 / 加速到全速
D1R, D2R = 1.00, 1.50      # 停下來：離終點這段距離內擺動減小 / 減速
SURF_M = 0.03              # 靜態與貼近液面的那一段，其他部分離液面至少這麼多（離玻璃則是 MARGIN）
EX_MAX = 2.2               # 起游後／停下前，那片鰭最多在這段距離內還留在液面下
SPEED = 1.10
DIP_CENTER, DIP_HALF = 1.15 * pi, 0.80 * pi   # 下潛圈：最低點在一圈的哪裡、下潛段的半寬（以繞圈角度計）
STOP_AZIMUTH = math.radians(-90)              # 靜態時魚停在杯子的正面（鏡頭在 -Y），頭朝右

fish_parts = [o for o in fish.children if o.type == 'MESH']
_loc, _sway, _name, _u = [], [], [], []
for ob in fish_parts:
    me = ob.data
    u_of = [0.0] * len(me.vertices)
    if ob.name.startswith("Fin_"):
        if ob.name not in SWAY:
            raise RuntimeError("SWAY 表缺少 " + ob.name)
        uvd = me.uv_layers[0].data
        for lp in me.loops:
            u_of[lp.vertex_index] = uvd[lp.index].uv[0]
    amp = SWAY.get(ob.name, 0.0)
    for v in me.vertices:
        _loc.append(tuple(v.co))
        _u.append(u_of[v.index])
        _sway.append(amp * u_of[v.index] ** 1.3)
        _name.append(ob.name)
LOCAL = np.array(_loc)
UFIN = np.array(_u)
SWAYV = np.array(_sway)
NAMES = np.array(_name)
IS_REACH = NAMES == REACH
X_MIN = float(LOCAL[:, 0].min()) - 0.08
X_MAX = float(LOCAL[:, 0].max()) + 0.04
XS = np.linspace(X_MIN, X_MAX, NS)
DX = (X_MAX - X_MIN) / (NS - 1)
ZUP = np.array((0, 0, 1.0))


def _sm(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def _norm(V):
    return V / np.maximum(np.linalg.norm(V, axis=-1, keepdims=True), 1e-12)


def wig_w(x):
    return np.clip((0.4 - x) / 3.4, 0.0, 1.0) ** 1.5


def local_shape():
    """魚在本地座標的形狀。靜態與游動都是同一個形狀（鰭只有擺動，沒有伸縮或收放）。"""
    return LOCAL


class Track:
    """幾段等距折線接起來的軌道。"""

    def __init__(self, *pieces):
        self.pieces = []
        self.end = 0.0
        for p in pieces:
            self.add(p)

    def add(self, pts):
        pts = np.asarray(pts, float)
        ds = float(np.linalg.norm(pts[1] - pts[0]))
        self.pieces.append((pts, self.end, ds))
        start = self.end
        self.end += ds * (len(pts) - 1)
        return start

    def eval(self, sig):
        sig = np.asarray(sig, float)
        C = np.zeros((len(sig), 3))
        for n_, (pts, start, ds) in enumerate(self.pieces):
            last = n_ == len(self.pieces) - 1
            end = start + ds * (len(pts) - 1)
            m = (sig >= start if n_ else np.ones(len(sig), bool)) & ((sig < end) | last)
            if not m.any():
                continue
            loc = (sig[m] - start) / ds
            i = np.clip(np.floor(loc).astype(int), 0, len(pts) - 2)
            f = (loc - i)[:, None]
            C[m] = pts[i] * (1 - f) + pts[i + 1] * f
        return C


def spine(track, sig_h, s):
    """魚的原點在軌道弧長 sig_h 時，NS 個取樣點的位置與座標框（和 JS 的算法相同）。"""
    C = track.eval(sig_h + s * XS)
    ip = np.minimum(np.arange(NS) + 1, NS - 1)
    im = np.maximum(np.arange(NS) - 1, 0)
    T = _norm(C[ip] - C[im])
    kap = (T[ip] - T[im]) / ((ip - im) * s * DX)[:, None]
    U = _norm(ZUP + BANK * kap)                 # 自然朝上，轉彎時往內側傾
    U = _norm(U - T * (U * T).sum(axis=1)[:, None])
    return C, T, U


def place(Pl, C, T, U, s):
    """把本地形狀沿軌道擺到世界座標（和 shader 的算法相同）。"""
    f = np.clip((Pl[:, 0] - X_MIN) / (X_MAX - X_MIN), 0, 1) * (NS - 1)
    i = np.minimum(np.floor(f).astype(int), NS - 2)
    r = (f - i)[:, None]
    c = C[i] * (1 - r) + C[i + 1] * r
    t = _norm(T[i] * (1 - r) + T[i + 1] * r)
    u = U[i] * (1 - r) + U[i + 1] * r
    lg = _norm(np.cross(t, u))
    u = np.cross(lg, t)
    return c + s * (u * Pl[:, 2:3] - lg * Pl[:, 1:2])


def clear_lb(P, level=LQ_LEVEL):
    """到邊界（level 那個平面、杯壁、圓頂）距離的保守下界；在外面則為負值。"""
    r = np.hypot(P[:, 0], P[:, 1])
    z = P[:, 2]
    k = np.maximum(z - LQ_CYL, 0.0)
    f = np.sqrt((r / LQ_R) ** 2 + (k / LQ_DOME) ** 2)
    side = np.where(z > LQ_CYL, (1 - f) * LQ_DOME, LQ_R - r)
    return np.minimum(z - level, side)


def resample(P, ds_target=0.06):
    P = np.asarray(P, float)
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(math.ceil(cum[-1] / ds_target)) + 1)
    t = np.linspace(0, cum[-1], n)
    return np.stack([np.interp(t, cum, P[:, k]) for k in range(3)], axis=1), cum


#              A      B      C     D      E     （每圈半徑與高度的變化，閘口處位置與方向都相同）
LAP_VAR = [(-0.25, 0.00, 0.50, 0.15, 0.00),      # 半徑只往內變（外側的尾鰭離杯壁本來就近），高度往上變
           (-0.10, -0.06, 0.90, 0.00, 0.00),
           (-0.32, 0.00, 0.25, -0.12, 0.30),
           (0.00, -0.08, 0.70, 0.25, 0.00),
           (-0.38, 0.05, 0.35, 0.00, 0.50)]
PHI = np.linspace(0, 2 * pi, 1200)


def lap_points(var, fac, rho0, z0, a, H, alpha, depth=0.0):
    A, B, Cc, Dd, E = var
    rho = rho0 + fac * a * (A * (1 - np.cos(PHI)) / 2 + B * (1 - np.cos(2 * PHI)) / 2)
    z = z0 + fac * H * (Cc * (1 - np.cos(PHI)) / 2 + Dd * np.sin(PHI) * (1 - np.cos(PHI))
                        + E * (1 - np.cos(2 * PHI)) / 2)
    z = z - depth * np.cos(np.clip((PHI - DIP_CENTER) / DIP_HALF, -1, 1) * pi / 2) ** 2
    th_ = alpha + PHI                       # 從上面看逆時針繞
    return np.stack([rho * np.cos(th_), rho * np.sin(th_), z], axis=1)


def check(track, s, sig, k, a):
    """魚的原點在 sig、擺動量為 (k 身體, a 鰭) 時：
    回傳（除了 REACH 之外的最小餘裕, 最糟的部位, REACH 離玻璃的最小餘裕, REACH 是否完全在液體裡）。"""
    Wd = place(LOCAL, *spine(track, sig, s), s)
    dyn = 1.2 * s * (a * SWAYV + k * WIG * wig_w(LOCAL[:, 0]))
    r = np.hypot(Wd[:, 0], Wd[:, 1])
    z = Wd[:, 2]
    kk = np.maximum(z - LQ_CYL, 0.0)
    f = np.sqrt((r / LQ_R) ** 2 + (kk / LQ_DOME) ** 2)
    glass = np.where(z > LQ_CYL, (1 - f) * LQ_DOME, LQ_R - r) - MARGIN - dyn      # 離杯壁／圓頂
    surf = (z - LQ_LEVEL) - SURF_M - dyn                                         # 離液面
    sl = np.minimum(glass, surf)
    nr = ~IS_REACH
    j = int(np.argmin(np.where(nr, sl, 1e9)))
    reach_glass = float(np.minimum(glass[IS_REACH], (z[IS_REACH] - AIR_FLOOR) - MARGIN - dyn[IS_REACH]).min())
    return float(sl[j]), _name[j], reach_glass, bool(sl[IS_REACH].min() >= 0), float(sl.min()), _name[int(np.argmin(sl))]


def design(s, verbose=False):
    """替這個大小設計所有的圈；回傳 dict（含檢查結果）或 (None, 原因)。"""
    span = s * (X_MAX - X_MIN)

    def swim_ok(tr, sg0, sg1, st=0.10):
        """整條魚（含那片鰭、含全幅擺動）沿軌道游這一段，最小餘裕。"""
        worst = (1e9, "")
        for sg in np.arange(sg0, sg1 + 1e-9, st):
            c = check(tr, s, sg, 1.0, 1.0)
            if c[4] < worst[0]:
                worst = (c[4], c[5])
        return worst

    def circle_ok(rho0, z0):
        c = resample(lap_points((0, 0, 0, 0, 0), 0, rho0, z0, rho0, 0, 0.0))[0]
        return swim_ok(Track(c, c, c), len(c) * 0.06, len(c) * 0.06 + 0.5, 0.25)[0] >= 0.01

    # 環形的高度與半徑：找最低（最貼近液面）、整條魚張著尾鰭繞一圈仍然放得下的位置
    ring = None
    for dz in np.arange(0.35, 1.61, 0.05):
        for rho0 in (1.30, 1.15, 1.00, 0.85):
            if 2 * pi * rho0 >= span + 1.0 and circle_ok(rho0, LQ_LEVEL + dz):
                ring = (rho0 - 0.08, LQ_LEVEL + dz + 0.12)
                break
        if ring:
            break
    if ring is None:
        return None, "張著尾鰭在液體裡繞不了圈"
    rho0, z0 = ring
    a, H, r_tube = rho0, 1.0, 0.0
    phi_stop = DIP_CENTER + 0.35 * s / rho0          # 停的位置：讓魚身（而不是鼻尖）落在最低點
    alpha = STOP_AZIMUTH - phi_stop
    laps = None
    lap_why = ''
    for fac in (1.0, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0.04):
        L = [resample(lap_points(v, fac, rho0, z0, a, H, alpha))[0] for v in LAP_VAR]
        ok = True
        for p_ in L:                         # 每一種圈整圈游一遍
            tr_ = Track(p_, p_, p_)
            w_ = swim_ok(tr_, tr_.pieces[1][1], tr_.pieces[2][1])
            if w_[0] < 0:
                lap_why = '整圈 %s %.3f' % (w_[1], w_[0])
                if verbose:
                    print('   fac %.2f: %s' % (fac, lap_why))
                ok = False
                break
        if ok:                               # 任兩種圈在閘口銜接的那一段
            for pa in L:
                for pb in L:
                    tr_ = Track(pa, pb)
                    g_ = tr_.pieces[1][1]
                    if swim_ok(tr_, g_ - s * X_MAX - 0.2, g_ - s * X_MIN + 0.2, 0.15)[0] < 0:
                        ok = False
                        break
                if not ok:
                    break
        if ok:
            laps = L
            lap_fac = fac
            break
    if laps is None:
        return None, "環形路徑放不進液體（rho0=%.2f z0=%.2f %s）" % (rho0, z0, lap_why)

    def dip_checks(depth, full=False, nb=0):
        raw = lap_points((0, 0, 0, 0, 0), 0, rho0, z0, a, H, alpha, depth)
        dip, cum = resample(raw)
        sig_stop = float(np.interp(phi_stop, PHI, cum))
        L0 = len(laps[0]) - 1
        tr = Track(laps[nb], dip, laps[nb])      # 前後接的是第 nb 種圈
        g0 = tr.pieces[1][1]
        sf = g0 + sig_stop
        out, ex_d, ex_r = [], 0.0, 0.0

        def step(sg, k, a, what):
            nonlocal ex_d, ex_r
            sl, nm_, rg, rin = check(tr, s, sg, k, a)[:4]
            out.append((min(sl, rg), nm_ if sl <= rg else REACH + "（碰玻璃）", what))
            if not rin:
                if sg >= sf:
                    ex_d = max(ex_d, sg - sf)
                else:
                    ex_r = max(ex_r, sf - sg)
        st = 0.04 if full else 0.08
        step(sf, 0.0, A_IDLE, "靜態")
        # 起游：從停的地方沿下潛圈一路游到離開這一圈
        for sg in np.arange(sf + 0.02, tr.pieces[2][1] - s * X_MIN + 0.3, st):
            k = float(_sm((sg - sf) / D1))
            step(sg, k, A_IDLE + (1 - A_IDLE) * k, "起游 +%.2f" % (sg - sf))
        # 停下來：從閘口進入下潛圈一路游到停的地方
        for sg in np.arange(g0 - s * X_MAX - 0.3, sf, st):
            k = float(_sm((sf - sg) / D1R))
            step(sg, k, A_IDLE + (1 - A_IDLE) * k, "停下來 -%.2f" % (sf - sg))
        worst = min(out)
        if max(ex_d, ex_r) > EX_MAX:
            worst = (-(max(ex_d, ex_r) - EX_MAX), REACH, "那片鰭離開水面太慢")
        return worst, dip, sig_stop, tr, sf, ex_d, ex_r

    w0 = dip_checks(0.0)[0]
    if w0[0] < 0:
        return None, "不下潛也放不下：%s %s 餘裕 %.3f" % (w0[2], w0[1], w0[0])
    lo, hi = 0.0, z0 - LQ_LEVEL - 0.05
    for _ in range(9):                      # 找最深、仍然全部通過的下潛深度
        mid = (lo + hi) / 2
        if dip_checks(mid)[0][0] >= 0:
            lo = mid
        else:
            hi = mid
    def dip_all(depth):
        """細查：下潛圈前後接每一種圈都要過。"""
        res = [dip_checks(depth, True, nb) for nb in range(len(laps))]
        r0_ = res[0]
        return (min(r[0] for r in res),) + r0_[1:5] + (max(r[5] for r in res), max(r[6] for r in res))

    worst, dip, sig_stop, tr, sf, ex_d, ex_r = dip_all(lo)
    for _ in range(12):                     # 細查沒過就退一點
        if worst[0] >= 0 or lo <= 0:
            break
        lo = max(0.0, lo - 0.03)
        worst, dip, sig_stop, tr, sf, ex_d, ex_r = dip_all(lo)
    if worst[0] < 0:
        return None, "下潛圈細查不過：%s" % (worst,)
    Wst = place(LOCAL, *spine(tr, sf, s), s)
    return dict(s=s, r_tube=r_tube, rho0=rho0, z0=z0, alpha=alpha, laps=laps, dip=dip, sig_stop=sig_stop,
                depth=lo, worst=worst, ex_d=ex_d, ex_r=ex_r, lap_fac=lap_fac, lap_len=[round(float(np.linalg.norm(p_[1] - p_[0]) * (len(p_) - 1)), 2) for p_ in laps], static=Wst, track=tr, sf=sf,
                reach_out=float(LQ_LEVEL - Wst[IS_REACH, 2].min())), ""


VERBOSE = bool(os.environ.get('FISH_VERBOSE'))
MOTION = None
for s_try in ([float(os.environ['FISH_S'])] if os.environ.get('FISH_S') else np.arange(FISH_SCALE_MAX, 0.449, -0.05)):
    mo, why = design(float(s_try), VERBOSE)
    if mo is None:
        print("FISH scale %.3f: %s" % (s_try, why))
        continue
    print("FISH scale %.3f: 可行，下潛 %.3f，那片鰭伸出液面 %.3f" % (s_try, mo["depth"], mo["reach_out"]))
    if mo["reach_out"] >= REACH_OUT_MIN:
        MOTION = mo
        break
if MOTION is None:
    raise RuntimeError("找不到同時滿足靜態姿勢與游動路徑的大小")
fish_scale = MOTION["s"]

# ---- 最後把結果印出來，並再檢查一次靜態姿勢（任何一項不過就中止）
Wst = MOTION["static"]
nr = ~IS_REACH
st_surf = Wst[nr, 2] - LQ_LEVEL
st_glass = clear_lb(Wst[nr], -1e9)
reach_z = Wst[IS_REACH, 2]
reach_glass = clear_lb(Wst[IS_REACH], AIR_FLOOR)
_others_out = sorted(set(NAMES[nr][st_surf < 0]))
print("FISH size: scale=%.3f verts=%d 身長（吻到尾柄）=%.2f 全長（吻到尾鰭末端）=%.2f"
      % (fish_scale, len(LOCAL), fish_scale * (BODY_X1 - BODY_X0), fish_scale * (X_MAX - X_MIN)))
print("FISH static: 其他頂點離液面最小 %.4f（%s）、離玻璃最小 %.4f（%s）; %s 伸出液面 %.3f，%.0f%% 的頂點在液面下，離玻璃最小 %.3f"
      % (st_surf.min(), NAMES[nr][int(np.argmin(st_surf))], st_glass.min(), NAMES[nr][int(np.argmin(st_glass))], REACH,
         LQ_LEVEL - reach_z.min(), 100.0 * (reach_z < LQ_LEVEL).mean(), reach_glass.min()))
if _others_out:
    raise RuntimeError("靜態姿勢：%s 也超出液面" % _others_out)
if st_glass.min() < MARGIN:
    raise RuntimeError("靜態姿勢：%s 太靠近玻璃" % NAMES[nr][int(np.argmin(st_glass))])
if reach_glass.min() < MARGIN:
    raise RuntimeError("靜態姿勢：伸出水面的鰭太靠近玻璃")
print("FISH reach fin: 起游後游出 %.2f、停下前最後 %.2f 的距離內，%s 還有一部分在液面下（檢查過不碰玻璃）；其餘時間整條魚都在液體裡"
      % (MOTION["ex_d"], MOTION["ex_r"], REACH))
print("FISH swim: 環形半徑 %.2f、高度 %.2f（離液面 %.2f）；%d 種圈各自整圈、以及任兩種圈在閘口銜接處，都用整條魚（尾鰭張開、全幅擺動）逐步檢查過"
      % (MOTION["rho0"], MOTION["z0"], MOTION["z0"] - LQ_LEVEL, len(MOTION["laps"])))
print("FISH laps: 變化幅度係數 %.2f，各圈長度 %s，魚全長 %.2f" % (MOTION["lap_fac"], MOTION["lap_len"], fish_scale * (X_MAX - X_MIN)))
print("FISH dip lap: 下潛 %.3f；靜態／起游／停下來 全程（除了那片鰭）的最小餘裕 %.4f（%s，%s）"
      % (MOTION["depth"], MOTION["worst"][0], MOTION["worst"][2], MOTION["worst"][1]))
print("FISH CHECK OK: 靜態只有 %s 伸出液面；游動、起游、停下來全程其他部分都在液體內（邊距 %.2f 以上，已含擺動）" % (REACH, MARGIN))

# Fish 節點：放在靜態位置、頭朝前進方向（一般的檢視器看到的是沒有彎的魚；彎曲與游動都在 shader 裡）
_C, _T, _U = spine(MOTION["track"], MOTION["sf"], fish_scale)
_i0 = int(np.argmin(np.abs(XS)))
fish.location = tuple(MOTION["track"].eval(np.array([MOTION["sf"]]))[0])
fish.rotation_euler = (0.0, -math.asin(float(_T[_i0][2])), math.atan2(float(_T[_i0][1]), float(_T[_i0][0])))
fish.scale = (fish_scale, fish_scale, fish_scale)


def _gl(P):
    """Blender（Z 朝上）→ glTF（Y 朝上）座標，攤平成一串數字。"""
    P = np.asarray(P, float).reshape(-1, 3)
    return [round(float(v), 4) for p in P for v in (p[0], p[2], -p[1])]


fish["swim"] = json.dumps({
    "ns": NS, "xmin": round(X_MIN, 4), "xmax": round(X_MAX, 4),
    "wig": WIG, "bank": BANK, "aidle": A_IDLE,
    "d1": D1, "d2": D2, "d1r": D1R, "d2r": D2R, "speed": SPEED,
    "reach": REACH,
    "laps": [_gl(p) for p in MOTION["laps"]], "dip": _gl(MOTION["dip"]), "stop": round(MOTION["sig_stop"], 4),
}, separators=(",", ":"))

# ---------------------------------------------------------------- 存檔與匯出
glb_path = os.path.join(HERE, "goldfish_glass.glb")
bpy.ops.export_scene.gltf(filepath=glb_path, export_format='GLB', export_yup=True,
                          export_apply=False, export_cameras=False,
                          export_lights=False, export_materials='NONE',
                          export_animations=False, export_extras=True)
glb_size = os.path.getsize(glb_path)
print("GLB bytes:", glb_size)
if glb_size > 1.5 * 1024 * 1024:
    raise RuntimeError("GLB 超過 1.5 MB：%d" % glb_size)

# ---------------------------------------------------------------- 把靜態姿勢烘進 mesh（.blend 與預覽圖用）
# GLB 裡的魚是直的（彎曲在 shader 裡做）；這裡把靜態姿勢直接寫進頂點，.blend 打開看到的就是作品的靜態樣子。
_off = 0
fish.location, fish.rotation_euler, fish.scale = (0, 0, 0), (0, 0, 0), (1, 1, 1)
for ob in fish_parts:
    n_ = len(ob.data.vertices)
    ob.data.vertices.foreach_set("co", Wst[_off:_off + n_].astype(np.float32).ravel())
    ob.data.update()
    _off += n_
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "goldfish_glass.blend"))

# ---------------------------------------------------------------- 預覽渲染
try:
    world = bpy.data.worlds.new("W")
    world.color = (0.80, 0.78, 0.76)
    scene.world = world
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'OBJECT'
    sh.show_object_outline = True
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'

    def shot(filename, loc, target, ortho, res):
        cd = bpy.data.cameras.new("PreviewCam")
        cam = bpy.data.objects.new("PreviewCam", cd)
        scene.collection.objects.link(cam)
        cam.location = loc
        d = Vector(target) - Vector(loc)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
        cd.clip_start, cd.clip_end = 1.0, 200.0
        scene.camera = cam
        scene.render.resolution_x, scene.render.resolution_y = res
        scene.render.filepath = os.path.join(HERE, filename)
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)

    # 整件作品（和參考圖同一個取景）
    shot("preview.png", (0.0, -48.0, 5.96), (0.0, 0.0, 5.96), 14.48, (543, 724))
    # 靜態姿勢的多角度特寫：不畫玻璃，液體調得很淡，看得出哪片鰭伸出液面
    glass.hide_render = True
    liquid.color = (0.95, 0.80, 0.30, 0.16)
    WP = Wst
    C = tuple((WP.min(axis=0) + WP.max(axis=0)) / 2)
    span = float((WP.max(axis=0) - WP.min(axis=0)).max()) * 1.2
    D = 40.0
    views = {
        "front": (0, -D, 0), "side": (D, 0, 0), "back": (0, D, 0), "left": (-D, 0, 0),
        "top": (0, -0.001, D), "bottom": (0, -0.001, -D),
        "threequarter": (D * 0.62, -D * 0.62, D * 0.48),
    }
    for nm, off in views.items():
        shot("preview_%s.png" % nm, (C[0] + off[0], C[1] + off[1], C[2] + off[2]), C, span, (640, 640))
    glass.hide_render = False
    liquid.color = (0.95, 0.80, 0.30, 0.38)
    print("previews rendered")
except Exception as e:  # 預覽失敗不影響模型輸出
    print("preview failed:", e)

# ---------------------------------------------------------------- 嵌入 HTML
html_path = os.path.join(HERE, "index.html")
if os.path.exists(html_path):
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    with open(glb_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    pat = re.compile(r'(<script id="glb-data" type="application/octet-stream">)(.*?)(</script>)', re.S)
    if pat.search(html):
        html = pat.sub(lambda m: m.group(1) + b64 + m.group(3), html, count=1)
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html)
        print("embedded GLB into index.html:", len(b64), "chars")
    else:
        print("index.html has no glb-data slot")
