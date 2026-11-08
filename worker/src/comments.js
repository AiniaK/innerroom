// 留言：公開列表（有快取）、新增留言（必須用 Google 登入）、留言者刪改自己的留言、房主管理、封鎖
import { fail, json, readJSON, cleanText, hmacHex, clientIP } from './util.js';
import { verifyGoogleToken } from './google.js';
import { queryComments, createComment, setPublic, trashComment, getComment, editOwnComment } from './notion.js';
import { checkLimits, LIMITS } from './ratelimit.js';

const CACHE_KEY = 'comments:public';
const CACHE_MAX_AGE = 3 * 60e3;   // 公開留言快取 3 分鐘：在 Notion 打勾或取消，房間最多 3 分鐘後更新
const PUBLIC_LIMIT = 200;         // 房間最多顯示最近 200 則
const ADMIN_LIMIT = 300;
const NICK_MAX = 20, CONTENT_MAX = 500;
const ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const AUTHOR = /^[0-9a-f]{32}$/;
const EDIT_WINDOW = 7 * 24 * 3600e3;   // 送出後 7 天內可以編輯；刪除不限時間
const MINE_LIMIT = 100;

const publicView = c => ({ id: c.id, nickname: c.nickname, content: c.content, createdAt: c.createdAt, editedAt: c.editedAt || null, method: c.method });
// 留言者自己看到的樣子：多了狀態（公開／審核中／未公開）和還能不能編輯
const mineView = c => ({ ...publicView(c), whisper: !!c.whisper, status: c.whisper ? 'whisper' : c.public ? 'public' : c.editedAt ? 'reviewing' : 'hidden',
  editableUntil: new Date(Date.parse(c.createdAt) + EDIT_WINDOW).toISOString(), editable: Date.now() - Date.parse(c.createdAt) < EDIT_WINDOW });
const secret = env => { if (!env.HASH_SECRET || env.HASH_SECRET.length < 16) fail(500, 'not_configured', 'HASH_SECRET'); return env.HASH_SECRET; };
export const authorId = async (env, sub) => (await hmacHex(secret(env), 'google:' + sub)).slice(0, 32);

/* ---------- 快取 ---------- */
async function readCache(env) { try { return env.KV ? await env.KV.get(CACHE_KEY, 'json') : null; } catch { return null; } }
async function writeCache(env, comments) {
  if (!env.KV) return;
  try { await env.KV.put(CACHE_KEY, JSON.stringify({ at: Date.now(), comments: comments.slice(0, PUBLIC_LIMIT) })); }
  catch (e) { console.error('KV put failed', CACHE_KEY, e && e.message); }
}
// 不重新查 Notion，直接修改快取（Notion 剛寫入時查詢不一定馬上查得到）
async function patchCache(env, fn) {
  const c = await readCache(env);
  if (c && Array.isArray(c.comments)) await writeCache(env, fn(c.comments));
}

