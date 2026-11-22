# 扭蛋公仔：書桌櫃頂層的四隻小公仔（眼寶、秤秤、泰迪熊、耳鼻猴）。
# 用法：/Applications/Blender.app/Contents/MacOS/Blender -b -P build_model.py
# 產生 gashapon.glb、gashapon.blend、preview_*.png（輸出到這支腳本所在的資料夾）。
#
# 單位：每隻公仔高約 2（房間裡再縮成實際大小）。Blender 裡 +Z 朝上、臉朝 -Y（匯出成 glTF 後臉朝 +Z、上 +Y）。
# 每隻公仔的每個部位是一個 mesh，名稱「角色_部位」（例如 Eye_Body），材質由房間那邊（room.js）設定。
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ONLY = sys.argv[sys.argv.index('--') + 1].split(',') if '--' in sys.argv else None   # 只做某幾隻：-- Eye,Scale
# 試做時輸出到 wip.glb，不會蓋掉房間正在用的 gashapon.glb；審查通過後加 --publish 才寫正式檔
OUTNAME = 'gashapon' if '--publish' in sys.argv else 'wip'
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------------- 共用的小工具 ----------------
def link(name, me):
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


def shade_smooth(ob):
    for p in ob.data.polygons:
        p.use_smooth = True


def uv_sphere(name, center, radii, seg=96, rings=64, shape=None):
    """細分很密的球；shape(dir) 可以依方向改半徑（推出形狀）"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized()
        k = shape(d) if shape else 1.0
        v.co = Vector((d.x * radii[0], d.y * radii[1], d.z * radii[2])) * k + Vector(center)
    bm.to_mesh(me)
    bm.free()
    ob = link(name, me)
    shade_smooth(ob)
    return ob


def join(objs, name):
    for o in scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def frame(nor, up=Vector((0, 0, 1))):
    """以法線為 z 軸的旋轉"""
    z = Vector(nor).normalized()
    xax = Vector(up).cross(z)
    if xax.length < 1e-4:
        xax = Vector((1, 0, 0))
    xax.normalize()
    y = z.cross(xax)
    return Matrix((xax, y, z)).transposed()


def tube(name, pts, r, seg=16, taper=None, caps=True):
    """沿著一串點的圓管；taper(t) 可以改半徑（0..1 沿著管子）"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    prev_u = None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        ref = prev_u if prev_u is not None else (Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0)))
        u = (ref - t * ref.dot(t)).normalized()   # 沿著管子平順地轉，不會扭
        prev_u = u
        w = t.cross(u).normalized()
        rr = r * (taper(i / (len(pts) - 1)) if taper else 1.0)
        rings.append([bm.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * rr) for a in [k / seg * 2 * math.pi for k in range(seg)]])
    for k in range(len(rings) - 1):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((rings[k][i], rings[k + 1][i], rings[k + 1][j], rings[k][j]))
    if caps:
        for ring, end in ((rings[0], pts[0]), (rings[-1], pts[-1])):
            c = bm.verts.new(end)
            for i in range(seg):
                bm.faces.new((c, ring[i], ring[(i + 1) % seg]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = link(name, me)
    shade_smooth(ob)
    return ob


def curve_pts(ctrl, n=40):
    """Catmull-Rom 平滑曲線"""
    P = [Vector(c) for c in ctrl]
    out = []
    for s in range(len(P) - 1):
        p0, p1, p2, p3 = P[max(s - 1, 0)], P[s], P[s + 1], P[min(s + 2, len(P) - 1)]
        for k in range(n // (len(P) - 1)):
            t = k / (n // (len(P) - 1))
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-1])
    return out


def ellipsoid(name, center, radii, rot=None, seg=48, rings=32):
    ob = uv_sphere(name, (0, 0, 0), radii, seg, rings)
    M = (rot.to_4x4() if rot else Matrix.Identity(4))
    ob.data.transform(Matrix.Translation(Vector(center)) @ M)
    return ob


class Surface:
    """在某個物件表面打點：從外面往裡打到表面，回傳 (位置, 法線)"""
    def __init__(self, ob, center):
        bpy.context.view_layer.update()
        self.ob, self.c = ob, Vector(center)

    def at(self, d):
        d = Vector(d).normalized()
        ok, loc, nor, _ = self.ob.ray_cast(self.c + d * 10, -d)
        if not ok:
            raise RuntimeError('ray missed %s' % (d,))
        return Vector(loc), Vector(nor).normalized()


class Sphere:
    """正球的表面（解析的，貼部件時不會沿著網格的折角凹凸）"""
    def __init__(self, center, r):
        self.c, self.r = Vector(center), r

    def at(self, d):
        d = Vector(d).normalized()
        return self.c + d * self.r, d


def cap(name, surf, d, radius, height, profile=None, up=Vector((0, 0, 1)), seg=128, rings=24, lift=0.0):
    """貼在曲面上的隆起圓片：中心方向 d、半徑 radius（沿表面）、高度 height。
       profile(t, a) → 0..1 的高度比例（t 從中心 0 到邊緣 1，a 是角度），預設是圓潤的鼓起、邊緣收進表面。"""
    loc0, nor0 = surf.at(d)
    R = frame(nor0, up)
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    def pt(t, a):
        q = loc0 + R @ Vector((math.cos(a) * radius * t, math.sin(a) * radius * t, 0))
        loc, nor = surf.at(q - surf.c)   # 投影回表面，順著曲面
        k = profile(t, a) if profile else math.sqrt(max(0.0, 1 - t ** 4))
        return loc + nor * (height * k + lift)
    centre = bm.verts.new(pt(0, 0))
    grid = []
    for i in range(1, rings + 1):
        t = i / rings
        grid.append([bm.verts.new(pt(t, j / seg * 2 * math.pi)) for j in range(seg)])
    for j in range(seg):
        bm.faces.new((centre, grid[0][j], grid[0][(j + 1) % seg]))
    for i in range(rings - 1):
        for j in range(seg):
            k = (j + 1) % seg
            bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][k], grid[i][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = link(name, me)
    shade_smooth(ob)
    return ob


def mitten(name, wrist, direction, size, thumb_side):
    """圓圓的手（像連指手套）：手掌一顆扁橢圓，旁邊一個小拇指"""
    d = Vector(direction).normalized()
    side = Vector(thumb_side).normalized()
    palm_c = Vector(wrist) + d * size * 0.75
    rot = frame(d, side).to_3x3() if False else None
    palm = ellipsoid(name + 'P', palm_c, (size * 0.62, size * 0.5, size * 0.85), rot=frame(side.cross(d), d) if False else None)
    # 讓手掌沿著手臂方向拉長
    M = Matrix.Translation(palm_c) @ frame(d, side).to_4x4() @ Matrix.Translation(-palm_c)
    palm.data.transform(Matrix.Translation(palm_c) @ frame(d, side).to_4x4() @ Matrix.Diagonal((1, 1, 1, 1)) @ Matrix.Translation(-palm_c))
    th = ellipsoid(name + 'T', palm_c + side * size * 0.55 - d * size * 0.1, (size * 0.26, size * 0.26, size * 0.42))
    return [palm, th]


# =====================================================================================
#   眼寶：米白色眼球，正面是藍色虹膜（放射紋）、深藍瞳孔、兩點白色反光、下方微笑；
#         細細的藍色手腳；雙手舉著一片比身體還大的透明隱形眼鏡（邊緣帶淡藍）。
# =====================================================================================
import numpy as np


def surface_nets(F, origin, h, name, decimate=0.3):
    """距離場 F（<0 為內部，格點間距 h，第一個格點在 origin）→ 一整片連續的網格（surface nets）"""
    nx, ny, nz = F.shape
    C8 = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0), (0, 0, 1), (1, 0, 1), (0, 1, 1), (1, 1, 1)]
    cor = np.stack([F[dx:nx - 1 + dx, dy:ny - 1 + dy, dz:nz - 1 + dz] for dx, dy, dz in C8], -1)
    cin = cor < 0
    active = cin.any(-1) & ~cin.all(-1)
    E = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    acc = np.zeros(cor.shape[:3] + (3,))
    cnt = np.zeros(cor.shape[:3])
    for a, b in E:
        fa, fb = cor[..., a], cor[..., b]
        cr = (fa < 0) != (fb < 0)
        t = np.where(cr, fa / np.where(cr, fa - fb, 1), 0)
        pa, pb = np.array(C8[a], float), np.array(C8[b], float)
        acc += np.where(cr[..., None], pa + t[..., None] * (pb - pa), 0)
        cnt += cr
    ii = np.argwhere(active)
    loc = acc[active] / cnt[active][:, None]
    verts = origin + (ii + loc) * h
    idx = -np.ones(active.shape, dtype=np.int64)
    idx[active] = np.arange(len(ii))
    faces = []
    ins = F < 0
    ch = ins[:-1, 1:-1, 1:-1] != ins[1:, 1:-1, 1:-1]
    for i, j, k in np.argwhere(ch):
        j += 1; k += 1
        q = [idx[i, j - 1, k - 1], idx[i, j, k - 1], idx[i, j, k], idx[i, j - 1, k]]
        faces.append(q if ins[i, j, k] else q[::-1])
    ch = ins[1:-1, :-1, 1:-1] != ins[1:-1, 1:, 1:-1]
    for i, j, k in np.argwhere(ch):
        i += 1; k += 1
        q = [idx[i - 1, j, k - 1], idx[i - 1, j, k], idx[i, j, k], idx[i, j, k - 1]]
        faces.append(q if ins[i, j, k] else q[::-1])
    ch = ins[1:-1, 1:-1, :-1] != ins[1:-1, 1:-1, 1:]
    for i, j, k in np.argwhere(ch):
        i += 1; j += 1
        q = [idx[i - 1, j - 1, k], idx[i, j - 1, k], idx[i, j, k], idx[i - 1, j, k]]
        faces.append(q if ins[i, j, k] else q[::-1])
    faces = [[int(v) for v in f] for f in faces if min(f) >= 0]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = link(name, me)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    sm = ob.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.5; sm.iterations = 3
    dc = ob.modifiers.new('dc', 'DECIMATE'); dc.ratio = decimate
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier='sm')
    bpy.ops.object.modifier_apply(modifier='dc')
    shade_smooth(ob)
    return ob


def sd_capsule_poly(P, pts, r):
    """點 P (N,3) 到一串線段的距離減 r"""
    d = np.full(len(P), 1e9)
    for a, b in zip(pts[:-1], pts[1:]):
        a, b = np.array(a), np.array(b)
        ba = b - a
        t = np.clip(((P - a) @ ba) / max(ba @ ba, 1e-12), 0, 1)
        d = np.minimum(d, np.linalg.norm(P - a - t[:, None] * ba, axis=1))
    return d - r


def sd_ellipsoid(P, c, radii, M=None):
    q = P - np.array(c)
    if M is not None:
        q = q @ np.array(M)          # 轉到橢圓體自己的座標（M 的欄是橢圓體的三個軸）
    r = np.array(radii)
    k0 = np.linalg.norm(q / r, axis=1)
    k1 = np.linalg.norm(q / (r * r), axis=1)
    return k0 * (k0 - 1) / np.maximum(k1, 1e-9)


def smin(a, b, k):
    """平滑聯集：交界處自然地圓過去（k 越大圓角越大）"""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


_mb_n = [0]
def blob(name, elems, res=0.006, thr=0.6):
    """幾顆 metaball 融成一塊光滑的形（手、腳）：elems = [(中心, 半徑, (sx,sy,sz) 或 None, 旋轉矩陣 或 None)]"""
    _mb_n[0] += 1
    fam = 'Blob%d' % _mb_n[0]   # 不同的 blob 名字不同，才不會互相融在一起
    mb = bpy.data.metaballs.new(fam)
    mb.resolution = res
    mb.render_resolution = res
    mb.threshold = thr
    ob = bpy.data.objects.new(fam, mb)
    scene.collection.objects.link(ob)
    for co, r, size, rot in elems:
        e = mb.elements.new(type='ELLIPSOID' if size else 'BALL')
        e.co = Vector(co)
        e.radius = r / 0.574 * 0.93   # threshold 0.6 時表面只在半徑的 0.574 倍；融合會再胖一點
        e.stiffness = 2.0
        if size:
            e.size_x, e.size_y, e.size_z = size
        if rot is not None:
            e.rotation = rot.to_quaternion()
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    new = link(name, me)
    bpy.data.objects.remove(ob)
    shade_smooth(new)
    return new


def mitten(name, base, up, normal, size, wrist_dir=None, thumb=1):
    """愛心形的圓手：圓圓的手掌，上緣兩個圓凸（一邊小的拇指、一邊大一點的手指），中間一道凹；全部融成一塊"""
    up, nz = Vector(up).normalized(), Vector(normal).normalized()
    side = up.cross(nz).normalized()
    nz = side.cross(up).normalized()
    Rm = Matrix((side, up, nz)).transposed()
    b = Vector(base)
    L = lambda x, y, z: b + Rm @ (Vector((x, y, z)) * size)
    tilt = lambda ang: Rm @ Matrix.Rotation(ang, 3, 'Z')
    el = [(L(0, 0, 0), size * 0.6, (1.0, 0.95, 0.78), Rm),
          (L(thumb * 0.55, 0.6, 0), size * 0.28, (1.0, 1.35, 0.95), tilt(-thumb * 0.55)),
          (L(-thumb * 0.2, 0.74, 0), size * 0.42, (1.0, 1.12, 0.9), tilt(thumb * 0.2))]
    if wrist_dir is not None:
        el.append((b - Vector(wrist_dir).normalized() * size * 0.7, size * 0.3, None, None))
    return blob(name, el, res=size * 0.06)


def heart_hand(name, base, up, toward, size):
    """愛心形的圓手（像連指手套）：一團圓圓的手掌，上緣兩個圓凸（拇指一個、其他手指一個）"""
    up, toward = Vector(up).normalized(), Vector(toward).normalized()
    side = up.cross(toward).normalized()
    toward = side.cross(up).normalized()
    M = Matrix((side, up, toward)).transposed().to_4x4()
    parts = [ellipsoid(name + 'p', (0, 0, 0), (size * 0.58, size * 0.62, size * 0.42)),
             ellipsoid(name + 'a', (-size * 0.3, size * 0.55, 0), (size * 0.3, size * 0.36, size * 0.3)),
             ellipsoid(name + 'b', (size * 0.28, size * 0.48, 0), (size * 0.32, size * 0.4, size * 0.32))]
    for o in parts:
        o.data.transform(Matrix.Translation(Vector(base)) @ M)
    return parts


def bean_foot(name, ankle, forward, size):
    """豆子形的腳掌：往前伸，前端圓胖、腳跟接在腿下"""
    f = Vector(forward).normalized()
    side = Vector((0, 0, 1)).cross(f).normalized()
    M = Matrix((side, f, Vector((0, 0, 1)))).transposed().to_4x4()
    parts = [ellipsoid(name + 'h', (0, 0, size * 0.42), (size * 0.5, size * 0.55, size * 0.42)),
             ellipsoid(name + 't', (0, size * 0.75, size * 0.48), (size * 0.62, size * 0.72, size * 0.5))]
    for o in parts:
        o.data.transform(Matrix.Translation(Vector(ankle)) @ M)
    return parts


# =====================================================================================
#   眼寶：比例都從參考圖（design-source/gashapon/眼寶.png）量出來，以身體半徑 R 為單位。
#   參考圖上身體中心在 (465, 680)、半徑 300px；img(px, py) 把圖上的點換成 (x, z)（R 為單位，右 +x、上 +z）。
#   身體：米白大球，球心離地 1.72R。虹膜：鮮藍的平台（平面、邊緣圓角），中心 (560,575)、半徑 0.67R，外圈一圈短短的放射刻紋；
#   深藍瞳孔中心 (548,548)、半徑 0.28R；大反光是一顆白色圓頂，在瞳孔上緣 (555,455)、半徑 0.22R；小反光 (535,595)、半徑 0.075R。
#   微笑：虹膜左下 (490,785) 一個小小的 U，寬 0.27R。
#   腿：細管、直直往下，下端彎進豆子形的腳掌（腳尖朝前、微微朝外）。手：同樣粗細的細管＋愛心形的圓手（兩個圓凸）。
#   左手（圖的左邊）貼著身體前面橫過虹膜，抓住鏡片的前緣；右手從身體右側往上，在鏡片的凹面裡撐著它。
#   隱形眼鏡：直徑 1.84R 的深弧面，邊緣是一圈淡藍。凸面朝右前上方（n），凹面朝著眼寶；
#   邊緣的最上點在圖上 (603,239)、最下點 (873,719)，前緣疊在虹膜右側。
# =====================================================================================
def img(px, py):
    return ((px - 465) / 300.0, (680 - py) / 300.0)


