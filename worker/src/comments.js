// 留言：公開列表（有快取）、新增留言（登入或匿名）、房主管理、封鎖
import { fail, json, readJSON, cleanText, hmacHex, clientIP } from './util.js';
import { verifyGoogleToken } from './google.js';
import { queryComments, createComment, setPublic, trashComment } from './notion.js';
import { checkLimits, LIMITS } from './ratelimit.js';

const CACHE_KEY = 'comments:public';
const CACHE_MAX_AGE = 3 * 60e3;   // 公開留言快取 3 分鐘：在 Notion 打勾或取消，房間最多 3 分鐘後更新
const PUBLIC_LIMIT = 200;         // 房間最多顯示最近 200 則
const ADMIN_LIMIT = 300;
const NICK_MAX = 20, CONTENT_MAX = 500;
const ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const AUTHOR = /^[0-9a-f]{32}$/;

const publicView = c => ({ id: c.id, nickname: c.nickname, content: c.content, createdAt: c.createdAt, method: c.method });
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

/* ---------- 新增留言 ---------- */
export async function postComment(env, request) {
  const b = await readJSON(request, 8 * 1024);
  if (b.website) return json({ ok: true, public: false });   // 機器人才會填的隱藏欄位：假裝成功
  if (typeof b.elapsed === 'number' && b.elapsed < 2500) fail(400, 'too_fast');

  const nickname = cleanText(b.nickname, { maxLen: NICK_MAX });
  if (nickname === null) fail(400, 'nickname_too_long');
  const content = cleanText(b.content, { maxLen: CONTENT_MAX, maxLines: 20 });
  if (content === null) fail(400, 'content_too_long');
  if (!content) fail(400, 'content_empty');

  let method = 'anonymous', author = null;
  if (b.credential) {
    const p = await verifyGoogleToken(env, b.credential);
    author = await authorId(env, p.sub);
    if ((await getBlocks(env)).some(x => x.author === author)) fail(403, 'blocked');
    method = 'google';
  }
  const links = (content.match(/https?:\/\/|www\./gi) || []).length;
  if (links > (method === 'google' ? 3 : 1)) fail(400, 'too_many_links');

  const ipKey = 'rl:ip:' + (await hmacHex(secret(env), 'ip:' + clientIP(request))).slice(0, 32);
  const rules = [{ key: ipKey, limits: LIMITS.ip }];
  if (author) rules.push({ key: 'rl:acct:' + author, limits: LIMITS.account });
  else rules.push({ key: 'rl:anon', limits: LIMITS.anonAll });
  const record = await checkLimits(env, rules);

  const saved = await createComment(env, {
    nickname: nickname || '匿名', content, createdAt: new Date().toISOString(), method, author, public: method === 'google',
  });
  await record();
  if (saved.public) await patchCache(env, list => [publicView(saved)].concat(list.filter(x => x.id !== saved.id)));
  return json({ ok: true, public: saved.public, comment: publicView(saved) }, 201);
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
