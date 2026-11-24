/* 「自由」（數位創作，房主大一的作品）：走進那只玻璃瓶。女孩已經離開了，留下她的病房：
 * 病床、點滴架、她站過的椅子、開著的窗（窗外是夜裡的月亮）、天花板上打開的空鳥籠。瓶口外，暖光直接透進來（看不到燈）。
 * 畫面貼近原作的拼貼質感：灰灰暗暗，瓶壁的玻璃帶著暗邊與反光；整個空間唯一的暖色，是瓶口照進來的光。
 * 聲音（全部即時合成，帶著玻璃瓶裡的回音）：空房間的底噪、很久才一滴的點滴、空鳥籠輕輕的吱呀、窗外很遠的風、
 * 偶爾一聲很淡的鳥鳴（從瓶口那邊）；走向瓶口，聲音慢慢變暖、變近。走進那道光，就回到房間。
 * 介面和 SpotlightSpace 相同：init(THREE)、enter({THREE, ac, out})、tick(dt, input)、render(renderer, camera, pose, input)、exit()、dispose()。 */
(function () {
  const W = 2.5, D = 1.8, CEIL = 3.2;                 // 瓶子裡：寬 5 公尺、深 3.6 公尺、高 3.2 公尺（x −2.5…2.5，z −1.8…1.8）
  const NECK = { y: 2.0, z: 0.0, r: 0.55 };           // 瓶口在右邊的瓶壁上
  const EXIT = { x: 2.02, z: -0.12, r: 0.42 };        // 瓶口照進來的光，落在地上的那一塊：走進去就離開
  const BASE = (document.currentScript && document.currentScript.src.replace(/[^/]*$/, '')) || 'spaces/';
  const S = { on: false, x: -0.8, z: 1.25, t: 0 };
  let THREE, scene, mats = [], geos = [], texs = [], grain, warmGlow, dustMat, beamMat;
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp = (a, b, k) => a + (b - a) * k;
  const solids = [];   // 走路時繞開的東西：[x0, x1, z0, z1]

  const keepM = (m) => (mats.push(m), m);
  const keepG = (g) => (geos.push(g), g);
  function canvasTex(w, h, draw, srgb = true) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; texs.push(t); return t;
  }
  // 灰灰的牆面／地面：細細的紙紋與斑駁的汙痕（拼貼的照片質感）
  const grungeTex = (base, seed, n = 512) => canvasTex(n, n, (g, w, h) => {
    let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) { const x = r() * w, y = r() * h, rr = 40 + r() * 140, gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.04 + r() * 0.05})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = (r() - 0.5) * 18; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
    g.putImageData(img, 0, 0);
  });
  const std = (o) => keepM(new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.9, metalness: 0 }, o)));
  function mesh(geo, m, x, y, z, parent, o = {}) {
    const k = new THREE.Mesh(keepG(geo), m); k.position.set(x, y, z);
    if (o.rx) k.rotation.x = o.rx; if (o.ry) k.rotation.y = o.ry; if (o.rz) k.rotation.z = o.rz;
    k.castShadow = o.cast !== false; k.receiveShadow = true; (parent || scene).add(k); return k;
  }
  const box = (w, h, d, m, x, y, z, p, o) => mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, p, o);
  const cyl = (rt, rb, h, m, x, y, z, p, o) => mesh(new THREE.CylinderGeometry(rt, rb, h, o && o.seg || 14), m, x, y, z, p, o);

  let UP;
  function rod(a, b, r, m, p, o) {   // 兩點之間的一根圓管
    UP = UP || new THREE.Vector3(0, 1, 0); const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), L = d.length();
    const k = mesh(new THREE.CylinderGeometry(r, r, L, 10), m, (A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2, p, o); k.quaternion.setFromUnitVectors(UP, d.normalize()); return k;
  }
  const bend = (pts, r, m, p, o) => mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q)), false, 'catmullrom', 0.2), pts.length * 12, r, 8, false), m, 0, 0, 0, p, o);   // 彎的細管
  function slab(w, d, h, r) {   // 圓角的厚板（床墊、毯子、櫃面）
    const b = Math.min(r, h / 2) * 0.8, x = w / 2 - b, z = d / 2 - b, c = Math.max(0.001, r - b), sh = new THREE.Shape();
    sh.moveTo(-x + c, -z); sh.lineTo(x - c, -z); sh.quadraticCurveTo(x, -z, x, -z + c); sh.lineTo(x, z - c); sh.quadraticCurveTo(x, z, x - c, z);
    sh.lineTo(-x + c, z); sh.quadraticCurveTo(-x, z, -x, z - c); sh.lineTo(-x, -z + c); sh.quadraticCurveTo(-x, -z, -x + c, -z);
    const g = new THREE.ExtrudeGeometry(sh, { depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 4, curveSegments: 6 });
    g.rotateX(-Math.PI / 2); g.translate(0, -(h - 2 * b) / 2, 0); return g;
  }
  const lathe = (pts, seg = 32) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  /* ---------- 空間 ---------- */
  function init(T) {
    if (scene) return;
    THREE = T; scene = new THREE.Scene(); scene.background = new THREE.Color(0x2b2a29);
    scene.fog = new THREE.Fog(0x2b2a29, 6, 22);
    // 光：灰灰的、像攝影棚左上方來的柔光；窗外的月光一點點藍；瓶口外透進來的暖光（唯一的暖色，投下影子）
    scene.add(new THREE.HemisphereLight(0x9a9893, 0x2a2826, 0.9));
    const key = new THREE.DirectionalLight(0xc9c6c0, 0.55); key.position.set(-3, 5, 4); scene.add(key);
    const moon = new THREE.PointLight(0x7f93c4, 0.9, 4.5, 2); moon.position.set(0.1, 1.7, -1.55); scene.add(moon);
    const warm = new THREE.SpotLight(0xffd58a, 26, 9, 0.42, 0.75, 1.6); warm.position.set(3.6, 2.45, -0.1); warm.target.position.set(EXIT.x - 0.35, 0, EXIT.z);
    warm.castShadow = true; warm.shadow.mapSize.set(1024, 1024); warm.shadow.bias = -0.0008; scene.add(warm, warm.target);
    const lampLight = new THREE.PointLight(0xffcf7a, 6, 7, 2); lampLight.position.set(4.6, 1.95, 0); scene.add(lampLight);

    // 瓶外：灰色的攝影棚背景（遠遠的、上暗下亮），瓶子放在灰色的桌面上
    const studio = canvasTex(64, 512, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#1c1b1a'); gr.addColorStop(0.55, '#5a5856'); gr.addColorStop(0.75, '#6d6b68'); gr.addColorStop(1, '#3d3c3a'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
    mesh(new THREE.SphereGeometry(16, 48, 24), keepM(new THREE.MeshBasicMaterial({ map: studio, side: THREE.BackSide, fog: false })), 0, 2, 0, scene, { cast: false });
    const table = mesh(new THREE.PlaneGeometry(40, 40), std({ color: 0x5c5a57, map: grungeTex('#8a8784', 7, 256) }), 0, -0.02, 0, scene, { rx: -Math.PI / 2, cast: false });
    table.material.map.wrapS = table.material.map.wrapT = THREE.RepeatWrapping; table.material.map.repeat.set(8, 8);

    // 瓶子裡：地板、後牆（女孩房間的牆，開著窗）
    const floorTex = grungeTex('#7b7874', 11); floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(2.5, 1.8);
    mesh(new THREE.PlaneGeometry(W * 2, D * 2), std({ map: floorTex, roughness: 0.85 }), 0, 0.001, 0, scene, { rx: -Math.PI / 2, cast: false });
    const wallTex = grungeTex('#8c8985', 23); wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping; wallTex.repeat.set(2, 1.3);
    const wallM = std({ map: wallTex });
    const WX0 = -0.45, WX1 = 0.55, WY0 = 1.25, WY1 = 2.15;   // 窗洞
    box(W - (-WX0) + 0.02, CEIL, 0.12, wallM, (-W + WX0) / 2, CEIL / 2, -D - 0.06);
    box(W - WX1 + 0.02, CEIL, 0.12, wallM, (W + WX1) / 2, CEIL / 2, -D - 0.06);
    box(WX1 - WX0, WY0, 0.12, wallM, (WX0 + WX1) / 2, WY0 / 2, -D - 0.06);
    box(WX1 - WX0, CEIL - WY1, 0.12, wallM, (WX0 + WX1) / 2, (CEIL + WY1) / 2, -D - 0.06);
    // 窗外：原作裡那片夜空和月亮
    const night = new THREE.TextureLoader().load(BASE + 'freedom/night.jpg'); night.colorSpace = THREE.SRGBColorSpace; texs.push(night);
    mesh(new THREE.PlaneGeometry(1.6, 1.5), keepM(new THREE.MeshBasicMaterial({ map: night, fog: false })), (WX0 + WX1) / 2, (WY0 + WY1) / 2 + 0.05, -D - 0.7, scene, { cast: false });
    // 窗框與兩扇往外打開的格子窗
    const frameM = std({ color: 0x3a3836, roughness: 0.7 });
    for (const [w, h, x, y] of [[WX1 - WX0 + 0.08, 0.05, (WX0 + WX1) / 2, WY0], [WX1 - WX0 + 0.08, 0.05, (WX0 + WX1) / 2, WY1], [0.05, WY1 - WY0, WX0, (WY0 + WY1) / 2], [0.05, WY1 - WY0, WX1, (WY0 + WY1) / 2]])
      box(w, h, 0.06, frameM, x, y, -D + 0.01);
    for (const side of [-1, 1]) {
      const pane = new THREE.Group(); pane.position.set(side < 0 ? WX0 : WX1, (WY0 + WY1) / 2, -D + 0.02); pane.rotation.y = side * -1.25; scene.add(pane);
      const pw = (WX1 - WX0) / 2, ph = WY1 - WY0;
      for (const [w, h, x, y] of [[pw, 0.035, side * pw / 2, ph / 2], [pw, 0.035, side * pw / 2, -ph / 2], [0.035, ph, side * pw, 0], [0.035, ph, 0, 0], [pw, 0.02, side * pw / 2, 0], [0.02, ph, side * pw / 2, 0], [pw, 0.02, side * pw / 2, ph / 4], [pw, 0.02, side * pw / 2, -ph / 4]])
        box(w, h, 0.03, frameM, x, y, 0, pane);
    }

    // 病床（左後方，沿著後牆，床頭靠左邊瓶壁）：圓管床架、四個輪子、床頭微微搖起、圓角床墊、掀開的床單、
    // 床尾摺著的毯子、靠牆那側的護欄立著、靠房間這側的護欄放下來（她從這邊下床）
    const metal = std({ color: 0x8e8c89, roughness: 0.4, metalness: 0.6 }), sheet = std({ color: 0xb7b4ae, roughness: 0.95 });
    const dark = std({ color: 0x2a2826, roughness: 0.7 }), panelM = std({ color: 0xa29e97, roughness: 0.65 });
    const bed = new THREE.Group(); bed.position.set(-1.5, 0, -1.15); scene.add(bed);
    for (const sx of [-0.84, 0.84]) for (const sz of [-0.36, 0.36]) {
      cyl(0.045, 0.045, 0.03, dark, sx, 0.045, sz, bed, { rx: Math.PI / 2, seg: 18 });   // 輪子
      box(0.02, 0.06, 0.05, metal, sx, 0.085, sz, bed); rod([sx, 0.11, sz], [sx, 0.42, sz], 0.018, metal, bed);
    }
    for (const sz of [-0.42, 0.42]) box(1.9, 0.05, 0.035, metal, 0, 0.42, sz, bed);
    for (const sx of [-0.88, -0.28, 0.32, 0.88]) box(0.035, 0.035, 0.84, metal, sx, 0.41, 0, bed);
    rod([-0.84, 0.2, 0], [0.84, 0.2, 0], 0.014, metal, bed); for (const sx of [-0.84, 0.84]) rod([sx, 0.2, -0.36], [sx, 0.2, 0.36], 0.012, metal, bed);
    const headSec = new THREE.Group(); headSec.position.set(-0.27, 0.465, 0); headSec.rotation.z = -0.26; bed.add(headSec);   // 床頭那一段搖起來
    box(0.68, 0.02, 0.8, metal, -0.34, -0.005, 0, headSec);
    mesh(slab(0.68, 0.84, 0.13, 0.05), sheet, -0.34, 0.065, 0, headSec);
    { const PW = 0.4, PD = 0.6, pg = new THREE.BoxGeometry(PW, 0.12, PD, 12, 4, 16), pp = pg.attributes.position;   // 枕頭：醫院那種長方形的枕頭，中間鼓、四邊壓扁收成一條縫
      for (let i = 0; i < pp.count; i++) { const u = pp.getX(i) / (PW / 2), w = pp.getZ(i) / (PD / 2), e = Math.max(0, (1 - Math.pow(Math.abs(u), 3)) * (1 - Math.pow(Math.abs(w), 3)));
        pp.setY(i, pp.getY(i) * (0.12 + 0.88 * Math.pow(e, 0.55)) + (pp.getY(i) > 0 ? Math.sin(u * 5 + w * 3) * 0.004 : 0));
        pp.setX(i, pp.getX(i) * (1 - 0.04 * w * w)); pp.setZ(i, pp.getZ(i) * (1 - 0.03 * u * u)); }
      pg.computeVertexNormals(); const pillow = mesh(pg, sheet, -0.42, 0.13, 0.02, headSec); pillow.rotation.set(0, 0.06, -0.05); }
    mesh(slab(1.24, 0.84, 0.13, 0.05), sheet, 0.35, 0.535, 0, bed);
    const crumple = new THREE.BoxGeometry(0.95, 0.05, 0.9, 16, 2, 12), cp = crumple.attributes.position;   // 掀開過、皺起來的床單
    for (let i = 0; i < cp.count; i++) { const x = cp.getX(i), z = cp.getZ(i); let y = cp.getY(i) + Math.sin(x * 9) * 0.02 + Math.cos(z * 11 + x * 3) * 0.016 + Math.max(0, x + 0.25) * 0.08 * (0.6 + 0.4 * Math.sin(z * 4));
      if (Math.abs(z) > 0.42) y -= (Math.abs(z) - 0.42) * 2.2; cp.setY(i, y); }
    crumple.computeVertexNormals(); mesh(crumple, sheet, 0.12, 0.625, 0.01, bed);
    mesh(slab(0.3, 0.86, 0.08, 0.035), std({ color: 0x7a7772, roughness: 0.95 }), 0.8, 0.64, 0, bed);   // 床尾摺好的毯子
    for (const [hx, top] of [[-0.99, 1.08], [0.99, 0.86]]) {   // 床頭板、床尾板：圓管框加一片板
      for (const sz of [-0.44, 0.44]) { rod([hx, 0.4, sz], [hx, top, sz], 0.022, metal, bed); mesh(new THREE.SphereGeometry(0.028, 12, 8), metal, hx, top, sz, bed); }
      rod([hx, top - 0.04, -0.44], [hx, top - 0.04, 0.44], 0.016, metal, bed); rod([hx, 0.47, -0.44], [hx, 0.47, 0.44], 0.014, metal, bed);
      box(0.022, top - 0.6, 0.8, panelM, hx, (top + 0.5) / 2, 0, bed);
    }
    rod([1.0, 0.3, 0.22], [1.09, 0.3, 0.22], 0.008, metal, bed); rod([1.09, 0.3, 0.22], [1.09, 0.22, 0.22], 0.008, metal, bed); cyl(0.012, 0.012, 0.05, dark, 1.11, 0.22, 0.22, bed, { rz: Math.PI / 2 });   // 床尾搖桿
    for (const [sz, y0] of [[-0.47, 0.7], [0.47, 0.43]]) {   // 護欄：靠牆的立著、靠房間這側的放下來
      bend([[-0.82, y0, sz], [-0.86, y0 + 0.08, sz], [-0.82, y0 + 0.16, sz], [-0.05, y0 + 0.16, sz], [0.0, y0 + 0.08, sz], [-0.05, y0, sz], [-0.82, y0, sz]], 0.011, metal, bed);
      for (const sx of [-0.62, -0.43, -0.24]) rod([sx, y0, sz], [sx, y0 + 0.16, sz], 0.007, metal, bed);
      for (const sx of [-0.7, -0.15]) rod([sx, y0, sz], [sx, sz < 0 ? 0.44 : 0.42, sz * 0.93], 0.009, metal, bed);
    }
    solids.push([-2.55, -0.45, -1.65, -0.6]);

    // 床頭的抽屜櫃：兩層抽屜、下面一扇小門；上面放著一個水壺和一杯水
    const cab = new THREE.Group(); cab.position.set(-2.2, 0, -0.38); cab.rotation.y = Math.PI / 2; scene.add(cab);   // 逆時針轉 90 度：抽屜朝床尾方向
    const cabM = std({ color: 0xa39f98, roughness: 0.7 }), cabF = std({ color: 0xb3afa8, roughness: 0.6 });
    box(0.4, 0.05, 0.36, dark, 0, 0.025, 0, cab); box(0.44, 0.65, 0.4, cabM, 0, 0.375, 0, cab);
    mesh(slab(0.47, 0.43, 0.03, 0.02), cabF, 0, 0.715, 0.005, cab);
    {   // 上層抽屜：可以拉出來，裡面有一封用西式信封裝著的信
      const dr = new THREE.Group(); dr.position.set(0, 0.6, 0); cab.add(dr); S.drawer = dr; S.drawerK = 0; S.drawerOpen = false;
      const front = box(0.4, 0.13, 0.014, cabF, 0, 0, 0.205, dr);
      box(0.13, 0.012, 0.012, metal, 0, 0.01, 0.228, dr); for (const hx of [-0.055, 0.055]) box(0.01, 0.01, 0.02, metal, hx, 0.01, 0.218, dr);
      const inner = std({ color: 0x8d8981, roughness: 0.85 });
      box(0.37, 0.008, 0.36, inner, 0, -0.05, 0.02, dr); box(0.008, 0.1, 0.36, inner, -0.181, -0.005, 0.02, dr); box(0.008, 0.1, 0.36, inner, 0.181, -0.005, 0.02, dr); box(0.37, 0.1, 0.008, inner, 0, -0.005, -0.156, dr);
      const envTex = canvasTex(512, 352, (g, w, h) => {   // 信封：米白色的紙、背面三角形的封口、一點點紙紋
        g.fillStyle = '#e9e1d0'; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '120,100,70' : '255,255,255'},${Math.random() * 0.06})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
        g.strokeStyle = 'rgba(120,104,80,.45)'; g.lineWidth = 3; g.beginPath(); g.moveTo(6, 6); g.lineTo(w / 2, h * 0.58); g.lineTo(w - 6, 6); g.stroke();
        g.strokeStyle = 'rgba(120,104,80,.25)'; g.lineWidth = 2; g.beginPath(); g.moveTo(6, h - 6); g.lineTo(w * 0.42, h * 0.5); g.moveTo(w - 6, h - 6); g.lineTo(w * 0.58, h * 0.5); g.stroke();
        g.fillStyle = '#8a3b33'; g.beginPath(); g.arc(w / 2, h * 0.56, 22, 0, Math.PI * 2); g.fill();   // 小小的封蠟
        g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(w / 2 - 6, h * 0.56 - 6, 9, 0, Math.PI * 2); g.fill();
      });
      const env = mesh(new THREE.BoxGeometry(0.22, 0.004, 0.15), [std({ color: 0xe9e1d0 }), std({ color: 0xe9e1d0 }), std({ map: envTex, roughness: 0.9 }), std({ color: 0xe2dac8 }), std({ color: 0xe9e1d0 }), std({ color: 0xe9e1d0 })], 0.01, -0.043, 0.03, dr);
      env.rotation.y = 0.18; S.pickFront = front; S.pickEnv = env;
    }
    for (const [y, h] of [[0.455, 0.13]]) {
      box(0.4, h, 0.014, cabF, 0, y, 0.205, cab);
      box(0.13, 0.012, 0.012, metal, 0, y + 0.01, 0.228, cab); for (const hx of [-0.055, 0.055]) box(0.01, 0.01, 0.02, metal, hx, y + 0.01, 0.218, cab);
    }
    box(0.4, 0.31, 0.014, cabF, 0, 0.215, 0.205, cab); mesh(new THREE.SphereGeometry(0.012, 10, 8), metal, 0.15, 0.3, 0.222, cab);
    const glassM = keepM(new THREE.MeshStandardMaterial({ color: 0xdfe5e3, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }));
    const waterM = keepM(new THREE.MeshStandardMaterial({ color: 0xb4c3c6, roughness: 0.05, transparent: true, opacity: 0.45, depthWrite: false }));
    const pit = new THREE.Group(); pit.position.set(-0.07, 0.73, -0.06); pit.rotation.y = 0.6; cab.add(pit);   // 水壺
    mesh(lathe([[0, 0.002], [0.056, 0.002], [0.061, 0.012], [0.063, 0.08], [0.057, 0.15], [0.046, 0.19], [0.049, 0.208], [0.055, 0.216]]), glassM, 0, 0, 0, pit, { cast: false });
    mesh(new THREE.CylinderGeometry(0.058, 0.056, 0.11, 28), waterM, 0, 0.06, 0, pit, { cast: false });
    bend([[-0.05, 0.18, 0], [-0.09, 0.17, 0], [-0.1, 0.11, 0], [-0.085, 0.06, 0], [-0.06, 0.045, 0]], 0.008, glassM, pit, { cast: false });
    mesh(new THREE.ConeGeometry(0.018, 0.03, 12, 1, true), glassM, 0.058, 0.215, 0, pit, { rz: -1.25, cast: false });   // 壺嘴
    const cup = new THREE.Group(); cup.position.set(0.12, 0.73, 0.08); cab.add(cup);   // 一杯水
    mesh(lathe([[0, 0.002], [0.03, 0.002], [0.032, 0.006], [0.037, 0.105]]), glassM, 0, 0, 0, cup, { cast: false });
    mesh(new THREE.CylinderGeometry(0.0335, 0.031, 0.068, 24), waterM, 0, 0.04, 0, cup, { cast: false });
    solids.push([-2.45, -1.95, -0.6, -0.15]);
    cyl(0.15, 0.13, 0.36, std({ color: 0x55524e }), -0.2, 0.18, -1.55);   // 小桶移到床尾、窗下
    solids.push([-0.38, -0.02, -1.73, -1.37]);

    // 點滴架：五腳輪座、兩段的不鏽鋼桿（中間有調高度的旋鈕）、上面四支彎鉤；掛著一袋點滴、滴管、調節夾，管子垂下來沒有接著誰
    const iv = new THREE.Group(); iv.position.set(0.95, 0, -0.35); scene.add(iv);
    const ivM = std({ color: 0xbdbbb7, roughness: 0.25, metalness: 0.8 });
    cyl(0.035, 0.045, 0.06, ivM, 0, 0.11, 0, iv, { seg: 20 });
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 + 0.3, c = Math.cos(a), sn = Math.sin(a);
      rod([c * 0.03, 0.1, sn * 0.03], [c * 0.27, 0.075, sn * 0.27], 0.011, ivM, iv);
      cyl(0.012, 0.012, 0.03, dark, c * 0.27, 0.06, sn * 0.27, iv);
      box(0.012, 0.035, 0.03, dark, c * 0.27 + 0.012, 0.035, sn * 0.27, iv);
      cyl(0.022, 0.022, 0.016, dark, c * 0.27 + 0.022, 0.022, sn * 0.27, iv, { rx: Math.PI / 2, seg: 16 });   // 輪子著地
    }
    rod([0, 0.13, 0], [0, 1.16, 0], 0.014, ivM, iv); cyl(0.021, 0.021, 0.045, ivM, 0, 1.16, 0, iv, { seg: 18 });
    rod([0.02, 1.16, 0], [0.05, 1.16, 0], 0.004, ivM, iv); mesh(new THREE.SphereGeometry(0.013, 12, 8), dark, 0.055, 1.16, 0, iv);   // 調高度的旋鈕
    rod([0, 1.16, 0], [0, 1.9, 0], 0.0095, ivM, iv); cyl(0.018, 0.018, 0.03, ivM, 0, 1.89, 0, iv, { seg: 16 });
    mesh(new THREE.SphereGeometry(0.012, 10, 8), ivM, 0, 1.915, 0, iv);
    for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      bend([[c * 0.015, 1.89, sn * 0.015], [c * 0.08, 1.895, sn * 0.08], [c * 0.13, 1.905, sn * 0.13], [c * 0.15, 1.93, sn * 0.15], [c * 0.145, 1.955, sn * 0.145]], 0.0045, ivM, iv);
      mesh(new THREE.SphereGeometry(0.007, 8, 6), ivM, c * 0.145, 1.957, sn * 0.145, iv); }
    const bagM = keepM(new THREE.MeshStandardMaterial({ color: 0xdfe3e0, roughness: 0.2, transparent: true, opacity: 0.55, depthWrite: false }));
    const tubeM = keepM(new THREE.MeshStandardMaterial({ color: 0xd6d9d6, roughness: 0.3, transparent: true, opacity: 0.6 }));
    mesh(new THREE.TorusGeometry(0.01, 0.003, 6, 16), tubeM, 0.15, 1.9, 0, iv);   // 掛在鉤上的小孔
    { const pouch = (w, h, t, top) => { const g = new THREE.BoxGeometry(w, h, t, 10, 18, 2), q = g.attributes.position;   // 點滴袋：扁扁的長方形軟袋，四邊是壓平的封邊，中間微微鼓起
        for (let k = 0; k < q.count; k++) { const u = q.getX(k) / (w / 2), v = q.getY(k) / (h / 2), e = Math.max(0, (1 - Math.pow(Math.abs(u), 6)) * (1 - Math.pow(Math.abs(v), 6)));
          q.setZ(k, q.getZ(k) * (0.06 + 0.94 * Math.pow(e, 0.5)) * (1 + 0.25 * (1 - (v + 1) / 2))); if (top !== undefined && q.getY(k) > top) q.setY(k, top); }
        g.computeVertexNormals(); return g; };
      mesh(pouch(0.12, 0.2, 0.026), bagM, 0.15, 1.785, 0, iv, { cast: false });
      mesh(pouch(0.104, 0.18, 0.02, -0.02), keepM(new THREE.MeshStandardMaterial({ color: 0xc8d2d2, roughness: 0.1, transparent: true, opacity: 0.5, depthWrite: false })), 0.15, 1.785, 0, iv, { cast: false });   // 袋裡剩下的藥水（下半袋）
      box(0.07, 0.008, 0.003, bagM, 0.15, 1.889, 0, iv, { cast: false });   // 上面掛的那一段封邊
      box(0.07, 0.06, 0.001, std({ color: 0xe8e6e1 }), 0.15, 1.8, 0.0135, iv, { cast: false });   // 標籤
      cyl(0.007, 0.007, 0.02, tubeM, 0.135, 1.677, 0, iv); cyl(0.007, 0.007, 0.02, tubeM, 0.165, 1.677, 0, iv); }   // 底下兩個接口
    cyl(0.006, 0.006, 0.03, tubeM, 0.15, 1.663, 0, iv); cyl(0.011, 0.009, 0.06, bagM, 0.15, 1.62, 0, iv, { cast: false });   // 滴管
    const tubePts = [[0.15, 1.59, 0], [0.165, 1.25, 0.03], [0.14, 0.8, 0.07], [0.08, 0.45, 0.1], [0.03, 0.32, 0.08], [0.02, 0.4, 0.05]];
    bend(tubePts, 0.0035, tubeM, iv, { cast: false });
    box(0.018, 0.05, 0.014, std({ color: 0x9fa3a3, roughness: 0.4 }), 0.162, 1.3, 0.027, iv);   // 調節夾
    solids.push([0.65, 1.25, -0.65, -0.05]);

    // 她站過的椅子：靠著右邊的瓶壁、在瓶口下面，椅面朝著瓶口
    const chairM = std({ color: 0x9b9893, roughness: 0.5, metalness: 0.4 });
    const ch = new THREE.Group(); ch.position.set(1.85, 0, 0.62); ch.rotation.y = -Math.PI / 2 + 0.25; scene.add(ch);
    box(0.42, 0.03, 0.42, chairM, 0, 0.46, 0, ch); box(0.42, 0.38, 0.025, chairM, 0, 0.7, -0.2, ch, { rx: -0.08 });
    for (const sx of [-0.19, 0.19]) for (const sz of [-0.19, 0.19]) cyl(0.012, 0.012, 0.46, chairM, sx, 0.23, sz, ch);
    for (const sx of [-0.19, 0.19]) box(0.02, 0.02, 0.38, chairM, sx, 0.14, 0, ch);
    solids.push([1.55, 2.15, 0.35, 0.9]);

    // 天花板吊著的空鳥籠：水滴形的鐵絲籠，正面開著一個門洞，籠門從門洞邊上的鉸鏈往外打開；籠子中間一根停棲的木棒；一條細鍊子吊上去
    const wire = std({ color: 0x2f2d2b, roughness: 0.6, metalness: 0.5 });
    const cage = new THREE.Group(); cage.position.set(0.25, 2.25, -1.15); scene.add(cage);
    const prof = (t) => { const y = -0.28 + t * 0.62, r = t < 0.62 ? 0.18 * Math.sin(Math.PI * Math.min(1, t / 0.62) * 0.5 + 0.4) : 0.18 * Math.pow(1 - (t - 0.62) / 0.38, 0.9); return [r, y]; };
    const NB = 14, cp3 = (a, t) => { const [r, y] = prof(t); return [Math.cos(a) * r, y, Math.sin(a) * r]; };
    const TB = 0.08, D0 = 0.22, D1 = 0.5, DK = [3, 4], ang = (k) => k / NB * Math.PI * 2;   // 門洞：第 3、4 根鐵絲之間挖掉，上下在兩圈橫環之間（朝前）
    const wirePath = (a, t0, t1) => { const pts = []; for (let i = 0; i <= 16; i++) pts.push(cp3(a, t0 + (t1 - t0) * i / 16)); return pts; };
    for (let k = 0; k < NB; k++) {
      if (DK.includes(k)) { bend(wirePath(ang(k), TB, D0), 0.003, wire, cage); bend(wirePath(ang(k), D1, 1), 0.003, wire, cage); }
      else bend(wirePath(ang(k), TB, 1), 0.003, wire, cage);
    }
    for (const t of [0.08, D0, D1, 0.72]) { const [r, y] = prof(t); mesh(new THREE.TorusGeometry(r, 0.0045, 5, 40), wire, 0, y, 0, cage, { rx: Math.PI / 2 }); }
    { const [br, by] = prof(TB); cyl(br + 0.008, br - 0.004, 0.032, wire, 0, by - 0.014, 0, cage, { seg: 40 });   // 籠底：淺淺的底盤（上下都看得到）
      mesh(new THREE.TorusGeometry(br + 0.008, 0.004, 5, 40), wire, 0, by + 0.002, 0, cage, { rx: Math.PI / 2 }); }
    // 籠門：形狀跟門洞一樣（貼著籠子的弧面），鉸鏈在第 2 根鐵絲，往外打開約 100 度
    const hA = new THREE.Vector3(...cp3(ang(2), D0)), hB = new THREE.Vector3(...cp3(ang(2), D1)), axis = hB.clone().sub(hA).normalize();
    const doorPts = (pts, sgn) => pts.map((q) => new THREE.Vector3(...q).sub(hA).applyAxisAngle(axis, sgn * 1.75).add(hA).toArray());
    const mid = new THREE.Vector3(...cp3(ang(3.5), (D0 + D1) / 2)), rad = (sgn) => { const v = mid.clone().sub(hA).applyAxisAngle(axis, sgn * 1.75).add(hA); return Math.hypot(v.x, v.z); };
    const sg = rad(1) > rad(-1) ? 1 : -1, arc = (t) => { const pts = []; for (let i = 0; i <= 12; i++) pts.push(cp3(ang(2 + 3 * i / 12), t)); return pts; };
    bend(doorPts(arc(D0 + 0.01), sg), 0.0035, wire, cage); bend(doorPts(arc(D1 - 0.01), sg), 0.0035, wire, cage);
    for (const k of [2.15, 3, 4, 4.85]) bend(doorPts(wirePath(ang(k), D0 + 0.01, D1 - 0.01), sg), 0.003, wire, cage);
    for (const t of [D0 + 0.01, D1 - 0.01]) mesh(new THREE.TorusGeometry(0.006, 0.002, 4, 10), wire, ...cp3(ang(2), t), cage);   // 鉸鏈小環
    // 停棲的木棒：橫過籠子中間、跟門洞方向垂直，兩端有小鐵片卡在鐵絲上
    const py = prof(0.3)[1], pr = prof(0.3)[0] - 0.004;
    rod([-pr, py, 0], [pr, py, 0], 0.0065, std({ color: 0x6f5e4c, roughness: 0.85 }), cage);
    for (const sx of [-1, 1]) box(0.006, 0.02, 0.016, wire, sx * (pr - 0.002), py, 0, cage);
    box(0.003, CEIL - 2.25 - 0.34, 0.003, wire, 0.25, (CEIL + 2.25 + 0.34) / 2, -1.15);   // 鍊子

    // 瓶壁：玻璃，帶著暗暗的厚邊和幾道亮白的反光（像原作），看得到外面灰灰的攝影棚
    const glassTex = (w, h, seed, vertical) => canvasTex(512, 512, (g, cw, chh) => {
      let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      g.clearRect(0, 0, cw, chh);
      const edge = (x0, y0, x1, y1) => { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(12,12,12,.78)'); gr.addColorStop(0.5, 'rgba(25,25,25,.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); return gr; };
      const bw = cw * 0.11; g.fillStyle = edge(0, 0, bw, 0); g.fillRect(0, 0, bw, chh); g.fillStyle = edge(cw, 0, cw - bw, 0); g.fillRect(cw - bw, 0, bw, chh);
      g.fillStyle = edge(0, 0, 0, bw); g.fillRect(0, 0, cw, bw); g.fillStyle = edge(0, chh, 0, chh - bw); g.fillRect(0, chh - bw, cw, bw);
      g.fillStyle = 'rgba(40,40,40,.12)'; g.fillRect(0, 0, cw, chh);
      for (let i = 0; i < 3; i++) {   // 反光：細長、淡淡的白、邊緣柔
        const vx = vertical ? r() * cw : 0, vy = vertical ? 0 : r() * chh, len = (0.2 + r() * 0.5) * (vertical ? chh : cw), th = 2 + r() * 7, off = r() * (vertical ? chh : cw) * 0.6;
        g.save(); g.globalAlpha = 0.1 + r() * 0.18; g.filter = 'blur(3px)'; g.fillStyle = '#fff';
        if (vertical) g.fillRect(vx, off, th, len); else g.fillRect(off, vy, len, th); g.restore();
      }
    });
    const glass = (w, h, seed, vertical) => keepM(new THREE.MeshBasicMaterial({ map: glassTex(w, h, seed, vertical), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    mesh(new THREE.PlaneGeometry(W * 2, CEIL), glass(W * 2, CEIL, 3, false), 0, CEIL / 2, D, scene, { cast: false });                       // 前
    mesh(new THREE.PlaneGeometry(D * 2, CEIL), glass(D * 2, CEIL, 5, true), -W, CEIL / 2, 0, scene, { ry: Math.PI / 2, cast: false });      // 左
    mesh(new THREE.PlaneGeometry(W * 2, D * 2), glass(W * 2, D * 2, 9, false), 0, CEIL, 0, scene, { rx: Math.PI / 2, cast: false });        // 上
    // 右邊的瓶壁中間開著瓶口：用一圈一圈的面組成（中間留一個圓洞）
    {
      const sh = new THREE.Shape(); sh.moveTo(-D, 0); sh.lineTo(D, 0); sh.lineTo(D, CEIL); sh.lineTo(-D, CEIL); sh.closePath();
      const hole = new THREE.Path(); hole.absarc(NECK.z, NECK.y, NECK.r, 0, Math.PI * 2, true); sh.holes.push(hole);
      const g = new THREE.ShapeGeometry(sh, 48), uv = g.attributes.uv, p = g.attributes.position;
      for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + D) / (2 * D), p.getY(i) / CEIL);
      mesh(g, glass(D * 2, CEIL, 13, true), W, 0, 0, scene, { ry: -Math.PI / 2, cast: false });
    }
    // 瓶頸：深色的玻璃圓筒往外伸，外圈有螺紋，盡頭是黑色的瓶蓋圈
    const neckM = keepM(new THREE.MeshBasicMaterial({ color: 0x1e1d1c, transparent: true, opacity: 0.72, side: THREE.DoubleSide, fog: false }));   // 深色的玻璃（不受暖光照亮，才不會變成一圈金屬）
    mesh(new THREE.CylinderGeometry(NECK.r, NECK.r, 0.75, 40, 1, true), neckM, W + 0.37, NECK.y, NECK.z, scene, { rz: Math.PI / 2, cast: false });
    for (let i = 0; i < 4; i++) mesh(new THREE.TorusGeometry(NECK.r + 0.03, 0.025, 8, 40), std({ color: 0x1d1c1b, roughness: 0.4, metalness: 0.5 }), W + 0.45 + i * 0.07, NECK.y, NECK.z, scene, { ry: Math.PI / 2, cast: false });
    mesh(new THREE.TorusGeometry(NECK.r + 0.02, 0.07, 10, 40), std({ color: 0x151413, roughness: 0.5, metalness: 0.4 }), W + 0.8, NECK.y, NECK.z, scene, { ry: Math.PI / 2, cast: false });
    // 瓶口外透進來的光：很大很暖的光暈
    const glowTex = canvasTex(256, 256, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(255,236,190,1)'); gr.addColorStop(0.12, 'rgba(255,214,140,.7)'); gr.addColorStop(0.45, 'rgba(255,200,120,.16)'); gr.addColorStop(1, 'rgba(255,200,120,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
    // 瓶口外沒有燈：只是一片暖暖的光，從很遠的地方透進來（一層柔光，不看得到光源）
    const outGlow = mesh(new THREE.PlaneGeometry(4.5, 4.5), keepM(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })), W + 2.6, NECK.y, NECK.z, scene, { ry: -Math.PI / 2, cast: false });
    // 瓶口照進來的光柱：從瓶口斜斜地落到地上，帶一點灰塵
    {
      const from = new THREE.Vector3(W + 0.1, NECK.y, NECK.z), to = new THREE.Vector3(EXIT.x - 0.55, 0.02, EXIT.z), len = from.distanceTo(to);
      const geo = new THREE.CylinderGeometry(NECK.r * 0.85, 0.62, len, 48, 12, true);
      beamMat = keepM(new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 } },
        vertexShader: 'varying vec3 vW; varying vec3 vN; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: `uniform float uT; varying vec3 vW; varying vec3 vN;
          void main(){ vec3 V = normalize(cameraPosition - vW); float f = pow(abs(dot(normalize(vN), V)), 1.7);
            float n = .8 + .2 * sin(vW.x * 3.1 + uT * .2) * sin(vW.y * 2.3 - uT * .15);
            gl_FragColor = vec4(vec3(1., .82, .5) * f * .28 * n, 1.); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }));
      const beam = new THREE.Mesh(keepG(geo), beamMat); beam.position.copy(from).add(to).multiplyScalar(0.5);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize()); scene.add(beam);
      const patchTex = canvasTex(256, 256, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, 'rgba(255,214,150,.75)'); gr.addColorStop(0.55, 'rgba(255,205,135,.4)'); gr.addColorStop(1, 'rgba(255,200,130,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
      const patch = mesh(new THREE.PlaneGeometry(1.7, 1.15), keepM(new THREE.MeshBasicMaterial({ map: patchTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), EXIT.x - 0.3, 0.006, EXIT.z, scene, { rx: -Math.PI / 2, cast: false });
      patch.renderOrder = 2;
      const N = 380, pos = new Float32Array(N * 3), seed = new Float32Array(N), dir = to.clone().sub(from);
      for (let i = 0; i < N; i++) { const t = Math.random(), c = from.clone().addScaledVector(dir, t), rr = lerp(NECK.r * 0.8, 0.6, t) * Math.sqrt(Math.random()), a = Math.random() * 6.283;
        pos.set([c.x + Math.cos(a) * rr * 0.6, c.y + Math.sin(a) * rr * 0.6, c.z + Math.sin(a * 1.7) * rr], i * 3); seed[i] = Math.random(); }
      const dg = keepG(new THREE.BufferGeometry()); dg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); dg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      dustMat = keepM(new THREE.ShaderMaterial({
        uniforms: { uT: { value: 0 }, uPR: { value: 600 } },
        vertexShader: `attribute float seed; uniform float uT, uPR; varying float vB;
          void main(){ vec3 p = position; float s = seed * 6.2831; p.x += sin(uT * .1 + s) * .04; p.y += sin(uT * .08 + s * 3.) * .05; p.z += cos(uT * .09 + s * 2.) * .04;
            vec4 mv = modelViewMatrix * vec4(p, 1.); float px = (.0016 + seed * .0026) * uPR / -mv.z; vB = clamp(px, .25, 1.) * (.5 + .5 * sin(uT * (.5 + seed) + s * 5.));
            gl_PointSize = clamp(px, 1., 6.); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: 'varying float vB; void main(){ float d = 1. - smoothstep(.2, .5, length(gl_PointCoord - .5)); gl_FragColor = vec4(vec3(1., .88, .65) * vB * d * .7, 1.); }',
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      scene.add(new THREE.Points(dg, dustMat));
    }
    // 拼貼照片的質感：一層細細的顆粒和四周暗角（畫面上的一層，不參與 3D）；走近瓶口時，眼前微微暖起來
    grain = document.createElement('div');
    const gc = document.createElement('canvas'); gc.width = gc.height = 160; { const g = gc.getContext('2d'), im = g.createImageData(160, 160); for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 34; } g.putImageData(im, 0, 0); }
    grain.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:5;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 45%,rgba(0,0,0,.55) 100%),url(${gc.toDataURL()});mix-blend-mode:normal;opacity:0`;
    document.body.appendChild(grain);
    warmGlow = document.createElement('div');
    warmGlow.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;mix-blend-mode:screen;background:radial-gradient(ellipse at 70% 40%,rgba(255,214,150,.55) 0%,rgba(255,200,130,.18) 55%,rgba(0,0,0,0) 100%)';
    document.body.appendChild(warmGlow);
  }

  /* ---------- 聲音：寂寞的空房間，帶著玻璃瓶裡的回音 ---------- */
  const A = { ac: null };
  function noiseBuf(ac, sec, pink) {
    const n = ac.sampleRate * sec, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0; for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; if (pink) { b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2 + w * 0.05) * 2.2; } else d[i] = w; }
    return b;
  }
  function glassIR(ac) {   // 玻璃瓶裡的回音：2.4 秒、慢慢衰減，帶一點清脆的共鳴
    const n = Math.round(ac.sampleRate * 2.4), b = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) { const t = i / ac.sampleRate; d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 2.6) * (0.7 + 0.3 * Math.sin(t * 2 * Math.PI * 1850)); } }
    return b;
  }
  function farIR(ac) {   // 外面世界的回音：比玻璃瓶裡長（3.6 秒）、柔和、沒有玻璃的清脆共鳴，高音慢慢先消失
    const n = Math.round(ac.sampleRate * 3.6), b = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < n; i++) { const t = i / ac.sampleRate, k = 0.35 + Math.min(0.6, t * 0.25); lp += ((Math.random() * 2 - 1) - lp) * (1 - k); d[i] = lp * Math.exp(-t * 1.5) * Math.min(1, t / 0.12); } }
    return b;
  }
  function panner(ac, x, y, z, ref = 1.2, roll = 1.4) {
    const p = ac.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = roll;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
    return p;
  }
  // 每種聲音有幾個版本，這裡選定要用哪一個（spaces/test-sound.html 可以試聽比較）
  const SND = { drip: 'f', creak: 'd', warm: 'e', bird: 'a', paper: 'a' };   // 房主選定：掛鐘、細鍊子、遠方啁啾、遠處有人彈琴
  function audioStart(ac, out, quiet) {
    if (!ac) return;
    A.ac = ac; const t0 = ac.currentTime;
    A.out = ac.createGain(); A.out.gain.value = 0; A.out.connect(out || ac.destination); A.out.gain.setTargetAtTime(1, t0, 1.2);
    A.dry = ac.createGain(); A.dry.connect(A.out);
    A.verb = ac.createConvolver(); A.verb.buffer = glassIR(ac); A.wet = ac.createGain(); A.wet.gain.value = 0.42; A.verb.connect(A.wet).connect(A.out);
    A.bus = ac.createGain(); A.bus.connect(A.dry); A.bus.connect(A.verb);
    // 鳥叫和琴聲專用的回音：長長的空間殘響（不受走向瓶口影響）。鳥叫另外有一點從遠處反彈回來的回聲；琴聲只有殘響，不疊聲
    A.echoIn = ac.createGain(); const fr = ac.createConvolver(); fr.buffer = farIR(ac); const frG = ac.createGain(); frG.gain.value = 0.7; A.echoIn.connect(fr).connect(frG).connect(A.out);
    const dl = ac.createDelay(1.5); dl.delayTime.value = 0.38; const fb = ac.createGain(); fb.gain.value = 0.32; const dlp = ac.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2200; const dG = ac.createGain(); dG.gain.value = 0.35;
    A.birdEcho = ac.createGain(); A.birdEcho.connect(A.echoIn); A.birdEcho.connect(dl); dl.connect(dlp).connect(fb).connect(dl); dlp.connect(dG).connect(A.out); dlp.connect(fr);
    const nb = noiseBuf(ac, 4, true), wn = noiseBuf(ac, 3, false); A.pink = nb; A.white = wn;
    if (!quiet) fetch(BASE + 'freedom/letter.m4a').then((r) => r.arrayBuffer()).then((b) => ac.decodeAudioData(b)).then((buf) => { if (A.ac === ac) A.rec = buf; }).catch(() => {});
    // 底噪：很低、悶悶的空氣聲（一直都在，很小聲）
    const tone = ac.createBufferSource(); tone.buffer = nb; tone.loop = true; const tl = ac.createBiquadFilter(); tl.type = 'lowpass'; tl.frequency.value = 170;
    A.tone = ac.createGain(); A.tone.gain.value = quiet ? 0 : TONE; tone.connect(tl).connect(A.tone).connect(A.dry); tone.start(); A.srcs = [tone];
    // 窗外很遠的風：從開著的窗吹進來
    const wind = ac.createBufferSource(); wind.buffer = nb; wind.loop = true; wind.playbackRate.value = 0.6; const wb = ac.createBiquadFilter(); wb.type = 'bandpass'; wb.frequency.value = 420; wb.Q.value = 0.6;
    A.wind = ac.createGain(); A.wind.gain.value = quiet ? 0 : 0.05; wind.connect(wb).connect(A.wind).connect(panner(ac, 0.05, 1.7, -2.0, 0.9, 1.6)).connect(A.bus); wind.start(t0, 1.3); A.srcs.push(wind);
    // 走向瓶口：暖暖的聲音（從瓶口那邊）
    A.warm = ac.createGain(); A.warm.gain.value = 0; A.warm.connect(panner(ac, W + 0.4, NECK.y, NECK.z, 1.0, 1.2)).connect(A.dry); const wE = ac.createBiquadFilter(); wE.type = 'lowpass'; wE.frequency.value = 2600; A.warm.connect(wE).connect(A.echoIn);
    makeWarm(SND.warm);
    A.pDrip = panner(ac, 0.95 + 0.15, 1.6, -0.35, 0.7, 1.5); A.pDrip.connect(A.bus);
    A.pCage = panner(ac, 0.25, 2.25, -1.15, 0.9, 1.3); A.pCage.connect(A.bus);
    A.pCab = panner(ac, -2.0, 0.6, -0.38, 0.8, 1.4); A.pCab.connect(A.bus);
    // 鳥：在瓶子外面很遠的地方。聲音悶一點、大部分只剩回音
    A.pBird = panner(ac, 16, 3.2, -1.5, 3, 1.0); const bl = ac.createBiquadFilter(); bl.type = 'lowpass'; bl.frequency.value = 2100;
    const bDry = ac.createGain(); bDry.gain.value = 0.4; A.pBird.connect(bl); bl.connect(bDry).connect(A.dry); bl.connect(A.verb); const bE = ac.createGain(); bE.gain.value = 1.3; bl.connect(bE).connect(A.birdEcho);
    A.next = quiet ? { drip: 1e9, cage: 1e9, bird: 1e9 } : { drip: t0 + 2.5, cage: t0 + 7, bird: t0 + 18 };
  }
  const TONE = 0.015;
  function makeWarm(v) {   // 靠近瓶口才慢慢出現的聲音（A.warm 控制大小）
    const ac = A.ac; if (A.warmSrc) { A.warmSrc.forEach((n) => { try { n.stop(); } catch (e) {} }); }
    A.warmSrc = []; A.warmBirds = v === 'c'; A.music = false;
    if (A.warmIn) A.warmIn.disconnect(); A.warmIn = ac.createGain(); A.warmIn.connect(A.warm);
    const lfo = (rate, depth, target, base) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = rate; g.gain.value = depth; target.value = base; o.connect(g).connect(target); o.start(); A.warmSrc.push(o); };
    if (v === 'a' || v === 'c') {   // a：暖暖的空氣，沒有音高，像外面溫和的風慢慢吹進來；c：同樣的風，再加上近一點的鳥
      const n = ac.createBufferSource(); n.buffer = A.pink; n.loop = true; n.playbackRate.value = 0.8;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650; const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
      const g = ac.createGain(); lfo(0.07, 0.35, g.gain, 1.1); lfo(0.05, 180, lp.frequency, 650);
      n.connect(hp).connect(lp).connect(g).connect(A.warmIn); n.start(0, Math.random() * 3); A.warmSrc.push(n);
    } else if (v !== 'b') warm2(v);
    if (v === 'b') {   // b：很淡、很高的柔和和弦，慢慢一起一伏（沒有低頻、沒有拍頻）
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.connect(A.warmIn);
      [[392, 0.12, 0.09], [493.9, 0.08, 0.07], [587.3, 0.07, 0.11], [784, 0.03, 0.06]].forEach(([f, a, r]) => {
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; const g = ac.createGain(); lfo(r, a * 0.6, g.gain, a); o.connect(g).connect(lp); o.start(); A.warmSrc.push(o); });
    }
  }
  // 第二批版本（d、e、f）
  const env = (g, t, peak, att, dec) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att); g.gain.exponentialRampToValueAtTime(0.00003, t + att + dec); };
  function tone1(f, t, peak, att, dec, dest, type = 'sine') { const ac = A.ac, o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f; env(g, t, peak, att, dec); o.connect(g).connect(dest); o.start(t); o.stop(t + att + dec + 0.05); return o; }
  function noiseHit(t, peak, dec, type, f, q, dest) { const ac = A.ac, n = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain(); n.buffer = A.white; fl.type = type; fl.frequency.value = f; fl.Q.value = q; env(g, t, peak, 0.001, dec); n.connect(fl).connect(g).connect(dest); n.start(t, Math.random() * 2); n.stop(t + dec + 0.05); }
  const farDrip = () => { if (!A.farDrip) { const ac = A.ac, lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; const d = ac.createGain(); d.gain.value = 0.15; lp.connect(d).connect(A.dry); lp.connect(A.verb); A.farDrip = lp; } return A.farDrip; };
  const DRIP2 = {
    d(t) { const f = 900 + Math.random() * 500, ac = A.ac, o = ac.createOscillator(), g = ac.createGain();   // d：很小、很圓的一顆水珠「噗」，音量很輕
      o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * 1.6, t + 0.06); env(g, t, 0.07, 0.002, 0.06); o.connect(g).connect(A.pDrip); o.start(t); o.stop(t + 0.1);
      noiseHit(t, 0.05, 0.012, 'highpass', 3000, 0.7, A.pDrip); },
    e(t) { const f = 700 + Math.random() * 200, ac = A.ac, o = ac.createOscillator(), g = ac.createGain();   // e：從隔壁房間傳來的水滴，很悶、幾乎只剩回音
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.8, t + 0.05); env(g, t, 0.35, 0.003, 0.08); o.connect(g).connect(farDrip()); o.start(t); o.stop(t + 0.12); },
    f(t) { noiseHit(t, 0.12, 0.018, 'bandpass', 2600, 3, A.pDrip); noiseHit(t + 0.004, 0.05, 0.03, 'bandpass', 900, 2, A.pDrip); },   // f：不是水聲，是掛鐘很輕的一聲「答」（寂寞的房間裡時間在走）
  };
  const CREAK2 = {
    d(t) { const n = 3 + Math.floor(Math.random() * 4); for (let i = 0; i < n; i++) noiseHit(t + i * (0.05 + Math.random() * 0.09), 0.05 + Math.random() * 0.04, 0.02, 'bandpass', 3200 + Math.random() * 1500, 5, A.pCage); },   // d：細鍊子輕輕晃，幾聲很碎的喀喀
    e(t) { const f = 620 + Math.random() * 60; [[1, 0.03, 2.4], [2.01, 0.012, 1.6], [3.9, 0.005, 0.9]].forEach(([m, a, d]) => tone1(f * m, t, a, 0.004, d, A.pCage)); },   // e：遠遠的一聲小鈴，低一點、很長的餘音
    f(t) { const ac = A.ac, o = ac.createOscillator(), g = ac.createGain(), bp = ac.createBiquadFilter(); o.type = 'triangle'; o.frequency.setValueAtTime(210, t); o.frequency.linearRampToValueAtTime(185, t + 0.9);   // f：籠子在吊鉤上慢慢轉半圈，很低很輕的「嘰——」
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06, t + 0.3); g.gain.linearRampToValueAtTime(0.025, t + 0.6); g.gain.linearRampToValueAtTime(0, t + 0.95);
      o.connect(bp).connect(g).connect(A.pCage); o.start(t); o.stop(t + 1); },
  };
  const BIRD2 = {
    b(t) { const ac = A.ac; [[2350, 2050, 0], [2600, 2200, 0.42]].forEach(([f0, f1, dt]) => { const o = ac.createOscillator(), g = ac.createGain(), s = t + dt;   // b：兩聲拉長、往下滑的口哨，很遠
      o.frequency.setValueAtTime(f0, s); o.frequency.exponentialRampToValueAtTime(f1, s + 0.32); g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.035, s + 0.06); g.gain.linearRampToValueAtTime(0, s + 0.34); o.connect(g).connect(A.pBird); o.start(s); o.stop(s + 0.36); }); },
    c(t) { const ac = A.ac; [[0, 0.5], [0.6, 0.35], [0.95, 0.75]].forEach(([dt, len]) => { const o = ac.createOscillator(), g = ac.createGain(), s = t + dt, f = 520;   // c：遠遠的斑鳩「咕—咕咕—」，低沉
      o.frequency.setValueAtTime(f * 0.9, s); o.frequency.linearRampToValueAtTime(f, s + 0.08); o.frequency.linearRampToValueAtTime(f * 0.86, s + len);
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.09, s + 0.07); g.gain.setValueAtTime(0.09, s + len - 0.1); g.gain.linearRampToValueAtTime(0, s + len); o.connect(g).connect(A.pBird); o.start(s); o.stop(s + len + 0.02); }); },
  };
  function warm2(v) {   // 暖聲第二批（接在 A.warmIn 上）
    const ac = A.ac, add = (n) => (A.warmSrc.push(n), n);
    if (v === 'd') {   // d：外面樹葉被風吹得沙沙響，一陣一陣
      const n = add(ac.createBufferSource()); n.buffer = A.white; n.loop = true; const hp = ac.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3800; hp.Q.value = 0.5;
      const g = ac.createGain(); g.gain.value = 0.25; const o = add(ac.createOscillator()), og = ac.createGain(); o.frequency.value = 0.13; og.gain.value = 0.22; o.connect(og).connect(g.gain); o.start();
      const o2 = add(ac.createOscillator()), og2 = ac.createGain(); o2.frequency.value = 0.031; og2.gain.value = 0.12; o2.connect(og2).connect(g.gain); o2.start();
      n.connect(hp).connect(g).connect(A.warmIn); n.start();
    } else if (v === 'e') {   // e：很遠的地方有人在彈琴，偶爾幾個音（五聲音階，柔、慢、有長長的尾巴）
      A.music = true;
    } else if (v === 'f') {   // f：遠方的海浪，很慢地一起一落
      const n = add(ac.createBufferSource()); n.buffer = A.pink; n.loop = true; const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const g = ac.createGain(); g.gain.value = 0.6; const o = add(ac.createOscillator()), og = ac.createGain(); o.frequency.value = 0.11; og.gain.value = 0.55; o.connect(og).connect(g.gain); o.start();
      const ol = add(ac.createOscillator()), olg = ac.createGain(); ol.frequency.value = 0.11; olg.gain.value = 450; ol.connect(olg).connect(lp.frequency); ol.start();
      n.connect(lp).connect(g).connect(A.warmIn); n.start();
    }
  }
  const PENTA = [523.3, 587.3, 659.3, 784, 880, 1046.5];
  function pianoNote(t) { const f = PENTA[Math.floor(Math.random() * PENTA.length)], d = A.warmIn;   // 遠處的琴聲：簡單、柔和的音
    [[1, 0.16, 2.6], [2, 0.05, 1.4], [3, 0.02, 0.8]].forEach(([m, a, dc]) => tone1(f * m, t, a, 0.006, dc, d));
    if (Math.random() < 0.4) [[1, 0.1, 2.2], [2, 0.03, 1.2]].forEach(([m, a, dc]) => tone1(f * 0.75 * m, t + 0.25, a, 0.006, dc, d)); }
  function drip(t) {   // 點滴：很久才一滴
    const ac = A.ac, v = SND.drip; if (DRIP2[v]) return DRIP2[v](t);
    if (v === 'a') {   // a：一滴落進水裡，「咚」的小水泡聲（音高往上滑）
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(480, t); o.frequency.exponentialRampToValueAtTime(1250, t + 0.045);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
      o.connect(g).connect(A.pDrip); o.start(t); o.stop(t + 0.1);
    } else if (v === 'b') {   // b：悶悶的、輕輕的一聲「答」，像滴在布或枕頭上
      const s = ac.createBufferSource(); s.buffer = A.white; const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; const g = ac.createGain();
      g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      const o = ac.createOscillator(), og = ac.createGain(); o.frequency.setValueAtTime(340, t); o.frequency.exponentialRampToValueAtTime(260, t + 0.06);
      og.gain.setValueAtTime(0.18, t); og.gain.exponentialRampToValueAtTime(0.0005, t + 0.07);
      s.connect(lp).connect(g).connect(A.pDrip); o.connect(og).connect(A.pDrip); s.start(t, Math.random()); s.stop(t + 0.05); o.start(t); o.stop(t + 0.08);
    } else {   // c：滴在金屬盆裡，很細的一聲「叮」，餘音短短的
      const s = ac.createBufferSource(); s.buffer = A.white; const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2300; bp.Q.value = 40; const g = ac.createGain();
      g.gain.setValueAtTime(1.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.004);
      const r = ac.createGain(); r.gain.value = 1; s.connect(g).connect(bp).connect(r).connect(A.pDrip); s.start(t, Math.random()); s.stop(t + 0.01);
      const o = ac.createOscillator(), og = ac.createGain(); o.frequency.value = 2300; og.gain.setValueAtTime(0.025, t); og.gain.exponentialRampToValueAtTime(0.0003, t + 0.35); o.connect(og).connect(A.pDrip); o.start(t); o.stop(t + 0.36);
    }
  }
  function creak(t) {   // 空鳥籠
    const ac = A.ac, v = SND.creak; if (v === 'none') return; if (CREAK2[v]) return CREAK2[v](t);
    if (v === 'a') {   // a：鐵絲輕輕碰到，一兩聲很小的「叮」
      const hits = 1 + (Math.random() < 0.5 ? 1 : 0), f0 = 1700 + Math.random() * 400;
      for (let h = 0; h < hits; h++) { const s = t + h * (0.14 + Math.random() * 0.1), amp = h ? 0.5 : 1;
        [[1, 0.035, 0.55], [2.76, 0.018, 0.35], [5.4, 0.008, 0.2]].forEach(([m, a, d]) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f0 * m;
          g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(a * amp, s + 0.002); g.gain.exponentialRampToValueAtTime(0.00005, s + d); o.connect(g).connect(A.pCage); o.start(s); o.stop(s + d + 0.02); }); }
    } else {   // b：吊鉤慢慢轉，乾乾的一聲「吱——」（一下一下摩擦）
      const dur = 0.7, n = Math.round(ac.sampleRate * dur), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
      let ph = 0; for (let i = 0; i < n; i++) { const k = i / n, rate = 70 + 90 * Math.sin(k * Math.PI) + (Math.random() - 0.5) * 30; ph += rate / ac.sampleRate; if (ph >= 1) { ph -= 1; d[i] = 0.6 + Math.random() * 0.4; } }
      const s = ac.createBufferSource(); s.buffer = b; const b1 = ac.createBiquadFilter(); b1.type = 'bandpass'; b1.frequency.value = 1300; b1.Q.value = 4; const b2 = ac.createBiquadFilter(); b2.type = 'bandpass'; b2.frequency.value = 2700; b2.Q.value = 6;
      const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.15); g.gain.linearRampToValueAtTime(0, t + dur);
      s.connect(b1).connect(g); s.connect(b2).connect(g); g.connect(A.pCage); s.start(t);
    }
  }
  function bird(t, near) {   // 鳥鳴：兩三聲短短的啁啾。平常在很遠的地方；near＝靠近瓶口時從瓶口外傳來
    if (!near && BIRD2[SND.bird]) return BIRD2[SND.bird](t);
    const ac = A.ac, k = 2 + Math.floor(Math.random() * 2), dest = near ? A.warmIn : A.pBird;
    for (let i = 0; i < k; i++) {
      const s = t + i * (0.16 + Math.random() * 0.06), o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine';
      const f = 2600 + Math.random() * 600; o.frequency.setValueAtTime(f, s); o.frequency.exponentialRampToValueAtTime(f * 1.35, s + 0.05); o.frequency.exponentialRampToValueAtTime(f * 0.85, s + 0.11);
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(near ? 0.25 : 0.14, s + 0.015); g.gain.exponentialRampToValueAtTime(0.0003, s + 0.13);
      o.connect(g).connect(dest); o.start(s); o.stop(s + 0.15);
    }
  }
  function audioTick(cam, warmK) {
    if (!A.ac) return;
    const ac = A.ac, now = ac.currentTime, L = ac.listener, f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    if (L.positionX) { L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z; L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z; L.upX.value = u.x; L.upY.value = u.y; L.upZ.value = u.z; }
    else { L.setPosition(cam.position.x, cam.position.y, cam.position.z); L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
    const N = A.next;
    if (N.drip < now + 0.2) { drip(N.drip); N.drip += 6 + Math.random() * 4; }
    if (N.cage < now + 0.2) { creak(N.cage); N.cage += 12 + Math.random() * 9; }
    if (N.bird < now + 0.2) { bird(N.bird); N.bird += 25 + Math.random() * 16; }
    if (A.music && warmK > 0.15) { if (!N.pn || N.pn < now - 30) N.pn = now + 1; if (N.pn < now + 0.2) { pianoNote(N.pn); N.pn += 2.2 + Math.random() * 3; } }
    if (A.warmBirds && warmK > 0.3) { if (!N.nb || N.nb < now - 30) N.nb = now + 2; if (N.nb < now + 0.2) { bird(N.nb, true); N.nb += 5 + Math.random() * 6; } }
    // 走向瓶口：底噪和風退去、回音變少（離開玻璃瓶），暖暖的聲音慢慢出現
    A.tone.gain.setTargetAtTime(TONE * (1 - 0.65 * warmK), now, 0.4);
    A.wind.gain.setTargetAtTime((0.04 + 0.02 * Math.sin(now * 0.23) * Math.sin(now * 0.07)) * (1 - 0.6 * warmK), now, 0.6);
    A.wet.gain.setTargetAtTime(0.42 * (1 - 0.6 * warmK), now, 0.4);
    A.warm.gain.setTargetAtTime(0.11 * warmK * warmK, now, 0.4);
  }
  // 試聽用（spaces/test-sound.html）：不進空間，單獨播某一種聲音的某個版本
  const audition = {
    start(ac) { if (!A.ac) audioStart(ac, ac.destination, true); const L = ac.listener; if (L.positionX) { L.positionX.value = 0.2; L.positionY.value = 1.6; L.positionZ.value = 0.8; } else L.setPosition(0.2, 1.6, 0.8); },
    play(kind, v) { const t = A.ac.currentTime + 0.05;
      if (kind === 'drip') { SND.drip = v; drip(t); } else if (kind === 'creak') { SND.creak = v; creak(t); } else if (kind === 'bird') { SND.bird = v; bird(t); }
      else if (kind === 'paper') { SND.paper = v; paperFlap(t); paperSlide(t + 0.6, 0.85, 0.09); paperSlide(t + 1.6, 0.35, 0.04); paperSlide(t + 2.9, 0.5, 0.06); }
      else if (kind === 'warm') { SND.warm = v; makeWarm(v); A.warm.gain.setTargetAtTime(0.11, t, 0.3); if (v === 'c') { bird(t + 1, true); bird(t + 6, true); } if (v === 'e') { clearInterval(A.demo); pianoNote(t + 0.3); A.demo = setInterval(() => { if (A.music) pianoNote(A.ac.currentTime + 0.05); else clearInterval(A.demo); }, 2800); } } },
    stopWarm() { A.warm.gain.setTargetAtTime(0, A.ac.currentTime, 0.2); A.music = false; clearInterval(A.demo); },
    room(on) { const t = A.ac.currentTime; A.tone.gain.setTargetAtTime(on ? TONE : 0, t, 0.3); A.wind.gain.setTargetAtTime(on ? 0.05 : 0, t, 0.3); },
  };
  function audioStop() {
    if (!A.ac) return; A.rec = null;
    if (A.warmSrc) A.warmSrc.forEach((n) => { try { n.stop(); } catch (e) {} }); A.warmSrc = null; A.warmIn = null;
    const o = A.out, ac = A.ac; o.gain.setTargetAtTime(0, ac.currentTime, 0.3);
    setTimeout(() => { try { o.disconnect(); } catch (e) {} }, 1600);
    A.ac = null;
  }

  /* ---------- 每一格 ---------- */
  const blocked = (x, z) => solids.some((b) => x > b[0] - 0.22 && x < b[1] + 0.22 && z > b[2] - 0.22 && z < b[3] + 0.22);
  function tick(dt, inp) {
    if (!S.on) return null;
    S.t += dt;
    if (S.drawer) { S.drawerK = Math.min(1, Math.max(0, S.drawerK + ((S.drawerOpen ? 1 : 0) - S.drawerK) * (1 - Math.pow(0.004, Math.max(0, Math.min(0.1, dt)))))); S.drawer.position.z = S.drawerK * 0.27; }
    const sp = (S.reading ? 0 : 1) * (inp.crouch > 0.5 ? 0.55 : 1) * 1.2 * dt;
    const fx = -Math.sin(inp.yaw), fz = -Math.cos(inp.yaw), rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
    const nx = Math.max(-W + 0.3, Math.min(W - 0.3, S.x + (fx * inp.mz + rx * inp.mx) * sp)), nz = Math.max(-D + 0.3, Math.min(D - 0.3, S.z + (fz * inp.mz + rz * inp.mx) * sp));
    if (!blocked(nx, S.z)) S.x = nx; if (!blocked(S.x, nz)) S.z = nz;
    const eyeY = lerp(1.6, 1.0, inp.crouch);
    const dExit = Math.hypot(S.x - EXIT.x, S.z - EXIT.z), warmK = sstep(2.8, 0.5, dExit);
    S.warmK = warmK;
    grain.style.opacity = Math.min(1, S.t / 1.5).toFixed(2);
    warmGlow.style.opacity = (warmK * warmK * 0.55).toFixed(3);
    beamMat.uniforms.uT.value = dustMat.uniforms.uT.value = S.t;
    return { x: S.x, y: eyeY, z: S.z, leave: dExit < EXIT.r && S.t > 1.5 };
  }
  function render(renderer, camera, pose, inp) {
    camera.position.set(pose.x, pose.y, pose.z); camera.rotation.set(inp.pitch, inp.yaw, 0); camera.updateMatrixWorld();
    dustMat.uniforms.uPR.value = camera.projectionMatrix.elements[5] * renderer.domElement.height / 2;
    audioTick(camera, S.warmK || 0);
    if (S.shadowFrames > 0) { renderer.shadowMap.needsUpdate = true; S.shadowFrames--; }   // 靜止的場景：影子只在剛進來時畫幾次
    const tm = renderer.toneMapping, legacy = renderer.useLegacyLights;   // 這個空間用自己的色調和燈光算法（房間用的是電影感的色調、舊式燈光亮度）
    renderer.toneMapping = THREE.NoToneMapping; renderer.useLegacyLights = false;
    renderer.render(scene, camera);
    renderer.toneMapping = tm; renderer.useLegacyLights = legacy;
  }
  /* ---------- 抽屜與信 ---------- */
  const LETTER = ['今天，我終於決定出去了。', '外面還是很黑，我也還是會害怕。', '但鳥兒在等我，路燈也亮著。', '我想先走一小段看看。', '如果累了，就找個地方休息。', '如果害怕，也沒有關係。', '這次，我不想再等天亮了。'];
  let ray, letterEl = null;
  function pick(ndc, camera) {   // 房間每一格問：準心／滑鼠指著什麼？（只有抽屜和信可以互動，要走近才行）
    if (!S.on || S.reading || !S.pickFront) return null;
    ray = ray || new THREE.Raycaster(); ray.setFromCamera(ndc, camera); ray.far = 1.9;
    const hit = ray.intersectObjects(S.drawerOpen ? [S.pickEnv, S.pickFront] : [S.pickFront], false)[0];
    if (!hit) return null;
    if (hit.object === S.pickEnv) return { kind: 'letter', label: '一封信', hint: '點擊拆開來讀' };
    return { kind: 'drawer', label: '床頭櫃的抽屜', hint: S.drawerOpen ? '點擊關上抽屜' : '點擊拉開抽屜' };
  }
  function act(a) {
    if (!a || S.reading) return;
    if (a.kind === 'drawer') { S.drawerOpen = !S.drawerOpen; slide(); }
    else if (a.kind === 'letter') openLetter();
  }
  function slide() { if (!A.ac) return; const t = A.ac.currentTime; noiseHit(t, 0.06, 0.35, 'bandpass', 700, 0.8, A.pCab); noiseHit(t + 0.3, 0.05, 0.05, 'lowpass', 300, 0.7, A.pCab); }   // 木頭抽屜滑動、輕輕碰到底
  // 紙張的聲音（在手上，所以不放在空間裡的某個位置）
  function paperSlide(t, dur, peak) { if (PAPER2[SND.paper]) return PAPER2[SND.paper].slide(t, dur, peak); if (PAPER[SND.paper]) return PAPER[SND.paper].slide(t, dur, peak); slideA(t, dur, peak); }
  function paperFlap(t) { if (PAPER2[SND.paper]) return PAPER2[SND.paper].flap(t); if (PAPER[SND.paper]) return PAPER[SND.paper].flap(t); flapA(t); }
  function crackle(t, dur, perSec, peak, f, q, dest) {   // 紙纖維互相摩擦的細碎聲：很多很小的「喀」，疏密隨時間起伏
    const ac = A.ac, sr = ac.sampleRate, n = Math.round(sr * dur), b = ac.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) { const x = i / n, rate = perSec * Math.sin(Math.PI * Math.pow(x, 0.7)); if (Math.random() < rate / sr) { const a = (Math.random() * 2 - 1) * (0.4 + Math.random() * 0.6), L = Math.round(sr * (0.0006 + Math.random() * 0.002)); for (let k = 0; k < L && i + k < n; k++) d[i + k] += a * Math.exp(-k / (L * 0.3)); } }
    const s = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = b; bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q; g.gain.value = peak;
    s.connect(bp).connect(g).connect(dest); s.start(t);
  }
  function hiss(t, dur, peak, type, f0, f1, q, buf, attackFrac = 0.3, dest) {   // 一段平滑的「唰」
    const ac = A.ac, n = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain(); n.buffer = buf || A.white;
    fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f0, t); fl.frequency.linearRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + dur * attackFrac); g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(fl).connect(g).connect(dest || A.dry); n.start(t, Math.random() * 2); n.stop(t + dur + 0.05);
  }
  function crisp(t, dur, perSec, peak, hp, dest) {   // 薄紙的脆：很短很尖的小「喀」（每一下不到 0.5 毫秒），只留高頻
    const ac = A.ac, sr = ac.sampleRate, n = Math.round(sr * dur), b = ac.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) { const x = i / n, rate = perSec * Math.pow(Math.sin(Math.PI * Math.pow(x, 0.6)), 0.7); if (Math.random() < rate / sr) { const a = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.7), L = Math.round(sr * (0.00008 + Math.random() * 0.0004)); for (let k = 0; k < L && i + k < n; k++) d[i + k] += a * (1 - k / L); } }
    const s = ac.createBufferSource(), f1 = ac.createBiquadFilter(), f2 = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = b;
    f1.type = 'highpass'; f1.frequency.value = hp; f1.Q.value = 0.7; f2.type = 'highpass'; f2.frequency.value = hp; f2.Q.value = 0.7; g.gain.value = peak;
    s.connect(f1).connect(f2).connect(g).connect(dest || A.dry); s.start(t);
  }
  const airy = (t, dur, peak, hp) => hiss(t, dur, peak, 'highpass', hp, hp * 1.15, 0.5, null, 0.25);   // 很細、很高的一層「斯——」
  const PAPER2 = {
    f: { flap: (t) => { crisp(t, 0.16, 900, 0.5, 3000); crisp(t + 0.2, 0.1, 500, 0.3, 3500); },   // f：薄紙輕輕滑出來，細細的斯——加上少少的脆
         slide: (t, dur, peak) => { airy(t, dur, peak * 0.5, 6000); crisp(t, dur, 220, peak * 4, 3500); } },
    g: { flap: (t) => { crisp(t, 0.22, 2200, 0.55, 2500); },   // g：脆一點，像信紙邊緣刮過信封，有明顯的沙沙小顆粒
         slide: (t, dur, peak) => { crisp(t, dur, 900, peak * 5, 2800); airy(t, dur, peak * 0.25, 7000); } },
    h: { flap: (t) => { crisp(t, 0.12, 1500, 0.45, 2500); noiseHit(t + 0.13, 0.05, 0.012, 'highpass', 2500, 0.7, A.dry); },   // h：攤開時紙「啪」地輕輕一抖
         slide: (t, dur, peak) => { airy(t, dur * 0.8, peak * 0.4, 5500); crisp(t, dur * 0.8, 350, peak * 4, 3000); if (dur < 0.4) { noiseHit(t + dur * 0.6, peak * 1.5, 0.015, 'highpass', 2200, 0.7, A.dry); crisp(t + dur * 0.6, 0.08, 2500, peak * 6, 2500); } } },
  };
  const PAPER = {   // 拆信紙聲的幾個版本（a 是第一版，寫在 slideA／flapA）
    b: { flap: (t) => hiss(t, 0.25, 0.05, 'bandpass', 700, 1000, 0.5, A.pink, 0.4),   // b：輕柔、悶一點，像紙在紙上滑
         slide: (t, dur, peak) => hiss(t, dur * 1.25, peak * 1.4, 'bandpass', 900, 1500, 0.45, A.pink, 0.35) },
    c: { flap: (t) => crackle(t, 0.22, 260, 0.35, 3500, 0.9, A.dry),   // c：乾乾的、聽得到紙纖維細細的摩擦
         slide: (t, dur, peak) => { crackle(t, dur, 520, peak * 4, 4200, 0.8, A.dry); hiss(t, dur, peak * 0.35, 'highpass', 3500, 4500, 0.5, null, 0.5); } },
    d: { flap: (t) => { hiss(t, 0.12, 0.05, 'bandpass', 2600, 3000, 0.8, null, 0.1); noiseHit(t, 0.04, 0.05, 'lowpass', 350, 0.7, A.dry); },   // d：近一點、清楚的一聲「唰」，開頭有紙的厚度
         slide: (t, dur, peak) => { hiss(t, dur * 0.8, peak * 1.2, 'bandpass', 3200, 5200, 0.5, null, 0.12); noiseHit(t, peak * 0.5, 0.08, 'lowpass', 400, 0.7, A.dry); crackle(t, dur * 0.7, 160, peak * 1.5, 3000, 1, A.dry); } },
    e: { flap: (t) => hiss(t, 0.18, 0.015, 'bandpass', 1800, 2200, 0.6, A.pink, 0.4),   // e：很輕、很短，幾乎只是一點空氣聲
         slide: (t, dur, peak) => hiss(t, dur * 0.7, peak * 0.35, 'bandpass', 1800, 2600, 0.5, A.pink, 0.3) },
  };
  function slideA(t, dur, peak) {   // a：第一版
    const ac = A.ac, n = ac.createBufferSource(), bp = ac.createBiquadFilter(), hs = ac.createBiquadFilter(), g = ac.createGain();
    n.buffer = A.white; bp.type = 'bandpass'; bp.Q.value = 0.6; bp.frequency.setValueAtTime(1600, t); bp.frequency.linearRampToValueAtTime(3200, t + dur);
    hs.type = 'lowpass'; hs.frequency.value = 6500;
    const N = 64, curve = new Float32Array(N);
    for (let k = 0; k < N; k++) { const x = k / (N - 1), shape = Math.sin(Math.PI * Math.pow(x, 0.8)); curve[k] = peak * shape * (0.75 + 0.25 * Math.random()); }
    curve[N - 1] = 0; g.gain.setValueAtTime(0, t); g.gain.setValueCurveAtTime(curve, t + 0.001, dur);
    n.connect(bp).connect(hs).connect(g).connect(A.dry); n.start(t, Math.random() * 2); n.stop(t + dur + 0.05);
  }
  function flapA(t) { noiseHit(t, 0.018, 0.09, 'bandpass', 1400, 0.7, A.dry); noiseHit(t + 0.12, 0.012, 0.07, 'bandpass', 2200, 0.7, A.dry); }
  const sfx = (f) => { if (A.ac) f(A.ac.currentTime + 0.02); };
  // 拆信的聲音：房主錄的真實抽信聲（freedom/letter.m4a，1.77 秒：開頭是抽出信紙，1.32 秒處是攤開的那一下）。還沒載好就用合成的
  function playRec(off, dur, gain = 0.12) {
    if (!A.ac || !A.rec) return false; const ac = A.ac, t = ac.currentTime + 0.02, s = ac.createBufferSource(), g = ac.createGain();
    s.buffer = A.rec; g.gain.value = gain; s.connect(g).connect(A.dry); s.start(t, off, dur); return true;
  }
  function openLetter() {
    S.reading = true; if (document.pointerLockElement) document.exitPointerLock();
    const sc = Math.min(1, (innerWidth - 32) / 330, (innerHeight - 40) / 440);
    letterEl = document.createElement('div');
    letterEl.style.cssText = 'position:fixed;inset:0;z-index:30;background:rgba(10,9,8,.55);opacity:0;transition:opacity .5s ease;overflow:hidden';
    const paperBg = '#efe8d8 linear-gradient(180deg,rgba(255,255,255,.25),rgba(0,0,0,.04))';
    letterEl.innerHTML = `
      <div class="lv-stage" style="position:absolute;left:50%;top:50%;width:320px;height:210px;margin:-105px 0 0 -160px;perspective:900px;transform:scale(${sc}) translateY(70px);transition:transform .7s cubic-bezier(.3,.7,.2,1),opacity .6s ease">
        <div style="position:absolute;inset:0;background:#d9ceb7;border-radius:3px;box-shadow:0 16px 40px rgba(0,0,0,.5);z-index:1"></div>
        <div class="lv-paper" style="position:absolute;left:14px;right:14px;top:12px;height:186px;background:${paperBg};border-radius:2px;box-shadow:0 1px 3px rgba(0,0,0,.18);z-index:3;transition:transform .9s cubic-bezier(.4,.1,.2,1)">
          <div style="position:absolute;left:0;right:0;top:50%;border-top:1px solid rgba(120,100,70,.14)"></div></div>
        <div style="position:absolute;inset:0;background:#e6dcc8;clip-path:polygon(0 0,50% 58%,100% 0,100% 100%,0 100%);border-radius:3px;z-index:4"></div>
        <div class="lv-flap" style="position:absolute;left:0;right:0;top:0;height:62%;transform-origin:50% 0;transform-style:preserve-3d;z-index:5;transition:transform .6s cubic-bezier(.4,.1,.3,1)">
          <div style="position:absolute;inset:0;background:#eae2d1;clip-path:polygon(0 0,100% 0,50% 100%);backface-visibility:hidden"></div>
          <div style="position:absolute;left:50%;top:84%;width:30px;height:30px;margin:-15px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#a24c42,#7a3029);backface-visibility:hidden"></div>
          <div style="position:absolute;inset:0;background:#d3c7ae;clip-path:polygon(0 0,100% 0,50% 100%);transform:rotateY(180deg);backface-visibility:hidden"></div></div>
      </div>
      <div class="lv-card" style="position:absolute;left:50%;top:50%;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:44px 40px 30px;
        background:${paperBg};color:#3b342b;border-radius:3px;box-shadow:0 18px 50px rgba(0,0,0,.55);opacity:0;transform:translate(-50%,-46%) scale(.86);transition:opacity .7s ease,transform .8s cubic-bezier(.2,.7,.2,1);
        font-family:'LXGW WenKai TC',serif;font-size:18px;line-height:2.1;letter-spacing:.06em;pointer-events:none">
        ${LETTER.map((l) => `<p style="margin:0 0 .55em">${l}</p>`).join('')}
        <div style="position:absolute;left:0;right:0;top:33%;border-top:1px solid rgba(120,100,70,.12)"></div><div style="position:absolute;left:0;right:0;top:66%;border-top:1px solid rgba(120,100,70,.12)"></div>
        <button type="button" style="outline:none;display:block;margin:22px auto 0;font:inherit;font-size:15px;color:#5b5145;background:none;border:1px solid rgba(91,81,69,.35);border-radius:999px;padding:6px 20px;cursor:pointer">把信收好</button></div>`;
    document.body.appendChild(letterEl);
    const el = letterEl, $q = (c) => el.querySelector(c), stage = $q('.lv-stage'), flap = $q('.lv-flap'), pap = $q('.lv-paper'), card = $q('.lv-card');
    const at = (ms, f) => setTimeout(() => { if (letterEl === el) f(); }, ms);
    requestAnimationFrame(() => { el.style.opacity = 1; stage.style.transform = `scale(${sc}) translateY(30px)`; });
    at(550, () => { flap.style.transform = 'rotateX(178deg)'; if (!A.rec) sfx(paperFlap); });   // 打開封口
    at(1000, () => { flap.style.zIndex = 2; });                                      // 封口翻到後面去
    at(1150, () => { pap.style.transform = 'translateY(-165px)'; if (!playRec(0)) sfx((t) => paperSlide(t, 0.85, 0.09)); });   // 抽出信紙（錄音會一路播到攤開那一下）
    at(2450, () => { stage.style.transform = `scale(${sc}) translateY(260px)`; stage.style.opacity = 0;       // 信封放下，信紙攤開
      card.style.opacity = 1; card.style.transform = 'translate(-50%,-50%)'; card.style.pointerEvents = 'auto'; if (!A.rec) sfx((t) => paperSlide(t, 0.35, 0.04)); });
    at(2600, () => { const b = $q('button'); if (b) b.focus(); });
    el.addEventListener('click', (e) => { if (card.style.pointerEvents === 'auto' && (e.target === el || e.target.closest('button'))) closeLetter(); });
    el.addEventListener('pointerup', (e) => e.stopPropagation());
  }
  function closeLetter() {
    if (!letterEl) return false;
    const el = letterEl, card = el.querySelector('.lv-card'); if (card.style.pointerEvents !== 'auto') return true;   // 還在拆信的動畫中：先不關
    letterEl = null; if (!playRec(1.2, 0.57, 0.1)) sfx((t) => paperSlide(t, 0.5, 0.06));
    card.style.transform = 'translate(-50%,-44%) scale(.9)'; el.style.opacity = 0; setTimeout(() => el.remove(), 600);
    setTimeout(() => { S.reading = false; }, 300); return true;
  }
  function esc() { return closeLetter(); }   // 讀信時按 Esc：先把信收好，不要直接離開作品
  function enter(o) {
    init(o.THREE); S.on = true; S.x = -0.8; S.z = 1.25; S.t = 0; S.shadowFrames = 3;
    audioStart(o.ac, o.out);
  }
  function exit() { if (letterEl) { letterEl.remove(); letterEl = null; } S.reading = false; S.on = false; if (grain) grain.style.opacity = 0; if (warmGlow) warmGlow.style.opacity = 0; audioStop(); }
  function dispose() {   // 離開後把這個空間從記憶體釋放（下次進來再建立）
    if (!scene) return;
    geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose());
    geos = []; mats = []; texs = []; solids.length = 0;
    if (grain) grain.remove(); if (warmGlow) warmGlow.remove(); grain = warmGlow = null; scene = null;
  }
  window.FreedomSpace = { init, enter, exit, tick, render, dispose, audition, pick, act, esc, startYaw: -0.45, note: '空間裡有很輕的聲音，戴耳機聽得比較清楚', exitHint: ['走進瓶口照進來的光，或點「離開作品」回到房間', '走進瓶口照進來的光，或按 Esc 回到房間'], get on() { return S.on; }, state: S };
})();
