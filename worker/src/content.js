// 檢查後台送來的 content.json：只接受房間認得的欄位、合理的型別和長度
import { fail } from './util.js';
import { isMediaRef } from './github.js';

const SAFE_LINK = /^https:\/\/(www\.|music\.|m\.)?(youtube\.com|youtu\.be|open\.spotify\.com|spotify\.link)\/[^\s"'<>]*$/i;
export const SECTION_NAMES = ['物件說明', '展品', '房間設定', '影片與音樂'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY = /^[A-Za-z0-9_:-]{1,40}$/;

function str(v, max, field) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) fail(400, 'invalid_content', field);
  return v;
}
function num(v, min, max, field) {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(400, 'invalid_content', field);
  return v;
}
function bool(v, field) {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(400, 'invalid_content', field);
  return v;
}
const prune = o => { Object.keys(o).forEach(k => o[k] === undefined && delete o[k]); return o; };

export function validateContent(c) {
  if (!isObj(c)) fail(400, 'invalid_content', 'root');
  const out = {};

  // 物件說明與火勢
  const t = c.texts;
  if (!isObj(t) || !isObj(t.items)) fail(400, 'invalid_content', 'texts');
  const items = {};
  for (const [k, v] of Object.entries(t.items)) {
    if (!KEY.test(k) || !isObj(v)) fail(400, 'invalid_content', 'texts.items');
    items[k] = prune({ t: str(v.t, 80, k + '.t'), b: str(v.b, 1600, k + '.b'), h: str(v.h, 80, k + '.h'), pop: bool(v.pop, k + '.pop'), hov: bool(v.hov, k + '.hov') });
  }
  if (Object.keys(items).length > 300) fail(400, 'invalid_content', 'texts.items');
  out.texts = { items, fire: num(t.fire, 0, 100, 'texts.fire') ?? 50 };

  // 展品
  const ex = c.exhibits;
  if (!isObj(ex) || !isObj(ex.items)) fail(400, 'invalid_content', 'exhibits');
  const exItems = {};
  for (const [id, s] of Object.entries(ex.items)) {
    if (!KEY.test(id) || !isObj(s)) fail(400, 'invalid_content', 'exhibits.items');
    if (s.mode !== undefined && !['hang', 'lean'].includes(s.mode)) fail(400, 'invalid_content', id + '.mode');
    exItems[id] = prune({
      kind: str(s.kind, 40, id + '.kind'), title: str(s.title, 80, id + '.title'), desc: str(s.desc, 1600, id + '.desc'),
      hidden: bool(s.hidden, id + '.hidden'), popup: bool(s.popup, id + '.popup'), hover: bool(s.hover, id + '.hover'),
      mode: s.mode, along: num(s.along, -10, 10, id + '.along'), height: num(s.height, 0, 5, id + '.height'), scale: num(s.scale, .05, 10, id + '.scale'),
    });
  }
  if (Object.keys(exItems).length > 100) fail(400, 'invalid_content', 'exhibits.items');
  out.exhibits = { items: exItems };

  // 電視
  if (c.tv === null || c.tv === undefined) out.tv = null;
  else {
    const v = c.tv;
    if (!isObj(v) || !isMediaRef(v.src)) fail(400, 'invalid_content', 'tv.src');
    const view = isObj(v.view) ? v.view : {};
    if (view.fit !== undefined && !['auto', 'contain', 'center35', 'cover'].includes(view.fit)) fail(400, 'invalid_content', 'tv.view.fit');
    out.tv = prune({
      src: v.src, name: str(v.name, 200, 'tv.name'), updatedAt: num(v.updatedAt, 0, 1e15, 'tv.updatedAt'),
      view: prune({ fit: view.fit, scale: num(view.scale, 10, 400, 'tv.view.scale'), offX: num(view.offX, -200, 200, 'tv.view.offX'), offY: num(view.offY, -200, 200, 'tv.view.offY'), blur: bool(view.blur, 'tv.view.blur') }),
    });
  }

  // 平板音樂
  const m = isObj(c.music) ? c.music : {};
  const tracks = Array.isArray(m.tracks) ? m.tracks : [];
  const links = Array.isArray(m.links) ? m.links : [];
  if (tracks.length > 60 || links.length > 60) fail(400, 'invalid_content', 'music');
  out.music = {
    tracks: tracks.map((x, i) => {
      if (!isObj(x) || !isMediaRef(x.src)) fail(400, 'invalid_content', `music.tracks[${i}].src`);
      if (x.kind !== undefined && !['audio', 'video'].includes(x.kind)) fail(400, 'invalid_content', `music.tracks[${i}].kind`);
      if (x.cover !== undefined && !isMediaRef(x.cover)) fail(400, 'invalid_content', `music.tracks[${i}].cover`);
      return prune({ src: x.src, kind: x.kind, name: str(x.name, 120, `music.tracks[${i}].name`), cover: x.cover });
    }),
    links: links.map((l, i) => {
      if (!isObj(l) || typeof l.url !== 'string' || l.url.length > 400 || !SAFE_LINK.test(l.url)) fail(400, 'invalid_content', `music.links[${i}].url`);
      return prune({ title: str(l.title, 120, `music.links[${i}].title`), url: l.url });
    }),
  };

  out.savedAt = num(c.savedAt, 0, 1e15, 'savedAt') ?? Date.now();
  return out;
}

export function commitMessage(sections) {
  const s = (Array.isArray(sections) ? sections : []).filter(x => SECTION_NAMES.includes(x));
  return '後台更新：' + (s.length ? [...new Set(s)].join('、') : '房間內容');
}
