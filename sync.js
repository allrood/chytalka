'use strict';
/* =========================================================
   Синхронізація через Dropbox (ПК ↔ телефон)
   У Dropbox, у папці додатка (та сама, що й у «Звичок»):
     /reader/state.json        — бібліотека, прогрес, статистика, слова, частина налаштувань
     /reader/books/<id>.json   — текст книжки (завантажується один раз)
     /reader/tr/<id>.json      — збережені переклади абзаців книжки
   ========================================================= */
const DBX_APP_KEY = 'w6r9zuk8fksychq';
const DBX_ROOT = '/reader';
const SYNC_SET = ['goalType','goalPages','goalMin','yearGoal','banal','minCount','exportFmt','exportLimit','trProvider','wordProvider','aiProvider','geminiModel','claudeModel'];
const WEB_URL = 'https://allrood.github.io/chytalka/';
let sync = {};                 // { refresh, access, exp, last, err, status, verifier, authUrl, tr:{id:rev}, books:{id:1} }
let syncBusy = false, syncAgain = false, syncTimer = null, lastAutoSync = 0, showLink = false;

const canon = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
const same = (a, b) => canon(a) === canon(b);
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const FORM = { 'Content-Type':'application/x-www-form-urlencoded' };
const form = o => new URLSearchParams(o).toString();
const hhmm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

async function syncLoad(){
  sync = await api.read('sync') || {};
  sync.refresh = await api.getSecret('dbx-refresh') || '';
  sync.status = null;
}
function syncSave(){ const { refresh, access, status, ...rest } = sync; api.write('sync', rest); }
async function setRefresh(r){ sync.refresh = r || ''; sync.access = null; await api.setSecret('dbx-refresh', r || ''); syncSave(); }

/* ---------- що синхронізується ---------- */
function snap(){
  const s = {}; SYNC_SET.forEach(k => { if (settings[k] !== undefined) s[k] = settings[k]; });
  return JSON.parse(JSON.stringify({ v:1, books:library.books, days:stats.days, words, settings:s }));
}
const isFresh = () => !Object.keys(stats.days).length && !Object.keys(words.star).length && !Object.keys(words.known).length && library.books.every(b => !b.read);

