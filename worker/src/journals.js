// 房主的夢境紀錄與心情筆記：從 Notion 讀出，給房間的書架與桌上的筆記本
// 每一篇是資料庫裡的一頁：欄位放標題、日期（夢境另有「夢的色調」），內容直接寫在頁面裡（文字段落與圖片）
import { fail, json, allowedOrigins } from './util.js';
import { notion, dataSourceOf } from './notion.js';

export const JOURNALS = {
  dream: { db: 'NOTION_DREAM_DB', tone: true, blankDate: true },   // 沒填日期的夢，日期就留白
  mood: { db: 'NOTION_MOOD_DB', tone: false },
};
const F = { title: '標題', date: '日期', tone: '夢的色調' };   // 要和 Notion 裡的欄位名稱完全一樣
const TONES = ['溫柔', '奇幻', '不安', '清醒'];
const LIST_TTL = 180;        // 整份清單在邊緣快取 3 分鐘：新寫的一篇最晚 3 分鐘後出現
const MAX_FILL = 30;         // 一次請求最多重新讀幾篇內容（免費方案每次請求最多 50 個子請求）

const plain = rt => (rt || []).map(x => x.plain_text || '').join('');
const TEXT_TYPES = { paragraph: 'p', heading_1: 'h', heading_2: 'h', heading_3: 'h', quote: 'q', callout: 'q', bulleted_list_item: 'li', numbered_list_item: 'li', to_do: 'li' };

