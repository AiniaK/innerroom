# 泰迪熊 v2：使用者提供的 Tripo 模型（Model-Teddy-v2/*.fbx，兩手垂下、沒有魔杖）→ 對齊舊模型的座標框、舉起左手（畫面右側）、
# 回傳整隻熊的網格（之後交給 teddy.py 的流程上色）以及魔杖的位置
import bpy, bmesh, math, os, glob
import numpy as np
from mathutils import Vector
import teddy as T

DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'design-source', 'gashapon', 'Model-Teddy-v2')
SHOULDER = np.array([0.27, 0.0, -0.10])     # 肩膀（轉動的中心，量的：scratchpad/v2/rel_F.png）
PAW = np.array([0.52, 0.0, -0.46])          # 垂下的手掌
RAISE = 100.0                                # 往上轉幾度（正面看逆時針）


def load():
    fbx = glob.glob(os.path.join(DIR, '*.fbx'))[0]
    bpy.ops.import_scene.fbx(filepath=fbx)
    ob = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]
    for o in list(bpy.context.selected_objects):
        if o is not ob:
            bpy.data.objects.remove(o)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.parent = None
    me = ob.data
    me.materials.clear()
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    # 合併重複的頂點（FBX 常在 UV 接縫處拆開）
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me); bm.free()
    V, E = T._arrays(me)
    V = V * 1.7; V[:, 2] -= 0.951                                   # 高 1.7、腳底 z=−0.951（和舊模型同一個框）
    n = len(V)
    me.vertices.foreach_set('co', V.ravel()); me.update()
    N = T._normals(me, V)
    # 原本垂下的手臂：離手臂中心線 0.13 以內、肩膀以外的點刪掉，切口補起來
    ax = (PAW - SHOULDER); ax[1] = 0; L = np.linalg.norm(ax); ax /= L
    yc = np.median(V[(np.abs(V[:, 0] - PAW[0]) < 0.05) & (np.abs(V[:, 2] - PAW[2]) < 0.05), 1])
    sh = SHOULDER.copy(); sh[1] = yc
    t = (V - sh) @ ax
    dax = np.linalg.norm((V - sh) - np.outer(np.clip(t, 0, L + 0.25), ax), axis=1)
    arm = (t > 0.02) & (dax < 0.16)
    # 不刪不補（補洞的大多邊形會摺成薄片）：原本手臂上的點，沿身體的橢圓截面壓回身體側面
    hips = V[(V[:, 2] > -0.66) & (V[:, 2] < -0.58)]
    k = ((hips[:, 0].max() - hips[:, 0].min()) / 2) / ((hips[:, 1].max() - hips[:, 1].min()) / 2)
    for i in np.nonzero(arm)[0]:
        z = min(V[i, 2], sh[2])
        sl = V[(np.abs(V[:, 2] - z) < 0.012) & (np.abs(V[:, 0]) < 0.12)]
        if len(sl) < 4:
            continue
        cy = (sl[:, 1].max() + sl[:, 1].min()) / 2; b = (sl[:, 1].max() - sl[:, 1].min()) / 2; a = b * k
        thh = np.arctan2((V[i, 1] - cy) / b, max(V[i, 0], 0.05) / a)
        V[i] = (a * np.cos(thh) * 0.98, cy + b * np.sin(thh) * 0.98, z)
    me.vertices.foreach_set('co', V.ravel()); me.update()
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    # 舉起的新手臂（照原本手臂的形狀：圓柱、略收細、圓滾滾的手掌），從肩膀往右上
    ang = np.radians(RAISE)
    rot = lambda p: np.array([sh[0] + (p[0] - sh[0]) * np.cos(ang) - (p[2] - sh[2]) * np.sin(ang), p[1], sh[2] + (p[0] - sh[0]) * np.sin(ang) + (p[2] - sh[2]) * np.cos(ang)])
    a0 = np.array([0.31, yc, -0.15])                                 # 肩膀：身體右上緣
    pc = np.array([0.585, yc, 0.105])                                # 手掌在臉頰旁（設計圖：手臂往右上約 45°）
    dirv = (pc - a0) / np.linalg.norm(pc - a0)
    up_ = np.cross(dirv, [0, 1, 0]); up_ /= np.linalg.norm(up_); fw_ = np.cross(up_, dirv)
    NR, NS = 40, 48
    rings = []
    for i in range(NR + 1):
        u = i / NR
        r = 0.112 - 0.012 * u + 0.008 * np.sin(np.pi * u)                    # 肩膀粗、往手腕略收
        c = a0 + (pc - a0) * u
        rings.append([bm.verts.new(Vector(c + (up_ * np.cos(q) + fw_ * np.sin(q)) * r)) for q in np.linspace(0, 2 * np.pi, NS, endpoint=False)])
    for ra, rb in zip(rings, rings[1:]):
        for k in range(NS):
            bm.faces.new((ra[k], ra[(k + 1) % NS], rb[(k + 1) % NS], rb[k]))
    for ring, c in ((rings[0], a0), (rings[-1], pc)):
        bm.faces.new(ring)
    shs = bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=24, radius=0.13)           # 肩膀：圓球，讓接點圓滑
    for v_ in shs['verts']:
        v_.co = Vector(a0 + dirv * 0.03 + np.array([-0.03, 0, 0])) + v_.co
    sph = bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=28, radius=0.122)          # 手掌（圓滾滾的）
    for v_ in sph['verts']:
        v_.co = Vector(pc + dirv * 0.03) + Vector((v_.co.x * 1.0, v_.co.y * 0.95, v_.co.z * 1.05))
    bm.to_mesh(me); bm.free()
    print('teddy_v2: removed arm verts', int(arm.sum()), 'paw', np.round(pc + dirv * 0.03, 3))
    load.cut = (sh, ax, L, a0, pc)
    return ob, pc + dirv * 0.03


