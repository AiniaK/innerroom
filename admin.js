/* 內在房間・房主後台
 *
 * 只有房主會打開這個頁面。流程：
 *   1. 用 Google 登入，取得 ID token（約 1 小時有效）。
 *   2. 每次呼叫 Worker 都帶上 Authorization: Bearer <ID token>，由 Worker 驗證並比對房主 email 白名單。
 *   3. 「儲存並更新房間」把新的 content.json 送到 Worker，Worker 提交到 GitHub，GitHub Pages 約 1 分鐘後更新。
 *
 * 這個頁面用到的 Worker API（第四階段實作）：
 *   GET    /api/me                         → { email }                 確認是房主
 *   GET    /api/content                    → { content, sha }          讀取 repo 裡最新的 content.json
 *   PUT    /api/content                    { content, sha, sections } → { sha, commitUrl }
 *   GET    /api/media                      → { files: [{ path, size }] }
 *   PUT    /api/media?path=media/…         內容為 {"encoding":"base64","content":"…"} → { path, size, commitUrl }
 *   DELETE /api/media?path=media/…         → { commitUrl }
 *   GET    /api/admin/comments             → { comments: [...] }
 *   PATCH  /api/admin/comments/:id         { public } → { comment }
 *   DELETE /api/admin/comments/:id
 *   GET    /api/admin/blocks               → { blocks: [{ author, note, createdAt }] }
 *   PUT    /api/admin/blocks/:author       { note }
 *   DELETE /api/admin/blocks/:author
 */
(() => {
'use strict';

const CFG = window.ROOM_CONFIG || {};
const MB = 1048576;
const WORKER_MAX = 25 * MB;        // 經 Worker 上傳的單檔上限
const COMPRESS_TARGET = 20 * MB;   // 瀏覽器壓縮影片的目標大小
const PICK_MAX = 500 * MB;         // 可以選來壓縮的原始檔上限
const SAFE_LINK = /^https:\/\/(www\.|music\.|m\.)?(youtube\.com|youtu\.be|open\.spotify\.com|spotify\.link)\//i;
const TOKEN_KEY = 'innerroom.admin.idtoken';
const TAB_KEY = 'innerroom.admin.tab';
const SECTION_NAMES = { texts: '物件說明', exhibits: '展品', settings: '房間設定', media: '影片與音樂' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = o => JSON.parse(JSON.stringify(o));
const fmtMB = n => (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB';
const fileName = p => String(p || '').split('/').pop();
const fireWord = v => v < 20 ? '微弱' : v < 40 ? '安靜' : v < 65 ? '中等' : v < 85 ? '旺盛' : '熊熊';
let toastT = 0;
function toast(s) { const t = $('#toast'); t.querySelector('span').textContent = s; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3600); }
function status(s, kind) { const el = $('#stat'); el.textContent = s; el.className = kind || ''; }
const err = (code, extra) => Object.assign(new Error(code), { code }, extra || {});

/* ======================= 登入 ======================= */
let token = null;
function jwtPayload(t) {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '='.repeat((4 - b.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch { return null; }
}
const tokenValid = t => { const p = t && jwtPayload(t); return !!(p && p.exp * 1000 > Date.now() + 60_000); };

function showLogin(msg) {
  $('#login').hidden = false;
  $('#loginMsg').textContent = msg || '';
  if (!$('#app').hidden) $('#loginIntro').textContent = '登入已過期，請再登入一次。你剛剛的修改還在，登入後再按一次儲存就好。';
}
function signOut(expired) {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  showLogin(expired ? '' : '已登出。');
}

async function onCredential(resp) {
  const t = resp && resp.credential;
  if (!t) return;
  token = t;
  $('#loginMsg').textContent = '確認房主身分中…';
  try {
    const me = await api('/api/me');
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch {}
    $('#login').hidden = true;
    $('#who').textContent = me.email || '';
    if (!started) start(); else toast('已重新登入');
  } catch (e) {
    token = null;
    $('#loginMsg').textContent = e.code === 'not_owner' ? '這個 Google 帳號不是房主，沒有使用後台的權限。'
      : e.code === 'no_worker' ? '後台還沒接上伺服器：請先在 config.js 填入 workerUrl。'
      : '無法確認身分：' + explain(e);
  }
}

function initGoogle() {
  if (!CFG.googleClientId) {
    $('#loginMsg').textContent = '還沒有設定 Google 登入：請先在 config.js 填入 googleClientId（見部署說明）。';
    return;
  }
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: CFG.googleClientId, callback: onCredential, auto_select: true, ux_mode: 'popup', use_fedcm_for_prompt: true });
    google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'zh-TW' });
    if (!token) google.accounts.id.prompt();
  };
  s.onerror = () => { $('#loginMsg').textContent = '載入 Google 登入失敗，請檢查網路後重新整理。'; };
  document.head.appendChild(s);
}

/* ======================= Worker API ======================= */
const apiBase = () => String(CFG.workerUrl || '').replace(/\/+$/, '');
async function api(path, opt = {}) {
  if (!apiBase()) throw err('no_worker');
  if (!tokenValid(token)) { signOut(true); throw err('expired'); }
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, opt.headers || {});
  let body = opt.body;
  if (opt.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opt.json); }
  let res;
  try { res = await fetch(apiBase() + path, { method: opt.method || 'GET', headers, body }); }
  catch { throw err('network'); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) { signOut(true); throw err('expired'); }
  if (!res.ok) throw err((data && data.error) || 'http_' + res.status, { status: res.status, data });
  return data || {};
}
// 上傳要顯示進度，所以用 XMLHttpRequest
function apiUpload(path, body, onProgress) {
  return new Promise((resolve, reject) => {
    if (!apiBase()) return reject(err('no_worker'));
    if (!tokenValid(token)) { signOut(true); return reject(err('expired')); }
    const x = new XMLHttpRequest();
    x.open('PUT', apiBase() + path);
    x.setRequestHeader('Authorization', 'Bearer ' + token);
    x.setRequestHeader('Content-Type', 'application/json');
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch {}
      if (x.status === 401) { signOut(true); return reject(err('expired')); }
      if (x.status >= 200 && x.status < 300) resolve(data || {});
      else reject(err((data && data.error) || 'http_' + x.status, { status: x.status, data }));
    };
    x.onerror = () => reject(err('network'));
    x.send(body);
  });
}
function explain(e) {
  const c = e && e.code;
  return ({
    no_worker: '還沒有設定 Worker 網址（config.js 的 workerUrl）。',
    expired: '登入已過期，請重新登入。',
    network: '連不上伺服器，請檢查網路後再試一次。',
    not_owner: '這個帳號不是房主。',
    conflict: '網站上的內容在別的地方被修改過（例如你在 GitHub 網頁改了檔案）。請重新整理後台，再做一次修改並儲存。',
    too_large: '檔案太大，無法經伺服器上傳。',
    bad_path: '檔名或資料夾不被接受：只能放進 media/，且只能是 MP4、WebM、MP3、M4A 或 JPG。',
    in_use: '這個檔案還在使用中。',
    is_whisper: '這是訪客的悄悄話，不能公開。',
    rate_limited: '操作太頻繁了，請稍等一下再試。',
    github_error: (e && e.data && e.data.hint ? e.data.hint + '。' : 'GitHub 暫時無法寫入，請稍後再試。'),
    notion_error: 'Notion 暫時無法讀寫，請稍後再試。',
    not_found: '找不到這筆資料，可能已經被刪除。',
    not_configured: 'Worker 的設定還不完整' + (e && e.data && e.data.field ? '（缺少 ' + e.data.field + '）' : '') + '，請照部署說明補上。',
    forbidden_origin: 'Worker 不接受從這個網址送出的請求，請確認 Worker 的 ALLOWED_ORIGINS 設定。',
    busy: '網站正在更新中，請稍等幾秒再試一次。',
    bad_upload: 'GitHub 不接受這個檔案，請換一個檔案再試。',
    notion_busy: 'Notion 暫時太忙，請稍後再試。',
  })[c] || (e && e.status === 404 ? '伺服器還沒有這個功能。' : '發生錯誤（' + (c || '未知') + '）。');
}