def build_eye():
    R = 0.78
    C = Vector((0, 0, 1.72 * R))
    def front_dir(px, py):
        x, z = img(px, py)
        return Vector((x, -math.sqrt(max(0.02, 1 - x * x - z * z)), z))
    def front_dir_l(px, py, lift):
        # 墊高 lift 之後、從正面看會落在圖上 (px, py) 的方向（墊高是沿著法線往外，會讓位置往外偏）
        x, z = img(px, py)
        k = 1 + lift / R
        x, z = x / k, z / k
        return Vector((x, -math.sqrt(max(0.02, 1 - x * x - z * z)), z))
    body = uv_sphere('Eye_Body', C, (R, R, R), seg=96, rings=64)
    S = Sphere(C, R)

    def cap_img(name, cx, cy, rpx, height, profile, lift, seg=144, rings=28):
        """在正面圖的座標上畫一個圓（中心 (cx,cy)、半徑 rpx），投影回球面、往外墊高：從正面看和設計圖完全重合"""
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        def pt(t, a):
            h = lift + height * profile(t, a)
            d = front_dir_l(cx + math.cos(a) * rpx * t, cy - math.sin(a) * rpx * t, h)
            return C + d * (R + h)
        centre = bm.verts.new(pt(0, 0))
        grid = [[bm.verts.new(pt(i / rings, j / seg * 2 * math.pi)) for j in range(seg)] for i in range(1, rings + 1)]
        for j in range(seg):
            bm.faces.new((centre, grid[0][j], grid[0][(j + 1) % seg]))
        for i in range(rings - 1):
            for j in range(seg):
                k = (j + 1) % seg
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][k], grid[i][k]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        ob = link(name, me)
        shade_smooth(ob)
        return ob

    # 虹膜：平台，邊緣在最外 12% 圓圓地收下去；外圈 14 道短刻紋
    def iris_prof(t, a):
        edge = 1.0 if t < 0.86 else math.cos((t - 0.86) / 0.14 * math.pi / 2) ** 0.6
        groove = 0.0
        if 0.5 < t < 0.9:
            g = abs(math.sin(a * 7 + 0.3))
            groove = 0.5 * max(0.0, 1 - g * 11) * math.sin(math.pi * (t - 0.5) / 0.4) ** 0.6
        return edge - groove
    # 虹膜一定要是球面上真正的圓（不能把正面圖投影上去，會在頂部拉長變形）：中心朝右前上方各約 21°、張角 42°，
    # 正面看的上下左右範圍（上 z0.89、下 -0.36、左 x-0.34、右 0.83）接近設計圖
    el, az = math.radians(21), math.radians(21)
    iris_d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    iris = cap('Eye_Iris', S, iris_d, math.tan(math.radians(42)) * R, 0.06 * R, iris_prof, seg=168, rings=34)
    flat = lambda t, a: 1.0 if t < 0.8 else math.cos((t - 0.8) / 0.2 * math.pi / 2) ** 0.5
    pupil = cap('Eye_Pupil', S, front_dir_l(575, 550, 0.07 * R), 0.4 * R, 0.03 * R, flat, seg=112, rings=20, lift=0.058 * R)   # 瞳孔中心 (575,550)、球面上的圓
    # 反光：扁平的白色圓片，整片在虹膜範圍內（大的在瞳孔上緣、小的在瞳孔左下）
    disc = lambda t, a: 1.0 if t < 0.72 else math.cos((t - 0.72) / 0.28 * math.pi / 2) ** 0.7
    # （圖上量的：大的中心 (555,466)、半徑 70px；小的 (536,595)、半徑 23px。正面看要是圓的，所以圓片朝向介於表面法線和正前方之間）
    # 反光：扁平的白色圓片，貼著球面（在正面圖座標上畫圓、投影回球面），墊在瞳孔上面；正面看是正圓、位置和圖上一樣
    flatdisc = lambda t, a: 1.0 if t < 0.8 else math.cos((t - 0.8) / 0.2 * math.pi / 2) ** 0.6
    sh = [cap('Eye_ShineA', S, front_dir_l(555, 470, 0.1 * R), 0.25 * R, 0.035 * R, flatdisc, seg=96, rings=18, lift=0.07 * R),
          cap('Eye_ShineB', S, front_dir_l(536, 595, 0.1 * R), 0.08 * R, 0.03 * R, flatdisc, seg=48, rings=10, lift=0.08 * R)]
    shine = join(sh, 'Eye_Shine')

    # 微笑：一小段圓弧（U 形），兩端是圓頭
    smile = []
    # 圖上量的：寬約 77px、深約 15px，底部在 (491,786)：一段半徑 0.17R、角度 ±0.85 的圓弧
    # 使用者在截圖上畫的紅線：底部在圖上 (457,818)、比較深的 U（寬約 0.32R、深約 0.11R）
    xz = []
    for i in range(25):
        t = -1.2 + 2.4 * i / 24
        x, z = img(457, 818)
        xz.append((x + math.sin(t) * 0.17, z + (1 - math.cos(t)) * 0.17))
    cx_ = sum(p[0] for p in xz) / len(xz); cz_ = sum(p[1] for p in xz) / len(xz)
    ca_, sa_ = math.cos(math.radians(30)), math.sin(math.radians(30))   # 原地順時針轉 30°（正面看；使用者 2026-11-23）
    for x, z in xz:
        dx, dz = x - cx_, z - cz_
        x, z = cx_ + dx * ca_ + dz * sa_, cz_ - dx * sa_ + dz * ca_
        p, n = S.at(Vector((x, -math.sqrt(1 - x * x - z * z), z)))
        smile.append(p + n * 0.004)
    mr = 0.022 * R
    mouth = join([tube('Eye_Smile', smile, mr, seg=14)] + [ellipsoid('end', q, (mr, mr, mr), seg=20, rings=12) for q in (smile[0], smile[-1])], 'Eye_Smile')

    limbs = []
    lr = 0.047 * R
    # 腿：參考圖上兩腿中間在身體中心右邊一點
    for sx in (-1, 1):
        hip = C + Vector(((0.11 + sx * 0.19) * R, 0.02 * R, -0.86 * R))
        ankle = Vector(((0.11 + sx * 0.22) * R, 0.0, 0.13 * R))
        limbs.append(tube('leg', curve_pts([hip, hip.lerp(ankle, 0.5), ankle], 24), lr, seg=18))
        f = Vector((sx * 0.85, -1, 0)).normalized()
        side = Vector((0, 0, 1)).cross(f).normalized()
        Rf = Matrix((side, f, Vector((0, 0, 1)))).transposed()
        heel = Vector((ankle.x, ankle.y, 0.085 * R))
        limbs.append(blob('foot', [(heel + f * 0.03 * R, 0.13 * R, (0.85, 0.95, 0.68), Rf),
                                   (heel + f * 0.17 * R, 0.14 * R, (0.88, 1.0, 0.64), Rf),
                                   (ankle + Vector((0, 0, 0.06 * R)), 0.06 * R, None, None)], res=0.012 * R))

    # 隱形眼鏡：幾乎直立（從正上方看，邊緣是一條直線），從眼睛前方斜斜地往右後方延伸，弧面朝右前方鼓出去；
    # 左手抓住它的前緣，右手從身體右後方繞出去，抓住後緣。
    # 鏡片的位置、曲度、大小：照使用者在俯視截圖上畫的紅線（2026-11-20）——
    # 從正上方看邊緣是一條直線，前端 A (右 0.2, 前 1.69)、後端 B (右 1.26, 前 0.83)（R 為單位）；整片在臉的右前方，
    # 凸面朝右前方鼓得很深、凹面朝著眼睛。高度照三視圖：中心約 0.8R。微微往後仰（n.z 0.2）。
    A_ = Vector((0.2, -1.69, 0.8)) * R
    B_ = Vector((1.26, -0.83, 0.8)) * R
    u = (B_ - A_).normalized()                          # 鏡片平面上、水平，從前端往後端
    n = Vector((u.y, -u.x, 0.2)).normalized()          # 凸面朝的方向（右前、微微往上）
    if n.x < 0:
        n = Vector((-u.y, u.x, 0.2)).normalized()
    u = (u - n * u.dot(n)).normalized()
    m = n.cross(u).normalized()
    if m.z < 0:
        m = -m                                         # 鏡片平面上、往上
    rl = 0.5 * (B_ - A_).length * 1.05
    sag = 0.6 * rl
    th = 0.016 * R
    rc = C + (A_ + B_) / 2
    Rs = (rl * rl + sag * sag) / (2 * sag)
    def lens_pt(r, ang, off=0.0):                    # ang 0 = 後緣（+u），pi = 前緣，pi/2 = 頂
        h = Rs - math.sqrt(max(0.0, Rs * Rs - r * r))
        return rc + n * sag + (u * math.cos(ang) + m * math.sin(ang)) * r + n * (-h + off)
    def to_img(p):
        q = (p - C) / R
        return Vector((465 + q.x * 300, 680 - q.z * 300))

    def arm_path(d0, end, r0=0.92, rmid=1.1):
        """從身體表面（方向 d0）沿著身體外側繞一道平順的弧到 end"""
        d0 = Vector(d0).normalized()
        d1 = (end - C).normalized()
        r1 = (end - C).length / R
        om = math.acos(max(-1.0, min(1.0, d0.dot(d1))))
        pts = []
        for i in range(41):
            t = i / 40
            d = (d0 * math.sin((1 - t) * om) + d1 * math.sin(t * om)) / math.sin(om)
            e = t * t * (3 - 2 * t)
            rr = r0 + (r1 - r0) * e + (rmid - 0.5 * (r0 + r1)) * math.sin(math.pi * t) * 1.2 + 0.18 * math.sin(math.pi * min(1.0, t * 2.5))
            pts.append(C + d * rr * R)
        return pts

    lr = 0.05 * R
    def hand(name, path, normal, size=1.0):
        """設計圖的手：手腕往外張開，接到一大團橢圓形的四指；旁邊一根細短圓頭的拇指（在看的人的左邊）。手臂最後一段也融進來，接縫是平順的。"""
        end = path[-1]
        up = (path[-1] - path[-5]).normalized()
        nz = Vector(normal)
        nz = (nz - up * nz.dot(up)).normalized()
        side = up.cross(nz).normalized()
        if side.x > 0:
            side = -side                              # 拇指在左邊
        Rm = Matrix((side, up, nz)).transposed()
        k = size * R
        L = lambda x, y, z: end + Rm @ (Vector((x, y, z)) * k)
        tilt = lambda ang: Rm @ Matrix.Rotation(ang, 3, 'Z')
        el = [(L(0, -0.08, 0), 0.0625 * k, (0.8, 2.0, 0.8), Rm),             # 手腕：沿著手臂拉長，從手臂的粗細平順地張開
              (L(-0.01, 0.03, 0), 0.068 * k, (1.0, 1.0, 0.85), Rm),
              (L(-0.04, 0.155, 0), 0.085 * k, (1.0, 1.42, 0.82), tilt(-0.12)),     # 四指：直立的長圓
              (L(0.085, 0.13, 0), 0.036 * k, (1.0, 2.2, 0.95), tilt(0.16))]         # 拇指：細長、圓頭，和四指分開
        return blob(name, el, res=0.008 * k)

    def arm(ctrl, grip, normal, name):
        """手臂＋手：手臂是一道平順的曲線；手腕從手臂的粗細往外張開（喇叭形），接到直立長圓的四指、旁邊一根細長圓頭的拇指。
           全部合成一個體積再重新長出一整片表面（體素重建），手臂和手是同一塊，沒有接縫也沒有鼓包；最後稍微磨圓。"""
        pts = [C + Vector(c) * R for c in ctrl]
        up = (grip - pts[-1]).normalized()
        wrist = grip - up * 0.13 * R
        path = curve_pts(pts + [wrist], 72)
        up = (path[-1] - path[-4]).normalized()
        nz = Vector(normal)
        nz = (nz - up * nz.dot(up)).normalized()
        side = up.cross(nz).normalized()
        if side.x > 0:
            side = -side                              # 拇指在左邊
        Rm = Matrix((side, up, nz)).transposed()
        L = lambda x, y, z: wrist + Rm @ (Vector((x, y, z)) * R)
        # 整條手臂＋手：在距離場裡用平滑聯集組合（手臂曲線＋手掌＋四指＋拇指），再長出一整片表面——從肩膀到指尖沒有接縫、交界自然圓順
        Rmn = np.array(Rm)
        Lw = lambda x, y, z: np.array(wrist + Rm @ (Vector((x, y, z)) * R))
        def rot(ang):
            return np.array(Rm @ Matrix.Rotation(ang, 3, 'Z'))
        hh = 0.0055 * R
        allp = np.array([tuple(p) for p in path] + [tuple(Lw(x, y, z)) for x in (-0.17, 0.19) for y in (-0.3, 0.37) for z in (-0.12, 0.12)])
        lo_ = allp.min(0) - 0.08 * R; hi_ = allp.max(0) + 0.08 * R
        xs = [np.arange(lo_[i], hi_[i] + hh, hh) for i in range(3)]
        F = np.full((len(xs[0]), len(xs[1]), len(xs[2])), 1.0)
        def block(a, b, pad):
            i0 = [max(0, int((min(a[i], b[i]) - pad - lo_[i]) / hh)) for i in range(3)]
            i1 = [min(len(xs[i]), int((max(a[i], b[i]) + pad - lo_[i]) / hh) + 2) for i in range(3)]
            sl = tuple(slice(i0[i], i1[i]) for i in range(3))
            P = np.stack(np.meshgrid(xs[0][sl[0]], xs[1][sl[1]], xs[2][sl[2]], indexing='ij'), -1)
            return sl, P.reshape(-1, 3), P.shape[:3]
        pts_ = [np.array(tuple(p)) for p in path]
        for a, b in zip(pts_[:-1], pts_[1:]):                     # 手臂：每一段只算它附近的格點
            sl, P, shp = block(a, b, lr + 0.12 * R)   # 範圍要夠寬：手掌和手臂的平滑過渡要讀到正確的距離
            F[sl] = np.minimum(F[sl], sd_capsule_poly(P, [a, b], lr).reshape(shp))
        hb0 = np.array([tuple(Lw(x, y, z)) for x in (-0.17, 0.19) for y in (-0.3, 0.37) for z in (-0.12, 0.12)])
        sl, P, shp = block(hb0.min(0), hb0.max(0), 0.02 * R)          # 手：只在手附近的盒子裡做平滑聯集
        d = F[sl].reshape(-1)
        d = smin(d, sd_ellipsoid(P, Lw(0.0, 0.1, 0), (0.08 * R, 0.065 * R, 0.058 * R), Rmn), 0.07 * R)           # 手掌（和手臂之間自然張開成喇叭形）
        d = smin(d, sd_ellipsoid(P, Lw(-0.035, 0.2, 0), (0.085 * R, 0.112 * R, 0.064 * R), rot(0.1)), 0.04 * R)    # 四指：直立的長圓
        d = smin(d, sd_capsule_poly(P, [tuple(Lw(0.06, 0.12, 0)), tuple(Lw(0.085, 0.215, 0))], 0.042 * R), 0.028 * R)   # 拇指：粗短圓頭，幾乎和四指並排往上，凹口保持清楚
        F[sl] = d.reshape(shp)
        limbs.append(surface_nets(F, lo_, hh, name))

    # 左手（圖上量的）：手臂從 (305,690) 貼在身體前面出來，經 (400,686)、(500,673)、(600,645) 緩緩往上，手腕在 (647,617)，抓住鏡片前緣
    # 手臂：照使用者畫的綠線（俯視）——左手從身體左前方往前繞一大圈，抓住鏡片前端；右手從身體右側往前彎，抓住鏡片後端。
    gripL = lens_pt(rl, math.pi + 0.75) + n * 0.03 * R        # 前端偏下（正面圖上左手在瞳孔右下方）
    gripR = lens_pt(rl, 0.25) + n * 0.03 * R                  # 後端、稍微偏上
    qL, qR = (gripL - C) / R, (gripR - C) / R
    print('eye: gripL', tuple(round(v, 2) for v in qL), 'gripR', tuple(round(v, 2) for v in qR))
    arm([(-0.5, -0.7, -0.06), (-0.58, -1.02, -0.02), (-0.36, -1.36, qL.z * 0.35), (-0.03, -1.6, qL.z * 0.7)], gripL, Vector((0.1, -1, 0.1)), 'armL')
    arm([(0.86, -0.25, -0.05), (1.08, -0.35, qR.z * 0.25), (1.22, -0.58, qR.z * 0.6)], gripR, Vector((0.7, -0.6, 0.1)), 'armR')
    limbs = join(limbs, 'Eye_Limbs')

    # 鏡片本體：薄殼
    me = bpy.data.meshes.new('Eye_Lens')
    bm = bmesh.new()
    seg, rings = 112, 22
    outer, inner = [], []
    for i in range(rings + 1):
        r = rl * (i / rings) ** 0.8
        if i == 0:
            outer.append([bm.verts.new(lens_pt(0, 0))]); inner.append([bm.verts.new(lens_pt(0, 0, -th))]); continue
        outer.append([bm.verts.new(lens_pt(r, j / seg * 2 * math.pi)) for j in range(seg)])
        inner.append([bm.verts.new(lens_pt(r, j / seg * 2 * math.pi, -th)) for j in range(seg)])
    def fan(layer, flip):
        for j in range(seg):
            k = (j + 1) % seg
            f = (layer[0][0], layer[1][j], layer[1][k])
            bm.faces.new(f[::-1] if flip else f)
        for i in range(1, rings):
            for j in range(seg):
                k = (j + 1) % seg
                f = (layer[i][j], layer[i + 1][j], layer[i + 1][k], layer[i][k])
                bm.faces.new(f[::-1] if flip else f)
    fan(outer, False)
    fan(inner, True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    lens = link('Eye_Lens', me)
    shade_smooth(lens)
    # 鏡片邊緣：一圈淡藍的圓邊
    rim_pts = [lens_pt(rl, k / 160 * 2 * math.pi, -th / 2) for k in range(161)]
    rim = tube('Eye_Rim', rim_pts, 0.022 * R, seg=12, caps=False)
    return [body, iris, pupil, shine, mouth, limbs, lens, rim]


# =====================================================================================
#   共用：距離場的小工具（圓角方塊）、用距離場長出一個部件
# =====================================================================================
def sd_round_box(P, c, half, r, M=None):
    q = P - np.array(c)
    if M is not None:
        q = q @ np.array(M)
    q = np.abs(q) - (np.array(half) - r)
    return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(q.max(1), 0) - r


def sdf_part(name, lo, hi, h, fn, decimate=0.35):
    lo, hi = np.array(lo, float), np.array(hi, float)
    xs = [np.arange(lo[i], hi[i] + h, h) for i in range(3)]
    G = np.stack(np.meshgrid(*xs, indexing='ij'), -1).reshape(-1, 3)
    F = fn(G).reshape(len(xs[0]), len(xs[1]), len(xs[2]))
    return surface_nets(F, lo, h, name, decimate)


# =====================================================================================
#   秤秤（體重計）：比例都從三視圖（design-source/gashapon/秤秤三視圖展示.png，2026-11-20 新版）量出來。
#   單位：身體寬度的一半（正面圖 206px）= 1；身體中心為原點（x 右＝角色的左、y 往後、z 上）。
#   正面圖：身體中心 (381,351)；側面圖（從角色左側看，臉朝左）中心 (893,355)；背面圖中心 (1414,356)。
#   身體：寬 2.0、高 2.03、厚 0.97 的圓角方形（正面看是四角很圓的方形，側面前後都是圓弧）；身體中心離地 1.6。
#   頂上：淡藍色的圓角上蓋（寬 0.88、高 0.14、深 0.41）。正面上方：半圓形的淡藍刻度窗（圓心 (0.04,1.07)、半徑 0.41），
#     一圈黑色刻度（21 根，長短交錯）和一根往上的紅色指針。
#   正面面板：米白色、四角圓（半寬 0.87、圓角 0.36），上緣被刻度窗外圈（半徑 0.52）挖出一個弧形凹口。
#   臉：深藍橢圓眼睛 (±0.3, 0.25)，半徑 0.078×0.107；粉紅腮紅 (−0.49 / 0.51, 0.11)，半徑 0.14；
#     D 字形張嘴（上緣 z 0.126、半寬 0.133、深 0.18，深紅色），下半一塊粉紅舌頭。
#   黃色捲尺：寬 0.13、厚 0.035，繞身體一圈，往角色的左側（+x）上升約 25°，背面略高；上面黑色刻度長短交錯。
#   手：深藍色短手臂＋圓球手（半徑 0.12）；角色的右手（−x）在 (−1.22, 0.22) 拿叉子（3 根叉齒），左手（+x）在 (1.23, 0.08) 拿餐刀，都往上舉。
#   腿：深藍色（半徑 0.125），x −0.33 / +0.30；圓頭靴（長 0.39、高 0.2），微微朝外、往前。
# =====================================================================================
SC_U = 0.72            # 1 單位在 Blender 裡的長度（公仔總高約 2）
SC_ZC = 1.6            # 身體中心離地（單位）


def build_scale():
    A_, B_, Cz, Q = 1.0, 0.36, 1.015, 3.0
    def gfun(x, z):
        return (abs(x / A_) ** 3.3 + abs(z / Cz) ** 3.3) ** (Q / 3.3)
    def Fb(p):
        return gfun(p[0], p[2]) + abs(p[1] / B_) ** Q
    # 身體：超橢球（正面看四角圓的方形、側面圓弧）
    me = bpy.data.meshes.new('Scale_Body')
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=160, v_segments=120, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized()
        v.co = d * Fb(d) ** (-1 / Q)
    bm.to_mesh(me); bm.free()
    body = link('Scale_Body', me); shade_smooth(body)

    def front(x, z):
        """正面表面上 (x,z) 那一點與法線"""
        def fy(x_, z_):
            g = gfun(x_, z_)
            return -B_ * max(0.0, 1 - g) ** (1 / Q)
        y = fy(x, z)
        e = 1e-3
        fx = (fy(x + e, z) - fy(x - e, z)) / (2 * e)
        fz = (fy(x, z + e) - fy(x, z - e)) / (2 * e)
        n = Vector((fx, -1, fz)).normalized()
        return Vector((x, y, z)), n

    def patch(name, c2, sdf2, height, profile, lift, seg=128, rings=20):
        """正面上的貼片：形狀由 2D 距離函數 sdf2(x,z) 決定（從 c2 往外是星形），貼著表面、往外墊高"""
        cx, cz = c2
        def rb(th):
            lo_, hi_ = 0.0, 3.0
            for _ in range(40):
                mid = (lo_ + hi_) / 2
                if sdf2(cx + math.cos(th) * mid, cz + math.sin(th) * mid) < 0:
                    lo_ = mid
                else:
                    hi_ = mid
            return lo_
        R_ = [rb(j / seg * 2 * math.pi) for j in range(seg)]
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        def pt(t, j):
            th = j / seg * 2 * math.pi
            x, z = cx + math.cos(th) * R_[j] * t, cz + math.sin(th) * R_[j] * t
            p, n = front(x, z)
            return p + n * (lift + height * profile(t))
        centre = bm.verts.new(pt(0, 0))
        grid = [[bm.verts.new(pt(i / rings, j)) for j in range(seg)] for i in range(1, rings + 1)]
        for j in range(seg):
            bm.faces.new((centre, grid[0][j], grid[0][(j + 1) % seg]))
        for i in range(rings - 1):
            for j in range(seg):
                k = (j + 1) % seg
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][k], grid[i][k]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
        ob = link(name, me); shade_smooth(ob)
        return ob

    plate = lambda t: 1.0 if t < 0.88 else max(0.0, math.cos((t - 0.88) / 0.12 * math.pi / 2)) ** 0.7
    dome = lambda t: math.sqrt(max(0.0, 1 - t ** 2.2))
    flat = lambda t: 1.0 if t < 0.85 else max(0.0, math.cos((t - 0.85) / 0.15 * math.pi / 2)) ** 0.6
    def sd_rrect2(x, z, cx, cz, hx, hz, r):
        qx, qz = abs(x - cx) - (hx - r), abs(z - cz) - (hz - r)
        return math.hypot(max(qx, 0), max(qz, 0)) + min(max(qx, qz), 0) - r
    def sd_circ(x, z, cx, cz, r):
        return math.hypot(x - cx, z - cz) - r
    def sd_ell(x, z, cx, cz, rx, rz):
        return (math.hypot((x - cx) / rx, (z - cz) / rz) - 1) * min(rx, rz)

    # 正面面板（米白）：圓角方形，上緣被刻度窗外圈挖出弧形凹口
    panel = patch('Scale_Panel', (0, -0.1), lambda x, z: max(sd_rrect2(x, z, 0, -0.02, 0.87, 0.87, 0.36), -sd_circ(x, z, 0.04, 1.07, 0.52)), 0.03, plate, 0.0, seg=192, rings=26)
    # 刻度窗（淡藍）
    # 刻度窗外圍一圈往前凸的粉紅框（側面看得到它在頂端前方鼓起），窗凹在框裡
    # （環形不能從一個中心往外放射著建，會摺到：改成沿著環的角度 φ 和寬度方向建）
    def ring(name, cx, cz, r0, r1, zmax, height, nseg=160, nw=14):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        phis = []
        for k in range(nseg + 1):
            phis.append(math.pi + k / nseg * math.pi)       # 下半圈
        rows_ = []
        for phi in phis:
            row = []
            for i in range(nw + 1):
                u_ = i / nw
                r = r0 + (r1 - r0) * u_
                x, z = cx + math.cos(phi) * r, min(cz + math.sin(phi) * r, zmax)
                prof = math.sin(math.pi * u_) ** 0.35
                p, n = front(x, z)
                row.append(bm.verts.new(p + n * height * prof))
            rows_.append(row)
        for a_ in range(nseg):
            for i in range(nw):
                bm.faces.new((rows_[a_][i], rows_[a_ + 1][i], rows_[a_ + 1][i + 1], rows_[a_][i + 1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
        ob = link(name, me); shade_smooth(ob)
        return ob
    frame_ = ring('Scale_Frame', 0.04, 1.07, 0.395, 0.53, 1.0, 0.06)
    dial = patch('Scale_Dial', (0.04, 0.82), lambda x, z: max(sd_circ(x, z, 0.04, 1.07, 0.41), z - 0.985), 0.012, flat, 0.012, seg=128, rings=16)
    ticks = []
    for i in range(21):
        a = math.radians(-42 + 84 * i / 20)
        r0 = 0.455 if i % 2 == 0 else 0.49
        p0, n0 = front(0.04 + math.sin(a) * r0, 0.43 + math.cos(a) * r0)
        p1, n1 = front(0.04 + math.sin(a) * 0.545, 0.43 + math.cos(a) * 0.545)
        ticks.append(tube('tick', [p0 + n0 * 0.03, p1 + n1 * 0.03], 0.009, seg=8))
    pb, nb_ = front(0.04, 0.66)
    pt_, nt_ = front(0.04, 0.80)
    needle = tube('Scale_Needle', [pb + nb_ * 0.032, pt_ + nt_ * 0.032], 0.022, seg=12, taper=lambda t: 1 - 0.85 * t)
    # 上蓋（淡藍圓角塊）
    # 上蓋：扁的圓拱（正面、背面看都是一道弧）
    cap_ = sdf_part('Scale_Cap', (-0.55, -0.32, 0.8), (0.6, 0.28, 1.25), 0.008,
                    lambda P: sd_ellipsoid(P, (0.02, -0.02, 0.99), (0.46, 0.21, 0.15)))
    # 臉
    eyes = join([patch('eyeL', (-0.29, 0.25), lambda x, z: sd_ell(x, z, -0.29, 0.25, 0.078, 0.107), 0.045, dome, 0.03, seg=64, rings=12),
                 patch('eyeR', (0.31, 0.25), lambda x, z: sd_ell(x, z, 0.31, 0.25, 0.078, 0.107), 0.045, dome, 0.03, seg=64, rings=12)], 'Scale_Eyes')
    cheeks = join([patch('chL', (-0.49, 0.107), lambda x, z: sd_circ(x, z, -0.49, 0.107, 0.14), 0.006, flat, 0.03, seg=64, rings=8),
                   patch('chR', (0.51, 0.107), lambda x, z: sd_circ(x, z, 0.51, 0.107, 0.14), 0.006, flat, 0.03, seg=64, rings=8)], 'Scale_Cheeks')
    mouth_sdf = lambda x, z: max(z - 0.126, sd_ell(x, z, 0.0, 0.126, 0.133, 0.18))
    mouth = patch('Scale_Mouth', (0, 0.04), mouth_sdf, 0.012, flat, 0.03, seg=96, rings=12)
    tongue = patch('Scale_Tongue', (0, -0.005), lambda x, z: max(sd_ell(x, z, 0.0, -0.01, 0.078, 0.05), mouth_sdf(x, z) + 0.01), 0.012, dome, 0.042, seg=64, rings=8)

    # 捲尺：繞身體一圈，往 +x 上升約 25°、背面略高
    nb = Vector((-math.sin(math.radians(27)), -0.17, math.cos(math.radians(27)))).normalized()
    P0 = Vector((0, 0, -0.23))
    e1 = (Vector((1, 0, 0)) - nb * nb.x).normalized()
    e2 = nb.cross(e1).normalized()
    W, TH = 0.17, 0.035
    def surf_hit(o, d):
        lo_, hi_ = 0.0, 3.0
        for _ in range(48):
            mid = (lo_ + hi_) / 2
            if Fb(o + d * mid) < 1:
                lo_ = mid
            else:
                hi_ = mid
        p = o + d * lo_
        e = 1e-4
        g = Vector(((Fb(p + Vector((e, 0, 0))) - Fb(p - Vector((e, 0, 0)))),
                    (Fb(p + Vector((0, e, 0))) - Fb(p - Vector((0, e, 0)))),
                    (Fb(p + Vector((0, 0, e))) - Fb(p - Vector((0, 0, e)))))).normalized()
        return p, g
    NS = 240
    rows = []
    for sgn in (-1, 1):
        o = P0 + nb * (sgn * W / 2)
        row = []
        for k in range(NS):
            th = k / NS * 2 * math.pi
            p, g = surf_hit(o, e1 * math.cos(th) + e2 * math.sin(th))
            row.append((p, g))
        rows.append(row)
    me = bpy.data.meshes.new('Scale_Tape')
    bm = bmesh.new()
    LIFT = 0.04                                          # 墊在正面面板（高 0.03）上面
    L0 = [bm.verts.new(p + g * LIFT) for p, g in rows[0]]
    L1 = [bm.verts.new(p + g * (LIFT + TH * 0.85)) for p, g in rows[0]]
    L2 = [bm.verts.new(p + g * (LIFT + TH * 0.85)) for p, g in rows[1]]
    L3 = [bm.verts.new(p + g * LIFT) for p, g in rows[1]]
    Lm0 = [bm.verts.new((rows[0][k][0] + rows[0][k][1] * TH + rows[1][k][0] + rows[1][k][1] * TH) / 2 * 0 + rows[0][k][0].lerp(rows[1][k][0], 0.5) + (rows[0][k][1] + rows[1][k][1]).normalized() * (LIFT + TH)) for k in range(NS)]
    loops = [L0, L1, Lm0, L2, L3]
    for a_, b_ in zip(loops, loops[1:] + loops[:1]):
        for k in range(NS):
            k2 = (k + 1) % NS
            bm.faces.new((a_[k], a_[k2], b_[k2], b_[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    tape = link('Scale_Tape', me); shade_smooth(tape)
    # 捲尺上的刻度：每 0.1 一根，長短交錯，從上緣往下
    acc_, last, cnt = 0.0, None, 0
    for k in range(NS):
        mid = rows[0][k][0].lerp(rows[1][k][0], 0.5)
        if last is not None:
            acc_ += (mid - last).length
        last = mid
        if acc_ >= 0.1:
            acc_ = 0.0
            cnt += 1
            # 印在捲尺上的刻度：沿捲尺外表面（中間略鼓）貼一條極薄的細條，不凸起（使用者 2026-11-21）
            ln = 0.6 if cnt % 2 == 0 else 0.38
            ka, kb = (k - 1) % NS, (k + 1) % NS
            tdir = (rows[0][kb][0] + rows[1][kb][0] - rows[0][ka][0] - rows[1][ka][0]).normalized()
            def outer(u):                                # u：0 在上緣、1 在下緣，貼著捲尺外表面
                p2 = rows[1][k][0] + rows[1][k][1] * (LIFT + TH * 0.85)
                p1 = rows[0][k][0] + rows[0][k][1] * (LIFT + TH * 0.85)
                pm = rows[0][k][0].lerp(rows[1][k][0], 0.5) + (rows[0][k][1] + rows[1][k][1]).normalized() * (LIFT + TH)
                return p2.lerp(pm, u / 0.5) if u < 0.5 else pm.lerp(p1, (u - 0.5) / 0.5)
            g = (rows[0][k][1] + rows[1][k][1]).normalized()
            us = [0.14 + ln * j / 6 for j in range(7)]
            mb = bmesh.new()
            pairs = []
            for u in us:
                c = outer(u) + g * 0.0025
                pairs.append((mb.verts.new(c - tdir * 0.0075), mb.verts.new(c + tdir * 0.0075)))
            for (a0, a1), (b0, b1) in zip(pairs, pairs[1:]):
                f_ = mb.faces.new((a0, a1, b1, b0))
                f_.normal_update()
                if f_.normal.dot(g) < 0:
                    f_.normal_flip()
            mm = bpy.data.meshes.new('tt'); mb.to_mesh(mm); mb.free()
            ticks.append(link('tt', mm))
    ticks = join(ticks, 'Scale_Ticks')

    # 手、腳：深藍，距離場平滑聯集
    def limbs_fn(P):
        # 手臂從身體側面出來、往外再往上，接在拳頭的後面（拳頭在手臂前方）
        d = sd_capsule_poly(P, [(-0.8, 0.02, -0.12), (-1.04, 0.05, -0.12), (-1.16, 0.06, 0.04), (-1.21, 0.03, 0.17)], 0.062)
        d = smin(d, sd_ellipsoid(P, (-1.22, -0.1, 0.22), (0.12, 0.12, 0.12)), 0.02)
        d = np.minimum(d, smin(sd_capsule_poly(P, [(0.8, 0.02, -0.2), (1.05, 0.05, -0.2), (1.17, 0.06, -0.06), (1.22, 0.03, 0.04)], 0.062),
                               sd_ellipsoid(P, (1.23, -0.1, 0.08), (0.12, 0.12, 0.12)), 0.02))
        for sx, xl, xf in ((-1, -0.33, -0.4), (1, 0.30, 0.41)):
            leg = sd_capsule_poly(P, [(xl, 0.0, -0.85), (xl + sx * 0.01, -0.01, -1.42)], 0.125)
            foot = sd_ellipsoid(P, (xf, -0.09, -1.5), (0.21, 0.2, 0.105))
            d = np.minimum(d, smin(leg, foot, 0.06))
        return d
    limbs = sdf_part('Scale_Limbs', (-1.45, -0.4, -1.65), (1.45, 0.3, 0.42), 0.008, limbs_fn, 0.3)

    # 叉子（角色的右手，−x）、餐刀（左手，+x）：銀色，扁的一面朝前
    def utensil(base, top_, fn):
        ax = (Vector(top_) - Vector(base)).normalized()
        nz = Vector((0, -1, 0))
        sd_ = ax.cross(nz).normalized()
        nz = sd_.cross(ax).normalized()
        M = np.array(Matrix((sd_, nz, ax)).transposed())
        b = np.array(base)
        L = (Vector(top_) - Vector(base)).length
        return lambda P: fn((P - b) @ M, L)
    def fork_fn(Q, L):
        d = sd_round_box(Q, (0, 0, 0.24), (0.036, 0.018, 0.25), 0.017)                     # 柄
        d = smin(d, sd_round_box(Q, (0, 0, 0.52), (0.032, 0.017, 0.06), 0.016), 0.04)    # 頸（和柄、叉頭平順接起來）
        d = smin(d, sd_ellipsoid(Q, (0, 0, 0.63), (0.14, 0.02, 0.085)), 0.03)            # 叉頭
        for ox in (-0.1, 0.0, 0.1):
            d = smin(d, sd_capsule_poly(Q, [(ox, 0, 0.64), (ox * 1.05, 0, L - 0.028)], 0.028), 0.02)   # 叉齒
        return d
    def knife_fn(Q, L):
        # 照設計圖的餐刀：柄等寬、兩端圓；刀背（外側 +x）從柄一路直到刀尖；
        # 刀口（內側 −x）在刀身根部先凹一個小台階往外凸出，最寬約柄的 2 倍多，再以弧線收到圓刀尖
        x, y, z = Q[:, 0], Q[:, 1], Q[:, 2]
        hw = 0.028                                                                          # 柄的半寬
        d = sd_round_box(Q, (0, 0, 0.23), (hw, 0.016, 0.23), 0.016)                         # 柄
        zb, zw, zt = 0.44, 0.52, 0.94                                                       # 刀身根部、最寬處、刀尖
        s1 = np.clip((z - zb) / (zw - zb), 0, 1); s1 = s1 * s1 * (3 - 2 * s1)               # 根部的台階（內凹曲線）
        u = np.clip((z - zw) / (zt - zw), 0, 1)
        wmax = 0.11
        wtop = 0.054                                                                        # 刀尖的寬度（圓鈍）
        w = np.where(z < zw, 2 * hw + (wmax - 2 * hw) * s1, wmax - (wmax - wtop) * u ** 1.2)  # 刀身寬度（從刀背量）
        rt = wtop / 2; cxt = hw - rt; czt = zt - rt
        cap = np.sqrt((x - cxt) ** 2 + np.maximum(z - czt, 0) ** 2) - rt                    # 圓頭刀尖
        d2 = np.maximum(np.maximum(x - hw, (hw - w) - x), np.maximum(zb - 0.01 - z, np.where(z > czt, cap, z - zt)))
        rb, t = 0.012, 0.004
        wx, wy = d2 + rb, np.abs(y) - t
        blade = np.minimum(np.maximum(wx, wy), 0) + np.sqrt(np.maximum(wx, 0) ** 2 + np.maximum(wy, 0) ** 2) - rb
        return smin(d, blade, 0.01)
    fbase, ftop = (-1.165, -0.12, -0.04), (-1.33, -0.12, 0.81)
    kbase, ktop = (1.2, -0.12, -0.1), (1.43, -0.12, 0.81)
    metal = join([sdf_part('fork', (-1.55, -0.2, -0.12), (-0.95, -0.04, 0.88), 0.006, utensil(fbase, ftop, fork_fn), 0.35),
                  sdf_part('knife', (1.0, -0.2, -0.18), (1.65, -0.04, 0.88), 0.005, utensil(kbase, ktop, knife_fn), 0.35)], 'Scale_Metal')

    parts = [body, frame_, panel, dial, ticks, needle, cap_, eyes, cheeks, mouth, tongue, tape, limbs, metal]
    T = Matrix.Translation((0, 0, SC_ZC * SC_U)) @ Matrix.Diagonal((SC_U, SC_U, SC_U, 1))
    for o in parts:
        o.data.transform(T)
    return parts


# =====================================================================================
#   泰迪熊：比例從三視圖（design-source/gashapon/泰迪熊三視圖設定稿.png）量出來。單位：150px = 1，地面 z=0，身體中心 x=0。
#   正面圖：身體中心 x 356、地面 y 690；側面圖（從角色左側看）身體中心 x 882；背面圖 x 1424。
#   頭：寬 2.1、深 1.75、高 1.7，中心高 2.97、在身體中心後方 0.16；往角色的左邊（+x）轉約 20°、往右肩微微歪（左耳較高）。
#   口鼻部白色（凸出約 0.25），上面黑鼻子、張開的紅嘴；黑珠眼睛（半徑 0.13、間距 0.78）；粉紅毛氈腮紅（半徑 0.21）。
#   耳朵：圓片半徑 0.37、厚 0.32，內側較淺。身體：蛋形（寬 1.75、深 1.56），中心高 1.29。
#   右手（−x）垂下；左手（+x）舉起拿木頭魔杖，杖頂黃色胖星星（外半徑 0.38），四周四道閃光。腿：短胖圓柱（半徑 0.33），平底。圓尾巴（半徑 0.25）。
#   縫線：虛線，在頭的中線、脖子一圈、肚子中線與橢圓、手臂邊緣、腿後與腳底一圈。（背面圖兩手都垂著，和正面不一致，以正面為準。）
# =====================================================================================
BR_U = 0.48


def sd_star5(px, py, r, rf):
    k1x, k1y = 0.809016994375, -0.587785252292
    k2x, k2y = -k1x, k1y
    px = np.abs(px)
    d = np.maximum(k1x * px + k1y * py, 0); px = px - 2 * d * k1x; py = py - 2 * d * k1y
    d = np.maximum(k2x * px + k2y * py, 0); px = px - 2 * d * k2x; py = py - 2 * d * k2y
    px = np.abs(px); py = py - r
    bax, bay = rf * (-k1y), rf * k1x - 1
    h = np.clip((px * bax + py * bay) / (bax * bax + bay * bay), 0, r)
    qx, qy = px - bax * h, py - bay * h
    return np.sqrt(qx * qx + qy * qy) * np.sign(py * bax - px * bay)


def project_to(fn, pts, iters=8):
    """把一串點沿著距離場的梯度推到表面上；回傳 (點, 外法線)"""
    P = np.array(pts, float)
    e = 1e-4
    for _ in range(iters):
        d = fn(P)
        g = np.stack([(fn(P + np.array(v) * e) - fn(P - np.array(v) * e)) / (2 * e) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1))], 1)
        gn = np.linalg.norm(g, axis=1, keepdims=True) + 1e-9
        P = P - (d[:, None]) * g / gn ** 2
    g = np.stack([(fn(P + np.array(v) * e) - fn(P - np.array(v) * e)) / (2 * e) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1))], 1)
    return P, g / (np.linalg.norm(g, axis=1, keepdims=True) + 1e-9)


def dashes(fn, pts, dash=0.075, gap=0.05, r=0.017, lift=0.0):
    """沿著一條曲線（先投影到表面）排出一段一段的縫線"""
    P, N = project_to(fn, pts)
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    acc = np.concatenate([[0], np.cumsum(seg)])
    out = []
    s0 = gap / 2
    while s0 + dash <= acc[-1]:
        ss = np.linspace(s0, s0 + dash, 4)
        q = [np.array([np.interp(v, acc, P[:, i]) for i in range(3)]) + np.array([np.interp(v, acc, N[:, i]) for i in range(3)]) * lift for v in ss]
        out.append(tube('st', [Vector(tuple(v)) for v in q], r, seg=8))
        s0 += dash + gap
    return out


def build_bear():
    # ---- 頭的座標：頭本身的局部座標 → 轉到身體上 ----
    yaw, roll = math.radians(20), math.radians(-8)
    Rh = (Matrix.Rotation(yaw, 3, 'Z') @ Matrix.Rotation(roll, 3, 'Y'))
    Hc = Vector((-0.09, 0.14, 2.9))      # 量的：下巴 2.1、頭頂 3.83（下巴壓在脖子縫線上）
    Rhn = np.array(Rh)
    def to_head(P):                       # 世界 → 頭局部
        return (P - np.array(Hc)) @ Rhn
    def H(v):                             # 頭局部 → 世界
        return Hc + Rh @ Vector(v)

    def head_fn(P):
        Q = to_head(P)
        d = sd_ellipsoid(Q, (0, 0, 0.05), (1.04, 0.86, 0.82))
        d = smin(d, sd_ellipsoid(Q, (0, -0.05, -0.32), (1.0, 0.8, 0.55)), 0.2)       # 兩頰飽滿、下巴平
        for sx in (-1, 1):
            d = smin(d, sd_ellipsoid(Q, (sx * 0.8, 0.14, 0.7), (0.39, 0.24, 0.39)), 0.1)
        return d
    def muzzle_fn(P):
        Q = to_head(P)
        d = sd_ellipsoid(Q, (0, -0.56, -0.34), (0.5, 0.42, 0.42))      # 口鼻部：大而圓
        return d
    RB = Matrix.Rotation(math.radians(12), 3, 'Z')
    RBn = np.array(RB)
    def body_fn(P):
        # 身體（量的）：蛋形，肚子底部 0.5、脖子縫線 2.03、最寬處半寬 0.85；下面一點點寬
        Pb = P @ RBn                                                                                         # 身體微微往角色的左邊轉（約 12°，正面圖上中線偏右）
        d = sd_ellipsoid(Pb, (0, -0.02, 1.27), (0.86, 0.8, 0.77))
        d = smin(d, sd_ellipsoid(Pb, (0, 0.05, 1.86), (0.62, 0.55, 0.36)), 0.25)
        for x in (-0.39, 0.39):                                                                             # 腿：粗的直筒（半徑 0.37），高到 0.55、幾乎靠在一起，平底
            d = smin(d, sd_capsule_poly(P, [(x, -0.02, 0.18), (x, 0.0, 0.8)], 0.37), 0.1)
        arm_r = sd_capsule_poly(P, [(-0.66, -0.02, 1.95), (-0.9, -0.05, 1.55), (-0.98, -0.08, 1.25)], 0.27)  # 右手（垂下）：粗，貼著身體側邊往下垂
        arm_r = smin(arm_r, sd_ellipsoid(P, (-0.99, -0.1, 1.15), (0.29, 0.27, 0.3)), 0.1)
        d = smin(d, arm_r, 0.14)
        arm = sd_capsule_poly(P, [(0.62, 0.0, 1.92), (1.2, -0.12, 2.3)], 0.28)                              # 左手（舉起，握魔杖）：粗、短
        arm = smin(arm, sd_ellipsoid(P, (1.35, -0.15, 2.42), (0.31, 0.29, 0.31)), 0.08)
        d = smin(d, arm, 0.12)
        d = smin(d, sd_ellipsoid(P, (0, 0.82, 1.12), (0.25, 0.25, 0.25)), 0.05)                             # 尾巴
        return np.maximum(d, -P[:, 2])                                                                     # 平底
    H_ = 0.012
    body = sdf_part('Bear_Body', (-1.5, -1.0, -0.02), (1.8, 1.15, 2.95), H_, body_fn, 0.12)
    head = sdf_part('Bear_Head', (-1.6, -1.2, 1.8), (1.6, 1.3, 4.3), H_, head_fn, 0.12)
    muzzle = sdf_part('Bear_Muzzle', (-0.6, -1.3, 2.3), (0.8, -0.15, 3.05), 0.008, muzzle_fn, 0.25)
    # 嘴：口鼻部前面一片 D 字形（上緣平、下面圓）的紅色，平貼在表面上
    def mouth_mesh():
        Pm, Nm = project_to(muzzle_fn, [tuple(H((0, -1.2, -0.27)))])
        n = Vector(tuple(Nm[0]))
        o = ellipsoid('Bear_Mouth', (0, 0, 0), (0.18, 0.17, 0.03), seg=64, rings=24)
        up_ = Rh @ Vector((0, 0, 1))
        for v in o.data.vertices:
            if v.co.y > 0.03:
                v.co.y = 0.03                                  # 上緣切平
        Rf = frame(n, up_)
        o.data.transform(Matrix.Translation(Vector(tuple(Pm[0])) + n * 0.012) @ Rf.to_4x4())
        return o
    mouth = mouth_mesh()
    nose = ellipsoid('Bear_Nose', (0, 0, 0), (0.135, 0.08, 0.09), seg=40, rings=20)
    nose.data.transform(Matrix.Translation(H((0, -0.95, -0.1))) @ Rh.to_4x4())   # 口鼻部上緣
    eyes = []
    for sx in (-1, 1):
        o = ellipsoid('eye', (0, 0, 0), (0.12, 0.1, 0.125), seg=40, rings=20)
        o.data.transform(Matrix.Translation(H((sx * 0.42, -0.8, 0.06))) @ Rh.to_4x4())
        eyes.append(o)
    eyes = join(eyes, 'Bear_Eyes')
    # 腮紅、耳朵內側：貼著頭的表面的扁圓片
    def disc_on(fn, pw, r, thick, name):
        P, N = project_to(fn, [tuple(pw)])
        n = Vector(tuple(N[0]))
        o = ellipsoid(name, (0, 0, 0), (r, r, thick), seg=48, rings=12)
        o.data.transform(Matrix.Translation(Vector(tuple(P[0])) + n * (thick * 0.4)) @ frame(n).to_4x4())
        return o
    cheeks = join([disc_on(head_fn, H((sx * 0.8, -0.62, -0.2)), 0.23, 0.035, 'ck') for sx in (-1, 1)], 'Bear_Cheeks')
    ein = []
    for sx in (-1, 1):
        o = ellipsoid('ei', (0, 0, 0), (0.25, 0.025, 0.25), seg=48, rings=16)
        o.data.transform(Matrix.Translation(H((sx * 0.82, -0.1, 0.68))) @ Rh.to_4x4())
        ein.append(o)
    earin = join(ein, 'Bear_EarIn')

    # 魔杖、星星、閃光
    wand = tube('Bear_Wand', [Vector((1.36, -0.15, 1.95)), Vector((1.33, -0.15, 3.45))], 0.05, seg=16)
    sc = Vector((1.31, -0.15, 3.79))
    def star_fn(P):
        Q = P - np.array(sc)
        d2 = sd_star5(Q[:, 0], Q[:, 2], 0.36, 0.56)
        rr = 0.09
        wx, wy = d2 + rr, np.abs(Q[:, 1]) - 0.05
        return np.minimum(np.maximum(wx, wy), 0) + np.sqrt(np.maximum(wx, 0) ** 2 + np.maximum(wy, 0) ** 2) - rr
    star = sdf_part('Bear_Star', (0.85, -0.35, 3.33), (1.78, 0.05, 4.25), 0.008, star_fn, 0.35)
    sparks = []
    for (x, z) in ((1.06, 4.13), (1.59, 4.13), (0.89, 3.62), (1.73, 3.63)):
        d = (Vector((x, 0, z)) - Vector((sc.x, 0, sc.z))).normalized()
        a = Vector((x, -0.15, z)) - d * 0.06
        sparks.append(tube('sp', [a, a + d * 0.17], 0.024, seg=10))
    sparks = join(sparks, 'Bear_Sparks')

    # 縫線（照三視圖逐條對）
    st = []
    W = lambda v: tuple(RB @ Vector(v))                      # 身體局部 → 世界（身體轉了 12°）
    # 頭：中線從頭頂一路到兩眼之間、口鼻部上緣；口鼻部下面到下巴一小段；後面從頭頂到後頸
    st += dashes(head_fn, [tuple(H((0, -math.sin(a) * 1.0, math.cos(a) * 1.0))) for a in np.linspace(0.05, 1.22, 46)])
    st += dashes(head_fn, [tuple(H((0, -math.sin(a) * 1.0, math.cos(a) * 1.0))) for a in np.linspace(2.3, 2.62, 10)])
    st += dashes(head_fn, [tuple(H((0, math.sin(a) * 1.0, math.cos(a) * 1.0))) for a in np.linspace(0.05, 2.45, 64)])
    # 脖子一圈
    st += dashes(body_fn, [W((math.cos(a) * 0.9, math.sin(a) * 0.9, 2.02)) for a in np.linspace(0, 2 * math.pi, 120)])
    # 身體：前後各一道中線（脖子到肚子底部）；前後各一道大 U，從腋下沿身體兩側（靠近輪廓）繞過肚子底部到另一邊腋下
    st += dashes(body_fn, [W((0.0, -1.2, z)) for z in np.linspace(2.0, 0.53, 44)])
    st += dashes(body_fn, [W((0.0, 1.2, z)) for z in np.linspace(2.0, 0.53, 44)])
    for side in (-1, 1):
        st += dashes(body_fn, [W((0.82 * math.sin(a), side * 1.2, 0.55 + 1.3 * (1 - math.cos(a)))) for a in np.linspace(-1.45, 1.45, 96)])
    # 手臂：沿著手臂外緣、繞過手掌末端回到內緣（一整圈的外框）
    for a0, a1 in (((-0.66, -0.02, 1.95), (-0.99, -0.1, 1.15)), ((0.62, 0.0, 1.92), (1.35, -0.15, 2.42))):
        a0, a1 = Vector(a0), Vector(a1)
        ax = (a1 - a0).normalized()
        sdv = ax.cross(Vector((0, -1, 0))).normalized()
        loop = [a0.lerp(a1, t) + sdv * 0.45 for t in np.linspace(0.1, 1.0, 22)]
        loop += [a1 + (sdv * math.cos(u) + ax * math.sin(u)) * 0.45 for u in np.linspace(0.2, math.pi - 0.2, 16)]
        loop += [a0.lerp(a1, t) - sdv * 0.45 for t in np.linspace(1.0, 0.25, 18)]
        st += dashes(body_fn, [tuple(v + Vector((0, -0.25, 0))) for v in loop])
    # 腿：外側邊緣一條直線（前面看得到）、後面一條，腳底一圈
    for x, sx in ((-0.39, -1), (0.39, 1)):
        st += dashes(body_fn, [(x + sx * 0.6, -0.6, z) for z in np.linspace(0.52, 0.1, 12)])
        st += dashes(body_fn, [(x, 1.0, z) for z in np.linspace(0.6, 0.1, 14)])
        st += dashes(body_fn, [(x + math.cos(a) * 0.6, -0.01 + math.sin(a) * 0.6, 0.09) for a in np.linspace(0, 2 * math.pi, 90)])
    seams = join(st, 'Bear_Seams')

    parts = [body, head, muzzle, mouth, nose, eyes, cheeks, earin, wand, star, sparks, seams]
    T = Matrix.Diagonal((BR_U, BR_U, BR_U, 1))
    for o in parts:
        o.data.transform(T)
    return parts


# =====================================================================================
#   耳鼻猴：比例從正面圖（design-source/gashapon/耳鼻猴正面.png，1311×1200）與背面圖量出來；沒有側面圖，厚度依光影推斷。
#   單位：200px = 1，地面 z=0，正面圖中心 x 650、地面 y 1095。
#   頭：寬 3.0、高 2.3（推斷深 2.4），中心高 3.71；米白臉部遮罩（中心 z 3.35、寬 2.4、高 1.45）。
#   耳朵：大圓耳（寬 1.45、高 2.1，中心 (±1.78, 3.83)），內側米白、再一層粉橘。
#   白色頭帶繞頭一圈（前面高、後面低），背面中央一個白色蝴蝶結；正前方一個橘色大鼻子裝飾（寬 0.9、兩個鼻孔），頂端高出頭頂。
#   眼睛黑色橢圓 (±0.59, 3.59)；粉紅腮紅 (±0.95, 3.37)；棕色小鼻子 (0, 3.39)；張開的 D 字嘴（上緣 3.22、寬 0.5）＋粉紅舌頭。
#   身體棕色，米白肚子；短手垂在兩側，米白小手 (±1.2, 1.25)；腿 (±0.65)，半徑 0.38，米白腳掌。
#   藍色披風：脖子一圈領子，往後垂下、兩側往外翹（下擺兩端在 x −2.2 / +1.95）。
#   尾巴：從後腰往上繞過披風，往角色的左邊（+x）捲，末端在左肩後方（正面看得到在右耳下方）。
# =====================================================================================
MK_U = 0.394


def surf_front(fn, X, Z, y0=-5.0, y1=1.0, steps=300):
    """從正前方往後打到距離場表面：回傳 (點, 外法線)，X、Z 是陣列"""
    n = len(X)
    ys = np.linspace(y0, y1, steps)
    hit = np.full(n, np.nan)
    prev = None
    for i, y in enumerate(ys):
        d = fn(np.stack([X, np.full(n, y), Z], 1))
        if prev is not None:
            m = np.isnan(hit) & (prev > 0) & (d <= 0)
            t = prev[m] / (prev[m] - d[m])
            hit[m] = ys[i - 1] + t * (ys[i] - ys[i - 1])
        prev = d
    hit = np.where(np.isnan(hit), y1, hit)
    P = np.stack([X, hit, Z], 1)
    e = 1e-4
    g = np.stack([(fn(P + np.array(v) * e) - fn(P - np.array(v) * e)) / (2 * e) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1))], 1)
    return P, g / (np.linalg.norm(g, axis=1, keepdims=True) + 1e-9)


