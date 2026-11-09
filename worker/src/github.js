// 透過 GitHub API 讀寫 repo：content.json 和 media/ 裡的檔案
import { fail, utf8ToBase64, base64ToUtf8 } from './util.js';

const API = 'https://api.github.com';
const MB = 1048576;
export const MEDIA_MAX = 25 * MB;                            // 單檔上限（原始大小）
export const MEDIA_BODY_MAX = Math.ceil(MEDIA_MAX / 3) * 4 + 256;   // 轉成 base64 JSON 後的上限

// 經後台上傳的檔名：只允許英數字、「-」、「_」、「.」，副檔名限定
export const UPLOAD_PATH = /^media\/(covers\/)?[a-z0-9][a-z0-9._-]{0,120}\.(mp4|webm|mp3|m4a|jpg)$/;
// content.json 裡可以引用的檔案：也接受用 GitHub 網頁上傳、檔名有中文或空白的檔案
export function isMediaRef(p) {
  return typeof p === 'string' && p.length <= 300 && /^media\//.test(p) && !p.includes('..') && !p.includes('//')
    && !/[\u0000-\u001F\u007F"'<>\\`?#]/.test(p) && /\.(mp4|webm|mp3|m4a|jpe?g|png|webp)$/i.test(p);
}

function repo(env) {
  const r = String(env.GITHUB_REPO || '');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r)) fail(500, 'not_configured', 'GITHUB_REPO');
  if (!env.GITHUB_TOKEN) fail(500, 'not_configured', 'GITHUB_TOKEN');
  return r;
}
const branch = env => env.GITHUB_BRANCH || 'main';

async function gh(env, path, opt = {}) {
  const res = await fetch(API + '/repos/' + repo(env) + path, {
    method: opt.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + String(env.GITHUB_TOKEN).trim(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'innerroom-worker',
      ...(opt.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opt.headers || {}),
    },
    body: opt.body === undefined ? undefined : (typeof opt.body === 'string' || opt.body instanceof ReadableStream ? opt.body : JSON.stringify(opt.body)),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, data };
}
function ghFail(r, what) {
  console.error('GitHub', what, r.status, r.data && r.data.message);
  if (r.status === 401 || r.status === 403) fail(502, 'github_error', 'GitHub 金鑰無效或權限不足');
  fail(502, 'github_error');
}

/* ---------- content.json ---------- */
export async function getContent(env) {
  const r = await gh(env, `/contents/content.json?ref=${encodeURIComponent(branch(env))}`);
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) ghFail(r, 'get content');
  let content = null;
  try { content = JSON.parse(base64ToUtf8(r.data.content)); } catch { content = null; }
  return { content, sha: r.data.sha };
}
export async function putContent(env, content, sha, message) {
  const body = { message, content: utf8ToBase64(JSON.stringify(content, null, 2) + '\n'), branch: branch(env) };
  if (sha) body.sha = sha;
  const r = await gh(env, '/contents/content.json', { method: 'PUT', body });
  if (r.status === 409 || (r.status === 422 && /sha/i.test(r.data && r.data.message || ''))) fail(409, 'conflict');
  if (!r.ok) ghFail(r, 'put content');
  return { sha: r.data.content.sha, commitUrl: r.data.commit.html_url };
}

/* ---------- media/ ---------- */
export async function listMedia(env) {
  const r = await gh(env, `/git/trees/${encodeURIComponent(branch(env))}?recursive=1`);
  if (!r.ok) ghFail(r, 'list media');
  return (r.data.tree || []).filter(e => e.type === 'blob' && e.path.startsWith('media/')).map(e => ({ path: e.path, size: e.size || 0 }));
}

// 把瀏覽器送來的 {"encoding":"base64","content":"…"} 原樣串流給 GitHub 建立 blob，Worker 不讀進記憶體
export async function createBlobFromStream(env, request) {
  const len = +(request.headers.get('content-length') || 0);
  if (!len) fail(411, 'length_required');
  if (len > MEDIA_BODY_MAX) fail(413, 'too_large');
  if (!/application\/json/.test(request.headers.get('content-type') || '')) fail(415, 'bad_type');
  const { readable, writable } = new FixedLengthStream(len);
  const pipe = request.body.pipeTo(writable);
  const r = await gh(env, '/git/blobs', { method: 'POST', body: readable });
  await pipe.catch(() => {});
  if (r.status === 422 || r.status === 400) fail(400, 'bad_upload');
  if (!r.ok) ghFail(r, 'create blob');
  return r.data.sha;
}

// 一次提交多個檔案的變更（sha 為 null 代表刪除）。分支剛好被別人更新時重試
export async function commitFiles(env, changes, message) {
  const ref = `heads/${branch(env)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await gh(env, `/git/ref/${ref}`);
    if (!head.ok) ghFail(head, 'get ref');
    const parent = head.data.object.sha;
    const commit = await gh(env, `/git/commits/${parent}`);
    if (!commit.ok) ghFail(commit, 'get commit');
    const tree = await gh(env, '/git/trees', { method: 'POST', body: {
      base_tree: commit.data.tree.sha,
      tree: changes.map(c => ({ path: c.path, mode: '100644', type: 'blob', sha: c.sha })),
    } });
    if (tree.status === 422) fail(404, 'not_found');
    if (!tree.ok) ghFail(tree, 'create tree');
    const created = await gh(env, '/git/commits', { method: 'POST', body: { message, tree: tree.data.sha, parents: [parent] } });
    if (!created.ok) ghFail(created, 'create commit');
    const upd = await gh(env, `/git/refs/${ref}`, { method: 'PATCH', body: { sha: created.data.sha, force: false } });
    if (upd.ok) return { commitUrl: created.data.html_url };
    if (upd.status !== 422 && upd.status !== 409) ghFail(upd, 'update ref');
  }
  fail(409, 'busy');
}

export function refsInContent(c) {
  const s = new Set();
  if (c && c.tv && c.tv.src) s.add(c.tv.src);
  ((c && c.music && c.music.tracks) || []).forEach(t => { if (t && t.src) s.add(t.src); if (t && t.cover) s.add(t.cover); });
  Object.values((c && c.exhibits && c.exhibits.items) || {}).forEach(e => { if (e && e.custom) { if (e.img) s.add(e.img); if (e.video) s.add(e.video); } });   // 後台新增的展品
  return s;
}

export const MB_ = MB;