/* ======================= 狀態 ======================= */
let started = false, catalog = null, contentSha = null, baseline = {};
let items = {}, fire = 50, ex = {}, tv = null, tvView = {}, music = { tracks: [], links: [] };
let mediaFiles = [], savedRefs = new Set();
// 剛上傳的檔案要等 GitHub Pages 更新後網站上才有，在那之前預覽用電腦裡的那份
const localURL = {};
const viewURL = p => localURL[p] || p;
let dirtyNote = false;

function loadState(c) {
  c = c || {};
  const t = c.texts || {};
  items = clone(t.items || {});
  fire = typeof t.fire === 'number' ? t.fire : catalog.fireDefault;
  const exItems = (c.exhibits && c.exhibits.items) || {};
  ex = {};
  Object.keys(catalog.exhibits).forEach(id => { ex[id] = Object.assign({}, catalog.exhibits[id].def, exItems[id] || {}); });
  tv = c.tv && c.tv.src ? clone(c.tv) : null;
  tvView = Object.assign({}, catalog.tv.def, tv && tv.view || {});
  const m = c.music || {};
  music = { tracks: (m.tracks || []).filter(x => x && x.src).map(clone), links: (m.links || []).map(clone) };
}

/* 從畫面讀出要儲存的內容（只存和預設值不同的部分，與原本的後台相同） */
function collectTexts() {
  const out = {};
  const rowKeys = new Set(catalog.texts.map(r => r[0]));
  Object.keys(items).forEach(k => { if (!rowKeys.has(k)) out[k] = items[k]; });   // 目錄裡沒有的鍵原樣保留
  document.querySelectorAll('#objList .adm-row').forEach(r => {
    const k = r.dataset.k, base = catalog.texts.find(x => x[0] === k);
    const v = n => r.querySelector(`[data-f=${n}]`);
    const t = v('t').value.trim(), b = v('b').value.trim(), h = v('h').value.trim();
    const e = {};
    if (t && t !== base[2]) e.t = t;
    if (b && b !== base[3]) e.b = b;
    if (!v('pop').checked) e.pop = false;
    if (!v('hov').checked) e.hov = false;
    if (h && h !== (catalog.hover[k] || '')) e.h = h;
    if (Object.keys(e).length) out[k] = e;
  });
  return out;
}
function exWidthOf(id) { const s = ex[id]; return Math.round(catalog.exhibits[id].OW * (s.scale > 0 ? s.scale : 1) * 100); }
function collectExhibits() {
  const W = catalog.wall;
  document.querySelectorAll('#exList [data-ex]').forEach(r => {
    const id = r.dataset.ex, s = ex[id], E = catalog.exhibits[id], f = n => r.querySelector(`[data-f=${n}]`);
    s.kind = f('kind').value.trim() || E.kind;
    s.title = f('title').value.trim() || E.def.title;
    s.desc = f('desc').value.trim();
    s.popup = f('popup').checked; s.hover = f('hover').checked; s.hidden = f('hidden').checked;
    s.mode = f('mode').value;
    const w = +f('width').value;
    if (w > 0) s.scale = clamp(w / 100 / E.OW, .2, 4);
    const half = E.OW * (s.scale > 0 ? s.scale : 1) / 2;
    s.along = +clamp(+f('along').value || 0, W.zMin + half, W.zMax - half).toFixed(3);
    s.height = +clamp(+f('height').value || 1.5, W.hMin, W.hMax).toFixed(3);
  });
  return clone(ex);
}
function buildContent() {
  return {
    texts: { items: collectTexts(), fire },
    exhibits: { items: collectExhibits() },
    tv: tv ? Object.assign({}, tv, { view: Object.assign({}, tvView) }) : null,
    music: { tracks: music.tracks.map(clone), links: music.links.map(clone) },
    savedAt: Date.now(),
  };
}
function sectionsOf(c) {
  return {
    texts: JSON.stringify(c.texts.items),
    exhibits: JSON.stringify(c.exhibits),
    settings: JSON.stringify(c.texts.fire),
    media: JSON.stringify([c.tv, c.music]),
  };
}
function changedSections(c) { const s = sectionsOf(c); return Object.keys(s).filter(k => s[k] !== baseline[k]); }
function markDirty() { if (!started) return; dirtyNote = true; if (!/中…$/.test($('#stat').textContent)) status('有尚未儲存的修改'); }
addEventListener('beforeunload', e => {
  if (!started) return;
  try { if (changedSections(buildContent()).length) { e.preventDefault(); e.returnValue = ''; } } catch {}
});

/* ======================= 啟動 ======================= */
async function start() {
  started = true;
  $('#app').hidden = false;
  status('載入中…');
  try {
    catalog = await (await fetch('data/catalog.json', { cache: 'no-store' })).json();
  } catch { status('讀不到 data/catalog.json，請重新整理。', 'err'); return; }
  let remote;
  try { remote = await api('/api/content'); }
  catch (e) { status('讀不到網站內容：' + explain(e), 'err'); started = false; return; }
  contentSha = remote.sha || null;
  loadState(remote.content);
  savedRefs = refsOf(remote.content || {});
  renderTexts(); renderExhibits(); renderSettings(); setupTV(); renderMusic(); setupTabs();
  baseline = sectionsOf(buildContent());
  status('已載入網站目前的內容');
  refreshFiles();
  loadComments();
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const show = id => {
    tabs.forEach(b => b.setAttribute('aria-selected', b.dataset.tab === id));
    document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== 'tab-' + id);
    scrollTo(0, 0);
    try { localStorage.setItem(TAB_KEY, id); } catch {}
  };
  tabs.forEach(b => b.onclick = () => show(b.dataset.tab));
  let first = 'obj';
  try { const t = localStorage.getItem(TAB_KEY); if (t && $('#tab-' + t)) first = t; } catch {}
  show(first);
}

