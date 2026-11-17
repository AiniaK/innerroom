/* 以碎為翼（2013）：給內在房間用的載入程式（three.js r158，全域 THREE，不需要 GLTFLoader）。
   讀 mirror_wings.glb（由 build_model.py 產生），套上鏡片、絨布、木框的材質，回傳可以放進場景的物件。
   這件作品沒有任何動態，tick 是空函式。
   用法：
     MirrorWings.load(url, { renderer }).then(w => { scene.add(w.root); ... w.setEnvMap(cubeTexture) })
   回傳 { root, tick(dt), height, meshes, setEnvMap(texture) }
     root    原點在木框正中央（寬、高、深的中心），單位公尺，正面朝 +z，上方 +y
     height  含框總高（0.40）；width 0.52、depth 0.05 也一併附上
     meshes  所有 mesh：Shards_Mirror（鏡面）、Shards_Edge（鏡片的側邊與背面）、Velvet（絨布）、Frame（木框）、Backboard（背板）
     setEnvMap(texture)  把房間拍下來的環境（CubeTexture 或 PMREM 貼圖）套到鏡片上；傳 null 則回到內建的攝影棚環境
   還沒呼叫 setEnvMap 之前，鏡片反射的是內建的程序化攝影棚（灰色房間加幾片柔光板與幾個小亮點）：
   有傳 renderer 時用 PMREMGenerator 產生；沒傳時改用畫布拼成的 CubeTexture，一樣不會是一片黑。
   單獨檢視頁（index.html）也用這一份程式，兩邊的材質相同。 */
