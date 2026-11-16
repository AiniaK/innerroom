/* 腦角獸：給內在房間用的載入程式（three.js r158，全域 THREE，不需要 GLTFLoader）。
   讀 brainhorn.glb（由 build_model.py 產生），每個部位一個 mesh：Body、Brain、Horns、Eyes、Mouth、Spots、Stars。
   材質由房間設定（和房間其他布偶一樣的卡通質感），這裡只負責讀檔。
   用法：Brainhorn.load(url).then(m => { m.parts.Body ... }) ；模型單位：身體高度 1，腳底在 y=0，臉朝 +z。 */
(function () {
  'use strict';
  const T = () => window.THREE;
  function parseGlb(buf) {
    const THREE = T();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB 檔');
    let off = 12, json = null, bin = null;
    while (off < buf.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
      else if (type === 0x004e4942) bin = off + 8;
      off += 8 + len;
    }
    const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const ARR = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
    const acc = (i) => {
      const a = json.accessors[i], bv = json.bufferViews[a.bufferView], n = SIZE[a.type], C = ARR[a.componentType];
      const start = bin + (bv.byteOffset || 0) + (a.byteOffset || 0);
      if (bv.byteStride && bv.byteStride !== n * C.BYTES_PER_ELEMENT) throw new Error('不支援交錯的頂點資料');
      return new THREE.BufferAttribute(new C(buf.slice(start, start + a.count * n * C.BYTES_PER_ELEMENT)), n);
    };
    const meshes = (json.meshes || []).map((m) => m.primitives.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', acc(p.attributes.POSITION));
      if (p.attributes.NORMAL !== undefined) g.setAttribute('normal', acc(p.attributes.NORMAL));
      if (p.attributes.TEXCOORD_0 !== undefined) g.setAttribute('uv', acc(p.attributes.TEXCOORD_0));
      if (p.indices !== undefined) g.setIndex(acc(p.indices));
      if (!g.attributes.normal) g.computeVertexNormals();
      return g;
    }));
    const build = (i) => {
      const nd = json.nodes[i];
      let o;
      if (nd.mesh !== undefined) {
        const prims = meshes[nd.mesh];
        if (prims.length === 1) o = new THREE.Mesh(prims[0]);
        else { o = new THREE.Group(); prims.forEach((g) => o.add(new THREE.Mesh(g))); }
      } else o = new THREE.Group();
      o.name = nd.name || '';
      if (nd.extras) Object.assign(o.userData, nd.extras);
      if (nd.matrix) new THREE.Matrix4().fromArray(nd.matrix).decompose(o.position, o.quaternion, o.scale);
      if (nd.translation) o.position.fromArray(nd.translation);
      if (nd.rotation) o.quaternion.fromArray(nd.rotation);
      if (nd.scale) o.scale.fromArray(nd.scale);
      (nd.children || []).forEach((c) => o.add(build(c)));
      return o;
    };
    const root = new THREE.Group();
    json.scenes[json.scene || 0].nodes.forEach((i) => root.add(build(i)));
    return root;
  }
  window.Brainhorn = {
    load: (url) => fetch(url).then((r) => { if (!r.ok) throw new Error('模型下載失敗 ' + r.status); return r.arrayBuffer(); }).then((buf) => {
      const root = parseGlb(buf), parts = {};
      root.traverse((o) => { if (o.isMesh) parts[o.name] = o; });
      return { root, parts };
    }),
  };
})();
