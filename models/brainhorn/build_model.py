# 腦角獸：腦神經外科的吉祥物，房間裡的小布偶。
# 用法：/Applications/Blender.app/Contents/MacOS/Blender -b -P build_model.py
# 產生 brainhorn.glb、brainhorn.blend、preview_*.png（輸出到這支腳本所在的資料夾）。
#
# 造型（參考使用者的設定圖）：白色蛋形的身體、四隻短短的腳、背後下方一條尖尖的小尾巴；
# 額頭上一顆粉紅色的腦（左右兩半、各有幾個圓圓的腦葉）；頭頂兩側是淡紫色、像神經元樹突的角，枝端是小圓球；
# 深藍色直立的橢圓眼睛、淡紫色的小微笑；身體兩側各兩個淡紫色圓點；背上沿著脊椎一排淡紫色的四角星（十字紋），往尾巴越來越小。
#
# 單位：1 = 身體高度約 1。Blender 裡 +Z 朝上、臉朝 -Y（匯出成 glTF 後臉朝 +Z、上 +Y）。
# 每個部位是一個 mesh：Body、Brain、Horns、Eyes、Mouth、Spots、Stars，材質由房間那邊設定。
import bpy, bmesh, math, os
from mathutils import Vector, Quaternion, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def meta_object(name, resolution=0.02, threshold=0.6):
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = threshold
    ob = bpy.data.objects.new(name, mb)
    scene.collection.objects.link(ob)
    return ob, mb


def ball(mb, co, r, stiff=2.0, kind='BALL', size=None, rot=None):
    e = mb.elements.new(type=kind)
    e.co = co
    e.radius = r
    e.stiffness = stiff
    if size:
        e.size_x, e.size_y, e.size_z = size
    if rot is not None:
        e.rotation = rot
    return e


def to_mesh(ob, name):
    """metaball → 一般 mesh（metaball 不能直接匯出）"""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    new = bpy.data.objects.new(name, me)
    scene.collection.objects.link(new)
    bpy.data.objects.remove(ob)
    return new


def shade_smooth(ob):
    for p in ob.data.polygons:
        p.use_smooth = True


# ---------------- 身體 ----------------
# 從一顆細分很密的球開始，沿每個方向用一個平滑的半徑函數把它推成形：
# 圓胖的蛋形（下半更寬、前後有厚度），四隻腳和尾巴都是表面平滑隆起長出來的，所以從頭頂、背、到尾巴尖是一條連續的線，像一團軟軟的奶油。
CEN = Vector((0, 0.06, 0.47))
LEGS = [Vector(v).normalized() for v in ((-0.5, -0.42, -0.78), (0.5, -0.42, -0.78), (-0.46, 0.4, -0.8), (0.46, 0.4, -0.8))]
TAIL = Vector((0.0, 0.78, -0.6)).normalized()   # 正後方：尾巴是脊椎的延伸


def body_radius(d):
    top = d.z > 0
    a = 0.5 * (1 + 0.1 * max(0.0, -d.z))      # 下半更寬
    b = 0.48 * (1 + 0.08 * max(0.0, -d.z))
    c = 0.56 if top else 0.46                 # 頭頂圓高，肚子較短
    r = 1 / math.sqrt((d.x / a) ** 2 + (d.y / b) ** 2 + (d.z / c) ** 2)
    for L in LEGS:                            # 腳：表面往下外方鼓出的短短圓柱
        r += 0.15 * math.exp(-(1 - d.dot(L)) / 0.024)
    ang = math.sqrt(max(0.0, 2 * (1 - d.dot(TAIL))))
    r += 0.27 * math.exp(-(ang / 0.26) ** 1.5)   # 尾巴：從背的弧線順下來，收成一個圓圓的小尖（指數大於 1，尖端是圓的）
    return r


bmx = bmesh.new()
bmesh.ops.create_uvsphere(bmx, u_segments=112, v_segments=84, radius=1.0)
for v in bmx.verts:
    d = v.co.normalized()
    p = CEN + d * body_radius(d)
    v.co = p