/* ======================= 物件說明 ======================= */
function renderTexts() {
  const ov = k => items[k] || {};
  $('#objList').innerHTML = catalog.texts.map(([k, label, t, b]) => {
    const v = ov(k), pop = v.pop !== false;
    return `<div class="adm-row${pop ? '' : ' off'}" data-k="${esc(k)}"><div class="k">${esc(label)}<br>${esc(k)}</div><div class="f">
      <div class="hov"><span title="游標移上去時顯示的名稱"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6"/><line x1="12" y1="7" x2="12" y2="10"/></svg></span>
        <input type="text" data-f="h" maxlength="40" value="${esc(v.h || catalog.hover[k] || '')}" placeholder="游標移上去時顯示的名稱" aria-label="${esc(label)}：游標移上去時顯示的名稱"></div>
      <input type="text" data-f="t" maxlength="40" value="${esc(v.t || t)}" placeholder="彈窗標題" aria-label="${esc(label)}：彈窗標題">
      <textarea data-f="b" maxlength="800" rows="2" placeholder="說明文字" aria-label="${esc(label)}：說明文字">${esc(v.b || b)}</textarea>
      <div class="opts"><label><input type="checkbox" data-f="pop" ${pop ? 'checked' : ''}> 點擊時顯示彈窗</label><label><input type="checkbox" data-f="hov" ${v.hov === false ? '' : 'checked'}> 游標移上去時顯示名稱</label></div></div></div>`;
  }).join('');
  $('#objList').addEventListener('input', markDirty);
  $('#objList').addEventListener('change', e => { if (e.target.dataset.f === 'pop') e.target.closest('.adm-row').classList.toggle('off', !e.target.checked); markDirty(); });
  $('#objQ').oninput = e => {
    const s = e.target.value.trim();
    document.querySelectorAll('#objList .adm-row').forEach(r => { r.hidden = !!s && !r.textContent.includes(s) && ![...r.querySelectorAll('input[type=text],textarea')].some(i => i.value.includes(s)); });
  };
}

/* ======================= 展品 ======================= */
function renderExhibits() {
  $('#exList').innerHTML = Object.keys(catalog.exhibits).map(id => {
    const E = catalog.exhibits[id], s = ex[id];
    return `<div class="adm-row ex${s.popup === false ? ' off' : ''}" data-ex="${esc(id)}"><div class="k">展品<br>${esc(id)}<br><img src="${esc(E.img)}" alt="" style="width:100%;max-width:120px;margin-top:8px;border:4px solid #D9B98E;border-radius:3px;box-sizing:border-box"></div><div class="f">
      <input type="text" data-f="kind" maxlength="20" value="${esc(s.kind || E.kind)}" placeholder="類別" aria-label="類別">
      <input type="text" data-f="title" maxlength="40" value="${esc(s.title)}" placeholder="名稱" aria-label="名稱">
      <textarea data-f="desc" maxlength="800" rows="3" placeholder="介紹文字" aria-label="介紹文字">${esc(s.desc || '')}</textarea>
      <div class="opts"><label><input type="checkbox" data-f="popup" ${s.popup === false ? '' : 'checked'}> 點擊時顯示彈窗</label><label><input type="checkbox" data-f="hover" ${s.hover === false ? '' : 'checked'}> 游標移上去時顯示名稱</label><label><input type="checkbox" data-f="hidden" ${s.hidden ? 'checked' : ''}> 收進收納箱（不顯示）</label>
        <label>擺放 <select data-f="mode" style="width:auto"><option value="hang" ${s.mode === 'hang' ? 'selected' : ''}>掛在牆上</option><option value="lean" ${s.mode !== 'hang' ? 'selected' : ''}>斜靠在地上</option></select></label>
        <label>水平位置 <input type="number" data-f="along" step="0.05" value="${(+s.along).toFixed(2)}"></label>
        <label>高度 <input type="number" data-f="height" step="0.05" value="${(+s.height).toFixed(2)}"></label>
        <label>寬度（公分） <input type="number" data-f="width" step="1" min="10" value="${exWidthOf(id)}"></label></div></div>
      <canvas class="exw" data-w="${esc(id)}" width="600" height="300" aria-label="白牆示意"></canvas></div>`;
  }).join('');
  const W = catalog.wall;
  const drawOne = (cv, sel) => {
    const g = cv.getContext('2d'), pad = 14, w = cv.width - pad * 2, h = cv.height - pad * 2 - 16, sx = w / (W.z1 - W.z0), sy = h / W.h;
    const X = z => pad + (W.z1 - z) * sx, Y = y => pad + (W.h - y) * sy;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#F3EADB'; g.fillRect(X(W.z1), Y(W.h), w, h); g.strokeStyle = '#CDBB9E'; g.lineWidth = 1; g.strokeRect(X(W.z1), Y(W.h), w, h);
    g.fillStyle = '#D9C6A6'; g.fillRect(X(W.z1), Y(0), w, 3);
    g.fillStyle = '#9C8A72'; g.font = '15px sans-serif'; g.textAlign = 'left'; g.fillText('← 南', X(W.z1), cv.height - 5); g.textAlign = 'right'; g.fillText('北 →', X(W.z0), cv.height - 5);
    const ids = Object.keys(catalog.exhibits).sort((a, b) => (a === sel) - (b === sel));
    for (const id of ids) {
      const r = document.querySelector(`#exList [data-ex="${id}"]`); if (!r) continue;
      const f = n => r.querySelector(`[data-f=${n}]`); if (f('hidden').checked) continue;
      const E = catalog.exhibits[id], ww = (+f('width').value || E.OW * 100) / 100, hh = ww * E.OH / E.OW, z = +f('along').value || 0;
      const cy = f('mode').value === 'hang' ? (+f('height').value || 1.5) : hh / 2;
      const x0 = X(z + ww / 2), x1 = X(z - ww / 2), y0 = Y(cy + hh / 2), y1 = Y(cy - hh / 2), me = id === sel;
      g.strokeStyle = me ? '#D23B2E' : '#8A6A4A'; g.lineWidth = me ? 4 : 2; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (me) { g.fillStyle = 'rgba(210,59,46,.12)'; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.fillStyle = '#D23B2E'; g.textAlign = 'center'; g.font = '15px sans-serif'; g.fillText(f('title').value || id, (x0 + x1) / 2, Math.max(16, y0 - 6)); }
    }
  };
  const draw = () => document.querySelectorAll('canvas.exw').forEach(cv => drawOne(cv, cv.dataset.w));
  document.querySelectorAll('#exList [data-ex]').forEach(r => {
    r.addEventListener('input', () => { draw(); markDirty(); });
    r.addEventListener('change', e => { if (e.target.dataset.f === 'popup') r.classList.toggle('off', !e.target.checked); draw(); markDirty(); });
  });
  draw();
}