// 一頁的內容 → [{t:'p'|'h'|'q'|'li', x:文字} | {t:'img', id, cap} | {t:'hr'}]
async function readBlocks(env, pageId) {
  const out = [];
  let cursor, guard = 0;
  do {
    const r = await notion(env, `/blocks/${pageId}/children?page_size=100` + (cursor ? '&start_cursor=' + cursor : ''));
    for (const b of r.results || []) {
      const t = TEXT_TYPES[b.type];
      if (t) { const x = plain(b[b.type].rich_text); out.push({ t, x }); continue; }
      if (b.type === 'image') out.push({ t: 'img', id: b.id, v: b.last_edited_time, cap: plain(b.image.caption) });   // v：換過圖片就會變，用來判斷壓縮版是否過期
      else if (b.type === 'divider') out.push({ t: 'hr' });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && ++guard < 5);
  // 去掉開頭與結尾的空段落
  while (out.length && out[0].t === 'p' && !out[0].x.trim()) out.shift();
  while (out.length && out.at(-1).t === 'p' && !out.at(-1).x.trim()) out.pop();
  return out;
}

export async function listJournal(env, ctx, kind, request) {
  const J = JOURNALS[kind];
  if (!J) fail(404, 'not_found');
  const cache = caches.default, key = new Request('https://cache.innerroom/journal/' + kind);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);

  const ds = await dataSourceOf(env, env[J.db], J.db);
  const pages = [];
  let cursor, guard = 0;
  do {
    const body = { page_size: 100, sorts: [{ property: F.date, direction: 'ascending' }, { timestamp: 'created_time', direction: 'ascending' }] };
    if (cursor) body.start_cursor = cursor;
    const r = await notion(env, `/data_sources/${ds}/query`, { method: 'POST', body });
    (r.results || []).forEach(p => { if (!p.in_trash && !p.archived) pages.push(p); });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && ++guard < 10);

  let filled = 0, partial = false;
  const items = [];
  for (const p of pages) {
    const pr = p.properties || {};
    const title = plain(pr[F.title] && pr[F.title].title).trim();
    const date = (pr[F.date] && pr[F.date].date && pr[F.date].date.start) || (J.blankDate ? '' : p.created_time.slice(0, 10));
    const toneName = J.tone && pr[F.tone] && pr[F.tone].select ? pr[F.tone].select.name : '';
    // 內容依「最後編輯時間」記在 KV：沒改過的頁面不再向 Notion 讀
    const ck = `journal:${p.id}:${p.last_edited_time}`;
    let blocks = env.KV ? await env.KV.get(ck, 'json') : null;
    if (!blocks) {
      if (filled >= MAX_FILL) { partial = true; continue; }
      blocks = await readBlocks(env, p.id); filled++;
      if (env.KV) ctx.waitUntil(env.KV.put(ck, JSON.stringify(blocks), { expirationTtl: 60 * 60 * 24 * 60 }).catch(() => {}));
    }
    if (!title && !blocks.length) continue;   // 還沒開始寫的空白頁
    items.push({ _k: String(date || p.created_time).slice(0, 10) + p.created_time, id: p.id, title: title || '（無題）', date: String(date).slice(0, 10), ...(J.tone ? { tone: TONES.includes(toneName) ? toneName : '' } : {}), blocks });
  }
  // 依日期排；沒填日期的照寫下的那天排進去
  items.sort((a, z) => a._k < z._k ? -1 : a._k > z._k ? 1 : 0).forEach(x => delete x._k);
  const res = json({ items, partial });
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', `public, max-age=${partial ? 15 : LIST_TTL}`);
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

/* ---------- 攝影作品：書桌櫃最下層盒子裡的照片。資料庫裡一列一張照片，勾「公開」的才出現 ---------- */
const PF = { title: '標題', photo: '照片', cap: '說明', pub: '公開' };   // 要和 Notion 裡的欄位名稱完全一樣
const fileOf = pr => { const f = pr && pr.files && pr.files[0]; return f ? (f.type === 'file' ? f.file && f.file.url : f.external && f.external.url) : null; };
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)(\?|$)/i;
const kindOf = pr => { const f = pr && pr.files && pr.files[0]; const n = (f && f.name) || fileOf(pr) || ''; return VIDEO_EXT.test(n) ? 'video' : 'image'; };
export async function listPhotos(env, ctx) {
  const cache = caches.default, key = new Request('https://cache.innerroom/photos');
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  const ds = await dataSourceOf(env, env.NOTION_PHOTO_DB, 'NOTION_PHOTO_DB');
  const items = [];
  let cursor, guard = 0;
  do {
    const body = { page_size: 100, filter: { property: PF.pub, checkbox: { equals: true } }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] };
    if (cursor) body.start_cursor = cursor;
    const r = await notion(env, `/data_sources/${ds}/query`, { method: 'POST', body });
    for (const p of r.results || []) {
      if (p.in_trash || p.archived) continue;
      const pr = p.properties || {};
      if (!fileOf(pr[PF.photo])) continue;   // 還沒放照片的列
      items.push({ id: p.id, v: p.last_edited_time, kind: kindOf(pr[PF.photo]), title: plain(pr[PF.title] && pr[PF.title].title).trim(), cap: plain(pr[PF.cap] && pr[PF.cap].rich_text).trim() });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && ++guard < 10);
  const res = json({ items });
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', `public, max-age=${LIST_TTL}`);
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
// 攝影作品的一頁 → 照片的原始檔網址（只接受攝影作品資料庫裡、勾了「公開」的）
async function photoSource(env, pageId) {
  if (!env.NOTION_PHOTO_DB) return null;
  const page = await notion(env, '/pages/' + pageId, { notFoundOK: true });
  if (!page || page.in_trash || page.archived) return null;
  const parentDs = String((page.parent && (page.parent.data_source_id || page.parent.database_id)) || '').replace(/-/g, '');
  const ok = [String(env.NOTION_PHOTO_DB).replace(/-/g, ''), String(await dataSourceOf(env, env.NOTION_PHOTO_DB, 'NOTION_PHOTO_DB')).replace(/-/g, '')];
  if (!ok.includes(parentDs)) return null;
  const pr = page.properties || {};
  if (!(pr[PF.pub] && pr[PF.pub].checkbox)) return null;
  const src = fileOf(pr[PF.photo]);
  return src && /^https:\/\//.test(src) ? { src, v: page.last_edited_time, kind: kindOf(pr[PF.photo]) } : null;
}

// 攝影作品裡的短片（像會動的照片）：由這裡轉送，支援瀏覽器播影片時的分段讀取（Range）。整支在邊緣快取一天
const VIDEO_MAX = 30 * 1024 * 1024;
export async function photoVideo(env, ctx, pageId, request) {
  if (!/^[0-9a-f-]{32,36}$/i.test(pageId)) fail(404, 'not_found');
  const origin = request.headers.get('Origin');
  const cors = origin && allowedOrigins(env).includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
  const cache = caches.default, key = new Request('https://cache.innerroom/photo-video/' + pageId);
  let hit = await cache.match(key);
  if (!hit) {
    const ph = await photoSource(env, pageId);
    if (!ph || ph.kind !== 'video') fail(404, 'not_found');
    const r = await fetch(ph.src);
    if (!r.ok) fail(502, 'video_error');
    const buf = await r.arrayBuffer();
    if (buf.byteLength > VIDEO_MAX) fail(413, 'too_large');
    let type = r.headers.get('Content-Type') || '';
    if (!/^video\//.test(type)) type = /\.webm/i.test(ph.src) ? 'video/webm' : /\.mov/i.test(ph.src) ? 'video/quicktime' : 'video/mp4';
    hit = new Response(buf, { headers: { 'Content-Type': type, 'Content-Length': String(buf.byteLength), 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  const buf = await hit.arrayBuffer(), n = buf.byteLength, type = hit.headers.get('Content-Type');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', ...cors };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (!m || (m[1] === '' && m[2] === '')) return new Response(buf, { headers: { ...base, 'Content-Length': String(n) } });
  let a = m[1] === '' ? Math.max(0, n - +m[2]) : +m[1], z = m[1] === '' || m[2] === '' ? n - 1 : Math.min(n - 1, +m[2]);
  if (a >= n || a > z) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${n}` } });
  return new Response(buf.slice(a, z + 1), { status: 206, headers: { ...base, 'Content-Length': String(z - a + 1), 'Content-Range': `bytes ${a}-${z}/${n}` } });
}

// 圖片區塊 → Notion 的原始檔網址；只接受這兩個資料庫裡的頁面上的圖片（或攝影作品資料庫裡的照片）
async function imageSource(env, blockId) {
  if (!/^[0-9a-f-]{32,36}$/i.test(blockId)) fail(404, 'not_found');
  const b = await notion(env, '/blocks/' + blockId, { notFoundOK: true });
  if (!b || b.type !== 'image') { const ph = await photoSource(env, blockId); if (ph) return ph; fail(404, 'not_found'); }   // 攝影作品：id 是一列（頁面）
  if (!b || b.type !== 'image' || !b.parent || b.parent.type !== 'page_id') fail(404, 'not_found');
  const page = await notion(env, '/pages/' + b.parent.page_id, { notFoundOK: true });
  const parentDs = page && page.parent && (page.parent.data_source_id || page.parent.database_id);
  const allowed = [];
  for (const k of Object.keys(JOURNALS)) { const id = env[JOURNALS[k].db]; if (id) allowed.push(await dataSourceOf(env, id, JOURNALS[k].db), String(id).replace(/-/g, '')); }
  if (!parentDs || !allowed.map(x => x.replace(/-/g, '')).includes(String(parentDs).replace(/-/g, ''))) fail(404, 'not_found');
  const src = b.image.type === 'file' ? b.image.file.url : b.image.external && b.image.external.url;
  if (!src || !/^https:\/\//.test(src)) fail(404, 'not_found');
  return { src, v: b.last_edited_time };
}

const IMG_KEY = id => 'jimg:' + String(id).replace(/-/g, '').toLowerCase();
const IMG_MAX = 2 * 1024 * 1024;   // 壓縮版的上限

// 頁面裡的圖片。房主在後台把圖片壓成小檔存進 KV（jimg:<區塊 id>）：有壓縮版、而且沒有過期就直接給，
// 否則照舊轉送 Notion 的原始檔（Notion 給的檔案網址一小時就失效，所以由這裡轉送，並在邊緣快取一天）。
// ?orig=1 一律給原始檔（後台壓縮時用）；?v= 是圖片的版本，和壓縮版記下的版本不同就表示換過圖了
export async function journalImage(env, ctx, blockId, request) {
  if (!/^[0-9a-f-]{32,36}$/i.test(blockId)) fail(404, 'not_found');
  const url = new URL(request.url), want = url.searchParams.get('v') || '', orig = url.searchParams.get('orig') === '1';
  const origin = request.headers.get('Origin');
  const cors = origin && allowedOrigins(env).includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
  if (!orig && env.KV) {
    const r = await env.KV.getWithMetadata(IMG_KEY(blockId), 'arrayBuffer');
    if (r.value && r.metadata && (!want || !r.metadata.v || r.metadata.v === want))
      return new Response(r.value, { headers: { 'Content-Type': r.metadata.type || 'image/jpeg', 'Cache-Control': 'public, max-age=2592000', 'X-Content-Type-Options': 'nosniff', ...cors } });
  }
  const cache = caches.default, key = new Request('https://cache.innerroom/journal-img/' + blockId);
  let hit = await cache.match(key);
  if (!hit) {
    const { src } = await imageSource(env, blockId);
    const r = await fetch(src);
    const type = r.headers.get('Content-Type') || '';
    if (!r.ok || !/^image\//.test(type)) fail(502, 'image_error');
    hit = new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  const out = new Response(hit.body, hit);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  if (!orig && want) out.headers.set('Cache-Control', 'public, max-age=3600');   // 還沒壓縮：瀏覽器別存太久，壓好後才換得到小檔
  return out;
}

// 後台：已經壓好的圖片 { 區塊 id: 版本 }
export async function adminImageList(env) {
  const done = {};
  let cursor, guard = 0;
  do {
    const r = await env.KV.list({ prefix: 'jimg:', cursor });
    for (const k of r.keys) done[k.name.slice(5)] = (k.metadata && k.metadata.v) || '';
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && ++guard < 20);
  return json({ done });
}

// 後台：存一張壓縮版（內容是圖片本身，Content-Type 為 image/webp 或 image/jpeg）
export async function adminImagePut(env, request, blockId) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!['image/webp', 'image/jpeg'].includes(type)) fail(400, 'bad_type');
  const len = +(request.headers.get('content-length') || 0);
  if (len > IMG_MAX) fail(413, 'too_large');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > IMG_MAX) fail(413, 'too_large');
  const { v } = await imageSource(env, blockId);   // 確認是夢境紀錄或心情筆記裡的圖，順便記下目前的版本
  await env.KV.put(IMG_KEY(blockId), buf, { metadata: { type, v, size: buf.byteLength } });
  return json({ ok: true, v, size: buf.byteLength });
}