me = bpy.data.meshes.new('Body')
bmx.to_mesh(me)
bmx.free()
body = bpy.data.objects.new('Body', me)
scene.collection.objects.link(body)
# 量出高度，縮放成身體高度剛好 1（腳底在 0）
zs = [v.co.z for v in body.data.vertices]
z0, z1 = min(zs), max(zs)
k = 1.0 / (z1 - z0)
for v in body.data.vertices:
    v.co = Vector((v.co.x * k, v.co.y * k, (v.co.z - z0) * k))
print('body raw height', z1 - z0, 'scale', k)
# 腳底切平一點：把低於 0.02 的頂點壓到 0.02
for v in body.data.vertices:
    if v.co.z < 0.02:
        v.co.z = 0.02
shade_smooth(body)
bpy.context.view_layer.update()
inv = body.matrix_world.inverted()


def hit(origin, direction):
    """從 origin 往 direction 打到身體表面：回傳 (位置, 法線)"""
    ok, loc, nor, _ = body.ray_cast(inv @ Vector(origin), Vector(direction).normalized())
    if not ok:
        raise RuntimeError('ray missed the body at %s' % (origin,))
    return Vector(loc), Vector(nor).normalized()


def front(x, z):
    return hit((x, -3, z), (0, 1, 0))


def side(sign, y, z):
    return hit((sign * 3, y, z), (-sign, 0, 0))


def back(x, z):
    return hit((x, 3, z), (0, -1, 0))


def top(x, y):
    return hit((x, y, 3), (0, 0, -1))


def frame(nor, up=Vector((0, 0, 1))):
    """以法線為 z 軸的旋轉（讓貼片貼著表面）"""
    z = nor.normalized()
    xax = up.cross(z)
    if xax.length < 1e-4:
        xax = Vector((1, 0, 0))
    xax.normalize()
    y = z.cross(xax)
    return Matrix((xax, y, z)).transposed()


def join(objs, name):
    for o in scene.objects:   # only these: an earlier join may still be selected
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def patch_ellipse(name, loc, nor, rx, ry, thick, up=Vector((0, 0, 1)), seg=40):
    """貼在表面上、略微隆起的橢圓貼片（眼睛、圓點）"""
    me = bpy.data.meshes.new(name)
    bmx = bmesh.new()
    R = frame(nor, up)
    rings = 4
    verts = []
    centre = bmx.verts.new(loc + nor * thick)
    for k in range(1, rings + 1):
        t = k / rings
        ring = []
        for i in range(seg):
            a = i / seg * 2 * math.pi
            h = thick * math.sqrt(max(0.0, 1 - t * t)) - 0.004 * t   # 中間鼓起，邊緣收進表面
            p = loc + R @ Vector((math.cos(a) * rx * t, math.sin(a) * ry * t, 0)) + nor * h
            ring.append(bmx.verts.new(p))
        verts.append(ring)
    for i in range(seg):
        bmx.faces.new((centre, verts[0][i], verts[0][(i + 1) % seg]))
    for k in range(rings - 1):
        a_, b_ = verts[k], verts[k + 1]
        for i in range(seg):
            j = (i + 1) % seg
            bmx.faces.new((a_[i], b_[i], b_[j], a_[j]))
    bmx.to_mesh(me)
    bmx.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    shade_smooth(ob)
    return ob


def tube(name, pts, r, seg=12):
    """沿著一串點的細管（嘴巴）"""
    me = bpy.data.meshes.new(name)
    bmx = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        n = Vector((0, -1, 0))
        u = t.cross(n).normalized()
        w = t.cross(u).normalized()
        rr = r * (0.75 + 0.25 * math.sin(math.pi * i / (len(pts) - 1)))
        rings.append([bmx.verts.new(p + (u * math.cos(a) + w * math.sin(a)) * rr)
                      for a in [k / seg * 2 * math.pi for k in range(seg)]])
    for k in range(len(rings) - 1):
        for i in range(seg):
            j = (i + 1) % seg
            bmx.faces.new((rings[k][i], rings[k + 1][i], rings[k + 1][j], rings[k][j]))
    for ring, end in ((rings[0], pts[0]), (rings[-1], pts[-1])):
        c = bmx.verts.new(end)
        for i in range(seg):
            bmx.faces.new((c, ring[i], ring[(i + 1) % seg]))
    bmesh.ops.recalc_face_normals(bmx, faces=bmx.faces)
    bmx.to_mesh(me)
    bmx.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    shade_smooth(ob)
    return ob