/* ======================= 房間設定 ======================= */
function renderSettings() {
  const r = $('#fire');
  r.value = fire;
  const show = () => { $('#fireV').textContent = fire + '・' + fireWord(fire); };
  show();
  r.oninput = () => { fire = +r.value; show(); markDirty(); };
}

/* ======================= 檔案上傳（共用） ======================= */
const kindOfPath = p => /\.(mp3|m4a)$/i.test(p) ? 'audio' : /\.(mp4|webm)$/i.test(p) ? 'av' : /\.jpe?g$/i.test(p) ? 'image' : 'other';
function slug(name) { return String(name).toLowerCase().replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function extOf(file) {
  const t = file.type || '', n = file.name || '';
  if (/webm/.test(t) || /\.webm$/i.test(n)) return 'webm';
  if (/mpeg|mp3/.test(t) || /\.mp3$/i.test(n)) return 'mp3';
  if (/m4a|x-m4a|audio\/mp4|aac/.test(t) || /\.m4a$/i.test(n)) return 'm4a';
  if (/jpe?g/.test(t) || /\.jpe?g$/i.test(n)) return 'jpg';
  if (/mp4/.test(t) || /\.mp4$/i.test(n)) return 'mp4';
  return '';
}
function newPath(prefix, file, ext) { const s = slug(file.name || ''); return `media/${prefix}${s ? '-' + s : ''}-${stamp()}.${ext}`; }

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => rej(err('read_failed'));
    r.readAsDataURL(blob);
  });
}
// 上傳到 media/。內容先在瀏覽器轉成 GitHub 要的格式，Worker 只負責原樣轉交，不必重新處理大檔案
async function uploadMedia(blob, path, ui) {
  if (blob.size > WORKER_MAX) throw err('too_large');
  ui.say('準備檔案中…');
  const b64 = await blobToBase64(blob);
  const body = new Blob(['{"encoding":"base64","content":"', b64, '"}'], { type: 'application/json' });
  ui.say('上傳中… 0%');
  ui.progress(0);
  const r = await apiUpload('/api/media?path=' + encodeURIComponent(path), body, p => { ui.progress(p); ui.say(p < 1 ? `上傳中… ${Math.round(p * 100)}%` : '上傳完成，正在存進 GitHub…'); });
  ui.progress(null);
  localURL[path] = URL.createObjectURL(blob);
  mediaFiles = mediaFiles.filter(f => f.path !== path).concat([{ path, size: blob.size }]);
  return r;
}
function uploadUI(statSel, progSel) {
  const st = $(statSel), pg = $(progSel);
  return {
    say(t, isErr) { st.textContent = t; st.classList.toggle('err', !!isErr); },
    html(h, isErr) { st.innerHTML = h; st.classList.toggle('err', !!isErr); },
    progress(p) { pg.hidden = p === null; if (p !== null) pg.firstElementChild.style.width = Math.round(p * 100) + '%'; },
  };
}
function githubUploadURL() {
  return CFG.githubRepo ? `https://github.com/${CFG.githubRepo}/upload/${CFG.githubBranch || 'main'}/media` : null;
}
function tooLargeHelp(file, canCompress) {
  return `這個檔案 ${fmtMB(file.size)}，超過經伺服器上傳的上限 ${fmtMB(WORKER_MAX)}。` +
    (canCompress ? '你可以按下方的按鈕，先在瀏覽器裡壓縮到 20 MB 以內再上傳；' : '') +
    '也可以<a href="#ghHelp" data-open-help>改用 GitHub 網頁上傳</a>，上傳後回到這裡從選單選取這個檔案。';
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-open-help]'); if (!a) return;
  e.preventDefault(); const d = $('#ghHelp'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// 在瀏覽器裡即時重新編碼，讓檔案落在 20 MB 以內（需要影片長度的時間）
let AC = null;
function tvCompress(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { reject(err('compress_failed')); return; }
    try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); AC.resume(); } catch {}
    const v = document.createElement('video'); v.playsInline = true; v.src = URL.createObjectURL(file);
    v.onerror = () => reject(err('compress_failed'));
    v.onloadedmetadata = () => {
      const dur = v.duration; if (!isFinite(dur) || dur <= 0) { reject(err('compress_failed')); return; }
      const sc = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * sc / 2) * 2; c.height = Math.round(v.videoHeight * sc / 2) * 2; const cx = c.getContext('2d');
      const stream = c.captureStream(30);
      try { if (AC) { const src = AC.createMediaElementSource(v), dst = AC.createMediaStreamDestination(); src.connect(dst); dst.stream.getAudioTracks().forEach(t => stream.addTrack(t)); } } catch {}
      // H.264 MP4 優先：iPhone 播不了用這種方式產生的 WebM
      const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
      const mime = types.find(t => MediaRecorder.isTypeSupported(t));
      if (!mime) { reject(err('compress_failed')); return; }
      const vbps = Math.max(250000, Math.min(2500000, Math.floor(COMPRESS_TARGET * 8 * .88 / dur) - 96000));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 96000 }); const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => { URL.revokeObjectURL(v.src); resolve(new Blob(chunks, { type: mime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm' })); };
      let raf = 0; const pump = () => { cx.drawImage(v, 0, 0, c.width, c.height); onProgress(Math.min(1, v.currentTime / dur)); if (!v.ended) raf = requestAnimationFrame(pump); };
      v.onended = () => { cancelAnimationFrame(raf); onProgress(1); rec.stop(); };
      rec.start(1000); v.play().then(pump).catch(() => { rec.stop(); reject(err('compress_failed')); });
    };
  });
}
function probeKind(src) {   // 有沒有畫面：有就是影片，沒有就是歌曲
  return new Promise(res => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.src = src;
    v.onloadedmetadata = () => res(v.videoWidth > 0 ? 'video' : 'audio');
    v.onerror = () => res(null);
    setTimeout(() => res(null), 15000);
  });
}
function coverToJpeg(file) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, 512 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(im.src); c.toBlob(b => b ? res(b) : rej(err('cover_failed')), 'image/jpeg', .88);
    };
    im.onerror = () => rej(err('cover_failed'));
    im.src = URL.createObjectURL(file);
  });
}

