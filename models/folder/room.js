/* 平面設計文件夾（three.js r158，全域 THREE）：書桌櫃最上層的牛皮紙文件夾，裡面隨意散放著平面設計作品。
   文件夾：左邊有摺邊，封面繞著摺邊翻開；封面貼一張手寫小標籤和一顆綁繩扣。翻開時，可以按住作品拖到別的位置（會移到最上面）。
   作品四種：
     單張（海報）：柔軟的紙，兩個方向都微微彎、一角翹起，拿在手上時輕輕起伏。
     去背（春聯）：照圖案的形狀剪下的紙。
     折頁（寬幅）：右半邊往後折，拿出來會攤開，中間留一道折痕。
     明信片：硬卡，有厚度、不會彎；正面是設計，背面是米白卡紙。
     迴紋針夾（齒盤蓋、logo）：幾張疊在一起，上緣用迴紋針夾住；點一下最上面那張換到最後。logo 直接用原圖，照各自的比例。
   用法：
     GraphicFolder.folder() → { root, meshes, height, tick(dt), held(e), put(id, g, F), pick(ndc, cam, layer), dragStart/dragMove/dragEnd }
     GraphicFolder.load(key) → Promise<{ root, meshes, height, tick(dt), held(e)?, pick()? }>（key 是 SPECS 裡的名稱）
   座標：x 往右、y 往上、z 朝向看的人；單位公尺。 */