def patch_on(fn, name, c2, sdf2, height, profile, lift, seg=128, rings=18):
    """正面看是 sdf2 形狀的貼片，貼在距離場表面上、往外墊高"""
    cx, cz = c2
    th = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    R_ = []
    for a in th:
        lo_, hi_ = 0.0, 4.0
        for _ in range(40):
            mid = (lo_ + hi_) / 2
            if sdf2(cx + math.cos(a) * mid, cz + math.sin(a) * mid) < 0:
                lo_ = mid
            else:
                hi_ = mid
        R_.append(lo_)
    R_ = np.array(R_)
    ts = np.linspace(0, 1, rings + 1)
    X = np.concatenate([[cx]] + [cx + np.cos(th) * R_ * t for t in ts[1:]])
    Z = np.concatenate([[cz]] + [cz + np.sin(th) * R_ * t for t in ts[1:]])
    T = np.concatenate([[0.0]] + [np.full(seg, t) for t in ts[1:]])
    P, N = surf_front(fn, X, Z)
    hgt = np.array([lift + height * profile(t) for t in T])
    V = P + N * hgt[:, None]
    me = bpy.data.meshes.new(name)
    faces = [(0, 1 + j, 1 + (j + 1) % seg) for j in range(seg)]
    for i in range(rings - 1):
        b0, b1 = 1 + i * seg, 1 + (i + 1) * seg
        for j in range(seg):
            k = (j + 1) % seg
            faces.append((b0 + j, b1 + j, b1 + k, b0 + k))
    me.from_pydata([tuple(v) for v in V], [], faces)
    me.update()
    ob = link(name, me)
    bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    shade_smooth(ob)
    return ob


