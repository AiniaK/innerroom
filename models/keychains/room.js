/* 房主設計的三個鑰匙圈（three.js r158，全域 THREE）。素材在 assets/keychains/（由設計圖與照片處理而成）：
   - acrylic：三層壓克力的安全帽。正面印安全帽（面罩是透明的）、背面是黑色剪影與簽名，中間層挖空成空腔，金魚是一片活動的小壓克力，
     拿起來翻轉時會依重力在安全帽裡滑動、碰到邊緣彈回。
   - strap：雙面織帶，一面橘色、一面粉色（從照片校正成正面）。
   - snake：雙面織帶，一面白蛇、一面黑蛇，外形跟著蛇的身體凸出。
   用法：Keychains.load('acrylic' | 'strap' | 'snake') → Promise<{ root, meshes, height, tick(dt) }>；
   單位公尺，root 的原點在鑰匙圈（不含金屬圈）的中心，正面朝 +z、上方（掛圈那頭）朝 +y。 */
(function () {
  'use strict';
  const BASE = 'assets/keychains/';
  let metaP = null;
  const meta = () => metaP || (metaP = fetch(BASE + 'keychains.json?v=2026-11-17c').then((r) => r.json()));
  const tex = (name) => new Promise((ok) => {
    const t = new THREE.TextureLoader().load(BASE + name + '.webp?v=2026-11-18w', () => ok(t), undefined, () => ok(t));
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  });
  const toon = (o) => new THREE.MeshToonMaterial(Object.assign({ gradientMap: null }, o));
  const metal = () => new THREE.MeshStandardMaterial({ color: 0xd9dcdf, metalness: 0.9, roughness: 0.28 });

  // 輪廓（圖上像素，y 往下）→ THREE.Shape（公尺，y 往上，以 (cx, cy) 為原點）
  const shapeOf = (pts, k, cx, cy) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2((x - cx) * k, (cy - y) * k)));
  const pathOf = (pts, k, cx, cy) => new THREE.Path(pts.map(([x, y]) => new THREE.Vector2((x - cx) * k, (cy - y) * k)).reverse());
  const circle = (x, y, r, k, cx, cy) => { const p = new THREE.Path(); p.absarc((x - cx) * k, (cy - y) * k, r * k, 0, Math.PI * 2, true); return p; };
  // 一張貼圖平面：圖上 (x0, y0) 起、w × h 像素
  function decal(t, x0, y0, w, h, k, cx, cy, z, flip) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w * k, h * k), toon({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false }));
    m.position.set((x0 + w / 2 - cx) * k, (cy - (y0 + h / 2)) * k, z);
    if (flip) m.rotation.y = Math.PI;
    return m;
  }
  // 鑰匙圈的金屬圈：一個小扣環穿過孔，再接一個大的開口圈
  function rings(hx, hy, holeR, big, parent) {
    const small = new THREE.Mesh(new THREE.TorusGeometry(holeR * 1.9, 0.0008, 8, 24), metal());
    small.position.set(hx, hy + holeR * 0.9, 0); small.rotation.y = Math.PI / 2; parent.add(small);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(big, 0.0011, 10, 48), metal());
    ring.position.set(hx, hy + holeR * 0.9 + holeR * 1.9 + big * 0.92, 0); parent.add(ring);
    return [small, ring];
  }

  function eyelet(x, y, r, t, parent, meshes) {
    const m = new THREE.MeshStandardMaterial({ color: 0xb9bdc2, metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide });
    for (const z of [t / 2 + 0.0003, -t / 2 - 0.0003]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.32, r * 0.36, 10, 32), m); ring.scale.z = 0.45; ring.position.set(x, y, z); parent.add(ring); meshes.push(ring);   // the rolled rim
    }
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, t + 0.0006, 24, 1, true), m); tube.rotation.x = Math.PI / 2; tube.position.set(x, y, 0); parent.add(tube); meshes.push(tube);
  }
  // a printed face cut to a shape: UVs from the shape's own box, so nothing can show past the edge (mirror: for the face seen from behind)
  function shapedFace(shape, t, mirror, z, back) {
    const g = new THREE.ShapeGeometry(shape, 8); g.computeBoundingBox(); const bb = g.boundingBox, P = g.attributes.position, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) { const u = (P.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), v = (P.getY(i) - bb.min.y) / (bb.max.y - bb.min.y); U.setXY(i, mirror ? 1 - u : u, v); }
    const m = new THREE.Mesh(g, toon({ map: t, alphaTest: 0.5, side: back ? THREE.BackSide : THREE.FrontSide })); m.position.z = z; return m;
  }
  function inside(px, py, poly) {   // 點在多邊形裡？（圖上像素）
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  async function acrylic() {
    const M = await meta(), [W, H] = M.acrylicSize, k = 0.06 / W, cx = W / 2, cy = H / 2 + 6;
    const [front, back, fishT] = await Promise.all([tex('acrylic-front'), tex('acrylic-back'), tex('acrylic-fish')]);
    const root = new THREE.Group(), meshes = [];
    const clear = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.06, metalness: 0, depthWrite: false });
    const hole = circle(M.hole.x, M.hole.y, M.hole.r, k, cx, cy);
    const plate = (depth, z, withCavity) => {
      const s = shapeOf(M['acrylic-outline'], k, cx, cy); s.holes.push(hole);
      if (withCavity) s.holes.push(pathOf(M['acrylic-cavity'], k, cx, cy));
      const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: 0.0004, bevelThickness: 0.0004, bevelSegments: 2, curveSegments: 6 });
      g.translate(0, 0, z - depth / 2);
      const m = new THREE.Mesh(g, clear); m.renderOrder = 2; root.add(m); meshes.push(m); return m;
    };
    plate(0.002, 0.0035, false);   // 正面那片
    plate(0.003, 0, true);         // 中間的框（中間挖空成空腔）
    plate(0.002, -0.0035, false);  // 背面那片
    const pf = decal(front, 0, 0, W, H, k, cx, cy, 0.0024), pb = decal(back, 0, 0, W, H, k, cx, cy, -0.0024);
    root.add(pf, pb); meshes.push(pf, pb);
    // 活動的金魚片：一片有厚度的小壓克力，兩面都看得到金魚
    const F = M.fish, fish = new THREE.Group(); root.add(fish);
    const fs = shapeOf(M['acrylic-fish-outline'], k, cx, cy), fg = new THREE.ExtrudeGeometry(fs, { depth: 0.0015, bevelEnabled: false, curveSegments: 4 });
    fg.translate(0, 0, -0.00075);
    const fe = new THREE.Mesh(fg, toon({ color: 0xffffff })); fish.add(fe); meshes.push(fe);
    for (const z of [0.0008, -0.0008]) { const d = decal(fishT, F.x, F.y, F.w, F.h, k, cx, cy, z); fish.add(d); meshes.push(d); }
    rings((M.hole.x - cx) * k, (cy - M.hole.y) * k, M.hole.r * k, 0.013, root).forEach((m) => meshes.push(m));
    // 金魚在空腔裡依重力滑動：用金魚輪廓上的一些點檢查有沒有碰到空腔邊
    const cav = M['acrylic-cavity'], probe = M['acrylic-fish-outline'].filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 40)) === 0);
    const fits = (dx, dy) => probe.every(([x, y]) => inside(x + dx, y + dy, cav));
    let px = 0, py = 0, vx = 0, vy = 0;
    const q = new THREE.Quaternion(), g = new THREE.Vector3();
    const tick = (dt) => {
      if (!dt) return;
      root.getWorldQuaternion(q); g.set(0, -1, 0).applyQuaternion(q.invert());   // 重力在鑰匙圈自己的座標裡
      const G = 2600, damp = Math.exp(-2.2 * dt);
      vx = (vx + g.x * G * dt) * damp; vy = (vy - g.y * G * dt) * damp;            // 圖上 y 往下
      const nx = px + vx * dt, ny = py + vy * dt;
      if (fits(nx, py)) px = nx; else vx *= -0.3;
      if (fits(px, ny)) py = ny; else vy *= -0.3;
      fish.position.set(px * k, -py * k, 0);
    };
    return { root, meshes, height: H * k, tick };
  }

  async function strap() {
    const M = await meta(), [W, H] = M.strapSize, k = 0.12 / H, [ch, ins] = M.strapChamfer;
    const [o, p] = await Promise.all([tex('strap-orange'), tex('strap-pink')]);
    const root = new THREE.Group(), meshes = [], w = W * k, h = H * k;
    const s = new THREE.Shape();
    s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2 - ch * h); s.lineTo(w / 2 - ins * w, h / 2); s.lineTo(-w / 2 + ins * w, h / 2); s.lineTo(-w / 2, h / 2 - ch * h); s.closePath();
    const holeY = h / 2 - 0.0066; s.holes.push(new THREE.Path().absarc(0, holeY, 0.0028, 0, Math.PI * 2, true));
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.0016, bevelEnabled: false }).translate(0, 0, -0.0008), toon({ color: 0x141414 }));
    root.add(body); meshes.push(body);
    const a = decal(o, 0, 0, W, H, k, W / 2, H / 2, 0.00085), b = decal(p, 0, 0, W, H, k, W / 2, H / 2, -0.00085, true);
    root.add(a, b); meshes.push(a, b);
    eyelet(0, holeY, 0.0028, 0.0016, root, meshes);   // 金屬雞眼
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0125, 0.0011, 10, 48), metal()); ring.position.set(0, holeY + 0.0125 - 0.0012, 0); ring.rotation.y = Math.PI / 2; root.add(ring); meshes.push(ring);   // 穿過孔：圈和織帶垂直，最低點落在孔裡
    return { root, meshes, height: h, tick() {} };
  }

  async function snake() {
    const M = await meta(), [W, H] = M['snake-white-size'], k = 0.13 / H, cx = W / 2, cy = H / 2;
    const [wt, bt] = await Promise.all([tex('snake-white'), tex('snake-black')]);
    const root = new THREE.Group(), meshes = [];
    const s = shapeOf(M['snake-white-outline'], k, cx, cy), Hh = M['snake-white-hole'];
    s.holes.push(circle(Hh.x, Hh.y, Hh.r * 0.9, k, cx, cy));
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.0016, bevelEnabled: false, curveSegments: 6 }).translate(0, 0, -0.0008), toon({ color: 0x0c0c0c }));
    root.add(body); meshes.push(body);
    // 兩面都照織帶的外形裁切：黑蛇那面是從背面看的，所以左右鏡像貼上；貼圖不會超出織帶的邊
    const a = shapedFace(s, wt, false, 0.00085, false), b = shapedFace(s, bt, true, -0.00085, true);
    root.add(a, b); meshes.push(a, b);
    const hx = (Hh.x - cx) * k, hy = (cy - Hh.y) * k, hr = Hh.r * 0.9 * k;
    eyelet(hx, hy, hr, 0.0016, root, meshes);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0125, 0.0011, 10, 48), metal()); ring.position.set(hx, hy + 0.0125 - hr * 0.55, 0); ring.rotation.y = Math.PI / 2; root.add(ring); meshes.push(ring);   // 穿過孔：圈和織帶垂直，最低點落在孔裡
    return { root, meshes, height: H * k, tick() {} };
  }

  /* ---------- 貼紙一疊：A 雷射、B D E F 反光。平放在盒子裡是一疊；拿在手上時展開成扇形，點一張就抽出來放大，可以單獨翻轉 ---------- */
  const STICKERS = [   // 由下往上疊；寬度（公分）照總表上的標示
    { key: 'E', w: 8.3, kind: 'reflect' }, { key: 'F', w: 8.3, kind: 'reflect' }, { key: 'B', w: 10, kind: 'reflect' },
    { key: 'A', w: 10, kind: 'laser' }, { key: 'D', w: 5, kind: 'reflect' }];
  // 雷射：顏色隨觀看角度在彩虹色之間流轉，越亮的地方越明顯
  function laserMat(t) {
    const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, roughness: 0.25, metalness: 0.35, side: THREE.FrontSide });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { vec3 vd = normalize(vViewPosition); float f = dot(normalize(vNormal), vd);
          vec3 ir = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + f * 1.8 + vMapUv.x * 1.4 + vMapUv.y * 0.6));
          float lit = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.55 + ir * 0.9), 0.55 * smoothstep(0.15, 0.7, lit)); }`);
    };
    m.customProgramCacheKey = () => 'sticker-laser';
    return m;
  }
  // 反光貼紙：正對光（也就是正對你）的時候會亮起來
  function reflectMat(t) {
    const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, roughness: 0.22, metalness: 0.25, side: THREE.FrontSide });
    m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      { float f = max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0); diffuseColor.rgb *= 0.85 + 0.75 * pow(f, 6.0); }`); };
    m.customProgramCacheKey = () => 'sticker-reflect';
    return m;
  }
  // 背面的離型紙：同樣的外形，米白色
  function backTex(t) {
    const img = t.image, c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#F3F0E9'; g.fillRect(0, 0, c.width, c.height);
    const bt = new THREE.CanvasTexture(c); bt.colorSpace = THREE.SRGBColorSpace; return bt;
  }

  async function stickers() {
    const M = await meta(), root = new THREE.Group(), meshes = [], cards = [];
    const texs = await Promise.all(STICKERS.map((s) => tex('sticker-' + s.key)));
    STICKERS.forEach((s, i) => {
      const t = texs[i], [pw, ph] = M.stickers[s.key].size, w = s.w / 100, h = w * ph / pw;
      const card = new THREE.Group(), front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), s.kind === 'laser' ? laserMat(t) : reflectMat(t));
      const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: backTex(t), alphaTest: 0.5, roughness: 0.9 }));
      front.position.z = 0.00015; back.position.z = -0.00015; back.rotation.y = Math.PI;
      front.userData.card = back.userData.card = i;
      card.add(front, back); root.add(card); meshes.push(front, back);
      const R = Math.sin(i * 12.9898) * 43758.5453, rnd = R - Math.floor(R);
      cards.push({ g: card, s, w, h, stack: { x: (rnd - 0.5) * 0.012, y: (i % 2 ? 0.006 : -0.004), r: (rnd - 0.5) * 0.5, z: i * 0.0006 }, q: new THREE.Quaternion(), sel: 0 });
    });
    const st = { fan: 0, selected: -1 };
    const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _a = new THREE.Vector3();
    const layout = (dt) => {
      const n = cards.length;
      cards.forEach((c, i) => {
        c.sel += ((st.selected === i ? 1 : 0) - c.sel) * (1 - Math.exp(-dt * 8));
        // 扇形：繞著下方一點轉開，像手上的一把牌
        const a = (i - (n - 1) / 2) * 0.34, fx = Math.sin(a) * 0.11, fy = Math.cos(a) * 0.11 - 0.08, fz = i * 0.003;
        const f = st.fan, s = c.sel, others = st.selected >= 0 && st.selected !== i ? 1 : 0;
        const x = c.stack.x + (fx - c.stack.x) * f, y = c.stack.y + (fy - c.stack.y) * f, rz = c.stack.r + (-a - c.stack.r) * f;
        c.g.position.set(x * (1 - s), (y - others * 0.02 * f) * (1 - s), (c.stack.z + (fz - c.stack.z) * f - others * 0.02) * (1 - s) + s * 0.06);
        _q.setFromEuler(_e.set(0, 0, rz * (1 - s)));
        c.g.quaternion.copy(_q).slerp(c.q, s);
        c.g.scale.setScalar(1 + s * 0.45);
      });
    };
    layout(1);
    const obj = {
      root, meshes, height: 0.1,
      tick(dt) { layout(dt || 0); },
      held(e) { st.fan += ((e > 0.9 ? 1 : 0) - st.fan) * 0.12; if (e < 0.5 && st.selected >= 0) { st.selected = -1; obj.onChange && obj.onChange(); } },
      // 點一下：點到某張就抽出那張；已經抽出一張時，點別處就放回扇形
      pick(ndc, camera, layer) {
        if (st.fan < 0.5) return false;
        const r = new THREE.Raycaster(); r.setFromCamera(ndc, camera); r.layers.set(layer);
        const hit = r.intersectObjects(meshes, false)[0];
        if (hit && st.selected < 0) { st.selected = hit.object.userData.card; cards[st.selected].q.identity(); obj.onChange && obj.onChange(); return true; }
        if (st.selected >= 0) { st.selected = -1; obj.onChange && obj.onChange(); return true; }
        return false;
      },
      turn(yaw, pitch) {   // 抽出來的那張自己轉
        if (st.selected < 0) return false;
        const q = cards[st.selected].q;
        q.premultiply(_q.setFromAxisAngle(_a.set(0, 1, 0), yaw)).premultiply(_q.setFromAxisAngle(_a.set(1, 0, 0), pitch)).normalize();
        return true;
      },
      face() { if (st.selected < 0) return false; cards[st.selected].q.identity(); return true; },
      back() { if (st.selected < 0) return false; st.selected = -1; obj.onChange && obj.onChange(); return true; },
      get selectedKey() { return st.selected >= 0 ? cards[st.selected].s.key : null; },
      info: Object.fromEntries(STICKERS.map((s, i) => [s.key, { kind: s.kind, w: s.w, h: Math.round(cards[i].h * 1000) / 10 }])),
    };
    return obj;
  }

  const MAKERS = { acrylic, strap, snake, stickers };
  window.Keychains = { load: (name) => MAKERS[String(name).split('?')[0]]() };
})();