(function () {
  'use strict';
  const V = '2026-11-23d';
  const FW = 0.34, FH = 0.25, BOARD = 0.0016;   // 文件夾（橫式）寬、高、紙板厚
  const Z0 = -0.0068, DZ = 0.0008;                // 作品在文件夾裡的高度：最底下一張、每疊一張加多少
  const GUS = 0.0148;                             // 封面（闔起來時）的位置＝文件夾的厚度：作品多了就加厚（2026-11-23 加了明信片，加厚 4 公釐）
  const PAPER = '#F3EEE4';

  // 作品清單：img 是 assets/graphic/ 裡的檔名；w 是印出來的寬（公尺）
  const SPECS = {
    gd_woodcraft: { type: 'sheet', img: 'woodcraft', w: 0.148 },
    gd_time: { type: 'sheet', img: 'time', w: 0.148 },
    gd_woodlife: { type: 'sheet', img: 'woodlife', w: 0.148 },
    gd_lifenum: { type: 'sheet', img: 'lifenum', w: 0.148 },
    gd_best: { type: 'sheet', img: 'best', w: 0.148 },
    gd_sunrise: { type: 'sheet', img: 'sunrise', w: 0.148 },
    gd_spring: { type: 'cut', img: 'spring', w: 0.15 },
    gd_puppet: { type: 'fold', img: 'puppet', w: 0.44 },
    gd_cogs: { type: 'clip', imgs: ['cog1', 'cog2'], w: 0.11, pad: 0.06 },
    gd_pc_newyear: { type: 'card', img: 'pc-newyear', w: 0.105 },   // 明信片：一般尺寸 10.5 × 14.8 公分
    gd_pc_midautumn: { type: 'card', img: 'pc-midautumn', w: 0.105 },
    gd_pc_dragonboat: { type: 'card', img: 'pc-dragonboat', w: 0.105 },
    gd_logos: { type: 'clip', imgs: ['logo-garden', 'logo-romanee', 'logo-life', 'logo-gotham', 'logo-medify'], w: 0.09, raw: true },
  };

  const rng = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const loadImg = (name) => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = `assets/graphic/${name}.webp?v=${V}`; });
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const imgTex = (im) => { const t = new THREE.Texture(im); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t; };

  // 牛皮紙：暖棕底、細細的纖維與雜點
  function kraft(base, seed) {
    const S = 512, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'), r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i++) { const x = r() * S, y = r() * S, l = 2 + r() * 10, a = r() * Math.PI; g.strokeStyle = r() < 0.5 ? `rgba(90,60,30,${0.05 + r() * 0.08})` : `rgba(255,240,215,${0.05 + r() * 0.08})`; g.lineWidth = 0.6 + r() * 0.8; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(70,45,20,${0.06 + r() * 0.1})`; g.fillRect(r() * S, r() * S, 1.2, 1.2); }
    const t = tex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  const mat = (o) => new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.9, metalness: 0 }, o));
  const mesh = (geo, m, list, parent) => { const o = new THREE.Mesh(geo, m); o.castShadow = o.receiveShadow = true; parent.add(o); list.push(o); return o; };

  // 文件夾封面的小標籤
  function labelTex() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#F6F1E6'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = 'rgba(120,90,60,.5)'; g.lineWidth = 4; g.strokeRect(14, 14, 484, 228);
    g.fillStyle = '#4A3A2C'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '600 74px "Noto Serif TC","Songti TC",serif'; g.fillText('平面設計', 256, 112);
    g.font = '500 30px Georgia,serif'; g.fillStyle = '#8A6E50'; g.fillText('GRAPHIC WORKS', 256, 186);
    return tex(c);
  }

  /* ---------- 文件夾 ---------- */
  function folder() {
    const root = new THREE.Group(), inner = new THREE.Group(), meshes = [], items = {}, order = [];
    root.add(inner);
    const outside = mat({ map: kraft('#C49D6E', 11) }), insideM = mat({ map: kraft('#D2AE80', 12) }), edge = mat({ color: 0xB08A5C });
    // 背板（裡面朝向 +z）與左邊的摺邊（夠厚，裝得下十來張作品）
    const back = new THREE.Group(); inner.add(back);
    const board = mesh(new THREE.BoxGeometry(FW, FH, BOARD), [edge, edge, edge, edge, insideM, outside], meshes, back); board.position.z = -0.008;
    mesh(new THREE.BoxGeometry(BOARD, FH, GUS + 0.0088), edge, meshes, back).position.set(-FW / 2, 0.0, (GUS - 0.0108) / 2 + 0.001);   // 左邊的摺邊（夠厚，裝得下十來張作品）
    // 上、下、右三邊也有窄窄的牛皮紙側邊（像風琴文件夾），闔起來從哪個角度都看不到裡面的作品
    for (const [w, h, x, y] of [[FW, BOARD, 0, -FH / 2], [FW, BOARD, 0, FH / 2], [BOARD, FH, FW / 2, 0]]) mesh(new THREE.BoxGeometry(w, h, GUS + 0.008), edge, meshes, back).position.set(x, y, (GUS - 0.0108) / 2 + 0.001);
    const btnM = mat({ color: 0x8A5A3A, roughness: 0.6 });
    const btnB = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.0016, 24), btnM, meshes, back); btnB.rotation.x = Math.PI / 2; btnB.position.set(FW / 2 - 0.03, 0, -0.0092);
    // 封面：繞著左邊的摺邊翻開
    const hinge = new THREE.Group(); hinge.position.set(-FW / 2, 0, GUS); inner.add(hinge);
    const cover = mesh(new THREE.BoxGeometry(FW, FH, BOARD), [edge, edge, edge, edge, outside, insideM], meshes, hinge); cover.position.x = FW / 2;
    const label = mesh(new THREE.PlaneGeometry(0.12, 0.06), mat({ map: labelTex(), roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2 }), meshes, hinge); label.position.set(FW / 2 + 0.04, 0.05, BOARD / 2 + 0.0004); label.rotation.z = 0.03;
    const btnF = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.0016, 24), btnM, meshes, hinge); btnF.rotation.x = Math.PI / 2; btnF.position.set(FW - 0.03, 0, BOARD / 2 + 0.0008);
    const cordM = mat({ color: 0xE9DFC8 });
    const cord = mesh(new THREE.TorusGeometry(0.0085, 0.0009, 6, 24), cordM, meshes, hinge); cord.position.copy(btnF.position); cord.position.z += 0.0011;
    const tail = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(FW - 0.03, -0.008, 0.0014), new THREE.Vector3(FW - 0.026, -0.04, 0.0012), new THREE.Vector3(FW - 0.036, -0.07, 0.001)]), 12, 0.0009, 5), cordM, meshes, hinge);
    let open = 0, want = 0, closing = null, leaving = false, homing = false;
    const apply = () => { const k = open < 0.5 ? 2 * open * open : 1 - Math.pow(-2 * open + 2, 2) / 2; hinge.rotation.y = -Math.PI * 0.94 * k; inner.position.x = FW / 2 * k * 0.98; cord.visible = tail.visible = k < 0.02; };
    apply();
    // 作品可以放在背板（右邊）或翻開的封面內側（左邊）。home 記著每件現在在哪一邊；ext 是它的半寬、半高
    const home = {}, ext = {}, M = 0.006, COVER_Z = -BOARD / 2;
    // 超出文件夾邊緣的作品：墊高到側邊的上面，不會跟邊框嵌在一起
    const overEdge = (id) => { const R = items[id].root, [hw, hh, ox, oy] = ext[id], a = R.rotation.z, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
      const ex = c * hw + sn * hh, ey = sn * hw + c * hh, cx = R.position.x + ox * Math.cos(a) - oy * Math.sin(a), cy = R.position.y + ox * Math.sin(a) + oy * Math.cos(a);
      return Math.abs(cx) + ex > FW / 2 - 0.002 || Math.abs(cy) + ey > FH / 2 - 0.002; };
    // 依疊放的順序排高度：每件佔一點厚度；迴紋針夾上下各多留迴紋針的空間，蓋在上面、墊在下面的作品都不會被穿過
    const restack = () => {
      let zb = Z0, zc = COVER_Z;
      // 背板到封面內側只有 1.7 公分左右：疊得比這高時，每件之間的間距等比例壓緊，最上面那件也不會穿出封面
      let need = 0; order.forEach((id) => { if (home[id] === back) { const d = items[id].depth || { below: 0, above: 0 }; need += DZ + d.below + d.above + (items[id].thick || 0); } });
      const k = Math.min(1, (GUS - BOARD / 2 - 0.0008 - Z0) / Math.max(need, 1e-6));
      order.forEach((id) => {
        const R = items[id].root, d = items[id].depth || { below: 0, above: 0 };
        if (home[id] === back) { zb += (DZ / 2 + d.below) * k; R.position.z = overEdge(id) && !closing ? GUS + (zb - Z0) : zb; zb += (d.above + DZ / 2 + (items[id].thick || 0)) * k; }
        else { zc -= DZ / 2 + d.below; R.position.z = zc; zc -= d.above + DZ / 2; }   // 封面上的作品是翻面貼的：迴紋針背面那段朝著封面
      });
    };
    // 放得進文件夾：轉過的外框不超出邊（留一點邊），太大就稍微轉正
    const fit = (id, x, y, a, cx0, cx1) => {   // (作品的中心不一定在它的原點：例如折起來的折頁，只在原點的一側)
      const [hw, hh, ox, oy] = ext[id];
      for (let i = 0; i < 12; i++) { const ex = Math.abs(Math.cos(a)) * hw + Math.abs(Math.sin(a)) * hh, ey = Math.abs(Math.sin(a)) * hw + Math.abs(Math.cos(a)) * hh; if (ex <= (cx1 - cx0) / 2 - M && ey <= FH / 2 - M) break; a *= 0.7; }
      const ex = Math.abs(Math.cos(a)) * hw + Math.abs(Math.sin(a)) * hh, ey = Math.abs(Math.sin(a)) * hw + Math.abs(Math.cos(a)) * hh;
      const c = Math.cos(a), sn = Math.sin(a), dx = ox * c - oy * sn, dy = ox * sn + oy * c;   // 作品中心相對於原點的位移（轉過之後）
      const lo = cx0 + ex + M, hi = cx1 - ex - M, cx = lo > hi ? (cx0 + cx1) / 2 : Math.max(lo, Math.min(hi, x + dx)), cy = Math.max(-FH / 2 + ey + M, Math.min(FH / 2 - ey - M, y + dy));
      return [cx - dx, cy - dy, a];
    };
    const measure = (id, g) => {   // 作品本身的大小（不含它在文件夾裡的轉動）
      const R = g.root, keepP = R.position.clone(), keepQ = R.quaternion.clone(), par = R.parent;
      if (par) par.remove(R); R.position.set(0, 0, 0); R.quaternion.identity(); R.updateMatrixWorld(true);
      const b = new THREE.Box3(); g.meshes.forEach((m) => { if (!m.geometry) return; m.geometry.computeBoundingBox(); b.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); });
      R.position.copy(keepP); R.quaternion.copy(keepQ); if (par) par.add(R);
      ext[id] = [(b.max.x - b.min.x) / 2, (b.max.y - b.min.y) / 2, (b.max.x + b.min.x) / 2, (b.max.y + b.min.y) / 2];   // 半寬、半高、中心位移
    };
    const toCover = (id) => { const R = items[id].root, a = R.rotation.z; hinge.attach(R); home[id] = hinge; R.rotation.set(0, Math.PI, -a); };   // 放到封面內側：正面朝外（翻開時朝向你）
    const toBack = (id) => { const R = items[id].root; back.attach(R); home[id] = back; };
    // 拖曳：按住作品，在背板或封面的平面上移動；拖起來的那件移到最上面
    let drag = null;
    const rc = new THREE.Raycaster(), plane = new THREE.Plane(), hitP = new THREE.Vector3(), nrm = new THREE.Vector3();
    const onPlane = (grp, z, nz, ndc, cam) => { rc.setFromCamera(ndc, cam); grp.updateWorldMatrix(true, false); nrm.set(0, 0, nz).transformDirection(grp.matrixWorld); plane.setFromNormalAndCoplanarPoint(nrm, grp.localToWorld(new THREE.Vector3(0, 0, z))); return rc.ray.intersectPlane(plane, hitP) ? grp.worldToLocal(hitP.clone()) : null; };
    const itemAt = (ndc, cam, layer) => {
      rc.setFromCamera(ndc, cam); rc.layers.set(layer);
      const own = []; Object.values(items).forEach((g) => own.push(...g.meshes));
      const hit = rc.intersectObjects(own, false)[0]; if (!hit) return null;
      for (const [id, g] of Object.entries(items)) if (g.meshes.includes(hit.object)) return id;
      return null;
    };
    const startClose = () => {   // 闔上前：封面上的作品收回右邊，所有作品整理到完全在文件夾裡
      if (closing) return;
      closing = { t: 0, list: order.map((id) => {
        const wasCover = home[id] === hinge; if (wasCover) toBack(id);
        const R = items[id].root, from = { p: R.position.clone(), q: R.quaternion.clone() };
        const a0 = wasCover ? SPECS_HOME[id][2] : R.rotation.z;   // 從封面收回來的：用它在文件夾裡原本的角度
        const x0 = R.position.x, y0 = R.position.y;
        const [x, y, a] = fit(id, x0, y0, a0, -FW / 2, FW / 2);
        return { id, from, to: { p: new THREE.Vector3(x, y, R.position.z), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a)) } };
      }) };
      restack(); closing.list.forEach((c) => { c.to.p.z = items[c.id].root.position.z; });
    };
    const api = {
      root, meshes, height: FW, items,
      tick(dt) {
        if (closing) {   // 整理中（約 0.4 秒），整理完才闔上
          closing.t = Math.min(1, closing.t + dt / 0.4); const e = closing.t < 0.5 ? 2 * closing.t * closing.t : 1 - Math.pow(-2 * closing.t + 2, 2) / 2;
          closing.list.forEach((c) => { const R = items[c.id].root; R.position.lerpVectors(c.from.p, c.to.p, e); R.quaternion.slerpQuaternions(c.from.q, c.to.q, e); });
          if (closing.t >= 1) { closing = null; want = 0; }
        }
        if (open !== want) { open += Math.sign(want - open) * Math.min(Math.abs(want - open), dt / (want ? 0.9 : 0.6)); apply(); if (open === 0 && leaving && api.onClosed) api.onClosed(); }
      },
      held(e) { if (e < 0.1) homing = false; if (e > 0.85) { if (!leaving && !homing) want = 1; } else if (open > 0 && want === 1 && !closing) startClose(); },   // 拿到眼前之後才翻開；闔好、正要放回書架的途中不再打開
      back() {   // 按「放回去」：先在眼前把作品整理好、闔上，闔好了才放回書架（onClosed）
        if (open <= 0.01) { leaving = false; homing = true; return false; }
        if (!leaving) { leaving = true; startClose(); }
        return true;
      },
      onClosed: null,
      isOpen: () => open > 0.85,
      put(id, g, F) {   // 作品放進文件夾：躺在背板上，一張疊一張（整理到不超出文件夾）
        g.root.scale.setScalar(1); back.add(g.root); items[id] = g; home[id] = back; g.meshes.forEach((m) => meshes.push(m));
        measure(id, g);
        const [x, y, a] = fit(id, F.at[0], F.at[1], F.yaw, -FW / 2, FW / 2); SPECS_HOME[id] = [x, y, a];
        g.root.position.set(x, y, 0); g.root.rotation.set(0, 0, a);
        SPECS_LAYER[id] = F.layer; order.push(id); order.sort((p, q) => SPECS_LAYER[p] - SPECS_LAYER[q]); restack();
      },
      adopt(id, R) { (home[id] || back).attach(R); restack(); },   // 從手上放回來：回到它原本那一邊
      pick(ndc, cam, layer) { if (open < 0.85 || closing) return false; return itemAt(ndc, cam, layer) || false; },   // 文件夾翻開時，點到哪一件作品
      dragStart(ndc, cam, layer) {   // 按到作品上：準備拖曳（還沒移動前，放開仍算是「點一下」）
        if (open < 0.85 || closing) return false;
        const id = itemAt(ndc, cam, layer); if (!id) return false;
        const onB = home[id] === back, p = onB ? onPlane(back, Z0 + DZ * (order.length + 1), 1, ndc, cam) : onPlane(hinge, COVER_Z - DZ * (order.length + 1), -1, ndc, cam); if (!p) return false;
        const R = items[id].root; drag = { id, ox: R.position.x - p.x, oy: R.position.y - p.y, raised: false }; return true;
      },
      dragMove(ndc, cam) {
        if (!drag) return;
        const id = drag.id, R = items[id].root;
        if (!drag.raised) { drag.raised = true; order.splice(order.indexOf(id), 1); order.push(id); }   // 拿起來的那件放到最上面
        const pb = onPlane(back, Z0 + DZ * (order.length + 1), 1, ndc, cam); if (!pb) return;
        const leftSide = home[id] === hinge ? pb.x < -FW / 2 + 0.006 : pb.x < -FW / 2 - 0.006;   // 越過中間的摺邊（留一點點緩衝，不會來回跳）
        if (leftSide) {   // 左邊：放在封面內側（可以超出封面）
          const pc = onPlane(hinge, COVER_Z - DZ * (order.length + 1), -1, ndc, cam); if (!pc) return;
          if (home[id] !== hinge) { toCover(id); drag.ox = R.position.x - pc.x; drag.oy = R.position.y - pc.y; }   // 接續原本的位置，不跳
          R.position.x = Math.max(-0.12, Math.min(FW + 0.12, pc.x + drag.ox)); R.position.y = Math.max(-FH / 2 - 0.1, Math.min(FH / 2 + 0.1, pc.y + drag.oy));
        } else {   // 右邊：放在背板上（可以超出文件夾）
          if (home[id] !== back) { const a = R.rotation.z; toBack(id); R.rotation.set(0, 0, -a); drag.ox = R.position.x - pb.x; drag.oy = R.position.y - pb.y; }
          R.position.x = Math.max(-FW / 2 - 0.12, Math.min(FW / 2 + 0.12, pb.x + drag.ox)); R.position.y = Math.max(-FH / 2 - 0.1, Math.min(FH / 2 + 0.1, pb.y + drag.oy));
        }
        restack();
      },
      dragEnd() { drag = null; },
    };
    return api;
  }
  const SPECS_HOME = {};
  const SPECS_LAYER = {};

  /* ---------- 作品 ---------- */
  // 把圖畫到紙上：pad 是留白（比例）
  function printed(im, w, h, o = {}) {
    const PX = 1024, cw = w >= h ? PX : Math.round(PX * w / h), chh = w >= h ? Math.round(PX * h / w) : PX;
    const c = document.createElement('canvas'); c.width = cw; c.height = chh; const g = c.getContext('2d');
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, cw, chh);
    const pad = o.pad || 0, aw = cw * (1 - 2 * pad), ah = chh * (1 - 2 * pad), k = Math.min(aw / im.width, ah / im.height);
    const dw = im.width * k, dh = im.height * k; g.drawImage(im, (cw - dw) / 2, (chh - dh) / 2, dw, dh);
    return tex(c);
  }
  /* 一張紙：正面是圖、背面是素紙。不是平板：兩個方向都有柔和的彎度，一角微微翹起；
     soft 為 true 時，拿在手上會輕輕起伏（像手裡拿著一張軟紙）。 */
  function paper(w, h, front, o = {}) {
    const grp = new THREE.Group(), list = [], seg = o.seg || [16, 20];
    const geo = new THREE.PlaneGeometry(w, h, seg[0], seg[1]), p = geo.attributes.position;
    if (o.uv) { const u = geo.attributes.uv; for (let i = 0; i < u.count; i++) u.setX(i, o.uv[0] + (o.uv[1] - o.uv[0]) * u.getX(i)); }
    const X = new Float32Array(p.count), Y = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) { X[i] = p.getX(i) / (w / 2); Y[i] = p.getY(i) / (h / 2); }
    // 折頁的折線那一邊（pin）固定不彎：兩半在折線上永遠貼在一起，看起來是同一張紙
    const PIN = new Float32Array(p.count); for (let i = 0; i < p.count; i++) PIN[i] = o.pin === 'right' ? Math.min(1, (1 - X[i]) * 1.4) : o.pin === 'left' ? Math.min(1, (1 + X[i]) * 1.4) : 1;
    const bk = geo.clone(); bk.rotateY(Math.PI);
    const front_m = mesh(geo, mat(Object.assign({ map: front, roughness: 0.82, side: THREE.FrontSide }, o.alpha ? { alphaTest: 0.5 } : {})), list, grp);
    const back_m = mesh(bk, mat(Object.assign({ color: o.backColor || PAPER, roughness: 0.9 }, o.alpha ? { map: front, alphaTest: 0.5 } : {})), list, grp);
    back_m.position.z = -0.0002;
    const A = o.bend === undefined ? 1 : o.bend, corner = o.corner || [1, -1];   // （在文件夾裡是平的，疊在一起才不會互相穿插；拿到手上才彎）
    const shape = (sway, t) => {   // 紙面的高度：橫向彎 + 縱向稍微彎 + 一角翹起 + 拿在手上的輕微起伏
      const bp = bk.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = X[i], y = Y[i];
        let z = PIN[i] * sway * A * (0.0026 * (1 - x * x) + 0.0012 * (1 - y * y) * x + 0.0028 * Math.pow(Math.max(0, (x * corner[0] + y * corner[1]) / 2), 3));
        if (sway) z += PIN[i] * sway * (Math.sin(t * 1.7 + x * 2.2 + y * 1.3) * 0.0022 * (0.4 + 0.6 * Math.abs(x)) + Math.sin(t * 1.1 + y * 2.5) * 0.0012);
        p.setZ(i, z); bp.setZ(i, z);
      }
      p.needsUpdate = bp.needsUpdate = true; geo.computeVertexNormals(); bk.computeVertexNormals();
    };
    shape(0, 0);
    let held = 0, t = 0;
    return { grp, list, tick(dt) { if (!o.soft) return; t += dt; if (held > 0.01) shape(held, t); }, held(e) { if (!o.soft) return; const was = held; held = Math.max(0, Math.min(1, (e - 0.6) / 0.4)); if (was > 0.01 && held <= 0.01) shape(0, 0); } };
  }

  // 迴紋針：直立的長形迴紋針，上面的彎跨過紙的上緣——正面一段長 U，繞過上緣後在紙的背面再一段短 U
  function paperclip(zf, zb, len = 0.032) {
    const pts = [], P = (x, y, z) => pts.push(new THREE.Vector3(x, y, z));
    const arc = (cx, cy, r, a0, a1, z0, z1, n = 12) => { for (let i = 1; i <= n; i++) { /* 從第 1 點開始：第 0 點和上一段的終點重疊，重疊的點會讓鐵絲整支算不出方向而消失 */ const a = a0 + (a1 - a0) * i / n, f = i / n; P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0 + (z1 - z0) * f); } };
    const R1 = 0.0028, R2 = 0.0021, R3 = 0.0016;
    P(R1, -len * 0.2, zf);                                   // 正面：內側那一端
    arc(0, -len * 0.82, R1, 0, -Math.PI, zf, zf);             // 往下到底的大彎
    P(-R1, 0.0, zf);                                          // 左邊長長的一段往上，超過紙的上緣
    arc(-R1 + R2, 0.0, R2, Math.PI, 0, zf, zb);               // 上面的彎：跨過紙緣，從正面繞到背面
    P(-R1 + 2 * R2, -len * 0.55, zb);                          // 背面往下
    arc(-R1 + 2 * R2 - R3, -len * 0.55, R3, 0, -Math.PI, zb, zb);
    P(-R1 + 2 * R2 - 2 * R3, -len * 0.18, zb);                 // 背面那一端
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), 220, 0.00055, 6);
    return new THREE.Mesh(g, mat({ color: 0xC9CDD2, metalness: 0.85, roughness: 0.3 }));
  }

  async function load(key) {
    key = String(key).split('?')[0];   // 房間載入時會在後面加上版本號
    const S = SPECS[key]; if (!S) throw new Error('沒有這件作品：' + key);
    const root = new THREE.Group(), meshes = [];
    if (S.type === 'sheet') {   // 海報：柔軟的紙
      const im = await loadImg(S.img), h = S.w * im.height / im.width;
      const pp = paper(S.w, h, imgTex(im), { soft: true, corner: [1, -1] }); root.add(pp.grp); meshes.push(...pp.list);
      return { root, meshes, height: Math.max(S.w, h), tick: pp.tick, held: pp.held };
    }
    if (S.type === 'card') {   // 明信片：硬卡（約 0.5 公釐厚），平的、不會彎；正面是設計，背面和側邊是米白卡紙
      const im = await loadImg(S.img), h = S.w * im.height / im.width, T = 0.0003;
      const stock = mat({ color: PAPER, roughness: 0.85 }), front = mat({ map: imgTex(im), roughness: 0.55 });
      const card = mesh(new THREE.BoxGeometry(S.w, h, T), [stock, stock, stock, stock, front, stock], meshes, root);
      card.position.z = T / 2;
      return { root, meshes, height: Math.max(S.w, h), thick: T, tick() {} };
    }
    if (S.type === 'cut') {   // 春聯：去背的剪紙，正反面都是同樣的形狀
      const im = await loadImg(S.img), h = S.w * im.height / im.width;
      const pp = paper(S.w, h, imgTex(im), { alpha: true, backColor: '#9E1C24', soft: true, corner: [-1, -1], seg: [16, 18] }); root.add(pp.grp); meshes.push(...pp.list);   // 拿到手上一樣是柔軟、微彎的紙
      return { root, meshes, height: Math.max(S.w, h), tick: pp.tick, held: pp.held };
    }
    if (S.type === 'fold') {   // 折頁：左半邊固定，右半邊沿中線往後折；拿到眼前時攤開（中間留一道折痕）
      const im = await loadImg(S.img), h = S.w * im.height / im.width, half = S.w / 2, t = imgTex(im);
      const lh = new THREE.Group(); root.add(lh);   // 左半邊也繞著中間的折線轉，兩半在折線上永遠接在一起
      const L = paper(half, h, t, { uv: [0, 0.5], soft: true, corner: [-1, 1], seg: [12, 14], pin: 'right' }); L.grp.position.x = -half / 2; lh.add(L.grp); meshes.push(...L.list);
      const hinge = new THREE.Group(); root.add(hinge);
      const Rr = paper(half, h, t, { uv: [0.5, 1], soft: true, corner: [1, -1], seg: [12, 14], pin: 'left' }); Rr.grp.position.x = half / 2; hinge.add(Rr.grp); meshes.push(...Rr.list);
      let k = 0;
      const apply = () => { const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; hinge.rotation.y = Math.PI * (1 - e) - 0.08 * e; hinge.position.z = -0.0005 * (1 - e); lh.rotation.y = 0.08 * e; };   // 攤開後兩半各往前收一點，留下一道 V 形的折痕
      apply();
      return {
        root, meshes, height: S.w,
        tick(dt) { L.tick(dt); Rr.tick(dt); },
        held(e) { const want = Math.max(0, Math.min(1, (e - 0.55) / 0.45)); if (want !== k) { k = want; apply(); } L.held(e); Rr.held(e); },
      };
    }
    if (S.type === 'clip') {   // 迴紋針夾：幾張錯開疊著，上緣用迴紋針夾住；點一下，最上面那張抽到最後面
      const ims = await Promise.all(S.imgs.map(loadImg)), r = rng(S.imgs.length * 7 + 3), sheets = [], SPC = 0.0004;   // 卡片之間的間距（疊得很緊）
      let topY = 0;
      ims.forEach((im) => { const h = S.raw ? Math.min(S.w * im.height / im.width, 0.075) : S.w; topY = Math.max(topY, h / 2); });
      ims.forEach((im, i) => {
        const w = S.raw ? Math.min(S.w, 0.075 * im.width / im.height) : S.w, h = S.raw ? w * im.height / im.width : S.w;   // logo：照原圖的比例，不加底卡
        const pp = paper(w, h, S.raw ? imgTex(im) : printed(im, w, h, { pad: S.pad }), { bend: 0, seg: [2, 2] });   // 卡片是硬的、平的，迴紋針才會浮在最上面那張前面
        const off = { x: (r() - 0.5) * 0.012, y: topY - h / 2 - (r() * 0.004), a: (r() - 0.5) * 0.1 };   // 上緣大致對齊，迴紋針才夾得到每一張
        root.add(pp.grp); meshes.push(...pp.list); sheets.push({ grp: pp.grp, off, order: i, flip: 0 });
      });
      const n = sheets.length, clip = paperclip(0.0008, -SPC * n - 0.0005);
      clip.position.set(-0.012, topY + 0.001, 0); clip.rotation.z = 0.05; clip.castShadow = true; root.add(clip); meshes.push(clip);   // 上面的彎高出紙緣一點：跨過紙緣，像真的夾住
      const layout = (dt) => {
        sheets.forEach((s) => {
          s.flip = Math.max(0, s.flip - (dt || 0) / 0.6);
          const lift = Math.sin(Math.PI * s.flip) * topY * 1.7;   // 抽出去再塞回最後面
          s.grp.position.set(s.off.x, s.off.y - lift, -SPC * s.order);
          s.grp.rotation.z = s.off.a;
        });
      };
      layout(0);
      return {
        root, meshes, height: topY * 2 * 1.2, depth: { below: SPC * S.imgs.length + 0.0012, above: 0.0016 },   // 迴紋針前後佔的空間
        tick(dt) { if (sheets.some((s) => s.flip > 0)) layout(dt); },
        pick(ndc, cam, layer) {   // 拿在手上時點它：最上面那張換到最後
          const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, cam); rc.layers.set(layer);
          if (!rc.intersectObjects(meshes, false).length) return false;
          sheets.forEach((s) => { s.order = s.order === 0 ? n - 1 : s.order - 1; });
          sheets.find((s) => s.order === n - 1).flip = 1; layout(0); return true;
        },
      };
    }
    throw new Error('不認得的作品類型');
  }
  window.GraphicFolder = { folder, load, SPECS, FW, FH };
})();