const addN = (b, l, r) => Math.max(0, (b || 0) + ((l || 0) - (b || 0)) + ((r || 0) - (b || 0)));
// тристороннє злиття словника: змінене лише з одного боку — береться ця зміна; змінене з обох — both() або локальне
function merge3(b, l, r, both){
  b = b || {}; l = l || {}; r = r || {};
  const out = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    const bv = b[k], lv = l[k], rv = r[k];
    let v;
    if (same(lv, rv)) v = lv; else if (same(lv, bv)) v = rv; else if (same(rv, bv)) v = lv;
    else v = both ? both(bv, lv, rv) : lv;
    if (v !== undefined) out[k] = v;
  }
  return out;
}
function mergeBook(b, l, r){
  if (!l || !r) return l || r;                       // видалено з одного боку, але змінено з іншого — залишаємо
  const newer = (r.last || '') > (l.last || '') ? r : l;
  const o = merge3(b, l, r, (bv, lv, rv) => newer === r ? rv : lv);
  o.read = Math.max(l.read || 0, r.read || 0);
  o.secs = b ? addN(b.secs, l.secs, r.secs) : Math.max(l.secs || 0, r.secs || 0);
  o.pos = newer.pos; o.last = newer.last;
  return o;
}
function mergeAll(base, local, remote){
  const B = base || {}, noBase = !base;
  const bm = x => Object.fromEntries((x.books || []).map(k => [k.id, k]));
  const kept = merge3(bm(B), bm(local), bm(remote), mergeBook);
  const order = [...(local.books || []), ...(remote.books || [])].map(k => k.id).filter((id, i, a) => kept[id] && a.indexOf(id) === i);
  const dayBoth = (bv, lv, rv) => noBase ? { c:Math.max(lv?.c || 0, rv?.c || 0), s:Math.max(lv?.s || 0, rv?.s || 0) } : { c:addN(bv?.c, lv?.c, rv?.c), s:addN(bv?.s, lv?.s, rv?.s) };
  const W = x => x.words || {};
  return {
    v:1,
    books: order.map(id => kept[id]),
    days: merge3(B.days, local.days, remote.days, dayBoth),
    words: { known:merge3(W(B).known, W(local).known, W(remote).known), star:merge3(W(B).star, W(local).star, W(remote).star), uk:merge3(W(B).uk, W(local).uk, W(remote).uk) },
    settings: merge3(B.settings, local.settings, remote.settings)
  };
}
// одна й та сама книжка, додана на різних пристроях окремо (напр. вбудована тестова), має різні id — зливаємо в одну
const bookKey = b => [String(b.title || '').trim().toLowerCase(), String(b.author || '').trim().toLowerCase(), b.chars || 0].join('|');
function dedupe(m){
  const byKey = {}, remap = {};
  const keepOf = (a, b) => (a.added || '9') < (b.added || '9') || ((a.added || '') === (b.added || '') && a.id < b.id) ? [a, b] : [b, a];
  const books = [];
  for (const b of m.books) {
    const k = bookKey(b), o = byKey[k];
    if (!o) { byKey[k] = b; books.push(b); continue; }
    const [keep, drop] = keepOf(o, b), newer = (drop.last || '') > (keep.last || '') ? drop : keep;
    const merged = { ...keep, read:Math.max(keep.read || 0, drop.read || 0), secs:(keep.secs || 0) + (drop.secs || 0), pos:newer.pos, last:newer.last, finished:keep.finished || drop.finished };
    books[books.indexOf(o)] = merged; byKey[k] = merged; remap[drop.id] = keep.id;
  }
  m.books = books;
  return remap;
}
// застосувати злитий стан на цьому пристрої
async function adopt(m, remap){
  // переклади і відкриту книжку з дубля переносимо на книжку, яка залишилась
  for (const [from, to] of Object.entries(remap || {})) {
    const a = await api.read('tr-' + from), c = cur && cur.meta.id === from ? cur.tr : null;
    if (a || c) { const t = { ...(await api.read('tr-' + to) || {}), ...(a || {}), ...(c || {}) }; await api.write('tr-' + to, t); if (c) cur.tr = t; }
    if (!(await api.read('book-' + to))) { const bk = await api.read('book-' + from); if (bk) await api.write('book-' + to, { ...bk, id:to }); }
    if (cur && cur.meta.id === from) { const nb = m.books.find(b => b.id === to); if (nb) { const keepPos = cur.meta.pos; cur.meta = Object.assign(library.books.find(b => b.id === to) || {}, nb); cur.meta.pos = nb.pos || keepPos; } }
    if (vocabBookId === from) vocabBookId = to;
  }
  const old = Object.fromEntries(library.books.map(b => [b.id, b]));
  if (cur && !old[cur.meta.id]) old[cur.meta.id] = cur.meta;
  const prevPos = cur ? canon(cur.meta.pos) : null;
  library.books = m.books.map(b => old[b.id] ? Object.assign(old[b.id], b) : b);
  for (const id in old) if (!m.books.some(b => b.id === id)) { api.remove('book-' + id); api.remove('tr-' + id); if (cur && cur.meta.id === id) { cur = null; if (view === 'reader') view = 'home'; } }
  stats.days = m.days; words.known = m.words.known || {}; words.star = m.words.star || {}; words.uk = m.words.uk || {};
  Object.assign(settings, m.settings || {});
  api.write('library', library); api.write('stats', stats); api.write('words', words); api.write('settings', settings);
  vocabCache = {};
  return prevPos !== null && cur && canon(cur.meta.pos) !== prevPos;
}