/* 上傳流程：太大的影片可以先壓縮；壓不了就指引改用 GitHub 網頁。上傳成功時呼叫 onDone({ path, name }) */
async function pickAndUpload(file, prefix, ui, allowCompress, onDone) {
  const ext = extOf(file);
  if (!ext || ext === 'jpg') { ui.say('只支援 MP4、WebM、MP3 或 M4A 檔案。', true); return; }
  if (file.size > PICK_MAX) { ui.html(`這個檔案 ${fmtMB(file.size)}，太大了。請先用其他軟體壓縮，或<a href="#ghHelp" data-open-help>改用 GitHub 網頁上傳</a>。`, true); return; }
  const name = (file.name || '').replace(/\.[^.]+$/, '').slice(0, 80);
  const send = async (blob, outExt) => {
    const path = newPath(prefix, file, outExt);
    try { await uploadMedia(blob, path, ui); }
    catch (e) {
      ui.progress(null);
      if (e.code === 'too_large' || e.status === 413) ui.html('伺服器不接受這麼大的檔案。請<a href="#ghHelp" data-open-help>改用 GitHub 網頁上傳</a>。', true);
      else ui.html(esc('上傳沒有成功：' + explain(e)) + (e.code === 'network' ? ' 若一直失敗，可以<a href="#ghHelp" data-open-help>改用 GitHub 網頁上傳</a>。' : ''), true);
      return;
    }
    await onDone({ path, name: name || fileName(path) });
  };
  if (file.size <= WORKER_MAX) { await send(file, ext); return; }
  const canCompress = allowCompress && /mp4|webm/.test(ext) && !!window.MediaRecorder;
  ui.html(tooLargeHelp(file, canCompress), true);
  if (!canCompress) return;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = '在瀏覽器壓縮後上傳'; b.style.marginLeft = '6px';
  $(ui.statSel).appendChild(b);
  b.onclick = async () => {
    b.remove();
    let blob;
    try { blob = await tvCompress(file, p => ui.say(`壓縮中… ${Math.round(p * 100)}%（大約需要影片長度的時間，請保持這個分頁開著）`)); }
    catch { ui.html('這支影片沒辦法在瀏覽器裡壓縮。請用其他軟體壓到 25 MB 以內，或<a href="#ghHelp" data-open-help>改用 GitHub 網頁上傳</a>。', true); return; }
    if (blob.size > WORKER_MAX) { ui.html(`壓縮後仍有 ${fmtMB(blob.size)}，請<a href="#ghHelp" data-open-help>改用 GitHub 網頁上傳</a>。`, true); return; }
    await send(blob, blob.type === 'video/webm' ? 'webm' : 'mp4');
  };
}
// pickAndUpload 需要知道狀態欄位的選擇器，好把「壓縮」按鈕放進去
function uploadUIFor(statSel, progSel) { return Object.assign(uploadUI(statSel, progSel), { statSel }); }

/* ======================= 電視 ======================= */
const tvVideo = document.createElement('video');
tvVideo.muted = true; tvVideo.loop = true; tvVideo.playsInline = true; tvVideo.preload = 'auto';
const tvCanvas = () => $('#tvPrev');
const BW_ = 128, BH_ = 72;
const tvSmall = document.createElement('canvas'); tvSmall.width = BW_; tvSmall.height = BH_;
const tvSmallCtx = tvSmall.getContext('2d', { willReadFrequently: true });
const blurTmp = new Float32Array(BW_ * BH_ * 3);
// 與房間相同的柔和模糊，讓預覽和房間裡的電視看起來一樣
function softBlur(img, r) {
  const d = img.data, w = BW_, h = BH_, t = blurTmp;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) { let ar = 0, ag = 0, ab = 0; for (let i = -r; i <= r; i++) { const x = Math.min(w - 1, Math.max(0, i)), k = (y * w + x) * 4; ar += d[k]; ag += d[k + 1]; ab += d[k + 2]; }
      for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; t[o] = ar; t[o + 1] = ag; t[o + 2] = ab; const a = (y * w + Math.max(0, x - r)) * 4, b = (y * w + Math.min(w - 1, x + r + 1)) * 4; ar += d[b] - d[a]; ag += d[b + 1] - d[a + 1]; ab += d[b + 2] - d[a + 2]; } }
    const n = 2 * r + 1;
    for (let x = 0; x < w; x++) { let ar = 0, ag = 0, ab = 0; for (let i = -r; i <= r; i++) { const y = Math.min(h - 1, Math.max(0, i)), o = (y * w + x) * 3; ar += t[o]; ag += t[o + 1]; ab += t[o + 2]; }
      for (let y = 0; y < h; y++) { const k = (y * w + x) * 4; d[k] = ar / (n * n); d[k + 1] = ag / (n * n); d[k + 2] = ab / (n * n); const a = (Math.max(0, y - r) * w + x) * 3, b = (Math.min(h - 1, y + r + 1) * w + x) * 3; ar += t[b] - t[a]; ag += t[b + 1] - t[a + 1]; ab += t[b + 2] - t[a + 2]; } }
  }
  for (let k = 0; k < d.length; k += 4) { const l = .3 * d[k] + .59 * d[k + 1] + .11 * d[k + 2]; d[k] = (d[k] * .7 + l * .3) * .82; d[k + 1] = (d[k + 1] * .7 + l * .3) * .82; d[k + 2] = (d[k + 2] * .7 + l * .3) * .82; }   // 降低彩度、稍暗一點
  return img;
}
function tvFit() {
  const TV_W = catalog.tv.w, TV_H = catalog.tv.h, vw = tvVideo.videoWidth, vh = tvVideo.videoHeight; if (!vw) return null; const ar = vw / vh;
  let fit = tvView.fit; if (fit === 'auto') fit = ar < 1 ? 'center35' : 'contain';
  let dw, dh;
  if (fit === 'cover') { if (ar > TV_W / TV_H) { dh = TV_H; dw = dh * ar; } else { dw = TV_W; dh = dw / ar; } }
  else if (fit === 'center35') { dw = TV_W * .6; dh = dw / ar; }
  else { if (ar > TV_W / TV_H) { dw = TV_W; dh = dw / ar; } else { dh = TV_H; dw = dh * ar; } }
  const k = tvView.scale / 100; dw *= k; dh *= k;
  return { dx: (TV_W - dw) / 2 + tvView.offX / 100 * TV_W / 2, dy: (TV_H - dh) / 2 - tvView.offY / 100 * TV_H / 2, dw, dh };
}
function drawTV() {
  const cv = tvCanvas(), g = cv.getContext('2d'), TV_W = cv.width, TV_H = cv.height;
  const f = tv && tvFit();
  if (!f || tvVideo.readyState < 2) {
    g.fillStyle = '#59544f'; g.fillRect(0, 0, TV_W, TV_H);
    g.fillStyle = 'rgba(251,246,236,.8)'; g.font = '34px "LXGW WenKai TC",serif'; g.textAlign = 'center';
    g.fillText(tv ? '影片載入中…' : '沒有影片（電視顯示「等待播放」）', TV_W / 2, TV_H / 2 + 12);
    return;
  }
  if (tvView.blur) {
    const vw = tvVideo.videoWidth, vh = tvVideo.videoHeight, tar = TV_W / TV_H; let sw = vw, sh = vh; if (vw / vh > tar) sw = vh * tar; else sh = vw / tar;
    tvSmallCtx.drawImage(tvVideo, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, BW_, BH_);
    try { tvSmallCtx.putImageData(softBlur(tvSmallCtx.getImageData(0, 0, BW_, BH_), 5), 0, 0); } catch {}
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(tvSmall, 0, 0, TV_W, TV_H);
  } else { g.fillStyle = '#1d1a17'; g.fillRect(0, 0, TV_W, TV_H); }
  g.drawImage(tvVideo, f.dx, f.dy, f.dw, f.dh);
  g.save(); g.globalCompositeOperation = 'saturation'; g.fillStyle = 'rgba(128,128,128,.22)'; g.fillRect(0, 0, TV_W, TV_H); g.restore();
  g.fillStyle = 'rgba(236,222,196,.16)'; g.fillRect(0, 0, TV_W, TV_H);
}
(function tvLoop() { if (started && catalog && !$('#tab-media').hidden) drawTV(); requestAnimationFrame(tvLoop); })();

