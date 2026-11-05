// 共用小工具：回應格式、CORS、錯誤、編碼

export class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
export const fail = (status, code, detail) => { throw new HttpError(status, code, detail); };

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
export function corsHeaders(env, origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
}

export async function readJSON(request, maxBytes) {
  const len = +(request.headers.get('content-length') || 0);
  if (len > maxBytes) fail(413, 'too_large');
  const text = await request.text();
  if (text.length > maxBytes) fail(413, 'too_large');
  try { return JSON.parse(text); } catch { fail(400, 'bad_json'); }
}

// UTF-8 字串 ↔ base64（只用在小檔案，例如 content.json）
export function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
export function base64UrlToBytes(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - b.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// 用 Worker 的 HASH_SECRET 做 HMAC，讓 Google ID、IP 變成無法還原的代號
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 純文字清理：去掉控制字元和看不見的字元，統一換行
export function cleanText(s, { maxLen, maxLines = 1 }) {
  let t = String(s ?? '').normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '');
  if (maxLines <= 1) t = t.replace(/\n+/g, ' ');
  else t = t.split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  const lines = t.split('\n');
  if (lines.length > maxLines) t = lines.slice(0, maxLines).join('\n');
  return [...t].length > maxLen ? null : t;   // 太長就回傳 null，由呼叫的地方回報錯誤
}

export const clientIP = request => request.headers.get('CF-Connecting-IP') || '0.0.0.0';