/* ---------- Dropbox ---------- */
async function dbx(url, o){
  const r = await api.http({ url, method:'POST', headers:o.headers, body:o.body });
  if (r.status === 0) throw new Error('немає інтернету або Dropbox недоступний');
  return r;
}
async function dbxToken(){
  if (sync.access && Date.now() < sync.exp) return sync.access;
  const r = await dbx('https://api.dropboxapi.com/oauth2/token', { headers:FORM, body:form({ grant_type:'refresh_token', refresh_token:sync.refresh, client_id:DBX_APP_KEY }) });
  let j = {}; try { j = JSON.parse(r.text); } catch (e) {}
  if (!r.ok) { if (j.error === 'invalid_grant') { await setRefresh(''); throw new Error('доступ до Dropbox скасовано, підключи ще раз'); } throw new Error(j.error_description || j.error || ('HTTP ' + r.status)); }
  sync.access = j.access_token; sync.exp = Date.now() + ((j.expires_in || 14400) - 120) * 1000;
  return sync.access;
}
const auth = async () => ({ Authorization:'Bearer ' + await dbxToken() });
async function dbxGet(path){
  const r = await dbx('https://content.dropboxapi.com/2/files/download', { headers:{ ...await auth(), 'Dropbox-API-Arg':JSON.stringify({ path }) } });
  if (r.status === 409 && r.text.includes('not_found')) return null;
  if (!r.ok) throw new Error('Dropbox: HTTP ' + r.status + ' ' + r.text.slice(0, 120));
  let rev = null; try { rev = JSON.parse(r.headers['dropbox-api-result']).rev; } catch (e) {}
  return { data:JSON.parse(r.text), rev };
}
async function dbxPut(path, obj, rev){
  const mode = rev ? { '.tag':'update', update:rev } : 'overwrite';
  const r = await dbx('https://content.dropboxapi.com/2/files/upload', { headers:{ ...await auth(), 'Content-Type':'application/octet-stream', 'Dropbox-API-Arg':JSON.stringify({ path, mode, autorename:false, mute:true }) }, body:JSON.stringify(obj) });
  if (r.status === 409) return { conflict:true };
  if (!r.ok) throw new Error('Dropbox: HTTP ' + r.status + ' ' + r.text.slice(0, 120));
  return { rev:JSON.parse(r.text).rev };
}
async function dbxList(path){
  const out = {};
  let r = await dbx('https://api.dropboxapi.com/2/files/list_folder', { headers:{ ...await auth(), 'Content-Type':'application/json' }, body:JSON.stringify({ path }) });
  for (;;) {
    if (r.status === 409) return out;              // папки ще немає
    if (!r.ok) throw new Error('Dropbox: HTTP ' + r.status);
    const j = JSON.parse(r.text);
    j.entries.forEach(e => { if (e['.tag'] === 'file') out[e.name.replace(/\.json$/, '')] = e.rev; });
    if (!j.has_more) return out;
    r = await dbx('https://api.dropboxapi.com/2/files/list_folder/continue', { headers:{ ...await auth(), 'Content-Type':'application/json' }, body:JSON.stringify({ cursor:j.cursor }) });
  }
}
async function dbxDelete(path){ try { await dbx('https://api.dropboxapi.com/2/files/delete_v2', { headers:{ ...await auth(), 'Content-Type':'application/json' }, body:JSON.stringify({ path }) }); } catch (e) {} }

