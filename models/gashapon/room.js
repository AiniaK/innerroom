/* 扭蛋公仔（three.js r158，全域 THREE）：書桌櫃頂層的小公仔。模型在 gashapon.glb（由 build_model.py 產生），材質在這裡設定。
   用法：Gashapon.load(name) → Promise<{ root, meshes, height, tick() }>；name 是角色（Eye、Scale、Bear、Monkey）。
   先給低解析度的形狀；Gashapon.upgrade() 載入精細版，把已經放好的公仔換成精細的形狀（材質、位置不變）。
   root 原點在公仔正中間，臉朝 +z、上 +y；height 是公仔的高（模型單位，房間再縮成實際大小）。 */
(function () {
  'use strict';
  const T = () => window.THREE;
  const V = '2026-11-24z';
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
    const ARR = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5122: Int16Array, 5120: Int8Array };
    const acc = (i) => {
      const a = json.accessors[i], bv = json.bufferViews[a.bufferView], n = SIZE[a.type], C = ARR[a.componentType];
      const start = bin + (bv.byteOffset || 0) + (a.byteOffset || 0);
      if (bv.byteStride && bv.byteStride !== n * C.BYTES_PER_ELEMENT) throw new Error('不支援交錯的頂點資料');
      const raw = new C(buf.slice(start, start + a.count * n * C.BYTES_PER_ELEMENT));
      // 壓縮過的網格（tools/quantize-glb.mjs）：16 位元整數還原成浮點數
      if (a.extras && a.extras.q) { const { o, s } = a.extras.q, f = new Float32Array(raw.length); for (let j = 0; j < raw.length; j++) f[j] = o[j % n] + s[j % n] * raw[j] / 32767; return new THREE.BufferAttribute(f, n); }
      if (a.normalized && C === Int16Array) { const f = new Float32Array(raw.length); for (let j = 0; j < raw.length; j++) f[j] = Math.max(-1, raw[j] / 32767); return new THREE.BufferAttribute(f, n); }
      return new THREE.BufferAttribute(raw, n);
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
  // 兩份模型：低解析度（房間一開始就先放，幾十 KB）和精細版（走近或過一會兒才載入，載好就把每個部位的形狀換掉）
  const glbs = {};
  const glb = (lo) => glbs[lo ? 'lo' : 'hi'] || (glbs[lo ? 'lo' : 'hi'] = fetch(`models/gashapon/gashapon${lo ? '-lo' : ''}.glb?v=${V}`).then((r) => r.arrayBuffer()).then(parseGlb));
  const made = [];   // 放進房間的公仔：{ name, meshes }，換精細版時用
  let upP = null;
  function swap(all, { name, meshes }) {
    const src = all.getObjectByName('Fig_' + name);
    if (!src) return;
    const by = {};
    src.traverse((o) => { if (o.isMesh) by[o.name] = o.geometry; });
    meshes.forEach((m) => { const g = by[m.name]; if (g && m.geometry !== g) { m.geometry.dispose(); m.geometry = g; } });
  }
  function upgrade() {
    if (!fullNow) { fullNow = true; Object.values(texReg).forEach((R) => R.full && R.full()); }
    return upP || (upP = glb(false).then((all) => { made.forEach((f) => swap(all, f)); return all; })
      .catch((e) => { upP = null; console.warn('扭蛋公仔精細版載入失敗', e); }));
  }

  // 材質：亮面軟膠（像扭蛋公仔的塗裝），不同部位不同光澤
  function vinyl(color, o = {}) { const THREE = T(); return new THREE.MeshPhysicalMaterial(Object.assign({ color, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.35 }, o)); }
  // 透明鏡片：正面幾乎看穿，越靠邊緣越看得到淡藍色（像真的隱形眼鏡）
  function lensMat() {
    const THREE = T(), m = new THREE.MeshPhysicalMaterial({ color: 0xd2ecff, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide, specularIntensity: 1 });
    m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `{ float f = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
        diffuseColor.a = clamp(diffuseColor.a + pow(f, 2.2) * 0.5, 0.0, 0.75); outgoingLight = mix(outgoingLight, vec3(0.6, 0.85, 1.0) * (0.25 + 1.4 * dot(outgoingLight, vec3(0.333))), pow(f, 2.0) * 0.7); }   // 邊緣的淡藍跟著照到的光走，不自己發光
      #include <opaque_fragment>`); };
    m.customProgramCacheKey = () => 'gacha-lens-2';
    return m;
  }
  // 毛氈：霧面＋絨毛光澤，再用細小的雜訊擾動法線，表面看起來毛茸茸的（不像光滑塑膠）
  function felt(color, o = {}) {
    const THREE = T(), m = new THREE.MeshPhysicalMaterial(Object.assign({ color, roughness: 0.95, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xfff1d8) }, o));
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = 'varying vec3 vFz;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFz = position;');
      sh.fragmentShader = 'varying vec3 vFz;\nfloat fzH(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}\n' +
        sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 q = vFz * 900.0; vec3 j = vec3(fzH(floor(q)), fzH(floor(q) + 17.0), fzH(floor(q) + 31.0)) - 0.5;
          normal = normalize(normal + j * 0.55); }`);
    };
    m.customProgramCacheKey = () => 'gacha-felt';
    return m;
  }
  function matte(color, o = {}) { return vinyl(color, Object.assign({ roughness: 0.62, clearcoat: 0.1, clearcoatRoughness: 0.6 }, o)); }
  function metal(color) { const THREE = T(); return new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.2 }); }
  // 貼圖（泰迪熊、耳鼻猴用模型的貼圖）：glTF 的 UV 不用上下翻。
  // 三段式載入，才不會在貼圖下載完之前黑黑的：先用一個平均色 → 縮小版（xxx_s.jpg，幾 KB）→ 完整貼圖
  const TEXFILL = { 'bear_tex.jpg': '#e8a55a', 'monkey_tex.jpg': '#c98a4e' };
  const texReg = {};
  let fullNow = false;
  function texObj(src, srgb) {
    const THREE = T(), t = new THREE.Texture(src);
    t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4; t.needsUpdate = true;
    return t;
  }
  function tex(file, srgb) {
    if (texReg[file]) return texReg[file].cur;
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.fillStyle = srgb ? (TEXFILL[file] || '#bbbbbb') : '#8080ff'; g.fillRect(0, 0, 1, 1);
    const R = texReg[file] = { cur: texObj(c, srgb), users: [], level: 0 };
    R.cur.userData.gfile = file;
    const put = (lvl, url) => {
      const img = new Image();
      img.onload = () => {
        if (R.level >= lvl) return;
        const old = R.cur; R.level = lvl; R.cur = texObj(img, srgb); R.cur.userData.gfile = file;
        R.users.forEach(([m, k]) => { m[k] = R.cur; m.needsUpdate = true; });
        old.dispose();
      };
      img.src = url;
    };
    put(1, `models/gashapon/${file.replace('.jpg', '_s.jpg')}?v=${V}`);
    R.full = () => put(2, `models/gashapon/${file}?v=${V}`);   // the full texture comes with the fine figures (upgrade), when you come near
    if (fullNow) R.full();
    return R.cur;
  }
  function useTex(m) {   // 材質用到的貼圖登記起來，換成更清楚的版本時一起換
    ['map', 'normalMap'].forEach((k) => { const f = m[k] && m[k].userData && m[k].userData.gfile; if (f && texReg[f]) { m[k] = texReg[f].cur; texReg[f].users.push([m, k]); } });
  }
  const MATS = {
    Scale: () => ({ Body: vinyl(0xF4B3C2, { roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.5 }), Frame: vinyl(0xF4B3C2, { roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.5 }), Panel: vinyl(0xFBF0E6, { roughness: 0.5 }), Dial: vinyl(0x8FDCEB, { roughness: 0.25, clearcoat: 0.8 }),
      Ticks: vinyl(0x1F1F24), Needle: vinyl(0xE0202A), Cap: vinyl(0xA9D3F2, { roughness: 0.4 }), Eyes: vinyl(0x1B2A55, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 }), Cheeks: matte(0xF6A9B6),
      Mouth: vinyl(0xE0435A), Tongue: vinyl(0xF68C9C), Tape: vinyl(0xF8C81E, { roughness: 0.4 }), Limbs: vinyl(0x3F5F9E, { roughness: 0.55, clearcoat: 0.15 }), Metal: metal(0xC9CDD3) }),
    Bear: () => ({ Skin: felt(0xffffff, { map: tex('bear_tex.jpg', true), normalMap: tex('bear_nrm.jpg', false) }), Body: felt(0xE9B676), Head: felt(0xE9B676), Tail: felt(0xffffff, { map: tex('bear_tex.jpg', true) }), Muzzle: felt(0xFBF6EC), Mouth: vinyl(0xD92030, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 }), Tongue: vinyl(0xF08A8A, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 }), Nose: vinyl(0x141414, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 }),
      Eyes: vinyl(0x0E0E0E, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 }), Cheeks: matte(0xFF987A), EarIn: matte(0xffffff, { map: tex('bear_tex.jpg', true), normalMap: tex('bear_nrm.jpg', false) }), Wand: matte(0xC08A52), WandTube: matte(0xC08A52), Ears: felt(0xE9B676), Star: vinyl(0xFFC91A, { roughness: 0.4 }),
      Sparks: vinyl(0xFFC91A), Seams: felt(0xC69A62), Pads: felt(0xFF987A) }),
    Monkey: () => ({ Skin: felt(0xffffff, { map: tex('monkey_tex.jpg', true), normalMap: tex('monkey_nrm.jpg', false) }), Cloth: matte(0xffffff, { map: tex('monkey_tex.jpg', true), normalMap: tex('monkey_nrm.jpg', false) }), Cream: vinyl(0xffffff, { map: tex('monkey_tex.jpg', true), normalMap: tex('monkey_nrm.jpg', false), roughness: 0.45 }), Head: matte(0xC98A4E), Body: matte(0xC98A4E), Tail: matte(0xC98A4E), Face: matte(0xF8DDB8), Belly: matte(0xF8DDB8), EarIn: matte(0xF8DDB8),
      EarPink: matte(0xF59A82), Eyes: vinyl(0xffffff, Object.assign({ map: tex('monkey_tex.jpg', true) }, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 })), Cheeks: matte(0xF6A0A0), Nose: vinyl(0x7A3E2A), Mouth: vinyl(0x9E2230), Tongue: vinyl(0xF08A8A),
      Band: matte(0xFBFBFB), Bow: matte(0xFBFBFB), Fists: matte(0xF8DDB8), Tail2: matte(0xC98A4E), Orn: vinyl(0xF8A51E, { roughness: 0.4 }), Cape: matte(0x3D7FD6, { side: T().DoubleSide }) }),
    Eye: () => ({ Body: vinyl(0xF4EEE2, { roughness: 0.45 }), Iris: vinyl(0x4D9AFF, { roughness: 0.45 }),
      Pupil: vinyl(0x1E3566, { roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 }), Shine: vinyl(0xFFFFFF, { roughness: 0.3, clearcoat: 0.5 }),   // 眼睛的反光點：不自帶發光，跟著房間的光亮暗
      Smile: vinyl(0x1E3566, { roughness: 0.5 }), Limbs: vinyl(0x4A6FB3, { roughness: 0.55, clearcoat: 0.15 }), Lens: lensMat(),
      Rim: new (T().MeshPhysicalMaterial)({ color: 0x8FD0F5, roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.75, depthWrite: false }) }),
  };

  async function load(name) {
    name = String(name).split('?')[0];
    const THREE = T(), lo = !upP, all = await glb(lo), src = all.getObjectByName('Fig_' + name);
    if (!src) throw new Error('沒有這個公仔：' + name);
    const fig = src.clone(true), mats = MATS[name](), meshes = [];
    Object.values(mats).forEach(useTex);
    fig.position.set(0, 0, 0);
    fig.traverse((o) => { if (!o.isMesh) return; const part = o.name.split('_').pop(); o.material = mats[part] || vinyl(0xffffff); const glass = part === 'Lens' || part === 'Rim'; o.castShadow = !glass; o.receiveShadow = true; if (glass) o.renderOrder = 4; meshes.push(o); });
    // 原點移到公仔正中間（拿起來時繞著中心轉）
    const box = new THREE.Box3().setFromObject(fig), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    fig.position.sub(c);
    const root = new THREE.Group(); root.add(fig);
    if (lo) { const f = { name, meshes }; made.push(f); if (upP) upP.then((hi) => hi && swap(hi, f)); }
    return { root, meshes, height: size.y, width: Math.max(size.x, size.z), tick() {} };
  }
  window.Gashapon = { load, upgrade };
})();
