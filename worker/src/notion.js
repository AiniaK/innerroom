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
};
const METHOD = { google: 'Google 登入', anonymous: '匿名' };

const API = 'https://api.notion.com/v1';
let memDS = null;

async function notion(env, path, opt = {}) {
  if (!env.NOTION_TOKEN) fail(500, 'not_configured', 'NOTION_TOKEN');
  const res = await fetch(API + path, {
    method: opt.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + env.NOTION_TOKEN,
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
  if (!env.NOTION_DATABASE_ID) fail(500, 'not_configured', 'NOTION_DATABASE_ID');
  const key = 'notion:ds:' + env.NOTION_DATABASE_ID;
  const cached = env.KV ? await env.KV.get(key) : null;
  if (cached) return (memDS = cached);
  const db = await notion(env, '/databases/' + encodeURIComponent(env.NOTION_DATABASE_ID));
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
  };
}

// 讀取留言，新的在前。onlyPublic 時只讀勾選「公開」的
export async function queryComments(env, { onlyPublic, limit }) {
  const ds = await dataSourceId(env);
  const out = [];
  let cursor;
  do {
    const body = { page_size: Math.min(100, limit - out.length), sorts: [{ property: P.time, direction: 'descending' }] };
    if (onlyPublic) body.filter = { property: P.public, checkbox: { equals: true } };
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