/* ---------- синхронізація ---------- */
async function syncNow(manual){
  if (!sync.refresh) return;
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true; sync.status = 'busy'; paintSync();
  try {
    if (view === 'reader') trackRead();
    // 1) стан
    let merged = null;
    for (let tries = 0; tries < 4; tries++) {
      const local = snap(), base = await api.read('sync-base');
      const remote = await dbxGet(DBX_ROOT + '/state.json');
      if (!remote) merged = local;
      else if (!base && isFresh()) merged = JSON.parse(JSON.stringify(remote.data));   // новий пристрій — беремо все з Dropbox
      else merged = mergeAll(base, local, remote.data);
      const remap = dedupe(merged);
      if (!remote || !same(merged, remote.data)) {
        const u = await dbxPut(DBX_ROOT + '/state.json', merged, remote && remote.rev);
        if (u.conflict) { merged = null; continue; }
      }
      // якщо поки ми синхронізувались тут щось змінилось — доливаємо ці зміни
      const now = snap(), final = same(now, local) ? merged : mergeAll(local, now, merged);
      if (final !== merged) syncAgain = true;
      if (final !== merged) Object.assign(remap, dedupe(final));
      const moved = await adopt(final, remap);
      await api.write('sync-base', merged);
      if (moved && view === 'reader') { renderReader(); toast('📖 Відкрито місце, де ти зупинився на іншому пристрої', 3500); } else if (view !== 'reader') render(); else updatePills();
      break;
    }
    if (!merged) throw new Error('не вдалося записати в Dropbox (конфлікт), спробую ще раз');
    // 2) тексти книжок: відсутні на пристрої — завантажити; відсутні в Dropbox — вивантажити
    const remoteBooks = await dbxList(DBX_ROOT + '/books');
    sync.books = sync.books || {};
    for (const b of library.books) {
      const have = await api.read('book-' + b.id);
      if (!have && remoteBooks[b.id]) { const g = await dbxGet(`${DBX_ROOT}/books/${b.id}.json`); if (g) await api.write('book-' + b.id, g.data); }
      else if (have && !remoteBooks[b.id]) await dbxPut(`${DBX_ROOT}/books/${b.id}.json`, have);
    }
    for (const id in remoteBooks) if (!library.books.some(b => b.id === id) && sync.books[id]) { await dbxDelete(`${DBX_ROOT}/books/${id}.json`); await dbxDelete(`${DBX_ROOT}/tr/${id}.json`); }
    sync.books = Object.fromEntries(library.books.map(b => [b.id, 1]));
    // 3) переклади абзаців: об'єднання
    const remoteTr = await dbxList(DBX_ROOT + '/tr');
    sync.tr = sync.tr || {}; sync.trN = sync.trN || {};
    for (const b of library.books) {
      const id = b.id, local = (cur && cur.meta.id === id ? cur.tr : await api.read('tr-' + id)) || {};
      const n = Object.keys(local).length;
      const dirty = (sync.trDirty || {})[id];
      if (remoteTr[id] === sync.tr[id] && n === sync.trN[id] && !dirty) continue;   // нічого нового
      let all = local, rev = remoteTr[id] || null, remoteN = remoteTr[id] ? (sync.trN[id] || 0) : 0;
      if (remoteTr[id] && remoteTr[id] !== sync.tr[id]) {
        const g = await dbxGet(`${DBX_ROOT}/tr/${id}.json`);
        if (g) { all = { ...g.data, ...local }; rev = g.rev; remoteN = Object.keys(g.data).length; }
      }
      const total = Object.keys(all).length;
      if (total !== n) { if (cur && cur.meta.id === id) { Object.assign(cur.tr, all); if (view === 'reader' && settings.parallel) renderReader(); } await api.write('tr-' + id, all); }
      if (total > remoteN || dirty) { const u = await dbxPut(`${DBX_ROOT}/tr/${id}.json`, all, rev); if (u.conflict) { syncAgain = true; continue; } rev = u.rev; }
      sync.tr[id] = rev; sync.trN[id] = total; if (sync.trDirty) delete sync.trDirty[id];
    }
    sync.last = Date.now(); sync.err = null; sync.status = 'ok';
  } catch (e) {
    sync.status = 'err'; sync.err = String(e.message || e);
    if (manual) toast('Синхронізація не вдалася: ' + sync.err, 5000);
  } finally {
    syncBusy = false; syncSave(); paintSync();
    if (syncAgain) { syncAgain = false; scheduleSync(1500); }
  }
}
// після змін — не частіше ніж раз на 2 хв; місце читання відправляється одразу, коли згортаєш/перемикаєш вікно, і підтягується, коли повертаєшся
let syncDue = 0;
function scheduleSync(ms){
  if (!sync.refresh) return;
  const due = Date.now() + (ms || 120000);
  if (syncTimer && syncDue <= due) return;
  clearTimeout(syncTimer); syncDue = due;
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(false); }, due - Date.now());
}
function autoSync(){ if (sync.refresh && Date.now() - lastAutoSync > 60000) { lastAutoSync = Date.now(); syncNow(false); } }
window.addEventListener('focus', autoSync);
// повернулись у програму — одразу підтягуємо місце з іншого пристрою; згорнули — одразу відправляємо своє
function pushNow(){ if (!sync.refresh) return; if (view === 'reader') savePos(); clearTimeout(syncTimer); syncTimer = null; syncNow(false); }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (sync.refresh) { lastAutoSync = Date.now(); syncNow(false); } }
  else pushNow();
});
window.addEventListener('pagehide', pushNow);
window.addEventListener('blur', () => { if (view === 'reader' && cur && Date.now() - (sync.last || 0) > 5000) pushNow(); });
setInterval(() => { if (sync.refresh && !syncBusy) syncNow(false); }, 15 * 60000);

// книжка є в бібліотеці, але текст ще не завантажено на цей пристрій
async function fetchBookText(id){
  if (!sync.refresh) return null;
  toast('Завантажую книжку з Dropbox…', 20000);
  try { const g = await dbxGet(`${DBX_ROOT}/books/${id}.json`); if (!g) return null; await api.write('book-' + id, g.data); toast('Готово'); return g.data; }
  catch (e) { toast('Не вдалося завантажити книжку: ' + e.message, 5000); return null; }
}

