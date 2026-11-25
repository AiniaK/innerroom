/* 「草原」（房主用 Unreal 做的影像作品）：清晨的盆地草原。訪客可以在盆地裡走，也可以走上一圈寬寬的稜線，
 * 從稜線往下看外面的大平原：樹林、草原、一條蜿蜒的大河，再遠是山脈。盆地裡的小溪從太陽那邊的缺口流出去，往下接到大河。
 * 時間固定在清晨：太陽在缺口的方向，剛升起，粉橘色的光從缺口斜斜照進盆地，盆底還有一層薄霧。
 * 太陡的地方（岩壁）不能爬上去，也不能從上面走下來；稜線的外緣是盡頭。
 * 全部是自己寫的著色器（不用 three 的燈光）：地形的光影在進來時一次算好（含稜線的長影子）；
 * 草：寬一點、有弧度、法線做成圓弧的草葉，柔和的天空光為主，加上包覆的側光和逆光時透出的光，一大片緊密地長著，跟著訪客移動，
 * 遠處的草慢慢變矮，接上同色的地面（不用網點淡出）。草裡點綴白色小花。
 * 聲音（即時合成）：風吹過草（越往稜線上越大）、小溪的水聲（從最近的溪段傳來）、四周偶爾的晨鳥。
 * 介面和其他作品空間相同：init(THREE)、enter({THREE, ac, out})、tick(dt, input)、render(renderer, camera, pose, input)、exit()、dispose()。 */