def star(name, loc, nor, size, up=Vector((0, 0, 1)), rings=6, n=64):
    """四角星（十字紋）：四個圓潤的長臂；不凸起，是貼著身體曲面的一片花紋（每個點都投影回身體表面，只浮起一點點避免閃爍）"""
    me = bpy.data.meshes.new(name)
    bmx = bmesh.new()
    R = frame(nor, up)

    def on_body(local):
        o = loc + R @ local + nor * 0.08
        ok, hl, hn, _ = body.ray_cast(inv @ o, -nor)
        lift = 0.0015 + 0.0045 * max(0.0, 1 - (local.length / size) ** 2)   # 中間微微隆起，邊緣順著身體收
        return (Vector(hl) + Vector(hn).normalized() * lift) if ok else (loc + R @ local)

    def rad(a):   # 十字：四個方向是圓頭的長臂，臂與臂之間收細
        k = abs(math.cos(2 * a))
        return size * (0.4 + 0.6 * k ** 3)   # 四臂粗一點

    c = bmx.verts.new(on_body(Vector((0, 0, 0))))
    grid = []
    for kk in range(1, rings + 1):
        t = kk / rings
        grid.append([bmx.verts.new(on_body(Vector((math.cos(a) * rad(a) * t, math.sin(a) * rad(a) * t, 0))))
                     for a in [i / n * 2 * math.pi for i in range(n)]])
    for i in range(n):
        bmx.faces.new((c, grid[0][i], grid[0][(i + 1) % n]))
    for kk in range(rings - 1):
        for i in range(n):
            j = (i + 1) % n
            bmx.faces.new((grid[kk][i], grid[kk + 1][i], grid[kk + 1][j], grid[kk][j]))
    bmesh.ops.recalc_face_normals(bmx, faces=bmx.faces)
    bmx.to_mesh(me)
    bmx.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    shade_smooth(ob)
    return ob


# ---------------- 臉：眼睛、嘴巴 ----------------
eyes = []
for sx in (-1, 1):
    p, n = front(sx * 0.215, 0.6)
    eyes.append(patch_ellipse('Eye', p, n, 0.04, 0.06, 0.016))
Eyes = join(eyes, 'Eyes')

mouth_pts = []
for i in range(9):
    t = i / 8
    x = (t - 0.5) * 0.11
    z = 0.555 - 0.022 * math.sin(math.pi * t)
    p, n = front(x, z)
    mouth_pts.append(p + n * 0.006)
Mouth = tube('Mouth', mouth_pts, 0.009)

# ---------------- 額頭上的腦 ----------------
# 左右兩半各是一片貼著額頭的隆起：外框是四個圓圓的腦葉連起來的波浪邊，中間留一道溝
# 額頭上的腦（照使用者畫的腦花圖）：
#   底層深粉：兩個大圓連成的外形，上下中間各有一個凹口，整片微微高出額頭
#   上層淺粉：每半邊四個腦葉——上、下各一個圓角方塊（貼著中線），外側上、下各一個圓；比深粉再凸一點，不過分外凸
# 圖上的座標（像素）直接換算：腦的總寬 0.3（約身體寬的三分之一），中心在高度 0.82
PX = 0.3 / 588.0
BCX, BCY, BRAIN_Z = 393.0, 287.0, 0.82


def img2uv(x, y):   # 圖上的點 → (u 往右, v 往上)
    return (x - BCX) * PX, (BCY - y) * PX


BASE_CIRCLES = [(img2uv(330, 287), 240 * PX), (img2uv(456, 287), 232 * PX)]


def sd_base(u, v):
    return min(math.hypot(u - c[0], v - c[1]) - r for (c, r) in BASE_CIRCLES)


def sd_rrect(u, v, x0, x1, y0, y1, rad):
    cx_, cy_ = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - rad, (y1 - y0) / 2 - rad
    qx, qy = abs(u - cx_) - hx, abs(v - cy_) - hy
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - rad


