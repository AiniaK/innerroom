// Worker 自動測試：用假的 GitHub、Notion、Google 和 KV，在 Node.js 裡直接呼叫 Worker。
// 執行：npm test（需要 Node.js 22 以上，不需要網路，也不會碰到真的帳號）
import assert from 'node:assert/strict';

/* ---------- Workers 才有的東西 ---------- */
globalThis.FixedLengthStream = class extends TransformStream { constructor() { super(); } };

/* ---------- 假的 Google：自己產生金鑰簽 ID token ---------- */
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = buf => Buffer.from(buf).toString('base64url');
async function idToken(claims = {}, { kid = 'k1', tamper = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1001', email: 'owner@gmail.com', email_verified: true, iat: now, exp: now + 3600, ...claims }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p)));
  if (tamper) sig[0] ^= 1;
  return `${h}.${p}.${b64u(sig)}`;
}

/* ---------- 假的 GitHub repo ---------- */
let gid = 0; const sha = () => 'sha' + (++gid).toString(16).padStart(6, '0');
const gh = { files: new Map(), head: null, commits: new Map(), blobs: new Map(), log: [] };
function ghCommit(message) { const c = sha(); gh.commits.set(c, { message, files: new Map(gh.files) }); gh.head = c; gh.log.push(message); return c; }
gh.files.set('content.json', { sha: sha(), text: JSON.stringify({ texts: { items: {}, fire: 46 }, exhibits: { items: {} }, tv: { src: 'media/tv-adventure.mp4', name: 'adventure.mp4' }, music: { tracks: [], links: [] }, savedAt: 1 }) });
gh.files.set('media/tv-adventure.mp4', { sha: sha(), text: 'VIDEO', size: 5 });
gh.files.set('media/old-unused.mp4', { sha: sha(), text: 'OLD', size: 3 });
ghCommit('init');

async function githubFetch(url, init) {
  const u = new URL(url), p = u.pathname.replace(/^\/repos\/me\/innerroom/, ''), m = init.method || 'GET';
  assert.equal(init.headers.Authorization, 'Bearer gh-token');
  const J = (s, o) => new Response(JSON.stringify(o), { status: s });
  if (p === '/contents/content.json' && m === 'GET') { const f = gh.files.get('content.json'); return J(200, { sha: f.sha, content: Buffer.from(f.text).toString('base64') }); }
  if (p === '/contents/content.json' && m === 'PUT') {
    const b = JSON.parse(init.body);
    if (b.sha !== gh.files.get('content.json').sha) return J(409, { message: 'does not match' });
    gh.files.set('content.json', { sha: sha(), text: Buffer.from(b.content, 'base64').toString() });
    const c = ghCommit(b.message);
    return J(200, { content: { sha: gh.files.get('content.json').sha }, commit: { html_url: 'https://github.com/me/innerroom/commit/' + c } });
  }
  if (p.startsWith('/git/trees/main') && m === 'GET') return J(200, { tree: [...gh.files].map(([path, f]) => ({ path, type: 'blob', size: f.size || f.text.length })) });
  if (p === '/git/blobs' && m === 'POST') {
    const text = await new Response(init.body).text();   // 串流進來的內容
    const b = JSON.parse(text); assert.equal(b.encoding, 'base64');
    const s = sha(); gh.blobs.set(s, Buffer.from(b.content, 'base64')); return J(201, { sha: s });
  }
  if (p === '/git/ref/heads/main') return J(200, { object: { sha: gh.head } });
  if (p.startsWith('/git/commits/') && m === 'GET') return J(200, { tree: { sha: 'tree-' + p.split('/').pop() } });
  if (p === '/git/trees' && m === 'POST') {
    const b = JSON.parse(init.body); const files = new Map(gh.files);
    for (const e of b.tree) {
      if (e.sha === null) { if (!files.has(e.path)) return J(422, { message: 'path not found' }); files.delete(e.path); }
      else { const buf = gh.blobs.get(e.sha); files.set(e.path, { sha: e.sha, text: buf.toString('latin1'), size: buf.length, bytes: buf }); }
    }
    const t = sha(); gh.pendingTree = { t, files }; return J(201, { sha: t });
  }
  if (p === '/git/commits' && m === 'POST') { const b = JSON.parse(init.body); const c = sha(); gh.pendingCommit = { c, message: b.message, files: gh.pendingTree.files }; return J(201, { sha: c, html_url: 'https://github.com/me/innerroom/commit/' + c }); }
  if (p === '/git/refs/heads/main' && m === 'PATCH') { gh.files = gh.pendingCommit.files; gh.head = gh.pendingCommit.c; gh.log.push(gh.pendingCommit.message); return J(200, {}); }
  return J(404, { message: 'not mocked ' + m + ' ' + p });
}

/* ---------- 假的 Notion ---------- */
const notion = { pages: new Map(), n: 0 };
async function notionFetch(url, init) {
  const u = new URL(url), p = u.pathname.replace('/v1', ''), m = init.method || 'GET';
  assert.equal(init.headers['Notion-Version'], '2025-09-03');
  const J = (s, o) => new Response(JSON.stringify(o), { status: s });
  if (p === '/databases/db123') return J(200, { data_sources: [{ id: 'ds-1', name: '留言' }] });
  if (p === '/data_sources/ds-1/query' && m === 'POST') {
    const b = JSON.parse(init.body);
    let list = [...notion.pages.values()].filter(x => !x.in_trash);
    const fs = b.filter ? (b.filter.and || [b.filter]) : [];
    for (const f of fs) {
      if (f.checkbox) list = list.filter(x => !!(x.properties[f.property] || {}).checkbox === f.checkbox.equals);
      if (f.rich_text) list = list.filter(x => ((x.properties['留言者 Google ID'].rich_text[0] || {}).text || {}).content === f.rich_text.equals);
    }
    list.sort((a, z) => z.properties['時間'].date.start.localeCompare(a.properties['時間'].date.start));
    return J(200, { results: list.slice(0, b.page_size), has_more: false });
  }
  if (p === '/pages' && m === 'POST') {
    const b = JSON.parse(init.body); assert.equal(b.parent.data_source_id, 'ds-1');
    const id = `0000000${++notion.n}-0000-0000-0000-000000000000`.slice(-36);
    const page = { id, created_time: new Date().toISOString(), properties: JSON.parse(JSON.stringify(b.properties)) };
    for (const [k, v] of Object.entries(page.properties)) { (v.title || v.rich_text || []).forEach(t => t.plain_text = t.text.content); }
    notion.pages.set(id, page); return J(200, page);
  }
  const pm = /^\/pages\/(.+)$/.exec(p);
  if (pm && m === 'GET') { const page = notion.pages.get(pm[1]); return page ? J(200, page) : J(404, { code: 'object_not_found' }); }
  if (pm && m === 'PATCH') {
    const page = notion.pages.get(pm[1]); if (!page) return J(404, { code: 'object_not_found' });
    const b = JSON.parse(init.body); if (b.in_trash) page.in_trash = true;
    if (b.properties) { for (const v of Object.values(b.properties)) (v.title || v.rich_text || []).forEach(t => t.plain_text = t.text.content); Object.assign(page.properties, b.properties); }
    return J(200, page);
  }
  return J(404, { message: 'not mocked ' + p });
}

globalThis.fetch = async (url, init = {}) => {
  const s = String(url);
  if (s.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return new Response(JSON.stringify({ keys: [pubJwk] }), { headers: { 'cache-control': 'public, max-age=20000' } });
  if (s.startsWith('https://api.github.com/')) return githubFetch(s, init);
  if (s.startsWith('https://api.notion.com/')) return notionFetch(s, init);
  throw new Error('unexpected fetch ' + s);
};

/* ---------- 假的 KV ---------- */
const kvStore = new Map(); let kvWrites = 0;
const KV = {
  async get(k, type) { const v = kvStore.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { kvWrites++; kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
};

const env = {
  GITHUB_REPO: 'me/innerroom', GITHUB_BRANCH: 'main', GITHUB_TOKEN: 'gh-token', GOOGLE_CLIENT_ID: CLIENT_ID,
  OWNER_EMAILS: 'Owner@gmail.com', NOTION_TOKEN: 'nt', NOTION_DATABASE_ID: 'db123', NOTION_VERSION: '2025-09-03',
  HASH_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://me.github.io,http://localhost:8000', KV,
};
const { default: worker } = await import('../src/index.js');
const ORIGIN = 'https://me.github.io';
async function call(method, path, { token, body, raw, headers = {}, origin = ORIGIN, ip = '1.2.3.4' } = {}) {
  const h = { ...headers, 'CF-Connecting-IP': ip };
  if (origin) h.Origin = origin;
  if (token) h.Authorization = 'Bearer ' + token;
  let b;
  if (body !== undefined) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; h['Content-Length'] = String(Buffer.byteLength(b)); }
  if (raw !== undefined) b = raw;
  const waits = [];
  const res = await worker.fetch(new Request('https://api.example' + path, { method, headers: h, body: b, duplex: 'half' }), env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

/* ---------- 測試 ---------- */
let passed = 0; const results = [];
async function test(name, fn) { try { await fn(); passed++; results.push('✓ ' + name); } catch (e) { results.push('✗ ' + name + '\n    ' + (e && e.stack || e)); } }

const owner = await idToken();
const visitor = await idToken({ sub: '2002', email: 'visitor@gmail.com' });

await test('health：不需要 Origin，只回報有沒有設定', async () => {
  const r = await call('GET', '/api/health', { origin: null });
  assert.equal(r.status, 200); assert.equal(r.data.configured.GITHUB_TOKEN, true);
  assert.ok(!JSON.stringify(r.data).includes('gh-token'));
});
await test('CORS：不允許的網域被擋，允許的網域有正確標頭', async () => {
  assert.equal((await call('GET', '/api/comments', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/comments', { origin: null })).status, 403);
  const pre = await worker.fetch(new Request('https://api.example/api/content', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, {});
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const bad = await worker.fetch(new Request('https://api.example/api/content', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env, {});
  assert.equal(bad.status, 403); assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});
await test('房主驗證：沒有 token、非房主、過期、aud 不對、簽章被改都會被擋', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: visitor })).status, 403);
  assert.equal((await call('GET', '/api/me', { token: await idToken({ exp: Math.floor(Date.now() / 1000) - 120 }) })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: await idToken({ aud: 'other' }) })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: await idToken({}, { tamper: true }) })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: await idToken({ email_verified: false }) })).status, 403);
  const ok = await call('GET', '/api/me', { token: owner });
  assert.equal(ok.status, 200); assert.equal(ok.data.email, 'owner@gmail.com');
});
await test('內容：讀取、儲存並產生 commit 訊息、sha 過期時回報衝突', async () => {
  const g = await call('GET', '/api/content', { token: owner });
  assert.equal(g.status, 200); assert.equal(g.data.content.texts.fire, 46);
  const c = { ...g.data.content, texts: { items: { tv: { t: '我的電視' } }, fire: 70 } };
  const p = await call('PUT', '/api/content', { token: owner, body: { content: c, sha: g.data.sha, sections: ['物件說明', '房間設定', '<惡意>'] } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(gh.log.at(-1), '後台更新：物件說明、房間設定');
  assert.equal(JSON.parse(gh.files.get('content.json').text).texts.fire, 70);
  const stale = await call('PUT', '/api/content', { token: owner, body: { content: c, sha: g.data.sha, sections: ['物件說明'] } });
  assert.equal(stale.status, 409); assert.equal(stale.data.error, 'conflict');
});
await test('內容檢查：拒絕危險的網址和不合理的值', async () => {
  const { data } = await call('GET', '/api/content', { token: owner });
  const bad = [
    { ...data.content, tv: { src: 'javascript:alert(1)' } },
    { ...data.content, tv: { src: 'media/../index.html' } },
    { ...data.content, music: { tracks: [], links: [{ title: 'x', url: 'https://evil.example/' }] } },
    { ...data.content, texts: { items: {}, fire: 900 } },
    { ...data.content, texts: { items: { a: { t: 'x'.repeat(500) } }, fire: 1 } },
  ];
  for (const c of bad) { const r = await call('PUT', '/api/content', { token: owner, body: { content: c, sha: data.sha } }); assert.equal(r.status, 400, JSON.stringify(c).slice(0, 80)); }
  const okRef = { ...data.content, tv: { src: 'media/中文 檔名.mp4', name: 'x' } };
  assert.equal((await call('PUT', '/api/content', { token: owner, body: { content: okRef, sha: data.sha } })).status, 200);
  const back = await call('GET', '/api/content', { token: owner });
  await call('PUT', '/api/content', { token: owner, body: { content: { ...back.data.content, tv: { src: 'media/tv-adventure.mp4', name: 'adventure.mp4' } }, sha: back.data.sha } });
});
await test('展品：後台新增的照片／影片展品可以儲存，檔案受保護不能刪', async () => {
  const { data } = await call('GET', '/api/content', { token: owner });
  const withEx = items => ({ ...data.content, exhibits: { items } });
  const good = { custom: true, img: 'media/ex-sea-20261109-120000.jpg', video: 'media/ex-sea-20261109-120000.mp4', W: .7, H: .39, kind: '影像', title: '海', mode: 'hang', along: 0, height: 1.5, extra: 'x' };
  for (const bad of [{ ...good, img: 'javascript:1' }, { ...good, img: 'media/a.mp4' }, { ...good, video: 'media/a.jpg' }, { ...good, W: 9 }, { custom: true, title: '沒有圖' }]) {
    assert.equal((await call('PUT', '/api/content', { token: owner, body: { content: withEx({ ex1: bad }), sha: data.sha } })).status, 400, JSON.stringify(bad));
  }
  const r = await call('PUT', '/api/content', { token: owner, body: { content: withEx({ ex1: good, cougar: { title: '美洲獅', img: 'media/x.jpg' } }), sha: data.sha, sections: ['展品'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const back = await call('GET', '/api/content', { token: owner });
  const e = back.data.content.exhibits.items;
  assert.equal(e.ex1.img, good.img); assert.equal(e.ex1.video, good.video); assert.equal(e.ex1.W, .7); assert.equal(e.ex1.extra, undefined);
  assert.equal(e.cougar.img, undefined);   // 原本就有的展品不能被換圖
  const del = await call('DELETE', '/api/media?path=' + encodeURIComponent(good.img), { token: owner });
  assert.equal(del.status, 409); assert.equal(del.data.error, 'in_use');
  await call('PUT', '/api/content', { token: owner, body: { content: { ...back.data.content, exhibits: { items: {} } }, sha: back.data.sha } });
});
await test('上傳：串流轉交給 GitHub、內容不變、檔名和大小有限制', async () => {
  const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
  const raw = JSON.stringify({ encoding: 'base64', content: bytes.toString('base64') });
  const r = await call('PUT', '/api/media?path=media/music-test-20261105-120000.mp4', { token: owner, raw, headers: { 'Content-Type': 'application/json', 'Content-Length': String(raw.length) } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(gh.files.get('media/music-test-20261105-120000.mp4').bytes.equals(bytes));
  assert.equal(gh.log.at(-1), '後台上傳：media/music-test-20261105-120000.mp4');
  for (const p of ['index.html', 'media/../index.html', 'media/a.html', 'media/Upper.mp4', 'media/x/y.mp4']) {
    assert.equal((await call('PUT', '/api/media?path=' + encodeURIComponent(p), { token: owner, raw, headers: { 'Content-Type': 'application/json', 'Content-Length': String(raw.length) } })).status, 400, p);
  }
  const big = await call('PUT', '/api/media?path=media/big.mp4', { token: owner, raw: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': String(40 * 1048576) } });
  assert.equal(big.status, 413);
  const list = await call('GET', '/api/media', { token: owner });
  assert.ok(list.data.files.some(f => f.path === 'media/music-test-20261105-120000.mp4'));
  assert.ok(!list.data.files.some(f => f.path === 'content.json'));
});
await test('刪除檔案：使用中的不能刪，未使用的可以刪', async () => {
  assert.equal((await call('DELETE', '/api/media?path=media/tv-adventure.mp4', { token: owner })).status, 409);
  const r = await call('DELETE', '/api/media?path=media/old-unused.mp4', { token: owner });
  assert.equal(r.status, 200); assert.ok(!gh.files.has('media/old-unused.mp4'));
  assert.equal(gh.log.at(-1), '後台刪除：media/old-unused.mp4');
  assert.equal((await call('DELETE', '/api/media?path=media/old-unused.mp4', { token: owner })).status, 404);
});

let googleId, otherId;
const other = await idToken({ sub: '3003', email: 'other@gmail.com' });
await test('沒有登入不能留言', async () => {
  const r = await call('POST', '/api/comments', { body: { nickname: '路人', content: '你好', elapsed: 9000 }, ip: '5.5.5.5' });
  assert.equal(r.status, 401); assert.equal(r.data.error, 'login_required');
  assert.equal(notion.pages.size, 0);
});
await test('登入留言：立即公開、只存雜湊代號、不公開 Google 名字、內容原樣存成純文字', async () => {
  const r = await call('POST', '/api/comments', { body: { nickname: ' 小樹 ', content: '<script>alert(1)</script>\n\n\n\n謝謝你的房間', credential: visitor, elapsed: 9000 }, ip: '6.6.6.6' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.public, true); assert.equal(r.data.comment.status, 'public');
  const page = notion.pages.get(r.data.comment.id); googleId = page.id;
  assert.equal(page.properties['暱稱'].title[0].text.content, '小樹');
  assert.equal(page.properties['內容'].rich_text[0].text.content, '<script>alert(1)</script>\n\n謝謝你的房間');
  assert.equal(page.properties['登入方式'].select.name, 'Google 登入');
  const author = page.properties['留言者 Google ID'].rich_text[0].text.content;
  assert.match(author, /^[0-9a-f]{32}$/); assert.ok(!JSON.stringify(page).includes('visitor@gmail.com')); assert.ok(!JSON.stringify(page).includes('2002'));
  const pub = await call('GET', '/api/comments');
  assert.deepEqual(pub.data.comments.map(c => c.nickname), ['小樹']);
  assert.equal(pub.data.comments[0].author, undefined);
  const o = await call('POST', '/api/comments', { body: { nickname: '別人', content: '我也來了', credential: other, elapsed: 9000 }, ip: '6.6.6.9' });
  otherId = o.data.comment.id;
});
await test('留言檢查：太長、空白、太多連結、太快送出、隱藏欄位、偽造登入', async () => {
  const t = { credential: visitor, elapsed: 9000 };
  assert.equal((await call('POST', '/api/comments', { body: { ...t, content: 'x'.repeat(501) }, ip: '7.7.7.1' })).status, 400);
  assert.equal((await call('POST', '/api/comments', { body: { ...t, content: '   ' }, ip: '7.7.7.2' })).status, 400);
  assert.equal((await call('POST', '/api/comments', { body: { ...t, nickname: 'n'.repeat(21), content: 'hi' }, ip: '7.7.7.3' })).status, 400);
  assert.equal((await call('POST', '/api/comments', { body: { ...t, content: 'http://a.com http://b.com http://c.com http://d.com' }, ip: '7.7.7.4' })).status, 400);
  assert.equal((await call('POST', '/api/comments', { body: { ...t, content: 'hi', elapsed: 500 }, ip: '7.7.7.5' })).status, 400);
  const before = notion.pages.size;
  const hp = await call('POST', '/api/comments', { body: { content: 'buy now', website: 'http://spam', elapsed: 9000 }, ip: '7.7.7.6' });
  assert.equal(hp.status, 200); assert.equal(notion.pages.size, before);
  assert.equal((await call('POST', '/api/comments', { body: { content: 'hi', credential: await idToken({}, { tamper: true }), elapsed: 9000 }, ip: '7.7.7.7' })).status, 401);
});
await test('頻率限制：同一個 IP 10 分鐘內第 4 則被擋', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/comments', { body: { content: '第 ' + i + ' 則', credential: await idToken({ sub: 'rl' + i }), elapsed: 9000 }, ip: '9.9.9.9' })).status, 201);
  const r = await call('POST', '/api/comments', { body: { content: '第 4 則', credential: await idToken({ sub: 'rl9' }), elapsed: 9000 }, ip: '9.9.9.9' });
  assert.equal(r.status, 429); assert.equal(r.data.error, 'rate_limited');
});
await test('自己的留言：列出、別人看不到我的', async () => {
  assert.equal((await call('POST', '/api/comments/mine', { body: {} })).status, 401);
  const mine = await call('POST', '/api/comments/mine', { body: { credential: visitor } });
  assert.equal(mine.status, 200); assert.deepEqual(mine.data.comments.map(c => c.id), [googleId]);
  assert.equal(mine.data.comments[0].editable, true);
  const theirs = await call('POST', '/api/comments/mine', { body: { credential: other } });
  assert.deepEqual(theirs.data.comments.map(c => c.id), [otherId]);
});
await test('編輯：只能改自己的，改完從房間移除並標示審核中，房主審核後重新公開', async () => {
  assert.equal((await call('PATCH', '/api/comments/' + otherId, { body: { credential: visitor, content: '亂改別人的' } })).status, 403);
  assert.equal((await call('PATCH', '/api/comments/' + googleId, { body: { content: '沒登入' } })).status, 401);
  const r = await call('PATCH', '/api/comments/' + googleId, { body: { credential: visitor, content: '謝謝你的房間（修改過）' } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.comment.status, 'reviewing'); assert.ok(r.data.comment.editedAt);
  const page = notion.pages.get(googleId);
  assert.equal(page.properties['公開'].checkbox, false); assert.ok(page.properties['編輯時間'].date.start);
  let pub = await call('GET', '/api/comments'); assert.ok(!pub.data.comments.some(c => c.id === googleId));
  const mine = await call('POST', '/api/comments/mine', { body: { credential: visitor } });
  assert.equal(mine.data.comments[0].status, 'reviewing'); assert.equal(mine.data.comments[0].content, '謝謝你的房間（修改過）');
  assert.equal((await call('PATCH', '/api/admin/comments/' + googleId, { token: owner, body: { public: true } })).status, 200);
  pub = await call('GET', '/api/comments'); assert.ok(pub.data.comments.some(c => c.id === googleId && c.editedAt));
});
await test('編輯期限：送出超過 7 天就不能編輯，但還能刪除', async () => {
  notion.pages.get(otherId).properties['時間'].date.start = new Date(Date.now() - 8 * 86400e3).toISOString();
  const r = await call('PATCH', '/api/comments/' + otherId, { body: { credential: other, content: '太久了' } });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'edit_window_closed');
  const mine = await call('POST', '/api/comments/mine', { body: { credential: other } });
  assert.equal(mine.data.comments[0].editable, false);
  assert.equal((await call('POST', '/api/comments/' + otherId + '/delete', { body: { credential: visitor } })).status, 403);
  assert.equal((await call('POST', '/api/comments/' + otherId + '/delete', { body: { credential: other } })).status, 200);
  assert.equal(notion.pages.get(otherId).in_trash, true);
  assert.equal((await call('POST', '/api/comments/' + otherId + '/delete', { body: { credential: other } })).status, 404);
});
await test('房主管理：取消公開時留言者看到「未公開」、刪除', async () => {
  assert.equal((await call('GET', '/api/admin/comments')).status, 401);
  assert.equal((await call('GET', '/api/admin/comments', { token: visitor })).status, 403);
  const all = await call('GET', '/api/admin/comments', { token: owner });
  assert.ok(all.data.comments.some(c => c.id === googleId && c.editedAt));
  await call('PATCH', '/api/admin/comments/' + googleId, { token: owner, body: { public: false } });
  notion.pages.get(googleId).properties['編輯時間'] = { date: null };
  const mine = await call('POST', '/api/comments/mine', { body: { credential: visitor } });
  assert.equal(mine.data.comments[0].status, 'hidden');
  assert.equal((await call('DELETE', '/api/admin/comments/' + googleId, { token: owner })).status, 200);
  assert.ok(!(await call('GET', '/api/comments')).data.comments.some(c => c.id === googleId));
  assert.equal((await call('PATCH', '/api/admin/comments/not-an-id', { token: owner, body: { public: true } })).status, 400);
});
await test('悄悄話：不公開、本人看得到、房主不能公開、可以切換', async () => {
  const r = await call('POST', '/api/comments', { body: { nickname: '小聲', content: '只想跟你說', whisper: true, credential: other, elapsed: 9000 }, ip: '8.8.8.1' });
  assert.equal(r.status, 201); assert.equal(r.data.public, false); assert.equal(r.data.comment.status, 'whisper');
  const id = r.data.comment.id, page = notion.pages.get(id);
  assert.equal(page.properties['悄悄話'].checkbox, true); assert.equal(page.properties['公開'].checkbox, false);
  assert.ok(!(await call('GET', '/api/comments')).data.comments.some(c => c.id === id));
  page.properties['公開'].checkbox = true;   // 就算在 Notion 誤勾「公開」
  kvStore.delete('comments:public');
  assert.ok(!(await call('GET', '/api/comments')).data.comments.some(c => c.id === id));
  page.properties['公開'].checkbox = false;
  const mine = await call('POST', '/api/comments/mine', { body: { credential: other } });
  assert.equal(mine.data.comments.find(c => c.id === id).status, 'whisper');
  const pubTry = await call('PATCH', '/api/admin/comments/' + id, { token: owner, body: { public: true } });
  assert.equal(pubTry.status, 400); assert.equal(pubTry.data.error, 'is_whisper');
  const e = await call('PATCH', '/api/comments/' + id, { body: { credential: other, content: '想讓大家看到', whisper: false } });
  assert.equal(e.status, 200); assert.equal(e.data.comment.status, 'reviewing');
  assert.equal((await call('PATCH', '/api/admin/comments/' + id, { token: owner, body: { public: true } })).status, 200);
  assert.ok((await call('GET', '/api/comments')).data.comments.some(c => c.id === id));
  const back = await call('PATCH', '/api/comments/' + id, { body: { credential: other, content: '還是悄悄說就好', whisper: true } });
  assert.equal(back.data.comment.status, 'whisper');
  assert.ok(!(await call('GET', '/api/comments')).data.comments.some(c => c.id === id));
});
await test('封鎖：被封鎖的 Google 帳號不能留言，解除後可以', async () => {
  const author = notion.pages.get(googleId).properties['留言者 Google ID'].rich_text[0].text.content;
  assert.equal((await call('PUT', '/api/admin/blocks/' + author, { token: owner, body: { note: '小樹' } })).status, 200);
  assert.equal((await call('GET', '/api/admin/blocks', { token: owner })).data.blocks[0].author, author);
  const r = await call('POST', '/api/comments', { body: { content: '我又來了', credential: visitor, elapsed: 9000 }, ip: '6.6.6.7' });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'blocked');
  assert.equal((await call('DELETE', '/api/admin/blocks/' + author, { token: owner })).status, 200);
  assert.equal((await call('POST', '/api/comments', { body: { content: '我又來了', credential: visitor, elapsed: 9000 }, ip: '6.6.6.8' })).status, 201);
});
await test('快取：3 分鐘內重複讀取不會再查 Notion', async () => {
  let queries = 0; const orig = globalThis.fetch;
  globalThis.fetch = (u, i) => { if (String(u).includes('/query')) queries++; return orig(u, i); };
  kvStore.delete('comments:public');
  await call('GET', '/api/comments'); await call('GET', '/api/comments'); await call('GET', '/api/comments');
  globalThis.fetch = orig;
  assert.equal(queries, 1);
});

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} 項通過；測試期間 KV 寫入 ${kvWrites} 次`);
process.exit(passed === results.length ? 0 : 1);