(function () {
  const L = 210, N = 316, STEP = (2 * L) / (N - 1);        // 盆地的地形格子：420 × 420 公尺，每 1.33 公尺一點
  const AX = 85, AZ = 120, ZC = -20;                         // 盆地：橢圓，稜線內緣 x 半徑 85、z 半徑 120，中心往前 20 公尺
  const Q_IN = 0.9, Q_OUT = 1.06, Q_WALK = 1.04;             // 稜線的平台：從 q 0.9 到 1.06；訪客最遠走到 1.04
  const SUN = [-0.72, 0.16, -0.676];                         // 太陽：左前方，仰角約 9 度；缺口就在這個方向
  const PLAIN = -92;                                         // 外面平原的高度（比盆底低 90 公尺）
  const START = { x: 6, z: 34, yaw: 0.3 };                   // 出發點：盆地靠近這一端，面向缺口與太陽那一側
  const MAXSLOPE = 0.85;                                     // 比這個更陡（約 40 度）的地方走不上去，也走不下去
  const S = { on: false, x: START.x, z: START.z, y: 0, t: 0 };
  let THREE, scene, mats = [], geos = [], texs = [], U, HG = null, VG = null, TREE = null, F = null, CL = null, COL = null, CREEK = [], CREEK_OUT = [], RIVER = [], skyMesh, grass, flowers, stoneTex = null, LOD = [], QL = { q: 1, ft: 16, t: 0, gpu: false }, coarse = false;
  const keepM = (m) => (mats.push(m), m), keepG = (g) => (geos.push(g), g);
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;

  /* ---------- 雜訊 ---------- */
  function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, y) { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
  function fbm(x, y, o = 5) { let s = 0, a = 0.5, f = 1, n = 0; for (let k = 0; k < o; k++) { s += a * vnoise(x * f, y * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }
  // 折線的格子索引：每條水路的線段先分到格子裡，查距離時只看附近那幾段（載入快很多）；超過 R 的距離只回傳「R 以外」
  const PIDX = new WeakMap();
  function pidx(P) { let g = PIDX.get(P); if (g) return g; const R = P === RIVER ? 90 : 14, C = R > 30 ? 120 : 16, m = new Map();
    for (let k = 0; k < P.length - 1; k++) { const [ax, az] = P[k], [bx, bz] = P[k + 1];
      for (let cx = Math.floor((Math.min(ax, bx) - R) / C); cx <= Math.floor((Math.max(ax, bx) + R) / C); cx++) for (let cz = Math.floor((Math.min(az, bz) - R) / C); cz <= Math.floor((Math.max(az, bz) + R) / C); cz++) {
        const key = (cx + 32768) * 65536 + (cz + 32768); let l = m.get(key); if (!l) m.set(key, l = []); l.push(k); } }
    g = { R, C, m }; PIDX.set(P, g); return g; }
  const segsNear = (P, x, z) => { const g = pidx(P); return g.m.get((Math.floor(x / g.C) + 32768) * 65536 + (Math.floor(z / g.C) + 32768)); };
  function polyNear(P, x, z) {   // 離折線最近的距離，和在折線上的位置（第幾段 + 段內比例）
    const ks = segsNear(P, x, z); if (!ks) return [pidx(P).R + 1, 0];
    let best = 1e9, at = 0; for (const k of ks) { const [ax, az] = P[k], [bx, bz] = P[k + 1], dx = bx - ax, dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1), d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; at = k + t; } } return [best, at]; }
  const lvlAt = (LV, at) => { const k = Math.min(LV.length - 2, Math.floor(at)); return lerp(LV[k], LV[k + 1], at - k); };
  // 小溪的河道：先照水位（只降不升）挖出淺淺的河床，兩岸再緩緩接回原本的地面
  function carveCreek(h, P, LV, x, z, wid) {
    if (!LV || !LV.length) return h; const [d, at] = polyNear(P, x, z); if (d > wid + 8) return h;
    const lv = lvlAt(LV, at), bed = lv - 0.55 * (1 - sstep(wid * 0.55, wid, d)) + 0.12, bank = lv + 0.15 + Math.max(0, d - wid) * 0.75;
    return Math.min(h, d < wid ? bed : bank);
  }
  function polyDist(P, x, z) { const ks = segsNear(P, x, z); if (!ks) return pidx(P).R + 1; let best = 1e9; for (const k of ks) { const [ax, az] = P[k], [bx, bz] = P[k + 1], dx = bx - ax, dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1); best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t)); } return best; }

  /* ---------- 地形 ---------- */
  const qOf = (x, z) => Math.hypot(x / AX, (z - ZC) / AZ);   // 1 ≈ 稜線
  const thOf = (x, z) => Math.atan2((z - ZC) / AZ, x / AX);
  const SUNTH = Math.atan2(SUN[2] / AZ, SUN[0] / AX);
  const NOTCH = [Math.cos(SUNTH) * AX, ZC + Math.sin(SUNTH) * AZ];   // 缺口的位置（稜線上，太陽那邊）
  function angDist(a, b) { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; }
  function rimH(th) {   // 稜線平台的高度：太陽那邊是一個寬寬的缺口（低到接近盆底），其他地方 20～45 公尺
    const n = fbm(Math.cos(th) * 2.2 + 7, Math.sin(th) * 2.2 + 3, 4), notch = Math.exp(-Math.pow(angDist(th, SUNTH), 2) / 0.07);
    return lerp(22 + 24 * n + 5 * Math.exp(-Math.pow(angDist(th, Math.PI / 2), 2) / 0.4), -1.2, notch);   // 缺口低到比盆底還低一點，小溪才流得出去
  }
  // 外面的平原：緩緩起伏，靠近遠山時慢慢升高；大河的河道一路壓低、壓平
  function plainH(x, z) {
    const d = Math.hypot(x, z);
    let h = PLAIN + (fbm(x * 0.0035 + 4, z * 0.0035 + 9, 4) - 0.5) * 26 + (fbm(x * 0.02, z * 0.02, 3) - 0.5) * 5 + sstep(1100, 2900, d) * 150;
    const dr = RIVER.length ? polyDist(RIVER, x, z) : 1e9; h = lerp(h, PLAIN - 4 + (fbm(x * 0.0035 + 4, z * 0.0035 + 9, 4) - 0.5) * 10, 1 - sstep(14, 70, dr)); h -= 2.2 * (1 - sstep(6, 16, dr));
    return carveCreek(h, CREEK_OUT, COL, x, z, 1.6);
  }
  function heightAt(x, z) { return carveCreek(carveCreek(baseHeight(x, z), CREEK, CL, x, z, 1.9), CREEK_OUT, COL, x, z, 1.6); }
  function baseHeight(x, z) {
    const q = qOf(x, z), th = thOf(x, z), R = rimH(th);
    let h = (fbm(x * 0.018 + 3, z * 0.018 + 9, 4) - 0.5) * 2.6 + 0.6 * Math.sin(x * 0.045) * Math.cos(z * 0.035);   // 盆底：緩緩的起伏
    const t = clamp((q - 0.46) / (Q_IN - 0.46), 0, 1);
    // 右側是岩壁：沿著牆忽強忽弱（有的地方是陡壁、有的地方退成陡坡），底線高低不一，壁面有突出的岩塊和凹進去的地方
    const cn = fbm(Math.cos(th) * 3.2 + 11, Math.sin(th) * 3.2 + 5, 3);
    const cliff = clamp(sstep(0.05, 0.55, Math.cos(th)) * (1 - Math.exp(-Math.pow(angDist(th, SUNTH), 2) / 0.1)) * (0.35 + 0.9 * cn), 0, 1);
    const tt = clamp(t + (fbm(x * 0.035 + 2, z * 0.035 + 8, 3) - 0.5) * 0.34, 0, 1);
    const bowl = Math.pow(t, 1.75), wall = sstep(0.26, 0.84, tt) * 0.8 + 0.2 * tt;
    const knobs = (fbm(x * 0.07 + 4, z * 0.07 + 1, 4) - 0.5) * 0.3 * R * cliff * Math.sin(Math.PI * tt) + (fbm(x * 0.2, z * 0.2, 2) - 0.5) * 1.5 * cliff;
    h += R * (bowl + (wall - bowl) * cliff) + knobs + (fbm(x * 0.06, z * 0.06, 4) - 0.5) * 6 * t * (1 - sstep(0.85, Q_IN, q));
    if (q > Q_IN) h = lerp(h, R + (fbm(x * 0.05, z * 0.05, 3) - 0.5) * 2.2, sstep(Q_IN - 0.02, Q_IN + 0.03, q));   // 稜線頂：寬寬的平台
    if (q > Q_OUT) { const k = clamp((q - Q_OUT) / 0.42, 0, 1); h = lerp(h, plainH(x, z), 1 - Math.pow(1 - k, 2.2)); h += (fbm(x * 0.08, z * 0.08, 3) - 0.5) * 8 * Math.sin(Math.PI * k); }   // 外側：陡陡地落到平原
    return h;
  }
  function hAt(x, z) {   // 從格子內插（走路用）
    const fx = clamp((x + L) / STEP, 0, N - 1.001), fz = clamp((z + L) / STEP, 0, N - 1.001), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = HG[j * N + i], b = HG[j * N + i + 1], c = HG[(j + 1) * N + i], d = HG[(j + 1) * N + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /* ---------- 共用的大氣：距離霧 + 盆底的薄霧（隨高度變淡），朝太陽的方向帶暖色 ---------- */
  const ATM = `
    uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uCam; uniform vec3 uHaze; uniform vec3 uHazeSun; uniform float uFogD; uniform float uMistD; uniform float uMistY; uniform float uMistH; uniform float uT;
    vec3 atmos(vec3 col, vec3 wp){
      vec3 d = wp - uCam; float dist = length(d); vec3 dir = d / max(dist, 1e-3);
      vec3 haze = mix(uHaze, uHazeSun, pow(max(dot(dir, uSun), 0.0), 5.0));
      float h0 = uCam.y - uMistY, h1 = wp.y - uMistY, dh = h1 - h0;
      float e0 = exp(-max(h0, 0.0) / uMistH), e1 = exp(-max(h1, 0.0) / uMistH);
      float fm = abs(dh) > 0.05 ? clamp(uMistH * (e0 - e1) / dh, 0.0, 1.0) : e0;
      float od = min(dist, 400.0) * uMistD * fm + dist * uFogD;
      return mix(col, haze, 1.0 - exp(-od));
    }
    float cs_h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
    float cs_n(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f); return mix(mix(cs_h(i), cs_h(i + vec2(1, 0)), u.x), mix(cs_h(i + vec2(0, 1)), cs_h(i + vec2(1, 1)), u.x), u.y); }
    float cloudSh(vec3 wp){ vec2 q = wp.xz * 0.0042 - vec2(0.8, -0.6) * uT * 0.02; return smoothstep(0.56, 0.78, cs_n(q) * 0.65 + cs_n(q * 2.3 + 4.0) * 0.35); }`;
  const NOISE = `
    float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
    float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ s += a * vn(p); p = p * 2.03 + 17.0; a *= 0.5; } return s / 0.97; }`;
  const WP = `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const shader = (vs, fs, o = {}) => keepM(new THREE.ShaderMaterial(Object.assign({ uniforms: Object.assign({}, U, o.uniforms || {}), vertexShader: vs, fragmentShader: fs }, o.opts || {})));
  const DERIV = { extensions: { derivatives: true } };
  // 地面的草色（近處接在草的下面，遠處就是草原本身的顏色）
  const GRASS_BASE = [0.13, 0.25, 0.15], GRASS_TOP = [0.42, 0.53, 0.26];   // 偏橄欖、帶一點黃的綠，不要太鮮

  /* ---------- 水面（小溪、大河共用）：清澈的淺水，看得見一顆顆鵝卵石的河底（越到中間越深、越青綠），
   * 順著水流慢慢移動的白色亮紋，再映著一點清晨的天空和太陽的反光 ---------- */
  function waterRibbon(pts2, widthFn, yFn, bed) {
    const pos = [], flow = [], uv = [], idx = [], ACR = [-1, -0.5, 0, 0.5, 1]; let arc = 0;
    for (let k = 0; k < pts2.length; k++) { const a = pts2[Math.max(0, k - 1)], b = pts2[Math.min(pts2.length - 1, k + 1)], dx = b[0] - a[0], dz = b[1] - a[1], dl = Math.hypot(dx, dz) || 1, w = widthFn(k);
      const [x, z] = pts2[k], y = yFn(k, x, z); if (k) arc += Math.hypot(x - pts2[k - 1][0], z - pts2[k - 1][1]);
      ACR.forEach((u) => { pos.push(x - dz / dl * w * u, y, z + dx / dl * w * u); flow.push(dx / dl, dz / dl); uv.push(arc, u * w); });
      if (k) for (let c = 0; c < 4; c++) { const a0 = (k - 1) * 5 + c, b0 = k * 5 + c; idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); } }
    const g = keepG(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2)); g.setAttribute('suv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    return new THREE.Mesh(g, shader(`attribute vec2 flow; attribute vec2 suv; varying vec2 vF; varying vec2 vS; varying vec3 vW; void main(){ vF = flow; vS = suv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      `${ATM} ${NOISE} uniform float uBed; uniform float uHalf; varying vec2 vF; varying vec2 vS; varying vec3 vW;
      vec3 vor(vec2 p){ vec2 i = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0; float id = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){ vec2 o = vec2(x, y), c = o + 0.15 + 0.7 * vec2(h21(i + o), h21(i + o + 7.3)); float d = length(f - c); if (d < d1){ d2 = d1; d1 = d; id = h21(i + o + 3.1); } else if (d < d2) d2 = d; }
        return vec3(d1, d2 - d1, id); }
      void main(){ vec2 t = normalize(vF); float along = vS.x, side = vS.y, acr = side / uHalf;
        float deep = 1.0 - acr * acr;                                                               // 中間深、兩岸淺，平滑地過渡
        // 河底的鵝卵石，透過水面輕輕晃動（晃動往下游漂）
        vec2 wob = vec2(vn(vec2(along * 1.6 - uT * 1.1, side * 2.0)), vn(vec2(along * 1.6 - uT * 0.9 + 5.0, side * 2.0 + 3.0))) - 0.5;
        vec3 v1 = vor(vW.xz * 3.2 + wob * 0.3), v2 = vor(vW.xz * 7.5 + wob * 0.45 + 11.0);
        float peb = smoothstep(0.55, 0.15, v1.x), peb2 = smoothstep(0.5, 0.12, v2.x);
        vec3 stone = mix(vec3(0.2, 0.22, 0.2), mix(vec3(0.36, 0.36, 0.33), vec3(0.5, 0.47, 0.4), v1.z), peb * (0.55 + 0.45 * v1.z));
        stone = mix(stone, mix(vec3(0.3, 0.32, 0.3), vec3(0.45, 0.43, 0.38), v2.z), peb2 * 0.45 * (1.0 - peb));
        vec3 bedC = mix(stone, vec3(0.1, 0.27, 0.27), 0.3 + 0.42 * deep);
        // 順著水流往下游漂的白色亮紋（沿著河的長度方向拉長）
        float st = fbm(vec2(along * 0.7 - uT * 0.6, side * 2.6)); float foam = smoothstep(0.62, 0.8, st) * (0.4 + 0.6 * vn(vec2(along * 2.2 - uT * 1.3, side * 7.0))) * (0.4 + 0.6 * deep);
        vec3 v = normalize(vW - uCam); vec3 nrm = normalize(vec3(wob.x * 0.22, 1.0, wob.y * 0.22)); vec3 r = reflect(v, nrm);
        float f = 0.06 + 0.7 * pow(1.0 - max(dot(-v, nrm), 0.0), 5.0);
        vec3 sky = mix(vec3(0.82, 0.8, 0.84), vec3(0.55, 0.62, 0.76), clamp(r.y * 2.0, 0.0, 1.0)); sky = mix(sky, vec3(1.0, 0.86, 0.7), pow(max(dot(r, uSun), 0.0), 6.0));
        vec3 under = mix(vec3(0.14, 0.2, 0.2), bedC, uBed);
        vec3 c = mix(under, sky, mix(0.35, f, uBed)) + vec3(0.92, 0.95, 0.96) * foam * 0.4 * uBed + vec3(1.0, 0.92, 0.8) * pow(max(dot(r, uSun), 0.0), 160.0) * 2.0;
        c = mix(c, vec3(0.17, 0.2, 0.17), smoothstep(0.75, 1.0, abs(acr)) * 0.45 * uBed);           // 岸邊濕濕的、淺淺的
        gl_FragColor = vec4(atmos(c, vW), 1.0); }`, { uniforms: { uBed: { value: bed }, uHalf: { value: Math.max(0.5, widthFn(0)) } }, opts: { side: THREE.DoubleSide } }));
    // 岩壁腳下：一叢叢的灌木和蕨類（坡度剛緩下來、旁邊就是陡壁的地方）
    { const shrubs = [], ferns = []; let tries = 0;
      while ((shrubs.length < (coarse ? 90 : 200) || ferns.length < (coarse ? 120 : 300)) && tries++ < 40000) {
        const th = R(tries * 1.31) * Math.PI * 2, q = 0.55 + R(tries * 2.77) * 0.38, x = Math.cos(th) * AX * q, z = ZC + Math.sin(th) * AZ * q;
        const sl = (xx, zz) => Math.max(Math.abs(hAt(xx + 1, zz) - hAt(xx - 1, zz)), Math.abs(hAt(xx, zz + 1) - hAt(xx, zz - 1))) / 2;
        const s0 = sl(x, z); if (s0 > 0.42 || s0 < 0.08) continue;
        const ux = Math.cos(th), uz = Math.sin(th) * AX / AZ, ul = Math.hypot(ux, uz), up = sl(x + ux / ul * 4, z + uz / ul * 4); if (up < 0.6) continue;   // 往外 4 公尺就是陡壁
        const item = [x, hAt(x, z), z, 0, R(tries * 5.1), visAt(x, z)];
        if (R(tries * 3.3) < 0.4) { if (shrubs.length < (coarse ? 90 : 200)) { item[3] = 0.5 + R(tries * 7.7) * 0.9; shrubs.push(item); } }
        else if (ferns.length < (coarse ? 120 : 300)) { item[3] = 0.6 + R(tries * 9.9) * 0.6; ferns.push(item); } }
      { const parts = []; [[0, 0.32, 0, 0.42], [0.3, 0.24, 0.1, 0.3], [-0.28, 0.25, -0.06, 0.32], [0.05, 0.42, -0.2, 0.28]].forEach(([x, y, z, r], k) => { const g = new THREE.SphereGeometry(r, 12, 9), pp = g.attributes.position;
          for (let i = 0; i < pp.count; i++) { const a = pp.getX(i), b = pp.getY(i), c = pp.getZ(i), nn = 1 + (fbm(a * 4 + k * 3, b * 4 + c * 3 + k, 3) - 0.5) * 0.6; pp.setXYZ(i, a * nn, b * nn * 0.8, c * nn); } g.computeVertexNormals(); g.translate(x, y, z); parts.push(withColor(g, [0.2, 0.32, 0.14])); });
        place(mergeG(parts), shrubs, (it, m4) => [[0.9 + 0.2 * it[4], 1, 0.9], m4.compose(V3(it[0], it[1] - 0.1, it[2]), q4.setFromEuler(e.set(0, it[4] * 6.28, 0)), V3(it[3], it[3] * (0.8 + 0.4 * it[4]), it[3]))], instVS(true)); }
      { const parts = []; for (let f = 0; f < 7; f++) { const a = f / 7 * Math.PI * 2, g = new THREE.PlaneGeometry(0.16, 0.9, 1, 8), pp = g.attributes.position;   // 一片羽狀的葉：從中心往外伸、往下垂，邊緣一齒一齒
          for (let i = 0; i < pp.count; i++) { const v = pp.getY(i) / 0.9 + 0.5, u = pp.getX(i), wv = Math.sin(Math.PI * Math.min(1, v * 1.1)) * (0.75 + 0.25 * Math.abs(Math.sin(v * 22))); pp.setXYZ(i, u * wv, v * 0.55 - v * v * 0.35, v * 0.75); }
          g.computeVertexNormals(); g.rotateY(a); parts.push(withColor(g, [0.22, 0.4, 0.17])); }
        place(mergeG(parts), ferns, (it, m4) => [[0.9 + 0.2 * it[4], 1, 0.85], m4.compose(V3(it[0], it[1] - 0.05, it[2]), q4.setFromEuler(e.set(0, it[4] * 6.28, 0)), V3(it[3], it[3], it[3]))], instVS(true)); } }
  }
  const visAt = (x, z) => { const i = clamp(Math.round((x + L) / STEP), 0, N - 1), j = clamp(Math.round((z + L) / STEP), 0, N - 1); return VG[j * N + i]; };

  /* ---------- 草原上的其他東西：帶穗的高草、孤樹、從缺口照進來的光束、空中飄的細毛、蝴蝶、蜻蜓、偶爾飛過的鳥群 ---------- */
  function extras(blade, inst, PLACE, ext) {
    const V3 = (x, y, z) => new THREE.Vector3(x, y, z), WDv = V3(0.8, 0, -0.6);
    // 帶穗的高草：一片一片地長，比一般的草高；頂端是一團軟軟的毛絨穗（長短、胖瘦、顏色不一），逆光時整團亮起來
    { const SEED = `
        vec2 wp; vec4 hf; float gh, H, wa; mat3 rotY;
        void seedSetup(){ wp = placeAt(); hf = hfAt(wp); float dist = length(wp - uCam.xz);
          gh = step(aRnd.w, hf.b * (0.2 + 0.5 * smoothstep(0.45, 0.72, vn(wp * 0.06 + 11.0)))) * smoothstep(uR, uR * 0.5, dist) * freeAt(wp);   // 整片草原零星都有，有些地方比較密
          H = (0.8 + 0.4 * aRnd.x) * gh; float ang = 2.2143 + (aRnd.z - 0.5) * 1.3, ca = cos(ang), sa = sin(ang); rotY = mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca); wa = windAt(wp); }   // 莖要比一般的草（最高約 1.3 公尺）高，穗才露得出來
        vec3 stemAt(float y){ float w = ((0.05 + 0.65 * wa) * (0.8 + 0.4 * aRnd.x) + sin(uT * (1.6 + aRnd.y) + aRnd.z * 30.0) * 0.05) * y * y;
          vec3 l = rotY * vec3(0.0, y * H, 0.1 * y * y * H) + vec3(0.8, 0.0, -0.6) * w * H; l.y -= 0.3 * w * w * H; return vec3(wp.x, hf.r - 0.04, wp.y) + l; }`;
      const NS = coarse ? 1800 : 5000, g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', blade.attributes.position); g.setIndex(blade.index); inst(g, NS);
      // 莖：細細的，上面一段帶一點米色
      const stem = new THREE.Mesh(g, shader(`${ATM} ${NOISE} ${PLACE} ${SEED} varying float vY; varying float vVis; varying vec3 vW;
        void main(){ seedSetup(); float y = position.y; vec3 p = stemAt(y) + rotY * vec3((position.x - 0.5) * 0.006 * step(0.001, gh), 0.0, 0.0);
          vY = y; vVis = hf.g; vW = p; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); if (gh < 0.02) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`,
        `${ATM} varying float vY; varying float vVis; varying vec3 vW; void main(){ vec3 a = mix(vec3(0.24, 0.36, 0.15), vec3(0.5, 0.55, 0.32), vY);
          vec3 light = vec3(0.7, 0.7, 0.76) * (0.75 + 0.25 * vY) + uSunCol * vVis * (1.0 - 0.6 * cloudSh(vW)) * 0.5; gl_FragColor = vec4(atmos(a * light, vW), 1.0); }`, { uniforms: ext, opts: { side: THREE.DoubleSide } }));
      stem.frustumCulled = false; scene.add(stem);
      // 穗：一團軟軟的毛絨。先在畫布上畫好（中間較密的芯，外圍幾百根極細、彎彎的半透明絨毛，邊緣漸漸淡掉），
      // 再貼在莖的頂端、永遠轉向你，所以從哪個角度看都是一團蓬鬆的紡錘形；跟著莖一起被風吹
      const pc = document.createElement('canvas'); pc.width = 96; pc.height = 320; { const g2 = pc.getContext('2d'), W2 = 96, H2 = 320, cx = W2 / 2;
        const env = (y) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, y))), 0.75);   // 紡錘形：兩端細、中間胖
        const core = g2.createLinearGradient(0, 0, W2, 0); core.addColorStop(0, 'rgba(255,250,235,0)'); core.addColorStop(0.5, 'rgba(255,250,235,0.55)'); core.addColorStop(1, 'rgba(255,250,235,0)');
        g2.fillStyle = core; for (let y = 6; y < H2 - 6; y += 2) { const w = env(y / H2) * 16; g2.fillRect(cx - w, y, w * 2, 2); }
        g2.lineCap = 'round';
        for (let k = 0; k < 520; k++) { const y0 = 10 + Math.random() * (H2 - 30), e = env(y0 / H2), side = Math.random() < 0.5 ? -1 : 1, len = (10 + Math.random() * 30) * e, a = 0.12 + Math.random() * 0.22;
          g2.strokeStyle = `rgba(255,${246 + Math.floor(Math.random() * 9)},${225 + Math.floor(Math.random() * 25)},${a.toFixed(2)})`; g2.lineWidth = 0.6 + Math.random() * 0.6;
          g2.beginPath(); g2.moveTo(cx + side * Math.random() * 4, y0); g2.quadraticCurveTo(cx + side * len * 0.5, y0 - len * 0.55, cx + side * len * 0.9, y0 - len * 1.1 + Math.random() * 6); g2.stroke(); } }
      const ptex = new THREE.CanvasTexture(pc); ptex.colorSpace = THREE.SRGBColorSpace; texs.push(ptex);
      const pg = new THREE.InstancedBufferGeometry(); { const P = [], idx = []; for (let r = 0; r <= 4; r++) P.push(-0.5, r / 4, 0, 0.5, r / 4, 0); for (let r = 0; r < 4; r++) { const a = r * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        pg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); pg.setIndex(idx); }
      pg.setAttribute('aOff', g.attributes.aOff); pg.setAttribute('aRnd', g.attributes.aRnd); pg.instanceCount = NS; geos.push(pg);   // 跟莖用同一組位置和亂數
      const plume = new THREE.Mesh(pg, shader(`${ATM} ${NOISE} ${PLACE} ${SEED} varying vec2 vUv; varying float vVis; varying vec3 vW; varying vec3 vTint;
        void main(){ seedSetup(); float r1 = fract(aRnd.y * 7.31), r2 = fract(aRnd.y * 13.7), r3 = fract(aRnd.x * 5.71); float y = position.y, t = mix(0.8 - 0.2 * r1, 1.03, y); vec3 c = stemAt(min(t, 1.0)); if (t > 1.0) c += normalize(stemAt(1.0) - stemAt(0.95)) * (t - 1.0) * H;   // 沿著莖的頂端（再往上多一點）   // 穗的長短不一
          vec3 ax = normalize(stemAt(1.0) - stemAt(0.7)); vec3 side = normalize(cross(ax, normalize(uCam - c)));
          vec3 p = c + side * position.x * (0.05 + 0.05 * r2) * step(0.001, gh);   // 胖瘦不一
          vTint = r3 < 0.4 ? vec3(0.95, 0.92, 0.84) : (r3 < 0.65 ? vec3(0.92, 0.8, 0.64) : (r3 < 0.85 ? vec3(0.93, 0.86, 0.88) : vec3(0.82, 0.87, 0.7)));   // 米白、淺褐、粉銀、嫩綠
          vUv = vec2(position.x + 0.5, y); vVis = hf.g; vW = p; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); if (gh < 0.02) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`,
        `${ATM} uniform sampler2D uMap; varying vec2 vUv; varying float vVis; varying vec3 vW; varying vec3 vTint; void main(){ vec4 t = texture2D(uMap, vUv); if (t.a < 0.01) discard;
          vec3 v = normalize(vW - uCam); float back = pow(clamp(dot(v, uSun), 0.0, 1.0), 2.0);
          vec3 light = vec3(0.74, 0.74, 0.8) + uSunCol * vVis * (1.0 - 0.6 * cloudSh(vW)) * (0.45 + 2.6 * back);   // 逆光時整團亮起來
          gl_FragColor = vec4(atmos(t.rgb * vTint * light, vW), t.a); }`, { uniforms: Object.assign({ uMap: { value: ptex } }, ext), opts: { side: THREE.DoubleSide, transparent: true, depthWrite: false } }));
      plume.frustumCulled = false; plume.renderOrder = 4; scene.add(plume); }

    // 一般的上色：自己的顏色 ×（天空光 + 被太陽照到的部分）；會被雲影遮住
    const litMat = (o = {}) => shader(`attribute vec3 color; uniform float uSway; uniform float uT; varying vec3 vC; varying vec3 vN; varying vec3 vW; varying float vH;
      void main(){ vC = color; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vH = position.y;
        w.xz += vec2(0.8, -0.6) * uSway * (sin(uT * 0.9 + w.x * 0.2) * 0.6 + sin(uT * 2.1 + w.z * 0.7) * 0.25) * max(position.y - 2.5, 0.0) * 0.012;   // 樹冠輕輕搖
        vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      `${ATM} ${NOISE} uniform float uVis; uniform float uAlpha; uniform float uLeaf; varying vec3 vC; varying vec3 vN; varying vec3 vW; varying float vH;
      void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; float wrap = clamp((dot(n, uSun) + 0.4) / 1.4, 0.0, 1.0);
        vec3 col = vC; if (uLeaf > 0.5) { float lf = vn(vW.xz * 2.6 + vW.y * 2.1) * 0.6 + vn(vW.xy * 6.0 + vW.z) * 0.4; col *= 0.7 + 0.6 * lf; col *= 0.6 + 0.4 * smoothstep(4.5, 9.5, vH); }   // 樹葉一叢一叢的明暗，下半部、裡面暗
        vec3 v = normalize(vW - uCam); float back = pow(clamp(dot(v, uSun), 0.0, 1.0), 4.0) * uLeaf;
        vec3 c = col * (mix(vec3(0.3, 0.32, 0.42), vec3(0.98, 0.94, 0.88), 0.5 * n.y + 0.5) * 0.72 + uSunCol * uVis * (1.0 - 0.6 * cloudSh(vW)) * (wrap * 0.85 + back * 0.6));
        gl_FragColor = vec4(atmos(c, vW), uAlpha); }`, { uniforms: { uVis: { value: o.vis === undefined ? 1 : o.vis }, uAlpha: { value: o.alpha || 1 }, uLeaf: { value: o.leaf ? 1 : 0 }, uSway: { value: o.sway ? 1 : 0 } },
        opts: Object.assign({ side: THREE.DoubleSide }, o.alpha ? { transparent: true, depthWrite: false } : {}) });
    const colorize = (g, c) => { if (!g.attributes.normal) g.computeVertexNormals(); const q = g.index ? g.toNonIndexed() : g; const a = new Float32Array(q.attributes.position.count * 3), cc = typeof c === 'function' ? null : c;
      for (let i = 0; i < q.attributes.position.count; i++) { const col = cc || c(q.attributes.position.getX(i), q.attributes.position.getY(i), q.attributes.position.getZ(i)); a[i * 3] = col[0]; a[i * 3 + 1] = col[1]; a[i * 3 + 2] = col[2]; }
      q.setAttribute('color', new THREE.BufferAttribute(a, 3)); return q; };
    const mergeAll = (list) => { const P = [], Nn = [], C = []; list.forEach((g) => { const pa = g.attributes.position, na = g.attributes.normal, ca = g.attributes.color; for (let i = 0; i < pa.count; i++) { P.push(pa.getX(i), pa.getY(i), pa.getZ(i)); Nn.push(na.getX(i), na.getY(i), na.getZ(i)); C.push(ca.getX(i), ca.getY(i), ca.getZ(i)); } g.dispose(); });
      const r = keepG(new THREE.BufferGeometry()); r.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); r.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3)); r.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); return r; };
    const limb = (a, b, r0, r1) => { const d = b.clone().sub(a), L2 = d.length(), g = new THREE.CylinderGeometry(r1, r0, L2, 7, 1); g.translate(0, L2 / 2, 0); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize())); g.translate(a.x, a.y, a.z); return g; };

    // 孤樹：微微彎的樹幹分成五根主枝、再分小枝；樹冠是好幾團凹凸的葉叢
    if (TREE) { const T0 = TREE, wood = [], R0 = (k) => hash(k * 5.3 + 3, k * 1.7 + 8), bark = [0.3, 0.25, 0.2];
      T0.limbs.forEach(([a, b, r0, r1]) => wood.push(colorize(limb(V3(...a), V3(...b), r0, r1), bark)));
      const wm = new THREE.Mesh(mergeAll(wood), litMat({ vis: 0.8 })); scene.add(wm);
      const leaves = []; T0.crowns.forEach(([cx, cy, cz, r], k) => { const g = new THREE.SphereGeometry(r, 18, 12), p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), nn = 1 + (fbm(x * 1.2 + k * 7, y * 1.2 + z * 0.9 + k, 3) - 0.5) * 0.6; p.setXYZ(i, x * nn, y * nn * 0.8, z * nn); }
        g.computeVertexNormals(); g.translate(cx, cy, cz); leaves.push(colorize(g, [0.24 + 0.04 * R0(k), 0.38 + 0.05 * R0(k + 1), 0.15])); });
      const lm = new THREE.Mesh(mergeAll(leaves), litMat({ vis: 1, leaf: true, sway: true })); scene.add(lm); }

    // 從缺口照進來的光束：幾道很淡的暖光，斜斜地穿過晨霧落進盆地；朝著太陽看時最明顯
    { const sd = U.uSun.value, D = V3(-sd.x, -sd.y, -sd.z), A0 = V3(NOTCH[0] * 1.08, 7, NOTCH[1] * 1.06), pos = [], uv = [], info = [], idx = []; let n = 0;
      for (let b = 0; b < 8; b++) { const off = V3((hash(b, 1) - 0.5) * 36, (hash(b, 2) - 0.2) * 10, (hash(b, 3) - 0.5) * 36), A = A0.clone().add(off), len = 90 + hash(b, 4) * 70, wdt = 3 + hash(b, 5) * 7;
        for (const [u, v] of [[-1, 0], [1, 0], [-1, 1], [1, 1]]) { pos.push(A.x, A.y, A.z); uv.push(u, v); info.push(len, wdt, hash(b, 6)); }
        idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); n += 4; }
      const g = keepG(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aQ', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('info', new THREE.Float32BufferAttribute(info, 3)); g.setIndex(idx);
      const m = new THREE.Mesh(g, shader(`attribute vec2 aQ; attribute vec3 info; uniform vec3 uCam; uniform vec3 uD; varying vec2 vUv; varying float vSeed; varying vec3 vW;
        void main(){ vec3 A = position, P0 = A + uD * info.x * aQ.y; vec3 toCam = normalize(uCam - P0); vec3 side = normalize(cross(uD, toCam));   // 繞著光束的方向轉向你，看起來是一道立體的光
          vec3 P = P0 + side * aQ.x * info.y * (0.6 + 0.6 * aQ.y); vUv = aQ; vSeed = info.z; vW = P; gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0); }`,
        `${ATM} ${NOISE} varying vec2 vUv; varying float vSeed; varying vec3 vW; void main(){ float across = 1.0 - smoothstep(0.2, 1.0, abs(vUv.x)), along = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          float flick = 0.65 + 0.35 * vn(vec2(vUv.x * 2.0 + vSeed * 9.0, vUv.y * 3.0 - uT * 0.05)); vec3 v = normalize(vW - uCam); float face = 0.25 + 0.75 * pow(max(dot(v, uSun), 0.0), 2.0);
          float a = across * along * flick * face * 0.06 * (1.0 - 0.7 * cloudSh(vW)); gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * a, a); }`,
        { uniforms: { uD: { value: D } }, opts: { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide } }));
      m.frustumCulled = false; m.renderOrder = 6; scene.add(m); }

    // 空中飄的細毛（像蒲公英的種子），在你四周慢慢順風飄、上下浮；逆光時一閃一閃
    { const NP = coarse ? 260 : 600, pos = new Float32Array(NP * 3), sd2 = new Float32Array(NP * 4); for (let i = 0; i < NP; i++) { pos[i * 3] = Math.random() * 28; pos[i * 3 + 2] = Math.random() * 28; for (let c = 0; c < 4; c++) sd2[i * 4 + c] = Math.random(); }
      const g = keepG(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(sd2, 4));
      const m = new THREE.Points(g, shader(`${NOISE} uniform sampler2D uHF; uniform vec3 uCam; uniform float uT; uniform float uPR; attribute vec4 seed; varying float vB; varying vec3 vW;
        vec4 hfAt(vec2 wp){ return texture2D(uHF, (((wp + ${L.toFixed(1)}) / ${(2 * L).toFixed(1)}) * ${(N - 1).toFixed(1)} + 0.5) / ${N.toFixed(1)}); }
        void main(){ vec2 drift = vec2(0.8, -0.6) * uT * (0.35 + 0.4 * seed.x) + vec2(sin(uT * 0.3 + seed.y * 20.0), cos(uT * 0.27 + seed.z * 20.0)) * 0.8;
          vec2 wp = uCam.xz + mod(position.xz + drift - uCam.xz + 14.0, 28.0) - 14.0; vec4 hf = hfAt(wp);
          vec3 p = vec3(wp.x, hf.r + 0.4 + seed.w * 3.2 + sin(uT * (0.5 + seed.x) + seed.y * 30.0) * 0.25, wp.y); vec4 mv = viewMatrix * vec4(p, 1.0);
          float d = -mv.z; vB = smoothstep(14.0, 8.0, length(wp - uCam.xz)) * hf.g; vW = p; gl_PointSize = clamp(uPR * 0.03 / max(d, 0.1), 1.0, 6.0); gl_Position = projectionMatrix * mv; }`,
        `${ATM} varying float vB; varying vec3 vW; void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c); if (r > 0.5) discard; vec3 v = normalize(vW - uCam);
          float glint = pow(max(dot(v, uSun), 0.0), 6.0); float a = smoothstep(0.5, 0.1, r) * vB * (0.25 + 1.2 * glint); gl_FragColor = vec4(vec3(1.0, 0.95, 0.85), a); }`,
        { uniforms: { uHF: ext.uHF, uPR: { value: 800 } }, opts: { transparent: true, depthWrite: false } }));
      m.frustumCulled = false; m.renderOrder = 7; scene.add(m); F = F || {}; F.fluffMat = m.material; }

    // 蝴蝶（白色的、淡黃色的、小小的藍色的）：停在陽光照到的花草上，翅膀慢慢開合曬太陽；偶爾飛一小段再停下
    F = F || {}; F.bugs = [];
    const wingTex = (kind) => { const c = document.createElement('canvas'); c.width = 128; c.height = 192; const g = c.getContext('2d');
      const fore = new Path2D('M0 64 C30 30 80 8 122 14 C128 40 118 78 104 96 C70 104 30 104 0 104 Z'), hind = new Path2D('M0 100 C40 98 86 104 96 124 C98 150 78 178 50 184 C26 186 8 168 0 150 Z');
      const base = [['#f3f1ea', '#c9c8c2'], ['#f7dd6a', '#e2c04a'], ['#8eaaf2', '#5a6fb8']][kind];
      for (const path of [hind, fore]) { const gr = g.createRadialGradient(0, 100, 4, 0, 100, 130); gr.addColorStop(0, base[1]); gr.addColorStop(0.45, base[0]); gr.addColorStop(1, base[0]); g.fillStyle = gr; g.fill(path); }
      g.save(); g.clip(fore);
      if (kind === 0) { g.fillStyle = '#26262a'; g.beginPath(); g.ellipse(118, 20, 34, 26, -0.4, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(72, 62, 7, 0, Math.PI * 2); g.fill(); }
      if (kind === 1) { g.fillStyle = '#e9852c'; g.beginPath(); g.arc(66, 58, 5, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#8a5a22'; g.lineWidth = 3; g.stroke(fore); }
      if (kind === 2) { g.strokeStyle = '#2e3550'; g.lineWidth = 9; g.stroke(fore); g.strokeStyle = '#f2f2f2'; g.lineWidth = 2.5; g.stroke(fore); }
      g.restore(); g.save(); g.clip(hind);
      if (kind === 1) { g.fillStyle = '#e9852c'; g.beginPath(); g.arc(52, 138, 5, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#8a5a22'; g.lineWidth = 3; g.stroke(hind); }
      if (kind === 2) { g.strokeStyle = '#2e3550'; g.lineWidth = 9; g.stroke(hind); g.strokeStyle = '#f2f2f2'; g.lineWidth = 2.5; g.stroke(hind); }
      if (kind === 0) { g.fillStyle = 'rgba(60,60,60,.35)'; g.beginPath(); g.arc(30, 112, 5, 0, Math.PI * 2); g.fill(); }
      g.restore(); g.strokeStyle = 'rgba(40,35,30,.28)'; g.lineWidth = 1;   // 翅脈
      for (const [x1, y1] of [[110, 30], [114, 60], [100, 88], [80, 120], [70, 160], [40, 178]]) { g.beginPath(); g.moveTo(0, 100); g.quadraticCurveTo(x1 * 0.4, (100 + y1) / 2, x1, y1); g.stroke(); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; texs.push(t); return t; };
    const wingMat = (tex) => shader(`varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      `${ATM} uniform sampler2D uMap; varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vec4 t = texture2D(uMap, vUv); if (t.a < 0.5) discard; vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
        vec3 v = normalize(vW - uCam); float wrap = clamp((dot(n, uSun) + 0.4) / 1.4, 0.0, 1.0), thru = pow(max(dot(v, uSun), 0.0), 2.0);   // 逆光時陽光從翅膀透過來
        vec3 c = t.rgb * (vec3(0.6, 0.62, 0.7) + uSunCol * (1.0 - 0.6 * cloudSh(vW)) * (wrap * 0.8 + thru * 0.7)); gl_FragColor = vec4(atmos(c, vW), 1.0); }`, { uniforms: { uMap: { value: tex } }, opts: { side: THREE.DoubleSide } });
    const sunlitSpot = (x0, z0, r) => { for (let tries = 0; tries < 30; tries++) { const x = x0 + (Math.random() - 0.5) * 2 * r, z = z0 + (Math.random() - 0.5) * 2 * r; if (qOf(x, z) < 0.85 && visAt(x, z) > 0.6 && polyDist(CREEK, x, z) > 2.5) return [x, hAt(x, z) + 0.7 + Math.random() * 0.25, z]; } return null; };
    const wtex = [0, 1, 2].map(wingTex), wmats = wtex.map(wingMat), bodyMat = litMat({ vis: 1 });
    // 身體：頭（前）、胸、細長的腹（後）、兩根前端膨大的觸角；牠的前方是 +z
    const bodyGeo = mergeAll([colorize(new THREE.SphereGeometry(0.0032, 8, 6).translate(0, 0, 0.0085), [0.12, 0.11, 0.1]), colorize(new THREE.SphereGeometry(0.0042, 8, 6).scale(1, 1, 1.4), [0.18, 0.16, 0.14]),
      colorize(new THREE.CylinderGeometry(0.0028, 0.0012, 0.02, 6).rotateX(Math.PI / 2).translate(0, 0, -0.014), [0.2, 0.18, 0.15]),
      ...[-1, 1].map((sx) => colorize(limb(V3(sx * 0.0015, 0.001, 0.01), V3(sx * 0.006, 0.007, 0.024), 0.0004, 0.0004), [0.12, 0.11, 0.1])),
      ...[-1, 1].map((sx) => colorize(new THREE.SphereGeometry(0.0011, 6, 4).translate(sx * 0.006, 0.007, 0.024), [0.12, 0.11, 0.1]))]);
    for (let b = 0; b < (coarse ? 8 : 14); b++) { const k = b % 3, sz = k === 2 ? 0.75 : 1;
      const wing = (side) => { const g = new THREE.PlaneGeometry(0.032, 0.048); g.translate(0.016, 0, 0); g.rotateX(-Math.PI / 2); g.scale(1, 1, -1);   // 鉸鏈在身體上（x=0），畫布上方（前翅）朝 +z
        if (side < 0) g.scale(-1, 1, 1); return new THREE.Mesh(keepG(g), wmats[k]); };
      const grp = new THREE.Group(), wl = wing(-1), wr = wing(1); grp.add(new THREE.Mesh(bodyGeo, bodyMat), wl, wr); grp.scale.setScalar(1.25 * sz); scene.add(grp);
      const home = b < 6 ? [START.x + (Math.random() - 0.5) * 30, START.z - 10 - Math.random() * 25] : CREEK[10 + Math.floor(Math.random() * 70)];
      const at = sunlitSpot(home[0], home[1], 8) || [home[0], hAt(home[0], home[1]) + 0.75, home[1]];
      grp.position.set(...at); grp.rotation.y = Math.random() * 6.28; F.bugs.push({ kind: 'fly', grp, wl, wr, home, t: Math.random() * 10, next: 4 + Math.random() * 14, from: null, to: null, fT: 0, ph: Math.random() * 6 }); }
    // 蜻蜓：停在小溪邊的草尖上，翅膀平平張開，偶爾振一下翅膀、換個位置
    for (let b = 0; b < 7; b++) { const mat = litMat({ vis: 1 }), wmat = litMat({ vis: 1, alpha: 0.4 }), grp = new THREE.Group();
      grp.add(new THREE.Mesh(keepG(colorize(new THREE.CylinderGeometry(0.0022, 0.0016, 0.07, 6).rotateX(Math.PI / 2).translate(0, 0, -0.012), b % 3 === 2 ? [0.75, 0.28, 0.16] : [0.14, 0.45, 0.78])), mat), new THREE.Mesh(keepG(colorize(new THREE.SphereGeometry(0.0045, 8, 6).translate(0, 0, 0.026), [0.2, 0.35, 0.4])), mat));
      const wings = []; for (const [sx, zz] of [[1, 0.012], [-1, 0.012], [1, 0.0], [-1, 0.0]]) { const g = new THREE.CircleGeometry(1, 12); g.scale(0.022, 0.0045, 1); g.translate(0.022, 0, 0); g.rotateX(-Math.PI / 2); if (sx < 0) g.scale(-1, 1, 1); g.translate(0, 0, zz);
        const w = new THREE.Mesh(keepG(colorize(g, [0.9, 0.93, 0.95])), wmat); wings.push(w); grp.add(w); }
      const ci = 3 + Math.floor(b / 7 * 34 + Math.random() * 4), [cx, cz] = CREEK[ci], side = Math.random() < 0.5 ? -1 : 1, px = cx + side * (2.0 + Math.random() * 0.8), pz = cz + (Math.random() - 0.5) * 2;   // 出發點附近那段小溪
      grp.position.set(px, hAt(px, pz) + 0.95, pz); grp.rotation.y = Math.random() * 6.28; grp.scale.setScalar(1.7); scene.add(grp);
      F.bugs.push({ kind: 'drag', grp, wings, home: [cx, cz], t: Math.random() * 10, next: 6 + Math.random() * 15, from: null, to: null, fT: 0, ph: 0 }); }
    // 鳥群：偶爾一小群鳥從高空飛過
    F.birds = []; F.flockT = 12 + Math.random() * 20;
    for (let b = 0; b < 8; b++) { const mat = litMat({ vis: 0.6 }), grp = new THREE.Group(), body = new THREE.Mesh(keepG(colorize(new THREE.SphereGeometry(0.09, 6, 4).scale(0.7, 0.6, 1.8), [0.16, 0.15, 0.16])), mat);
      const wing = (s) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.08, s * 0.42, 0, -0.02, 0, 0, -0.1], 3)); g.computeVertexNormals(); return new THREE.Mesh(keepG(colorize(g, [0.16, 0.15, 0.16])), mat); };
      const wl = wing(-1), wr = wing(1); grp.add(body, wl, wr); grp.visible = false; scene.add(grp); F.birds.push({ grp, wl, wr, off: V3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 8), ph: Math.random() * 6 }); }
  }
  // 和草一樣的風（顯示卡上 windAt 的同一個算法），讓停在草尖的蝴蝶、蜻蜓跟著草一起動
  function gustJS(x, z, t) { const qx = x * 0.05 - 0.8 * t * 0.32, qz = z * 0.05 + 0.6 * t * 0.32; return vnoise(qx, qz) * 0.6 + vnoise(qx * 2.4 + 7, qz * 2.4 + 7) * 0.3 + vnoise(qx * 5 + 3, qz * 5 + 3) * 0.1; }
  const windJS = (x, z, t) => sstep(0.42, 0.86, Math.max(gustJS(x, z, t), gustJS(x, z, t - 0.6) * 0.85));
  function fauna(dt) {
    if (!F || !F.bugs) return; const t = S.t;
    const near = (coarse ? 12 : 19) * 0.7;
    for (const b of F.bugs) { b.t += dt; b.grp.visible = Math.hypot(b.grp.position.x - S.x, b.grp.position.z - S.z) < near;
      if (!b.to) { b.next -= dt;
        if (!b.rest) b.rest = b.grp.position.clone();
        const wa = windJS(b.rest.x, b.rest.z, t), lean = (0.05 + 0.72 * wa) * 0.75;   // 停著：跟著草尖一起被風吹
        b.grp.position.set(b.rest.x + 0.8 * lean, b.rest.y - 0.3 * lean * lean, b.rest.z - 0.6 * lean);
        const pd = Math.hypot(b.rest.x - S.x, b.rest.z - S.z);
        if ((pd < 2.6 || (wa > 0.7 && Math.random() < dt * 1.5)) && b.next > 0.3) { b.next = 0; b.flee = true; }   // 有人走近、或大陣風吹來：飛走
        if (b.kind === 'fly') { const open = 0.25 + 1.25 * (0.5 + 0.5 * Math.cos(b.t * 0.7 + b.ph)); b.wl.rotation.z = -open; b.wr.rotation.z = open; }   // 停著：翅膀慢慢開合曬太陽
        else { const q = Math.max(0, Math.sin(b.t * 9)) * (Math.sin(b.t * 0.6 + b.ph) > 0.93 ? 0.25 : 0); b.wings.forEach((w, i) => (w.rotation.z = (i % 2 ? -1 : 1) * q)); }   // 偶爾振一下翅膀
        if (b.next <= 0) { const r = b.flee ? 9 : (b.kind === 'fly' ? 4 : 3); let to = null; const ax = b.grp.position.x - S.x, az = b.grp.position.z - S.z, al = Math.hypot(ax, az) || 1;
          for (let k = 0; k < 30 && !to; k++) { let x = b.grp.position.x + (Math.random() - 0.5) * 2 * r, z = b.grp.position.z + (Math.random() - 0.5) * 2 * r;
            if (b.flee) { x += ax / al * r * 0.6; z += az / al * r * 0.6; if (Math.hypot(x - S.x, z - S.z) < 5) continue; }   // 往離開你的方向飛
            if (qOf(x, z) > 0.85) continue; if (b.kind === 'fly' && (visAt(x, z) < 0.5 || polyDist(CREEK, x, z) < 2.5)) continue; if (b.kind === 'drag' && Math.abs(polyDist(CREEK, x, z) - 2.6) > 1.2) continue;
            to = new THREE.Vector3(x, hAt(x, z) + (b.kind === 'fly' ? 0.7 + Math.random() * 0.25 : 0.85), z); }
          if (to) { b.from = b.grp.position.clone(); b.to = to; b.fT = 0; b.dur = b.from.distanceTo(to) / ((b.kind === 'fly' ? 1.2 : 2.5) * (b.flee ? 1.8 : 1)) + 0.4; } else b.next = 3; b.flee = false; } }
      else { b.fT += dt / b.dur; const k = Math.min(1, b.fT), e = k * k * (3 - 2 * k), p = b.from.clone().lerp(b.to, e); p.y += Math.sin(Math.PI * k) * (b.kind === 'fly' ? 0.6 : 0.3) + (b.kind === 'fly' ? Math.sin(b.t * 7) * 0.05 : 0);
        b.grp.position.copy(p); b.grp.rotation.y = Math.atan2(b.to.x - b.from.x, b.to.z - b.from.z);
        if (b.kind === 'fly') { const f = 0.9 + 0.75 * Math.sin(b.t * 24); b.wl.rotation.z = -f; b.wr.rotation.z = f; } else b.wings.forEach((w, i) => (w.rotation.z = (i % 2 ? -1 : 1) * Math.sin(b.t * 60) * 0.35));
        if (k >= 1) { b.rest = b.to.clone(); b.to = null; b.next = (b.kind === 'fly' ? 6 : 10) + Math.random() * 16; b.grp.rotation.y += (Math.random() - 0.5) * 2; } } }
    // 鳥群
    F.flockT -= dt;
    if (F.flockT < 0 && !F.flock) { const a = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 90, dir = new THREE.Vector3(Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2));
      const c = new THREE.Vector3(S.x + Math.cos(a) * dist * 0.4, S.y + 45 + Math.random() * 35, S.z + Math.sin(a) * dist * 0.4); F.flock = { p: c.clone().addScaledVector(dir, -220), dir, life: 0 }; F.birds.forEach((b) => (b.grp.visible = true)); }
    if (F.flock) { const fl = F.flock; fl.life += dt; fl.p.addScaledVector(fl.dir, 13 * dt);
      F.birds.forEach((b, i) => { const p = fl.p.clone().add(b.off).addScaledVector(fl.dir, -Math.abs(i - 3.5) * 2.2); b.grp.position.copy(p); b.grp.rotation.y = Math.atan2(fl.dir.x, fl.dir.z); b.grp.scale.setScalar(2.2);
        const fl2 = Math.sin(t * 9 + b.ph) * (Math.sin(t * 0.8 + b.ph) > 0.3 ? 0.7 : 0.1); b.wl.rotation.z = fl2; b.wr.rotation.z = -fl2; });
      if (fl.life > 36) { F.flock = null; F.flockT = 35 + Math.random() * 45; F.birds.forEach((b) => (b.grp.visible = false)); } }
  }

  /* ---------- 小溪兩岸：圓潤的淺灰白石頭（一堆一堆，有的半泡在水裡）、水面上的小圓葉、水邊的小花 ---------- */
  function riverside() {
    const R = (s) => hash(s * 1.93 + 0.7, s * 5.31 + 2.1), stones = [], blooms = [];
    const path = CREEK.concat(CREEK_OUT.slice(1, 40));
    for (let k = 2; k < path.length - 1; k++) {
      const [x, z] = path[k], [x2, z2] = path[k + 1], dl = Math.hypot(x2 - x, z2 - z) || 1, nx = -(z2 - z) / dl, nz = (x2 - x) / dl, w = 1.2;
      const nS = R(k) < 0.85 ? 1 + Math.floor(R(k + 0.3) * 3) : 0;
      for (let m = 0; m < nS; m++) { const side = R(k * 3 + m) < 0.5 ? -1 : 1, inWater = R(k * 7 + m) < 0.18, off = inWater ? R(k + m * 0.7) * w * 0.8 : w + 0.1 + R(k * 5 + m) * 1.3, along = (R(k * 11 + m) - 0.5) * 2.5;
        const sx = x + nx * off * side + (x2 - x) / dl * along, sz = z + nz * off * side + (z2 - z) / dl * along, sc = (inWater ? 0.18 : 0.22) + Math.pow(R(k * 13 + m), 2.2) * (inWater ? 0.45 : 1.1);
        stones.push([sx, hAt(sx, sz) - sc * 0.35 + (inWater ? 0.15 : 0), sz, sc, R(k * 17 + m), visAt(sx, sz)]); }
      const nF = Math.floor(R(k + 0.45) * 10); for (let m = 0; m < nF; m++) { const side = R(k * 37 + m) < 0.5 ? -1 : 1, off = w + 0.6 + R(k * 41 + m) * 3.2, along = (R(k * 43 + m) - 0.5) * 3;
        const fx = x + nx * off * side + (x2 - x) / dl * along, fz = z + nz * off * side + (z2 - z) / dl * along; blooms.push([fx, hAt(fx, fz), fz, R(k * 47 + m), R(k * 53 + m), visAt(fx, fz)]); }
    }
    { let tries = 0; while (stones.length < (coarse ? 160 : 260) && tries++ < 20000) {
        const x = (R(tries * 3.1) * 2 - 1) * AX * 1.05, z = ZC + (R(tries * 5.7) * 2 - 1) * AZ * 1.05, q = qOf(x, z);
        if (q > Q_OUT - 0.02 || (q > 0.86 && q < Q_IN + 0.03)) continue;                               // 盆底、坡上、稜線頂都可以；稜線邊緣的陡處不要
        if (fbm(x * 0.03 + 9, z * 0.03 + 2, 3) < 0.5) continue;                                      // 一片一片地出現，不是平均撒
        const sl = Math.max(Math.abs(hAt(x + 1, z) - hAt(x - 1, z)), Math.abs(hAt(x, z + 1) - hAt(x, z - 1))) / 2; if (sl > 0.3) continue;   // 岩壁、陡坡上沒有
        if (polyDist(CREEK, x, z) < 2) continue;
        const n = R(tries * 7.3) < 0.6 ? 1 : 2 + Math.floor(R(tries * 9.1) * 4);
        for (let m = 0; m < n; m++) { const sx = x + (R(tries + m * 1.3) - 0.5) * 2.4 * (n > 1), sz = z + (R(tries + m * 2.9) - 0.5) * 2.4 * (n > 1), sc = 0.15 + Math.pow(R(tries * 11 + m), 2.5) * (m ? 0.5 : 1.1);
          stones.push([sx, hAt(sx, sz) - sc * 0.4, sz, sc, R(tries * 13 + m), visAt(sx, sz)]); } } }
    // 石頭佔的地方：畫進一張遮罩，草、花、穗都不長在石頭上
    { const SM = 2048, cs = 2 * L / SM, m = new Uint8Array(SM * SM);
      for (const it of stones) { const rf = it[3] * Math.max(1 + 0.5 * it[4], 1.3 - 0.4 * it[4]) * 0.68, i0 = Math.floor((it[0] - rf + L) / cs), i1 = Math.ceil((it[0] + rf + L) / cs), j0 = Math.floor((it[2] - rf + L) / cs), j1 = Math.ceil((it[2] + rf + L) / cs);
        for (let j = Math.max(0, j0); j <= Math.min(SM - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(SM - 1, i1); i++) { const d = Math.hypot((i + 0.5) * cs - L - it[0], (j + 0.5) * cs - L - it[2]); if (d < rf) m[j * SM + i] = 255; } }
      stoneTex = new THREE.DataTexture(m, SM, SM, THREE.RedFormat, THREE.UnsignedByteType); stoneTex.magFilter = stoneTex.minFilter = THREE.LinearFilter; stoneTex.needsUpdate = true; texs.push(stoneTex); }
    const lit = `${ATM} varying vec3 vC; varying vec3 vN; varying vec3 vW; varying float vV; void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
        vec3 amb = mix(vec3(0.3, 0.32, 0.42), vec3(0.98, 0.94, 0.88), 0.5 * n.y + 0.5); float wrap = clamp((dot(n, uSun) + 0.45) / 1.45, 0.0, 1.0);
        vec3 c = vC * (amb * 0.75 + uSunCol * vV * (1.0 - 0.6 * cloudSh(vW)) * wrap * 0.8); gl_FragColor = vec4(atmos(c, vW), 1.0); }`;
    const instVS = (wind) => `${NOISE} attribute vec3 color; attribute vec4 aI; varying vec3 vC; varying vec3 vN; varying vec3 vW; varying float vV; uniform float uT; uniform vec3 uCam;
      void main(){ vC = color * aI.xyz; vV = aI.w; vN = normalize(mat3(modelMatrix * instanceMatrix) * normal); vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        ${wind ? `vec3 b = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; vec2 WD = normalize(vec2(0.8, -0.6));
        vec2 q0 = b.xz * 0.05 - WD * uT * 0.32, q1 = b.xz * 0.05 - WD * (uT - 0.6) * 0.32;
        float n0 = vn(q0) * 0.6 + vn(q0 * 2.4 + 7.0) * 0.3 + vn(q0 * 5.0 + 3.0) * 0.1, n1 = vn(q1) * 0.6 + vn(q1 * 2.4 + 7.0) * 0.3 + vn(q1 * 5.0 + 3.0) * 0.1;
        float wa = smoothstep(0.42, 0.86, max(n0, n1 * 0.85)) + sin(uT * 2.6 + b.x * 3.1) * 0.05;   // 和草同一陣風
        float hh = max(w.y - b.y, 0.0); w.xz += WD * (0.05 + 0.72 * wa) * hh * hh * 2.2; w.y -= 0.35 * wa * wa * hh * hh * 1.2;
        float keep = smoothstep(${(coarse ? 12 : 19).toFixed(1)}, ${(coarse ? 12 * 0.5 : 19 * 0.5).toFixed(1)}, length(b.xz - uCam.xz)); w.xyz = mix(b, w.xyz, keep);   // 跟草一樣，遠了就不顯示` : ''}
        vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
    const place = (geo, list, mk, vs) => { const im = new THREE.InstancedMesh(geo, shader(vs || instVS(), lit, { opts: { side: THREE.DoubleSide } }), list.length), ai = new Float32Array(list.length * 4), m4 = new THREE.Matrix4();
      list.forEach((it, i) => { const [col, mat] = mk(it, m4); ai.set([col[0], col[1], col[2], it[5]], i * 4); im.setMatrixAt(i, mat); });
      geo.setAttribute('aI', new THREE.InstancedBufferAttribute(ai, 4)); im.frustumCulled = false; scene.add(im); };
    const withColor = (g, c) => { if (!g.attributes.normal) g.computeVertexNormals(); const q = g.index ? g.toNonIndexed() : g; if (!q.attributes.normal) q.computeVertexNormals(); const a = new Float32Array(q.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = c[0]; a[i + 1] = c[1]; a[i + 2] = c[2]; } q.setAttribute('color', new THREE.BufferAttribute(a, 3)); return q; };
    const mergeG = (list) => { const P = [], Nn = [], C = []; list.forEach((g) => { const pa = g.attributes.position, na = g.attributes.normal, ca = g.attributes.color; for (let i = 0; i < pa.count; i++) { P.push(pa.getX(i), pa.getY(i), pa.getZ(i)); Nn.push(na.getX(i), na.getY(i), na.getZ(i)); C.push(ca.getX(i), ca.getY(i), ca.getZ(i)); } g.dispose(); });
      const r = keepG(new THREE.BufferGeometry()); r.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); r.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3)); r.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); return r; };
    const q4 = new THREE.Quaternion(), e = new THREE.Euler(), V3 = (x, y, z) => new THREE.Vector3(x, y, z);
    // 石頭：一顆圓潤、微微凹凸的石頭（頂點用雜訊推），每顆再用不同的比例、轉向，壓扁一點
    { const g = new THREE.SphereGeometry(1, 28, 18), p = g.attributes.position; for (let i = 0; i < p.count; i++) { const v = V3(p.getX(i), p.getY(i), p.getZ(i)), n = 1 + (fbm(v.x * 1.3 + 5, v.y * 1.3 + v.z * 0.7, 3) - 0.5) * 0.45; p.setXYZ(i, v.x * n, v.y * n * 0.62, v.z * n); }
      g.computeVertexNormals(); const sg = keepG(withColor(g, [1, 1, 1])); g.dispose();
      place(sg, stones, (it, m4) => { const tint = 0.7 + 0.14 * it[4]; return [[tint * 0.96, tint * 0.97, tint * 1.04], m4.compose(V3(it[0], it[1], it[2]), q4.setFromEuler(e.set((it[4] - 0.5) * 0.4, it[4] * 6.28, (it[4] - 0.5) * 0.3)), V3(it[3] * (1 + 0.5 * it[4]), it[3], it[3] * (1.3 - 0.4 * it[4])))]; }); }
    // 水邊的小花：橘色的雛菊、藍色一串串的穗狀花、粉色的小花團；細細的莖會隨風搖
    { const stem = (h) => withColor(new THREE.CylinderGeometry(0.004, 0.006, h, 4).translate(0, h / 2, 0), [0.3, 0.45, 0.18]);
      const daisy = () => { const parts = [stem(0.36)]; for (let i = 0; i < 11; i++) { const a = i / 11 * Math.PI * 2, pg = new THREE.PlaneGeometry(0.014, 0.045).translate(0, 0.024, 0).rotateX(-1.25).rotateY(a); pg.translate(0, 0.36, 0); parts.push(withColor(pg, [0.96, 0.46, 0.22])); }
        parts.push(withColor(new THREE.SphereGeometry(0.012, 8, 6).scale(1, 0.55, 1).translate(0, 0.365, 0), [0.92, 0.7, 0.25])); return mergeG(parts); };
      const spike = () => { const parts = [stem(0.42)]; for (let i = 0; i < 9; i++) { const y = 0.26 + i * 0.019, r = 0.013 * (1 - i / 11); parts.push(withColor(new THREE.SphereGeometry(r, 6, 4).translate(Math.sin(i * 2.4) * 0.006, y, Math.cos(i * 2.4) * 0.006), [0.36, 0.46, 0.86])); } return mergeG(parts); };
      const puff = () => { const parts = [stem(0.3)]; for (let i = 0; i < 5; i++) parts.push(withColor(new THREE.SphereGeometry(0.011, 6, 5).translate(Math.cos(i * 1.26) * 0.014, 0.3 + (i % 2) * 0.008, Math.sin(i * 1.26) * 0.014), [0.95, 0.62, 0.72])); return mergeG(parts); };
      const sway = true;
      [[daisy, 0, 0.45], [spike, 0.45, 0.78], [puff, 0.78, 1.01]].forEach(([mk, a, b]) => { const list = blooms.filter((f) => f[3] >= a && f[3] < b); if (!list.length) return;
        place(mk(), list, (it, m4) => [[1, 1, 1], m4.compose(V3(it[0], it[1], it[2]), q4.setFromEuler(e.set((it[4] - 0.5) * 0.3, it[4] * 6.28, 0)), V3(1, 0.8 + 0.5 * it[4], 1).multiplyScalar(1.4))], instVS(sway)); }); }
  }

  /* ---------- 建立空間 ---------- */
  function init(T) {
    if (scene) return;
    THREE = T; scene = new THREE.Scene(); LOD = []; QL = { q: 1, ft: 16, t: 0, gpu: false };
    coarse = (typeof matchMedia !== 'undefined' && matchMedia('(pointer:coarse)').matches) || (navigator.hardwareConcurrency || 8) <= 4;
    const V = (a) => new THREE.Vector3(...a);
    U = { uSun: { value: V(SUN).normalize() }, uSunCol: { value: V([1.0, 0.8, 0.6]) }, uCam: { value: V([0, 0, 0]) }, uHaze: { value: V([0.77, 0.76, 0.8]) }, uHazeSun: { value: V([0.97, 0.82, 0.66]) },
      uFogD: { value: 0.00042 }, uMistD: { value: 0.02 }, uMistY: { value: -1.5 }, uMistH: { value: 4.0 }, uT: { value: 0 } };

    // 水路：盆地裡的小溪從近處右邊流向缺口；出了缺口沿著外坡往下，接到平原上的大河
    const ctrl = [[34, 52], [27, 32], [14, 18], [-2, 4], [-9, -14], [-18, -32], [-34, -50], [-50, -66], [NOTCH[0] * 0.92, NOTCH[1] * 0.93 + ZC * 0.07], [NOTCH[0], NOTCH[1]]];
    CREEK = new THREE.CatmullRomCurve3(ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z))).getSpacedPoints(110).map((p) => [p.x, p.z]);
    const out = [[NOTCH[0], NOTCH[1]], [NOTCH[0] * 1.2, NOTCH[1] * 1.15], [NOTCH[0] * 1.55, NOTCH[1] * 1.4], [-175, -150], [-240, -185], [-300, -200]];
    CREEK_OUT = new THREE.CatmullRomCurve3(out.map(([x, z]) => new THREE.Vector3(x, 0, z))).getSpacedPoints(70).map((p) => [p.x, p.z]);
    const riv = [[-1900, -1300], [-1300, -760], [-820, -560], [-470, -430], [-300, -200], [-360, 60], [-560, 300], [-470, 560], [-160, 700], [260, 760], [700, 640], [1200, 820], [2000, 900]];
    RIVER = new THREE.CatmullRomCurve3(riv.map(([x, z]) => new THREE.Vector3(x, 0, z))).getSpacedPoints(220).map((p) => [p.x, p.z]);
    // 水位：沿著小溪往下游走，水位只降不升（遇到隆起的地方就挖成小河谷）；出了缺口接著往下
    { const base = (x, z) => (Math.abs(x) < L - 2 && Math.abs(z) < L - 2 ? baseHeight(x, z) : plainH(x, z)) - 0.1;
      CL = []; CREEK.forEach(([x, z], k) => CL.push(k ? Math.min(CL[k - 1] - 0.01, base(x, z)) : base(x, z)));
      COL = []; CREEK_OUT.forEach(([x, z], k) => COL.push(Math.min(k ? COL[k - 1] - 0.02 : CL[CL.length - 1], base(x, z)))); }

    // 盆地的地形格子：高度 → 法線 → 太陽照不照得到（沿著太陽方向看有沒有山擋住，邊緣軟軟的）→ 顏色
    const WANT_TREE = false;   // 孤樹：房主說先拿掉
    if (WANT_TREE) { const tx = -36, tz = -40, ty = heightAt(tx, tz), crowns = [], limbs = [], R0 = (k) => hash(k * 3.7 + 1, k * 9.1 + 2), P = (x, y, z) => [tx + x, ty + y, tz + z];
      const t1 = P(0.15, 2.2, 0), t2 = P(0.3, 4.0, -0.2); limbs.push([P(0, -0.3, 0), t1, 0.45, 0.36], [t1, t2, 0.36, 0.28]);
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2 + R0(k) * 0.8, h0 = 3.0 + R0(k + 5) * 1.2, from = P(0.2, h0, -0.1), len = 2.2 + R0(k + 7);
        const to = [from[0] + Math.cos(a) * len, from[1] + 1.6 + R0(k + 2) * 1.4, from[2] + Math.sin(a) * len]; limbs.push([from, to, 0.22, 0.12]);
        crowns.push([to[0], to[1] + 0.6, to[2], 2.0 + R0(k + 11) * 0.5]);
        for (let m = 0; m < 3; m++) { const b = a + (m - 1) * 0.75, l2 = 1.1 + R0(k * 3 + m) * 0.6, end = [to[0] + Math.cos(b) * l2, to[1] + 0.5 + R0(k * 3 + m + 1) * 0.8, to[2] + Math.sin(b) * l2];
          limbs.push([to, end, 0.11, 0.05]); crowns.push([end[0], end[1] + 0.25, end[2], 1.45 + R0(k * 5 + m) * 0.5]); } }
      crowns.push([tx + 0.3, ty + 7.6, tz - 0.2, 2.6], [tx + 0.2, ty + 6.0, tz, 2.4]);   // 中間厚厚的一團，把樹幹上段也包住
      TREE = { x: tx, z: tz, y: ty, crowns, limbs }; }
    HG = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) HG[j * N + i] = heightAt(-L + i * STEP, -L + j * STEP);
    const vis = VG = new Float32Array(N * N), nrm = new Float32Array(N * N * 3), dens = new Float32Array(N * N), sd = U.uSun.value;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, x = -L + i * STEP, z = -L + j * STEP, hx = HG[j * N + Math.min(N - 1, i + 1)] - HG[j * N + Math.max(0, i - 1)], hz = HG[Math.min(N - 1, j + 1) * N + i] - HG[Math.max(0, j - 1) * N + i];
      const nx = -hx / (2 * STEP), nz = -hz / (2 * STEP), nl = Math.hypot(nx, 1, nz); nrm[k * 3] = nx / nl; nrm[k * 3 + 1] = 1 / nl; nrm[k * 3 + 2] = nz / nl;
      const y0 = HG[k] + 0.4; let v = 1, t = 1.5;
      while (t < 520) { const px = x + sd.x * t, pz = z + sd.z * t; if (px < -L || px > L || pz < -L || pz > L) break;
        const gap = y0 + sd.y * t - hAt(px, pz); if (gap < 0) { v = 0; break; } v = Math.min(v, gap / (t * 0.035)); t *= 1.07; t += 0.6; }
      if (TREE && Math.hypot(x - TREE.x, z - TREE.z) < 120) for (const [cx, cy, cz, cr] of TREE.crowns) {   // 孤樹的影子（樹冠擋住低低的陽光）
        const ox = cx - x, oy = cy - y0, oz = cz - z, t2 = ox * sd.x + oy * sd.y + oz * sd.z; if (t2 <= 0) continue;
        const d = Math.hypot(ox - sd.x * t2, oy - sd.y * t2, oz - sd.z * t2); if (d < cr * 1.05) v *= lerp(0.3, 1, sstep(cr * 0.5, cr * 1.05, d)); }
      vis[k] = clamp(v, 0, 1);
      const q = qOf(x, z), slope = 1 - nrm[k * 3 + 1], dc = Math.min(polyDist(CREEK, x, z), polyDist(CREEK_OUT, x, z));
      dens[k] = (1 - sstep(0.22, 0.4, slope)) * (1 - sstep(Q_OUT, Q_OUT + 0.04, q)) * sstep(1.7, 2.8, dc);
    }
    // 給草用的地形貼圖：R 高度、G 陽光、B 草的密度
    const hf = new Uint16Array(N * N * 4), toH = THREE.DataUtils.toHalfFloat;
    for (let k = 0; k < N * N; k++) { hf[k * 4] = toH(HG[k]); hf[k * 4 + 1] = toH(vis[k]); hf[k * 4 + 2] = toH(dens[k]); hf[k * 4 + 3] = 0; }
    const hfTex = new THREE.DataTexture(hf, N, N, THREE.RGBAFormat, THREE.HalfFloatType); hfTex.magFilter = hfTex.minFilter = THREE.LinearFilter; hfTex.needsUpdate = true; texs.push(hfTex);

    // 盆地的地形網格：顏色（草地、岩壁、濕的河床）和光影在這裡一次算好
    const sc = U.uSunCol.value;
    const bake = (a, ny, ndl, v, grassK) => { const amb = 0.5 + 0.24 * ny, sunK = v * (1.0 * ndl + 0.2 * grassK); return [a[0] * (amb * 0.88 + sc.x * sunK), a[1] * (amb * 0.93 + sc.y * sunK), a[2] * (amb * 1.08 + sc.z * sunK)]; };
    const tg = keepG(new THREE.PlaneGeometry(2 * L, 2 * L, N - 1, N - 1)); tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position, col = new Float32Array(tp.count * 3), gcol = new Uint16Array(N * N * 4);   // gcol：每一格地面的顏色，給草的根部用
    for (let n = 0; n < tp.count; n++) {
      const x = tp.getX(n), z = tp.getZ(n), i = Math.round((x + L) / STEP), j = Math.round((z + L) / STEP), k = j * N + i; tp.setY(n, HG[k]);
      const ny = nrm[k * 3 + 1], slope = 1 - ny, ndl = Math.max(0, nrm[k * 3] * sd.x + ny * sd.y + nrm[k * 3 + 2] * sd.z), m = fbm(x * 0.05, z * 0.05, 3), m2 = fbm(x * 0.3, z * 0.3, 2);
      let a = GRASS_BASE.map((c, ci) => lerp(c, GRASS_TOP[ci], 0.35 + 0.25 * m)); { const hi = sstep(0.8, 0.95, qOf(x, z)); a = a.map((c, ci) => lerp(c, [0.3, 0.38, 0.22][ci], hi * 0.6)); }   // 高處的草色淡一點、不要螢光綠                              // 草地（和草葉同一個顏色）
      const rock = sstep(0.24, 0.42, slope), rc = 0.36 + 0.12 * m2; a = a.map((c, ci) => lerp(c, [rc, rc, rc * 0.96][ci], rock));   // 岩壁
      const wet = 1 - sstep(1.2, 2.6, Math.min(polyDist(CREEK, x, z), polyDist(CREEK_OUT, x, z))); a = a.map((c, ci) => lerp(c, [0.2, 0.23, 0.2][ci], wet * 0.8));
      const b = bake(a, ny, ndl, vis[k], dens[k]); col[n * 3] = b[0]; col[n * 3 + 1] = b[1]; col[n * 3 + 2] = b[2];
      gcol[k * 4] = toH(b[0]); gcol[k * 4 + 1] = toH(b[1]); gcol[k * 4 + 2] = toH(b[2]); gcol[k * 4 + 3] = 0;
    }
    const gTex = new THREE.DataTexture(gcol, N, N, THREE.RGBAFormat, THREE.HalfFloatType); gTex.magFilter = gTex.minFilter = THREE.LinearFilter; gTex.needsUpdate = true; texs.push(gTex);
    tg.setAttribute('color', new THREE.BufferAttribute(col, 3)); tg.computeVertexNormals();
    const groundFS = `${ATM} ${NOISE} varying vec3 vC; varying vec3 vW; void main(){ vec3 dx = dFdx(vW), dy = dFdy(vW); vec3 n = normalize(cross(dx, dy)); if (n.y < 0.0) n = -n; float steep = smoothstep(0.5, 0.75, 1.0 - n.y);
        float g = vn(vW.xz * 0.35) * 0.5 + vn(vW.xz * 1.7) * 0.3 + vn(vW.xz * 6.0) * 0.2;
        vec2 rp = vec2((vW.x - vW.z) * 0.7, vW.y); float r = fbm(rp * 0.18) * 0.6 + vn(rp * 1.1) * 0.4;
        vec2 so = vec2(0.5, 0.35); float bump = (fbm(rp * 0.3) - fbm(rp * 0.3 + so)) * 3.0 + (vn(rp * 1.4) - vn(rp * 1.4 + so * 1.5)) * 1.2;   // 岩面的凹凸：朝光的一側亮、背光的一側暗
        float crack = smoothstep(0.08, 0.0, abs(vn(vec2(rp.x * 0.9, rp.y * 0.08)) - 0.5)) * 0.35 + smoothstep(0.06, 0.0, abs(vn(rp * vec2(0.25, 0.6) + 7.0) - 0.5)) * 0.25;
        float moss = smoothstep(0.55, 0.75, fbm(rp * 0.09 + 3.0)) * 0.6;
        vec3 rock = vC * (0.74 + 0.45 * r) * (1.0 + bump * 0.25) * (1.0 - crack * 0.6); rock = mix(rock, rock * vec3(0.75, 0.95, 0.6), moss);
        vec3 c = mix(vC * (0.9 + 0.2 * g), rock, steep); c *= 1.0 - 0.22 * cloudSh(vW); gl_FragColor = vec4(atmos(c, vW), 1.0); }`;
    scene.add(new THREE.Mesh(tg, shader(`attribute vec3 color; varying vec3 vC; varying vec3 vW; void main(){ vC = color; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`, groundFS, { opts: DERIV })));

    // 外面的大平原（在盆地格子外面）：草原、一片片樹林下的深色地面、大河的河道；光影也一次算好
    { const SZ = 6400, SEGS = coarse ? 260 : 400, g = keepG(new THREE.PlaneGeometry(SZ, SZ, SEGS, SEGS)); g.rotateX(-Math.PI / 2);
      const p = g.attributes.position, c = new Float32Array(p.count * 3), H = new Float32Array(p.count);
      for (let n = 0; n < p.count; n++) { const x = p.getX(n), z = p.getZ(n); H[n] = (Math.abs(x) < L - 2 && Math.abs(z) < L - 2) ? Math.min(plainH(x, z), heightAt(x, z)) - 3 : plainH(x, z); p.setY(n, H[n]); }
      g.computeVertexNormals(); const nn = g.attributes.normal;
      for (let n = 0; n < p.count; n++) { const x = p.getX(n), z = p.getZ(n), ny = nn.getY(n), ndl = Math.max(0, nn.getX(n) * sd.x + ny * sd.y + nn.getZ(n) * sd.z), m = fbm(x * 0.01, z * 0.01, 3);
        const wood = sstep(0.56, 0.64, fbm(x * 0.0045 + 21, z * 0.0045 + 4, 4)), dr = polyDist(RIVER, x, z);
        let a = [lerp(0.26, 0.4, m), lerp(0.4, 0.5, m), lerp(0.14, 0.2, m)]; a = a.map((v, ci) => lerp(v, [0.12, 0.18, 0.1][ci], wood * (1 - sstep(10, 30, 60 - dr))));
        const rock = sstep(0.3, 0.5, 1 - ny); a = a.map((v, ci) => lerp(v, [0.38, 0.38, 0.37][ci], rock));
        const b = bake(a, ny, ndl, 1, 0.6 * (1 - rock)); c[n * 3] = b[0]; c[n * 3 + 1] = b[1]; c[n * 3 + 2] = b[2]; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      const m = new THREE.Mesh(g, shader(`attribute vec3 color; varying vec3 vC; varying vec3 vW; void main(){ vC = color; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`, groundFS, { opts: DERIV }));
      m.frustumCulled = false; scene.add(m);
      // 平原上的樹：一片片樹林和零散的樹，圓圓的闊葉樹和尖尖的針葉樹；不長在河邊和盆地的外坡上
      const R = (s) => hash(s * 1.37, s * 7.11), pick = [], NT = coarse ? 1000 : 2600;
      for (let s = 0; pick.length < NT && s < NT * 30; s++) { const ang = R(s) * Math.PI * 2, d = 230 + Math.pow(R(s + 0.5), 0.8) * 1900, x = Math.cos(ang) * d, z = Math.sin(ang) * d;
        if (qOf(x, z) < 1.62) continue; const wood = fbm(x * 0.0045 + 21, z * 0.0045 + 4, 4), dr = polyDist(RIVER, x, z);
        if (dr < 22) continue; const want = wood > 0.58 ? 0.85 : (dr < 60 ? 0.12 : 0.03); if (R(s + 0.25) > want) continue;
        pick.push([x, plainH(x, z), z, 7 + R(s + 0.7) * 9, R(s + 0.9) < (wood > 0.6 ? 0.45 : 0.15) ? 1 : 0, R(s + 0.3)]); }
      for (let s2 = 0, nb = 0; nb < (coarse ? 500 : 1400) && s2 < 90000; s2++) {   // 灌木：樹林邊緣多、草原上零散
        const ang = R(s2 + 0.11) * Math.PI * 2, d = 200 + Math.pow(R(s2 + 0.61), 0.7) * 1500, x = Math.cos(ang) * d, z = Math.sin(ang) * d;
        if (qOf(x, z) < 1.6) continue; const wood = fbm(x * 0.0045 + 21, z * 0.0045 + 4, 4), dr = polyDist(RIVER, x, z); if (dr < 16) continue;
        const want = wood > 0.5 && wood < 0.62 ? 0.7 : (dr < 50 ? 0.25 : 0.05); if (R(s2 + 0.37) > want) continue;
        pick.push([x, plainH(x, z), z, 1.6 + R(s2 + 0.77) * 2.2, 2, R(s2 + 0.53)]); nb++; }
      const lumpy = (r, seed) => { const g = new THREE.SphereGeometry(r, 8, 6), p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + (fbm(x * 4 + seed, y * 4 + z * 3 + seed, 3) - 0.5) * 0.55; p.setXYZ(i, x * k, y * k, z * k); } g.computeVertexNormals(); return g; };
      const treeMesh = (kind) => {
        const parts = [];
        if (kind === 0) { [[0, 0.62, 0, 0.36], [0.2, 0.56, 0.08, 0.26], [-0.18, 0.58, -0.1, 0.27], [0.04, 0.8, -0.05, 0.25], [-0.08, 0.5, 0.18, 0.22]].forEach(([x, y, z, r], k) => parts.push([lumpy(r, k * 3.3).translate(x, y, z), [0.2, 0.33, 0.13]]));
          parts.push([new THREE.CylinderGeometry(0.03, 0.05, 0.42, 4, 1, true).translate(0, 0.21, 0), [0.27, 0.21, 0.15]]); }
        else if (kind === 1) { [[0.42, 0.38, 0.45], [0.33, 0.36, 0.72], [0.22, 0.32, 0.96]].forEach(([r, h, y]) => parts.push([new THREE.ConeGeometry(r, h, 6, 1, true).translate(0, y, 0), [0.12, 0.22, 0.15]]));
          parts.push([new THREE.CylinderGeometry(0.025, 0.04, 0.4, 4, 1, true).translate(0, 0.2, 0), [0.25, 0.2, 0.15]]); }
        else { [[0, 0.32, 0, 0.42], [0.3, 0.24, 0.1, 0.3], [-0.28, 0.25, -0.06, 0.32]].forEach(([x, y, z, r], k) => parts.push([lumpy(r, k * 5.1 + 2).translate(x, y, z).scale(1, 0.75, 1), [0.24, 0.36, 0.15]])); }
        const P = [], Nn = [], C = [], LY = []; parts.forEach(([gg, col]) => { const q = gg.index ? gg.toNonIndexed() : gg; if (!q.attributes.normal) q.computeVertexNormals(); const pa = q.attributes.position, na = q.attributes.normal;
          for (let i = 0; i < pa.count; i++) { P.push(pa.getX(i), pa.getY(i), pa.getZ(i)); Nn.push(na.getX(i), na.getY(i), na.getZ(i)); C.push(...col); LY.push(pa.getY(i)); } gg.dispose(); });
        const geo = keepG(new THREE.BufferGeometry()); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); geo.setAttribute('ly', new THREE.Float32BufferAttribute(LY, 1));
        const list = pick.filter((t) => t[4] === kind), ai = new Float32Array(list.length);
        const im = new THREE.InstancedMesh(geo, shader(
          `attribute vec3 color; attribute float ly; attribute float aV; varying vec3 vC; varying vec3 vN; varying vec3 vW; varying float vLy; varying float vVr; void main(){ vC = color; vLy = ly; vVr = aV; vN = normalize(mat3(modelMatrix * instanceMatrix) * normal); vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
          `${ATM} ${NOISE} varying vec3 vC; varying vec3 vN; varying vec3 vW; varying float vLy; varying float vVr; void main(){ vec3 n = normalize(vN); float wrap = clamp((dot(n, uSun) + 0.35) / 1.35, 0.0, 1.0);
            vec3 col = vC * (0.85 + 0.3 * vVr) * mix(vec3(1.0), vec3(1.12, 1.08, 0.85), step(0.7, vVr)) * (0.9 + 0.2 * vn(vW.xz * 0.9 + vW.y));   // 每棵樹的綠稍有不同，有幾棵偏黃
            float occ = 0.55 + 0.45 * smoothstep(0.25, 0.9, vLy);   // 樹冠下半部、裡面比較暗
            vec3 c = col * occ * (vec3(0.46, 0.5, 0.6) * (0.6 + 0.4 * n.y) + uSunCol * wrap * 1.1 * (1.0 - 0.6 * cloudSh(vW))); gl_FragColor = vec4(atmos(c, vW), 1.0); }`), list.length);
        const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e = new THREE.Euler();
        list.forEach((t, i) => { const sc = t[3] * (kind === 1 ? 1.3 : 1); ai[i] = t[5]; m4.compose(new THREE.Vector3(t[0], t[1] - 0.3, t[2]), q4.setFromEuler(e.set(0, t[5] * 6.28, 0)), new THREE.Vector3(sc * (0.85 + 0.3 * t[5]), sc * (0.9 + 0.25 * R(i + 0.5)), sc * (0.85 + 0.3 * t[5]))); im.setMatrixAt(i, m4); });
        geo.setAttribute('aV', new THREE.InstancedBufferAttribute(ai, 1)); im.frustumCulled = false; scene.add(im); };
      treeMesh(0); treeMesh(1); treeMesh(2);
    }
    // 水：盆地裡的小溪、流出缺口沿外坡往下的那一段、平原上的大河
    scene.add(waterRibbon(CREEK, () => 1.5, (k) => CL[k] - 0.08, 1));
    scene.add(waterRibbon(CREEK_OUT, () => 1.2, (k) => COL[k] - 0.08, 0.8));
    scene.add(waterRibbon(RIVER, () => 10, () => PLAIN - 4.6 + 1.2, 0));
    riverside();

    // 天空：清晨的漸層（地平線靠太陽那邊是粉橘色，往上是淡淡的藍灰）、太陽與光暈、被晨光染成粉色的雲
    skyMesh = new THREE.Mesh(keepG(new THREE.SphereGeometry(5000, 48, 24)), shader(
      `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      `${ATM} ${NOISE} varying vec3 vD; void main(){ vec3 d = normalize(vD); float s = max(dot(d, uSun), 0.0), y = d.y;
        vec3 hor = mix(vec3(0.80, 0.77, 0.80), vec3(0.98, 0.79, 0.62), pow(s, 2.5)); vec3 mid = mix(vec3(0.72, 0.74, 0.81), vec3(0.93, 0.80, 0.74), pow(s, 4.0));
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.16, y)); c = mix(c, vec3(0.45, 0.54, 0.68), smoothstep(0.14, 0.75, y)); if (y < 0.0) c = mix(hor, uHaze, smoothstep(0.0, -0.12, y));
        vec2 uv = d.xz / (y + 0.12) * 1.3; float cl = fbm(uv * 0.9 + vec2(uT * 0.004, 0.0)), cl2 = fbm(uv * 2.3 - 5.0);
        float cov = smoothstep(0.5, 0.78, cl * 0.75 + cl2 * 0.3) * smoothstep(0.02, 0.2, y) * (1.0 - smoothstep(0.6, 0.95, y));
        vec3 lit = mix(vec3(0.86, 0.79, 0.82), vec3(1.0, 0.8, 0.64), pow(s, 2.0)), shade = vec3(0.56, 0.56, 0.64);
        c = mix(c, mix(shade, lit, smoothstep(0.35, 0.8, cl2)), cov * 0.85);
        c += vec3(1.0, 0.82, 0.62) * (pow(s, 900.0) * 3.0 + pow(s, 60.0) * 0.45 + pow(s, 7.0) * 0.16) * (1.0 - cov * 0.6);
        gl_FragColor = vec4(c, 1.0); }`, { opts: { side: THREE.BackSide, depthWrite: false } }));
    skyMesh.renderOrder = -10; skyMesh.frustumCulled = false; scene.add(skyMesh);

    // 平原盡頭的山脈：三層（越遠越淡、越藍），最遠那一層有雪
    for (const [R, peak, seed, snow] of [[2700, 260, 1, 0], [3300, 520, 2, 0], [4300, 1100, 3, 1]]) {
      const SEG = 360, ROWS = 6, pos = [], ci = [], idx = [];
      for (let s = 0; s <= SEG; s++) { const th = s / SEG * Math.PI * 2;
        let ph = 0; { let a = 1, f = 1; for (let o = 0; o < 6; o++) { const nv = vnoise(Math.cos(th) * 2.2 * f + seed * 9, Math.sin(th) * 2.2 * f + seed * 5); ph += a * (o < 2 ? nv : 1 - Math.abs(nv * 2 - 1)); a *= 0.45; f *= 2.3; } ph /= 1.8; }
        const top = 40 + peak * (0.3 + 1.1 * Math.pow(ph, 2.0));
        for (let r = 0; r <= ROWS; r++) { const k = r / ROWS, y = -60 + (top + 60) * k, rr = R + (1 - k) * (top + 60) * 1.6; pos.push(Math.cos(th) * rr, y, Math.sin(th) * rr); ci.push(k, y, snow); }
        if (s) for (let r = 0; r < ROWS; r++) { const a = (s - 1) * (ROWS + 1) + r, b = a + ROWS + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); } }
      const g = keepG(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('info', new THREE.Float32BufferAttribute(ci, 3)); g.setIndex(idx); g.computeVertexNormals();
      scene.add(new THREE.Mesh(g, shader(`attribute vec3 info; varying vec3 vI; varying vec3 vW; varying vec3 vN; void main(){ vI = info; vN = normal; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        `${ATM} ${NOISE} varying vec3 vI; varying vec3 vW; varying vec3 vN; void main(){ vec3 n = normalize(vN); float ndl = max(dot(n, uSun), 0.0);
          float th = atan(vW.z, vW.x); vec2 gp = vec2(th * 300.0 + vW.y * 0.05, vW.y * 0.22); float gully = fbm(gp * vec2(0.5, 1.0)) * 0.7 + vn(gp * vec2(2.0, 3.0)) * 0.3;
          vec3 rock = mix(vec3(0.2, 0.28, 0.18), vec3(0.30, 0.33, 0.38), smoothstep(150.0, 450.0, vI.y)) * (0.55 + 0.75 * gully); float sn = vI.z * smoothstep(0.2, 0.32, gully * 0.4 + (vI.y - 380.0) / 1100.0);
          vec3 a = mix(rock, vec3(0.93, 0.93, 0.96) * (0.8 + 0.25 * gully), sn); float side = 0.75 + 0.5 * (gully - 0.5); vec3 c = a * (0.5 + 0.25 * n.y) * side + a * uSunCol * smoothstep(0.0, 0.9, ndl) * (0.25 + 0.4 * gully);
          gl_FragColor = vec4(atmos(c, vW), 1.0); }`, { opts: DERIV })));
    }

    // 盆底的晨霧：幾片很淡、慢慢飄的霧，多在遠處和低處；走近時會淡掉，不會撞上一片硬邊
    for (const [x, z, w, d, y] of [[-10, -70, 90, 40, 2.5], [20, -40, 70, 35, 1.6], [-30, -20, 60, 30, 3.5], [35, 10, 50, 30, 1.2], [-300, -150, 700, 400, 6], [-400, 400, 800, 500, 8]]) {
      const g = keepG(new THREE.PlaneGeometry(w, d, 1, 1)); g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, shader(WP, `${ATM} ${NOISE} uniform vec2 uC; uniform vec2 uS; varying vec3 vW; void main(){ vec2 q = (vW.xz - uC) / uS; float edge = (1.0 - smoothstep(0.25, 0.5, abs(q.x))) * (1.0 - smoothstep(0.2, 0.5, abs(q.y)));
          float n = fbm(vW.xz * (0.03 * 90.0 / uS.x) + vec2(uT * 0.01, uT * 0.004)); float a = smoothstep(0.35, 0.8, n) * edge * 0.4 * smoothstep(4.0, 22.0, distance(vW, uCam));
          vec3 v = normalize(vW - uCam); vec3 c = mix(uHaze, uHazeSun, pow(max(dot(v, uSun), 0.0), 3.0)) * 1.04; gl_FragColor = vec4(c, a); }`,
        { uniforms: { uC: { value: new THREE.Vector2(x, z) }, uS: { value: new THREE.Vector2(w, d) } }, opts: { transparent: true, depthWrite: false } }));
      m.position.set(x, (Math.abs(x) < L && Math.abs(z) < L ? hAt(x, z) : plainH(x, z)) + y, z); m.renderOrder = 5; scene.add(m); }

    // 草：一大片寬一點、有弧度的草葉，跟著訪客（以訪客為中心、四周一圈），在顯示卡上照著地形擺放、隨風擺動
    const R = coarse ? 12 : 19, NB = coarse ? 60000 : 230000, NF = coarse ? 1400 : 4200, SEGB = 5;
    const blade = new THREE.InstancedBufferGeometry(); { const p = []; for (let s = 0; s <= SEGB; s++) p.push(0, s / SEGB, 0, 1, s / SEGB, 0); const idx = [];
      for (let s = 0; s < SEGB; s++) { const a = s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      blade.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); blade.setIndex(idx); }
    const inst = (g, n) => { const off = new Float32Array(n * 2), rnd = new Float32Array(n * 4); for (let k = 0; k < n; k++) { off[k * 2] = (Math.random() * 2 - 1) * R; off[k * 2 + 1] = (Math.random() * 2 - 1) * R; for (let c = 0; c < 4; c++) rnd[k * 4 + c] = Math.random(); }
      g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2)); g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4)); g.instanceCount = n; geos.push(g); LOD.push([g, n]); return g; };
    const PLACE = `
      attribute vec2 aOff; attribute vec4 aRnd; uniform sampler2D uHF; uniform float uR;
      vec4 hfAt(vec2 wp){ return texture2D(uHF, (((wp + ${L.toFixed(1)}) / ${(2 * L).toFixed(1)}) * ${(N - 1).toFixed(1)} + 0.5) / ${N.toFixed(1)}); }
      vec2 placeAt(){ return uCam.xz + mod(aOff - uCam.xz + uR, 2.0 * uR) - uR; }
      uniform sampler2D uST; float freeAt(vec2 wp){ return step(texture2D(uST, (wp + ${L.toFixed(1)}) / ${(2 * L).toFixed(1)}).r, 0.3); }   // 1 = 這裡沒有石頭
      // 風：一團一團不規則的陣風，從上風處滑過來（形狀、強弱每次都不一樣）；風團經過時草被壓低，過後慢慢回彈
      float gustN(vec2 wp, float t){ vec2 wd = normalize(vec2(0.8, -0.6)); vec2 q = wp * 0.05 - wd * t * 0.32; return vn(q) * 0.6 + vn(q * 2.4 + 7.0) * 0.3 + vn(q * 5.0 + 3.0) * 0.1; }
      float windAt(vec2 wp){ float now = gustN(wp, uT), late = gustN(wp, uT - 0.6);   // 回彈：比風團晚一點才鬆開
        return smoothstep(0.42, 0.86, max(now, late * 0.85)); }
      const vec2 WD = vec2(0.8, -0.6);`;
    const ext = { uHF: { value: hfTex }, uR: { value: R }, uGC: { value: gTex }, uST: { value: stoneTex } };
    grass = new THREE.Mesh(inst(blade, NB), shader(
      `${ATM} ${NOISE} ${PLACE} varying float vY; varying float vX; varying float vVis; varying vec3 vW; varying float vVar; varying vec3 vNr; varying float vWind; uniform sampler2D uGC; varying vec3 vGround; varying float vRootK;
      vec3 bez(vec3 a, vec3 b, vec3 c, vec3 d, float t){ float u = 1.0 - t; return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d; }
      vec3 bezD(vec3 a, vec3 b, vec3 c, vec3 d, float t){ float u = 1.0 - t; return 3.0*u*u*(b - a) + 6.0*u*t*(c - b) + 3.0*t*t*(d - c); }
      void main(){ vec2 wp = placeAt(); vec4 hf = hfAt(wp); float dist = length(wp - uCam.xz);
        float gh = step(aRnd.w, hf.b) * smoothstep(uR, uR * 0.5, dist) * freeAt(wp);                       // 遠處慢慢變矮（不淡出）
        float patchH = 0.75 + 0.5 * vn(wp * 0.09);
        float H = (0.6 + 0.45 * aRnd.x) * patchH * gh, y01 = position.y, xs = position.x;
        float Wd = 0.034 * (0.7 + 0.6 * aRnd.y) * (1.0 - pow(1.0 - (1.08 - y01), 2.0) * 0.0) * (1.0 - pow(y01, 1.6)) * gh;
        float lean = 0.16 + (aRnd.y - 0.5) * 0.3 + (vn(wp * 0.5 + uT * 0.08) - 0.5) * 0.2;   // 平常大致直立，只微微彎
        vec3 p1 = vec3(0.0), p2 = vec3(0.0, 0.4, 0.0), p3 = vec3(0.0, 0.75, 0.12 * sign(lean)), p4 = vec3(0.0, cos(lean), sin(lean));   // 下半直、上半慢慢彎下來
        vec3 cv = bez(p1, p2, p3, p4, y01), cd = bezD(p1, p2, p3, p4, y01);
        float ang = 2.2143 + (aRnd.z - 0.5) * 1.3, ca = cos(ang), sa = sin(ang);   // 葉片大致朝著風的方向（±37°）
        mat3 rotY = mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca);
        vec3 local = rotY * vec3((xs - 0.5) * Wd, cv.y * H, cv.z * H);
        // 風：沿著風向往前壓，越上面壓得越多
        float wa = windAt(wp); float soft = 0.7 + 0.6 * aRnd.x;   // 有的草軟、有的硬
        float flutter = sin(uT * (2.2 + 1.6 * aRnd.y) + aRnd.z * 40.0) * (0.04 + 0.06 * wa);   // 每根草各自的抖動
        float w = ((0.05 + 0.72 * wa) * soft + flutter) * y01 * y01; vec3 wdir = vec3(WD.x, 0.0, WD.y);
        local += wdir * w * H; local.y -= 0.35 * w * w * H;
        // 法線：沿著彎弧的方向，再往左右兩側斜一點（看起來像圓弧的草，不是一片薄紙）；遠一點就慢慢朝上
        vec3 nb = rotY * normalize(vec3(0.0, -cd.z, cd.y)); vec3 side = rotY * vec3(1.0, 0.0, 0.0);
        vec3 nr = normalize(nb + side * (xs - 0.5) * 1.2); nr = normalize(mix(nr, vec3(0.0, 1.0, 0.0), smoothstep(2.0, 14.0, dist) * 0.5));
        vec3 p = vec3(wp.x, hf.r - 0.04, wp.y) + local;
        // 側面朝著你時，在畫面上把草葉稍微撐寬，不會變成一條細線
        vec4 mv = viewMatrix * vec4(p, 1.0); vec3 fn = rotY * vec3(0.0, 0.0, 1.0); vec3 vd = normalize(uCam - p);
        float vdn = abs(dot(fn, vd)); mv.x += (1.0 - vdn) * (1.0 - vdn) * (xs - 0.5) * Wd * 0.6;
        vGround = texture2D(uGC, (((wp + ${L.toFixed(1)}) / ${(2 * L).toFixed(1)}) * ${(N - 1).toFixed(1)} + 0.5) / ${N.toFixed(1)}).rgb; vRootK = 0.55 + 0.45 * step(0.5, fract(aRnd.z * 13.7));   // 根部用腳下地面的顏色：有的一模一樣、有的只是接近
        vWind = wa; vY = y01; vX = xs; vVis = hf.g; vW = p; vVar = fract(aRnd.x * 7.31 + vn(wp * 0.25) * 0.6); vNr = nr;
        gl_Position = projectionMatrix * mv; if (gh < 0.02) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`,
      `${ATM} varying float vY; varying float vX; varying float vVis; varying vec3 vW; varying float vVar; varying vec3 vNr; varying float vWind; varying vec3 vGround; varying float vRootK;
      void main(){ vec3 base = vec3(${GRASS_BASE.join(', ')}), top = vec3(${GRASS_TOP.join(', ')});
        top *= mix(vec3(0.95, 0.97, 1.0), vec3(1.06, 1.04, 0.96), vVar);   // 顏色只差一點點
        top = mix(top, vec3(0.62, 0.56, 0.36), step(0.84, fract(vVar * 5.3)) * 0.75);   // 少數草葉的上半段帶點枯黃，和穗的顏色接得上
        vec3 a = mix(base, top, smoothstep(0.0, 0.95, vY)) ;   // 根部不再壓暗
        vec3 n = normalize(vNr); if (!gl_FrontFacing) n = -n; n = normalize(vec3(n.x, abs(n.y) * 0.6 + 0.4, n.z));
        vec3 v = normalize(uCam - vW);
        vec3 amb = mix(vec3(0.26, 0.28, 0.4), vec3(1.0, 0.94, 0.84), 0.5 * n.y + 0.5);                     // 天空光：上面暖白、下面偏藍
        float wrap = clamp((dot(n, uSun) + 0.5) / 1.5, 0.0, 1.0);                                          // 包覆的陽光
        float back = clamp((dot(v, -uSun) + 0.5) / 1.5, 0.0, 1.0); back = back * back * vY;                // 逆光時從草葉裡透出來的光
        vec3 light = amb * 0.8 + uSunCol * vVis * (1.0 - 0.6 * cloudSh(vW)) * (wrap * 0.38 + back * 0.9);
        float sheen = smoothstep(0.3, 1.0, vWind) * vY; light *= 1.0 + 0.32 * sheen; a = mix(a, a * vec3(1.08, 1.06, 0.9), sheen);
        float spk = step(0.993, fract(sin(dot(floor(vW * 55.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453)) * smoothstep(0.7, 1.0, vY) * vVis * (1.0 - cloudSh(vW)) * pow(clamp(dot(-v, uSun), 0.0, 1.0), 2.0) * (0.5 + 0.5 * sin(uT * 4.0 + vW.x * 30.0));
        light += vec3(1.0, 0.97, 0.9) * spk * 6.0;   // 露珠   // 被風壓彎的草反光，一道道亮帶在草原上滾過
        vec3 gc = vGround * (1.0 - 0.22 * cloudSh(vW)); vec3 col = mix(gc, a * light, 1.0 - vRootK * (1.0 - smoothstep(0.0, 0.5, vY)));   // 根部慢慢融進地面的顏色
        gl_FragColor = vec4(atmos(col, vW), 1.0); }`, { uniforms: ext, opts: { side: THREE.DoubleSide } }));
    grass.frustumCulled = false; scene.add(grass);
    // 草裡的白色小花：細細的莖、六片小小的白色花瓣、黃色的花心；花朝上、微微朝外，跟著風搖
    const fg = new THREE.InstancedBufferGeometry(); { const P = [], C = [], PT = [];
      const tri = (a, b, c, col, part) => { P.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) { C.push(...col); PT.push(part); } };
      for (let i = 0; i < 6; i++) { const a0 = i / 6 * Math.PI * 2, r = 0.024, ca = Math.cos(a0), sa = Math.sin(a0), K = 8;   // 圓潤的花瓣：橢圓形，尖端是圓的
        const pt = (t) => { const u = 0.5 * r + 0.5 * r * Math.cos(t), v = 0.27 * r * Math.sin(t), y = 0.004 + 0.006 * (u / r); return [ca * u - sa * v, y, sa * u + ca * v]; };
        const c0 = pt(Math.PI); for (let q = 0; q < K; q++) { const t0 = Math.PI - q / K * 2 * Math.PI, t1 = Math.PI - (q + 1) / K * 2 * Math.PI; tri(c0.map((v, ci) => (v + pt(0)[ci]) / 2), pt(t0), pt(t1), [0.97, 0.97, 0.94], 0); } }
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, b = (i + 1) / 6 * Math.PI * 2, r = 0.006; tri([0, 0.005, 0], [Math.cos(a) * r, 0.003, Math.sin(a) * r], [Math.cos(b) * r, 0.003, Math.sin(b) * r], [0.95, 0.78, 0.25], 1); }
      for (const [x0, x1] of [[-0.0015, 0.0015]]) { tri([x0, -1, 0], [x1, -1, 0], [x1, 0, 0], [0.3, 0.46, 0.2], 2); tri([x0, -1, 0], [x1, 0, 0], [x0, 0, 0], [0.3, 0.46, 0.2], 2); }
      fg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); fg.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); fg.setAttribute('part', new THREE.Float32BufferAttribute(PT, 1)); }
    flowers = new THREE.Mesh(inst(fg, NF), shader(
      `${ATM} ${NOISE} ${PLACE} attribute vec3 color; attribute float part; varying vec3 vW; varying float vVis; varying vec3 vC; varying float vPart;
      void main(){ vec2 wp = placeAt(); vec4 hf = hfAt(wp); float dist = length(wp - uCam.xz); float pch = vn(wp * 0.07 + 3.0) * 0.7 + vn(wp * 0.21) * 0.3; float keep = freeAt(wp) * step(aRnd.w, hf.b * 0.9) * smoothstep(uR, uR * 0.6, dist) * step(0.52, pch) * step(aRnd.y, smoothstep(0.52, 0.75, pch) * 1.4);   // 一片一片聚在一起
        float H = (0.45 + 0.35 * aRnd.x) * keep; float w = windAt(wp) * 0.7; vec3 head = vec3(wp.x + WD.x * w * H * 0.6, hf.r + H * (1.0 - 0.15 * w * w), wp.y + WD.y * w * H * 0.6);
        float ang = aRnd.z * 6.2832, ca = cos(ang), sa = sin(ang); vec3 lp = position;
        vec3 p; if (part > 1.5) { float k = -lp.y; vec3 base = vec3(wp.x, hf.r, wp.y); p = mix(head, base, k); p.x += lp.x * keep * ca; p.z += lp.x * keep * sa; }   // 莖：從地面接到花
        else { float tilt = 0.35 + 0.3 * aRnd.y; lp = vec3(lp.x, lp.y * cos(tilt) - lp.z * sin(tilt), lp.y * sin(tilt) + lp.z * cos(tilt)); lp = vec3(ca * lp.x + sa * lp.z, lp.y, -sa * lp.x + ca * lp.z); p = head + lp * keep * (0.85 + 0.4 * aRnd.y); }
        float yz = step(0.58, vn(wp * 0.035 + 20.0)); vC = part < 0.5 ? mix(color, vec3(1.0, 0.88, 0.4), yz) : (part < 1.5 ? mix(color, vec3(0.95, 0.6, 0.2), yz) : color);   // 有的一片是淡黃色的花
        vW = p; vVis = hf.g; vPart = part; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); if (keep < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`,
      `${ATM} varying vec3 vW; varying float vVis; varying vec3 vC; varying float vPart; void main(){ vec3 v = normalize(vW - uCam); float back = pow(max(dot(v, uSun), 0.0), 3.0);
        vec3 light = vec3(0.68, 0.68, 0.74) + uSunCol * vVis * (1.0 - 0.6 * cloudSh(vW)) * (0.45 + (vPart < 0.5 ? 0.9 : 0.3) * back);
        gl_FragColor = vec4(atmos(vC * light, vW), 1.0); }`, { uniforms: ext, opts: { side: THREE.DoubleSide } }));
    flowers.frustumCulled = false; scene.add(flowers);
    extras(blade, inst, PLACE, ext);
  }

  /* ---------- 聲音：風吹過草、小溪、晨鳥（帶一點開闊的回音） ---------- */
  const A = { ac: null };
  function noiseBuf(ac, sec, pink) { const n = ac.sampleRate * sec, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; if (pink) { b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2 + w * 0.05) * 2.2; } else d[i] = w; } return b; }
  function openIR(ac) { const n = Math.round(ac.sampleRate * 3), b = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < n; i++) { const t = i / ac.sampleRate; lp += ((Math.random() * 2 - 1) - lp) * 0.5; d[i] = lp * Math.exp(-t * 1.8) * Math.min(1, t / 0.08); } } return b; }
  function panner(ac, ref, roll) { const p = ac.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = roll; return p; }
  const setPos = (p, x, y, z) => { if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z); };
  function audioStart(ac, out) {
    if (!ac) return; A.ac = ac; const t0 = ac.currentTime;
    A.out = ac.createGain(); A.out.gain.value = 0; A.out.connect(out || ac.destination); A.out.gain.setTargetAtTime(1, t0, 1.5);
    A.verb = ac.createConvolver(); A.verb.buffer = openIR(ac); const vg = ac.createGain(); vg.gain.value = 0.5; A.verb.connect(vg).connect(A.out);
    const pink = noiseBuf(ac, 5, true), white = noiseBuf(ac, 3, false); A.srcs = [];
    const loop = (buf, rate) => { const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate || 1; s.start(t0, Math.random() * 2); A.srcs.push(s); return s; };
    const w1 = loop(pink, 0.7), wb = ac.createBiquadFilter(); wb.type = 'bandpass'; wb.frequency.value = 520; wb.Q.value = 0.5; A.wind = ac.createGain(); A.wind.gain.value = 0.05; w1.connect(wb).connect(A.wind).connect(A.out);
    const w2 = loop(white, 1), rb = ac.createBiquadFilter(); rb.type = 'bandpass'; rb.frequency.value = 3800; rb.Q.value = 0.6; A.rustle = ac.createGain(); A.rustle.gain.value = 0.012; w2.connect(rb).connect(A.rustle).connect(A.out);
    /* 小溪的水聲拿掉了（房主覺得不好聽） */ 
    A.pBird = panner(ac, 6, 1); const bl = ac.createBiquadFilter(); bl.type = 'lowpass'; bl.frequency.value = 6000; A.pBird.connect(bl); bl.connect(A.out); bl.connect(A.verb);
    A.next = t0 + 2.5;
  }
  function chirps(t) {   // 一隻晨鳥：兩到五聲短短的鳴叫，有時是一串顫音
    const ac = A.ac, ang = Math.random() * Math.PI * 2, r = 25 + Math.random() * 60; setPos(A.pBird, S.x + Math.cos(ang) * r, S.y + 4 + Math.random() * 10, S.z + Math.sin(ang) * r);
    const trill = Math.random() < 0.3, k = trill ? 8 + Math.floor(Math.random() * 6) : 2 + Math.floor(Math.random() * 4), f0 = 2400 + Math.random() * 1500;
    for (let i = 0; i < k; i++) { const s = t + i * (trill ? 0.07 : 0.16 + Math.random() * 0.08), o = ac.createOscillator(), g = ac.createGain(), f = f0 * (trill ? 1 + 0.04 * Math.sin(i) : 0.9 + Math.random() * 0.25);
      o.frequency.setValueAtTime(f, s); o.frequency.exponentialRampToValueAtTime(f * (trill ? 1.15 : 1.35), s + 0.04); o.frequency.exponentialRampToValueAtTime(f * 0.85, s + (trill ? 0.06 : 0.11));
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(trill ? 0.06 : 0.1, s + 0.012); g.gain.exponentialRampToValueAtTime(0.0003, s + (trill ? 0.065 : 0.13));
      o.connect(g).connect(A.pBird); o.start(s); o.stop(s + 0.15); }
  }
  function audioTick(cam) {
    if (!A.ac) return; const ac = A.ac, now = ac.currentTime, Ls = ac.listener, f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    if (Ls.positionX) { Ls.positionX.value = cam.position.x; Ls.positionY.value = cam.position.y; Ls.positionZ.value = cam.position.z; Ls.forwardX.value = f.x; Ls.forwardY.value = f.y; Ls.forwardZ.value = f.z; Ls.upX.value = u.x; Ls.upY.value = u.y; Ls.upZ.value = u.z; }
    else { Ls.setPosition(cam.position.x, cam.position.y, cam.position.z); Ls.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
    const high = sstep(4, 30, S.y - 1.6), gust = 0.6 + 0.4 * Math.sin(now * 0.31) * Math.sin(now * 0.17 + 1);
    A.wind.gain.setTargetAtTime((0.035 + 0.07 * high) * gust, now, 0.5); A.rustle.gain.setTargetAtTime(0.012 * gust * (1 - 0.6 * high), now, 0.5);
    if (A.next < now + 0.2) { chirps(A.next); A.next += 3 + Math.random() * 7; }
  }
  function audioStop() { if (!A.ac) return; const o = A.out, ac = A.ac; o.gain.setTargetAtTime(0, ac.currentTime, 0.3); const ss = A.srcs; setTimeout(() => { ss.forEach((s) => { try { s.stop(); } catch (e) {} }); try { o.disconnect(); } catch (e) {} }, 1600); A.ac = null; }

  /* ---------- 每一格 ---------- */
  // 能不能從 (x0,z0) 走到 (x1,z1)：在稜線外緣以內，而且不會太陡（岩壁爬不上去、也走不下去）
  function canStep(x0, z0, x1, z1) {
    if (qOf(x1, z1) > Q_WALK) return false;
    if (TREE && Math.hypot(x1 - TREE.x, z1 - TREE.z) < 0.75) return false;   // 孤樹的樹幹
    const d = Math.hypot(x1 - x0, z1 - z0); if (d < 1e-5) return true;
    const ahead = 0.6, ux = (x1 - x0) / d, uz = (z1 - z0) / d;   // 看前面一小段的坡度，不只是這一步
    return Math.abs(hAt(x0 + ux * ahead, z0 + uz * ahead) - hAt(x0, z0)) / ahead < MAXSLOPE;
  }
  function tick(dt, inp) {
    if (!S.on) return null;
    S.t += dt; U.uT.value = S.t; fauna(dt);
    // 畫面跟不上時，草、花、穗的數量自動減少（最少到三成）；順了再慢慢加回來
    if (dt > 0 && dt < 0.25) QL.ft += (dt * 1000 - QL.ft) * 0.06; QL.t += dt;
    if (QL.t > 1.2) { QL.t = 0; const q0 = QL.q; if (QL.ft > 23) QL.q = Math.max(0.3, QL.q * 0.8); else if (QL.ft < 18) QL.q = Math.min(1, QL.q * 1.08);
      if (QL.q !== q0) LOD.forEach(([g, n]) => { g.instanceCount = Math.round(n * QL.q); }); }
    const sp = (inp.run ? 4.2 : 1.9) * (inp.crouch > 0.5 ? 0.5 : 1) * dt;
    const fx = -Math.sin(inp.yaw), fz = -Math.cos(inp.yaw), rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
    const dx = (fx * inp.mz + rx * inp.mx) * sp, dz = (fz * inp.mz + rz * inp.mx) * sp;
    if (dx || dz) { if (canStep(S.x, S.z, S.x + dx, S.z + dz)) { S.x += dx; S.z += dz; } else if (canStep(S.x, S.z, S.x + dx, S.z)) S.x += dx; else if (canStep(S.x, S.z, S.x, S.z + dz)) S.z += dz; }   // 擋住時沿著邊滑過去
    const ground = hAt(S.x, S.z), eye = ground + (inp.crouch > 0.5 ? 1.0 : 1.6);
    S.y = S.y ? S.y + (eye - S.y) * (1 - Math.pow(0.001, dt)) : eye;
    return { x: S.x, y: S.y, z: S.z, leave: false };
  }
  function render(renderer, camera, pose, inp) {
    if (!QL.gpu) { QL.gpu = true; try { const gl = renderer.getContext(), di = gl.getExtension('WEBGL_debug_renderer_info'), name = di ? gl.getParameter(di.UNMASKED_RENDERER_WEBGL) : '';   // 內建顯示卡、手機：一開始就用比較少的草
        if (coarse || /Intel|Mali|Adreno|PowerVR|SwiftShader/i.test(name)) { QL.q = 0.5; LOD.forEach(([g, n]) => { g.instanceCount = Math.round(n * QL.q); }); } } catch (e) {} }
    camera.position.set(pose.x, pose.y, pose.z); camera.rotation.set(inp.pitch, inp.yaw, 0);
    const near = camera.near, far = camera.far; camera.near = 0.08; camera.far = 9000; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    U.uCam.value.copy(camera.position); skyMesh.position.copy(camera.position); if (F && F.fluffMat) F.fluffMat.uniforms.uPR.value = renderer.domElement.height * camera.projectionMatrix.elements[5] * 0.5;
    audioTick(camera);
    const tm = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping;
    renderer.render(scene, camera);
    renderer.toneMapping = tm; camera.near = near; camera.far = far; camera.updateProjectionMatrix();
  }
  function enter(o) {
    init(o.THREE); S.on = true; S.x = START.x; S.z = START.z; S.y = 0; S.t = 0;
    audioStart(o.ac, o.out);
  }
  function exit() { S.on = false; audioStop(); }
  function dispose() {
    if (!scene) return;
    geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose());
    geos = []; mats = []; texs = []; scene = null; HG = null; skyMesh = grass = flowers = null; F = null; TREE = null;
  }
  window.GrasslandSpace = { init, enter, exit, tick, render, dispose, startYaw: START.yaw, state: S,
    note: '清晨的盆地草原，可以走上稜線，看看外面的世界', exitHint: ['點「離開作品」回到房間', '按 Esc 回到房間'], get on() { return S.on; } };
})();
