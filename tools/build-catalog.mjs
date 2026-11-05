// 產生 data/catalog.json：後台需要的物件清單、預設文字、展品尺寸。
// 房間的物件或展品有變動時（改了 index.html），在專案資料夾執行：
//   node tools/build-catalog.mjs
// 需要 Node.js 22 以上和 Google Chrome。
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 只供這支工具使用的本機伺服器
const server = createServer(async (req, res) => {
  const path = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
  if (!path.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(path); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const debugPort = 9300 + Math.floor(Math.random() * 500);
const profile = await mkdtemp(join(tmpdir(), 'innerroom-catalog-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', url], { stdio: 'ignore' });

try {
  let ws;
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = pages.find(p => p.type === 'page' && p.url.startsWith('http://127.0.0.1'));
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error('打不開 Chrome');
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const evaluate = expression => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });

  let catalog = null;
  for (let i = 0; i < 60 && !catalog; i++) {
    const r = await evaluate('typeof window.__roomCatalog==="function"?JSON.stringify(window.__roomCatalog()):null');
    catalog = r.result && r.result.result && r.result.result.value;
    if (!catalog) await sleep(500);
  }
  if (!catalog) throw new Error('房間沒有載入完成，讀不到物件清單');
  const data = JSON.parse(catalog);
  await writeFile(join(ROOT, 'data/catalog.json'), JSON.stringify(data, null, 1) + '\n');
  console.log(`已寫入 data/catalog.json：${data.texts.length} 個物件、${Object.keys(data.exhibits).length} 件展品`);
  ws.close();
} finally {
  chrome.kill();
  server.close();
}