function setTVSource(src, name) {
  if (src) {
    tv = { src, name: name || fileName(src), view: Object.assign({}, tvView), updatedAt: Date.now() };
    if (tvVideo.getAttribute('src') !== viewURL(src)) { tvVideo.src = viewURL(src); tvVideo.play().catch(() => {}); }
  } else {
    tv = null; tvVideo.pause(); tvVideo.removeAttribute('src'); tvVideo.load();
  }
  renderTVNow(); renderFiles(); markDirty();
}
function renderTVNow() {
  $('#tvNow').textContent = tv ? '目前選擇：' + (tv.name || fileName(tv.src)) + '（' + tv.src + '）' : '目前沒有影片，電視顯示「等待播放」。';
  const off = !tv;
  ['#tvFit', '#tvScale', '#tvX', '#tvY', '#tvBlur', '#tvReset'].forEach(s => $(s).disabled = off);
  fillTVPick();
}
function fillTVPick() {
  const vids = mediaFiles.filter(f => kindOfPath(f.path) === 'av').map(f => f.path);
  if (tv && !vids.includes(tv.src)) vids.unshift(tv.src);
  $('#tvPick').innerHTML = '<option value="">（不播放影片）</option>' + vids.map(p => `<option value="${esc(p)}">${esc(fileName(p))}</option>`).join('');
  $('#tvPick').value = tv ? tv.src : '';
}
function setupTV() {
  const sync = () => {
    $('#tvFit').value = tvView.fit; $('#tvScale').value = tvView.scale; $('#tvX').value = tvView.offX; $('#tvY').value = tvView.offY; $('#tvBlur').checked = !!tvView.blur;
    $('#tvScaleV').textContent = tvView.scale + '%'; $('#tvXV').textContent = tvView.offX; $('#tvYV').textContent = tvView.offY;
  };
  const live = () => {
    tvView = { fit: $('#tvFit').value, scale: +$('#tvScale').value, offX: +$('#tvX').value, offY: +$('#tvY').value, blur: $('#tvBlur').checked };
    sync(); markDirty();
  };
  ['#tvFit', '#tvBlur'].forEach(s => $(s).onchange = live);
  ['#tvScale', '#tvX', '#tvY'].forEach(s => $(s).oninput = live);
  $('#tvReset').onclick = () => { tvView = Object.assign({}, catalog.tv.def); sync(); markDirty(); };
  $('#tvPick').onchange = e => setTVSource(e.target.value, null);
  const ui = uploadUIFor('#tvStat', '#tvProg');
  $('#tvFile').onchange = async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    e.target.disabled = true;
    await pickAndUpload(f, 'tv', ui, true, async r => { setTVSource(r.path, f.name.slice(0, 120)); ui.say('已上傳並選取：' + fileName(r.path) + '。按上方「儲存並更新房間」後，訪客就會看到。'); });
    e.target.disabled = false; e.target.value = '';
  };
  sync();
  if (tv) { tvVideo.src = tv.src; tvVideo.play().catch(() => {}); }
  renderTVNow();
}

/* ======================= 平板音樂 ======================= */
function renderMusic() {
  const T = music.tracks, box = $('#musTracks');
  box.innerHTML = '';
  if (!T.length) box.innerHTML = '<div class="note">播放清單是空的。</div>';
  T.forEach((t, i) => {
    const r = document.createElement('div'); r.className = 'item';
    const cov = document.createElement('img'); cov.className = 'cov'; cov.alt = '';
    if (t.kind !== 'video' && t.cover) cov.src = viewURL(t.cover); else cov.style.visibility = t.kind === 'video' ? 'hidden' : 'visible';
    const g = document.createElement('div'); g.className = 'grow';
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 80; name.value = t.name || ''; name.placeholder = '顯示名稱'; name.setAttribute('aria-label', '第 ' + (i + 1) + ' 首的顯示名稱');
    name.oninput = () => { t.name = name.value.trim(); markDirty(); };
    const meta = document.createElement('div'); meta.className = 'note'; meta.textContent = (t.kind === 'video' ? '影片・' : '歌曲・') + t.src;
    g.append(name, meta);
    const btn = (label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = fn; return b; };
    const up = btn('↑', () => { [T[i - 1], T[i]] = [T[i], T[i - 1]]; renderMusic(); markDirty(); }); up.disabled = i === 0; up.setAttribute('aria-label', '往上移');
    const dn = btn('↓', () => { [T[i + 1], T[i]] = [T[i], T[i + 1]]; renderMusic(); markDirty(); }); dn.disabled = i === T.length - 1; dn.setAttribute('aria-label', '往下移');
    r.append(cov, g, up, dn);
    if (t.kind !== 'video') {
      const ci = document.createElement('input'); ci.type = 'file'; ci.accept = 'image/png,image/jpeg,image/webp'; ci.hidden = true;
      const cb = btn(t.cover ? '換封面' : '上傳封面', () => ci.click());
      ci.onchange = async () => {
        const f = ci.files && ci.files[0]; if (!f) return; cb.disabled = true;
        const ui = uploadUIFor('#musStat', '#musProg');
        try {
          const jb = await coverToJpeg(f);
          const path = `media/covers/${slug(t.name || fileName(t.src)) || 'cover'}-${stamp()}.jpg`;
          await uploadMedia(jb, path, ui);
          t.cover = path; ui.say('封面已上傳：' + (t.name || fileName(t.src)) + '。記得按「儲存並更新房間」。'); renderMusic(); renderFiles(); markDirty();
        } catch (e) { ui.progress(null); ui.say(e.code === 'cover_failed' ? '這張圖片讀不了，請換一張 JPG 或 PNG。' : '封面上傳沒有成功：' + explain(e), true); cb.disabled = false; }
      };
      r.append(cb, ci);
      if (t.cover) r.append(btn('移除封面', () => { delete t.cover; renderMusic(); renderFiles(); markDirty(); }));
    }
    const rm = btn('從清單移除', () => {
      if (!rm.dataset.armed) { rm.dataset.armed = 1; rm.textContent = '再按一次確認'; return; }
      T.splice(i, 1); renderMusic(); renderFiles(); markDirty();
    }, 'danger');
    r.append(rm);
    box.appendChild(r);
  });

  const L = music.links, lb = $('#musLinks');
  lb.innerHTML = L.length ? '' : '<div class="note">還沒有連結。</div>';
  L.forEach((l, i) => {
    const r = document.createElement('div'); r.className = 'item';
    const n = document.createElement('div'); n.className = 'grow'; n.textContent = (l.title || '未命名') + '・' + (/spotify/i.test(l.url) ? 'Spotify' : 'YouTube');
    const u = document.createElement('div'); u.className = 'note'; u.textContent = l.url; n.appendChild(u);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small danger'; b.textContent = '移除';
    b.onclick = () => { L.splice(i, 1); renderMusic(); markDirty(); };
    r.append(n, b); lb.appendChild(r);
  });
  fillMusPick();
}
function fillMusPick() {
  const used = new Set(music.tracks.map(t => t.src));
  const opts = mediaFiles.filter(f => ['audio', 'av'].includes(kindOfPath(f.path)) && !used.has(f.path));
  $('#musPick').innerHTML = opts.length ? '<option value="">從 media/ 選一個檔案…</option>' + opts.map(f => `<option value="${esc(f.path)}">${esc(fileName(f.path))}</option>`).join('')
    : '<option value="">（media/ 裡沒有其他可加入的檔案）</option>';
  $('#musAdd').disabled = !opts.length;
}
async function addTrack(src, name, ui) {
  ui.say('確認檔案類型…');
  const kind = kindOfPath(src) === 'audio' ? 'audio' : (await probeKind(viewURL(src))) || 'audio';
  music.tracks.push({ src, kind, name: name || fileName(src).replace(/\.[^.]+$/, '') });
  renderMusic(); renderFiles(); markDirty();
  ui.say('已加入：' + (name || fileName(src)) + (kind === 'video' ? '（影片）' : '（歌曲）') + '。記得按「儲存並更新房間」。');
}
(function setupMusic() {
  const ui = uploadUIFor('#musStat', '#musProg');
  $('#musAdd').onclick = () => { const p = $('#musPick').value; if (p) addTrack(p, null, ui); };
  $('#musFile').onchange = async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    e.target.disabled = true;
    await pickAndUpload(f, 'music', ui, true, r => addTrack(r.path, r.name, ui));
    e.target.disabled = false; e.target.value = '';
  };
  $('#musLAdd').onclick = () => {
    const title = $('#musLT').value.trim().slice(0, 60), url = $('#musLU').value.trim();
    if (!SAFE_LINK.test(url)) { ui.say('請貼上 YouTube（youtube.com、youtu.be）或 Spotify（open.spotify.com）的完整網址。', true); return; }
    music.links.push({ title: title || '未命名', url }); $('#musLT').value = ''; $('#musLU').value = '';
    renderMusic(); markDirty(); ui.say('連結已加入。記得按「儲存並更新房間」。');
  };
})();