def round_side(V, E=None, ob=None):
    """重新網格化之後：原本手臂切口那一帶，沿身體的橢圓截面推回圓弧（寬深比用手掌以下、沒有手臂黏著的屁股量）"""
    sh, ax, L, a0, pc = load.cut
    t = (V - sh) @ ax
    dax = np.linalg.norm((V - sh) - np.outer(np.clip(t, 0, L + 0.25), ax), axis=1)
    dv = (pc - a0) / np.linalg.norm(pc - a0)
    tn = (V - a0) @ dv
    dnew = np.linalg.norm((V - a0) - np.outer(np.clip(tn, 0, np.linalg.norm(pc - a0)), dv), axis=1)
    hips = V[(V[:, 2] > -0.66) & (V[:, 2] < -0.58)]
    a_h = (hips[:, 0].max() - hips[:, 0].min()) / 2; b_h = (hips[:, 1].max() - hips[:, 1].min()) / 2
    k = a_h / b_h
    out = V.copy()
    zone = (t > -0.02) & (dax < 0.2) & (dnew > 0.15) & (V[:, 0] > 0.15)
    for i in np.nonzero(zone)[0]:
        z = V[i, 2]
        sl = V[(np.abs(V[:, 2] - z) < 0.01) & (np.abs(V[:, 0]) < 0.12)]
        if len(sl) < 4:
            continue
        cy = (sl[:, 1].max() + sl[:, 1].min()) / 2; b = (sl[:, 1].max() - sl[:, 1].min()) / 2; a = b * k
        x, y = V[i, 0], V[i, 1] - cy
        th = np.arctan2(y / b, x / a)
        tgt = np.array([a * np.cos(th), cy + b * np.sin(th), z])
        wgt = np.clip((0.2 - dax[i]) / 0.06, 0, 1) * np.clip((dnew[i] - 0.15) / 0.04, 0, 1)
        out[i] = V[i] + (tgt - V[i]) * wgt
    if ob is not None:                                             # 再投影到整隻熊柔化後的圓滑外形上（自然接上周圍的弧度）
        from mathutils.bvhtree import BVHTree
        ob.data.vertices.foreach_set('co', out.ravel()); ob.data.update()
        bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
        lo = out.min(0) - 0.1; hg = 0.008
        shape = tuple(int(x) for x in np.ceil((out.max(0) + 0.1 - lo) / hg))
        G = T._occupancy(bvh, lo, hg, shape)
        for a_ in range(3):
            G = T._blur1(G, 0.045, hg, a_)
        P = T._project_iso(out, G, lo, hg)
        zw = zone.astype(float)
        if E is not None:
            for _ in range(10):
                zw = 0.5 * zw + 0.5 * T._avg(zw[:, None], E, len(V))[:, 0]
        out = out + np.clip(zw * 1.6, 0, 1)[:, None] * (P - out)
    if E is not None:                                              # 推圓之後那一帶再磨順（切口的毛邊）
        zw = T._grow(zone, E, len(V), 4).astype(float)
        for _ in range(6):
            zw = 0.5 * zw + 0.5 * T._avg(zw[:, None], E, len(V))[:, 0]
        out = T._taubin(out, E, 150, np.clip(zw * 1.5, 0, 1), 0.5, -0.53)
    print('teddy_v2: rounded side verts', int(zone.sum()), 'k', round(float(k), 3))
    return out

    paw = V[arm & (w > 0.9)]
    pc = paw[np.argsort(((paw - paw.mean(0)) ** 2).sum(1))].mean(0)
    tip = paw[np.argmax(paw @ np.array([ax[0] * np.cos(np.radians(RAISE)) - ax[2] * np.sin(np.radians(RAISE)), 0, ax[0] * np.sin(np.radians(RAISE)) + ax[2] * np.cos(np.radians(RAISE))]))]
    print('teddy_v2: arm verts', int(arm.sum()), 'paw tip', tip.round(3))
    return ob, tip
