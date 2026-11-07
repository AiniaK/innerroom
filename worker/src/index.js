// 內在房間 Worker：房主內容 API（提交到 GitHub）＋留言 API（Notion＋KV 快取）
import { HttpError, fail, json, corsHeaders, allowedOrigins, readJSON } from './util.js';
import { requireOwner } from './google.js';
import { getContent, putContent, listMedia, createBlobFromStream, commitFiles, refsInContent, UPLOAD_PATH, isMediaRef } from './github.js';
import { validateContent, commitMessage } from './content.js';
import { listPublic, postComment, adminList, adminSetPublic, adminDelete, adminBlocks, adminBlock, adminUnblock } from './comments.js';

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  // 設定檢查（不會顯示任何金鑰內容）
  if (path === '/api/health' && m === 'GET') {
    return json({ ok: true, configured: {
      GITHUB_REPO: !!env.GITHUB_REPO, GITHUB_TOKEN: !!env.GITHUB_TOKEN, GOOGLE_CLIENT_ID: !!env.GOOGLE_CLIENT_ID,
      OWNER_EMAILS: !!env.OWNER_EMAILS, NOTION_TOKEN: !!env.NOTION_TOKEN, NOTION_DATABASE_ID: !!env.NOTION_DATABASE_ID,
      HASH_SECRET: !!(env.HASH_SECRET && env.HASH_SECRET.length >= 16), KV: !!env.KV, ALLOWED_ORIGINS: allowedOrigins(env),
    },
    // 只檢查格式（開頭與字元種類），不透露金鑰內容，方便發現貼錯的金鑰
    format: {
      GITHUB_TOKEN: /^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(String(env.GITHUB_TOKEN || '').trim()),
      NOTION_TOKEN: /^(ntn_|secret_)[A-Za-z0-9]+$/.test(String(env.NOTION_TOKEN || '').trim()),
      NOTION_DATABASE_ID: /^[0-9a-f]{32}$/i.test(String(env.NOTION_DATABASE_ID || '').trim().replace(/-/g, '')),
    } });
  }

  // 只接受來自網站網域的請求（瀏覽器一定會帶 Origin）
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) fail(403, 'forbidden_origin');

  /* ---------- 公開：留言 ---------- */
  if (path === '/api/comments' && m === 'GET') return listPublic(env, ctx);
  if (path === '/api/comments' && m === 'POST') return postComment(env, request);

  /* ---------- 以下都只限房主 ---------- */
  if (!path.startsWith('/api/')) fail(404, 'not_found');
  const owner = await requireOwner(env, request);

  if (path === '/api/me' && m === 'GET') return json({ email: owner.email });

  if (path === '/api/content' && m === 'GET') return json(await getContent(env));
  if (path === '/api/content' && m === 'PUT') {
    const b = await readJSON(request, 256 * 1024);
    const content = validateContent(b.content);
    if (b.sha !== null && b.sha !== undefined && typeof b.sha !== 'string') fail(400, 'bad_request');
    return json(await putContent(env, content, b.sha || null, commitMessage(b.sections)));
  }

  if (path === '/api/media' && m === 'GET') return json({ files: await listMedia(env) });
  if (path === '/api/media' && m === 'PUT') {
    const p = url.searchParams.get('path') || '';
    if (!UPLOAD_PATH.test(p)) fail(400, 'bad_path');
    const sha = await createBlobFromStream(env, request);
    const r = await commitFiles(env, [{ path: p, sha }], '後台上傳：' + p);
    return json({ path: p, commitUrl: r.commitUrl });
  }
  if (path === '/api/media' && m === 'DELETE') {
    const p = url.searchParams.get('path') || '';
    if (!isMediaRef(p)) fail(400, 'bad_path');
    const { content } = await getContent(env);
    if (refsInContent(content).has(p)) fail(409, 'in_use');   // 房間還在用的檔案不能刪
    const r = await commitFiles(env, [{ path: p, sha: null }], '後台刪除：' + p);
    return json({ commitUrl: r.commitUrl });
  }

  if (path === '/api/admin/comments' && m === 'GET') return adminList(env);
  let mm = /^\/api\/admin\/comments\/([^/]+)$/.exec(path);
  if (mm && m === 'PATCH') return adminSetPublic(env, request, decodeURIComponent(mm[1]));
  if (mm && m === 'DELETE') return adminDelete(env, decodeURIComponent(mm[1]));
  if (path === '/api/admin/blocks' && m === 'GET') return adminBlocks(env);
  mm = /^\/api\/admin\/blocks\/([^/]+)$/.exec(path);
  if (mm && m === 'PUT') return adminBlock(env, request, decodeURIComponent(mm[1]));
  if (mm && m === 'DELETE') return adminUnblock(env, decodeURIComponent(mm[1]));

  fail(404, 'not_found');
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status >= 500) console.error(e.code, e.detail || '');
        res = json({ error: e.code, ...(e.detail && (e.status === 400 || e.code === 'not_configured') ? { field: e.detail } : {}), ...(e.detail && e.code === 'github_error' ? { hint: e.detail } : {}) }, e.status);
      } else {
        console.error('unexpected', e && e.stack || e);
        res = json({ error: 'server_error' }, 500);
      }
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
