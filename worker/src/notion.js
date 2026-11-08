// Notion 留言資料庫（API 版本 2025-09-03：用「資料來源」data source 讀寫）
import { fail } from './util.js';

// 資料庫欄位名稱：要和 Notion 裡的欄位名稱完全一樣
export const P = {
  nickname: '暱稱',              // 標題（Title）
  content: '內容',               // 文字（Text）
  time: '時間',                  // 日期（Date）
  method: '登入方式',            // 單選（Select）：Google 登入／匿名
  author: '留言者 Google ID',    // 文字（Text）：雜湊後的代號，匿名留言留空
  public: '公開',                // 核取方塊（Checkbox）
  edited: '編輯時間',            // 日期（Date）：留言者自己編輯的時間，沒編輯過留空
  whisper: '悄悄話',             // 核取方塊（Checkbox）：只給房主看，永遠不會出現在房間的公開留言
};
const METHOD = { google: 'Google 登入', anonymous: '匿名' };

const API = 'https://api.notion.com/v1';
let memDS = null;

async function notion(env, path, opt = {}) {
  if (!env.NOTION_TOKEN) fail(500, 'not_configured', 'NOTION_TOKEN');
  const res = await fetch(API + path, {
    method: opt.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + String(env.NOTION_TOKEN).trim(),   // 貼上金鑰時常多帶空白或換行
      'Notion-Version': env.NOTION_VERSION || '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    console.error('Notion', path, res.status, data && data.code, data && data.message);
    if (res.status === 404 && opt.notFoundOK) return null;
    if (res.status === 429) fail(503, 'notion_busy');
    fail(502, 'notion_error');
  }
  return data;
}

// 由資料庫 ID 找到資料來源 ID（記在 KV，只查一次）
async function dataSourceId(env) {
  if (memDS) return memDS;
  const dbId = String(env.NOTION_DATABASE_ID || '').trim();
  if (!dbId) fail(500, 'not_configured', 'NOTION_DATABASE_ID');
  const key = 'notion:ds:' + dbId;
  const cached = env.KV ? await env.KV.get(key) : null;
  if (cached) return (memDS = cached);
  const db = await notion(env, '/databases/' + encodeURIComponent(dbId));
  const id = db && db.data_sources && db.data_sources[0] && db.data_sources[0].id;
  if (!id) fail(502, 'notion_error', '找不到資料來源，請確認資料庫已分享給 integration');
  if (env.KV) { try { await env.KV.put(key, id); } catch {} }
  return (memDS = id);
}

const plain = rt => (rt || []).map(x => x.plain_text || '').join('');
function toComment(page) {
  const pr = page.properties || {};
  const method = pr[P.method] && pr[P.method].select && pr[P.method].select.name === METHOD.google ? 'google' : 'anonymous';
  return {
    id: page.id,
    nickname: plain(pr[P.nickname] && pr[P.nickname].title) || '匿名',
    content: plain(pr[P.content] && pr[P.content].rich_text),
    createdAt: (pr[P.time] && pr[P.time].date && pr[P.time].date.start) || page.created_time,
    method,
    public: !!(pr[P.public] && pr[P.public].checkbox),
    author: plain(pr[P.author] && pr[P.author].rich_text) || null,
    editedAt: (pr[P.edited] && pr[P.edited].date && pr[P.edited].date.start) || null,
    whisper: !!(pr[P.whisper] && pr[P.whisper].checkbox),
    trashed: !!(page.in_trash || page.archived),
  };
}

// 讀取留言，新的在前。onlyPublic 時只讀勾選「公開」的；author 時只讀這個代號的留言
export async function queryComments(env, { onlyPublic, author, limit }) {
  const ds = await dataSourceId(env);
  const out = [];
  let cursor;
  do {
    const body = { page_size: Math.min(100, limit - out.length), sorts: [{ property: P.time, direction: 'descending' }] };
    const filters = [];
    if (onlyPublic) filters.push({ property: P.public, checkbox: { equals: true } }, { property: P.whisper, checkbox: { equals: false } });
    if (author) filters.push({ property: P.author, rich_text: { equals: author } });
    if (filters.length) body.filter = filters.length === 1 ? filters[0] : { and: filters };
    if (cursor) body.start_cursor = cursor;
    const r = await notion(env, `/data_sources/${ds}/query`, { method: 'POST', body });
    (r.results || []).forEach(p => { if (!p.in_trash && !p.archived) out.push(toComment(p)); });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && out.length < limit);
  return out;
}

export async function createComment(env, c) {
  const ds = await dataSourceId(env);
  const page = await notion(env, '/pages', { method: 'POST', body: {
    parent: { type: 'data_source_id', data_source_id: ds },
    properties: {
      [P.nickname]: { title: [{ type: 'text', text: { content: c.nickname } }] },
      [P.content]: { rich_text: [{ type: 'text', text: { content: c.content } }] },
      [P.time]: { date: { start: c.createdAt } },
      [P.method]: { select: { name: METHOD[c.method] } },
      [P.author]: { rich_text: c.author ? [{ type: 'text', text: { content: c.author } }] : [] },
      [P.public]: { checkbox: !!c.public },
      [P.whisper]: { checkbox: !!c.whisper },
    },
  } });
  return toComment(page);
}

export async function setPublic(env, id, value) {
  const page = await notion(env, '/pages/' + id, { method: 'PATCH', notFoundOK: true, body: { properties: { [P.public]: { checkbox: !!value } } } });
  if (!page) fail(404, 'not_found');
  return toComment(page);
}

export async function trashComment(env, id) {
  const page = await notion(env, '/pages/' + id, { method: 'PATCH', notFoundOK: true, body: { in_trash: true } });
  if (!page) fail(404, 'not_found');
}

export async function getComment(env, id) {
  const page = await notion(env, '/pages/' + id, { notFoundOK: true });
  return page ? toComment(page) : null;
}

// 留言者自己編輯：更新內容與編輯時間，並取消「公開」，等房主審核
export async function editOwnComment(env, id, { content, nickname, editedAt, whisper }) {
  const properties = {
    [P.whisper]: { checkbox: !!whisper },
    [P.content]: { rich_text: [{ type: 'text', text: { content } }] },
    [P.edited]: { date: { start: editedAt } },
    [P.public]: { checkbox: false },
  };
  if (nickname !== undefined) properties[P.nickname] = { title: [{ type: 'text', text: { content: nickname } }] };
  const page = await notion(env, '/pages/' + id, { method: 'PATCH', notFoundOK: true, body: { properties } });
  if (!page) fail(404, 'not_found');
  return toComment(page);
}