/* ======================= media/ 檔案清單 ======================= */
// 「使用中」以網站目前的內容和畫面上尚未儲存的選擇一起判斷，避免刪掉還要用的檔案
function refsOf(c) {
  const s = new Set();
  if (c.tv && c.tv.src) s.add(c.tv.src);
  ((c.music && c.music.tracks) || []).forEach(t => { if (t.src) s.add(t.src); if (t.cover) s.add(t.cover); });
  return s;
}
function currentRefs() { return refsOf({ tv, music }); }
async function refreshFiles() {
  const st = $('#filesStat'); st.textContent = '讀取中…'; st.classList.remove('err');
  try {
    const r = await api('/api/media');
    mediaFiles = (r.files || []).filter(f => /^media\//.test(f.path));
    st.textContent = `共 ${mediaFiles.length} 個檔案`;
  } catch (e) { st.textContent = '讀不到檔案清單：' + explain(e); st.classList.add('err'); }
  renderFiles(); fillTVPick(); fillMusPick();
}
function renderFiles() {
  const cur = currentRefs(), body = $('#filesBody');
  if (!mediaFiles.length) { body.innerHTML = '<tr><td colspan="4" class="note">沒有檔案。</td></tr>'; return; }
  body.innerHTML = '';
  mediaFiles.slice().sort((a, b) => a.path.localeCompare(b.path)).forEach(f => {
    const tr = document.createElement('tr');
    const inSaved = savedRefs.has(f.path), inCur = cur.has(f.path);
    const tag = inCur && inSaved ? '<span class="tag ok">使用中</span>' : inCur ? '<span class="tag warn">已選取，尚未儲存</span>' : inSaved ? '<span class="tag warn">網站仍在使用，儲存後才能刪除</span>' : '<span class="tag">未使用</span>';
    tr.innerHTML = `<td><a href="${esc(f.path)}" target="_blank" rel="noopener">${esc(f.path.replace(/^media\//, ''))}</a></td><td>${f.size ? fmtMB(f.size) : ''}</td><td>${tag}</td><td></td>`;
    if (!inSaved && !inCur) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small danger'; b.textContent = '刪除';
      b.onclick = async () => {
        if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = '再按一次確認刪除'; return; }
        b.disabled = true; b.textContent = '刪除中…';
        try {
          await api('/api/media?path=' + encodeURIComponent(f.path), { method: 'DELETE' });
          mediaFiles = mediaFiles.filter(x => x.path !== f.path); renderFiles(); fillTVPick(); fillMusPick(); toast('已刪除 ' + f.path);
        } catch (e) { b.disabled = false; b.textContent = '刪除'; delete b.dataset.armed; toast('刪除沒有成功：' + explain(e)); }
      };
      tr.lastElementChild.appendChild(b);
    }
    body.appendChild(tr);
  });
}
$('#filesRefresh').onclick = refreshFiles;
{ const u = githubUploadURL(), a = $('#ghUpload'); if (u) a.href = u; else { a.removeAttribute('href'); a.textContent = 'GitHub 上的 media 資料夾上傳頁面（請先在 config.js 填入 githubRepo）'; } }

/* ======================= 儲存 ======================= */
let deployWatch = 0;
$('#save').onclick = async () => {
  if (!started || !catalog) return;
  const c = buildContent(), secs = changedSections(c);
  if (!secs.length) { status('沒有需要儲存的修改'); return; }
  const btn = $('#save'); btn.disabled = true;
  status('儲存中…');
  try {
    const r = await api('/api/content', { method: 'PUT', json: { content: c, sha: contentSha, sections: secs.map(k => SECTION_NAMES[k]) } });
    contentSha = r.sha || contentSha;
    baseline = sectionsOf(c); savedRefs = refsOf(c); dirtyNote = false;
    renderFiles();
    $('#stat').innerHTML = '已送出，網站約 1 分鐘後更新' + (r.commitUrl ? `（<a href="${esc(r.commitUrl)}" target="_blank" rel="noopener">查看這次的修改紀錄</a>）` : '');
    $('#stat').className = 'ok';
    watchDeploy(c.savedAt);
  } catch (e) {
    status('儲存沒有成功：' + explain(e), 'err');
  } finally { btn.disabled = false; }
};
// 定時讀網站上的 content.json，看到這次儲存的內容就告訴房主「網站已更新」
function watchDeploy(savedAt) {
  const my = ++deployWatch, t0 = Date.now();
  const tick = async () => {
    if (my !== deployWatch) return;
    try {
      const c = await (await fetch('content.json?v=' + Date.now(), { cache: 'no-store' })).json();
      if (c && c.savedAt === savedAt) { if (!dirtyNote) status('網站已更新，訪客現在看到的是新的內容', 'ok'); toast('網站已更新'); return; }
    } catch {}
    if (Date.now() - t0 < 5 * 60_000) setTimeout(tick, 15_000);
    else if (!dirtyNote) status('已送出，但網站還沒更新完成。可以稍後打開房間確認；若超過 10 分鐘仍未更新，請到 GitHub 的 Actions 頁面查看。');
  };
  setTimeout(tick, 20_000);
}