def build_monkey():
    HC = np.array((0.0, 0.1, 3.71))
    def head_fn(P):
        d = sd_ellipsoid(P, HC, (1.5, 1.2, 1.14))
        d = smin(d, sd_ellipsoid(P, HC + np.array((0, -0.08, -0.42)), (1.52, 1.12, 0.72)), 0.25)   # 腮幫子：頭下半部寬、飽滿
        for sx in (-1, 1):
            d = smin(d, sd_ellipsoid(P, (sx * 1.8, 0.38, 3.86), (0.75, 0.48, 1.07)), 0.1)      # 耳朵：厚、鼓
        return d
    def body_fn(P):
        d = sd_ellipsoid(P, (0, 0.05, 1.55), (1.36, 1.05, 0.92))
        d = smin(d, sd_ellipsoid(P, (0, 0.1, 2.22), (1.12, 0.82, 0.45)), 0.25)           # 肩膀、脖子
        for sx in (-1, 1):
            d = smin(d, sd_capsule_poly(P, [(sx * 1.02, 0.02, 2.15), (sx * 1.36, -0.02, 1.8), (sx * 1.4, -0.1, 1.55), (sx * 1.3, -0.18, 1.4)], 0.22), 0.12)   # 手臂：從肩膀往外彎、手肘外張，再往內收到腰側
            d = smin(d, sd_capsule_poly(P, [(sx * 0.65, 0.0, 1.0), (sx * 0.65, -0.02, 0.32)], 0.38), 0.1)    # 腿
        return d
    def cream_fn(P):
        d = 1e9
        for sx in (-1, 1):
            hand = sd_ellipsoid(P, (sx * 1.24, -0.24, 1.24), (0.3, 0.27, 0.3))                  # 米白握拳
            for ox in (-0.1, 0.0, 0.1):                                                             # 三道指縫
                hand = np.maximum(hand, -sd_capsule_poly(P, [(sx * 1.24 + ox, -0.56, 1.24), (sx * 1.24 + ox, -0.5, 1.02)], 0.022))
            foot = sd_ellipsoid(P, (sx * 0.66, -0.14, 0.16), (0.37, 0.44, 0.17))
            foot = np.maximum(foot, -P[:, 2])
            for ox in (-0.13, 0.0, 0.13):                                                  # 三道腳趾溝
                foot = np.maximum(foot, -(sd_capsule_poly(P, [(sx * 0.66 + ox, -0.62, 0.06), (sx * 0.66 + ox, -0.38, 0.3)], 0.025)))
            d = np.minimum(d, np.minimum(hand, foot))
        return d
    head = sdf_part('Monkey_Head', (-2.6, -1.3, 2.5), (2.6, 1.45, 4.95), 0.014, head_fn, 0.12)
    body = sdf_part('Monkey_Body', (-1.6, -1.2, 0.2), (1.6, 1.25, 2.8), 0.014, body_fn, 0.15)
    cream = sdf_part('Monkey_Cream', (-1.6, -0.75, -0.02), (1.6, 0.4, 1.6), 0.01, cream_fn, 0.3)

    plate = lambda t: 1.0 if t < 0.85 else max(0.0, math.cos((t - 0.85) / 0.15 * math.pi / 2)) ** 0.6
    dome = lambda t: math.sqrt(max(0.0, 1 - t ** 2.2))
    def ell2(cx, cz, rx, rz):
        return lambda x, z: (math.hypot((x - cx) / rx, (z - cz) / rz) - 1) * min(rx, rz)
    face = patch_on(head_fn, 'Monkey_Face', (0, 3.3), lambda x, z: max(ell2(0, 3.32, 1.26, 0.8)(x, z), z - 4.05, 2.72 - z), 0.012, plate, 0.0, seg=192, rings=24)
    eyes = join([patch_on(head_fn, 'eye', (sx * 0.59, 3.585), ell2(sx * 0.59, 3.585, 0.135, 0.185), 0.07, dome, 0.012, 64, 12) for sx in (-1, 1)], 'Monkey_Eyes')
    cheeks = join([patch_on(head_fn, 'ck', (sx * 0.95, 3.365), ell2(sx * 0.95, 3.365, 0.2, 0.19), 0.006, plate, 0.014, 64, 8) for sx in (-1, 1)], 'Monkey_Cheeks')
    nose = patch_on(head_fn, 'Monkey_Nose', (0, 3.385), ell2(0, 3.385, 0.15, 0.075), 0.06, dome, 0.012, 48, 10)
    mouth_sdf = lambda x, z: max(z - 3.215, ell2(0, 3.215, 0.25, 0.3)(x, z))
    mouth = patch_on(head_fn, 'Monkey_Mouth', (0, 3.08), mouth_sdf, 0.008, plate, 0.014, 96, 12)
    tongue = patch_on(head_fn, 'Monkey_Tongue', (0, 3.0), lambda x, z: max(ell2(0, 2.99, 0.16, 0.09)(x, z), mouth_sdf(x, z) + 0.02), 0.012, dome, 0.022, 64, 8)
    belly = patch_on(body_fn, 'Monkey_Belly', (0, 1.65), ell2(0, 1.65, 0.74, 0.58), 0.012, plate, 0.0, 128, 14)
    # 耳朵內側：米白圓片、再一層粉橘（靠頭的那側）
    def ear_disc(sx, cx, cz, rx, rz, dy, name):
        o = ellipsoid(name, (0, 0, 0), (rx, 0.03, rz), seg=48, rings=16)
        o.data.transform(Matrix.Translation((sx * cx, 0.38 - 0.47 + dy, cz)))
        return o
    # 耳朵內：棕色外圈 → 米白 → 偏向頭那側的粉橘 C 形 → 中間米白
    earin = join([ear_disc(sx, 1.82, 3.86, 0.6, 0.88, -0.01, 'ei') for sx in (-1, 1)] +
                 [ear_disc(sx, 1.9, 3.82, 0.27, 0.47, -0.045, 'ei2') for sx in (-1, 1)], 'Monkey_EarIn')
    earpk = join([ear_disc(sx, 1.8, 3.86, 0.44, 0.68, -0.028, 'ep') for sx in (-1, 1)], 'Monkey_EarPink')

    # 頭帶：馬鞍形地貼著頭繞一圈——前面在額頭上方（高 4.5）、兩側往下經過耳朵前面（3.65）、後腦又往上（4.0）；寬 0.25、厚 0.06
    HA, HB_, HCz = 1.5, 1.2, 1.14
    def band_pt(th, dz):
        z = 4.02 + 0.3 * math.cos(2 * th) + 0.25 * math.cos(th) + dz
        s_ = math.sqrt(max(0.0, 1 - ((z - HC[2]) / HCz) ** 2))
        p = Vector((HA * math.sin(th) * s_, HC[1] - HB_ * math.cos(th) * s_, z))
        g = Vector((p.x / HA ** 2, (p.y - HC[1]) / HB_ ** 2, (p.z - HC[2]) / HCz ** 2)).normalized()
        return p, g
    NS, W, TH = 200, 0.33, 0.085
    rows = [[band_pt(k / NS * 2 * math.pi, s0) for k in range(NS)] for s0 in (-W / 2, W / 2)]
    me = bpy.data.meshes.new('band'); bm = bmesh.new()
    L = [[bm.verts.new(p + g * h) for p, g in rows[r]] for r, h in ((0, 0.0), (0, TH * 0.8), (1, TH * 0.8), (1, 0.0))]
    mid_ = [bm.verts.new(rows[0][k][0].lerp(rows[1][k][0], 0.5) + (rows[0][k][1] + rows[1][k][1]).normalized() * TH) for k in range(NS)]
    loops = [L[0], L[1], mid_, L[2], L[3]]
    for a_, b_ in zip(loops, loops[1:] + loops[:1]):
        for k in range(NS):
            k2 = (k + 1) % NS
            bm.faces.new((a_[k], a_[k2], b_[k2], b_[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    band = link('band', me); shade_smooth(band)
    # 背面的蝴蝶結（頭帶最後面那一點）
    kb = NS // 2
    bp = rows[0][kb][0].lerp(rows[1][kb][0], 0.5)
    bn = (rows[0][kb][1] + rows[1][kb][1]).normalized()
    bow = [ellipsoid('knot', tuple(bp + bn * 0.1), (0.16, 0.12, 0.15), seg=32, rings=16)]
    for sx in (-1, 1):
        o = ellipsoid('loop', (0, 0, 0), (0.42, 0.12, 0.27), seg=40, rings=20)
        o.data.transform(Matrix.Translation(bp + bn * 0.07 + Vector((sx * 0.4, 0, 0))) @ Matrix.Rotation(sx * 0.25, 4, 'Y'))
        bow.append(o)
    band = join([band] + bow, 'Monkey_Band')
    # 橘色大鼻子裝飾（頭帶正前方）：上面窄的鼻樑、下面寬的鼻頭＋兩邊鼻翼、兩個鼻孔
    def orn_fn(P):
        # 貼著額頭、沿頭頂往後躺的一個鼻子：鼻樑順著頭的弧度往上往後，鼻頭和鼻翼在最前面下方，鼻孔朝前下
        ridge = [(0, -1.12, 4.12), (0, -1.02, 4.45), (0, -0.82, 4.74), (0, -0.52, 4.92), (0, -0.22, 4.98)]
        d = 1e9
        for k in range(len(ridge) - 1):
            r0, r1 = 0.3 - 0.02 * k, 0.3 - 0.02 * (k + 1)
            d = np.minimum(d, sd_capsule_poly(P, [ridge[k], ridge[k + 1]], (r0 + r1) / 2))
        d = smin(d, sd_ellipsoid(P, (0, -1.3, 4.12), (0.3, 0.27, 0.27)), 0.1)              # 鼻頭
        for sx in (-1, 1):
            d = smin(d, sd_ellipsoid(P, (sx * 0.33, -1.17, 4.05), (0.23, 0.23, 0.2)), 0.12)    # 鼻翼
        for sx in (-1, 1):
            d = np.maximum(d, -sd_ellipsoid(P, (sx * 0.16, -1.42, 3.97), (0.085, 0.12, 0.07)))  # 鼻孔
        return np.maximum(d, -head_fn(P) - 0.02)                                                # 不伸進頭裡
    orn = sdf_part('Monkey_Orn', (-0.7, -1.65, 3.7), (0.7, 0.2, 5.35), 0.01, orn_fn, 0.25)

    # 披風：領子繞脖子一圈，往後垂下、兩側往外翹
    def cape_surface():
        # 從肩膀往下垂、再像鐘一樣外擴；兩側下擺往上翹；側邊在手臂後面（正面看披風在手臂後方、從兩側露出來）
        me = bpy.data.meshes.new('Monkey_Cape'); bm = bmesh.new()
        NA, NV = 112, 30
        grid_ = []
        TH_ = math.radians(98)
        for i in range(NA + 1):
            th = -TH_ + 2 * TH_ * i / NA                      # 0 = 正後方
            sg = abs(math.sin(th))
            zb = 0.9 + 0.62 * sg ** 2.4                       # 下擺：後面低、兩側往上翹
            col = []
            for j in range(NV + 1):
                t = j / NV
                e = t ** 1.6                                  # 先往下垂、越往下越外擴
                rx = 0.98 + (2.3 - 0.98) * e
                ry = 0.76 + (1.5 - 0.76) * e
                z = 2.48 + (zb - 2.48) * t
                p = Vector((math.sin(th) * rx, math.cos(th) * ry + 0.05, z))
                if body_fn(np.array([tuple(p)]))[0] < 0.07:   # 不能穿進身體、手臂：沿水平方向往外推
                    dirh = Vector((p.x, p.y - 0.05, 0)).normalized()
                    for _ in range(60):
                        p = p + dirh * 0.015
                        if body_fn(np.array([tuple(p)]))[0] >= 0.07:
                            break
                col.append(bm.verts.new(p))
            grid_.append(col)
        for i in range(NA):
            for j in range(NV):
                bm.faces.new((grid_[i][j], grid_[i + 1][j], grid_[i + 1][j + 1], grid_[i][j + 1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
        ob = link('Monkey_Cape', me)
        sm = ob.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.5; sm.iterations = 8
        so = ob.modifiers.new('so', 'SOLIDIFY'); so.thickness = 0.06; so.offset = 0
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier='sm'); bpy.ops.object.modifier_apply(modifier='so')
        shade_smooth(ob)
        return ob
    cape = cape_surface()
    collar = tube('collar', [Vector((math.cos(a) * 0.98, math.sin(a) * 0.76 + 0.08, 2.5)) for a in np.linspace(0, 2 * math.pi, 97)], 0.12, seg=16, caps=False)   # 領子：緊貼脖子、就在頭下面
    cape = join([cape, collar], 'Monkey_Cape')
    # 尾巴
    # 尾巴：從後腰、披風下擺底下出來，沿著披風外面往上（不穿過披風），到左肩後方往外捲一圈；末端收圓
    tail_pts = curve_pts([(0.0, 0.9, 0.78), (0.04, 1.4, 0.74), (0.08, 1.7, 0.95), (0.12, 1.66, 1.45), (0.22, 1.5, 2.1), (0.45, 1.3, 2.72),
                          (0.95, 1.15, 3.08), (1.45, 0.95, 3.06), (1.72, 0.8, 2.8), (1.66, 0.78, 2.55), (1.47, 0.82, 2.53), (1.42, 0.86, 2.7)], 160)
    tr = 0.16
    tail = join([tube('Monkey_Tail', tail_pts, tr, seg=22, taper=lambda t: 1.0 - 0.12 * t),
                 ellipsoid('tailend', tuple(tail_pts[-1]), (tr * 0.88, tr * 0.88, tr * 0.88), seg=24, rings=12)], 'Monkey_Tail')

    parts = [head, body, cream, face, eyes, cheeks, nose, mouth, tongue, belly, earin, earpk, band, orn, cape, tail]
    T = Matrix.Diagonal((MK_U, MK_U, MK_U, 1))
    for o in parts:
        o.data.transform(T)
    return parts


# =====================================================================================
#   泰迪熊（第二版，從設計圖像素直接做）：design-source/gashapon/泰迪熊三視圖設定稿.png
#   1. 三張圖的熊身輪廓（去掉魔杖、星星）逐像素切出來，三個方向的輪廓交集（visual hull），
#      再和一組「稍大的基本形狀」（蛋形身體、圓柱手腳、頭、耳朵、尾巴）取交集——輪廓決定外形（三個視角和設計圖一致），
#      基本形狀決定手腳的立體粗細（只靠輪廓交集會把手、尾巴拉成和身體一樣厚的板子）。
#   2. 顏色區塊（白色口鼻、粉紅腮紅、紅色嘴、淺色耳內）照正面圖的像素從正前方投影到表面，做成貼片；眼睛、鼻子做成珠子。
#   3. 縫線：用顏色把每一段縫線的像素抓出來，分別從正面、背面、側面打到表面上，做成一段一段凸起的縫線。
#   單位：150px = 1，地面 z=0；正面圖身體中心 x 356、側面圖 882（從角色左側看，臉朝左）、背面圖 1424；地面在圖上 y 690。
# =====================================================================================
def build_teddy3():
    """泰迪熊 v2（貼圖版）：v2 原本的貼圖＋網站的毛氈材質，由 teddy3.py 做小幅的形狀調整、圓眼珠、尾巴"""
    import sys
    sys.path.insert(0, HERE)
    import hull as HL
    import teddy3
    return teddy3.build(HL, tube, join, link)


def build_teddy2():
    """泰迪熊 v2：使用者提供的 Tripo 模型（兩手垂下、不拿魔杖），由 teddy2.py 上色、加零件"""
    import sys
    sys.path.insert(0, HERE)
    import hull as HL
    import teddy2
    return teddy2.build(HL, tube, join, link)


def build_monkey3():
    """耳鼻猴 v2（貼圖版）：模型原本的貼圖＋網站的毛氈材質，頭帶藍改白、背後加蝴蝶結（monkey2.py）"""
    import sys
    sys.path.insert(0, HERE)
    import hull as HL
    import monkey2
    return monkey2.build(HL, tube, join, link)


def build_monkey2():
    """耳鼻猴：使用者提供的模型（Model-Monkey.glb），由 monkey.py 撫平、分色、加外加零件、手指腳趾、蝴蝶結、尾巴"""
    import sys
    sys.path.insert(0, HERE)
    import hull as HL
    import monkey
    return monkey.build(HL, tube, join, link)


def build_teddy():
    """泰迪熊：使用者提供的模型（Model-Teddy.glb），由 teddy.py 收平五官、撫平、分材質、貼縫線"""
    import sys
    sys.path.insert(0, HERE)
    import hull as HL
    A = HL.load_rgb(os.path.join(HERE, '..', '..', 'design-source', 'gashapon', '泰迪熊三視圖設定稿.png'))
    r, g, b = A[..., 0], A[..., 1], A[..., 2]
    Hh, Ww = r.shape
    Yi, Xi = np.mgrid[0:Hh, 0:Ww]
    bg = (np.abs(r - 222) < 14) & (np.abs(g - 220) < 14) & (np.abs(b - 225) < 14)
    sil = ~HL.flood_bg(bg | ((r - b < 25) & (r > 150) & (Yi > 600))) & (Yi < 692)
    yellow = (r > 220) & (g > 170) & (b < 90)
    body_sil = sil & ~yellow
    body_sil[:285, 536:578] = False                                       # 正面圖的魔杖
    fur = (r - b > 60) & ~yellow
    hpass = g - HL.blur2(g, 7)
    seam = sil & fur & (hpass < -9) & (r - g > 45)
    seam |= sil & fur & (Xi > 1140) & (hpass < -5.5) & (r - g > 42)                  # 背面的縫線對比比較低
    white = sil & (r > 238) & (g > 225) & (b > 200)
    black = sil & (r < 95) & (g < 95) & (b < 95)
    red = sil & (r > 150) & (g < 80) & (b < 80)
    pink = sil & (r > 230) & (g > 110) & (g < 178) & (b > 128)
    earin = sil & (r > 245) & (g > 205) & (b > 140) & (b < 186) & (Yi < 215)
    S, GND = 150.0, 690.0
    pxF = lambda x: 356 + S * x
    pxS = lambda y: 882 + S * y
    pxB = lambda x: 1424 - S * x
    pyZ = lambda z: GND - S * z

    def grow(m, k):
        return HL.blur2(m.astype(np.float32), k) > 0.01
    front = Xi < 640
    # 縫線：嚴格條件抓出確定的小段 → 連起來 → 細化成骨架 → 描出一條條縫線的走向 → 沿線用固定間距排一段一段的縫線，投影到表面
    near_parts = grow(white | black | red | pink | yellow, 4) | grow(~sil, 3)
    strict = sil & fur & (hpass < -9) & (r - g > 45) & ~near_parts
    strict |= sil & fur & (Xi > 1140) & (hpass < -6) & (r - g > 42) & ~near_parts
    dash = np.zeros_like(strict)
    for comp in HL.components(strict, 8, 140):
        c = comp.mean(0)
        u, s_, vt = np.linalg.svd(comp - c, full_matrices=False)
        half = np.abs((comp - c) @ vt[0]).max(); width = np.abs((comp - c) @ vt[1]).max() * 2 + 1
        if 5 <= half * 2 <= 30 and width <= 7 and half * 2 >= 1.5 * width:
            dash[comp[:, 0], comp[:, 1]] = True
    # 每條縫線的大致走向（照設計圖標的），再把每一點吸附到附近實際偵測到的縫線像素：位置是從圖上量的，雜點不會被當成縫線
    PATHS = {
        'F': [[(365, 135), (380, 165), (392, 200), (397, 228)],                                     # 頭的中線（頭頂到口鼻上緣）
              [(398, 356), (396, 386)],                                                             # 口鼻下面到下巴
              [(248, 386), (300, 393), (385, 396), (450, 389), (476, 381)],                         # 脖子
              [(381, 400), (383, 470), (383, 530), (381, 584)],                                     # 身體中線
              [(276, 404), (258, 450), (250, 510), (262, 560), (300, 592), (345, 601), (400, 599), (450, 581), (482, 541), (488, 481), (480, 421), (461, 396)],   # 肚子的 U
              [(238, 386), (205, 420), (176, 470), (162, 520), (170, 546), (200, 548), (220, 528)],  # 垂下的手外框
              [(256, 410), (246, 460), (238, 520)],                                                 # 垂下的手內側
              [(478, 421), (512, 405), (545, 388)],                                                 # 舉起的手下緣
              [(246, 562), (248, 620), (256, 656), (300, 663), (340, 659)],                         # 左腿外側＋腳底
              [(480, 562), (475, 620), (470, 656), (445, 661), (415, 660)],                         # 右腿外側＋腳底
              [(381, 600), (381, 642)]],                                                           # 兩腿之間
        'S': [[(905, 462), (906, 540), (905, 622)], [(955, 458), (957, 540)], [(830, 468), (827, 520), (836, 562)],
              [(826, 655), (860, 661), (896, 651)], [(822, 376), (862, 396), (920, 440)]],
        'B': [[(1421, 140), (1421, 300), (1421, 470)], [(1421, 572), (1421, 640), (1420, 688)],
              [(1310, 376), (1360, 381), (1421, 383), (1480, 381), (1532, 376)],
              [(1336, 386), (1301, 450), (1298, 520), (1311, 561), (1351, 591), (1421, 601), (1490, 591), (1530, 561), (1545, 521), (1541, 451), (1509, 386)],
              [(1290, 386), (1251, 430), (1233, 480), (1236, 531)], [(1552, 386), (1590, 430), (1611, 480), (1610, 526)],
              [(1331, 602), (1331, 688)], [(1482, 602), (1482, 688)],
              [(1422 + 38 * math.cos(a_), 522 + 38 * math.sin(a_)) for a_ in np.linspace(0, 2 * math.pi, 40)]],
    }
    dy_, dx_ = np.nonzero(dash)
    DP = np.stack([dy_, dx_], 1).astype(float)
    def snap(path):
        P_ = np.array([(y, x) for x, y in path], float)
        out = []
        for i in range(len(P_) - 1):
            a0, a1 = P_[i], P_[i + 1]
            n_ = max(2, int(np.linalg.norm(a1 - a0) / 3))
            for t_ in np.linspace(0, 1, n_, endpoint=False):
                out.append(a0 + (a1 - a0) * t_)
        out.append(P_[-1])
        out = np.array(out)
        res = out.copy()
        for i, q in enumerate(out):
            m_ = np.abs(DP - q).max(1) < 9
            if m_.sum() >= 3:
                res[i] = q + (DP[m_].mean(0) - q) * 0.8
        k_ = 3
        return np.array([res[max(0, i - k_):i + k_ + 1].mean(0) for i in range(len(res))])
    import teddy
    return teddy.build(HL, tube, join, link, PATHS, snap)


def build_bear2():
    import sys
    sys.path.insert(0, HERE)
    import hull as HL
    A = HL.load_rgb(os.path.join(HERE, '..', '..', 'design-source', 'gashapon', '泰迪熊三視圖設定稿.png'))
    r, g, b = A[..., 0], A[..., 1], A[..., 2]
    Hh, Ww = r.shape
    Yi, Xi = np.mgrid[0:Hh, 0:Ww]
    bg = (np.abs(r - 222) < 14) & (np.abs(g - 220) < 14) & (np.abs(b - 225) < 14)
    sil = ~HL.flood_bg(bg | ((r - b < 25) & (r > 150) & (Yi > 600))) & (Yi < 692)
    yellow = (r > 220) & (g > 170) & (b < 90)
    body_sil = sil & ~yellow
    body_sil[:285, 536:578] = False                                       # 正面圖的魔杖
    fur = (r - b > 60) & ~yellow
    hpass = g - HL.blur2(g, 7)
    seam = sil & fur & (hpass < -9) & (r - g > 45)
    seam |= sil & fur & (Xi > 1140) & (hpass < -5.5) & (r - g > 42)                  # 背面的縫線對比比較低
    white = sil & (r > 238) & (g > 225) & (b > 200)
    black = sil & (r < 95) & (g < 95) & (b < 95)
    red = sil & (r > 150) & (g < 80) & (b < 80)
    pink = sil & (r > 230) & (g > 110) & (g < 178) & (b > 128)
    earin = sil & (r > 245) & (g > 205) & (b > 140) & (b < 186) & (Yi < 215)
    S, GND = 150.0, 690.0
    pxF = lambda x: 356 + S * x
    pxS = lambda y: 882 + S * y
    pxB = lambda x: 1424 - S * x
    pyZ = lambda z: GND - S * z

    # ---- 1. 身體：平順的基本形狀，位置與大小是用設計圖的正面＋側面輪廓自動擬合出來的（bear_fit.json，scratchpad/bearfit.py），
    #         輪廓和設計圖只差邊緣一兩格；各部位之間平滑地融在一起
    import json
    p = json.load(open(os.path.join(HERE, 'bear_fit.json')))
    def body_fn(P):
        d = sd_ellipsoid(P, (p['hx'], p['hy'], p['hz']), (p['ha'], p['hb'], p['hc']))
        d = smin(d, sd_ellipsoid(P, (p['mx'], p['my'], p['mz']), (p['mr'], p['mr'] * 0.85, p['mr'] * 0.85)), 0.12)   # 口鼻部
        for ex, ez in ((p['e1x'], p['e1z']), (p['e2x'], p['e2z'])):
            d = smin(d, sd_ellipsoid(P, (ex, p['ey'], ez), (p['er'], 0.3, p['er'])), 0.08)                               # 耳朵（厚而圓）
        bd = sd_ellipsoid(P, (0, -0.02, p['bz']), (p['ba'], p['bb'], p['bc']))
        bd = smin(bd, sd_ellipsoid(P, (0, 0.05, p['uz']), (p['ua'], p['ua'] * 0.88, p['uc'])), 0.2)
        for sx in (-1, 1):
            bd = smin(bd, sd_capsule_poly(P, [(sx * p['lx'], 0, 0.18), (sx * p['lx'], 0, p['lt'])], p['lr']), 0.1)          # 腿
        bd = smin(bd, sd_capsule_poly(P, [(p['a2x'], 0, p['a2z']), (p['a1x'], -0.08, p['a1z'])], p['ar']), 0.12)            # 垂下的手
        bd = smin(bd, sd_capsule_poly(P, [(p['r1x'], 0, p['r1z']), (p['r2x'], -0.15, p['r2z'])], p['rr']), 0.12)            # 舉起的手
        bd = smin(bd, sd_ellipsoid(P, (0, p['ty'], p['tz']), (p['tr'],) * 3), 0.05)                                      # 尾巴
        d = np.minimum(d, bd)                                                                                           # 頭和身體之間保留一道接縫
        return np.maximum(d, -P[:, 2])
    body = sdf_part('Bear_Body', (-1.75, -1.4, -0.02), (1.95, 1.35, 4.05), 0.012, body_fn, 0.2)
    bpy.context.view_layer.update()

    # 打到表面：正面（往 +y）、背面（往 −y）、側面（往 −x）
    def hit(view, px, py):
        z = (GND - py) / S
        if view == 'F':
            o, d = Vector(((px - 356) / S, -5, z)), Vector((0, 1, 0))
        elif view == 'B':
            o, d = Vector((-(px - 1424) / S, 5, z)), Vector((0, -1, 0))
        else:
            o, d = Vector((5, (px - 882) / S, z)), Vector((-1, 0, 0))
        ok, loc, nor, _ = body.ray_cast(o, d)
        return (Vector(loc), Vector(nor).normalized()) if ok else (None, None)

    # ---- 2. 顏色貼片（正面投影）、眼睛鼻子珠子 ----
    def decal(name, mask, lift, step=2, x0=0, x1=640):
        pts = {}
        ys_, xs_ = np.nonzero(mask[:, x0:x1])
        xs_ = xs_ + x0
        keep = set()
        for y, x in zip(ys_, xs_):
            if y % step == 0 and x % step == 0:
                keep.add((y, x))
        verts, idx = [], {}
        for (y, x) in keep:
            p, n = hit('F', x, y)
            if p is None or n.y > -0.3:
                continue                                                 # 斜角處不貼（從正前方投影會拉出拖痕）
            idx[(y, x)] = len(verts)
            verts.append(tuple(p + n * lift))
        faces = []
        for (y, x) in idx:
            q = [(y, x), (y, x + step), (y + step, x + step), (y + step, x)]
            if all(k in idx for k in q):
                faces.append([idx[k] for k in q])
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces); me.update()
        ob = link(name, me)
        sm = ob.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.5; sm.iterations = 2
        so = ob.modifiers.new('so', 'SOLIDIFY'); so.thickness = 0.012; so.offset = 1
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier='sm'); bpy.ops.object.modifier_apply(modifier='so')
        shade_smooth(ob)
        return ob
    def grow(m, k):
        return HL.blur2(m.astype(np.float32), k) > 0.01
    front = Xi < 640
    def clean(m, k=2):                                                     # 毛絨紋理會讓顏色區域有雜點：先磨平、再補洞
        return HL.blur2(HL.blur2(m.astype(np.float32), k) > 0.5, k + 1) > 0.35
    near = lambda cx, cy, rad: (Xi - cx) ** 2 + (Yi - cy) ** 2 < rad ** 2
    def ellfit(m, flat_top=False):
        # 從顏色區域算出中心、長短軸、角度，做成邊緣乾淨的橢圓（嘴巴：上緣切平）
        out = np.zeros_like(m)
        for comp in HL.components(m, 60, 10 ** 6):
            c = comp.mean(0)
            cov = np.cov((comp - c).T)
            ev, evec = np.linalg.eigh(cov)
            ax = 2 * np.sqrt(np.maximum(ev, 1e-6))
            d = np.stack([Yi - c[0], Xi - c[1]], -1) @ evec
            e = (d[..., 0] / ax[0]) ** 2 + (d[..., 1] / ax[1]) ** 2 < 1
            if flat_top:
                y0_, y1_ = comp[:, 0].min(), comp[:, 0].max()
                e &= Yi >= y0_ + 0.22 * (y1_ - y0_)                     # 上緣切平（D 字形）
            out |= e
        return out
    muzzle = decal('Bear_Muzzle', ellfit(clean(white | red | black, 3) & near(407, 300, 75)), 0.006, step=1)
    mouth = decal('Bear_Mouth', ellfit(clean(red) & near(412, 302, 40), True), 0.016, step=1)
    cheeks = decal('Bear_Cheeks', ellfit(clean(pink, 3) & front), 0.01, step=1)
    # 耳內：直接放在耳朵正面（耳朵比頭的正面靠後，從正前方投影會打到額頭上）；位置、大小照設計圖量的
    ein = []
    for comp in HL.components(clean(earin, 3) & (near(212, 162, 40) | near(430, 140, 38)), 60, 10 ** 6):
        cy_, cx_ = comp.mean(0)
        rx_ = (comp[:, 1].max() - comp[:, 1].min()) / 2 / S
        rz_ = (comp[:, 0].max() - comp[:, 0].min()) / 2 / S
        ex = (cx_ - 356) / S
        ez = (GND - cy_) / S
        o = ellipsoid('ei', (ex, p['ey'] - 0.3 + 0.012, ez), (rx_, 0.02, rz_), seg=48, rings=16)
        ein.append(o)
    earin = join(ein, 'Bear_EarIn')
    beads = []
    for comp in HL.components(black & front & (Yi < 330), 30, 4000):      # 只在臉上（腳下的陰影不算）
        cy, cx = comp.mean(0)
        p, n = hit('F', cx, cy)
        if p is None:
            continue
        ry = (comp[:, 0].max() - comp[:, 0].min() + 1) / 2 / S
        rx = (comp[:, 1].max() - comp[:, 1].min() + 1) / 2 / S
        o = ellipsoid('bead', (0, 0, 0), (rx, ry, min(rx, ry) * 0.6), seg=40, rings=20)
        o.data.transform(Matrix.Translation(p + n * min(rx, ry) * 0.15) @ frame(n).to_4x4())
        beads.append((cy, o))
    nose = [o for cy, o in beads if cy > 258]
    eyes = [o for cy, o in beads if cy <= 258]
    nose = join(nose, 'Bear_Nose') if nose else None
    eyes = join(eyes, 'Bear_Eyes')

    # ---- 3. 縫線：每一段各自投影 ----
    # 縫線：嚴格條件抓出確定的小段 → 連起來 → 細化成骨架 → 描出一條條縫線的走向 → 沿線用固定間距排一段一段的縫線，投影到表面
    near_parts = grow(white | black | red | pink | yellow, 4) | grow(~sil, 3)
    strict = sil & fur & (hpass < -9) & (r - g > 45) & ~near_parts
    strict |= sil & fur & (Xi > 1140) & (hpass < -6) & (r - g > 42) & ~near_parts
    dash = np.zeros_like(strict)
    for comp in HL.components(strict, 8, 140):
        c = comp.mean(0)
        u, s_, vt = np.linalg.svd(comp - c, full_matrices=False)
        half = np.abs((comp - c) @ vt[0]).max(); width = np.abs((comp - c) @ vt[1]).max() * 2 + 1
        if 5 <= half * 2 <= 30 and width <= 7 and half * 2 >= 1.5 * width:
            dash[comp[:, 0], comp[:, 1]] = True
    # 每條縫線的大致走向（照設計圖標的），再把每一點吸附到附近實際偵測到的縫線像素：位置是從圖上量的，雜點不會被當成縫線
    PATHS = {
        'F': [[(365, 135), (380, 165), (392, 200), (397, 228)],                                     # 頭的中線（頭頂到口鼻上緣）
              [(398, 356), (396, 386)],                                                             # 口鼻下面到下巴
              [(248, 386), (300, 393), (385, 396), (450, 389), (476, 381)],                         # 脖子
              [(381, 400), (383, 470), (383, 530), (381, 584)],                                     # 身體中線
              [(276, 404), (258, 450), (250, 510), (262, 560), (300, 592), (345, 601), (400, 599), (450, 581), (482, 541), (488, 481), (480, 421), (461, 396)],   # 肚子的 U
              [(238, 386), (205, 420), (176, 470), (162, 520), (170, 546), (200, 548), (220, 528)],  # 垂下的手外框
              [(256, 410), (246, 460), (238, 520)],                                                 # 垂下的手內側
              [(478, 421), (512, 405), (545, 388)],                                                 # 舉起的手下緣
              [(246, 562), (248, 620), (256, 656), (300, 663), (340, 659)],                         # 左腿外側＋腳底
              [(480, 562), (475, 620), (470, 656), (445, 661), (415, 660)],                         # 右腿外側＋腳底
              [(381, 600), (381, 642)]],                                                           # 兩腿之間
        'S': [[(905, 462), (906, 540), (905, 622)], [(955, 458), (957, 540)], [(830, 468), (827, 520), (836, 562)],
              [(826, 655), (860, 661), (896, 651)], [(822, 376), (862, 396), (920, 440)]],
        'B': [[(1421, 140), (1421, 300), (1421, 470)], [(1421, 572), (1421, 640), (1420, 688)],
              [(1310, 376), (1360, 381), (1421, 383), (1480, 381), (1532, 376)],
              [(1336, 386), (1301, 450), (1298, 520), (1311, 561), (1351, 591), (1421, 601), (1490, 591), (1530, 561), (1545, 521), (1541, 451), (1509, 386)],
              [(1290, 386), (1251, 430), (1233, 480), (1236, 531)], [(1552, 386), (1590, 430), (1611, 480), (1610, 526)],
              [(1331, 602), (1331, 688)], [(1482, 602), (1482, 688)],
              [(1422 + 38 * math.cos(a_), 522 + 38 * math.sin(a_)) for a_ in np.linspace(0, 2 * math.pi, 40)]],
    }
    dy_, dx_ = np.nonzero(dash)
    DP = np.stack([dy_, dx_], 1).astype(float)
    def snap(path):
        P_ = np.array([(y, x) for x, y in path], float)
        out = []
        for i in range(len(P_) - 1):
            a0, a1 = P_[i], P_[i + 1]
            n_ = max(2, int(np.linalg.norm(a1 - a0) / 3))
            for t_ in np.linspace(0, 1, n_, endpoint=False):
                out.append(a0 + (a1 - a0) * t_)
        out.append(P_[-1])
        out = np.array(out)
        res = out.copy()
        for i, q in enumerate(out):
            m_ = np.abs(DP - q).max(1) < 9
            if m_.sum() >= 3:
                res[i] = q + (DP[m_].mean(0) - q) * 0.8
        k_ = 3
        return np.array([res[max(0, i - k_):i + k_ + 1].mean(0) for i in range(len(res))])
    curves = [(v, snap(pth)) for v, lst in PATHS.items() for pth in lst]
    st = []
    DL, GP = 0.075, 0.05
    for view, cv in curves:
        hits = [hit(view, x, y) for y, x in cv]
        P3 = [(p, n) for p, n in hits if p is not None and (view != 'S' or n.x > 0.5) and (view != 'F' or n.y < -0.2) and (view != 'B' or n.y > 0.2)]
        if len(P3) < 4:
            continue
        pts = [p for p, n in P3]; nrm = [n for p, n in P3]
        L = [0.0]
        for i in range(1, len(pts)):
            L.append(L[-1] + (pts[i] - pts[i - 1]).length)
        def at(sv):
            j = max(1, min(len(L) - 1, int(np.searchsorted(L, sv))))
            t_ = (sv - L[j - 1]) / max(1e-9, L[j] - L[j - 1])
            return pts[j - 1].lerp(pts[j], t_), nrm[j - 1].lerp(nrm[j], t_).normalized()
        s0 = GP / 2
        while s0 + DL <= L[-1]:
            q = [at(s0 + DL * f) for f in (0, 0.5, 1)]
            st.append(tube('st', [p + n * 0.012 for p, n in q], 0.017, seg=8))
            s0 += DL + GP
    seams = join(st, 'Bear_Seams')

    # ---- 魔杖、星星、閃光（沿用量好的位置）----
    sc = Vector((1.31, -0.15, 3.79))
    wand = tube('Bear_Wand', [Vector((1.36, -0.15, 1.95)), Vector((1.315, -0.15, 3.72))], 0.05, seg=16)   # 魔杖插進星星裡（接在一起）
    def star_fn(P):
        Q = P - np.array(sc)
        d2 = sd_star5(Q[:, 0], Q[:, 2], 0.36, 0.56)
        rr = 0.09
        wx, wy = d2 + rr, np.abs(Q[:, 1]) - 0.05
        return np.minimum(np.maximum(wx, wy), 0) + np.sqrt(np.maximum(wx, 0) ** 2 + np.maximum(wy, 0) ** 2) - rr
    star = sdf_part('Bear_Star', (0.85, -0.4, 3.33), (1.78, 0.1, 4.25), 0.008, star_fn, 0.35)
    sparks = None                                                           # 四道閃光不要（使用者 2026-11-20）
    print('bear2: seams', len(st), 'beads', len(beads))
    parts = [p for p in (body, muzzle, mouth, cheeks, earin, eyes, nose, seams, wand, star, sparks) if p is not None]
    T = Matrix.Diagonal((BR_U, BR_U, BR_U, 1))
    for o in parts:
        o.data.transform(T)
    return parts


def restitch_normals(objs):
    # 同一張皮切成好幾塊（不同材質）：交界的頂點用所有塊一起算的平滑法線，交界才不會有明暗接縫（使用者修過形狀也一樣）
    acc = {}
    key_ = lambda co: (round(co[0], 5), round(co[1], 5), round(co[2], 5))
    for o in objs:
        me = o.data
        for p_ in me.polygons:
            nw = p_.normal * p_.area
            for vi in p_.vertices:
                k = key_(me.vertices[vi].co)
                acc[k] = acc.get(k, Vector((0, 0, 0))) + nw
    for o in objs:
        me = o.data
        ns = []
        for v_ in me.vertices:
            n_ = acc.get(key_(v_.co), v_.normal)
            ns.append(n_.normalized() if n_.length > 0 else v_.normal)
        me.normals_split_custom_set_from_vertices(ns)
    print('restitch normals', [o.name for o in objs])


def conform_cheeks(skin, ck, bulge=0.007):
    # 腮紅貼平臉頰：依照臉頰表面的弧度重新做兩片圓餅，中間微微隆起（邊緣貼著臉）
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(skin, dg)
    me = ck.data
    n = len(me.vertices); par = list(range(n))
    def f(i):
        while par[i] != i:
            par[i] = par[par[i]]; i = par[i]
        return i
    for e in me.edges:
        a_, b_ = f(e.vertices[0]), f(e.vertices[1])
        if a_ != b_:
            par[a_] = b_
    groups = {}
    for i in range(n):
        groups.setdefault(f(i), []).append(i)
    bm = bmesh.new()
    for ids in groups.values():
        P = np.array([me.vertices[i].co[:] for i in ids]); c = P.mean(0)
        loc, nor, _, _ = bvh.find_nearest(Vector(c))
        dv = (Vector(nor) * 0.8 + Vector((0, -1, 0)) * 0.2).normalized()
        up = (Vector((0, 0, 1)) - dv * dv.z).normalized(); rt = up.cross(dv).normalized()
        R = float(np.max(np.linalg.norm((P - c) - np.outer((P - c) @ np.array(dv[:]), dv[:]), axis=1)))
        NS, NR = 72, 10
        def place(u, v, off):
            o_ = Vector(loc) + rt * u + up * v + dv * 0.3
            h = bvh.ray_cast(o_, -dv)
            p_ = h[0] if h[0] is not None else Vector(loc) + rt * u + up * v
            nn = h[1] if h[1] is not None else dv
            return bm.verts.new(p_ + nn * off)
        lift = lambda r: 0.0015 + bulge * (1 - r * r)
        cen = place(0, 0, lift(0))
        rings = [[place(R * r * math.cos(t), R * r * math.sin(t), lift(r)) for t in np.linspace(0, 2 * math.pi, NS, endpoint=False)] for r in np.linspace(0, 1, NR + 1)[1:]]
        wall = [place(R * math.cos(t), R * math.sin(t), -0.003) for t in np.linspace(0, 2 * math.pi, NS, endpoint=False)]
        for i in range(NS):
            j = (i + 1) % NS
            bm.faces.new((cen, rings[0][i], rings[0][j]))
            for ra, rb in zip(rings, rings[1:]):
                bm.faces.new((ra[i], rb[i], rb[j], ra[j]))
            bm.faces.new((rings[-1][i], wall[i], wall[j], rings[-1][j]))
        print('cheek conform: R', round(R, 4), 'center', np.round(c, 3))
    bm.normal_update()
    for fc in bm.faces:
        if fc.normal.y > 0 and fc.calc_center_median().x * 0 == 0:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    for p_ in me.polygons:
        p_.use_smooth = True


BUILD = {'Eye': build_eye, 'Scale': build_scale, 'Bear': build_teddy3, 'Monkey': build_monkey3}
made = []
for key, fn in BUILD.items():
    if ONLY and key not in ONLY:
        continue
    man = os.path.join(HERE, 'manual', key + '.blend')
    if os.path.exists(man):
        # 手動修整版優先：直接用 manual/<名稱>.blend 裡的 <名稱>_ 物件，不重新產生（使用者在 Blender 裡修過）
        with bpy.data.libraries.load(man, link=False) as (src, dst):
            dst.objects = [n for n in src.objects if n.startswith(key + '_')]
        parts = []
        for o in dst.objects:
            if o.type != 'MESH':
                continue
            scene.collection.objects.link(o)
            o.parent = None
            o.data.materials.clear()
            o['nocap'] = 1
            parts.append(o)
        for o in list(bpy.data.objects):                               # 手動檔帶進來的父物件（Fig_xxx）刪掉，名稱才不會變成 Fig_xxx.001
            if o.name.startswith('Fig_' + key) and o not in parts:
                bpy.data.objects.remove(o, do_unlink=True)
        print('manual', key, [o.name for o in parts])
        if key == 'Monkey':
            restitch_normals([o for o in parts if o.name.split('_', 1)[1].split('.')[0] in ('Skin', 'Eyes', 'Cloth', 'Cream')])
        if key == 'Bear':
            conform_cheeks([o for o in parts if o.name.startswith('Bear_Skin')][0], [o for o in parts if o.name.startswith('Bear_Cheeks')][0])
    else:
        parts = fn()
    root = bpy.data.objects.new('Fig_' + key, None)
    scene.collection.objects.link(root)
    for p in parts:
        p.parent = root
    made.append((key, root, parts))

# ---------------- 匯出 ----------------
# 每個部件最多約 9000 面（距離場長出來的部件很密，減到這樣曲面仍然平順）：四隻放在一起的檔案才不會太大
for o in [o for o in scene.objects if o.type == 'MESH']:
    nf = len(o.data.polygons)
    if nf > 9000 and not o.get('nocap'):                          # nocap：已經自己減好面的（泰迪熊）
        md = o.modifiers.new('cap', 'DECIMATE')
        md.ratio = 9000 / nf
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier='cap')
for o in scene.objects:
    o.select_set(True)
print('faces', {o.name: len(o.data.polygons) for o in scene.objects if o.type == 'MESH'})
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'gashapon.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(HERE, OUTNAME + '.glb'), export_format='GLB', use_selection=True,
                          export_apply=True, export_materials='NONE', export_normals=True, export_texcoords=True)
print('glb', os.path.getsize(os.path.join(HERE, OUTNAME + '.glb')))
if OUTNAME == 'gashapon':                                          # 網站先載入的縮小版貼圖（xxx_s.jpg），完整貼圖下載完之前用
    import subprocess
    for f_ in ('bear_tex', 'bear_nrm', 'monkey_tex', 'monkey_nrm'):
        src_ = os.path.join(HERE, f_ + '.jpg')
        if os.path.exists(src_):
            subprocess.run(['sips', '-Z', '256', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', src_, '--out', os.path.join(HERE, f_ + '_s.jpg')], capture_output=True)
    print('small textures done')

# ---------------- 預覽（workbench，只看造型） ----------------
COL = {'Body': (0.95, 0.92, 0.85), 'Iris': (0.12, 0.37, 0.88), 'Pupil': (0.08, 0.14, 0.31), 'Shine': (1, 1, 1), 'Smile': (0.08, 0.14, 0.31),
       'Limbs': (0.24, 0.37, 0.66), 'Lens': (0.8, 0.92, 1.0), 'Rim': (0.45, 0.75, 1.0),
       'Scale_Body': (0.96, 0.7, 0.76), 'Scale_Frame': (0.96, 0.7, 0.76), 'Scale_Panel': (0.98, 0.94, 0.9), 'Scale_Dial': (0.55, 0.83, 0.92), 'Scale_Ticks': (0.08, 0.08, 0.1),
       'Scale_Needle': (0.88, 0.1, 0.1), 'Scale_Cap': (0.62, 0.8, 0.94), 'Scale_Eyes': (0.1, 0.16, 0.33), 'Scale_Cheeks': (0.97, 0.66, 0.72),
       'Scale_Mouth': (0.86, 0.22, 0.3), 'Scale_Tongue': (0.98, 0.55, 0.6), 'Scale_Tape': (0.98, 0.8, 0.1), 'Scale_Limbs': (0.24, 0.36, 0.62),
       'Scale_Metal': (0.78, 0.79, 0.82),
       'Bear_Body': (0.93, 0.74, 0.5), 'Bear_Head': (0.93, 0.74, 0.5), 'Bear_Muzzle': (0.99, 0.94, 0.86), 'Bear_Mouth': (0.85, 0.08, 0.12),
       'Bear_Nose': (0.06, 0.06, 0.06), 'Bear_Eyes': (0.05, 0.05, 0.05), 'Bear_Cheeks': (0.96, 0.6, 0.66), 'Bear_EarIn': (0.97, 0.85, 0.66),
       'Monkey_Head': (0.8, 0.5, 0.25), 'Monkey_Body': (0.8, 0.5, 0.25), 'Monkey_Tail': (0.8, 0.5, 0.25), 'Monkey_Cream': (0.98, 0.86, 0.68),
       'Monkey_Face': (0.98, 0.86, 0.68), 'Monkey_Belly': (0.98, 0.86, 0.68), 'Monkey_EarIn': (0.98, 0.86, 0.68), 'Monkey_EarPink': (0.97, 0.6, 0.5),
       'Monkey_Eyes': (0.06, 0.06, 0.08), 'Monkey_Cheeks': (0.97, 0.62, 0.62), 'Monkey_Nose': (0.45, 0.22, 0.15), 'Monkey_Mouth': (0.6, 0.12, 0.15),
       'Monkey_Tongue': (0.95, 0.5, 0.5), 'Monkey_Band': (0.97, 0.97, 0.97), 'Monkey_Orn': (0.98, 0.65, 0.15), 'Monkey_Cape': (0.25, 0.5, 0.9),
       'Bear_Wand': (0.75, 0.52, 0.3), 'Bear_Star': (1.0, 0.8, 0.1), 'Bear_Sparks': (1.0, 0.8, 0.1), 'Bear_Seams': (0.55, 0.36, 0.18), 'Bear_Tail': (0.93, 0.74, 0.5), 'Bear_WandTube': (0.75, 0.52, 0.3), 'Bear_Ears': (0.93, 0.74, 0.5), 'Bear_Pads': (0.91, 0.72, 0.68), 'Monkey_Bow': (0.98, 0.98, 0.98), 'Monkey_Tail2': (0.79, 0.54, 0.31), 'Monkey_Face': (0.97, 0.87, 0.72), 'Monkey_Body': (0.79, 0.54, 0.31)}
for o in scene.objects:
    if o.type == 'MESH':
        m = bpy.data.materials.new(o.name)
        m.diffuse_color = (*COL.get(o.name, COL.get(o.name.split('_')[-1], (1, 1, 1))), {'Lens': 0.12, 'Rim': 0.5}.get(o.name.split('_')[-1], 1))
        o.data.materials.append(m)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.show_specular_highlight = True
scene.display.shading.show_xray = False
scene.render.film_transparent = False
scene.render.resolution_x, scene.render.resolution_y = 1086, 1448
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.lens = 85
for key, root, parts in made:
    for k2, r2, p2 in made:                  # 只顯示這一隻（四隻都放在原點，預覽時要把其他的藏起來）
        for o in p2:
            o.hide_render = (k2 != key)
    # 「ref」：正交鏡頭，對齊參考圖（身體中心、半徑在圖上的像素位置），可以直接疊圖比對
    REFCAM = {'Eye': (465, 680, 300, 0.78, 1.72 * 0.78)}   # 圖上中心 x, y、半徑 px、R、球心高度
    if key in REFCAM:
        px, py, rpx, R_, cz = REFCAM[key]
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = 1448 / rpx * R_
        cam.location = Vector(((543 - px) / rpx * R_, -20, cz + (py - 724) / rpx * R_))
        cam.rotation_euler = (math.pi / 2, 0, 0)
        scene.render.filepath = os.path.join(HERE, 'preview_%s_ref.png' % key)
        bpy.ops.render.render(write_still=True)
    # 三視圖對齊（正交鏡頭，身體中心與比例和設計圖上一致）：輸出和設計圖同尺寸的圖，可以直接並排／疊圖比對
    REF3 = {'Monkey': (1311, 1200, [('front', (0, 1, 0), 650, 1095, 200)], MK_U, 0.0),
            'Bear': (1774, 887, [('front', (0, 1, 0), 356, 690, 150), ('side', (-1, 0, 0), 882, 690, 150), ('back', (0, -1, 0), 1424, 690, 150)], BR_U, 0.0),
            'Scale': (1774, 887, [('front', (0, 1, 0), 381, 351, 206), ('side', (-1, 0, 0), 893, 355, 214), ('back', (0, -1, 0), 1414, 356, 206)], SC_U, SC_ZC * SC_U)}
    if key in REF3:
        W_, H_, vs, U_, cz = REF3[key]
        scene.render.resolution_x, scene.render.resolution_y = W_, H_
        cam.data.type = 'ORTHO'
        for nm_, dirv, px, py, rpx in vs:
            cam.data.ortho_scale = W_ / rpx * U_
            dv = Vector(dirv)
            right = dv.cross(Vector((0, 0, 1)))
            off = (W_ / 2 - px) / rpx * U_            # 身體中心在圖上的水平位置
            cam.location = -dv * 20 + right * off + Vector((0, 0, cz + (py - H_ / 2) / rpx * U_))
            cam.rotation_euler = dv.to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = os.path.join(HERE, 'ref3_%s_%s.png' % (key, nm_))
            bpy.ops.render.render(write_still=True)
        scene.render.resolution_x, scene.render.resolution_y = 1086, 1448
    cam.data.type = 'PERSP'
    cam.data.lens = 120
    VIEWS = {'Bear': [('face', (0.6, -4.2, 3.0), (0.05, -0.4, 1.36), 120), ('star', (0.9, -3.6, 2.2), (0.64, -0.07, 1.6), 140), ('sideH', (4.5, 0.0, 1.5), (0.0, 0.0, 1.35), 110)],
             'Scale': [('dial', (0.25, -3.6, 2.0), (0.03, -0.3, 1.72), 170), ('face', (0.2, -3.6, 1.4), (0.0, -0.33, 1.25), 150),
                       ('fork', (-1.6, -3.2, 1.6), (-0.9, -0.08, 1.3), 110), ('knife', (1.6, -3.2, 1.55), (0.95, -0.08, 1.3), 110), ('armS', (3.4, -0.6, 1.4), (0.9, -0.05, 1.3), 110),
                       ('feet', (0.8, -3.0, 0.2), (0.0, -0.05, 0.12), 170)],
             'Eye': [('handL', (-0.6, -4.2, 2.0), (0.31, -1.32, 1.6), 170), ('handLs', (2.0, -3.9, 1.8), (0.31, -1.32, 1.6), 170),
                     ('handR', (1.7, -3.6, 2.6), (0.99, -0.64, 2.1), 170), ('handRs', (4.0, 0.2, 2.6), (0.99, -0.64, 2.1), 170),
                     ('threeL', (-9, -13, 2.6), (0.3, 0, 1.3), 120)]}
    for name, pos, aim, lens in VIEWS.get(key, []):
        cam.data.lens = lens
        cam.location = Vector(pos)
        cam.rotation_euler = (Vector(aim) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(HERE, 'preview_%s_%s.png' % (key, name))
        bpy.ops.render.render(write_still=True)
    # 繞一整圈：8 個方位（每 45°，微微俯視）＋正上方＋正下方，全部都要看過
    cam.data.type = 'PERSP'
    cam.data.lens = 120
    for k in range(8):
        ang = math.radians(k * 45)
        cam.location = Vector((math.sin(ang) * 15, -math.cos(ang) * 15, 3.4))
        cam.rotation_euler = (Vector((0.3, 0, 1.1)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(HERE, 'turn_%s_%d.png' % (key, k))
        bpy.ops.render.render(write_still=True)
    for nm_, pos in (('up', (0.3, -0.01, 16)), ('down', (0.3, -0.01, -14))):
        cam.location = Vector(pos)
        cam.rotation_euler = (Vector((0.3, 0, 1.1)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(HERE, 'turn_%s_%s.png' % (key, nm_))
        bpy.ops.render.render(write_still=True)
    cam.data.lens = 120
    for name, pos, aim in (('top', (0.4, -0.3, 16), (0.4, -0.2, 1.2)), ('three', (8, -14, 2.2), (0.22, 0, 1.22)), ('side', (16, 0.0, 1.45), (0.0, 0, 1.45)), ('back', (0.0, 16, 1.45), (0.0, 0, 1.45))):
        cam.location = Vector(pos)
        d = Vector(aim) - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(HERE, 'preview_%s_%s.png' % (key, name))
        bpy.ops.render.render(write_still=True)

# ---------------- 低解析度版（房間一開始就先放這個，近看時再換成上面那份） ----------------
# 每個部位減面到原本的一小部分（至少留 300 面），形狀和顏色區塊都還在，檔案只有幾十 KB。
for o in [o for o in scene.objects if o.type == 'MESH']:
    nf = len(o.data.polygons)
    if nf <= 240:
        continue
    md = o.modifiers.new('lo', 'DECIMATE')
    md.ratio = max(160 / nf, 0.08 if o.get('nocap') else 0.05)   # 泰迪熊的零件本來就減過面了：留多一點，五官遠看才不會變形
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier='lo')
for o in scene.objects:
    o.select_set(o.type in ('MESH', 'EMPTY'))
print('lo faces', sum(len(o.data.polygons) for o in scene.objects if o.type == 'MESH'))
bpy.ops.export_scene.gltf(filepath=os.path.join(HERE, OUTNAME + '-lo.glb'), export_format='GLB', use_selection=True,
                          export_apply=True, export_materials='NONE', export_normals=True, export_texcoords=True)
print('lo glb', os.path.getsize(os.path.join(HERE, OUTNAME + '-lo.glb')))
