// 作品的 GLB 網格壓縮（只量化、不減面）：座標與 UV 存成 16 位元整數（附還原用的偏移與縮放），法線存成 16 位元。
// 誤差：座標約為模型尺寸的 1/65000（作品約 0.01 毫米以下），肉眼看不出來；檔案約小一半。
// 用法：node tools/quantize-glb.mjs models/xxx/xxx.glb [更多檔案…]   （已量化過的檔案會跳過）
// 讀取端：models/*/room.js 的 parseGlb 會依 accessor.extras.q 還原成浮點數。
import { readFileSync, writeFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) { console.log('不是 GLB：', file); continue; }
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  if (json.asset?.extras?.quantized) { console.log('已量化，跳過：', file); continue; }
  const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const ARR = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5122: Int16Array, 5120: Int8Array };
  const read = (a) => {
    const bv = json.bufferViews[a.bufferView], n = SIZE[a.type], C = ARR[a.componentType], start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    if (bv.byteStride && bv.byteStride !== n * C.BYTES_PER_ELEMENT) throw new Error('不支援交錯的頂點資料');
    return new C(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * n * C.BYTES_PER_ELEMENT));
  };
  // 每個 accessor 的新內容
  const role = {};
  for (const m of json.meshes || []) for (const p of m.primitives) {
    if (p.attributes.POSITION !== undefined) role[p.attributes.POSITION] = 'q';
    if (p.attributes.TEXCOORD_0 !== undefined) role[p.attributes.TEXCOORD_0] = 'q';
    if (p.attributes.NORMAL !== undefined) role[p.attributes.NORMAL] = 'n';
  }
  const chunks = [], views = [];
  let pos = 0;
  const push = (u8) => { const pad = (4 - (pos % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); pos += pad; } chunks.push(u8); views.push({ buffer: 0, byteOffset: pos, byteLength: u8.length }); pos += u8.length; return views.length - 1; };
  json.accessors = json.accessors.map((a, i) => {
    const src = read(a), n = SIZE[a.type], out = { ...a };
    delete out.byteOffset;
    if (role[i] === 'q' && a.componentType === 5126) {
      const mn = [], mx = [];
      for (let k = 0; k < n; k++) { mn[k] = Infinity; mx[k] = -Infinity; }
      for (let j = 0; j < src.length; j++) { const k = j % n; mn[k] = Math.min(mn[k], src[j]); mx[k] = Math.max(mx[k], src[j]); }
      const o = mn.map((v, k) => (v + mx[k]) / 2), s = mn.map((v, k) => Math.max((mx[k] - v) / 2, 1e-12));
      const q = new Int16Array(src.length);
      for (let j = 0; j < src.length; j++) { const k = j % n; q[j] = Math.max(-32767, Math.min(32767, Math.round((src[j] - o[k]) / s[k] * 32767))); }
      out.componentType = 5122; out.extras = { ...(a.extras || {}), q: { o, s } };
      out.bufferView = push(new Uint8Array(q.buffer));
    } else if (role[i] === 'n' && a.componentType === 5126) {
      const q = new Int16Array(src.length);
      for (let j = 0; j < src.length; j++) q[j] = Math.max(-32767, Math.min(32767, Math.round(src[j] * 32767)));
      out.componentType = 5122; out.normalized = true;
      out.bufferView = push(new Uint8Array(q.buffer));
    } else out.bufferView = push(new Uint8Array(src.buffer));
    return out;
  });
  json.bufferViews = views;
  json.buffers = [{ byteLength: pos }];
  json.asset = { ...json.asset, extras: { ...(json.asset.extras || {}), quantized: true } };
  const binBuf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
  let js = Buffer.from(JSON.stringify(json), 'utf8'); const jp = (4 - (js.length % 4)) % 4; if (jp) js = Buffer.concat([js, Buffer.alloc(jp, 0x20)]);
  const bp = (4 - (binBuf.length % 4)) % 4, binP = bp ? Buffer.concat([binBuf, Buffer.alloc(bp)]) : binBuf;
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binP.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const outBuf = Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(binP.length, 0x004e4942), binP]);
  writeFileSync(file, outBuf);
  console.log(file, buf.length, '→', outBuf.length);
}