def lobe_shapes():   # 左半邊（圖上 x < 393）的四個腦葉，右半邊鏡像
    out = []
    for x0, x1, y0, y1, rad in ((215, 383, 50, 330, 75), (220, 383, 240, 524, 75)):   # 上下兩塊在中段重疊，連成一片
        (u0, v1), (u1, v0) = img2uv(x0, y0), img2uv(x1, y1)
        out.append(('r', (u0, u1, v0, v1, rad * PX)))
    for cx_, cy_, r in ((190, 215, 74), (183, 362, 84)):   # 外側兩個圓往內和方塊多重疊一些
        out.append(('c', (img2uv(cx_, cy_), r * PX)))
    return out


LOBE = lobe_shapes()


def sd_lobes(u, v):
    u = -abs(u)   # 用左半邊的形狀，右半邊鏡像
    best = 9.0
    for kind, prm in LOBE:
        if kind == 'r':
            best = min(best, sd_rrect(u, v, *prm))
        else:
            (cu, cv), r = prm
            best = min(best, math.hypot(u - cu, v - cv) - r)
    return best


def smooth01(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


H_BASE, H_LOBE = 0.014, 0.011


def relief(name, sd, cu, cv, h_in, h_edge, soft, rings=26, seg=132):
    """以 (cu, cv) 為中心、外框是 sd=0 的一片隆起，貼在身體正面：中間高 h_in、邊緣圓圓地降到 h_edge"""
    def reach(th):
        lo, hi = 0.0, 0.3
        for _ in range(30):
            mid = (lo + hi) / 2
            if sd(cu + math.cos(th) * mid, cv + math.sin(th) * mid) < 0:
                lo = mid
            else:
                hi = mid
        return lo

    me = bpy.data.meshes.new(name)
    bmx = bmesh.new()
    grid = []
    for k in range(rings + 1):
        t = k / rings
        ring = []
        for i in range(seg if k else 1):
            th = i / seg * 2 * math.pi
            rr = reach(th) * t
            u, v = cu + math.cos(th) * rr, cv + math.sin(th) * rr
            p, n = front(u, BRAIN_Z + v)
            h = h_edge + (h_in - h_edge) * smooth01(-sd(u, v) / soft)
            ring.append(bmx.verts.new(p + n * h))
        grid.append(ring)
    c = grid[0][0]
    for i in range(seg):
        bmx.faces.new((c, grid[1][i], grid[1][(i + 1) % seg]))
    for k in range(1, rings):
        for i in range(seg):
            j = (i + 1) % seg
            bmx.faces.new((grid[k][i], grid[k + 1][i], grid[k + 1][j], grid[k][j]))
    bmesh.ops.recalc_face_normals(bmx, faces=bmx.faces)
    bmx.to_mesh(me)
    bmx.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    shade_smooth(ob)
    return ob


Brain = relief('Brain', sd_base, 0.0, 0.0, H_BASE, -0.004, 0.032)   # 從額頭緩緩隆起，邊緣順順地收進身體
lobe_halves = []
for sx in (-1, 1):
    cu = sx * (393 - 290) * PX
    lobe_halves.append(relief('LobeHalf', lambda u, v, sx=sx: sd_lobes(u, v) if u * sx > 0.0015 else 1.0, cu, 0.0, H_BASE + H_LOBE, H_BASE - 0.003, 0.008))
BrainLobes = join(lobe_halves, 'BrainLobes')
shade_smooth(BrainLobes)

# ---------------- 頭頂兩側的角（神經元樹突） ----------------
ho, hom = meta_object('HornMeta', 0.013, 0.6)


def capsule(a, b, r):
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    q = Vector((1, 0, 0)).rotation_difference(d.normalized())
    e = ball(hom, (a + b) / 2, r, 2.0, 'CAPSULE', rot=q)
    e.size_x = L / 2


def horn(sx):
    """像鹿角一樣：主幹從頭頂兩側往外上方長出，末端的分枝在空間中往四面八方散開（上、外、前、後、斜下），每枝再彎一下，末端一顆小圓球"""
    base, n = top(sx * 0.22, 0.04)
    base = base - n * 0.04
    axis = Vector((sx * 0.6, 0.0, 0.8)).normalized()
    trunk_end = base + axis * 0.085
    ball(hom, base, 0.08, 2.0)                      # 根部粗一點，像從頭上長出來
    capsule(base, trunk_end, 0.052)
    u = Vector((0, 1, 0)).cross(axis).normalized()   # 在主幹周圍展開的兩個方向
    v = axis.cross(u).normalized()
    # (繞主幹的角度, 偏離主幹的角度, 長度, 有沒有小分枝)
    BR = [(0.0, 0.85, 0.27, True), (1.25, 1.05, 0.24, False), (2.5, 1.2, 0.22, True), (3.75, 0.95, 0.26, False), (5.0, 1.3, 0.2, False)]   # 偏離主幹更多，往四面散開
    for th, ph, L, sub in BR:
        th = th if sx > 0 else math.pi - th            # 左右鏡像
        d = (axis * math.cos(ph) + (u * math.cos(th) + v * math.sin(th)) * math.sin(ph)).normalized()
        bend = (axis * 0.35 + d).normalized()           # 枝先往外、再往上彎
        mid = trunk_end + d * L * 0.5
        tip = mid + bend * L * 0.5
        capsule(trunk_end, mid, 0.034)
        capsule(mid, tip, 0.027)
        ball(hom, tip, 0.048, 2.0)
        if sub:
            d2 = (d + (u * math.cos(th + 1.6) + v * math.sin(th + 1.6)) * 0.9 + axis * 0.3).normalized()
            t2 = mid + d2 * L * 0.45
            capsule(mid, t2, 0.024)
            ball(hom, t2, 0.042, 2.0)


horn(-1)
horn(1)
Horns = to_mesh(ho, 'Horns')
shade_smooth(Horns)

# ---------------- 身體兩側的圓點 ----------------
spots = []
for sx in (-1, 1):
    for (y, z, r) in ((0.0, 0.42, 0.036), (0.09, 0.33, 0.03)):
        p, n = side(sx, y, z)
        spots.append(patch_ellipse('Spot', p, n, r, r, 0.01))
Spots = join(spots, 'Spots')

# ---------------- 背上的十字紋（沿脊椎往尾巴越來越小） ----------------
stars = []
N = 8
for i in range(N):
    t = i / (N - 1)
    z = 0.86 - t * 0.64          # 沿著脊椎一路往下，最後幾顆落在尾巴上
    p, n = back(0.0, z)
    stars.append(star('Star', p, n, 0.058 - t * 0.03))
Stars = join(stars, 'Stars')

# ---------------- 匯出 ----------------
for o in scene.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = body
tri = sum(len(o.data.polygons) for o in scene.objects if o.type == 'MESH')
print('faces', tri, {o.name: len(o.data.vertices) for o in scene.objects if o.type == 'MESH'})
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'brainhorn.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(HERE, 'brainhorn.glb'), export_format='GLB', use_selection=True,
                          export_apply=True, export_materials='NONE', export_normals=True, export_texcoords=False)