export async function listPublic(env, ctx) {
  const c = await readCache(env);
  const fresh = c && Date.now() - c.at < CACHE_MAX_AGE;
  if (fresh) return json({ comments: c.comments }, 200, { 'Cache-Control': 'public, max-age=30' });
  try {
    const list = (await queryComments(env, { onlyPublic: true, limit: PUBLIC_LIMIT })).map(publicView);
    ctx.waitUntil(writeCache(env, list));
    return json({ comments: list }, 200, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    if (c) return json({ comments: c.comments, stale: true });   // Notion 暫時有問題時，先給舊的
    throw e;
  }
}

/* ---------- 封鎖名單（存在 KV） ---------- */
export async function getBlocks(env) { try { return (env.KV && await env.KV.get('blocks', 'json')) || []; } catch { return []; } }
async function saveBlocks(env, list) { if (!env.KV) fail(500, 'not_configured', 'KV'); await env.KV.put('blocks', JSON.stringify(list)); }

/* ---------- 留言者身分 ---------- */
async function visitor(env, credential) {
  if (!credential) fail(401, 'login_required');
  const p = await verifyGoogleToken(env, credential);
  return authorId(env, p.sub);
}
const isBlocked = async (env, author) => (await getBlocks(env)).some(x => x.author === author);
function cleanPost(b) {
  const nickname = cleanText(b.nickname, { maxLen: NICK_MAX });
  if (nickname === null) fail(400, 'nickname_too_long');
  const content = cleanText(b.content, { maxLen: CONTENT_MAX, maxLines: 20 });
  if (content === null) fail(400, 'content_too_long');
  if (!content) fail(400, 'content_empty');
  if ((content.match(/https?:\/\/|www\./gi) || []).length > 3) fail(400, 'too_many_links');
  return { nickname, content };
}
const ipKey = async (env, request) => 'rl:ip:' + (await hmacHex(secret(env), 'ip:' + clientIP(request))).slice(0, 32);

/* ---------- 新增留言（必須用 Google 登入，送出後立即公開） ---------- */
export async function postComment(env, request) {
  const b = await readJSON(request, 8 * 1024);
  if (b.website) return json({ ok: true, public: false });   // 機器人才會填的隱藏欄位：假裝成功
  if (typeof b.elapsed === 'number' && b.elapsed < 2500) fail(400, 'too_fast');
  const author = await visitor(env, b.credential);
  if (await isBlocked(env, author)) fail(403, 'blocked');
  const { nickname, content } = cleanPost(b);

  const record = await checkLimits(env, [{ key: await ipKey(env, request), limits: LIMITS.ip }, { key: 'rl:acct:' + author, limits: LIMITS.account }]);
  const whisper = b.whisper === true;   // 悄悄話：只給房主看
  const saved = await createComment(env, {
    nickname: nickname || '匿名', content, createdAt: new Date().toISOString(), method: 'google', author, public: !whisper, whisper,
  });
  await record();
  if (!whisper) await patchCache(env, list => [publicView(saved)].concat(list.filter(x => x.id !== saved.id)));
  return json({ ok: true, public: !whisper, comment: mineView(saved) }, 201);
}

/* ---------- 留言者自己的留言：列出、編輯、刪除 ---------- */
export async function listMine(env, request) {
  const b = await readJSON(request, 8 * 1024);
  const author = await visitor(env, b.credential);
  const comments = (await queryComments(env, { author, limit: MINE_LIMIT })).map(mineView);
  return json({ comments });
}

async function ownComment(env, id, author) {
  if (!ID.test(id)) fail(400, 'bad_id');
  const c = await getComment(env, id);
  if (!c || c.trashed) fail(404, 'not_found');
  if (!c.author || c.author !== author) fail(403, 'not_yours');
  return c;
}

export async function editMine(env, request, id) {
  const b = await readJSON(request, 8 * 1024);
  const author = await visitor(env, b.credential);
  if (await isBlocked(env, author)) fail(403, 'blocked');
  const c = await ownComment(env, id, author);
  if (Date.now() - Date.parse(c.createdAt) >= EDIT_WINDOW) fail(403, 'edit_window_closed');
  const { nickname, content } = cleanPost({ nickname: b.nickname === undefined ? c.nickname : b.nickname, content: b.content });
  const record = await checkLimits(env, [{ key: 'rl:edit:' + author, limits: LIMITS.edit }]);
  const whisper = typeof b.whisper === 'boolean' ? b.whisper : c.whisper;
  const saved = await editOwnComment(env, c.id, { content, nickname: nickname || '匿名', editedAt: new Date().toISOString(), whisper });
  await record();
  await patchCache(env, list => list.filter(x => x.id !== saved.id));   // 編輯後先從房間移除，等房主審核
  return json({ ok: true, comment: mineView(saved) });
}

export async function deleteMine(env, request, id) {
  const b = await readJSON(request, 8 * 1024);
  const author = await visitor(env, b.credential);
  const c = await ownComment(env, id, author);
  await trashComment(env, c.id);
  await patchCache(env, list => list.filter(x => x.id !== c.id));
  return json({ ok: true });
}

/* ---------- 房主管理 ---------- */
export async function adminList(env) {
  const comments = await queryComments(env, { onlyPublic: false, limit: ADMIN_LIMIT });
  return json({ comments });
}
export async function adminSetPublic(env, request, id) {
  if (!ID.test(id)) fail(400, 'bad_id');
  const b = await readJSON(request, 1024);
  if (typeof b.public !== 'boolean') fail(400, 'bad_request');
  if (b.public) { const cur = await getComment(env, id); if (!cur || cur.trashed) fail(404, 'not_found'); if (cur.whisper) fail(400, 'is_whisper'); }   // 悄悄話不能公開
  const c = await setPublic(env, id, b.public);
  await patchCache(env, list => {
    const rest = list.filter(x => x.id !== c.id);
    return c.public ? [publicView(c)].concat(rest).sort((a, z) => String(z.createdAt).localeCompare(String(a.createdAt))) : rest;
  });
  return json({ comment: c });
}
export async function adminDelete(env, id) {
  if (!ID.test(id)) fail(400, 'bad_id');
  await trashComment(env, id);
  await patchCache(env, list => list.filter(x => x.id.replace(/-/g, '') !== id.replace(/-/g, '')));
  return json({ ok: true });
}
export async function adminBlocks(env) { return json({ blocks: await getBlocks(env) }); }
export async function adminBlock(env, request, author) {
  if (!AUTHOR.test(author)) fail(400, 'bad_id');
  const b = await readJSON(request, 2048);
  const note = cleanText(b.note || '', { maxLen: 80 }) || '';
  const list = (await getBlocks(env)).filter(x => x.author !== author);
  list.push({ author, note, createdAt: new Date().toISOString() });
  await saveBlocks(env, list);
  return json({ ok: true });
}
export async function adminUnblock(env, author) {
  if (!AUTHOR.test(author)) fail(400, 'bad_id');
  await saveBlocks(env, (await getBlocks(env)).filter(x => x.author !== author));
  return json({ ok: true });
}
