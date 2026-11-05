// 驗證 Google Identity Services 發的 ID token（RS256 JWT）
import { base64UrlToBytes, fail } from './util.js';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let memJwks = null;   // { keys, exp }

async function getKeys(env, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && memJwks && memJwks.exp > now) return memJwks.keys;
  if (!forceRefresh && env.KV) {
    const cached = await env.KV.get('google:jwks', 'json');
    if (cached && cached.exp > now) { memJwks = cached; return cached.keys; }
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) fail(503, 'google_unavailable');
  const body = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const ttl = Math.max(600, Math.min(86400, m ? +m[1] : 3600));
  memJwks = { keys: body.keys || [], exp: now + ttl * 1000 };
  if (env.KV) { try { await env.KV.put('google:jwks', JSON.stringify(memJwks), { expirationTtl: ttl }); } catch {} }
  return memJwks.keys;
}

// 驗證成功回傳 token 內容（sub、email…）；失敗丟出 401
export async function verifyGoogleToken(env, token) {
  if (!env.GOOGLE_CLIENT_ID) fail(500, 'not_configured', 'GOOGLE_CLIENT_ID');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) fail(401, 'invalid_token');
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch { fail(401, 'invalid_token'); }
  if (header.alg !== 'RS256' || !header.kid) fail(401, 'invalid_token');

  let jwk = (await getKeys(env, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(env, true)).find(k => k.kid === header.kid);   // Google 換了金鑰
  if (!jwk) fail(401, 'invalid_token');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) fail(401, 'invalid_token');

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(payload.iss)) fail(401, 'invalid_token');
  if (payload.aud !== env.GOOGLE_CLIENT_ID) fail(401, 'invalid_token');
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) fail(401, 'expired');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) fail(401, 'invalid_token');
  if (!payload.sub) fail(401, 'invalid_token');
  return payload;
}

export function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// 只有房主（OWNER_EMAILS 白名單裡、email 已驗證的帳號）能通過
export async function requireOwner(env, request) {
  const t = bearer(request);
  if (!t) fail(401, 'unauthorized');
  const p = await verifyGoogleToken(env, t);
  const owners = String(env.OWNER_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!owners.length) fail(500, 'not_configured', 'OWNER_EMAILS');
  if (!p.email || p.email_verified !== true || !owners.includes(String(p.email).toLowerCase())) fail(403, 'not_owner');
  return p;
}
