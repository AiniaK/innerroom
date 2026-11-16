/* 金魚酒杯：給內在房間用的載入程式（three.js r158，全域 THREE，不需要 GLTFLoader）。
   讀 goldfish_glass.glb（由 build_model.py 產生），套上玻璃、液體、金魚、氣泡的材質，回傳可以放進場景的物件。
   兩種狀態：靜態（預設，魚停在液面、一片鰭伸出水面，整件作品完全靜止）與動態（魚在液體裡繞著游、氣泡飄動）。
   材質與 models/goldfish-glass/index.html（單獨檢視頁）相同。
   用法：GoldfishGlass.load(url).then(g => { scene.add(g.root); ... 每幀都呼叫 g.tick(dt)；g.setMotion(true/false) 切換，g.motion 是目前要的狀態 })
   tick 每幀都要呼叫（不要用 dt=0 來暫停）：靜態時它只負責把魚游回去、停好，到位之後什麼都不做。
   g.root 的原點在杯子正中央（模型單位：參考圖像素 / 100，總高約 12.2），g.height 是總高。 */
(function () {
  'use strict';
  const T = () => window.THREE;

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

  /* ---------- 材質 ---------- */
  const SURF_VERT = `
    varying vec3 vN; varying vec3 vP;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;
  // 程序化攝影棚：左右各一個直條柔光箱 + 頂光（在視角空間）
  const STUDIO = `
    float band(float x, float a, float b, float s){ return smoothstep(a-s,a+s,x)*(1.0-smoothstep(b-s,b+s,x)); }
    float studio(vec3 r){
      float vert = 1.0 - smoothstep(0.55, 0.92, abs(r.y));
      float s = band(r.x, 0.40, 0.60, 0.05) * 0.85 * vert;
      s += band(-r.x, 0.50, 0.76, 0.05) * vert;
      s += band(-r.x, 0.86, 0.93, 0.02) * 0.5 * vert;
      s += band(r.y, 0.78, 0.95, 0.05) * 0.45;
      return s; }`;
  const GLASS_FRAG = `
    uniform float uGain; uniform vec3 uEdge; varying vec3 vN; varying vec3 vP;
    ${STUDIO}
    void main(){
      vec3 v = normalize(-vP); vec3 n = normalize(vN); if (dot(n,v) < 0.0) n = -n;
      float ndv = clamp(dot(n,v),0.0,1.0); vec3 r = reflect(-v,n);
      float aEdge = pow(1.0-ndv,6.0)*0.62*mix(1.0,0.28,smoothstep(0.80,0.98,abs(n.y)));
      float aSpec = studio(r)*(0.14+0.50*pow(1.0-ndv,1.5));
      float aBase = 0.018; float a = aBase + aEdge + aSpec;
      vec3 col = (vec3(0.93,0.95,0.96)*aBase + uEdge*aEdge + vec3(1.0)*aSpec)/a;
      gl_FragColor = vec4(col, clamp(a*uGain,0.0,1.0));
      #include <colorspace_fragment>
    }`;
  const LIQUID_FRAG = `
    uniform vec3 uCol; uniform vec3 uDeep; uniform float uA0; uniform float uA1; uniform float uSpec; varying vec3 vN; varying vec3 vP;
    ${STUDIO}
    void main(){
      vec3 v = normalize(-vP); vec3 n = normalize(vN); if (dot(n,v) < 0.0) n = -n;
      float ndv = clamp(dot(n,v),0.0,1.0); float f = pow(1.0-ndv,1.7);
      vec3 col = mix(uCol,uDeep,f); float a = mix(uA0,uA1,f);
      float s = studio(reflect(-v,n))*uSpec;
      col = mix(col, vec3(1.0,0.98,0.9), clamp(s,0.0,1.0)); a = clamp(a+s*0.5,0.0,1.0);
      gl_FragColor = vec4(col,a);
      #include <colorspace_fragment>
    }`;
  const glassMat = (side, gain) => new (T().ShaderMaterial)({ vertexShader: SURF_VERT, fragmentShader: GLASS_FRAG,
    uniforms: { uGain: { value: gain }, uEdge: { value: new (T().Color)(0x74767c) } }, transparent: true, depthWrite: false, side });
  const liquidMat = (side, col, deep, a0, a1, spec) => new (T().ShaderMaterial)({ vertexShader: SURF_VERT, fragmentShader: LIQUID_FRAG,
    uniforms: { uCol: { value: new (T().Color)(col) }, uDeep: { value: new (T().Color)(deep) }, uA0: { value: a0 }, uA1: { value: a1 }, uSpec: { value: spec } },
    transparent: true, depthWrite: false, side });

  function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /* ---------- 金魚（紅色長尾金魚，帶一點金色質感）的材質與游動。這一段在 room.js 與 index.html 是同一份，改的時候請兩邊一起改 ----------
     魚永遠躺在一條「軌道」上：頂點 shader 把魚的本地 x（沿身體）對到軌道上的弧長、y/z 當成離軌道的橫向偏移，
     所以身體與尾巴會順著路徑彎。軌道是一圈一圈的環形路徑（折線由 build_model.py 算好並檢查過，放在 Fish 節點的 extras.swim）：
     一般的圈有幾種形狀輪流出現；另外有一圈「下潛圈」會貼近液面。
     鰭在靜態與游動時都是同一個形狀和大小（只有擺動），沒有任何伸縮或收放。
     靜態：魚停在下潛圈的最低點，貼近液面、順著轉彎微微側傾，朝下垂的那片腹鰭就自然穿過液面，完全不動。
     動態：從停的地方沿下潛圈往前游、離開液面去繞圈；要停下來時，游完這一圈後轉進下潛圈，游到最低點減速停住。 */
  function fishKit(THREE) {
    const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const canvasTex = (w, h, draw) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.anisotropy = 8; return t;
    };
    const sm = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

    // 魚身：x 沿身體（0 尾柄 → 1 吻部）；y：0 與 1 是腹部、0.5 是背部。整條都是紅色，鱗片後緣鑲一圈金色
    const bodyTex = () => {
      const t = canvasTex(1024, 1024, (g, W, H) => {
        const BACK = [146, 6, 12], FLANK = [214, 20, 20], BELLY = [226, 50, 34];
        const colAt = (y) => {
          const b = Math.min(y, H - y) / (H / 2);            // 0 腹 → 1 背
          return b < .3 ? BELLY.map((v, i) => v + (FLANK[i] - v) * sm(b / .3)) : FLANK.map((v, i) => v + (BACK[i] - v) * sm((b - .3) / .7));
        };
        for (let y = 0; y < H; y += 2) { g.fillStyle = rgb(colAt(y)); g.fillRect(0, y, W, 2); }
        // 鱗片：像屋瓦一樣由頭往尾疊，露出來的後緣是金色的圓弧，被蓋住的中心是較深的紅
        const rand = rng(7), sx = 50, rows = 24, sy = H / rows, rx = sx * .98, ry = sy * .68, xEnd = W * .80;
        for (let col = 0; col * sx < xEnd + sx; col++) for (let k = 0; k < 2; k++) for (let row = k; row <= rows; row += 2) {
          const cx = col * sx + (k ? sx / 2 : 0) - 8, cy = row * sy;
          if (cx > xEnd) continue;
          const b = Math.min(cy, H - cy) / (H / 2), glint = rand();
          const c = colAt(cy), rim = c.map((v, i) => Math.min(255, v * 1.08 + [40, 46, 8][i] * (.3 + .7 * glint))), core = c.map((v) => v * .68);
          g.globalAlpha = Math.min(1, (xEnd - cx) / 130) * (.55 + .45 * sm(b / .25));
          g.beginPath(); g.ellipse(cx - 3, cy, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = 'rgba(64,0,4,0.6)'; g.fill();
          const gr = g.createRadialGradient(cx + rx * .55, cy, rx * .1, cx + rx * .2, cy, rx * 1.15);
          gr.addColorStop(0, rgb(core)); gr.addColorStop(.55, rgb(c)); gr.addColorStop(1, rgb(rim));
          g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = gr; g.fill();
          g.beginPath(); g.ellipse(cx, cy, rx - 1.5, ry - 1.5, 0, Math.PI * .6, Math.PI * 1.4);
          g.strokeStyle = `rgba(255,${(196 + 40 * glint) | 0},${(84 + 50 * glint) | 0},${.42 + .45 * glint})`; g.lineWidth = 2.4; g.stroke();
        }
        g.globalAlpha = 1;
        // 頭部：沒有鱗片、顏色略深；鰓蓋是一道帶金邊的弧線
        const hg = g.createLinearGradient(W * .74, 0, W, 0);
        hg.addColorStop(0, 'rgba(160,8,12,0)'); hg.addColorStop(.4, 'rgba(160,8,12,0.3)'); hg.addColorStop(1, 'rgba(120,4,10,0.5)');
        g.fillStyle = hg; g.fillRect(W * .74, 0, W * .26, H);
        for (const y of [H * .27, H * .73]) {
          g.beginPath(); g.ellipse(W * .845, y, W * .05, H * .13, 0, Math.PI * .5, Math.PI * 1.5); g.strokeStyle = 'rgba(84,0,6,0.6)'; g.lineWidth = 6; g.stroke();
          g.beginPath(); g.ellipse(W * .845 + 6, y, W * .05, H * .13, 0, Math.PI * .6, Math.PI * 1.4); g.strokeStyle = 'rgba(255,200,96,0.4)'; g.lineWidth = 3; g.stroke();
        }
        const pg = g.createLinearGradient(0, 0, W * .1, 0); pg.addColorStop(0, 'rgba(190,14,16,0.75)'); pg.addColorStop(1, 'rgba(190,14,16,0)');
        g.fillStyle = pg; g.fillRect(0, 0, W * .1, H);
        // 金粉：背部與體側零星的細點
        for (let i = 0; i < 520; i++) {
          const x = rand() * W, y = H * (.12 + rand() * .76), r = .8 + rand() * 1.9;
          g.fillStyle = `rgba(255,${(206 + rand() * 40) | 0},${(96 + rand() * 60) | 0},${.3 + rand() * .55})`; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        }
      });
      t.wrapT = THREE.RepeatWrapping; return t;
    };

    // 眼睛：x 由瞳孔中心往外。黑瞳孔、金色虹膜，外圈回到深紅
    const eyeTex = () => canvasTex(128, 4, (g, W, H) => {
      const e = g.createLinearGradient(0, 0, W, 0);
      [[0, '#040303'], [.2, '#070404'], [.235, '#eebc50'], [.33, '#cf8a22'], [.4, '#8a2a10'], [.44, '#4a0808'], [.56, '#a01012'], [1, '#b01214']].forEach(([s, c]) => e.addColorStop(s, c));
      g.fillStyle = e; g.fillRect(0, 0, W, H);
    });

    // 鰭：x 根部 → 末端；y 橫跨鰭寬。從根部到末端都是紅色，只是越來越透；鰭條帶金色反光並往末端分岔；零星的金粉；末端與邊緣破碎
    const finCache = {};
    const finTex = (seed) => finCache[seed % 4] || (finCache[seed % 4] = canvasTex(512, 512, (g, W, H) => {
      const rand = rng(1000 + seed % 4);
      const base = g.createLinearGradient(0, 0, W, 0);
      [[0, 'rgba(150,4,12,0.97)'], [.16, 'rgba(194,10,16,0.94)'], [.42, 'rgba(212,18,20,0.84)'], [.72, 'rgba(216,22,22,0.64)'], [1, 'rgba(220,26,24,0.42)']].forEach(([s, c]) => base.addColorStop(s, c));
      g.fillStyle = base; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 46; i++) {       // 鰭膜上深淺不一的長條
        const y = rand() * H, a = .05 + rand() * .12, dark = rand() > .45, colr = dark ? '132,2,10' : '236,44,34';
        const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, `rgba(${colr},0)`); gr.addColorStop(.2 + rand() * .3, `rgba(${colr},${a})`); gr.addColorStop(1, `rgba(${colr},${a * .5})`);
        g.fillStyle = gr; g.fillRect(0, y, W, 4 + rand() * 14);
      }
      const seg = (x0, y0, x1, y1, w, a0, a1) => {     // 一條鰭條：暗紅的影子加上金色的反光
        for (const [dy, colr, k] of [[1.6, '104,0,8', .55], [0, '255,206,112', 1]]) {
          const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, `rgba(${colr},${a0 * k})`); gr.addColorStop(1, `rgba(${colr},${a1 * k})`);
          g.strokeStyle = gr; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0 + dy); g.bezierCurveTo(x0 + (x1 - x0) * .4, y0 + dy, x0 + (x1 - x0) * .6, y1 + dy, x1, y1 + dy); g.stroke();
        }
      };
      const N = 34;
      const ray = (x, y, depth, spread) => {
        const xe = depth === 0 ? W * (.30 + rand() * .14) : depth === 1 ? W * (.58 + rand() * .12) : W;
        const ye = y + (rand() - .5) * 3;
        seg(x, y, xe, ye, [3, 2.2, 1.5][depth], [.62, .58, .52][depth], [.58, .52, .36][depth]);
        if (depth < 2) { ray(xe, ye, depth + 1, spread / 2); ray(xe, ye + spread * (rand() > .5 ? 1 : -1), depth + 1, spread / 2); }
      };
      for (let i = 0; i < N; i++) ray(0, (i + .5 + (rand() - .5) * .4) / N * H, 0, H / N * .5);
      for (let i = 0; i < 42; i++) {       // 細長的金線：從靠近根部一路延伸到末端，像鰭膜上流動的金絲
        const y0 = rand() * H, y1 = y0 + (rand() - .5) * 26, x0 = W * (.04 + rand() * .3), a = .32 + rand() * .34;
        const gr = g.createLinearGradient(x0, 0, W, 0); gr.addColorStop(0, 'rgba(255,214,128,0)'); gr.addColorStop(.18, `rgba(255,214,128,${a})`); gr.addColorStop(1, `rgba(255,224,150,${a * .45})`);
        g.strokeStyle = gr; g.lineWidth = .7 + rand() * .9; g.beginPath(); g.moveTo(x0, y0);
        g.bezierCurveTo(x0 + (W - x0) * .35, y0 + (rand() - .5) * 10, x0 + (W - x0) * .7, y1 + (rand() - .5) * 10, W, y1); g.stroke();
      }
      for (let i = 0; i < 150; i++) {      // 金粉
        const x = W * (.05 + rand() * .93), y = rand() * H, r = .7 + rand() * 1.6;
        g.fillStyle = `rgba(255,${(208 + rand() * 40) | 0},${(104 + rand() * 60) | 0},${.3 + rand() * .5})`; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      g.globalCompositeOperation = 'destination-out';      // 破碎的邊：末端的鋸齒與裂口、兩側的缺角
      const tipFade = g.createLinearGradient(W * .8, 0, W, 0); tipFade.addColorStop(0, 'rgba(0,0,0,0)'); tipFade.addColorStop(1, 'rgba(0,0,0,0.4)');
      g.fillStyle = tipFade; g.fillRect(W * .8, 0, W * .2, H);
      g.fillStyle = '#000';
      for (let i = 0; i < 44; i++) {
        const y = rand() * H, d = W * (.02 + rand() * rand() * .16), h = 2 + rand() * 9;
        g.beginPath(); g.moveTo(W + 1, y - h); g.lineTo(W - d, y + (rand() - .5) * 3); g.lineTo(W + 1, y + h); g.fill();
      }
      for (const yEdge of [0, H]) {
        const e = g.createLinearGradient(0, yEdge, 0, yEdge ? H - 20 : 20); e.addColorStop(0, 'rgba(0,0,0,0.5)'); e.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = e; g.fillRect(0, yEdge ? H - 20 : 0, W, 20);
        g.fillStyle = '#000';
        for (let i = 0; i < 16; i++) { const x = W * (.25 + rand() * .75), r = 3 + rand() * 9; g.beginPath(); g.ellipse(x, yEdge, r * 2.4, r, 0, 0, Math.PI * 2); g.fill(); }
      }
      g.globalCompositeOperation = 'source-over';
    }));

    // 鰭的擺動參數 [擺幅, 沿鰭的波數, 相位, 不透明度, 速度]；擺幅要和 build_model.py 的 SWAY 表一致（邊界檢查用它）
    const FIN = {
      Fin_Tail_UL: [.15, 5.2, 0, 1, 1.25], Fin_Tail_UR: [.15, 4.8, 1.3, 1, 1.2], Fin_Tail_ML: [.16, 5.0, 2.6, 1, 1.15], Fin_Tail_MR: [.16, 5.4, 3.9, 1, 1.2],
      Fin_Tail_LL: [.15, 5.0, 5.1, 1, 1.25], Fin_Tail_LR: [.15, 4.6, .7, 1, 1.15],
      Fin_Dorsal: [.05, 3.4, .6, 1, 1.4], Fin_Ventral_L: [.07, 3.6, 2, 1, 1.3], Fin_Ventral_R: [.06, 3.6, 3.1, 1, 1.3],
      Fin_Anal_L: [.06, 3.4, 1.1, 1, 1.3], Fin_Anal_R: [.06, 3.4, 4, 1, 1.3], Fin_Pectoral_L: [.04, 3, .3, .6, 2.4], Fin_Pectoral_R: [.04, 3, 3.4, .6, 2.4],
    };

    // 把材質套到 Fish 底下的每個 mesh，回傳 { tick(dt), setMotion(on), motion(), flow() }
    const dress = (fish) => {
      const D = typeof fish.userData.swim === 'string' ? JSON.parse(fish.userData.swim) : fish.userData.swim;
      if (!D) throw new Error('模型缺少游動資料（Fish 的 extras.swim），請重新執行 build_model.py');
      const V3 = THREE.Vector3, NS = D.ns, s = fish.scale.x;
      fish.position.set(0, 0, 0); fish.quaternion.identity(); fish.scale.set(1, 1, 1);   // Fish 節點歸零：位置全由軌道決定
      const xs = [], wg = [], spC = [], spT = [], spU = [], dx = (D.xmax - D.xmin) / (NS - 1);
      for (let i = 0; i < NS; i++) { xs.push(D.xmin + dx * i); wg.push(Math.pow(Math.min(1, Math.max(0, (.4 - xs[i]) / 3.4)), 1.5)); spC.push(new V3()); spT.push(new V3()); spU.push(new V3()); }
      const uA = { value: new THREE.Vector4(s, 0, 0, 0) };      // 大小、（未使用）、時間、鰭的擺動量
      const shared = { uSpC: { value: spC }, uSpT: { value: spT }, uSpU: { value: spU }, uFishA: uA, uFishB: { value: new THREE.Vector4(D.xmin, D.xmax, 0, 0) } };

      const patch = (m, fin) => {
        m.onBeforeCompile = (sh) => {
          Object.assign(sh.uniforms, shared);
          if (fin) sh.uniforms.uFin = { value: new THREE.Vector4(fin[0], fin[1], fin[2], fin[4]) };
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', `#include <common>
              #define GF_NS ${NS}
              uniform vec3 uSpC[GF_NS]; uniform vec3 uSpT[GF_NS]; uniform vec3 uSpU[GF_NS]; uniform vec4 uFishA; uniform vec4 uFishB;
              ${fin ? 'uniform vec4 uFin;' : ''}`)
            .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
              vec3 gfP = position; vec3 gfN = objectNormal;
              ${fin ? `float finW = pow(uv.x, 1.3);
              float finA = uFishA.z * uFin.w - uv.x * uFin.y + uFin.z;
              float finS = (sin(finA + uv.y * 2.2) + 0.35 * sin(finA * 1.7 + uv.y * 5.0)) / 1.35;
              gfP += normalize(gfN) * (finS * uFin.x * finW * uFishA.w);` : ''}
              float gfF = clamp((gfP.x - uFishB.x) / (uFishB.y - uFishB.x), 0.0, 1.0) * float(GF_NS - 1);
              int gfI = int(min(floor(gfF), float(GF_NS - 2))); float gfR = gfF - float(gfI);
              vec3 gfC = mix(uSpC[gfI], uSpC[gfI + 1], gfR);
              vec3 gfT = normalize(mix(uSpT[gfI], uSpT[gfI + 1], gfR)); vec3 gfU = mix(uSpU[gfI], uSpU[gfI + 1], gfR);
              vec3 gfL = normalize(cross(gfT, gfU)); gfU = cross(gfL, gfT);
              objectNormal = normalize(gfT * gfN.x + gfU * gfN.y + gfL * gfN.z);`)
            .replace('#include <begin_vertex>', 'vec3 transformed = gfC + uFishA.x * (gfU * gfP.y + gfL * gfP.z);');
        };
        m.customProgramCacheKey = () => (fin ? 'goldfish-fin-5' : 'goldfish-body-5');
        return m;
      };

      const bt = bodyTex();
      const bodyM = patch(new THREE.MeshPhysicalMaterial({ map: bt, roughness: .28, metalness: .3, clearcoat: .8, clearcoatRoughness: .18,
        sheen: .28, sheenColor: new THREE.Color(0xffb040), sheenRoughness: .4, emissive: 0xffffff, emissiveMap: bt, emissiveIntensity: .2, envMapIntensity: .8 }));
      const eyeM = patch(new THREE.MeshPhysicalMaterial({ map: eyeTex(), roughness: .1, clearcoat: 1, clearcoatRoughness: .05, envMapIntensity: .5 }));
      let seed = 0;
      fish.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;                      // 位置由 shader 決定，原本的包圍球不準
        if (o.name === 'FishBody') o.material = bodyM;
        else if (o.name.startsWith('FishEye')) o.material = eyeM;
        else if (o.name.startsWith('Fin_')) {
          const f = FIN[o.name] || [.05, 3, 0, 1, 1.3], tex = finTex(seed++);
          o.material = patch(new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: .24, roughness: .42, metalness: .15,
            transparent: true, opacity: f[3], depthWrite: false, side: THREE.DoubleSide, envMapIntensity: .5 }), f);
          o.renderOrder = 3;
        }
      });

      /* ----- 軌道：一圈一圈等距折線接起來 ----- */
      const mk = (p) => ({ p, n: p.length / 3, ds: Math.hypot(p[3] - p[0], p[4] - p[1], p[5] - p[2]), start: 0, end: 0 });
      let track = [];
      const push = (pc) => { pc.start = track.length ? track[track.length - 1].end : 0; pc.end = pc.start + pc.ds * (pc.n - 1); track.push(pc); return pc; };
      const evalTrack = (sig, out) => {
        let e = track[track.length - 1];
        for (let i = 0; i < track.length; i++) if (sig < track[i].end) { e = track[i]; break; }
        const loc = (sig - e.start) / e.ds, i = Math.min(e.n - 2, Math.max(0, Math.floor(loc))), f = loc - i, p = e.p, j = i * 3;
        out.set(p[j] + (p[j + 3] - p[j]) * f, p[j + 1] + (p[j + 4] - p[j + 1]) * f, p[j + 2] + (p[j + 5] - p[j + 2]) * f);
      };
      const tmp = new V3(), tmp2 = new V3();
      const laySpine = (sh, k, t) => {
        for (let i = 0; i < NS; i++) evalTrack(sh + s * xs[i], spC[i]);
        for (let i = 0; i < NS; i++) spT[i].subVectors(spC[Math.min(i + 1, NS - 1)], spC[Math.max(i - 1, 0)]).normalize();
        for (let i = 0; i < NS; i++) {
          const ip = Math.min(i + 1, NS - 1), im = Math.max(i - 1, 0);
          tmp.subVectors(spT[ip], spT[im]).multiplyScalar(D.bank / ((ip - im) * s * dx)); tmp.y += 1; tmp.normalize();   // 自然朝上，轉彎時往內側傾
          tmp.addScaledVector(spT[i], -tmp.dot(spT[i])).normalize(); spU[i].copy(tmp);
        }
        if (k > 0) for (let i = 0; i < NS; i++) spC[i].addScaledVector(tmp2.crossVectors(spT[i], spU[i]), s * D.wig * wg[i] * Math.sin(4.2 * t - 1.6 * xs[i]) * k);   // 游泳時身體左右擺
      };

      /* ----- 狀態：idle（停在下潛圈的最低點）／swim（起游、繞圈）／return（轉進下潛圈、游向停的位置） ----- */
      const rand = rng(20261116);
      let want = false, state = 'idle', sh = 0, sh0 = 0, sFinal = 0, dipAt = 0, k = 0, aT = 0, t = 0, flow = 0, lapI = 0, rest = false;
      const nextLap = () => { lapI = (lapI + 1 + Math.floor(rand() * (D.laps.length - 1))) % D.laps.length; return mk(D.laps[lapI]); };
      const extend = () => {
        while (track[track.length - 1].end < sh + s * D.xmax + .5) {
          if (!want && state === 'swim') { dipAt = push(mk(D.dip)).start; sFinal = dipAt + D.stop; state = 'return'; }   // 要停下來：這一圈游完就轉進下潛圈
          else push(nextLap());
        }
        while (track.length > 1 && track[0].end < sh + s * D.xmin - .5) track.shift();
      };
      sh = sh0 = sFinal = push(mk(D.dip)).start + D.stop; laySpine(sh, 0, 0);

      const tick = (dt) => {
        dt = Math.min(Math.max(dt, 0), .1);
        // 氣泡跟著魚：魚還沒完全停好之前照常飄，停好之後在約 1 秒內慢下來；重新起游時約 1 秒內恢復
        flow = Math.min(1, Math.max(0, flow + (want || state !== 'idle' || aT > 0 ? dt : -dt)));
        if (rest && !want) return;
        rest = false;
        let a = 0;
        if (state === 'idle') {
          if (want) {                                 // 起游前：鰭先開始擺
            aT = Math.min(D.aidle, aT + dt * D.aidle / .9);
            if (aT >= D.aidle) { sh0 = sh; state = 'swim'; }
          } else if (aT > 0) aT = Math.max(0, aT - dt * D.aidle / 1.6);     // 到位後：擺動慢慢停下來
          else rest = true;                                                 // 完全靜止，之後的 tick 什麼都不做
          k = 0; a = aT;
        }
        if (state === 'return' && want && sh + s * D.xmax + .05 < dipAt) {  // 還沒游進下潛圈就又被叫去游：取消，繼續繞圈
          while (track[track.length - 1].start >= dipAt) track.pop();
          state = 'swim'; extend();
        }
        if (state === 'swim') {
          sh += D.speed * (.1 + .9 * sm((sh - sh0) / D.d2)) * (want ? 1 : 1.35) * dt; extend();
          k = sm((sh - sh0) / D.d1); a = D.aidle + (1 - D.aidle) * k;
        } else if (state === 'return') {
          sh = Math.min(sFinal, sh + D.speed * (.07 + .93 * sm((sFinal - sh) / D.d2r)) * dt); extend();
          if (sFinal - sh < 2e-3) { sh = sFinal; state = 'idle'; aT = D.aidle; k = 0; }   // 到位：之後由 idle 接手（擺動慢慢停；若這時又要游就直接起游）
          else k = sm((sFinal - sh) / D.d1r);
          a = D.aidle + (1 - D.aidle) * k;
        }
        if (a > 0) t += dt;
        laySpine(sh, k, t);
        uA.value.set(s, k, t, a);
      };
      return { tick, setMotion: (on) => { want = !!on; }, motion: () => want, flow: () => sm(flow), state: () => state };
    };
    return { dress };
  }

  /* ---------- 氣泡 ---------- */
  const LEVEL = 2.55, COUNT = 150;
  const inside = (x, y, z, pad) => {
    const r = Math.hypot(x, z), R = 2.98 - pad;
    if (y < LEVEL + pad) return false;
    if (y <= 3.8) return r < R;
    const k = (y - 3.8) / (2.8 - pad); return k < 1 && r < R * Math.sqrt(1 - k * k);
  };
  function makeBubbles() {
    const THREE = T(), rand = rng(20240607), list = [];
    const spawn = (b, anywhere) => {
      for (let i = 0; i < 40; i++) {
        const x = (rand() * 2 - 1) * 2.9, z = (rand() * 2 - 1) * 2.9, y = anywhere ? LEVEL + rand() * 4 : LEVEL + .1 + rand() * .5;
        if (inside(x, y, z, .12)) { b.x = x; b.y = y; b.z = z; return; }
      }
      b.x = 0; b.y = LEVEL + .3; b.z = 0;
    };
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vN; varying vec3 vP;
        void main(){ vec4 mv = modelViewMatrix * instanceMatrix * vec4(position,1.0); vP = mv.xyz; vN = normalMatrix * mat3(instanceMatrix) * normal; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vP;
        void main(){
          vec3 n = normalize(vN); vec3 v = normalize(-vP); float ndv = clamp(dot(n,v),0.0,1.0);
          float rim = pow(1.0-ndv,1.6); float spec = pow(max(dot(n, normalize(vec3(-0.45,0.6,0.66))),0.0),18.0);
          vec3 col = mix(vec3(1.0,0.93,0.70), vec3(0.80,0.54,0.10), rim*0.9); col = mix(col, vec3(1.0), spec);
          gl_FragColor = vec4(col, clamp(0.16 + rim*0.78 + spec*0.9, 0.0, 1.0));
          #include <colorspace_fragment>
        }` });
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 9), mat, COUNT);
    mesh.renderOrder = 5.5; mesh.frustumCulled = false;
    for (let i = 0; i < COUNT; i++) {
      const b = {}; spawn(b, true);
      const big = rand() < .12; b.r = big ? .05 + rand() * .03 : .02 + rand() * .026;
      b.speed = .03 + b.r * 2.2 + rand() * .05; b.phase = rand() * Math.PI * 2; b.wob = .02 + rand() * .05; list.push(b);
    }
    const d = new THREE.Object3D();
    const update = (dt, t) => {
      for (let i = 0; i < COUNT; i++) {
        const b = list[i]; b.y += b.speed * dt; if (!inside(b.x, b.y, b.z, .08)) spawn(b, false);
        d.position.set(b.x + Math.sin(t * .9 + b.phase) * b.wob, b.y, b.z + Math.cos(t * .7 + b.phase * 1.3) * b.wob);
        d.scale.setScalar(b.r); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    update(0, 0);
    return { mesh, update };
  }

  /* ---------- 組合 ---------- */
  const HEIGHT = 12.2;
  function build(buf) {
    const THREE = T();
    const model = parseGlb(buf);
    const glass = model.getObjectByName('Glass'), liquid = model.getObjectByName('Liquid'), fish = model.getObjectByName('Fish');
    if (!glass || !liquid || !fish) throw new Error('模型缺少 Glass / Liquid / Fish');
    const twin = (m, mat, order) => { const b = new THREE.Mesh(m.geometry, mat); b.position.copy(m.position); b.quaternion.copy(m.quaternion); b.scale.copy(m.scale); b.renderOrder = order; m.parent.add(b); return b; };
    // 繪製順序：玻璃背面 → 液體背面 → 魚鰭 → 液體正面 → 氣泡 → 玻璃正面
    glass.material = glassMat(THREE.FrontSide, 1); glass.renderOrder = 6;
    twin(glass, glassMat(THREE.BackSide, .6), 1);
    liquid.material = liquidMat(THREE.FrontSide, 0xf3dc8a, 0xd9a92e, .11, .74, .14); liquid.renderOrder = 5;
    twin(liquid, liquidMat(THREE.BackSide, 0xf6e29a, 0xe6bf48, .26, .62, 0), 2);
    const swim = fishKit(THREE).dress(fish);
    const bub = makeBubbles(); model.add(bub.mesh);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.userData.noInk = true; } });
    // root 的原點放在杯子正中央，方便拿起來時繞中心翻轉
    model.position.y = -HEIGHT / 2;
    const root = new THREE.Group(); root.name = 'GoldfishGlass'; root.add(model);
    // 氣泡跟著魚的狀態：靜態時不上浮也不晃動，切換時約 1 秒內緩和地加速／減速
    let tb = 0;
    const tick = (dt) => { swim.tick(dt); const f = swim.flow(); if (f > 0) { const d = Math.min(Math.max(dt, 0), .1) * f; tb += d; bub.update(d, tb); } };
    return { root, tick, height: HEIGHT, meshes: (() => { const a = []; model.traverse((o) => { if (o.isMesh) a.push(o); }); return a; })(),
      setMotion: (on) => swim.setMotion(on), get motion() { return swim.motion(); } };
  }

  window.GoldfishGlass = {
    load: (url) => fetch(url).then((r) => { if (!r.ok) throw new Error('模型下載失敗 ' + r.status); return r.arrayBuffer(); }).then(build),
    build,
  };
})();
