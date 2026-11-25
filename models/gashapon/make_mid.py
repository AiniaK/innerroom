# 手機用的「中等精細」扭蛋公仔：讀 gashapon.glb（已量化），每個部位減面到約四分之一，寫成 gashapon-mid.glb（未量化，之後再跑 tools/quantize-glb.mjs）
# 用法：/Applications/Blender.app/Contents/MacOS/Blender -b -P models/gashapon/make_mid.py
import bpy, bmesh, json, struct, os
HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT, RATIO, MINF = os.path.join(HERE, 'gashapon.glb'), os.path.join(HERE, 'gashapon-mid.glb'), 0.26, 500

b = open(SRC, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]; J = json.loads(b[20:20 + jl]); off = 20 + jl
bl = struct.unpack('<I', b[off:off + 4])[0]; BIN = b[off + 8:off + 8 + bl]
SIZE = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}; FMT = {5126: 'f', 5123: 'H', 5125: 'I', 5122: 'h', 5121: 'B'}
def acc(i):
    a = J['accessors'][i]; bv = J['bufferViews'][a['bufferView']]; n = SIZE[a['type']]; f = FMT[a['componentType']]
    st = bv.get('byteOffset', 0) + a.get('byteOffset', 0); cnt = a['count'] * n
    raw = struct.unpack('<%d%s' % (cnt, f), BIN[st:st + cnt * struct.calcsize(f)])
    q = (a.get('extras') or {}).get('q')
    if q: raw = [q['o'][k % n] + q['s'][k % n] * raw[k] / 32767 for k in range(cnt)]
    elif a.get('normalized') and f == 'h': raw = [max(-1, v / 32767) for v in raw]
    return [tuple(raw[k:k + n]) for k in range(0, cnt, n)]

bpy.ops.wm.read_factory_settings(use_empty=True)
newmeshes = []
for mi, m in enumerate(J['meshes']):
    prims = []
    for p in m['primitives']:
        P = acc(p['attributes']['POSITION']); UV = acc(p['attributes']['TEXCOORD_0']) if 'TEXCOORD_0' in p['attributes'] else None
        I = [v[0] for v in acc(p['indices'])]; F = [tuple(I[k:k + 3]) for k in range(0, len(I), 3)]
        me = bpy.data.meshes.new('m'); me.from_pydata(P, [], F); me.update()
        if UV:
            ul = me.uv_layers.new(name='uv')
            for li, lp in enumerate(me.loops): ul.data[li].uv = UV[lp.vertex_index]
        ob = bpy.data.objects.new('o', me); bpy.context.scene.collection.objects.link(ob)
        nf = len(me.polygons)
        if nf > MINF:
            md = ob.modifiers.new('d', 'DECIMATE'); md.ratio = max(RATIO, MINF / nf); md.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = ob; bpy.ops.object.modifier_apply(modifier='d')
        me = ob.data; bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(me); bm.free(); me.update()
        # 每個角落：位置、平滑法線（用頂點法線，接縫處不會有折痕）、UV；相同的合併成一個頂點
        key2i, pos, nrm, uvs, idx = {}, [], [], [], []
        ul = me.uv_layers[0].data if UV else None
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index; uv = tuple(round(c, 6) for c in ul[li].uv) if ul else ()
                k = (vi, uv)
                if k not in key2i:
                    key2i[k] = len(pos); v = me.vertices[vi]; pos.append(tuple(v.co)); nrm.append(tuple(v.normal)); uvs.append(uv)
                idx.append(key2i[k])
        prims.append((pos, nrm, uvs if UV else None, idx))
    newmeshes.append(prims)

# 寫出 GLB：節點、場景照原檔，網格換成減面後的
bin_ = bytearray(); views = []; accs = []
def add(data, fmt, comp, typ, target, mm=False):
    global bin_
    while len(bin_) % 4: bin_ += b'\0'
    flat = [c for t in data for c in (t if isinstance(t, tuple) else (t,))]
    raw = struct.pack('<%d%s' % (len(flat), fmt), *flat)
    views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(raw), 'target': target}); bin_ += raw
    a = {'bufferView': len(views) - 1, 'componentType': comp, 'count': len(data), 'type': typ}
    if mm: n = len(data[0]); a['min'] = [min(t[k] for t in data) for k in range(n)]; a['max'] = [max(t[k] for t in data) for k in range(n)]
    accs.append(a); return len(accs) - 1
meshes = []
for mi, prims in enumerate(newmeshes):
    ps = []
    for pos, nrm, uvs, idx in prims:
        at = {'POSITION': add(pos, 'f', 5126, 'VEC3', 34962, True), 'NORMAL': add(nrm, 'f', 5126, 'VEC3', 34962)}
        if uvs: at['TEXCOORD_0'] = add([(u, v) for u, v in uvs], 'f', 5126, 'VEC2', 34962)
        big = len(pos) > 65535
        ps.append({'attributes': at, 'indices': add(idx, 'I' if big else 'H', 5125 if big else 5123, 'SCALAR', 34963)})
    meshes.append({'name': J['meshes'][mi].get('name', ''), 'primitives': ps})
out = {'asset': {'version': '2.0', 'generator': 'make_mid.py'}, 'scene': J.get('scene', 0), 'scenes': J['scenes'], 'nodes': J['nodes'], 'meshes': meshes,
       'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}
js = json.dumps(out, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
while len(bin_) % 4: bin_ += b'\0'
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_)
open(OUT, 'wb').write(glb)
print('MID tris', sum(len(p[3]) // 3 for prims in newmeshes for p in prims), 'bytes', len(glb))
