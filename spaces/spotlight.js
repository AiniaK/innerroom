/* 聚光燈裝置（房主大學時的空間作品）：從記憶收藏櫃第 8 格的相框走進來的另一個空間。
 * 5 × 5 公尺、高 3 公尺的全黑空間（黑地毯、黑牆、黑天花板），正上方一盞暖白聚光燈，地上光圈直徑 80 公分；
 * 空間裡有霧（光像一團柔軟的空間）和在光下反光的灰塵。
 * 聲音：像心跳但不寫實的低頻脈動。越靠近角落越大聲、越壓迫、越快；越靠近光越散；
 * 站進光下（頭在平均身高的位置）聲音削弱、變得遙遠——當年用抗噪技術在那個高度做到的小範圍安靜。
 * 介面：init(THREE) 建好場景；enter({ac, out}) 進入（聲音接到 out）；tick(dt, input) 每格更新；render(renderer, camera)；exit()。 */
(function () {
  const HALF = 2.5, CEIL = 3.0, POOL_R = 0.4, LAMP_Y = 2.92;
  const S = { on: false, x: 0, z: 2.05, t: 0 };
  let THREE, scene, beamMat, hazeMat, dustMat, glow, lampGlow;

  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp = (a, b, k) => a + (b - a) * k;

  function canvasTex(size, draw) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // 光柱（霧裡的光）：面向你的部分亮、邊緣淡掉，看起來有厚度；越上面越亮；霧慢慢流動
  function beamMaterial(strength) {
    return new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uK: { value: strength }, uIn: { value: 0 } },
      vertexShader: `varying vec3 vW; varying vec3 vN; varying float vY;
        void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); vY = position.y;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uT, uK, uIn; varying vec3 vW; varying vec3 vN; varying float vY;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
        float n3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
          return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
        void main(){
          vec3 V = normalize(cameraPosition - vW);
          float facing = abs(dot(normalize(vN), V));
          float core = pow(facing, 1.6);
          float hgt = clamp(vW.y / ${CEIL.toFixed(1)}, 0., 1.);
          float vert = mix(.55, 1., hgt) * smoothstep(0., .12, vW.y);
          float fog = .72 + .28 * n3(vW * 2.2 + vec3(0., uT * .05, uT * .03)) + .12 * n3(vW * 6. - vec3(uT * .04));
          float a = core * vert * fog * uK * mix(1., .28, uIn);
          gl_FragColor = vec4(vec3(1., .92, .8) * a, 1.);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
  }

  function init(T) {
    if (scene) return;
    THREE = T;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    // 黑地毯（細細的纖維雜訊）＋地上的光圈：光圈中心暖白、邊緣柔和，外面一圈很淡的散光
    const floorTex = canvasTex(1024, (g, n) => {
      g.fillStyle = '#0a0909'; g.fillRect(0, 0, n, n);
      const img = g.getImageData(0, 0, n, n), d = img.data;
      for (let i = 0; i < d.length; i += 4) { const v = (Math.random() - .5) * 7; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
      g.putImageData(img, 0, 0);
      const c = n / 2, px = n / (HALF * 2);
      const halo = g.createRadialGradient(c, c, 0, c, c, 1.5 * px);
      halo.addColorStop(0, 'rgba(255,236,205,.20)'); halo.addColorStop(.4, 'rgba(255,230,195,.06)'); halo.addColorStop(1, 'rgba(255,230,195,0)');
      g.fillStyle = halo; g.fillRect(0, 0, n, n);
      const pool = g.createRadialGradient(c, c, 0, c, c, POOL_R * px * 1.12);
      pool.addColorStop(0, 'rgba(255,246,228,1)'); pool.addColorStop(.72, 'rgba(255,240,216,.97)');
      pool.addColorStop(.88, 'rgba(255,232,200,.5)'); pool.addColorStop(1, 'rgba(255,230,195,0)');
      g.fillStyle = pool; g.beginPath(); g.arc(c, c, POOL_R * px * 1.12, 0, Math.PI * 2); g.fill();
    });
    floorTex.anisotropy = 8;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), new THREE.MeshBasicMaterial({ map: floorTex, toneMapped: false }));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    // 黑牆、黑天花板：幾乎看不見，只在靠近地面的地方有一點光圈反過來的微光
    const wallTex = canvasTex(256, (g, n) => {
      const gr = g.createLinearGradient(0, n, 0, 0); gr.addColorStop(0, '#0d0b0a'); gr.addColorStop(.35, '#070606'); gr.addColorStop(1, '#040404');
      g.fillStyle = gr; g.fillRect(0, 0, n, n);
    });
    const wallM = new THREE.MeshBasicMaterial({ map: wallTex, toneMapped: false });
    [[0, -HALF, 0], [0, HALF, Math.PI], [-HALF, 0, Math.PI / 2], [HALF, 0, -Math.PI / 2]].forEach(([x, z, ry]) => {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, CEIL), wallM); w.position.set(x, CEIL / 2, z); w.rotation.y = ry; scene.add(w);
    });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), new THREE.MeshBasicMaterial({ color: 0x030303, toneMapped: false }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = CEIL; scene.add(ceil);
    // 入口：你進來的那面牆上，門縫透進一點點房間的光（轉身看得到，走回去就出去）
    const seamM = new THREE.MeshBasicMaterial({ color: 0x6d5a45, toneMapped: false });
    const DW = .9, DH = 2.05;
    [[-DW / 2, DH / 2, .012, DH], [DW / 2, DH / 2, .012, DH], [0, DH, DW, .012]].forEach(([x, y, w, h]) => {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), seamM); s.position.set(x, y, HALF - .005); s.rotation.y = Math.PI; scene.add(s);
    });
    // 燈具：天花板上一個黑色的燈筒，鏡面發著暖白光
    const can = new THREE.Mesh(new THREE.CylinderGeometry(.09, .11, .16, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x0a0a0a, side: THREE.DoubleSide }));
    can.position.y = CEIL - .08; scene.add(can);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(.085, 32), new THREE.MeshBasicMaterial({ color: 0xfff4e2, toneMapped: false }));
    lens.rotation.x = Math.PI / 2; lens.position.y = LAMP_Y - .01; scene.add(lens);
    const glowTex = canvasTex(256, (g, n) => {
      const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      gr.addColorStop(0, 'rgba(255,244,226,1)'); gr.addColorStop(.15, 'rgba(255,236,210,.55)'); gr.addColorStop(.5, 'rgba(255,230,200,.12)'); gr.addColorStop(1, 'rgba(255,230,200,0)');
      g.fillStyle = gr; g.fillRect(0, 0, n, n);
    });
    lampGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false }));
    lampGlow.renderOrder = 5;   // 光暈不被天花板切出方形的邊
    lampGlow.position.set(0, LAMP_Y - .03, 0); lampGlow.scale.set(.9, .9, 1); scene.add(lampGlow);
    // 光柱：內層比較濃的光、外層一圈淡淡的霧
    const H = LAMP_Y;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.07, POOL_R * 1.02, H, 64, 24, true), beamMaterial(.42));
    beam.position.y = H / 2; scene.add(beam); beamMat = beam.material;
    const haze = new THREE.Mesh(new THREE.CylinderGeometry(.14, POOL_R * 1.9, H, 64, 24, true), beamMaterial(.09));
    haze.position.y = H / 2; scene.add(haze); hazeMat = haze.material;
    // 灰塵：在光柱附近慢慢飄，只有落在光裡的時候才亮
    const N = 900, pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const y = .05 + Math.random() * (H - .1), R = lerp(POOL_R, .07, y / H) * 1.5, a = Math.random() * Math.PI * 2, r = R * Math.sqrt(Math.random());
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r; seed[i] = Math.random();
    }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); dg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    dustMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uPR: { value: 1 } },
      vertexShader: `attribute float seed; uniform float uT, uPR; varying float vB;
        void main(){ vec3 p = position; float s = seed * 6.2831;
          p.x += sin(uT * .11 + s) * .05 + sin(uT * .37 + s * 3.) * .012;
          p.z += cos(uT * .09 + s * 2.) * .05 + cos(uT * .29 + s) * .012;
          p.y += sin(uT * .07 + s * 5.) * .06 - mod(uT * .006 * (.5 + seed), .2);
          float R = mix(${POOL_R.toFixed(2)}, .07, clamp(p.y / ${H.toFixed(2)}, 0., 1.));
          float r = length(p.xz);
          vB = (1. - smoothstep(R * .75, R * 1.05, r)) * (.45 + .55 * sin(uT * (.6 + seed) + s * 7.) * .5 + .5 * .55);
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          float px = (.0016 + seed * .0028) * uPR / -mv.z;           // 真實大小約 2～4 公釐：近的大、遠的小
          vB *= clamp(px, .25, 1.);                                    // 比一個像素還小的就淡一點，不會變成一顆大點
          gl_PointSize = clamp(px, 1., 7.);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vB; void main(){ vec2 c = gl_PointCoord - .5; float d = 1. - smoothstep(.2, .5, length(c));
          gl_FragColor = vec4(vec3(1., .95, .86) * vB * d * .7, 1.); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    scene.add(new THREE.Points(dg, dustMat));
    // 站進光裡：眼前亮晃晃、柔柔地被包住（畫面上一層暖白的溢光）
    glow = document.createElement('div');
    glow.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:5;transition:none;' +
      'mix-blend-mode:screen;background:radial-gradient(ellipse at 50% 40%,rgba(255,248,234,1) 0%,rgba(255,240,218,.7) 40%,rgba(255,230,200,.35) 100%)';
    document.body.appendChild(glow);
  }

  /* ---------- 聲音：像心跳但不寫實的低頻脈動（暫用合成的聲音，之後換成房主的音檔） ---------- */
  const A = { ac: null, out: null, bus: null, lp: null, dry: null, wet: null, vol: null, next: 0, bpm: 60 };
  function audioStart(ac, out) {
    if (!ac) return;
    A.ac = ac;
    A.vol = ac.createGain(); A.vol.gain.value = 0; A.vol.connect(out || ac.destination);
    A.lp = ac.createBiquadFilter(); A.lp.type = 'lowpass'; A.lp.frequency.value = 900; A.lp.Q.value = .4;
    A.dry = ac.createGain(); A.wet = ac.createGain(); A.wet.gain.value = .1;
    // 「散」：一點點拉長、模糊的回聲（越靠近光越多）
    const d1 = ac.createDelay(1), fb = ac.createGain(), dl = ac.createBiquadFilter();
    d1.delayTime.value = .19; fb.gain.value = .55; dl.type = 'lowpass'; dl.frequency.value = 380;
    A.bus = ac.createGain();
    A.bus.connect(A.lp); A.lp.connect(A.dry); A.dry.connect(A.vol);
    A.lp.connect(d1); d1.connect(dl); dl.connect(fb); fb.connect(d1); dl.connect(A.wet); A.wet.connect(A.vol);
    A.next = ac.currentTime + .4;
    A.vol.gain.setTargetAtTime(1, ac.currentTime, .8);
  }
  function thump(t, amp, f0) {   // 一下圓鈍的低頻：純正弦波，頻率微微往下滑、柔和地收掉
    const ac = A.ac, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * .7, t + .25);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + .03); g.gain.exponentialRampToValueAtTime(.0008, t + .5);
    o.connect(g); g.connect(A.bus);
    o.start(t); o.stop(t + .55);
  }
  function audioTick(p) {
    if (!A.ac) return;
    const ac = A.ac, now = ac.currentTime;
    A.bpm = lerp(A.bpm, p.bpm, .05);
    while (A.next < now + .15) {   // 往前排好接下來的拍子
      const beat = 60 / A.bpm;
      thump(A.next, .9 * p.press, 52);
      thump(A.next + Math.min(.3, beat * .3), .55 * p.press, 46);
      A.next += beat;
    }
    A.vol.gain.setTargetAtTime(p.vol, now, .25);
    A.lp.frequency.setTargetAtTime(p.cut, now, .25);
    A.dry.gain.setTargetAtTime(p.dry, now, .25);
    A.wet.gain.setTargetAtTime(p.wet, now, .25);
  }
  function audioStop() {
    if (!A.ac) return;
    const v = A.vol, ac = A.ac;
    v.gain.setTargetAtTime(0, ac.currentTime, .3);
    setTimeout(() => { try { v.disconnect(); } catch (e) {} }, 1500);
    A.ac = null;
  }

  // 你在空間裡的位置 → 聲音和光的感受
  function feel(eyeY) {
    const corner = Math.min(...[[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]].map(([cx, cz]) => Math.hypot(S.x - cx, S.z - cz)));
    const toCorner = sstep(2.2, .35, corner);                  // 越靠近角落越接近 1
    const dl = Math.hypot(S.x, S.z);
    const nearLight = sstep(1.6, .45, dl);                      // 越靠近光越接近 1
    const under = sstep(.5, .3, dl);                            // 站進光圈
    const head = sstep(1.2, 1.5, eyeY);                         // 頭在平均身高（蹲下就出了抗噪的範圍）
    const quiet = under * head;
    return { toCorner, nearLight, under, quiet };
  }

  function tick(dt, inp) {
    if (!S.on) return null;
    S.t += dt;
    // 走動（和房間一樣的速度）；四面牆擋住
    const sp = (inp.crouch > .5 ? .55 : 1) * 1.2 * dt;
    const fx = -Math.sin(inp.yaw), fz = -Math.cos(inp.yaw), rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
    S.x = Math.max(-HALF + .3, Math.min(HALF - .3, S.x + (fx * inp.mz + rx * inp.mx) * sp));
    S.z = Math.max(-HALF + .3, Math.min(HALF - .3, S.z + (fz * inp.mz + rz * inp.mx) * sp));
    const eyeY = lerp(1.6, 1.0, inp.crouch);
    const f = feel(eyeY);
    // 光裡的亮：站進去時眼前亮晃晃；抬頭看燈時更亮
    const look = Math.max(0, Math.sin(inp.pitch)) ;
    glow.style.opacity = (f.under * (.16 + .5 * look * look) + f.nearLight * .03).toFixed(3);
    beamMat.uniforms.uT.value = hazeMat.uniforms.uT.value = dustMat.uniforms.uT.value = S.t;
    beamMat.uniforms.uIn.value = hazeMat.uniforms.uIn.value = f.under;
    audioTick({
      bpm: lerp(lerp(58, 104, Math.pow(f.toCorner, 1.3)), 50, f.nearLight * .6),
      press: lerp(.75, 1.25, f.toCorner),
      vol: .5 * lerp(.55, 1.25, f.toCorner) * lerp(1, .55, f.nearLight) * lerp(1, .12, f.quiet),
      cut: lerp(lerp(1100, 320, f.nearLight), 150, f.quiet),
      dry: lerp(1, .35, f.nearLight),
      wet: lerp(.08, .55, f.nearLight),
    });
    // 走回入口（門縫那裡）就出去
    return { x: S.x, y: eyeY, z: S.z, leave: S.z > HALF - .42 && Math.abs(S.x) < .5 && S.t > 1.5 };
  }

  function render(renderer, camera, pose, inp) {
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.set(inp.pitch, inp.yaw, 0);
    camera.updateMatrixWorld();
    dustMat.uniforms.uPR.value = camera.projectionMatrix.elements[5] * renderer.domElement.height / 2;   // 一公尺在一公尺外佔幾個像素
    renderer.render(scene, camera);
  }

  function enter(o) {
    init(o.THREE);
    S.on = true; S.x = 0; S.z = HALF - .55; S.t = 0;
    audioStart(o.ac, o.out);
  }
  function exit() {
    S.on = false; if (glow) glow.style.opacity = 0;
    audioStop();
  }

  window.SpotlightSpace = { init, enter, exit, tick, render, get on() { return S.on; }, state: S };
})();
