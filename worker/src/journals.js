// 房主的夢境紀錄與心情筆記：從 Notion 讀出，給房間的書架與桌上的筆記本
// 每一篇是資料庫裡的一頁：欄位放標題、日期（夢境另有「夢的色調」），內容直接寫在頁面裡（文字段落與圖片）
import { fail, json } from './util.js';
import { notion, dataSourceOf } from './notion.js';

export const JOURNALS = {
  dream: { db: 'NOTION_DREAM_DB', tone: true },
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
      if (b.type === 'image') out.push({ t: 'img', id: b.id, cap: plain(b.image.caption) });
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
    const date = (pr[F.date] && pr[F.date].date && pr[F.date].date.start) || p.created_time.slice(0, 10);
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
    items.push({ id: p.id, title: title || '（無題）', date: String(date).slice(0, 10), ...(J.tone ? { tone: TONES.includes(toneName) ? toneName : '' } : {}), blocks });
  }
  const res = json({ items, partial });
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', `public, max-age=${partial ? 15 : LIST_TTL}`);
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

// 頁面裡的圖片：Notion 給的檔案網址一小時就失效，所以由這裡轉送，並在邊緣快取一天。
// 只轉送這兩個資料庫裡的圖片
export async function journalImage(env, ctx, blockId) {
  if (!/^[0-9a-f-]{32,36}$/i.test(blockId)) fail(404, 'not_found');
  const cache = caches.default, key = new Request('https://cache.innerroom/journal-img/' + blockId);
  const hit = await cache.match(key);
  if (hit) return hit;
  const b = await notion(env, '/blocks/' + blockId, { notFoundOK: true });
  if (!b || b.type !== 'image' || !b.parent || b.parent.type !== 'page_id') fail(404, 'not_found');
  const page = await notion(env, '/pages/' + b.parent.page_id, { notFoundOK: true });
  const parentDs = page && page.parent && (page.parent.data_source_id || page.parent.database_id);
  const allowed = [];
  for (const k of Object.keys(JOURNALS)) { const id = env[JOURNALS[k].db]; if (id) allowed.push(await dataSourceOf(env, id, JOURNALS[k].db), String(id).replace(/-/g, '')); }
  if (!parentDs || !allowed.map(x => x.replace(/-/g, '')).includes(String(parentDs).replace(/-/g, ''))) fail(404, 'not_found');
  const src = b.image.type === 'file' ? b.image.file.url : b.image.external && b.image.external.url;
  if (!src || !/^https:\/\//.test(src)) fail(404, 'not_found');
  const r = await fetch(src);
  const type = r.headers.get('Content-Type') || '';
  if (!r.ok || !/^image\//.test(type)) fail(502, 'image_error');
  const out = new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