/* ---------- підключення ---------- */
let pkce = null;
async function preparePkce(){
  try { const v = b64url(crypto.getRandomValues(new Uint8Array(48))); pkce = { v, ch:b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))) }; } catch (e) { pkce = null; }
}
function dbxStartAuth(){
  if (!pkce) { toast('Зачекай секунду й натисни ще раз'); preparePkce(); return; }
  sync.verifier = pkce.v;
  sync.authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${DBX_APP_KEY}&response_type=code&code_challenge=${pkce.ch}&code_challenge_method=S256&token_access_type=offline`;
  pkce = null; preparePkce(); syncSave();
  api.openUrl(sync.authUrl); paintSync();
}
async function dbxFinishAuth(){
  const code = ($('#dbxCodeInp')?.value || '').trim();
  if (!code) { toast('Встав код з Dropbox'); return; }
  if (/^(RD1|HZ1)\./.test(code)) { joinByCode(code); return; }
  const r = await dbx('https://api.dropboxapi.com/oauth2/token', { headers:FORM, body:form({ code, grant_type:'authorization_code', client_id:DBX_APP_KEY, code_verifier:sync.verifier }) }).catch(e => ({ ok:false, text:e.message }));
  let j = {}; try { j = JSON.parse(r.text); } catch (e) {}
  if (!r.ok || !j.refresh_token) { toast('Dropbox не прийняв код: ' + (j.error_description || j.error || r.text || '').slice(0, 120), 5000); return; }
  delete sync.verifier; delete sync.authUrl;
  await setRefresh(j.refresh_token); sync.access = j.access_token; sync.exp = Date.now() + ((j.expires_in || 14400) - 120) * 1000;
  toast('Dropbox підключено'); syncNow(true);
}
async function linkCode(withKeys){
  const o = { k:DBX_APP_KEY, r:sync.refresh };
  if (withKeys) { const g = await api.getSecret('gemini'); if (g) o.g = g; }
  return 'RD1.' + b64url(new TextEncoder().encode(JSON.stringify(o)));
}
// RD1 — код читалки (може містити ключ Gemini), HZ1 — код зі «Звичок» (той самий Dropbox)
async function joinByCode(given){
  const raw = String(given || [...document.querySelectorAll('.linkInp')].map(i => i.value).find(v => v.trim()) || '').replace(/\s+/g, '');
  const m = raw.match(/(RD1|HZ1)\.([A-Za-z0-9_-]+)/);
  let o;
  try {
    if (!m) throw 0;
    const b = atob(m[2].replace(/-/g, '+').replace(/_/g, '/'));
    o = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))));
    if (!o.r || (o.k && o.k !== DBX_APP_KEY)) throw 0;
  } catch (e) { toast(raw ? 'Код обрізаний або не той. Скопіюй його на ПК ще раз повністю (RD1.… або HZ1.…)' : 'Встав код з комп\'ютера', 5000); return false; }
  if (o.g && !(await api.getSecret('gemini'))) await api.setSecret('gemini', o.g);
  await setRefresh(o.r); delete sync.verifier; syncSave();
  toast('Підключаю…', 8000); await syncNow(true);
  paintJoin(); if (view === 'settings') renderSettings(); else render();
  if (sync.status === 'ok') toast('✓ Синхронізацію підключено', 3000);
  return true;
}

/* ---------- вигляд ---------- */
function syncPanelBody(){
  if (sync.refresh) return `<div class="cap">Бібліотека, прогрес, слова, статистика й переклади зберігаються ще й у твоєму Dropbox, тож ПК і телефон бачать одне й те саме.</div>
    <div class="row"><span>${sync.status === 'busy' ? '⏳ Синхронізую…' : sync.status === 'err' ? '⚠ ' + esc(sync.err || '') : sync.last ? '✓ Остання синхронізація о ' + hhmm(sync.last) : 'Ще не синхронізовано'}</span><div class="spacer"></div>
      <button class="btn primary" data-act="dbxsync">Синхронізувати зараз</button><button class="btn" data-act="dbxoff">Відключити</button></div>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="dbxlink">📱 Підключити телефон</button></div>
    ${showLink ? `<div class="syncbox"><b>Як підключити телефон</b><ol><li>Натисни «Скопіювати посилання» і перешли його собі на телефон (наприклад, у «Збережене» в Telegram).</li><li>На iPhone відкрий посилання в Safari. Читалка підключиться сама.</li><li>Потім «Поділитися» → «На початковий екран», щоб читалка була як програма.</li></ol>
      <label class="row hint" style="gap:6px;margin-bottom:6px"><input type="checkbox" id="linkKeys" checked> передати й ключ Gemini, щоб не вводити його на телефоні</label>
      <div class="row"><button class="btn primary" data-act="dbxcopylink">Скопіювати посилання</button><button class="btn" data-act="dbxcopy">Лише код</button><button class="btn plain" data-act="dbxlinkhide">Сховати</button></div>
      <div class="hint" style="margin-top:6px">Посилання дає доступ до папки читалки у твоєму Dropbox. Не пересилай його іншим людям.</div></div>` : ''}`;
  if (sync.verifier) return `<div class="syncbox"><b>Крок 2 з 2</b><ol><li>У вікні Dropbox натисни «Allow / Дозволити». Якщо вікно не відкрилося, натисни «Відкрити сторінку Dropbox».</li><li>Скопіюй код, який покаже Dropbox, і встав сюди.</li></ol>
    <div class="row"><input class="inp" id="dbxCodeInp" placeholder="Код з Dropbox" style="flex:1;min-width:180px"><button class="btn primary" data-act="dbxcode">Підключити</button></div>
    <div class="row" style="margin-top:6px"><button class="btn" data-act="dbxopen">Відкрити сторінку Dropbox</button><button class="btn plain" data-act="dbxcancel">Скасувати</button></div></div>`;
  return `<div class="cap">Щоб книжки, прогрес і слова були однакові на ПК і на телефоні. Дані лежатимуть у твоєму Dropbox, у папці «Програми». Безкоштовно.</div>
    <div class="row"><button class="btn primary" data-act="dbxauth">Підключити Dropbox</button></div>
    <div class="syncbox"><b>Уже є код або посилання з іншого пристрою?</b><div class="hint" style="margin:4px 0 8px">Підходить код читалки (RD1.…) і код зі «Звичок» (HZ1.…): вони користуються тим самим Dropbox.</div>
      <div class="row"><input class="inp linkInp" id="linkInp" placeholder="RD1.… або HZ1.…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="flex:1;min-width:180px"><button class="btn primary" data-act="dbxjoin">Підключити</button></div>
      ${navigator.clipboard && navigator.clipboard.readText ? '<div class="row" style="margin-top:6px"><button class="btn" data-act="dbxpaste">📋 Вставити з буфера й підключити</button></div>' : ''}</div>`;
}
function paintSync(){
  const p = $('#syncPill');
  if (p) {
    const st = !sync.refresh ? 'off' : sync.status;
    p.className = 'pill sync ' + (st === 'busy' ? 'busy' : st === 'err' ? 'err' : (sync.last && Date.now() - sync.last < 4000) ? 'ok' : '');
    p.innerHTML = '<span class="sico">⟳</span><span class="stx">' + (st === 'off' ? 'Синхронізація' : st === 'busy' ? 'Синхронізую…' : st === 'err' ? 'Помилка' : sync.last ? (Date.now() - sync.last < 4000 ? 'Готово ✓' : hhmm(sync.last)) : 'Синхронізувати') + '</span>';
    p.title = st === 'off' ? 'Підключити синхронізацію з Dropbox' : st === 'err' ? 'Синхронізація не вдалася: ' + (sync.err || '') + '. Натисни, щоб спробувати ще раз' : 'Натисни, щоб синхронізувати зараз';
    clearTimeout(paintSync.t); if (p.classList.contains('ok')) paintSync.t = setTimeout(paintSync, 4100);
  }
  const sp = $('#syncPanel');
  if (sp && !(sp.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) sp.innerHTML = '<h3>☁ Синхронізація з телефоном</h3>' + syncPanelBody();
}
async function syncAction(a){
  switch (a) {
    case 'syncpill': if (sync.refresh) syncNow(true); else { go('settings'); setTimeout(() => $('#syncPanel')?.scrollIntoView({ block:'center' }), 50); } return true;
    case 'dbxauth': dbxStartAuth(); return true;
    case 'dbxopen': if (sync.authUrl) api.openUrl(sync.authUrl); return true;
    case 'dbxcode': dbxFinishAuth(); return true;
    case 'dbxcancel': delete sync.verifier; syncSave(); paintSync(); return true;
    case 'dbxsync': syncNow(true); return true;
    case 'dbxlink': showLink = true; paintSync(); return true;
    case 'dbxlinkhide': showLink = false; paintSync(); return true;
    case 'dbxjoin': joinByCode(); return true;
    case 'dbxpaste': try { const t = await navigator.clipboard.readText(); if (/(RD1|HZ1)\./.test(t || '')) joinByCode(t); else toast('У буфері немає коду. Скопіюй посилання чи код на ПК ще раз', 5000); } catch (e) { toast('Не вдалося прочитати буфер. Встав код у поле вручну (натисни в полі → «Вставити»)', 5000); } return true;
    case 'joinhide': try { sessionStorage.setItem('chytalka-joinhide', '1'); } catch (e) {} paintJoin(); return true;
    case 'copycode': { const c = pendingCode; if (c) { await api.copy(c); toast('Код скопійовано. Тепер додай читалку на початковий екран', 4000); } return true; }
    case 'dbxcopy': await api.copy(await linkCode($('#linkKeys')?.checked)); toast('Код скопійовано'); return true;
    case 'dbxcopylink': await api.copy(WEB_URL + '#' + await linkCode($('#linkKeys')?.checked)); toast('Посилання скопійовано. Перешли його собі на телефон', 4000); return true;
    case 'dbxoff': if (confirm('Відключити синхронізацію на цьому пристрої? Дані тут і в Dropbox залишаться.')) { await setRefresh(''); sync = {}; syncSave(); api.remove('sync-base'); paintSync(); toast('Синхронізацію вимкнено'); } return true;
  }
  return false;
}
/* ---------- телефон: програма з іконки має окреме від Safari сховище ---------- */
const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
let pendingCode = '';
// на веб-версії без підключення — помітна плашка з полем для коду
function paintJoin(){
  const b = $('#joinSlot'); if (!b || !appInfo.web) return;
  let hide = false; try { hide = sessionStorage.getItem('chytalka-joinhide') === '1'; } catch (e) {}
  if (pendingCode && !standalone() && isPhone()) {
    b.innerHTML = `<div class="joinbox"><b>✓ Підключено в Safari. Тепер зроби читалку програмою:</b>
      <ol><li>Натисни «Скопіювати код» нижче.</li><li>«Поділитися» <span class="hint">(квадрат зі стрілкою)</span> → «На початковий екран».</li><li>Відкрий читалку з іконки й натисни «📋 Вставити з буфера й підключити». Програма з іконки має окреме сховище, тому її треба підключити ще раз.</li></ol>
      <div class="row"><button class="btn primary" data-act="copycode">Скопіювати код</button><button class="btn plain" data-act="joinhide">Сховати</button></div></div>`;
    return;
  }
  if (!sync.refresh && !hide) {
    b.innerHTML = `<div class="joinbox"><b>☁ Синхронізацію з ПК не підключено</b><div class="hint" style="margin:3px 0 8px">На ПК: читалка → ⟳ → «📱 Підключити телефон» → «Лише код». Встав код сюди.</div>
      <div class="row"><input class="inp linkInp" placeholder="RD1.… або HZ1.…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="flex:1;min-width:150px"><button class="btn primary" data-act="dbxjoin">Підключити</button></div>
      <div class="row" style="margin-top:6px">${navigator.clipboard && navigator.clipboard.readText ? '<button class="btn" data-act="dbxpaste">📋 Вставити з буфера й підключити</button>' : ''}<button class="btn plain" data-act="joinhide">Пізніше</button></div></div>`;
    return;
  }
  b.innerHTML = '';
}
async function syncStart(){
  await syncLoad(); preparePkce();
  // посилання виду …/#RD1.… підключає пристрій одразу; код не йде на сервер і прибирається з адреси
  const m = location.hash.match(/(RD1|HZ1)\.[A-Za-z0-9_-]+/);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    pendingCode = m[0];
    if (!sync.refresh) { await joinByCode(m[0]); paintJoin(); return; }
  }
  paintSync(); paintJoin();
  if (sync.refresh) syncNow(false);
}
