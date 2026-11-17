/* 車隊團服（three.js r158，全域 THREE）。房主為車隊設計的 T 恤與長袖。
   一件衣服是一整張有厚度的布：前後兩片沿著衣服的外形，中間微微鼓起、邊緣收薄，表面有細小的起伏與織紋；
   正面、背面畫上底色與印花（assets/shirts/ 的去背印花，位置與大小照設計圖的比例）。
   折疊用的是圓弧的彎折：兩側先往後折，下半再往上折到後面，所以折好的衣服邊緣是圓的、有厚度。
   拿在手上翻轉時，袖子和下擺會跟不上手的速度、往反方向甩，停下來再慢慢晃回來。
   用法：Shirts.load('ride-white') → Promise<{ root, meshes, height, tick(dt), held(e) }>
   單位公尺；root 的原點在攤開時衣服的正中央，正面朝 +z、領口朝 +y。 */
(function () {
  'use strict';
  const COLORS = { white: '#F1F0EC', black: '#1D1D1F', grey: '#65777B', hood: '#3A3D3D' };
  // 每一款的印花：file 是 assets/shirts/ 裡的檔名（{c} 換成顏色）；cx, cy 是整張圖的中心、w 是整張圖的寬（公尺，照設計圖量的）
  const STYLE = {
    ride: { front: { file: 'ride-{c}-front', cx: 0.005, cy: 0.118, w: 0.35 }, back: { file: 'ride-{c}-back', cx: 0, cy: 0, w: 0.222 } },
    n1: { front: { file: 'n1-{c}-front', cx: 0.108, cy: 0.083, w: 0.079 }, back: { file: 'n1-{c}-back', cx: 0, cy: 0.037, w: 0.31 } },
    battle: { front: { file: 'battle-{c}-front', cx: 0.005, cy: 0.074, w: 0.26 }, back: { file: 'battle-{c}-back', cx: -0.03, cy: -0.25, w: 0.25 } },
    faith: { front: { file: 'faith-{c}-front', cx: 0.0, cy: 0.09, w: 0.34 }, back: { file: 'faith-{c}-back', cx: 0, cy: 0.1, w: 0.13 } },
    faithplain: { front: { file: 'faithplain-{c}-front', cx: 0.0, cy: 0.08, w: 0.36 } },   // 沒有金魚的版本：白衣黑字、黑衣白字
    // 冬季的長袖帽T（#3A3D3D）：正面同一張 X 與金魚，背面橘、粉兩款 RIDER；布料厚
    hoodorange: { hood: true, front: { file: 'ls-front', cx: 0.0, cy: 0.12, w: 0.3 }, back: { file: 'ls-back-orange', cx: 0, cy: 0.02, w: 0.32, qr: true } },
    hoodpink: { hood: true, front: { file: 'ls-front', cx: 0.0, cy: 0.12, w: 0.3 }, back: { file: 'ls-back-pink', cx: 0, cy: 0.02, w: 0.32, qr: true } },
  };
  const PX = 1024, spanOf = (st) => st.hood ? 0.62 : 0.44;   // 貼圖涵蓋 x, y ∈ [-S, S]（帽T 比較大）；每件衣服各自算，避免同時載入時互相干擾
  const A = 0.14, YF = -0.03, YH = 0.335;   // 帽T 的帽子在 YH 以上，折的時候往前蓋下來                // 折線：兩側往後折的位置 ±A；下半往上折的位置 YF
  // 外形（右半邊，從領口往下、繞到下擺中央；左半邊鏡像）：身寬 0.5、衣長約 0.73，比例照設計圖
  const NECK = (n) => { const o = []; for (let i = 0; i <= 8; i++) { const t = i / 8, x = 0.098 * t; o.push([x, n + (0.352 - n) * Math.pow(t, 2.4)]); } return o; };   // 平順的 U 形領口
  const SHORT = (n) => [...NECK(n), [0.235, 0.335], [0.235, 0.335], [0.388, 0.205], [0.357, 0.07], [0.249, 0.128], [0.252, -0.37], [0.12, -0.376], [0, -0.377]];
  const LONG = (n) => [...NECK(n), [0.235, 0.335], [0.33, 0.17], [0.425, -0.2], [0.422, -0.245], [0.345, -0.262], [0.335, -0.22], [0.262, 0.03], [0.252, -0.37], [0.12, -0.376], [0, -0.377]];
  // 帽T：身寬 0.56、衣長 0.75，長袖，帽子攤在領口上方
  const HOOD = () => [...[...Array(10)].map((_, i) => { const a = i / 9 * Math.PI / 2; return [0.19 * Math.sin(a), 0.4 + 0.18 * Math.cos(a)]; }), [0.195, 0.37], [0.27, 0.335], [0.37, 0.16], [0.46, -0.22], [0.455, -0.29], [0.37, -0.305], [0.36, -0.25], [0.29, 0.02], [0.282, -0.39], [0.13, -0.395], [0, -0.396]];
  const outline = (st, n) => { const h = st.hood ? HOOD() : (st.long ? LONG : SHORT)(n); return h.concat(h.slice(0, -1).reverse().map(([x, y]) => [-x, y])); };

  const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  async function face(st, color, side) {
    const S = spanOf(st), toPx = (x, y) => [(x + S) / (2 * S) * PX, (S - y) / (2 * S) * PX];
    const c = document.createElement('canvas'); c.width = c.height = PX; const g = c.getContext('2d');
    const ny = side === 'front' ? 0.305 : 0.345, pts = outline(st, ny), dark = color !== 'white';
    g.beginPath(); pts.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath();
    g.save(); g.clip();
    g.fillStyle = COLORS[color]; g.fillRect(0, 0, PX, PX);
    // 棉布的織紋與一點不均勻的明暗（像攤平的布，不是紙）
    g.fillStyle = g.createPattern(grain(dark), 'repeat'); g.fillRect(0, 0, PX, PX);   // 先做一小塊布紋再鋪滿（不再每件畫上萬個點）
    for (let i = 0; i < 26; i++) { const x = Math.random() * PX, y = Math.random() * PX, r = 40 + Math.random() * 160, gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${dark ? 0.05 : 0.035})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
    // 真實一點的布：腋下與領口下的陰影、肩線與側縫、下半身幾道柔軟的垂墜皺摺
    const shade = (x, y, r, a) => { const [px, py] = toPx(x, y), rr = r / (2 * S) * PX, gr = g.createRadialGradient(px, py, 0, px, py, rr); gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(px - rr, py - rr, rr * 2, rr * 2); };
    for (const sx of [-1, 1]) { shade(sx * 0.25, 0.12, 0.09, dark ? 0.3 : 0.16); shade(sx * 0.25, -0.05, 0.12, dark ? 0.12 : 0.06); }
    shade(0, ny - 0.04, 0.09, dark ? 0.2 : 0.1);
    g.lineWidth = 2.5; g.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
    for (const sx of [-1, 1]) {
      g.beginPath(); { const [a, b] = toPx(sx * 0.09, 0.352), [c, d] = toPx(sx * 0.232, 0.333); g.moveTo(a, b); g.lineTo(c, d); } g.stroke();                  // 肩線
      if (!st.hood) { g.beginPath(); { const [a, b] = toPx(sx * 0.249, 0.125), [c, d] = toPx(sx * 0.252, -0.37); g.moveTo(a, b); g.lineTo(c, d); } g.stroke(); }   // 側縫
      g.beginPath(); { const [a, b] = toPx(sx * 0.232, 0.333), [c, d] = toPx(sx * 0.249, 0.128); g.moveTo(a, b); g.quadraticCurveTo(c + sx * 10, (b + d) / 2, c, d); } g.stroke();   // 袖籠
    }
    if (st.hood) hoodDetails(g, side, S, toPx);
    // 羅紋領口：沿著 U 形領口一圈寬約 1.4 公分的帶子，帶細細的直紋，內緣有一道車縫線
    if (!st.hood) {
      const nk = NECK(ny), arc = nk.slice().reverse().map(([x, y]) => [-x, y]).concat(nk.slice(1)), bw = 0.014;
      const along = (off) => arc.map(([x, y], i) => { const [x2, y2] = arc[Math.min(arc.length - 1, i + 1)], [x1, y1] = arc[Math.max(0, i - 1)], dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy) || 1; return [x + dy / l * off, y - dx / l * off]; });
      const outer = along(-bw);   // 往衣身那一側
      g.beginPath(); arc.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? g.lineTo(px, py) : g.moveTo(px, py); }); outer.slice().reverse().forEach(([x, y]) => { const [px, py] = toPx(x, y); g.lineTo(px, py); }); g.closePath();
      g.save(); g.clip(); g.fillStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'; g.fillRect(0, 0, PX, PX);
      g.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)'; g.lineWidth = 1.5;
      arc.forEach(([x, y], i) => { if (i % 1) return; const [ox, oy] = outer[i], [a, b] = toPx(x, y), [c, d] = toPx(ox, oy); for (let k = 0; k < 3; k++) { const t = k / 3; g.beginPath(); g.moveTo(a + (arc[Math.min(arc.length - 1, i + 1)] ? 0 : 0) + t * 4, b); g.lineTo(c + t * 4, d); g.stroke(); } });
      g.restore();
      g.lineWidth = 2; g.setLineDash([5, 4]); g.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.16)';
      g.beginPath(); outer.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke(); g.setLineDash([]);
    }
    g.lineWidth = 2; g.setLineDash([6, 5]); g.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.18)';
    const cuff = st.hood ? [[0.457, -0.24], [0.362, -0.26]] : st.long ? [[0.418, -0.215], [0.34, -0.235]] : [[0.37, 0.165], [0.343, 0.09]];
    for (const s of [1, -1]) { const [a1, b1] = toPx(s * cuff[0][0], cuff[0][1]), [a2, b2] = toPx(s * cuff[1][0], cuff[1][1]); g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.stroke(); }
    if (!st.hood) { const [a1, b1] = toPx(-0.252, -0.352), [a2, b2] = toPx(0.252, -0.352); g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.stroke(); }
    g.setLineDash([]);
    const P = st[side];
    if (P) {
      const fname = P.file.replace('{c}', color);
      let img = await load(`assets/shirts/${fname}.${PNG_KEEP.has(fname) ? 'png' : 'webp'}?v=2026-11-18w`);
      if (img && P.ink) {   // 白字換成黑字，橘色保留
        const t = document.createElement('canvas'); t.width = img.width; t.height = img.height; const tg = t.getContext('2d'); tg.drawImage(img, 0, 0);
        const d = tg.getImageData(0, 0, t.width, t.height); for (let i = 0; i < d.data.length; i += 4) { const r = d.data[i], gg = d.data[i + 1], b = d.data[i + 2]; if (r > 200 && gg > 200 && b > 200) { d.data[i] = d.data[i + 1] = d.data[i + 2] = 18; } }
        tg.putImageData(d, 0, 0); img = t;
      }
      if (img && P.qr) img = coverQR(img);
      if (img) { const w = P.w / (2 * S) * PX, h = w * img.height / img.width, [cx, cy] = toPx(P.cx, P.cy); g.globalAlpha = 0.96; g.drawImage(img, cx - w / 2, cy - h / 2, w, h); g.globalAlpha = 1; }
    }
    g.restore();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const mc = document.createElement('canvas'); mc.width = mc.height = 512; const mg = mc.getContext('2d'); mg.fillStyle = '#000'; mg.fillRect(0, 0, 512, 512); mg.fillStyle = '#fff';
    mg.beginPath(); pts.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? mg.lineTo(px / 2, py / 2) : mg.moveTo(px / 2, py / 2); }); mg.closePath(); mg.fill();
    t.userData.mask = new THREE.CanvasTexture(mc);   // 外形的遮罩：衣服裡面那層布也照這個外形裁
    return t;
  }

  // 帽T 的細節：帽口與內裡、抽繩、袋鼠口袋、羅紋袖口與下擺；背面是帽子的中縫
  function hoodDetails(g, side, S, toPx) {
    const line = (pts, w, col, dash) => { g.lineWidth = w; g.strokeStyle = col; g.setLineDash(dash || []); g.beginPath(); pts.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke(); g.setLineDash([]); };
    const band = (x0, x1, y0, y1) => { const [a, b] = toPx(x0, y1), [c, d] = toPx(x1, y0); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(a, b, c - a, d - b);
      g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2; for (let x = a; x < c; x += 6) { g.beginPath(); g.moveTo(x, b); g.lineTo(x, d); g.stroke(); } };
    band(-0.282, 0.282, -0.396, -0.335);   // 下擺羅紋
    if (side === 'front') {
      // 帽子：從正面看，帽口是一圈翻過來的雙層布邊，裡面是較深的帽子內裡（圓順的拱形，不是多邊形）
      const arch = (w, top, bot) => { g.beginPath(); { const p0 = toPx(-w * 0.88, 0.3), c1 = toPx(-w * 1.12, 0.43), c2 = toPx(-w * 0.62, top), p1 = toPx(0, top), c3 = toPx(w * 0.62, top), c4 = toPx(w * 1.12, 0.43), p2 = toPx(w * 0.88, 0.3), c5 = toPx(w * 0.4, bot), c6 = toPx(-w * 0.4, bot);
        g.moveTo(...p0); g.bezierCurveTo(...c1, ...c2, ...p1); g.bezierCurveTo(...c3, ...c4, ...p2); g.bezierCurveTo(...c5, ...c6, ...p0); } };
      arch(0.158, 0.565, 0.255); g.fillStyle = 'rgba(255,255,255,0.045)'; g.fill();                   // 帽沿（雙層布，稍亮）
      arch(0.122, 0.52, 0.29); { const [cx, cy] = toPx(0, 0.39), gr = g.createRadialGradient(cx, cy, 10, cx, cy, 0.17 / (2 * S) * PX); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0.3)'); g.fillStyle = gr; g.fill(); }   // 帽子內裡
      g.setLineDash([5, 4]); g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; arch(0.14, 0.545, 0.272); g.stroke(); g.setLineDash([]);   // 帽沿的車縫線
      for (const s of [-1, 1]) {   // 抽繩，末端金屬扣
        line([[s * 0.06, 0.29], [s * 0.058, 0.22], [s * 0.05, 0.13]], 7, 'rgba(78,80,80,1)');
        const [ex, ey] = toPx(s * 0.05, 0.125); g.fillStyle = '#9a9c9c'; g.fillRect(ex - 4, ey - 2, 8, 16);
      }
      // 袋鼠口袋
      line([[-0.17, -0.1], [-0.2, -0.31], [0.2, -0.31], [0.17, -0.1], [-0.17, -0.1]], 3, 'rgba(0,0,0,0.3)', [6, 5]);
      line([[-0.17, -0.1], [0.17, -0.1]], 5, 'rgba(0,0,0,0.25)');
    } else {
      { const [a1, b1] = toPx(0, 0.578), [a2, b2] = toPx(0.012, 0.47), [a3, b3] = toPx(0, 0.36); g.setLineDash([6, 5]); g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 3; g.beginPath(); g.moveTo(a1, b1); g.quadraticCurveTo(a2, b2, a3, b3); g.stroke(); g.setLineDash([]); }   // 帽子的中縫
      { const [cx, cy] = toPx(0, 0.36), gr = g.createLinearGradient(0, cy - 30, 0, cy + 10); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)'); g.fillStyle = gr; g.fillRect(cx - 0.2 / (2 * S) * PX, cy - 30, 0.4 / (2 * S) * PX, 40); }   // 帽子接到背上的地方，一點陰影
    }
    for (const s of [-1, 1]) band(Math.min(s * 0.36, s * 0.457), Math.max(s * 0.36, s * 0.457), -0.305, -0.255);   // 袖口羅紋（大略）
  }

  // 帽T 背面的 QR code 遮起來：照範例的方式，把 QR 右下大半塊斜角填成實色（三個定位方塊留著，看得出是 QR，但掃不出來）
  function coverQR(img) {
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height; const g = t.getContext('2d'); g.drawImage(img, 0, 0);
    const k = t.width / 849, x0 = 682 * k, y0 = 1027 * k, x1 = 783 * k, y1 = 1127 * k, s = x1 - x0;
    g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(x0 + 0.16 * s, y1); g.lineTo(x1, y0 + 0.16 * s); g.lineTo(x1, y1); g.closePath(); g.fill();
    return t;
  }

  // 印花檔案大多是 WebP；這幾張顏色很少的扁平圖用 PNG 反而比較小，所以留 PNG
  const PNG_KEEP = new Set(['ls-front', 'n1-black-back', 'n1-black-front', 'n1-grey-back', 'n1-grey-front', 'n1-white-back', 'ride-black-back', 'ride-grey-back', 'ride-white-back']);

  // 棉布織紋的小磚（256 px），深色、淺色各一塊，所有衣服共用
  const GRAIN = {};
  function grain(dark) {
    if (GRAIN[dark]) return GRAIN[dark];
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    for (let i = 0; i < 1800; i++) { g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${dark ? 0.035 : 0.05})` : `rgba(0,0,0,${dark ? 0.08 : 0.04})`; g.fillRect(Math.random() * 256, Math.random() * 256, 1.4, 1.4); }
    return (GRAIN[dark] = c);
  }

  // 點到外形邊的距離（正：在裡面）
  function edgeDist(x, y, poly) {
    let inside = false, d = 9;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      const vx = xj - xi, vy = yj - yi, l2 = vx * vx + vy * vy, t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - xi) * vx + (y - yi) * vy) / l2)) : 0;   // 頭尾重疊的點：長度 0 的邊
      d = Math.min(d, Math.hypot(x - xi - vx * t, y - yi - vy * t));
    }
    return inside ? d : -d;
  }

  // 一條平的布繞著折線彎成半徑 r 的圓弧（往後），再接著往回延伸；s 是離折線的距離，z 是離布中線的距離（正面為正）
  function bend(s, z, theta, r) {
    const L = theta * r;
    if (s <= L) { const f = s / r; return [r * Math.sin(f) + z * Math.sin(f), -r + r * Math.cos(f) + z * Math.cos(f)]; }
    const cx = r * Math.sin(theta), cz = -r + r * Math.cos(theta), t = s - L;
    return [cx + t * Math.cos(theta) + z * Math.sin(theta), cz - t * Math.sin(theta) + z * Math.cos(theta)];
  }

  async function shirt(name) {
    const [model, color] = name.split('?')[0].split('-'), st = STYLE[model], S = spanOf(st); const thick = st.hood ? 1.7 : 1;
    const [ft, bt] = await Promise.all([face(st, color, 'front'), face(st, color, 'back')]);
    const base = new THREE.Color(COLORS[color]), sheenC = base.clone().lerp(new THREE.Color(0xffffff), 0.35);
    const mat = (t, side) => new THREE.MeshPhysicalMaterial({ map: t, alphaTest: 0.5, side, roughness: 0.9, metalness: 0, sheen: 1, sheenRoughness: 0.55, sheenColor: sheenC });   // 棉布：霧面，邊緣帶一點絨面的光
    // 一張網格蓋住整件衣服；外形以外的格子不要
    const N = st.hood ? 90 : 74, poly = outline(st, 0.33), rest = [], index = [], keep = new Int32Array((N + 1) * (N + 1)).fill(-1), cell = 2 * S / N;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = -S + i * cell, y = -S + j * cell, d = edgeDist(x, y, poly);
      if (d < -1.6 * cell) continue;
      // 布的厚度：中間鼓、邊緣收薄；再加上幾道柔軟的起伏
      const k = Math.min(1, Math.max(0, d) / 0.07), puff = 0.0058 * thick * Math.pow(k, 0.55);   // 一層布攤平時的蓬鬆度（前後各一半）
      const wr = (0.0026 * Math.sin(x * 21 + y * 8) * Math.sin(y * 15 - x * 5) + 0.0016 * Math.sin(x * 47 - y * 31)) * Math.min(1, Math.max(0, d) / 0.04);
      keep[j * (N + 1) + i] = rest.length; rest.push([x, y, puff + wr, puff - wr * 0.6]);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = keep[j * (N + 1) + i], b = keep[j * (N + 1) + i + 1], c = keep[(j + 1) * (N + 1) + i], d = keep[(j + 1) * (N + 1) + i + 1];
      if (a >= 0 && b >= 0 && c >= 0) index.push(a, b, c);
      if (b >= 0 && d >= 0 && c >= 0) index.push(b, d, c);
    }
    const n = rest.length;
    const SS = S;
    const mk = (back) => {
      const g = new THREE.BufferGeometry(), U = new Float32Array(n * 2);
      rest.forEach(([x, y], q) => { const u = (x + SS) / (2 * SS), v = (y + SS) / (2 * SS); U[q * 2] = back ? 1 - u : u; U[q * 2 + 1] = v; });
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('uv', new THREE.BufferAttribute(U, 2)); g.setIndex(index);
      return g;
    };
    const gf = mk(false), gb = mk(true);
    const mf = new THREE.Mesh(gf, mat(ft, THREE.FrontSide)), mb = new THREE.Mesh(gb, mat(bt, THREE.BackSide));
    mf.castShadow = mb.castShadow = mf.receiveShadow = mb.receiveShadow = true;
    const inside = new THREE.MeshPhysicalMaterial({ color: base.clone().multiplyScalar(0.72), roughness: 0.95, sheen: 0.6, sheenColor: sheenC });
    const mfi = new THREE.Mesh(gf, Object.assign(inside.clone(), { side: THREE.BackSide, alphaMap: ft.userData.mask, alphaTest: 0.5 })), mbi = new THREE.Mesh(gb, Object.assign(inside.clone(), { side: THREE.FrontSide, alphaMap: bt.userData.mask, alphaTest: 0.5 }));   // 衣服裡面：從領口看進去的那層布（照外形裁）
    const root = new THREE.Group(); root.add(mf, mb, mfi, mbi);
    const collars = [];

    const AA = st.hood ? 0.16 : A;   // 帽T 比較寬，折線往外一點
    let fold = 1, want = 1, dirty = true;
    const sw = { x: 0, vx: 0, y: 0, vy: 0 }, qPrev = new THREE.Quaternion(), qNow = new THREE.Quaternion(), qd = new THREE.Quaternion(); let qInit = false;
    const ease = (x) => x * x * (3 - 2 * x);
    const pose = () => {
      const fb = ease(Math.min(1, Math.max(0, (fold - 0.5) / 0.5))), fs = ease(Math.min(1, fold / 0.5)), open = 1 - fold;   // 攤開：先放下半，再攤開兩側
      const Pf = gf.attributes.position.array, Pb = gb.attributes.position.array;
      for (let q = 0; q < n; q++) {
        const [x0, y0, zf, zb] = rest[q];
        for (let side = 0; side < 2; side++) {
          let x = x0, y = y0, z = side ? -zb : zf;
          if (open > 0.01) {
            z += open * (sw.x * x * Math.abs(x) * 2.4 + sw.y * Math.min(0, y) * Math.abs(y) * 2.6);   // 甩動：兩側與下擺落後
            const ax = Math.abs(x) - (st.hood ? 0.28 : 0.25);
            if (ax > 0 && y > -0.3) { y -= open * 0.14 * ax * ax / 0.15; z -= open * 0.03 * ax; }   // 拎著肩膀：袖子微微往下垂、往後一點
            const low = Math.min(1, Math.max(0, (0.05 - y) / 0.42));
            z += open * low * (0.009 * Math.sin(x * 26 + 0.7) + 0.005 * Math.sin(x * 47 + 2.1));   // 下半身柔軟的垂墜皺摺（前後兩片一起動）
            y -= open * 0.006 * low * low;
          }
          if (st.hood && fs > 0.001 && y > YH) { const [p, w] = bend(y - YH, -z, Math.PI * fs, 0.016); y = YH + p; z = -w; }   // 帽子往前蓋下來
          if (fs > 0.001 && Math.abs(x) > AA) { const s = Math.sign(x), [p, w] = bend(Math.abs(x) - AA, z, Math.PI * fs, (s < 0 ? 0.0065 : 0.0095) * thick); x = s * (AA + p); z = w; }
          if (fb > 0.001 && y < YF) { const [p, w] = bend(YF - y, z, Math.PI * fb, 0.0135 * thick); y = YF - p; z = w; }
          const arr = side ? Pb : Pf; arr[q * 3] = x; arr[q * 3 + 1] = y; arr[q * 3 + 2] = z;
        }
      }
      gf.attributes.position.needsUpdate = gb.attributes.position.needsUpdate = true;
      gf.computeVertexNormals(); gb.computeVertexNormals(); gf.computeBoundingSphere(); gb.computeBoundingSphere();
    };
    pose();
    return {
      root, meshes: [mf, mb, mfi, mbi, ...collars], height: 0.73,
      tick(dt) {
        if (!dt) return;
        if (fold !== want) { const stp = dt * 1.3; fold = want > fold ? Math.min(want, fold + stp) : Math.max(want, fold - stp); dirty = true; }
        // 甩動：用衣服轉動的角速度推動兩個彈簧（左右、上下），布跟在後面，停下來後晃幾下才靜止
        root.getWorldQuaternion(qNow);
        if (qInit && fold < 0.99) {
          qd.copy(qPrev).invert().multiply(qNow);
          const ang = 2 * Math.acos(Math.min(1, Math.abs(qd.w))), sn = Math.sqrt(Math.max(1e-9, 1 - qd.w * qd.w)), sg = qd.w < 0 ? -1 : 1;
          const wy = ang > 1e-5 ? sg * qd.y / sn * ang / dt : 0, wx = ang > 1e-5 ? sg * qd.x / sn * ang / dt : 0, K = 55, C = 5;
          sw.vx += (K * (-Math.max(-6, Math.min(6, wy)) * 0.022 - sw.x) - C * sw.vx) * dt; sw.x += sw.vx * dt;
          sw.vy += (K * (Math.max(-6, Math.min(6, wx)) * 0.022 - sw.y) - C * sw.vy) * dt; sw.y += sw.vy * dt;
          if (Math.abs(sw.x) + Math.abs(sw.y) + Math.abs(sw.vx) + Math.abs(sw.vy) > 1e-4) dirty = true;
        }
        qPrev.copy(qNow); qInit = true;
        if (dirty) { pose(); dirty = false; }
      },
      held(e) { want = e > 0.97 ? 0 : 1; },
    };
  }
  window.Shirts = { load: shirt };
})();