/* ======================= 留言管理 ======================= */
let comments = [], blocks = [], cFilter = 'pending';
document.querySelectorAll('[data-cf]').forEach(b => b.onclick = () => {
  cFilter = b.dataset.cf; document.querySelectorAll('[data-cf]').forEach(x => x.setAttribute('aria-pressed', x === b)); renderComments();
});
$('#cmRefresh').onclick = () => loadComments();
async function loadComments() {
  const st = $('#cmStat'); st.textContent = '讀取中…'; st.classList.remove('err');
  try {
    const [c, b] = await Promise.all([api('/api/admin/comments'), api('/api/admin/blocks')]);
    comments = c.comments || []; blocks = b.blocks || [];
    st.dataset.ok = '1';
  } catch (e) {
    comments = []; blocks = []; delete st.dataset.ok;
    st.textContent = e.status === 404 ? '留言服務還沒設定好（Worker 的留言功能完成後就能使用）。' : '讀不到留言：' + explain(e);
    st.classList.add('err');
  }
  renderComments();
}
const fmtTime = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }); };
function renderComments() {
  const st = $('#cmStat');
  if (st.dataset.ok) st.textContent = `共 ${comments.length} 則，待審核 ${comments.filter(x => !x.public && !x.whisper).length} 則，悄悄話 ${comments.filter(x => x.whisper).length} 則`;
  const blocked = new Set(blocks.map(b => b.author));
  const list = comments.filter(c => cFilter === 'all' || (cFilter === 'whisper' ? c.whisper : cFilter === 'public' ? (c.public && !c.whisper) : (!c.public && !c.whisper)));
  const box = $('#cmList');
  box.innerHTML = list.length ? '' : `<div class="note">${cFilter === 'pending' ? '沒有待審核的留言。' : cFilter === 'whisper' ? '沒有悄悄話。' : '沒有留言。'}</div>`;
  list.forEach(c => {
    const d = document.createElement('div'); d.className = 'cm' + (c.public || c.whisper ? '' : ' pending');
    const isG = c.method === 'google';
    d.innerHTML = `<div class="meta"><span>${esc(fmtTime(c.createdAt))}</span><b>${esc(c.nickname || '匿名')}</b>
      <span class="tag">${isG ? 'Google 登入' : '匿名'}</span>${c.whisper ? '<span class="tag">悄悄話・只有你看得到</span>' : c.public ? '<span class="tag ok">已公開</span>' : c.editedAt ? '<span class="tag warn">已編輯，等待審核</span>' : '<span class="tag warn">未公開</span>'}${c.editedAt ? `<span class="tag">編輯於 ${esc(fmtTime(c.editedAt))}</span>` : ''}
      ${isG && blocked.has(c.author) ? '<span class="tag warn">此帳號已封鎖</span>' : ''}</div>
      <div class="txt"></div><div class="row"></div>`;
    d.querySelector('.txt').textContent = c.content || '';
    const row = d.querySelector('.row');
    const btn = (label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = () => fn(b); row.appendChild(b); return b; };
    if (!c.whisper) btn(c.public ? '取消公開' : '公開', async b => {
      b.disabled = true;
      try { await api('/api/admin/comments/' + encodeURIComponent(c.id), { method: 'PATCH', json: { public: !c.public } }); c.public = !c.public; renderComments(); toast(c.public ? '留言已公開' : '留言已取消公開'); }
      catch (e) { b.disabled = false; toast('沒有成功：' + explain(e)); }
    }, c.public ? '' : 'primary');
    btn('刪除', async b => {
      if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = '再按一次確認刪除'; return; }
      b.disabled = true;
      try { await api('/api/admin/comments/' + encodeURIComponent(c.id), { method: 'DELETE' }); comments = comments.filter(x => x.id !== c.id); renderComments(); toast('留言已刪除'); }
      catch (e) { b.disabled = false; toast('刪除沒有成功：' + explain(e)); }
    }, 'danger');
    if (isG && c.author && !blocked.has(c.author)) {
      btn('封鎖這個 Google 帳號', async b => {
        if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = '再按一次確認封鎖'; return; }
        b.disabled = true;
        try {
          await api('/api/admin/blocks/' + encodeURIComponent(c.author), { method: 'PUT', json: { note: (c.nickname || '') + '：' + String(c.content || '').slice(0, 40) } });
          blocks.push({ author: c.author, note: c.nickname, createdAt: new Date().toISOString() }); renderComments(); toast('已封鎖這個帳號');
        } catch (e) { b.disabled = false; toast('封鎖沒有成功：' + explain(e)); }
      }, 'danger');
    }
    box.appendChild(d);
  });
  const bl = $('#blockList');
  bl.innerHTML = blocks.length ? '' : '<div class="note">沒有封鎖任何帳號。</div>';
  blocks.forEach(b => {
    const r = document.createElement('div'); r.className = 'item';
    const n = document.createElement('div'); n.className = 'grow';
    n.innerHTML = `<div>${esc(b.note || '（沒有備註）')}</div><div class="note">代號 ${esc(String(b.author).slice(0, 12))}…・封鎖於 ${esc(fmtTime(b.createdAt))}</div>`;
    const u = document.createElement('button'); u.type = 'button'; u.className = 'btn small'; u.textContent = '解除封鎖';
    u.onclick = async () => {
      u.disabled = true;
      try { await api('/api/admin/blocks/' + encodeURIComponent(b.author), { method: 'DELETE' }); blocks = blocks.filter(x => x.author !== b.author); renderComments(); toast('已解除封鎖'); }
      catch (e) { u.disabled = false; toast('沒有成功：' + explain(e)); }
    };
    r.append(n, u); bl.appendChild(r);
  });
}

/* ======================= 開始 ======================= */
$('#logout').onclick = () => { signOut(false); };
try { const t = sessionStorage.getItem(TOKEN_KEY); if (tokenValid(t)) token = t; } catch {}
initGoogle();
if (token) {
  api('/api/me').then(me => { $('#login').hidden = true; $('#who').textContent = me.email || ''; start(); })
    .catch(e => { token = null; if (e.code !== 'expired') $('#loginMsg').textContent = e.code === 'not_owner' ? '這個 Google 帳號不是房主。' : '無法確認身分：' + explain(e); });
}
})();
