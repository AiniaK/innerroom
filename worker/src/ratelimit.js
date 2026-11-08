// 頻率限制：用 KV 記錄最近 24 小時的送出時間。
// KV 免費方案每天只能寫 1000 次，所以每個對象只用一個鍵，而且只有「真的送出」才寫入。
// KV 不是即時同步，同時大量送出時可能放過幾則；另外加上每個 Worker 執行個體裡的記憶體計數擋短時間灌水。
import { fail } from './util.js';

const mem = new Map();   // key → [時間…]（同一個執行個體內）

export const LIMITS = {
  ip: [[10 * 60e3, 3], [24 * 3600e3, 15]],         // 每個 IP：10 分鐘 3 則、一天 15 則
  account: [[10 * 60e3, 5], [24 * 3600e3, 30]],    // 每個 Google 帳號：10 分鐘 5 則、一天 30 則
  edit: [[10 * 60e3, 10], [24 * 3600e3, 40]],      // 每個 Google 帳號編輯：10 分鐘 10 次、一天 40 次
};

async function load(env, key) {
  const now = Date.now();
  let list = mem.get(key) || [];
  // 記憶體和 KV 各有一份紀錄，取比較完整（比較長）的那份；不要用去重合併，同一毫秒的兩次送出會被當成一次
  if (env.KV) { try { const kv = await env.KV.get(key, 'json'); if (Array.isArray(kv) && kv.length > list.length) list = kv; } catch {} }
  return list.filter(t => now - t < 24 * 3600e3);
}

// 檢查所有規則；全部通過才回傳一個 commit()，送出成功後再呼叫它記錄
export async function checkLimits(env, rules) {
  const now = Date.now(), loaded = [];
  for (const { key, limits } of rules) {
    const list = await load(env, key);
    for (const [win, max] of limits) {
      if (list.filter(t => now - t < win).length >= max) fail(429, 'rate_limited');
    }
    loaded.push({ key, list });
  }
  return async () => {
    for (const { key, list } of loaded) {
      const next = list.concat([now]).slice(-100);
      mem.set(key, next);
      if (env.KV) { try { await env.KV.put(key, JSON.stringify(next), { expirationTtl: 24 * 3600 + 60 }); } catch (e) { console.error('KV put failed', key, e && e.message); } }
    }
  };
}
