/* 車隊的帽子（three.js r158，全域 THREE）：灰色平簷帽（snapback，六片帽冠）。
   帽冠：前面挺直、頂部圓而平、後面略低；六片布的接縫兩側有車縫線，每片上方一個繡出來的透氣孔，頂端布包扣。
   帽簷：平直的新月形，貼著帽冠前緣，上面一圈圈車縫線，右側貼安全帽反光貼紙。
   印花：正面 GOLDFISH BRAIN / HELMET MASTERPIECE 與金魚、左側縫上黑色 RIDE SAVE 布標、背面 Since 2023 June、後面半月形開口與扣帶。
   用法：Caps.load('cap') → Promise<{ root, meshes, height, tick() }>；單位公尺，root 原點在帽子中間，帽簷朝 +z、上方 +y。 */
(function () {
  'use strict';
  const V = '2026-11-18i';
  const W = 0.094, D = 0.102;                      // 帽冠底圈：半寬（左右）、半深（前後）
  const HF = 0.118, HB = 0.094;                    // 帽冠高：前面、後面
  const SEAMS = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];   // 六片布的接縫（u：0 在正前方，繞一圈到 1）
  const BASE = '#97989b';
  const tex = (n) => new Promise((ok) => { const t = new THREE.TextureLoader().load(`assets/caps/${n}.webp?v=${V}`, () => ok(t), undefined, () => ok(t)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; });

  // 帽冠上的一點：u 繞一圈（0 在正前方，往 +x 繞），v 從帽緣 0 到頂 1
  const front = (u) => 0.5 + 0.5 * Math.cos(u * Math.PI * 2);   // 1 在正前方，0 在正後方
  function seamPinch(u, v) { let p = 0; for (const s of SEAMS) { let d = Math.abs(u - s); d = Math.min(d, 1 - d); p = Math.max(p, Math.exp(-((d / 0.011) ** 2))); } return p * Math.sin(Math.min(1, v * 1.4) * Math.PI / 2) * (1 - v * 0.7); }
  function crownPoint(u, v, pinch = true) {
    const a = u * Math.PI * 2, f = front(u);
    const n = 2.35 + 1.05 * f;                                // 前面較挺、後面較圓
    const rr = Math.pow(Math.max(0, 1 - Math.pow(v, n)), 1 / n);
    const r = rr * (1 - (pinch ? 0.014 * seamPinch(u, v) : 0)); // 接縫處微微凹下，每片布鼓起
    const x = Math.sin(a) * W * r, z = Math.cos(a) * D * r;
    const y = v * 0.106 * (1 - 0.05 * (1 - rr) * (1 - rr)) + 0.11 * z * Math.sin(v * Math.PI / 2) * (1 - v * 0.6);   // 所有布片在頂端匯成一點；整頂往前抬一點（前高後低）
    return new THREE.Vector3(x, y, z);
  }
  // 某高度一圈的周長（用來把貼圖上的東西換算成公尺）
  const circ = (v) => { let L = 0, p = crownPoint(0, v, false); for (let i = 1; i <= 64; i++) { const q = crownPoint(i / 64, v, false); L += p.distanceTo(q); p = q; } return L; };

  // 反光貼紙：正對你的時候亮起來（像反光材質），上面還有一層亮面
  function reflective(t) {
    const m = new THREE.MeshPhysicalMaterial({ map: t, alphaTest: 0.5, roughness: 0.28, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
    m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      { float f = max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0); diffuseColor.rgb *= 0.8 + 0.9 * pow(f, 8.0); }`); };
    m.customProgramCacheKey = () => 'retroreflective';
    return m;
  }

  // 布紋底：細細的斜紋與雜點
  const tiles = {};
  function weave(g, w, h, base, k = 1) {   // 一小塊斜紋布（128 px）鋪滿整張，不逐點運算
    const key = base + k;
    if (!tiles[key]) { const c = document.createElement('canvas'); c.width = c.height = 128; const tg = c.getContext('2d'); tg.fillStyle = base; tg.fillRect(0, 0, 128, 128);
      const id = tg.getImageData(0, 0, 128, 128), d = id.data;
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const i = (y * 128 + x) * 4, tw = ((x + y) % 4 < 2 ? 4 : -4) * k, nz = (Math.random() - 0.5) * 10 * k; for (let q = 0; q < 3; q++) d[i + q] = Math.max(0, Math.min(255, d[i + q] + tw + nz)); }
      tg.putImageData(id, 0, 0); tiles[key] = c; }
    g.fillStyle = g.createPattern(tiles[key], 'repeat'); g.fillRect(0, 0, w, h);
  }


  // 帽冠的貼圖（u, v 空間）：接縫與車縫線、透氣孔、底邊、後面開口的包邊、布標、背面字
  function crownTextures(sideImg) {
    const CW = 2048, CH = 1024, c = document.createElement('canvas'); c.width = CW; c.height = CH; const g = c.getContext('2d');
    const b = document.createElement('canvas'); b.width = CW / 2; b.height = CH / 2; const bg = b.getContext('2d'); bg.fillStyle = '#808080'; bg.fillRect(0, 0, CW / 2, CH / 2);
    weave(g, CW, CH, BASE);
    const X = (u) => u * CW, Y = (v) => (1 - v) * CH;
    const C = []; for (let k = 0; k <= 40; k++) C.push(circ(k / 40));
    const L = (v) => Math.max(0.01, C[Math.round(Math.min(1, v) * 40)]);
    const OP = { u: 0.5, hu: 0.062, hv: 0.36 };   // 後面開口（半橢圓）
    const inOpen = (u, v) => ((u - OP.u) / OP.hu) ** 2 + (v / OP.hv) ** 2 < 1.15;
    const path = (fu, v0, v1, ctx = g, sx = 1) => { ctx.beginPath(); let first = true; for (let k = 0; k <= 60; k++) { const v = v0 + (v1 - v0) * k / 60, u = fu(v); if (inOpen(((u % 1) + 1) % 1, v)) { first = true; continue; } const x = X(u) * sx, y = Y(v) * sx; first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false; } };
    // 接縫：中間一道陰影、兩側各一排車縫線（離接縫 3.5 毫米）
    for (const s of SEAMS) for (const wrap of [0, 1, -1]) {
      const su = s + wrap;
      g.strokeStyle = 'rgba(40,40,44,0.35)'; g.lineWidth = 3; path(() => su, 0, 0.985); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.1)'; g.lineWidth = 2; path(() => su + 2 / CW, 0, 0.985); g.stroke();
      for (const side of [-1, 1]) { g.setLineDash([7, 5]); g.strokeStyle = 'rgba(60,60,64,0.55)'; g.lineWidth = 1.6; path((v) => su + side * 0.0035 / L(v), 0.02, 0.95); g.stroke(); g.setLineDash([]); }
      bg.strokeStyle = '#5a5a5a'; bg.lineWidth = 3; path(() => su, 0, 0.985, bg, 0.5); bg.stroke();
    }
    // 帽緣：一道車縫線
    g.setLineDash([7, 5]); g.strokeStyle = 'rgba(60,60,64,0.5)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(0, Y(0.045)); g.lineTo(CW, Y(0.045)); g.stroke(); g.setLineDash([]);
    // 透氣孔：每片中間上方，繡出來的小圓孔（深色孔＋一圈密密的繡線）
    for (let k = 0; k < 6; k++) {
      const u = (k + 0.5) / 6, v = 0.66, rx = 0.0021 / L(v) * CW, ry = 0.0021 / 0.11 * CH * 0.85, x = X(u), y = Y(v);
      g.fillStyle = 'rgba(140,141,144,1)'; g.beginPath(); g.ellipse(x, y, rx * 1.9, ry * 1.9, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(110,110,114,0.35)'; g.lineWidth = 1; for (let a = 0; a < Math.PI * 2; a += 0.22) { g.beginPath(); g.moveTo(x + Math.cos(a) * rx * 1.05, y + Math.sin(a) * ry * 1.05); g.lineTo(x + Math.cos(a) * rx * 1.85, y + Math.sin(a) * ry * 1.85); g.stroke(); }
      g.fillStyle = '#2c2c30'; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
      bg.fillStyle = '#b0b0b0'; bg.beginPath(); bg.ellipse(x / 2, y / 2, rx * 0.95, ry * 0.95, 0, 0, Math.PI * 2); bg.fill(); bg.fillStyle = '#404040'; bg.beginPath(); bg.ellipse(x / 2, y / 2, rx / 2, ry / 2, 0, 0, Math.PI * 2); bg.fill();
    }
    // 後面開口的包邊（一圈布條＋車縫線）
    g.save(); g.lineWidth = 0.008 / L(0.2) * CW; g.strokeStyle = '#86878a'; g.beginPath(); g.ellipse(X(OP.u), Y(0), OP.hu * CW + g.lineWidth / 2, OP.hv * CH + g.lineWidth / 2, 0, Math.PI, 0); g.stroke();
    g.setLineDash([7, 5]); g.lineWidth = 1.6; g.strokeStyle = 'rgba(60,60,64,0.6)'; g.beginPath(); g.ellipse(X(OP.u), Y(0), OP.hu * CW + 0.006 / L(0.2) * CW, OP.hv * CH + 0.006 / L(0.2) * CW, 0, Math.PI, 0); g.stroke(); g.restore();
    // 背面的刺繡字 Since 2023 June：開口上方，約 5.5 公分寬，排成微微的拱形
    { const v = 0.55, wPx = 0.055 / L(v) * CW, hPx = 0.0085 / HB * CH, txt = 'Since 2023 June', R = 820;
      g.save(); g.translate(X(0.5), Y(v)); g.scale(wPx / 600, hPx / 62); g.font = '700 70px "Helvetica Neue",Arial,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#1c1c1f';
      const ws = [...txt].map((ch) => g.measureText(ch).width), tot = ws.reduce((p, q) => p + q, 0); let acc = -tot / 2;
      [...txt].forEach((ch, i) => { const th = (acc + ws[i] / 2) / R; acc += ws[i]; g.save(); g.translate(R * Math.sin(th), R - R * Math.cos(th)); g.rotate(th); g.fillText(ch, 0, 0); g.restore(); });
      g.restore(); }
    // 左側的 RIDE SAVE 黑色布標：約 3.2 × 2.4 公分，縫在側面中下方
    { const u = 0.785, v = 0.36, wPx = 0.032 / L(v) * CW, hPx = 0.024 / HF * CH * 1.05, x = X(u) - wPx / 2, y = Y(v) - hPx / 2;
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x + 3, y + 4, wPx, hPx);
      g.drawImage(sideImg, x, y, wPx, hPx);
      g.setLineDash([5, 4]); g.strokeStyle = 'rgba(150,150,150,0.6)'; g.lineWidth = 1.4; g.strokeRect(x + 5, y + 5, wPx - 10, hPx - 10); g.setLineDash([]);
      bg.fillStyle = '#909090'; bg.fillRect(x / 2, y / 2, wPx / 2, hPx / 2); }
    // 開口的遮罩
    const m = document.createElement('canvas'); m.width = 1024; m.height = 512; const mg = m.getContext('2d'); mg.fillStyle = '#fff'; mg.fillRect(0, 0, 1024, 512); mg.fillStyle = '#000'; mg.beginPath(); mg.ellipse(512, 512, OP.hu * 1024, OP.hv * 512, 0, Math.PI, 0); mg.fill();
    const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
    return { map, bump: new THREE.CanvasTexture(b), alpha: new THREE.CanvasTexture(m), OP };
  }

  // 帽簷：內緣沿著帽冠前半圈；外緣是圓角的方形（超橢圓），一直寬到帽冠兩側
  const BR = { ri: 0.985, outX: 1.03, outZ: 0.076, m: 3.3 };
  function brimPt(a, f) {
    const s = Math.sin(a), c = Math.cos(a), e = 2 / BR.m;
    const ix = s * W * BR.ri, iz = c * D * BR.ri, ox = Math.sign(s) * Math.pow(Math.abs(s), e) * W * BR.outX, oz = Math.pow(Math.abs(c), e) * (D * BR.ri + BR.outZ);
    return [ix + (ox - ix) * f, iz + (oz - iz) * f];
  }
  const zIn = (x) => D * BR.ri * Math.sqrt(Math.max(0, 1 - (x / (W * BR.ri)) ** 2));
  const brimY = (x, z) => -0.0012 - 0.011 * Math.pow(Math.max(0, z - zIn(x)) / 0.08, 2);   // 往前微微下垂（帽簷上任何一點都照這個高度，貼紙才貼得服貼）
  const brimUV = (x, z) => [x / 0.11 * 0.5 + 0.5, z / 0.2];
  function brimTexture(top) {
    const S = 1024, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    weave(g, S, S, top ? BASE : '#88898c', 0.8);
    if (top) {   // 一圈圈跟著外緣的車縫線
      g.setLineDash([6, 5]); g.strokeStyle = 'rgba(60,60,64,0.5)'; g.lineWidth = 1.8;
      for (let k = 1; k <= 8; k++) { const f = 1 - k * 0.07; g.beginPath(); for (let i = 0; i <= 120; i++) { const [x, z] = brimPt(-Math.PI / 2 + Math.PI * i / 120, f), [u, v] = brimUV(x, z); i ? g.lineTo(u * S, (1 - v) * S) : g.moveTo(u * S, (1 - v) * S); } g.stroke(); }
      g.setLineDash([]);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  // 主視覺的投影：像參考圖那樣從正前方略高的地方看過去，帽冠前片和帽簷一起接住整張圖
  const PT = 0.42, PW = 0.1296, PH = 0.1296 * 579 / 643, PTOP = 0.0565;   // 主視覺寬約 13 公分
  const printUV = (x, y, z) => [0.5 + (x + 0.004) / PW, (y * Math.cos(PT) - z * Math.sin(PT) - (PTOP - PH)) / PH];

  async function cap() {
    const [ft, st, sk] = await Promise.all([tex('cap-front'), tex('cap-side'), tex('cap-sticker')]);
    const root = new THREE.Group(), meshes = [], inner = new THREE.Group(); inner.position.y = -0.055; root.add(inner);
    const add = (g, m) => { const o = new THREE.Mesh(g, m); o.castShadow = o.receiveShadow = true; inner.add(o); meshes.push(o); return o; };
    const CT = crownTextures(st.image);
    const sheen = { sheen: 0.7, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xcfd0d3) };
    const cloth = new THREE.MeshPhysicalMaterial({ map: CT.map, bumpMap: CT.bump, bumpScale: 2.5, alphaMap: CT.alpha, alphaTest: 0.5, roughness: 0.93, ...sheen, side: THREE.FrontSide });
    const lining = new THREE.MeshStandardMaterial({ color: 0x6c6d70, roughness: 0.95, alphaMap: CT.alpha, alphaTest: 0.5, side: THREE.BackSide });

    // 帽冠
    const NU = 144, NV = 40, P = [], UV = [], I = [];
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) { const u = i / NU, v = 1 - Math.pow(1 - j / NV, 1.15), p = crownPoint(u, v); P.push(p.x, p.y, p.z); UV.push(u, v); }
    const id = (i, j) => j * (NU + 1) + i;
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { const a = id(i, j), b = id(i + 1, j), c = id(i, j + 1), d = id(i + 1, j + 1); I.push(a, b, c, b, d, c); }
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); cg.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); cg.setIndex(I); cg.computeVertexNormals();
    { const n = cg.attributes.normal; for (let i = id(0, NV); i <= id(NU, NV); i++) n.setXYZ(i, 0, 1, 0); }   // 帽頂匯在一點：法線統一朝上
    add(cg, cloth); add(cg, lining);
    // 帽頂的布包扣
    const tp = crownPoint(0, 1), btn = add(new THREE.SphereGeometry(0.0085, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0x939497, roughness: 0.9, ...sheen }));
    btn.position.set(0, tp.y - 0.002, tp.z); btn.scale.y = 0.42;

    // 主視覺：同一個投影同時貼在帽冠前片與帽簷上（圖下半部延伸到帽簷），只留圖的範圍
    const printM = new THREE.MeshPhysicalMaterial({ map: ft, alphaTest: 0.5, roughness: 0.75, sheen: 0.3, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const printOn = (geo, facing) => {
      const g = geo.clone(), pos = g.attributes.position, nrm = g.attributes.normal, uv = new Float32Array(pos.count * 2), idx = [], src = g.index.array;
      for (let i = 0; i < pos.count; i++) { const [u, v] = printUV(pos.getX(i), pos.getY(i), pos.getZ(i)); uv[i * 2] = u; uv[i * 2 + 1] = v; }
      const ok = (q) => uv[q * 2] > -0.02 && uv[q * 2] < 1.02 && uv[q * 2 + 1] > -0.02 && uv[q * 2 + 1] < 1.02 && (!facing || nrm.getY(q) * Math.sin(PT) + nrm.getZ(q) * Math.cos(PT) > 0.12);
      for (let k = 0; k < src.length; k += 3) if (ok(src[k]) && ok(src[k + 1]) && ok(src[k + 2])) idx.push(src[k], src[k + 1], src[k + 2]);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); return add(g, printM);
    };
    printOn(cg, true);

    // 帽簷：圓角方形的平板（內緣貼著帽冠前緣），厚 4 毫米，往前微微下垂
    {
      const NA = 96, NF = 12, T = 0.0042;
      const surf = (dy, up) => {
        const P = [], UV = [], I = [];
        for (let j = 0; j <= NF; j++) for (let k = 0; k <= NA; k++) { const [x, z] = brimPt(-Math.PI / 2 + Math.PI * k / NA, j / NF); P.push(x, brimY(x, z) + dy, z); UV.push(...brimUV(x, z)); }
        for (let j = 0; j < NF; j++) for (let k = 0; k < NA; k++) { const a = j * (NA + 1) + k, b = a + 1, c = a + NA + 1, d = c + 1; up ? I.push(a, c, b, b, c, d) : I.push(a, b, c, b, d, c); }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setIndex(I); g.computeVertexNormals(); return g;
      };
      const mk = (t) => new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.92, ...sheen, side: THREE.DoubleSide });
      const topG = surf(T, true);
      add(topG, mk(brimTexture(true))); add(surf(0, false), mk(brimTexture(false)));
      printOn(topG, false);
      // 外緣的側邊（包邊）
      const P = [], I = [];
      for (let k = 0; k <= NA; k++) { const [x, z] = brimPt(-Math.PI / 2 + Math.PI * k / NA, 1), y = brimY(x, z); P.push(x, y, z, x, y + T, z); }
      for (let k = 0; k < NA; k++) { const a = k * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); eg.setIndex(I); eg.computeVertexNormals();
      add(eg, new THREE.MeshStandardMaterial({ color: 0x86878a, roughness: 0.9, side: THREE.DoubleSide }));
      // 反光貼紙：帽簷右前方，順著帽簷的弧度貼平（每個點都照帽簷高度）
      const sg = new THREE.PlaneGeometry(0.038, 0.034, 12, 12), sp = sg.attributes.position, cx = 0.036, cz = 0.128, rot = -0.12;
      for (let i = 0; i < sp.count; i++) { const lx = sp.getX(i), ly = sp.getY(i), x = cx + lx * Math.cos(rot) - ly * Math.sin(rot), z = cz - (lx * Math.sin(rot) + ly * Math.cos(rot)); sp.setXYZ(i, x, brimY(x, z) + T + 0.0009, z); }
      sg.computeVertexNormals(); { const n = sg.attributes.normal; if (n.getY(0) < 0) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); }
      const st2 = add(sg, reflective(sk)); st2.material.side = THREE.DoubleSide; st2.renderOrder = 2;
    }

    // 後面的扣帶：灰色布條橫過開口下方，旁邊一個黑色的扣
    {
      const P = [], I = [], u0 = 0.5 - CT.OP.hu - 0.012, u1 = 0.5 + CT.OP.hu + 0.012;
      for (let k = 0; k <= 24; k++) { const u = u0 + (u1 - u0) * k / 24; for (const y of [0, 0.012]) { const p = crownPoint(u, 0.05, false).multiplyScalar(1.012); P.push(p.x, y, p.z); } }
      for (let k = 0; k < 24; k++) { const a = k * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
      add(g, new THREE.MeshPhysicalMaterial({ color: 0x8f9093, roughness: 0.9, ...sheen, side: THREE.DoubleSide }));
      const p = crownPoint(0.5 + CT.OP.hu * 0.8, 0.05, false).multiplyScalar(1.03), buckle = add(new THREE.BoxGeometry(0.011, 0.014, 0.0025), new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.4, metalness: 0.5 }));
      p.y = 0.0065; buckle.position.copy(p); buckle.lookAt(p.x * 2, 0.0065, p.z * 2);
    }
    return { root, meshes, height: 0.2, tick() {} };
  }
  window.Caps = { load: cap };
})();