(function () {
  'use strict';
  const T = () => window.THREE;
  const WIDTH = 0.52, HEIGHT = 0.40, DEPTH = 0.05;

  /* ---------- 迷你 GLB 解析：只讀這個模型用到的部分（節點階層、位移旋轉縮放、extras、POSITION / NORMAL / TEXCOORD_0 / indices） ---------- */
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

  function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 貼圖（畫布生成） ---------- */
  // 淺色原木（偏暖的櫸木色）：木紋沿著 u 方向，也就是沿著框條的長邊
  function woodTexture() {
    const THREE = T(), W = 1024, H = 256, r = rng(745);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#d0a06a'; g.fillRect(0, 0, W, H);
    // 寬的色帶
    for (let i = 0; i < 26; i++) {
      const y = r() * H, h = 6 + r() * 34;
      g.fillStyle = r() < 0.5 ? `rgba(226,178,120,${0.10 + r() * 0.16})` : `rgba(150,96,50,${0.07 + r() * 0.13})`;
      g.fillRect(0, y, W, h); g.fillRect(0, y - H, W, h);
    }
    // 細木紋：微微起伏的長線，左右兩端接得起來
    for (let i = 0; i < 150; i++) {
      const y0 = r() * H, amp = 0.4 + r() * 2.0, k = 1 + Math.floor(r() * 2), ph = r() * 6.283;
      g.strokeStyle = r() < 0.72 ? `rgba(132,82,40,${0.07 + r() * 0.17})` : `rgba(240,204,156,${0.07 + r() * 0.15})`;
      g.lineWidth = 0.5 + r() * 1.3;
      g.beginPath();
      for (let x = 0; x <= W; x += 16) { const y = y0 + Math.sin(x / W * 6.283 * k + ph) * amp; if (x === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    }
    // 櫸木的細小斑點（短短的深色髓線）
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = `rgba(118,72,36,${0.08 + r() * 0.16})`;
      g.fillRect(r() * W, r() * H, 3 + r() * 9, 0.7 + r() * 0.6);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  // 絨布：很淡的斑駁，讓大片深色不會死平
  function velvetTexture() {
    const THREE = T(), S = 256, r = rng(2013);
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 520; i++) {
      const x = r() * S, y = r() * S, rad = 5 + r() * 26, v = r() < 0.5 ? 255 : 70;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(${v},${v},${v},${0.05 + r() * 0.07})`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = gr;
      for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) { if ((ox && (x + ox + rad < 0 || x + ox - rad > S)) || (oy && (y + oy + rad < 0 || y + oy - rad > S))) continue; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2); }   // 只畫真的跨到邊上的複本
    }
    const id = g.getImageData(0, 0, S, S), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(id, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 5); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ---------- 內建的攝影棚環境（還沒有房間的環境貼圖時用） ----------
     作品正面朝 +z，鏡片反射的主要是 +z 那一側，所以柔光板與小亮點大多放在前方的半球；翻轉時每片鏡片輪流掃過亮點而閃爍。 */
  const PANELS = [   // 方向（會正規化）、寬、高、亮度
    [[-0.55, 0.85, 1.0], 2.6, 2.0, 5.5],    // 左上的大柔光箱
    [[1.0, 0.25, 0.75], 0.9, 3.2, 4.5],     // 右側的直條
    [[-1.0, -0.1, 0.45], 0.7, 2.6, 3.2],    // 左側的直條
    [[0.1, 1.0, 0.15], 3.2, 1.6, 2.6],      // 頂光
    [[0.35, 0.95, -1.0], 2.4, 1.8, 3.0],    // 後上方（翻到背面時也有東西可以反射）
    [[0.25, 0.3, 1.0], 0.34, 0.34, 26],     // 以下是小而亮的點
    [[-0.3, -0.25, 1.0], 0.26, 0.26, 20],
    [[0.75, 0.75, 0.6], 0.3, 0.3, 24],
    [[-0.85, 0.4, 0.7], 0.26, 0.26, 20],
    [[0.6, -0.55, 0.8], 0.24, 0.24, 16],
    [[-0.1, 0.55, 1.0], 0.22, 0.22, 22],
    [[-0.7, -0.6, -0.6], 0.3, 0.3, 14],
    [[0.9, 0.1, -0.7], 0.3, 0.3, 14],
  ];
  // 深淺不一的色塊（像房間裡的家具、門窗、牆面）：每片鏡片的角度略有不同，反射到的明暗也就各不相同
  const PATCHES = (function () {
    const r = rng(323), out = [];
    for (let i = 0; i < 90; i++) {
      const z = r() * 2 - 1, a = r() * 6.283, q = Math.sqrt(1 - z * z), k = r();
      const v = k < 0.35 ? 0.03 + r() * 0.1 : k < 0.75 ? 0.2 + r() * 0.4 : 0.8 + r() * 0.9;
      out.push([[q * Math.cos(a), z, q * Math.sin(a)], 0.5 + r() * 1.9, 0.5 + r() * 1.9, v]);
    }
    return out;
  })();
  const WALLS = { px: 0.30, nx: 0.24, py: 0.62, ny: 0.10, pz: 0.36, nz: 0.20 };   // 灰色房間六面的明暗（線性）

  function studioScene() {
    const THREE = T(), sc = new THREE.Scene();
    const mk = (v, tint) => { const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }); m.color.setRGB(v * tint[0], v * tint[1], v * tint[2]); return m; };
    const warm = [1.0, 0.97, 0.93], cool = [0.95, 0.98, 1.0];
    const room = new THREE.Mesh(new THREE.BoxGeometry(12, 12, 12),
      [mk(WALLS.px, warm), mk(WALLS.nx, cool), mk(WALLS.py, warm), mk(WALLS.ny, warm), mk(WALLS.pz, cool), mk(WALLS.nz, warm)]);
    sc.add(room);
    const put = (list, dist) => list.forEach((p, i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(p[1], p[2]), mk(p[3], i % 2 ? cool : warm));
      m.position.set(p[0][0], p[0][1], p[0][2]).normalize().multiplyScalar(dist);
      m.lookAt(0, 0, 0); sc.add(m);
    });
    put(PATCHES, 5.6); put(PANELS, 5);
    return sc;
  }
  function disposeScene(sc) { sc.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); }); }

  // 沒有 renderer 時的替代品：把同一個攝影棚畫在六張畫布上（亮度壓在 0–1）
  function canvasEnv() {
    const THREE = T(), S = 256;
    const faces = [   // 每一面的朝向與畫布上的右、上方向（three 的 CubeTexture 排列：+x −x +y −y +z −z）
      { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0], w: WALLS.px }, { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0], w: WALLS.nx },
      { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1], w: WALLS.py }, { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1], w: WALLS.ny },
      { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], w: WALLS.pz }, { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0], w: WALLS.nz },
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const imgs = faces.map((f) => {
      const c = document.createElement('canvas'); c.width = c.height = S;
      const g = c.getContext('2d'), v = Math.round(Math.pow(f.w, 1 / 2.2) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, 0, S, S);
      PATCHES.concat(PANELS).forEach((p) => {
        const L = Math.hypot(p[0][0], p[0][1], p[0][2]), d = [p[0][0] / L, p[0][1] / L, p[0][2] / L], k = dot(d, f.n);
        if (k < 0.3) return;
        const x = dot(d, f.r) / k, y = dot(d, f.u) / k;                 // 投影到這一面（−1…1）
        const hw = p[1] / 10 / k, hh = p[2] / 10 / k, b = Math.min(255, Math.round(Math.pow(Math.min(p[3], 1), 1 / 2.2) * 235 + Math.min(p[3], 20)));
        g.fillStyle = `rgb(${b},${b},${b})`;
        g.fillRect((x - hw + 1) / 2 * S, (1 - (y + hh)) / 2 * S, hw * S, hh * S);
      });
      return c;
    });
    const t = new THREE.CubeTexture(imgs); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    return t;
  }

  function defaultEnv(renderer) {
    const THREE = T();
    if (renderer && THREE.PMREMGenerator) {
      try {
        const pm = new THREE.PMREMGenerator(renderer), sc = studioScene();
        const rt = pm.fromScene(sc, 0, 0.1, 100);
        pm.dispose(); disposeScene(sc);
        return { texture: rt.texture, dispose: () => rt.dispose() };
      } catch (e) { console.warn('以碎為翼：內建環境改用畫布版本', e); }
    }
    const t = canvasEnv();
    return { texture: t, dispose: () => t.dispose() };
  }

  /* ---------- 組合 ---------- */
  function build(buf, opts) {
    const THREE = T();
    opts = opts || {};
    const model = parseGlb(buf);
    const get = (n) => { const o = model.getObjectByName(n); if (!o || !o.isMesh) throw new Error('模型缺少 ' + n); return o; };
    const mirror = get('Shards_Mirror'), edge = get('Shards_Edge'), velvet = get('Velvet'), frame = get('Frame'), back = get('Backboard');

    // 鏡片：單純的鏡子銀色（沒有綠邊）
    const mirrorMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 1, roughness: 0.04, envMapIntensity: 1 });
    // 鏡片厚度的側邊與背面：略暗的銀灰，稍微粗一點，碎裂的邊緣會帶一點細碎的亮
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a5, metalness: 0.9, roughness: 0.3, envMapIntensity: 0.9 });
    // 絨布：接近黑的暖咖啡，霧面吸光；只留一點絨毛的邊光，不反射環境
    const velvetMat = new THREE.MeshPhysicalMaterial({ color: 0x35231a, map: velvetTexture(), roughness: 1, metalness: 0,
      specularIntensity: 0, sheen: 1, sheenColor: new THREE.Color(0x6e4e3a), sheenRoughness: 0.55, envMapIntensity: 0 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: woodTexture(), roughness: 0.6, metalness: 0, envMapIntensity: 0.35 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.9, metalness: 0, envMapIntensity: 0.2 });
    mirror.material = mirrorMat; edge.material = edgeMat; velvet.material = velvetMat; frame.material = woodMat; back.material = backMat;

    const meshes = [];
    model.traverse((o) => { if (o.isMesh) { meshes.push(o); o.userData.noInk = true; o.castShadow = o !== velvet; o.receiveShadow = o === velvet || o === frame; } });

    // 模型本身的原點已經在木框正中央
    const root = new THREE.Group(); root.name = 'MirrorWings'; root.add(model);

    // 鏡片的環境：先用內建攝影棚，房間準備好之後用 setEnvMap 換成它拍下來的環境
    const reflective = [mirrorMat, edgeMat];
    let builtin = defaultEnv(opts.renderer);
    const apply = (t) => reflective.forEach((m) => { m.envMap = t; m.needsUpdate = true; });
    apply(builtin.texture);
    const setEnvMap = (texture) => {
      if (texture) { apply(texture); if (builtin) { builtin.dispose(); builtin = null; } }
      else { if (!builtin) builtin = defaultEnv(opts.renderer); apply(builtin.texture); }
    };

    return { root, tick: function () {}, height: HEIGHT, width: WIDTH, depth: DEPTH, meshes, setEnvMap,
      materials: { mirror: mirrorMat, edge: edgeMat, velvet: velvetMat, wood: woodMat, back: backMat } };
  }

  window.MirrorWings = {
    load: (url, opts) => fetch(url).then((r) => { if (!r.ok) throw new Error('模型下載失敗 ' + r.status); return r.arrayBuffer(); }).then((buf) => build(buf, opts)),
    build,
  };
})();