print('glb', os.path.getsize(os.path.join(HERE, 'brainhorn.glb')))

# ---------------- 預覽（workbench，只看造型） ----------------
COL = {'Body': (0.96, 0.95, 0.93), 'Brain': (0.89, 0.62, 0.69), 'BrainLobes': (0.95, 0.74, 0.78), 'Horns': (0.74, 0.68, 0.92), 'Eyes': (0.12, 0.15, 0.32),
       'Mouth': (0.74, 0.68, 0.92), 'Spots': (0.74, 0.68, 0.92), 'Stars': (0.74, 0.68, 0.92)}
for o in scene.objects:
    if o.type == 'MESH':
        m = bpy.data.materials.new(o.name)
        m.diffuse_color = (*COL.get(o.name, (1, 1, 1)), 1)
        o.data.materials.append(m)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.render.resolution_x = 640
scene.render.resolution_y = 640
world = bpy.data.worlds.new('w')
scene.world = world
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.lens = 60
target = Vector((0, 0, 0.62))
for nm, d, tg, dist in (('front', (0.25, -1, 0.15), target, 3.6), ('side', (1, 0, 0.12), target, 3.6), ('back', (-0.2, 1, 0.2), target, 3.6),
                       ('top', (0.1, -0.3, 1), target, 3.6), ('brain', (0, -1, 0.35), Vector((0, -0.3, 0.82)), 1.0)):
    d = Vector(d).normalized()
    target = tg
    cam.location = target + d * dist
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(HERE, 'preview_%s.png' % nm)
    bpy.ops.render.render(write_still=True)
print('done')
