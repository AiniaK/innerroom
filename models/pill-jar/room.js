/* 羽毛膠囊（大學時期的作品）：一個玻璃藥罐，裝著許多透明膠囊，每顆膠囊裡是一根小羽毛。
   吞下裝著羽毛的膠囊，就能獲得自由。
   全部在這裡用程式做出來（three.js r158，全域 THREE），尺寸照實物：玻璃蓋的藥罐（直徑 6 公分、含蓋高 11.2 公分），0 號膠囊長 2.2 公分。
   用法：PillJar.load() → Promise<{ root, meshes, height, tick(), setEnvMap(tex) }>；root 原點在藥罐正中央。 */
(function () {
  'use strict';
  const R = 0.03, JAR_H = 0.088, T = 0.0024, BASE_T = 0.006;   // 瓶身外半徑、瓶身高、壁厚、厚底
  const TOTAL = 0.112;                                          // 含蓋總高
  const CR = 0.0038, CL = 0.0217;                               // 膠囊半徑、全長
  const N_PILLS = 70, FILL_TOP = 0.062;                         // 膠囊數、最高堆到哪裡

  /* ---------- 玻璃：和金魚酒杯同一套（邊緣與反光看得見，正面幾乎透明） ---------- */
  const VERT = `
    varying vec3 vN; varying vec3 vP;
    void main(){
      mat4 m = modelViewMatrix; mat3 nm = normalMatrix;
      #ifdef USE_INSTANCING
        m = modelViewMatrix * instanceMatrix; nm = normalMatrix * mat3(instanceMatrix);
      #endif
      vec4 mv = m * vec4(position,1.0); vP = mv.xyz; vN = nm * normal; gl_Position = projectionMatrix * mv; }`;
  const STUDIO = `
    float band(float x, float a, float b, float s){ return smoothstep(a-s,a+s,x)*(1.0-smoothstep(b-s,b+s,x)); }
    float studio(vec3 r){
      float vert = 1.0 - smoothstep(0.55, 0.92, abs(r.y));
      float s = band(r.x, 0.40, 0.60, 0.05) * 0.85 * vert;
      s += band(-r.x, 0.50, 0.76, 0.05) * vert;
      s += band(-r.x, 0.86, 0.93, 0.02) * 0.5 * vert;
      s += band(r.y, 0.78, 0.95, 0.05) * 0.45;
      return s; }`;
  const GLASS = `
    uniform float uGain; uniform vec3 uEdge; uniform vec3 uBase; uniform float uA0; varying vec3 vN; varying vec3 vP;
    ${STUDIO}
    void main(){
      vec3 v = normalize(-vP); vec3 n = normalize(vN); if (dot(n,v) < 0.0) n = -n;
      float ndv = clamp(dot(n,v),0.0,1.0); vec3 r = reflect(-v,n);
      float aEdge = pow(1.0-ndv,5.0)*0.7;
      float aSpec = studio(r)*(0.16+0.55*pow(1.0-ndv,1.5));
      float a = uA0 + aEdge + aSpec;
      vec3 col = (uBase*uA0 + uEdge*aEdge + vec3(1.0)*aSpec)/a;
      gl_FragColor = vec4(col, clamp(a*uGain,0.0,1.0));
      #include <colorspace_fragment>
    }`;
  const clear = (gain, a0, edge) => glass({ side: THREE.FrontSide, gain, edge: edge || 0xb4bfba, base: 0xf4f8f6, a0 });   // 乾淨的透明玻璃，只在厚的地方帶一點點青
  const glass = (o) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: GLASS, transparent: true, depthWrite: false, side: o.side,
    uniforms: { uGain: { value: o.gain }, uEdge: { value: new THREE.Color(o.edge) }, uBase: { value: new THREE.Color(o.base) }, uA0: { value: o.a0 } } });

  // 種子亂數：每次打開都是同一堆膠囊
  const rng = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647);

  /* ---------- 羽毛：白色小羽毛，羽軸與蓬鬆的羽絲（下半部是絨毛） ---------- */
  /* 真實構造的小羽毛（沿 +y，長 L，原點在中間）：
     羽軸：由粗到細、微微彎；最下面一小段是光禿的羽管。
     羽片：羽軸兩側一根根斜向羽尖、微微彎的羽枝，整片稍微往內凹，羽枝末端漸漸透明。
     絨羽：靠近羽管的下半段，蓬鬆、捲曲、往四面八方散開的絨毛。
     每根羽枝是一條很細的帶子（兩個三角形一段），用頂點顏色的透明度做出末端變淡。 */
  function featherGeo(L) {
    const r = rng(9), P = [], C = [], I = [];
    const y0 = -L / 2, axisX = (t) => 0.035 * L * Math.sin(Math.PI * t);   // 羽軸微彎
    const axis = (t) => [axisX(t), y0 + L * t, 0];
    // 一條帶子：沿著點列，寬度 w0→w1，透明度 a0→a1，寬的方向用 side（單位向量）
    const ribbon = (pts, w0, w1, a0, a1, side) => {
      const base = P.length / 3;
      pts.forEach((p, i) => { const k = i / (pts.length - 1), w = (typeof w0 === 'function' ? w0(k) : w0 + (w1 - w0) * k) / 2, a = a0 + (a1 - a0) * k;
        P.push(p[0] - side[0] * w, p[1] - side[1] * w, p[2] - side[2] * w, p[0] + side[0] * w, p[1] + side[1] * w, p[2] + side[2] * w);
        C.push(1, 1, 0.985, a, 1, 1, 0.985, a); });
      for (let i = 0; i < pts.length - 1; i++) { const a = base + i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    };
    // 羽軸（兩條交叉的帶子，從哪個角度看都有粗細）
    const RT = [0, 0.0015, 0.004, 0.0075, 0.012, 0.017, 0.022, 0.03, 0.045, 0.07]; for (let i = 1; i <= 24; i++) RT.push(0.07 + 0.93 * i / 24);
    const rach = RT.map((t) => axis(t * 0.97));   // 羽軸停在羽尖接合點前面   // 底端很密，才收得圓
    const rw = (k0) => (k) => { const t = RT[Math.round(k * (RT.length - 1))], tip = Math.min(1, t / 0.022); return k0 * Math.sqrt(Math.max(0, 1 - (1 - tip) * (1 - tip))) * (1 - 0.82 * t); };   // 羽管底端圓潤收口，往羽尖越來越細
    ribbon(rach, rw(0.036 * L), 0, 1, 0.9, [1, 0, 0]); ribbon(rach, rw(0.032 * L), 0, 1, 0.9, [0, 0, 1]);
    // 羽片：先定好外形（底下漸寬，到羽尖兩側收合在羽軸延伸出去的一點），每根羽枝從羽軸長到外形上。
    // 羽枝細、末端淡到幾乎透明，看起來輕盈
    const HW = 0.2 * L, yA = y0 + L * 1.03, yc = y0 + L * 0.72;
    const outline = (y) => { const tb = (y - y0) / L;
      if (y >= yA) return 0;
      if (y > yc) return HW * Math.pow(Math.max(0, 1 - Math.pow((y - yc) / (yA - yc), 1.8)), 0.62);   // 羽尖：兩側收合成圓潤、略尖的弧
      return HW * Math.pow(Math.sin(Math.PI / 2 * Math.min(1, Math.max(0, (tb - 0.34) / 0.3))), 0.55); };   // 底下漸寬
    for (const sgn of [-1, 1]) for (let j = 0; j < 46; j++) {
      // 先決定羽枝末端落在外形上的哪裡（從羽片下緣一路排到羽尖），再回推它從羽軸哪裡長出來；靠近羽尖的都從羽軸末端往前展開，在尖端收合
      const ey = y0 + L * (0.5 + (1.03 - 0.004 - 0.5) * Math.pow((j + 0.3 + r() * 0.4) / 46, 0.9));
      const ay = Math.min(Math.max(ey - 1.45 * outline(ey) - 0.02 * L, y0 + 0.34 * L), y0 + 0.965 * L), ax = axisX((ay - y0) / L);
      const ex = axisX(Math.min(1, (ey - y0) / L)) + sgn * outline(ey) * (0.9 + r() * 0.12);
      const dx = ex - ax, dy = ey - ay, dl = Math.hypot(dx, dy); if (dl < 0.01 * L) continue;
      const nx = -dy / dl, ny = dx / dl, pts = [];
      for (let i = 0; i <= 5; i++) { const u = i / 5, c = 0.07 * dl * u * (1 - u) * sgn;   // 羽枝微微彎
        const x = ax + dx * u + nx * c, y = ay + dy * u + ny * c; pts.push([x, y, 0.09 * L * (Math.abs(x - ax) / HW) ** 2]); }   // 整片往內凹
      const wk = Math.min(1, dl / (0.1 * L));
      ribbon(pts, 0.012 * L * wk, 0.004 * L * wk, 0.95, 0.15, [dy / dl, -dx / dl, 0]);   // 帶子的寬在羽片平面裡、垂直於羽枝
    }
    // 絨羽：羽管上方那一段，捲曲蓬鬆的長絨毛，往各個方向
    for (let j = 0; j < 46; j++) {
      const t = 0.1 + 0.26 * r(), [ax, ay] = axis(t), th = r() * Math.PI * 2, up = 0.35 + r() * 0.9, len = (0.16 + r() * 0.16) * L, pts = [];
      const dir = [Math.cos(th) * Math.sin(up), Math.cos(up), Math.sin(th) * Math.sin(up)], curl = (r() - 0.5) * 2.4;
      for (let i = 0; i <= 6; i++) { const u = i / 6, d = len * u, c = curl * u * u;
        pts.push([ax + d * (dir[0] * Math.cos(c) - dir[2] * Math.sin(c)), ay + d * dir[1], d * (dir[0] * Math.sin(c) + dir[2] * Math.cos(c))]); }
      { const sx = -dir[2], sz = dir[0], sl = Math.hypot(sx, sz) || 1; ribbon(pts, 0.009 * L, 0.003 * L, 0.7, 0.05, [sx / sl, 0, sz / sl]); }   // 寬的方向垂直於絨毛
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4)); g.setIndex(I); g.computeVertexNormals();
    return g;
  }

  // 膠囊的一截：開口在 y=0、圓頂在 y=len 的圓管
  function capsuleHalf(len, r) {
    const pts = [new THREE.Vector2(r, 0), new THREE.Vector2(r, len - r)];
    for (let i = 1; i <= 10; i++) { const a = (i / 10) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * r, len - r + Math.sin(a) * r)); }
    return new THREE.LatheGeometry(pts, 20);
  }

  // 兩條線段之間的最短距離（不配置物件，算得快）
  function segDist(p, q, u, w) {   // 線段 p→q 與 u→w，皆為 [x,y,z]
    const d1x = q[0] - p[0], d1y = q[1] - p[1], d1z = q[2] - p[2], d2x = w[0] - u[0], d2y = w[1] - u[1], d2z = w[2] - u[2], rx = p[0] - u[0], ry = p[1] - u[1], rz = p[2] - u[2];
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz, c = d1x * rx + d1y * ry + d1z * rz, b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
    let s = den > 1e-14 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = (b * s + f) / e;
    if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    const x = rx + d1x * s - d2x * t, y = ry + d1y * s - d2y * t, z = rz + d1z * s - d2z * t; return Math.sqrt(x * x + y * y + z * z);
  }

  // 把膠囊一顆一顆「倒進」瓶子：每顆試幾個位置與方向，從上往下落到碰到底或其他膠囊為止，挑最低的
  function pour() {
    const r = rng(42), IN = R - T - 0.0006, FLOOR = BASE_T, half = CL / 2 - CR, placed = [];
    const ends = (c, ax) => [[c[0] + ax[0] * half, c[1] + ax[1] * half, c[2] + ax[2] * half], [c[0] - ax[0] * half, c[1] - ax[1] * half, c[2] - ax[2] * half]];
    const ok = (c, ax) => {
      const [a, b] = ends(c, ax);
      for (const p of [a, b]) if (Math.hypot(p[0], p[2]) > IN - CR || p[1] < FLOOR + CR || p[1] > FILL_TOP + 0.02) return false;
      for (const q of placed) if (Math.abs(q.c[1] - c[1]) < CL && Math.abs(q.c[0] - c[0]) < CL && Math.abs(q.c[2] - c[2]) < CL && segDist(a, b, q.a, q.b) < 2 * CR * 0.97) return false;
      return true;
    };
    for (let k = 0; k < N_PILLS; k++) {
      let best = null;
      for (let tries = 0; tries < 30; tries++) {
        const th = r() * Math.PI * 2, tilt = Math.PI / 2 - (r() ** 2) * 1.2;   // 大多躺著，少數斜立
        const ax = [Math.cos(th) * Math.sin(tilt), Math.cos(tilt), Math.sin(th) * Math.sin(tilt)];
        const rr = Math.sqrt(r()) * Math.max(0, IN - CR - half * Math.hypot(ax[0], ax[2])), ph = r() * Math.PI * 2;
        const c = [Math.cos(ph) * rr, FILL_TOP + 0.01, Math.sin(ph) * rr];
        if (!ok(c, ax)) continue;
        let step = 0.004;   // 先大步往下落，碰到了再改小步
        while (step >= 0.0004) { while (c[1] > FLOOR && ok([c[0], c[1] - step, c[2]], ax)) c[1] -= step; step /= 2; }
        if (!best || c[1] < best.c[1]) best = { c, ax };
      }
      if (!best || best.c[1] > FILL_TOP) continue;
      const [a, b] = ends(best.c, best.ax);
      placed.push({ c: best.c, ax: best.ax, a, b, spin: r() * Math.PI * 2, flip: r() < 0.5 });
    }
    return placed.map((p) => ({ ...p, c: new THREE.Vector3(...p.c), ax: new THREE.Vector3(...p.ax) }));
  }

  async function load() {
    const root = new THREE.Group(), inner = new THREE.Group(), meshes = [];
    inner.position.y = -TOTAL / 2; root.add(inner);
    const add = (g, m, o = {}) => { const x = new THREE.Mesh(g, m); if (o.ro !== undefined) x.renderOrder = o.ro; x.castShadow = !!o.shadow; inner.add(x); meshes.push(x); return x; };
    const V2 = (p) => p.map(([x, y]) => new THREE.Vector2(x, y));

    // 瓶身（外壁）：厚底的下緣圓潤、微微外擴，直筒往上，瓶口一圈凸緣
    const outerP = V2([[0, 0.0004], [R - 0.006, 0], [R - 0.0015, 0.0012], [R + 0.0012, 0.0045], [R + 0.0016, 0.0085], [R + 0.0006, 0.013], [R, 0.018],
      [R, JAR_H - 0.006], [R + 0.0006, JAR_H - 0.0045], [R + 0.0022, JAR_H - 0.0035], [R + 0.0026, JAR_H - 0.0015], [R + 0.0018, JAR_H], [R - T, JAR_H]]);
    // 內壁：厚底上面是平的
    const innerP = V2([[0, BASE_T], [R - T - 0.004, BASE_T], [R - T - 0.0005, BASE_T + 0.003], [R - T, BASE_T + 0.008], [R - T, JAR_H]]);
    add(new THREE.LatheGeometry(outerP, 72), clear(1, 0.016), { ro: 9 });
    add(new THREE.LatheGeometry(innerP, 72), glass({ side: THREE.BackSide, gain: 0.55, edge: 0xbcc6c1, base: 0xf4f8f6, a0: 0.008 }), { ro: 8 });
    const baseTop = add(new THREE.CircleGeometry(R - T - 0.004, 48), clear(0.9, 0.03, 0xa9b5b0), { ro: 7 }); baseTop.rotation.x = -Math.PI / 2; baseTop.position.y = BASE_T;   // 厚玻璃底的上面

    // 玻璃蓋：塞進瓶口的一圈塞子、蓋在凸緣上的圓盤（上面微微隆起），頂上一顆圓球把手。整個蓋子是一組，可以掀開
    const lidG = new THREE.Group(); inner.add(lidG);
    const lidP = V2([[0, JAR_H + 0.0072], [0.012, JAR_H + 0.0071], [R - 0.004, JAR_H + 0.0058], [R + 0.0026, JAR_H + 0.004], [R + 0.0038, JAR_H + 0.0025], [R + 0.0036, JAR_H + 0.0008],
      [R + 0.002, JAR_H + 0.0001], [R - T - 0.0004, JAR_H + 0.0001], [R - T - 0.0006, JAR_H - 0.006], [R - T - 0.003, JAR_H - 0.0068], [0, JAR_H - 0.0068]]);
    const lid = add(new THREE.LatheGeometry(lidP, 72), clear(1.05, 0.02, 0xaab6b1), { ro: 10 });
    const knobY = JAR_H + 0.0072, neck = add(new THREE.CylinderGeometry(0.0034, 0.0046, 0.006, 32), clear(1.1, 0.04, 0xa5b2ac), { ro: 10 }); neck.position.y = knobY + 0.003;
    const ball = add(new THREE.SphereGeometry(0.0085, 40, 28), clear(1.1, 0.03, 0xa5b2ac), { ro: 11 }); ball.position.y = knobY + 0.006 + 0.0075;
    const lidParts = [lid, neck, ball]; lidParts.forEach((m) => lidG.add(m));

    // 膠囊：倒進瓶子裡
    const P = pour(), n = P.length, half = CL / 2;
    // 膠囊沿長軸 y 從 -CL/2 到 +CL/2：本體從下端長到 2/3 處，稍粗的蓋子從上端套下來到一半
    const bodyG = capsuleHalf(CL * 0.66, CR * 0.985).rotateZ(Math.PI).translate(0, -half + CL * 0.66, 0), capHG = capsuleHalf(CL * 0.48, CR).translate(0, half - CL * 0.48, 0);
    const shell = (edge, base, a0, gain) => glass({ side: THREE.DoubleSide, gain, edge, base, a0 });
    const bodies = new THREE.InstancedMesh(bodyG, shell(0xb59a63, 0xefe2bf, 0.035, 0.75), n), caps = new THREE.InstancedMesh(capHG, shell(0xa98d55, 0xe9dab2, 0.05, 0.8), n);
    // 羽毛：照真實構造做的小羽毛，長約 1.3 公分
    const fGeo = featherGeo(0.013);
    const feathers = new THREE.InstancedMesh(fGeo, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, opacity: 0.95, side: THREE.DoubleSide, color: 0xffffff, emissive: 0xfffaf0, emissiveIntensity: 0.45, roughness: 1 }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qs = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), tmp = new THREE.Vector3();
    P.forEach((p, i) => {
      q.setFromUnitVectors(Y, p.ax).multiply(qs.setFromAxisAngle(Y, p.spin)); if (p.flip) q.multiply(qs.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
      m4.compose(p.c, q, one); bodies.setMatrixAt(i, m4); caps.setMatrixAt(i, m4);
      const fq = q.clone().multiply(qs.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (i % 5 - 2) * 0.06));
      m4.compose(p.c, fq, new THREE.Vector3(0.9 + (i % 3) * 0.06, 0.92 + (i % 4) * 0.03, 1)); feathers.setMatrixAt(i, m4);
    });
    for (const [im, ro] of [[feathers, 4], [bodies, 5], [caps, 6]]) { im.renderOrder = ro; im.frustumCulled = false; inner.add(im); meshes.push(im); }

    /* ---------- 互動：點蓋子 → 蓋子掀開、取出一顆膠囊到眼前 → 服用（殼散成顆粒、羽毛飛走）或放回去 ---------- */
    const top = P.reduce((bi, p, i) => (p.c.y > P[bi].c.y ? i : bi), 0);   // 最上面那一顆
    const M0 = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()]; bodies.getMatrixAt(top, M0[0]); caps.getMatrixAt(top, M0[1]); feathers.getMatrixAt(top, M0[2]);
    const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
    const hideSlot = (h) => { bodies.setMatrixAt(top, h ? ZERO : M0[0]); caps.setMatrixAt(top, h ? ZERO : M0[1]); feathers.setMatrixAt(top, h ? ZERO : M0[2]); for (const im of [bodies, caps, feathers]) im.instanceMatrix.needsUpdate = true; };
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2), cl01 = (t) => Math.min(1, Math.max(0, t));
    const api = { root, meshes, height: TOTAL, setEnvMap() {}, pills: n, state: 'idle', onOffer: null, onDone: null };
    let spin = 0, touched = false; const pUser = new THREE.Quaternion(), qa = new THREE.Quaternion(), ax = new THREE.Vector3();
    let sBase = 1, cam = null, st = 'idle', t = 0, pill = null, pBody, pCap, pFeather, dust = null, from = null, lidK = 0, lidTo = 0;
    const W = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() }, tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), RZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const layerOf = (o) => o.traverse((x) => { x.layers.mask = lid.layers.mask; });
    const slotWorld = () => { inner.updateWorldMatrix(true, false); const m = inner.matrixWorld.clone().multiply(M0[0]); const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); m.decompose(p, q, sc); return { p, q, s: sc.x }; };
    const mouthWorld = () => inner.localToWorld(new THREE.Vector3(0, JAR_H + 0.045, 0));
    const eyeWorld = () => {   // 眼前：鏡頭正前方 30 公分，躺成橫的、慢慢轉
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const p = cam.position.clone().addScaledVector(dir, 0.3).addScaledVector(up, 0.05);   // 在藥罐上方，不跟瓶身疊在一起
      const q = cam.quaternion.clone().multiply(pUser).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25)).multiply(RZ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin));   // 訪客拖曳的翻轉 × 橫躺微微朝上 × 繞長軸慢慢轉   // 橫躺、微微朝上，繞自己的長軸慢慢轉
      return { p, q };
    };
    function makePill() {
      const s0 = slotWorld();
      pill = new THREE.Group(); pBody = new THREE.Mesh(bodyG, bodies.material.clone()); pCap = new THREE.Mesh(capHG, caps.material.clone()); pFeather = new THREE.Mesh(fGeo, feathers.material.clone());
      pFeather.renderOrder = 20; pBody.renderOrder = 21; pCap.renderOrder = 22; pBody.material.uniforms.uGain.value = 1.15; pCap.material.uniforms.uGain.value = 1.2; pFeather.material.emissiveIntensity = 0.6; pill.add(pFeather, pBody, pCap);
      sBase = s0.s; pill.position.copy(s0.p); pill.quaternion.copy(s0.q); pill.scale.setScalar(s0.s); root.parent.add(pill); layerOf(pill); hideSlot(true);
    }
    const go = (s2) => { st = s2; api.state = s2; t = 0; from = pill ? { p: pill.position.clone(), q: pill.quaternion.clone() } : null; };
    api.offer = (camera) => { if (st !== 'idle') return false; cam = camera || cam; pUser.identity(); spin = 0; touched = false; lidTo = 1; makePill(); go('rise'); return true; };
    api.putBack = () => { if (!['rise', 'come', 'offer'].includes(st)) return false; go('return'); return true; };
    api.take = () => { if (st !== 'offer') return false; go('release'); return true; };
    api.back = () => api.putBack() || st === 'release' || st === 'fly' || st === 'return';   // 按 Esc：膠囊先放回瓶子；服用的動畫播完前不放下藥罐
    api.busy = () => st !== 'idle';
    // 膠囊在眼前時：拖曳翻轉的是膠囊（照螢幕的軸轉，和翻轉藥罐的手感一樣），「轉回正面」讓它回到原本的角度
    api.turn = (yaw, pitch) => { if (st !== 'come' && st !== 'offer') return false; touched = true; facing = false; pUser.premultiply(qa.setFromAxisAngle(ax.set(0, 1, 0), yaw)).premultiply(qa.setFromAxisAngle(ax.set(1, 0, 0), pitch)).normalize(); return true; };
    let facing = false;
    api.face = () => { if (st !== 'come' && st !== 'offer') return false; facing = true; touched = false; return true; };   // 平順地翻回原本的角度
    // 膠囊拿出來的時候，藥罐往後退、變暗，讓膠囊在前面清楚浮出來
    const jarMats = [...new Set(meshes.map((m) => m.material))].map((m) => ({ m, g: m.uniforms ? m.uniforms.uGain.value : m.opacity }));
    const INNER0 = inner.position.clone(); let dimK = 0;
    const rc = new THREE.Raycaster();
    api.pick = (ndc, camera, layer) => {   // 點到蓋子：交給房間決定（第一次就打開、服用過就提醒）
      cam = camera; rc.layers.set(layer); rc.setFromCamera(ndc, camera);
      if (!rc.intersectObjects(lidParts, false).length) return st !== 'idle';   // 動畫中點哪裡都不算「點旁邊」
      if (st === 'idle' && api.onLid) api.onLid();
      return true;
    };
    function burst() {   // 膠囊殼散成細細的發光顆粒：從殼的表面出發，往外、往下飄，慢慢淡掉
      const N = 1000, pos = new Float32Array(N * 3), vel = [], v = new THREE.Vector3();
      pill.updateMatrixWorld(true);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2, y = (Math.random() - 0.5) * CL * 0.95, rr = CR * (Math.abs(y) > CL / 2 - CR ? Math.sqrt(Math.max(0, 1 - ((Math.abs(y) - (CL / 2 - CR)) / CR) ** 2)) : 1);
        v.set(Math.cos(a) * rr, y, Math.sin(a) * rr).applyMatrix4(pill.matrixWorld); pos.set([v.x, v.y, v.z], i * 3);
        const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).applyQuaternion(pill.quaternion).multiplyScalar(0.02 + Math.random() * 0.035);
        vel.push(out.add(new THREE.Vector3((Math.random() - 0.5) * 0.02, -0.01 - Math.random() * 0.025, (Math.random() - 0.5) * 0.02)));
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ color: 0xfff6e4, size: 0.0008, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
      dust = new THREE.Points(g, m); dust.frustumCulled = false; dust.renderOrder = 30; dust.userData.vel = vel; root.parent.add(dust); layerOf(dust);
    }
    api.tick = (dt) => {
      dt = Math.min(dt, 0.05);
      // 蓋子：掀起來、往旁邊斜放；蓋回去時反過來
      lidK += Math.sign(lidTo - lidK) * Math.min(Math.abs(lidTo - lidK), dt / 1.6);   // 蓋子慢慢掀開（約 1.6 秒）
      const lk = ease(cl01(lidK)); lidG.position.set(0.05 * lk, 0.03 * Math.sin(Math.PI * Math.min(1, lidK * 1.2)) * 1 + 0.008 * lk, 0.012 * lk); lidG.rotation.z = -0.55 * lk;
      const dimTo = (st === 'come' || st === 'offer' || st === 'release' || (st === 'fly' && t < 1.6)) ? 1 : 0;
      dimK += Math.sign(dimTo - dimK) * Math.min(Math.abs(dimTo - dimK), dt / 0.9);
      const dk = ease(cl01(dimK));
      for (const { m, g } of jarMats) { if (m.uniforms) m.uniforms.uGain.value = g * (1 - 0.6 * dk); else m.opacity = g * (1 - 0.65 * dk); }
      inner.position.copy(INNER0);
      if (dk > 0 && cam) {   // 往遠離鏡頭的方向退（在 root 的座標裡算）
        root.updateWorldMatrix(true, false);
        const away = root.getWorldPosition(new THREE.Vector3()).sub(cam.position).normalize(), wq = root.getWorldQuaternion(new THREE.Quaternion()).invert(), sc = root.getWorldScale(new THREE.Vector3()).x;
        inner.position.addScaledVector(away.applyQuaternion(wq), 0.24 * dk / sc);
      }
      if (st === 'idle' || !pill) return;
      t += dt;
      if (st === 'rise') {   // 等蓋子掀開，膠囊從瓶裡升到瓶口上方
        const k = ease(cl01((t - 1.5) / 1.1)), m = mouthWorld();
        pill.position.lerpVectors(from.p, m, k); pill.quaternion.slerpQuaternions(from.q, tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0).applyQuaternion(inner.getWorldQuaternion(new THREE.Quaternion()))), k);
        if (t > 2.6) go('come');
      } else if (st === 'come') {   // 飄到眼前
        const k = ease(cl01(t / 1.3)), e = eyeWorld();
        pill.position.lerpVectors(from.p, e.p, k); pill.quaternion.slerpQuaternions(from.q, e.q, k); pill.scale.setScalar(sBase * (1 + 0.8 * k));
        if (t > 1.3) { go('offer'); if (api.onOffer) api.onOffer(); }
      } else if (st === 'offer') {   // 在眼前慢慢轉（訪客翻過之後就停下來，讓他自己看）
        if (!touched) spin += dt * 0.6;
        if (facing) { pUser.slerp(qa.identity(), 1 - Math.exp(-dt * 7)); if (pUser.angleTo(qa) < 0.002) { pUser.identity(); facing = false; } }
        const e = eyeWorld(); pill.position.copy(e.p).addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), Math.sin(t * 1.6) * 0.0025); pill.quaternion.copy(e.q);
      } else if (st === 'return') {   // 放回去：回到瓶口上方、落回原位，再蓋上蓋子
        const m = mouthWorld(), s0 = slotWorld();
        if (t < 1.1) { const k = ease(t / 1.1); pill.position.lerpVectors(from.p, m, k); pill.quaternion.slerpQuaternions(from.q, s0.q, k); pill.scale.setScalar(sBase * (1.8 - 0.8 * k)); }
        else { const k = ease(cl01((t - 1.1) / 0.9)); pill.position.lerpVectors(m, s0.p, k); pill.quaternion.copy(s0.q); }
        if (t > 2.0) { root.parent.remove(pill); pill = null; hideSlot(false); lidTo = 0; st = 'idle'; api.state = 'idle'; if (api.onDone) api.onDone('back'); }
      } else if (st === 'release') {   // 服用：兩截輕輕分開，殼散成顆粒，羽毛被放出來
        const k = ease(cl01(t / 0.7)); pCap.position.y = 0.006 * k; pBody.position.y = -0.006 * k;
        const e = eyeWorld(); pill.position.copy(e.p);
        if (t > 0.7) { burst(); pCap.visible = pBody.visible = false; go('fly'); }
      } else if (st === 'fly') {   // 羽毛左右擺盪著往上飄，飄出視野；顆粒往外往下飄散、淡掉
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), e = eyeWorld();
        pill.position.copy(e.p).addScaledVector(up, 0.022 * t + 0.012 * t * t).addScaledVector(right, Math.sin(t * 2.2) * 0.02 * Math.min(1, t));
        pill.quaternion.copy(e.q).multiply(tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sin(t * 2.2 + 0.8) * 0.5));
        pFeather.material.opacity = 0.95 * (1 - cl01((t - 3.2) / 1.2));
        if (dust) { const pa = dust.geometry.attributes.position, vel = dust.userData.vel; for (let i = 0; i < vel.length; i++) { vel[i].multiplyScalar(1 - dt * 0.9); pa.setXYZ(i, pa.getX(i) + vel[i].x * dt, pa.getY(i) + vel[i].y * dt, pa.getZ(i) + vel[i].z * dt); } pa.needsUpdate = true; dust.material.opacity = 0.9 * (1 - cl01(t / 2.4)); }
        if (t > 1.2) lidTo = 0;
        if (t > 4.4) { root.parent.remove(pill); pill = null; if (dust) { root.parent.remove(dust); dust.geometry.dispose(); dust = null; } st = 'idle'; api.state = 'idle'; if (api.onDone) api.onDone('taken'); }
      }
    };
    return api;

  }
  window.PillJar = { load, featherGeo };
})();
