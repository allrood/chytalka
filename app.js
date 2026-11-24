'use strict';
/* =========================================================
   Моя читалка — інтерфейс
   ========================================================= */
// window.api — міст до головного процесу (preload.js)
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const dkey = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
const todayKey = () => dkey(new Date());
const parseKey = k => { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const short = k => { const d = parseKey(k); return pad(d.getDate()) + '.' + pad(d.getMonth()+1); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmt = n => Math.round(n).toLocaleString('uk-UA');
const NORM = 1800;                       // 1 сторінка = 1800 знаків (Normseite)
const ART = { m:'der', f:'die', n:'das' };
const FUNC_POS = ['pron','det','article','prep','conj','particle','num','postp','contraction','intj','punct','symbol','character'];
const WORD_RE = /[A-Za-zÄÖÜäöüßẞÀ-ÖØ-öø-ÿ]+(?:[-'’][A-Za-zÄÖÜäöüßẞÀ-ÖØ-öø-ÿ]+)*/g;
const COVERS = ['#7c3aed','#0f766e','#b45309','#be123c','#1d4ed8','#4d7c0f','#a21caf','#0e7490'];

/* ---------- стан ---------- */
let D = {}, F = {};                     // словник і форми слів
let settings, library, stats, words, appInfo = {};
let view = 'home', cur = null;          // cur = { meta, book, offs, tr }
let vocabBookId = null, vocabScope = 'book', vocabCache = {};
let lastAct = Date.now();

const DEFAULTS = {
  goalType:'pages', goalPages:20, goalMin:30, yearGoal:12,
  banal:2000, minCount:2, exportFmt:'word', exportLimit:0,
  font:20, width:760, theme:'dark', parallel:false,
  trProvider:'deepl', wordProvider:'auto', claudeModel:'claude-haiku-5-5',
  aiProvider:'auto', geminiModel:'gemini-flash-latest'
};

async function loadAll(){
  settings = Object.assign({}, DEFAULTS, await api.read('settings') || {});
  if (settings.trProvider === 'claude') settings.trProvider = 'ai';
  if (settings.wordProvider === 'claude') settings.wordProvider = 'ai';
  library = await api.read('library') || { books:[] };
  stats = await api.read('stats') || { days:{} };
  readToday = await api.read('read-today') || readToday;
  words = await api.read('words') || { known:{}, star:{}, uk:{} };
  if (typeof loadSongs === 'function') await loadSongs();
  words.known = words.known || {}; words.star = words.star || {}; words.uk = words.uk || {};
}
const syncSoon = () => { if (typeof scheduleSync === 'function') scheduleSync(); };
const saver = (name, get) => { let t = null; return (now) => { clearTimeout(t); const f = () => api.write(name, get()).then(syncSoon); if (now) f(); else t = setTimeout(f, 800); }; };
const saveSettings = saver('settings', () => settings);
const saveLib = saver('library', () => library);
const saveStats = saver('stats', () => stats);
const saveWords = saver('words', () => words);
let saveTrT = null;
function saveTr(){ if (!cur) return; const id = cur.meta.id, tr = cur.tr; clearTimeout(saveTrT); saveTrT = setTimeout(() => api.write('tr-' + id, tr).then(syncSoon), 1200); }

function toast(msg, ms = 2200){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }

/* =========================================================
   Словник
   ========================================================= */
const cap1 = w => w ? w[0].toUpperCase() + w.slice(1) : w;
function lookup(w){
  const out = [];
  const add = (l, exact) => { if (D[l] && !out.some(x => x.l === l)) out.push({ l, e:D[l], exact }); };
  const tryW = (x, exact) => { if (D[x]) add(x, exact); const f = F[x]; if (f) (Array.isArray(f) ? f : [f]).forEach(l => add(l, false)); };
  tryW(w, true);
  if (/^[A-ZÄÖÜ]/.test(w)) tryW(w.toLowerCase(), false); else tryW(cap1(w), false);
  if (!out.length && /ß/.test(w)) { const n = w.replace(/ß/g, 'ss'); tryW(n, false); if (/^[A-ZÄÖÜ]/.test(n)) tryW(n.toLowerCase(), false); else tryW(cap1(n), false); }   // стара орфографія: daß → dass
  if (!out.length && w.includes('-')) { const last = w.split('-').pop(); tryW(last, false); tryW(cap1(last), false); }
  if (!out.length && /^[A-ZÄÖÜ]/.test(w) && w.length >= 7) {        // складне слово: шукаємо найдовший відомий кінець
    for (let i = 2; i <= w.length - 4; i++) {
      const tail = cap1(w.slice(i)), e = D[tail] || (F[tail] && D[[].concat(F[tail])[0]]);
      const head = D[tail] ? tail : (F[tail] ? [].concat(F[tail])[0] : null);
      if (e && head && D[head].p.includes('noun')) {
        const mod = w.slice(0,i), lem = mod + head.toLowerCase();       // Zimmerherren → Zimmerherr
        out.push({ l:cap1(lem), e:{ p:['noun'], g:D[head].g, en:D[head].en, uk:D[head].uk }, comp:{ mod, head } });
        break;
      }
    }
  }
  const sc = x => (x.e.r || 200000) * (x.exact ? 0.34 : 1);
  return out.sort((a,b) => sc(a) - sc(b));
}
const withArt = (l, e) => e && e.g && e.p.includes('noun') ? `${ART[e.g]} ${l}` : l;
const posUk = p => ({noun:'іменник', verb:'дієслово', adj:'прикметник', adv:'прислівник', pron:'займенник', prep:'прийменник', conj:'сполучник', det:'детермінатив', article:'артикль', num:'числівник', particle:'частка', intj:'вигук', name:'власна назва'}[p] || p);
function ukOf(l, e){
  if (words.uk[l]) return { t:words.uk[l], src:'api' };
  if (e && e.uk && e.uk.length) return { t:e.uk.slice(0,2).join(', '), src:'approx' };
  return null;
}

/* =========================================================
   Імпорт книжок
   ========================================================= */
function parseXml(text, html){
  const p = new DOMParser();
  let doc = p.parseFromString(text, html ? 'text/html' : 'application/xhtml+xml');
  if (!html && doc.querySelector('parsererror')) doc = p.parseFromString(text, 'text/html');
  return doc;
}
const clean = s => s.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
function blocksOf(root){
  const out = [];
  const sel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dd,dt';
  root.querySelectorAll(sel).forEach(el => {
    if (el.parentElement && el.parentElement.closest(sel)) return;
    const t = clean(el.textContent || '');
    if (t) out.push({ h:/^H\d$/.test(el.tagName.toUpperCase()), t });
  });
  return out;
}
function resolvePath(base, rel){
  const parts = base.split('/'); parts.pop();
  for (const seg of decodeURIComponent(rel.split('#')[0]).split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}
function parseEpub(files){
  const cont = parseXml(files['META-INF/container.xml'] || '');
  const opfPath = cont.querySelector('rootfile')?.getAttribute('full-path') || Object.keys(files).find(f => f.endsWith('.opf'));
  const opf = parseXml(files[opfPath]);
  const meta = n => clean(opf.getElementsByTagName('dc:' + n)[0]?.textContent || opf.getElementsByTagNameNS('*', n)[0]?.textContent || '');
  const manifest = {};
  for (const it of opf.getElementsByTagName('item')) manifest[it.getAttribute('id')] = it.getAttribute('href');
  const chapters = [];
  for (const ir of opf.getElementsByTagName('itemref')) {
    const href = manifest[ir.getAttribute('idref')]; if (!href) continue;
    const p = resolvePath(opfPath, href), src = files[p]; if (!src) continue;
    const doc = parseXml(src);
    const bl = blocksOf(doc.body || doc.documentElement);
    if (!bl.length) continue;
    const title = bl.find(b => b.h)?.t || clean(doc.querySelector('title')?.textContent || '') || `Розділ ${chapters.length+1}`;
    chapters.push({ title, paras:bl.map(b => b.t), heads:bl.map((b,i) => b.h ? i : -1).filter(i => i >= 0) });
  }
  return { title:meta('title'), author:meta('creator'), lang:meta('language'), chapters };
}
function parseFb2(text){
  const doc = parseXml(text);
  const g = (sel) => clean(doc.querySelector(sel)?.textContent || '');
  const author = [g('title-info author first-name'), g('title-info author last-name')].filter(Boolean).join(' ');
  const chapters = [];
  const bodies = [...doc.getElementsByTagName('body')].filter(b => b.getAttribute('name') !== 'notes');
  for (const body of bodies) {
    const secs = [...body.children].filter(c => c.tagName === 'section');
    (secs.length ? secs : [body]).forEach(sec => {
      const paras = [], heads = [];
      sec.querySelectorAll('title p, p, subtitle, v').forEach(el => {
        if (el.parentElement.closest('p')) return;
        const t = clean(el.textContent); if (!t) return;
        if (el.closest('title') || el.tagName === 'subtitle') heads.push(paras.length);
        paras.push(t);
      });
      if (paras.length) chapters.push({ title:clean(sec.querySelector('title')?.textContent || '') || `Розділ ${chapters.length+1}`, paras, heads });
    });
  }
  return { title:g('title-info book-title'), author, lang:g('title-info lang'), chapters };
}
function parseTxt(text){
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map(clean).filter(Boolean);
  const chapters = []; let curc = null;
  for (const p of paras) {
    if (/^(Kapitel|Chapter|Teil|Глава|Розділ|[IVXLC]+\.?)(\s|$)/.test(p) && p.length < 80) { curc = { title:p, paras:[p], heads:[0] }; chapters.push(curc); continue; }
    if (!curc) { curc = { title:'Текст', paras:[], heads:[] }; chapters.push(curc); }
    curc.paras.push(p);
  }
  return { title:'', author:'', lang:'', chapters };
}
async function importRaw(raw){
  let b;
  if (raw.type === 'epub') b = parseEpub(raw.files);
  else if (raw.type === 'fb2') b = parseFb2(raw.text);
  else b = parseTxt(raw.text);
  if (!b.chapters.length) throw new Error('У книжці не знайдено тексту');
  b.title = b.title || raw.name.replace(/\.[^.]+$/, '');
  const id = uid();
  const chars = b.chapters.reduce((a,c) => a + c.paras.reduce((x,p) => x + p.length, 0), 0);
  await api.write('book-' + id, { id, ...b });
  const meta = { id, title:b.title, author:b.author, lang:b.lang || 'de', chars, added:todayKey(), last:null, read:0, pos:{ ch:0, p:0 }, finished:null, secs:0, color:COLORS_PICK() };
  library.books.unshift(meta); saveLib(true);
  return meta;
}
const COLORS_PICK = () => COVERS[library.books.length % COVERS.length];
async function addBooks(){
  const raws = await api.pickBooks();
  for (const r of raws) {
    if (r.error) { toast(`${r.name}: ${r.error}`, 4000); continue; }
    try { const m = await importRaw(r); toast(`Додано: ${m.title}`); } catch (e) { toast(`${r.name}: ${e.message}`, 4000); }
  }
  render();
}

/* =========================================================
   Статистика і цілі
   ========================================================= */
const day = k => (stats.days[k] = stats.days[k] || { c:0, s:0 });
const dayVal = k => { const d = stats.days[k]; if (!d) return 0; return settings.goalType === 'pages' ? d.c / NORM : d.s / 60; };
const goalVal = () => settings.goalType === 'pages' ? settings.goalPages : settings.goalMin;
const unit = () => settings.goalType === 'pages' ? 'стор.' : 'хв';
function goalStreak(){
  let d = new Date(), n = 0;
  if (dayVal(dkey(d)) < goalVal()) d = addDays(d, -1);
  while (dayVal(dkey(d)) >= goalVal()) { n++; d = addDays(d, -1); }
  return n;
}
const finishedIn = y => library.books.filter(b => b.finished && b.finished.startsWith(String(y)));
function ring(v, max, color = '#9ff5f7', size = 96){
  const r = size/2 - 9, c = 2*Math.PI*r, p = Math.min(1, max ? v/max : 0);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="#4f5153" stroke-width="9"/>
    ${p > 0 ? `<circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c*p} ${c}" transform="rotate(-90 ${size/2} ${size/2})"/>` : ''}
    <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-size="${size/4.6}" font-weight="700" fill="#eceeee">${Math.round(p*100)}%</text></svg>`;
}
function daysChart(n = 30){
  const W = 760, H = 170, L = 30, B = 22, T = 12, keys = [];
  for (let i = n-1; i >= 0; i--) keys.push(dkey(addDays(new Date(), -i)));
  const vals = keys.map(dayVal), g = goalVal(), max = Math.max(g * 1.3, ...vals, 1);
  const bw = (W-L-6)/n*0.65, x = i => L + (i+0.5)*(W-L-6)/n, y = v => T + (1 - v/max)*(H-T-B);
  const bars = vals.map((v,i) => `<rect x="${x(i)-bw/2}" y="${y(v)}" width="${bw}" height="${Math.max(v ? 2 : 0, y(0)-y(v))}" rx="3" fill="${v >= g ? '#9ff5f7' : '#4f8f92'}"><title>${short(keys[i])}: ${v.toFixed(settings.goalType === 'pages' ? 1 : 0)} ${unit()}</title></rect>`).join('');
  const xl = keys.map((k,i) => i % 5 === 0 || i === n-1 ? `<text x="${x(i)}" y="${H-6}" fill="#a4a8aa" font-size="10.5" text-anchor="middle">${short(k)}</text>` : '').join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><line x1="${L}" x2="${W-6}" y1="${y(g)}" y2="${y(g)}" stroke="#f5a524" stroke-dasharray="6 4"/><text x="${L+4}" y="${y(g)-4}" fill="#f5a524" font-size="10.5">мета ${g} ${unit()}</text>${bars}${xl}</svg>`;
}
function updatePills(){
  const v = dayVal(todayKey()), g = goalVal();
  $('#goalPill').textContent = `Сьогодні ${settings.goalType === 'pages' ? v.toFixed(1) : Math.round(v)} / ${g} ${unit()}`;
  const y = new Date().getFullYear();
  $('#yearPill').textContent = `Прочитано у ${y}: ${finishedIn(y).length}${settings.yearGoal ? ' / ' + settings.yearGoal : ''}`;
}

/* відстеження часу читання */
['mousemove','keydown','wheel','click','scroll','touchstart'].forEach(ev => window.addEventListener(ev, () => { lastAct = Date.now(); }, { passive:true, capture:true }));
setInterval(() => {
  if (view !== 'reader' || !cur || !document.hasFocus() || Date.now() - lastAct > 120000) return;
  day(todayKey()).s += 5; cur.meta.secs = (cur.meta.secs || 0) + 5;
  saveStats(); saveLib(); updatePills(); updateStatus();
}, 5000);

/* =========================================================
   Рендер і навігація
   ========================================================= */
function render(){
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.body.className = 'th-' + settings.theme + (view === 'reader' ? ' reading' : '');
  closePop();
  updatePills();
  $('#rstatus')?.remove();
  if (view !== 'songs' && typeof ytStop === 'function') ytStop();
  ({ home:renderHome, reader:renderReader, vocab:renderVocab, mywords:renderMyWords, settings:renderSettings, songs:renderSongs })[view]();
}
function go(v){ if (view === 'reader') savePos(); view = v; window.scrollTo(0, 0); render(); }

/* ---------- бібліотека ---------- */
function renderHome(){
  const y = new Date().getFullYear(), fin = finishedIn(y), v = dayVal(todayKey()), g = goalVal();
  const last = library.books.filter(b => b.last).sort((a,b) => b.last.localeCompare(a.last))[0];
  const st = goalStreak();
  $('#main').innerHTML = `<div id="joinSlot"></div>
    <div class="homegrid">
      <div class="panel"><div class="today">${ring(v, g)}
        <div><div class="hint">Сьогодні</div><div class="big">${settings.goalType === 'pages' ? v.toFixed(1) : Math.round(v)} <span class="hint" style="font-size:14px">/ ${g} ${unit()}</span></div>
        <div class="hint" style="margin-top:4px">${st ? `🔥 ${st} дн. поспіль виконуєш мету` : 'Мета на день: ' + g + ' ' + unit()}</div>
        ${settings.goalType === 'pages' ? '<div class="hint">1 стор. = 1800 знаків</div>' : ''}</div></div>
        ${last ? `<button class="btn primary" style="width:100%;margin-top:14px" data-open="${last.id}">▶ Продовжити: ${esc(last.title)}</button>` : ''}
      </div>
      <div class="panel"><div class="row"><h3>Останні 30 днів</h3><div class="spacer"></div><span class="hint">${settings.goalType === 'pages' ? 'сторінки' : 'хвилини'} читання</span></div>${daysChart()}</div>
    </div>
    <div class="row"><h2 style="margin:0">Мої книжки</h2><div class="spacer"></div><button class="btn primary" data-act="add">+ Додати книжку</button></div>
    <div class="hint" style="margin:4px 0 12px">EPUB, FB2 або TXT</div>
    ${library.books.length ? `<div class="books">${library.books.map(bookCard).join('')}</div>` : '<div class="empty">Книжок ще немає</div>'}
    <div class="panel" style="margin-top:14px"><div class="row"><h3>📚 Прочитано у ${y}</h3><div class="spacer"></div><b>${fin.length}${settings.yearGoal ? ' з ' + settings.yearGoal : ''}</b></div>
      ${settings.yearGoal ? `<div class="bar" style="margin-top:10px"><i style="width:${Math.min(100, fin.length/settings.yearGoal*100)}%"></i></div>` : ''}
      <div class="yearlist">${fin.length ? fin.sort((a,b) => b.finished.localeCompare(a.finished)).map(b => `<div><span>${esc(b.title)}${b.author ? ' · <span class="hint">' + esc(b.author) + '</span>' : ''}</span><span class="hint">${short(b.finished)}.${b.finished.slice(0,4)}</span></div>`).join('') : '<span class="hint">Ще немає. Книжка вважається прочитаною, коли дочитаєш до кінця або позначиш вручну.</span>'}</div>
      ${yearsArchive(y)}
    </div>`;
  if (typeof paintJoin === 'function') paintJoin();
}
function yearsArchive(y){
  const ys = [...new Set(library.books.filter(b => b.finished).map(b => +b.finished.slice(0,4)))].filter(x => x !== y).sort((a,b) => b-a);
  return ys.length ? `<div class="hint" style="margin-top:10px">Раніше: ${ys.map(x => `${x} — ${finishedIn(x).length}`).join(' · ')}</div>` : '';
}
function bookCard(b){
  const p = b.chars ? Math.min(100, b.read / b.chars * 100) : 0;
  const ini = b.title.split(/\s+/).filter(w => /^[A-ZÄÖÜА-ЯІЇЄҐ]/i.test(w)).slice(0,2).map(w => w[0]).join('').toUpperCase();
  return `<div class="book"><div class="cover" style="background:${b.color || '#7c3aed'}">${esc(ini)}</div>
    <div style="flex:1;min-width:0"><div class="bt">${esc(b.title)}</div><div class="ba">${esc(b.author || '')}</div>
      <div class="bar"><i style="width:${p}%"></i></div>
      <div class="hint" style="margin:5px 0 8px">${Math.round(p)}% · ${fmt(b.read/NORM)} з ${fmt(b.chars/NORM)} стор.${b.finished ? ' · <span class="done-badge">✓ прочитано</span>' : ''}</div>
      <div class="row"><button class="btn sm primary" data-open="${b.id}">Читати</button><button class="btn sm" data-vocab="${b.id}">Вортшатц</button>
        <button class="btn sm plain" data-finish="${b.id}" title="${b.finished ? 'Зняти позначку' : 'Позначити прочитаною'}">${b.finished ? '↺' : '✓'}</button>
        <button class="btn sm plain" data-delbook="${b.id}" title="Видалити">🗑</button></div></div></div>`;
}

/* ---------- читання ---------- */
async function openBook(id, ch, p){
  const meta = library.books.find(b => b.id === id); if (!meta) return;
  if (!cur || cur.meta.id !== id) {
    let book = await api.read('book-' + id);
    if (!book && typeof fetchBookText === 'function') book = await fetchBookText(id);
    if (!book) { toast(sync && sync.refresh ? 'Текст книжки ще не завантажено. Перевір інтернет і спробуй ще раз' : 'Не вдалося відкрити книжку'); return; }
    const offs = []; let o = 0;
    book.chapters.forEach((c, ci) => { offs[ci] = c.paras.map(pp => { const s = o; o += pp.length; return s; }); });
    cur = { meta, book, offs, tr: await api.read('tr-' + id) || {} };
  }
  if (ch != null) { cur.meta.pos = { ch, p:p || 0 }; moved(); }
  // last не чіпаємо: він означає «коли змінилося місце читання», і за ним синхронізація вирішує, чия позиція новіша
  if (!meta.last) { meta.last = new Date(0).toISOString(); saveLib(); }
  view = 'reader'; render();
}
// абзац → шматки по 2–4 речення (залежно від довжини) для паралельного перекладу: [[від, до], …]
const chunkCache = new Map();
function chunksOf(text){
  if (chunkCache.has(text)) return chunkCache.get(text);
  const ends = []; const re = /[.!?…]+[»«"“”'’)\]]*(?=\s+[^\s])/g; let m;
  while ((m = re.exec(text))) ends.push(m.index + m[0].length);
  ends.push(text.length);
  const sents = []; let s0 = 0;
  for (const e of ends) { if (e > s0) { sents.push([s0, e]); s0 = e; } }
  const out = []; let cs = 0, n = 0;
  sents.forEach(([a, b], i) => {
    n++;
    const len = b - cs, last = i === sents.length - 1;
    if (last || (n >= 2 && len >= 220) || n >= 4 || len >= 420) { out.push([cs, b]); cs = b; n = 0; }
  });
  // занадто короткий хвіст приєднуємо до попереднього шматка
  if (out.length > 1 && out[out.length - 1][1] - out[out.length - 1][0] < 90) { const t = out.pop(); out[out.length - 1][1] = t[1]; }
  chunkCache.set(text, out);
  return out;
}
function paraHTML(text, ci, pi, from = 0, to = text.length){
  let out = '', last = from;
  text.slice(0, to).replace(WORD_RE, (m, off) => {
    if (off < from) return m;
    out += esc(text.slice(last, off));
    const lw = lookup(m)[0];
    out += `<span class="w${lw && words.star[lw.l] ? ' star' : ''}" data-o="${off}">${esc(m)}</span>`;
    last = off + m.length; return m;
  });
  return out + esc(text.slice(last, to));
}
// абзац у режимі паралельного перекладу: кожен шматок — окремий блок із перекладом під ним
function paraParallel(t, ch, i){
  const cs = chunksOf(t);
  if (cs.length <= 1) return `<p data-p="${i}">${paraHTML(t, ch, i)}</p>${trSlot(ch, i)}`;
  return cs.map(([a, b], j) => `<p data-p="${i}" data-e="${b}" class="${j ? 'cont' : ''}${j < cs.length - 1 ? ' cut' : ''}">${paraHTML(t, ch, i, a, b).trim()}</p>${trSlot(ch, i, j)}`).join('');
}
// «Поруч»: оригінал зліва, переклад справа (лише на широкому екрані)
const sideMode = () => settings.parallel === 'side' && innerWidth > 900;
function paraSide(t, ch, i){
  const cs = chunksOf(t);
  if (cs.length <= 1) return `<div class="pr"><p data-p="${i}">${paraHTML(t, ch, i)}</p>${trSlot(ch, i)}</div>`;
  return cs.map(([a, b], j) => `<div class="pr${j ? ' cont' : ''}${j < cs.length - 1 ? ' cut' : ''}"><p data-p="${i}" data-e="${b}">${paraHTML(t, ch, i, a, b).trim()}</p>${trSlot(ch, i, j)}</div>`).join('');
}
function renderReader(){
  if (!cur) {
    const last = library.books.filter(b => b.last).sort((a,b) => b.last.localeCompare(a.last))[0] || library.books[0];
    if (last) { openBook(last.id); return; }
    $('#main').innerHTML = '<div class="empty">Спочатку додай книжку в бібліотеці</div>'; return;
  }
  const { book, meta } = cur, ch = Math.min(meta.pos.ch || 0, book.chapters.length-1), c = book.chapters[ch];
  document.documentElement.style.setProperty('--rf', settings.font + 'px');
  document.documentElement.style.setProperty('--rw', settings.width + 'px');
  const heads = new Set(c.heads || []);
  $('#main').innerHTML = `
    <div class="rbar">
      <button class="btn sm" data-view="home">← Бібліотека</button>
      <span class="rtitle" title="${esc(book.title)}">${esc(book.title)}</span>
      <select class="inp" id="chapSel" style="max-width:260px">${book.chapters.map((x,i) => `<option value="${i}" ${i === ch ? 'selected' : ''}>${esc(x.title.slice(0,60))}</option>`).join('')}</select>
      <div class="spacer"></div>
      <div class="seg"><button class="${settings.parallel ? '' : 'on'}" data-par="0">Переклад по кліку</button><button class="${settings.parallel && !sideMode() ? 'on' : ''}" data-par="1" title="Переклад під кожними 2–4 реченнями">Паралельний</button>${innerWidth > 900 ? `<button class="${sideMode() ? 'on' : ''}" data-par="2" title="Оригінал зліва, переклад справа; наведи мишку — підсвітиться пара">Поруч</button>` : ''}</div>
      <button class="btn sm" data-font="-1" title="Менший шрифт">A−</button><button class="btn sm" data-font="1" title="Більший шрифт">A+</button>
      <div class="seg">${[['dark','Темна'],['sepia','Сепія'],['light','Світла']].map(([t,l]) => `<button class="${settings.theme === t ? 'on' : ''}" data-theme="${t}">${l}</button>`).join('')}</div>
      ${settings.parallel ? `<button class="btn sm" data-pre="ask" title="Перекласти розділ або всю книжку заздалегідь і зберегти">⤓ Перекласти наперед</button>` : ''}
      <button class="btn sm" data-vocab="${meta.id}">🧠 Вортшатц</button>
    </div>
    <div class="rwrap" id="rwrap">
      <button class="pgbtn prev" data-pg="-1" title="Попередня сторінка (←)">‹</button>
      <div class="rpage" id="rpage"><div class="rtext${sideMode() ? ' sbs' : ''}" id="rtext" lang="${esc(meta.lang || 'de')}">
      ${c.paras.map((t,i) => heads.has(i) ? `<h3 class="rh" data-p="${i}">${paraHTML(t, ch, i)}</h3>` : (sideMode() ? paraSide(t, ch, i) : settings.parallel ? paraParallel(t, ch, i) : `<p data-p="${i}">${paraHTML(t, ch, i)}</p>`)).join('')}
      <div class="chapnav">${ch > 0 ? `<button class="btn" data-chap="${ch-1}">← ${esc(book.chapters[ch-1].title.slice(0,40))}</button>` : '<span></span>'}
        ${ch < book.chapters.length-1 ? `<button class="btn primary" data-chap="${ch+1}">${esc(book.chapters[ch+1].title.slice(0,40))} →</button>` : `<button class="btn primary" data-finish="${meta.id}">${meta.finished ? '✓ Книжку прочитано' : '🏁 Позначити книжку прочитаною'}</button>`}</div>
      </div></div>
      <button class="pgbtn next" data-pg="1" title="Наступна сторінка (→, пробіл)">›</button>
    </div>`;
  $('#rstatus')?.remove();
  const st = document.createElement('div'); st.className = 'rstatus'; st.id = 'rstatus'; document.body.appendChild(st);
  $('#chapSel').addEventListener('change', e => { savePos(); cur.meta.pos = { ch:+e.target.value, p:0 }; moved(); renderReader(); });
  // повертаємось на збережене місце (або на останню сторінку, якщо гортали назад з наступного розділу)
  pg.cur = 0;
  requestAnimationFrame(() => {
    layoutPages();
    if (meta.pos.p === 'end') pg.cur = pg.n - 1; else pg.cur = pageOfPos(meta.pos);
    pg.kept = meta.pos.p === 'end' ? -1 : pg.cur;   // поки не перегорнули — збережене місце не переписуємо (на іншому екрані сторінки інші)
    showPage();
  });
  updateStatus();
}
/* ---------- посторінкове листання ---------- */
const pg = { cur:0, n:1, step:1, gap:60, kept:-1 };
// користувач сам перейшов в інше місце (розділ, слово з вортшатцу) — це найновіша позиція
function moved(){ cur.meta.last = new Date().toISOString(); if (typeof scheduleSync === 'function') scheduleSync(); }
function layoutPages(){
  const wrap = $('#rwrap'), page = $('#rpage'), t = $('#rtext'); if (!wrap || !t) return;
  const avail = wrap.clientWidth - 2 * (innerWidth <= 700 ? 16 : 56);   // місце для стрілок по боках (на телефоні їх немає)
  const w = Math.max(280, Math.min(sideMode() ? Math.round(settings.width * 1.75) : settings.width, avail));
  page.style.width = w + 'px';
  t.style.columnWidth = w + 'px'; t.style.columnGap = pg.gap + 'px';
  pg.step = w + pg.gap;
  const left = t.getBoundingClientRect().left, last = t.lastElementChild;
  const rs = last ? last.getClientRects() : [];
  const right = rs.length ? rs[rs.length - 1].right : left;
  pg.n = Math.max(1, Math.floor((right - left - 1) / pg.step) + 1);
  pg.cur = Math.min(pg.cur, pg.n - 1);
}
function relX(el, end){ const t = $('#rtext'), rs = el.getClientRects(); if (!rs.length) return 0; return (end ? rs[rs.length - 1].right : rs[0].left) - t.getBoundingClientRect().left; }
// сторінка, на якій стоїть збережене місце: абзац p, слово з відступом o всередині абзацу
function pageOfPos(pos){
  const el = document.querySelector(`#rtext [data-p="${pos.p || 0}"]`); if (!el) return 0;
  let tgt = el;
  if (pos.o) { for (const w of document.querySelectorAll(`#rtext [data-p="${pos.p || 0}"] .w`)) { tgt = w; if (+w.dataset.o >= pos.o) break; } }
  return Math.min(pg.n - 1, Math.max(0, Math.floor((relX(tgt) + 2) / pg.step)));
}
function pageOfPara(p){ const el = document.querySelector(`#rtext [data-p="${p}"]`); return el ? Math.min(pg.n - 1, Math.max(0, Math.floor((relX(el) + 2) / pg.step))) : 0; }
function showPage(){
  const t = $('#rtext'); if (!t) return;
  t.style.transform = `translateX(${-pg.cur * pg.step}px)`;
  closePop();
  trackRead(); if (settings.parallel) observeTr();
}
function turnPage(d){
  if (view !== 'reader' || !cur) return;
  const ch = cur.meta.pos.ch, n = cur.book.chapters.length;
  if (pg.cur + d >= 0 && pg.cur + d < pg.n) { pg.cur += d; pg.kept = -1; showPage(); return; }
  if (d > 0 && ch < n - 1) { savePos(); cur.meta.pos = { ch:ch + 1, p:0 }; moved(); renderReader(); }
  else if (d < 0 && ch > 0) { savePos(); cur.meta.pos = { ch:ch - 1, p:'end' }; moved(); renderReader(); }
}
// після зміни шрифту, розміру вікна чи перекладу: перерахувати сторінки, лишаючись на тому ж абзаці
function relayoutKeepPage(){ if (view === 'reader' && $('#rtext')) { layoutPages(); $('#rtext').style.transform = `translateX(${-pg.cur * pg.step}px)`; updateStatus(); } }
function relayoutKeep(){
  if (view !== 'reader' || !cur || !$('#rtext')) return;
  const pos = cur.meta.pos; layoutPages(); pg.cur = typeof pos.p === 'number' ? pageOfPos(pos) : 0; pg.kept = pg.cur; showPage();
}
let rzT = null;
window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { const t = $('#rtext'); if (view === 'reader' && t && t.classList.contains('sbs') !== sideMode()) { savePos(); renderReader(); } else relayoutKeep(); }, 150); });
// свайп вліво/вправо на телефоні
let tch = null;
window.addEventListener('touchstart', e => { if (view === 'reader' && e.touches.length === 1 && e.target.closest('#rwrap')) tch = { x:e.touches[0].clientX, y:e.touches[0].clientY, t:Date.now() }; else tch = null; }, { passive:true });
window.addEventListener('touchend', e => {
  if (!tch) return; const t = e.changedTouches[0], dx = t.clientX - tch.x, dy = t.clientY - tch.y; tch = null;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = Date.now(); turnPage(dx < 0 ? 1 : -1); }
}, { passive:true });
let swiped = 0;
let wheelT = 0;
window.addEventListener('wheel', e => {
  if (view !== 'reader' || !e.target.closest('#rwrap') || e.target.closest('#pop')) return;
  e.preventDefault();
  const now = Date.now(); if (now - wheelT < 350 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
  wheelT = now; turnPage((e.deltaY || e.deltaX) > 0 ? 1 : -1);
}, { passive:false });
// усі ключі перекладу розділу (ті самі шматки, що й на екрані)
function trKeysOf(ci){
  const c = cur.book.chapters[ci], heads = new Set(c.heads || []), out = [];
  c.paras.forEach((t, i) => { if (heads.has(i)) return; const n = chunksOf(t).length; if (n <= 1) out.push(ci + '.' + i); else for (let j = 0; j < n; j++) out.push(ci + '.' + i + '.' + j); });
  return out;
}
// переклад наперед: зберігається і через синхронізацію потрапляє на телефон
let preRun = null;
async function pretranslate(scope, only){
  if (!cur) return;
  if (preRun) { preRun.stop = true; toast('Зупиняю…'); return; }
  const prov = await providerFor('tr');
  if (!prov) { toast('Додай ключ ' + (appInfo.web ? 'Gemini' : 'DeepL') + ' у налаштуваннях'); return; }
  let ap = await altProvider(); if (ap === 'ai2') ap = null;   // той самий Gemini двічі наперед не перекладаємо
  const ch = cur.meta.pos.ch, chs = scope === 'book' ? cur.book.chapters.map((_, i) => i) : [ch];
  const all = chs.flatMap(trKeysOf);
  const jobs = [];
  if (only !== 'alt') jobs.push({ prov, alt:false, ks:all.filter(k => !cur.tr[k]) });
  if (ap && only !== 'main') jobs.push({ prov:ap, alt:true, ks:all.filter(k => !cur.tr[altKey(k)]) });
  if (!jobs.some(j => j.ks.length)) { toast('Тут уже все перекладено'); return; }
  const run = preRun = { stop:false }, bookId = cur.meta.id, res0 = [];
  for (const job of jobs) {
    const step = job.prov === 'deepl' ? 40 : 8, nm = provName(job.prov) + (job.alt ? ' (інший варіант)' : '');
    let done = 0, fails = 0;
    for (let i = 0; i < job.ks.length && !run.stop; ) {
      const part = job.ks.slice(i, i + step);
      toast(`Перекладаю наперед, ${nm}: ${done} з ${job.ks.length}… (натисни кнопку ще раз, щоб зупинити)`, 60000);
      try {
        const res = job.prov === 'deepl' ? await deepl(part.map(trText)) : await aiParas(part.map(trText));
        if (!cur || cur.meta.id !== bookId) { run.stop = true; break; }
        part.forEach((k, j) => { if (res[j]) { cur.tr[job.alt ? altKey(k) : k] = res[j]; showTr(k); } });
        saveTr(); done += part.length; i += step; fails = 0;
      } catch (e) {
        if (++fails > 4) { toast(`${nm}: зупинено — ${e.message}`, 6000); await new Promise(ok => setTimeout(ok, 2500)); break; }
        toast(`⚠ ${nm}: ${e.message}. Повтор через ${fails * 15} с…`, fails * 15000);
        await new Promise(ok => setTimeout(ok, fails * 15000));
      }
    }
    if (job.ks.length) res0.push(`${nm} — ${done}`);
  }
  preRun = null;
  if (view === 'reader') relayoutKeepPage();
  toast(`Перекладено наперед: ${res0.join(', ') || 'нічого нового'}. Переклади збережено${typeof sync !== 'undefined' && sync.refresh ? ' і вони синхронізуються на телефон' : ''}.`, 6000);
}
// меню «Перекласти наперед»: який перекладач (основний / інший варіант / обидва) і скільки (розділ / книжка)
async function preMenu(btn){
  if (preRun) { pretranslate(); return; }
  if ($('#preMenu')) { closePreMenu(); return; }
  if (!cur) return;
  const prov = await providerFor('tr');
  if (!prov) { toast('Додай ключ ' + (appInfo.web ? 'Gemini' : 'DeepL') + ' у налаштуваннях'); return; }
  let ap = await altProvider(); if (ap === 'ai2') ap = null;
  const ch = cur.meta.pos.ch;
  const left = (cis, alt) => cis.flatMap(trKeysOf).filter(k => !cur.tr[alt ? altKey(k) : k]).reduce((a, k) => a + trText(k).length, 0);
  const scopes = [['chapter', 'Цей розділ', [ch]], ['book', 'Уся книжка', cur.book.chapters.map((_, i) => i)]];
  const cell = (sc, only, label, n) => n ? `<button class="btn sm" data-prego="${sc}:${only}">${label}<small>${fmt(n)} зн.</small></button>` : `<button class="btn sm" disabled>${label}<small>готово ✓</small></button>`;
  const rows = scopes.map(([sc, title, cis]) => {
    const nm = left(cis), na = ap ? left(cis, 1) : 0;
    return `<div class="pmrow"><b>${title}</b>${cell(sc, 'main', provName(prov), nm)}${ap ? cell(sc, 'alt', provName(ap) + ' (⇄ інший)', na) + (nm || na ? `<button class="btn sm primary" data-prego="${sc}:both">Обидва</button>` : '') : ''}</div>`;
  }).join('');
  const m = document.createElement('div'); m.id = 'preMenu'; m.className = 'premenu';
  m.innerHTML = `<div class="hint">Перекладається лише те, чого ще немає. Знаки — скільки залишилось.${prov === 'deepl' || ap === 'deepl' ? ' DeepL безкоштовно: 500 000 знаків на місяць.' : ''}</div>${rows}`;
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.top = (r.bottom + 6) + 'px'; m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
}
function closePreMenu(){ const m = $('#preMenu'); if (m) m.remove(); }
// альтернативний переклад: інший перекладач (DeepL ↔ Gemini); зберігається поруч під ключем «ключ~» і синхронізується
const altKey = k => k + '~';
const provName = p => p === 'deepl' ? 'DeepL' : 'Gemini';
const trAltOn = new Set();           // шматки, де зараз показано інший варіант
async function altProvider(){
  const main = await providerFor('tr'), k = await keys(), ai = !!(await aiWho());
  if (main === 'deepl') return ai ? 'ai' : null;
  return k.deepl ? 'deepl' : ai ? 'ai2' : null;      // ai2: той самий ШІ, але просимо інше формулювання
}
function markTrDirty(){ if (typeof sync !== 'undefined' && cur) { sync.trDirty = sync.trDirty || {}; sync.trDirty[cur.meta.id] = 1; } }
function showTr(k){
  const el = document.querySelector(`[data-tr="${k}"]`); if (!el) return;
  const alt = trAltOn.has(k) && cur.tr[altKey(k)], t = alt || cur.tr[k];
  setTr(k, t || '…', !t); el.classList.toggle('alt', !!alt);
}
async function toggleAlt(k){
  if (!cur) return;
  if (trAltOn.has(k)) { trAltOn.delete(k); showTr(k); relayoutKeepPage(); return; }
  trAltOn.add(k);
  if (!cur.tr[altKey(k)]) {
    const prov = await altProvider();
    if (!prov) { trAltOn.delete(k); toast('Для іншого варіанта додай ключ Gemini' + (appInfo.web ? '' : ' або DeepL') + ' у налаштуваннях', 4000); return; }
    const el = document.querySelector(`[data-tr="${k}"] .trt`); if (el) el.textContent = '… шукаю інший варіант (' + provName(prov === 'ai2' ? 'ai' : prov) + ')';
    try {
      const t = trText(k), [r] = prov === 'deepl' ? await deepl([t]) : prov === 'ai' ? await aiParas([t]) : await aiAlt([t], [cur.tr[k] || '']);
      if (r) { cur.tr[altKey(k)] = r; saveTr(); } else trAltOn.delete(k);
    } catch (e) { trAltOn.delete(k); toast(e.message, 5000); }
  }
  showTr(k); relayoutKeepPage();
}
function trSlot(ch, i, j){
  const k = ch + '.' + i + (j != null ? '.' + j : ''), alt = trAltOn.has(k) && cur.tr[altKey(k)], t = alt || cur.tr[k];
  return `<div class="tr ${t ? '' : 'wait'}${alt ? ' alt' : ''}" data-tr="${k}"><span class="trt">${t ? esc(t) : '…'}</span><button class="trre" data-retr="${k}" title="Перекласти цей шматок заново">↻</button><button class="trre tralt" data-alt="${k}" title="Інший варіант перекладу (DeepL ↔ Gemini)">⇄</button></div>`;
}
// текст для ключа перекладу: «розділ.абзац» або «розділ.абзац.шматок»
function trText(k){
  const [c, p, j] = k.split('.').map(Number), t = cur.book.chapters[c].paras[p];
  if (isNaN(j)) return t;
  const [a, b] = chunksOf(t)[j]; return t.slice(a, b).trim();
}
function updateStatus(){
  const st = $('#rstatus'); if (!st || !cur) return;
  const m = cur.meta, p = m.chars ? m.read / m.chars * 100 : 0;
  st.innerHTML = `<span>${Math.round(p)}%</span><div class="bar"><i style="width:${p}%"></i></div><span>стор. ${fmt(m.read/NORM)} з ${fmt(m.chars/NORM)}</span><span>·</span><span>сторінка розділу ${pg.cur + 1} / ${pg.n}</span><span class="xs">·</span><span class="xs">${$('#goalPill').textContent}</span><span class="xs">·</span><span class="xs">у книжці ${Math.round((m.secs||0)/60)} хв</span>`;
}
// облік прочитаного: абзац вважається прочитаним, коли його кінець є на поточній або попередніх сторінках
function trackRead(){
  if (view !== 'reader' || !cur) return;
  const ps = document.querySelectorAll('#rtext [data-p]'); if (!ps.length) return;
  const ch = cur.meta.pos.ch, start = pg.cur * pg.step, endX = start + pg.step - pg.gap / 2;
  let top = null, cover = null, readTo = -1, readE = null;
  for (const el of ps) {
    const a = relX(el), b = relX(el, true);
    if (top === null && a >= start - 2 && a < endX) top = +el.dataset.p;
    if (cover === null && b > start) cover = +el.dataset.p;
    if (b <= endX + 1) { readTo = +el.dataset.p; readE = el.dataset.e ? +el.dataset.e : null; } else if (a > endX) break;
  }
  if (pg.cur >= pg.n - 1) { readTo = +ps[ps.length-1].dataset.p; readE = null; }
  // місце читання = перше слово на сторінці (абзац + відступ), щоб на іншому пристрої відкрилася та сама сторінка
  if (pg.kept !== pg.cur) {
    let first = null;
    for (const el of ps) {
      const pi = +el.dataset.p; if (cover !== null && pi < cover) continue;
      for (const w of el.querySelectorAll('.w')) { if (relX(w) >= start - 2) { first = w; break; } }
      if (first || relX(el) > endX) break;
    }
    const np = first ? +first.closest('[data-p]').dataset.p : (top !== null ? top : cover), no = first ? +first.dataset.o : 0;
    if (np !== null && (np !== cur.meta.pos.p || no !== (cur.meta.pos.o || 0))) {
      cur.meta.pos = { ch, p:np, o:no }; cur.meta.last = new Date().toISOString();
      if (typeof scheduleSync === 'function') scheduleSync();   // місце піде разом з іншими змінами або одразу при згортанні вікна
    }
    pg.kept = pg.cur;
  }
  if (readTo >= 0) {
    const c = cur.book.chapters[ch];
    const end = cur.offs[ch][readTo] + (readE != null ? readE : c.paras[readTo].length);
    // «сьогодні»: усе, що дочитано на сторінках, які ти бачив, — і вперше, і повторно; один і той самий текст за день рахується раз
    const from = cur.offs[ch][Math.min(cover !== null ? cover : readTo, readTo)];
    const add = addReadToday(cur.meta.id, from, end);
    if (add > 0 && add <= 25000) { day(todayKey()).c += add; saveStats(); }   // великі стрибки не рахуємо
    if (end > cur.meta.read) {
      cur.meta.read = end;
      if (!cur.meta.finished && cur.meta.read >= cur.meta.chars * 0.98) { cur.meta.finished = todayKey(); toast('🎉 Книжку прочитано! Вона зарахована в цьогорічні.', 3500); }
    }
  }
  saveLib(); updatePills(); updateStatus();
}
// прочитані сьогодні ділянки тексту (лише на цьому пристрої): { d:'2026-11-23', b:{ id:[[від, до], ...] } }
let readToday = { d:'', b:{} };
function addReadToday(id, a, b){
  if (!(b > a)) return 0;
  const d = todayKey(); if (readToday.d !== d) readToday = { d, b:{} };
  const rs = readToday.b[id] || [];
  let add = b - a;
  for (const [x, y] of rs) add -= Math.max(0, Math.min(b, y) - Math.max(a, x));
  if (add <= 0) return 0;
  const all = [...rs, [a, b]].sort((u, v) => u[0] - v[0]), out = [];
  for (const r of all) { const l = out[out.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); }
  readToday.b[id] = out; api.write('read-today', readToday);
  return add;
}
function savePos(){ if (cur) { trackRead(); saveLib(true); } }

/* ---------- паралельний переклад ---------- */
let trQueue = new Set(), trBusy = false;
function observeTr(){
  const lo = pg.cur * pg.step - 2, hi = (pg.cur + 2) * pg.step;
  document.querySelectorAll('#rtext .tr.wait').forEach(el => { const x = relX(el); if (x >= lo && x < hi) trQueue.add(el.dataset.tr); });
  pumpTr();
}
const setTr = (k, text, wait) => { const el = document.querySelector(`[data-tr="${k}"]`); if (!el) return; el.querySelector('.trt').textContent = text; el.classList.toggle('wait', !!wait); };
let trFail = 0, trRetryT = null;
async function pumpTr(){
  if (trBusy || !trQueue.size || !cur) return;
  const prov = await providerFor('tr');
  if (!prov) { document.querySelectorAll('.tr.wait .trt').forEach(el => { el.textContent = 'Щоб бачити паралельний переклад, додай ключ ' + (appInfo.web ? 'Gemini' : 'DeepL або Gemini') + ' у налаштуваннях.'; }); trQueue.clear(); return; }
  trBusy = true;
  const keys = [...trQueue].slice(0, prov === 'deepl' ? 20 : 6); keys.forEach(k => trQueue.delete(k));
  const bookId = cur.meta.id;
  const texts = keys.map(trText);
  try {
    const res = prov === 'deepl' ? await deepl(texts) : await aiParas(texts);
    trFail = 0;
    if (cur && cur.meta.id === bookId) {
      keys.forEach((k,i) => { if (res[i]) { cur.tr[k] = res[i]; showTr(k); } });
      saveTr(); relayoutKeepPage();
    }
  } catch (e) {
    // збій (часто Gemini перевантажений): шматки чекають і пробуємо ще раз пізніше — 15 с, 45 с, 2 хв
    trFail++;
    const wait = [15, 45, 120][Math.min(trFail - 1, 2)];
    keys.forEach(k => setTr(k, '⚠ ' + e.message + (trFail <= 3 ? ` · повтор через ${wait} с` : ' · натисни ↻'), true));
    trBusy = false;
    if (trFail <= 3) { clearTimeout(trRetryT); trRetryT = setTimeout(() => { if (view === 'reader' && settings.parallel) { keys.forEach(k => trQueue.add(k)); observeTr(); } }, wait * 1000); }
    else { trQueue.clear(); toast(e.message, 5000); }
    return;
  }
  trBusy = false; pumpTr();
}

/* =========================================================
   Переклад через API
   ========================================================= */
async function keys(){ return { deepl: appInfo.web ? '' : await api.getSecret('deepl'), claude: await api.getSecret('claude'), gemini: await api.getSecret('gemini') }; }
// який ШІ відповідає на запитання: Gemini (безкоштовний ключ) або Claude API
async function aiWho(){
  const k = await keys(), p = settings.aiProvider;
  if (p === 'gemini') return k.gemini ? 'gemini' : null;
  if (p === 'claude') return k.claude ? 'claude' : null;
  return k.gemini ? 'gemini' : k.claude ? 'claude' : null;   // auto
}
const aiLabel = who => who === 'claude' ? 'Claude' : 'Gemini';
async function providerFor(kind){
  const k = await keys(), ai = !!(await aiWho());
  if (kind === 'tr') { const p = settings.trProvider; if (p === 'deepl' && k.deepl) return 'deepl'; if (p === 'ai' && ai) return 'ai'; return k.deepl ? 'deepl' : ai ? 'ai' : null; }
  const p = settings.wordProvider;
  if (p === 'dict') return null;
  if (p === 'deepl') return k.deepl ? 'deepl' : null;
  if (p === 'ai') return ai ? 'ai' : null;
  return ai ? 'ai' : k.deepl ? 'deepl' : null;   // auto
}
async function deepl(texts){
  const key = await api.getSecret('deepl'); if (!key) throw new Error('Немає ключа DeepL');
  const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const r = await api.http({ url:host + '/v2/translate', method:'POST', headers:{ 'Authorization':'DeepL-Auth-Key ' + key.trim(), 'Content-Type':'application/json' }, body:JSON.stringify({ text:texts, source_lang:'DE', target_lang:'UK' }) });
  if (r.status === 403) throw new Error('DeepL: ключ не підходить');
  if (r.status === 456) throw new Error('DeepL: вичерпано місячний ліміт символів');
  if (!r.ok) throw new Error('DeepL: помилка ' + r.status + (r.status ? '' : ' (немає інтернету?)'));
  return JSON.parse(r.text).translations.map(t => t.text);
}
async function claude(system, user, maxTokens = 800){
  const key = await api.getSecret('claude'); if (!key) throw new Error('Немає ключа Claude');
  const r = await api.http({ url:'https://api.anthropic.com/v1/messages', method:'POST',
    headers:{ 'x-api-key':key.trim(), 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body:JSON.stringify({ model:settings.claudeModel, max_tokens:maxTokens, system, messages:[{ role:'user', content:user }] }) });
  if (r.status === 401) throw new Error('Claude: ключ не підходить');
  if (!r.ok) { let m = ''; try { m = JSON.parse(r.text).error.message; } catch (e) {} throw new Error('Claude: помилка ' + r.status + (m ? ' — ' + m : r.status ? '' : ' (немає інтернету?)')); }
  return JSON.parse(r.text).content.map(c => c.text || '').join('');
}
async function gemini(system, user, opts = {}){
  const key = await api.getSecret('gemini'); if (!key) throw new Error('Немає ключа Gemini');
  const call = model => api.http({ url:`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, method:'POST',
    headers:{ 'x-goog-api-key':key.trim(), 'Content-Type':'application/json' },
    body:JSON.stringify({ system_instruction:{ parts:[{ text:system }] }, contents:[{ role:'user', parts:Array.isArray(user) ? user : [{ text:user }] }],
      ...(opts.json || opts.lowMedia ? { generationConfig:{ ...(opts.json ? { responseMimeType:'application/json' } : {}), ...(opts.lowMedia ? { mediaResolution:'MEDIA_RESOLUTION_LOW' } : {}) } } : {}) }) });
  // якщо модель перевантажена (503), зникла (404) чи вичерпала свій ліміт (429) — пробуємо наступну
  const first = settings.geminiModel || 'gemini-flash-latest';
  // старі моделі Google поступово вимикає (404) — тому спершу «-latest», потім актуальні 3.5, а 2.5 лише наостанок
  const models = [...new Set([first, 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'])];
  let r, keep = null;
  for (let i = 0; i < models.length; i++) {
    r = await call(models[i]);
    if (r.status === 503 || r.status === 500) { await new Promise(ok => setTimeout(ok, 1500)); r = await call(models[i]); }
    if (![404, 429, 500, 503].includes(r.status)) break;
    if (r.status !== 404 && !keep) keep = r;      // для повідомлення беремо справжню причину, а не «модель зникла»
  }
  if (keep && [404, 429, 500, 503].includes(r.status)) r = keep;
  let m = ''; try { m = JSON.parse(r.text).error.message; } catch (e) {}
  if (r.status === 400 && /api key/i.test(m)) throw new Error('Gemini: ключ не підходить');
  if (r.status === 403) throw new Error('Gemini: ключ не підходить або API не ввімкнено');
  if (r.status === 429) throw new Error('Gemini: забагато запитів, безкоштовний ліміт. Зачекай хвилину (або до завтра, якщо вичерпано денний)');
  if (r.status === 503 || r.status === 500) throw new Error('Gemini зараз перевантажений у Google. Спробуй ще раз за хвилину');
  if (!r.ok) throw new Error('Gemini: помилка ' + r.status + (m ? ' — ' + m : r.status ? '' : ' (немає інтернету?)'));
  const c = JSON.parse(r.text).candidates?.[0];
  const t = (c?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
  if (!t) throw new Error('Gemini не дав відповіді' + (c?.finishReason ? ' (' + c.finishReason + ')' : ''));
  return t;
}
async function ai(system, user, maxTokens = 800){
  const who = await aiWho();
  if (who === 'gemini') return gemini(system, user);
  if (who === 'claude') return claude(system, user, maxTokens);
  throw new Error('Додай ключ Gemini у налаштуваннях');
}
const jsonFrom = t => { const m = t.match(/[\[{][\s\S]*[\]}]/); return JSON.parse(m ? m[0] : t); };
// інший варіант від того самого ШІ (коли DeepL недоступний, наприклад на телефоні)
async function aiAlt(texts, mains){
  const out = await ai('Ти перекладач художньої літератури з німецької на українську. Відповідай лише JSON-масивом рядків.',
    'Для кожного німецького фрагмента дай ІНШИЙ варіант українського перекладу, ніж наведений: ближчий до німецького порядку слів і конструкцій, щоб було видно будову оригіналу, але грамотний. Поверни JSON-масив у тому ж порядку.\n\n' + JSON.stringify(texts.map((t, i) => ({ de:t, uk:mains[i] }))), 4000);
  return jsonFrom(out);
}
async function aiParas(texts){
  const out = await ai('Ти перекладач художньої літератури з німецької на українську. Перекладай точно і природно, зберігаючи стиль. Відповідай лише JSON-масивом рядків.',
    'Переклади кожен абзац українською. Поверни JSON-масив перекладів у тому ж порядку.\n\n' + JSON.stringify(texts), 4000);
  return jsonFrom(out);
}

/* =========================================================
   Спливаюче вікно слова
   ========================================================= */
let popCtx = null;
function sentenceAt(text, off){
  let s = off, e = off;
  while (s > 0 && !(/[.!?…]/.test(text[s-1]) && /\s/.test(text[s] || ''))) s--;
  while (e < text.length && !/[.!?…]/.test(text[e])) e++;
  while (e < text.length && /[.!?…»«"“”)\]]/.test(text[e])) e++;
  return text.slice(s, e).trim();
}
async function openPop(el){
  document.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  const p = el.closest('[data-p]'), pi = +p.dataset.p, sg = p.dataset.sg && songs[p.dataset.sg];
  const text = sg ? sg.lines[pi].de : cur.book.chapters[cur.meta.pos.ch].paras[pi], word = el.textContent;
  const sent = sentenceAt(text, +el.dataset.o);
  const cands = lookup(word);
  popCtx = { word, sent:sg ? text : sent, cands, el, ai:null, sentTr:null, expl:null, b:sg ? sg.title + (sg.artist ? ' — ' + sg.artist : '') : '' };
  drawPop(); placePop(el);
  const prov = await providerFor('word');
  const best = cands[0];
  if (prov === 'ai') aiWord();
  else if (prov === 'deepl' && best && !words.uk[best.l]) {
    try { const [t] = await deepl([withArt(best.l, best.e)]); words.uk[best.l] = t.replace(/^(der|die|das)\s+/i, ''); saveWords(); if (popCtx && popCtx.word === word) drawPop(); } catch (e) { toast(e.message, 4000); }
  }
}
async function aiWord(){
  const ctx = popCtx; ctx.ai = 'loading'; drawPop();
  try {
    const who = await aiWho();
    const t = await ai('Ти помічник для вивчення німецької мови носієм української. Відповідай лише JSON без пояснень.',
      `Речення: «${ctx.sent}»\nСлово: «${ctx.word}»\nПоверни JSON: {"lemma": "початкова форма (для іменника з артиклем)", "uk": "переклад українською саме в цьому контексті, 1–4 слова", "gram": "коротко граматична форма українською, напр. дієслово, претерит, 3 ос. одн.", "note": "коротка примітка, якщо слово має тут особливе значення або це частина сталого виразу; інакше порожній рядок"}`, 400);
    ctx.ai = jsonFrom(t); ctx.ai.by = aiLabel(who);
    const l = ctx.cands[0]?.l; if (l && !words.uk[l] && ctx.ai.uk) { words.uk[l] = ctx.ai.uk; saveWords(); }
  } catch (e) { ctx.ai = { error:e.message }; }
  if (popCtx === ctx) drawPop();
}
function drawPop(){
  const c = popCtx; if (!c) return;
  const best = c.cands[0];
  let h = `<div class="row"><div class="pw">${esc(c.word)}</div><div class="spacer"></div><button class="ico" data-act="closepop">✕</button></div>`;
  if (best) {
    const e = best.e, uk = ukOf(best.l, e);
    h += `<div class="pl">${esc(withArt(best.l, e))} · ${e.p.map(posUk).join(', ')}${e.r ? ` · частотність #${fmt(e.r)}` : ''}${best.comp ? ` · складне: ${esc(best.comp.mod)} + ${esc(best.comp.head)}` : ''}</div>`;
    if (c.ai && c.ai !== 'loading' && !c.ai.error) h += `<div class="uk"><b>${esc(c.ai.uk)}</b></div><div class="src">${esc(c.ai.by || 'ШІ')} · у цьому контексті</div>${c.ai.gram ? `<div class="hint" style="margin-top:4px">${esc(c.ai.lemma || '')}${c.ai.lemma ? ' — ' : ''}${esc(c.ai.gram)}</div>` : ''}${c.ai.note ? `<div class="box">${esc(c.ai.note)}</div>` : ''}`;
    else if (uk) h += `<div class="uk">${uk.src === 'api' ? `<b>${esc(uk.t)}</b>` : `<span class="approx">≈ ${esc(uk.t)}</span>`}</div><div class="src">${uk.src === 'api' ? 'переклад збережено' : 'приблизно, через англійський словник'}</div>`;
    if (c.ai === 'loading') h += `<div class="hint" style="margin-top:6px"><span class="spin"></span> ШІ перекладає в контексті…</div>`;
    if (c.ai && c.ai.error) h += `<div class="hint" style="color:var(--bad);margin-top:6px">${esc(c.ai.error)}</div>`;
    h += `<ul class="en">${(e.en || []).slice(0,3).map(g => `<li>${esc(g)}</li>`).join('')}</ul>`;
    if (c.cands.length > 1) h += `<div class="hint" style="margin-top:6px">Інші варіанти: ${c.cands.slice(1,4).map(x => esc(withArt(x.l, x.e))).join(', ')}</div>`;
  } else h += `<div class="hint" style="margin-top:6px">Слова немає у словнику${/^[A-ZÄÖÜ]/.test(c.word) ? ' (можливо, це ім\'я)' : ''}.</div>`;
  if (c.sentTr) h += `<div class="box">${c.sentTr === 'loading' ? '<span class="spin"></span> Перекладаю речення…' : esc(c.sentTr)}</div>`;
  if (c.expl) h += `<div class="box">${c.expl === 'loading' ? '<span class="spin"></span> ШІ пояснює…' : esc(c.expl).replace(/\n/g, '<br>')}</div>`;
  const l = best?.l;
  h += `<div class="acts">
    <button class="btn sm" data-act="sent">Перекласти речення</button>
    <button class="btn sm" data-act="ai">ШІ: в контексті</button>
    <button class="btn sm" data-act="explain">Пояснити граматику</button>
    <button class="btn sm" data-act="askclaude" title="Скопіює запитання і відкриє claude.ai у браузері">Запитати Claude ↗</button>
    ${l ? `<button class="btn sm" data-act="star">${words.star[l] ? '★ У моїх словах' : '☆ У мої слова'}</button><button class="btn sm" data-act="known">${words.known[l] ? '✓ Знаю (зняти)' : '✓ Знаю'}</button>` : ''}
  </div>`;
  $('#pop').innerHTML = h; $('#pop').classList.remove('hidden');
}
function placePop(el){
  if (innerWidth <= 700) return;   // на телефоні вікно слова — знизу екрана (CSS)
  const r = el.getBoundingClientRect(), pp = $('#pop'), w = 380;
  let x = Math.min(innerWidth - w - 12, Math.max(190, r.left + r.width/2 - w/2));
  let y = r.bottom + 8;
  pp.style.left = x + 'px'; pp.style.top = y + 'px';
  requestAnimationFrame(() => { const h = pp.offsetHeight; if (y + h > innerHeight - 40) pp.style.top = Math.max(60, r.top - h - 8) + 'px'; });
}
function closePop(){ popCtx = null; $('#pop')?.classList.add('hidden'); document.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel')); }
async function popAction(a){
  const c = popCtx; if (!c) return;
  const l = c.cands[0]?.l;
  if (a === 'closepop') return closePop();
  if (a === 'star' && l) { if (words.star[l]) delete words.star[l]; else words.star[l] = { s:c.sent, w:c.word, b:c.b || cur?.meta.title || '', d:todayKey() }; saveWords(); drawPop(); c.el.classList.toggle('star', !!words.star[l]); vocabCache = {}; return; }
  if (a === 'known' && l) { if (words.known[l]) delete words.known[l]; else words.known[l] = 1; saveWords(); drawPop(); vocabCache = {}; return; }
  if (a === 'sent') {
    const prov = await providerFor('tr'); if (!prov) { toast('Додай ключ DeepL або Gemini у налаштуваннях'); return; }
    c.sentTr = 'loading'; drawPop();
    try { c.sentTr = prov === 'deepl' ? (await deepl([c.sent]))[0] : (await aiParas([c.sent]))[0]; } catch (e) { c.sentTr = '⚠ ' + e.message; }
    if (popCtx === c) drawPop(); return;
  }
  if (a === 'ai') { if (!(await aiWho())) { toast('Додай ключ Gemini у налаштуваннях'); return; } aiWord(); return; }
  if (a === 'askclaude') {
    const lemma = c.cands[0] ? withArt(c.cands[0].l, c.cands[0].e) : '';
    const q = `Я вивчаю німецьку (рівень B2), рідна мова українська. Поясни українською, коротко:\n1) що означає слово «${c.word}»${lemma ? ` (${lemma})` : ''} саме в цьому реченні і як його перекласти;\n2) граматику речення;\n3) як перекласти все речення.\n\nРечення: «${c.sent}»` + (cur?.meta.title ? `\nКнижка: ${cur.meta.title}` : '');
    await api.copy(q);
    api.openUrl('https://claude.ai/new?q=' + encodeURIComponent(q));
    toast('Відкриваю claude.ai. Запитання також скопійовано: якщо поле порожнє, натисни Ctrl+V', 6000);
    return;
  }
  if (a === 'explain') {
    if (!(await aiWho())) { toast('Додай ключ Gemini у налаштуваннях'); return; }
    c.expl = 'loading'; drawPop();
    try { c.expl = await ai('Ти викладач німецької для носія української рівня B2. Пиши коротко, українською, без markdown.', `Поясни коротко (до 6 рядків) граматику і зміст цього речення, особливо слово «${c.word}»: «${c.sent}»`, 700); }
    catch (e) { c.expl = '⚠ ' + e.message; }
    if (popCtx === c) drawPop();
  }
}

/* =========================================================
   Вортшатц
   ========================================================= */
async function analyze(bookId){
  if (vocabCache[bookId]) return vocabCache[bookId];
  const book = cur && cur.meta.id === bookId ? cur.book : await api.read('book-' + bookId);
  const map = new Map(); let off = 0, total = 0;
  book.chapters.forEach((c, ci) => c.paras.forEach((t, pi) => {
    const start = off;
    t.replace(WORD_RE, (m, o) => {
      total++;
      const cs = lookup(m), best = cs[0];
      if (!best) return m;
      const e = best.e;
      if (e.n || (e.p.length && e.p.every(p => FUNC_POS.includes(p) || p === 'name'))) return m;
      let it = map.get(best.l);
      if (!it) { it = { l:best.l, e, comp:best.comp, n:0, occ:[], first:{ ci, pi, o, w:m } }; map.set(best.l, it); }
      it.n++; it.occ.push(start + o);
      return m;
    });
    off += t.length;
  }));
  return (vocabCache[bookId] = { book, items:[...map.values()], total, chapterStarts:book.chapters.map((c, ci) => 0) });
}
function chapterRange(book, ci){
  let s = 0; for (let i = 0; i < ci; i++) s += book.chapters[i].paras.reduce((a,p) => a + p.length, 0);
  return [s, s + book.chapters[ci].paras.reduce((a,p) => a + p.length, 0)];
}
async function vocabList(){
  const meta = library.books.find(b => b.id === vocabBookId); if (!meta) return null;
  const an = await analyze(meta.id);
  let range = [0, Infinity];
  if (vocabScope === 'chapter') range = chapterRange(an.book, Math.min(meta.pos.ch || 0, an.book.chapters.length-1));
  if (vocabScope === 'unread') range = [meta.read || 0, Infinity];
  const list = [];
  for (const it of an.items) {
    if (it.e.r && it.e.r <= settings.banal) continue;
    const n = it.occ.filter(o => o >= range[0] && o < range[1]).length;
    if (n < settings.minCount) continue;
    list.push({ ...it, cnt:n });
  }
  list.sort((a,b) => b.cnt - a.cnt || (a.e.r || 1e9) - (b.e.r || 1e9));
  return { meta, an, list };
}
function exampleOf(an, it){
  const t = an.book.chapters[it.first.ci].paras[it.first.pi];
  let s = sentenceAt(t, it.first.o);
  if (s.length > 220) { const i = s.indexOf(it.first.w); s = (i > 90 ? '…' + s.slice(i - 80) : s).slice(0, 220) + '…'; }
  return s;
}
const markWord = (s, w) => esc(s).replace(new RegExp('(^|[^\\p{L}])(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![\\p{L}])', 'u'), '$1<mark>$2</mark>');
async function renderVocab(){
  if (!vocabBookId) vocabBookId = cur?.meta.id || library.books[0]?.id;
  if (!vocabBookId) { $('#main').innerHTML = '<div class="empty">Спочатку додай книжку</div>'; return; }
  $('#main').innerHTML = '<div class="loading">Рахую слова…</div>';
  const res = await vocabList(); if (!res) return;
  const { meta, an, list } = res;
  const visible = list.filter(it => !words.known[it.l]);
  const knownCnt = list.length - visible.length;
  const shown = visible.slice(0, 600);
  $('#main').innerHTML = `
    <div class="row" style="margin-bottom:12px"><h1>Вортшатц</h1><div class="spacer"></div>
      <select class="inp" id="vBook">${library.books.map(b => `<option value="${b.id}" ${b.id === meta.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select></div>
    <div class="panel">
      <div class="vtools">
        <div class="seg">${[['book','Уся книжка'],['chapter','Поточний розділ'],['unread','Ще не прочитане']].map(([k,l]) => `<button class="${vocabScope === k ? 'on' : ''}" data-scope="${k}">${l}</button>`).join('')}</div>
        <label class="hint">Пропускати найуживаніші <select class="inp" id="vBanal">${[0,500,1000,1500,2000,3000,4000,5000,7000].map(n => `<option value="${n}" ${settings.banal === n ? 'selected' : ''}>${n ? n + ' слів' : 'нічого'}</option>`).join('')}</select></label>
        <label class="hint">мін. разів у тексті <select class="inp" id="vMin">${[1,2,3,4,5,8].map(n => `<option ${settings.minCount === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <div class="hint">Знайдено <b>${visible.length}</b> слів${knownCnt ? ` (ще ${knownCnt} позначено «знаю»)` : ''}. Займенники, артиклі, прийменники та імена відкинуто автоматично. Сортування — від найчастіших у цьому тексті.</div>
      <div class="vtools" style="margin:12px 0 0">
        <button class="btn" data-act="trlist">🌐 Перекласти список українською</button>
        <span class="hint">Експорт:</span>
        <select class="inp" id="vFmt">${[['word','Слова (з артиклем)'],['word_tr','Слово — переклад'],['word_tr_ex','Слово — переклад — приклад']].map(([k,l]) => `<option value="${k}" ${settings.exportFmt === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="inp" id="vLim">${[[0,'усі'],[50,'перші 50'],[100,'перші 100'],[200,'перші 200'],[500,'перші 500']].map(([k,l]) => `<option value="${k}" ${settings.exportLimit === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn primary" data-act="copylist">📋 Копіювати</button><button class="btn" data-act="savelist">💾 Зберегти .txt</button>
      </div>
    </div>
    ${shown.length ? `<div class="vwrap"><table class="vtable"><thead><tr><th>#</th><th>Слово</th><th>Разів</th><th>Частотність</th><th>Переклад</th><th>Приклад з книжки</th><th></th></tr></thead><tbody>
      ${shown.map((it, i) => vRow(an, it, i)).join('')}</tbody></table></div>${visible.length > shown.length ? `<div class="hint" style="margin-top:8px">Показано перші ${shown.length}. В експорт потрапляють усі.</div>` : ''}` : '<div class="empty">За цими фільтрами слів немає</div>'}`;
  $('#vBook').addEventListener('change', e => { vocabBookId = e.target.value; renderVocab(); });
  $('#vBanal').addEventListener('change', e => { settings.banal = +e.target.value; saveSettings(); renderVocab(); });
  $('#vMin').addEventListener('change', e => { settings.minCount = +e.target.value; saveSettings(); renderVocab(); });
  $('#vFmt').addEventListener('change', e => { settings.exportFmt = e.target.value; saveSettings(); });
  $('#vLim').addEventListener('change', e => { settings.exportLimit = +e.target.value; saveSettings(); });
}
function vRow(an, it, i){
  const uk = ukOf(it.l, it.e);
  return `<tr data-l="${esc(it.l)}"><td class="hint">${i+1}</td>
    <td class="lem">${it.e.g && it.e.p.includes('noun') ? `<span class="art">${ART[it.e.g]}</span> ` : ''}${esc(it.l)}${it.comp ? `<div class="hint">${esc(it.comp.mod)} + ${esc(it.comp.head)}</div>` : ''}</td>
    <td>${it.cnt}</td><td class="hint">${it.e.r ? '#' + fmt(it.e.r) : 'рідкісне'}</td>
    <td class="ukc">${uk ? (uk.src === 'api' ? esc(uk.t) : `<span class="approx">≈ ${esc(uk.t)}</span>`) : ''}<div class="hint">${esc((it.e.en || [])[0] || '').slice(0, 70)}</div></td>
    <td class="ex"><a href="#" class="hint" data-jump="${it.first.ci}.${it.first.pi}" title="Відкрити в книжці">↗</a> ${markWord(exampleOf(an, it), it.first.w)}</td>
    <td style="white-space:nowrap"><button class="ico ${words.star[it.l] ? 'on' : ''}" data-vstar="${esc(it.l)}" title="У мої слова">${words.star[it.l] ? '★' : '☆'}</button><button class="ico" data-vknown="${esc(it.l)}" title="Знаю — прибрати зі списку">✓</button></td></tr>`;
}
function exportLine(l, e, ex){
  const w = withArt(l, e), uk = ukOf(l, e), t = uk ? uk.t : ((e.en || [])[0] || '');
  if (settings.exportFmt === 'word') return w;
  if (settings.exportFmt === 'word_tr') return `${w} — ${t}`;
  return `${w} — ${t} — ${ex}`;
}
async function exportText(){
  const { an, list, meta } = await vocabList();
  let items = list.filter(it => !words.known[it.l]);
  if (settings.exportLimit) items = items.slice(0, settings.exportLimit);
  return { meta, text:items.map(it => exportLine(it.l, it.e, exampleOf(an, it))).join('\n'), n:items.length };
}
async function translateList(items){
  const prov = await providerFor('word') || await providerFor('tr');
  if (!prov) { toast('Додай ключ DeepL або Gemini у налаштуваннях', 3500); return 0; }
  const need = items.filter(it => !words.uk[it.l]).slice(0, 400);
  if (!need.length) { toast('Усі слова вже перекладені'); return 0; }
  let done = 0;
  for (let i = 0; i < need.length; i += (prov === 'deepl' ? 50 : 60)) {
    const part = need.slice(i, i + (prov === 'deepl' ? 50 : 60));
    toast(`Перекладаю ${i + part.length} з ${need.length}…`, 60000);
    try {
      if (prov === 'deepl') {
        const tr = await deepl(part.map(it => withArt(it.l, it.e)));
        part.forEach((it, j) => { words.uk[it.l] = tr[j].replace(/^(der|die|das)\s+/i, ''); });
      } else {
        const out = jsonFrom(await ai('Ти укладач німецько-українського словника. Відповідай лише JSON-об’єктом.',
          'Дай короткий український переклад (1–4 слова, найуживаніше значення) для кожного німецького слова. Поверни JSON {"слово": "переклад"}.\n' + JSON.stringify(part.map(it => it.l)), 3000));
        part.forEach(it => { if (out[it.l]) words.uk[it.l] = out[it.l]; });
      }
      done += part.length; saveWords();
    } catch (e) { toast(e.message, 5000); break; }
  }
  toast(`Перекладено ${done} слів`);
  return done;
}

/* ---------- мої слова ---------- */
function renderMyWords(){
  const ls = Object.keys(words.star).sort((a,b) => (words.star[b].d || '').localeCompare(words.star[a].d || ''));
  $('#main').innerHTML = `
    <div class="row" style="margin-bottom:12px"><h1>★ Мої слова</h1><div class="spacer"></div>
      <select class="inp" id="mFmt">${[['word','Слова (з артиклем)'],['word_tr','Слово — переклад'],['word_tr_ex','Слово — переклад — приклад']].map(([k,l]) => `<option value="${k}" ${settings.exportFmt === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn primary" data-act="copymy">📋 Копіювати</button><button class="btn" data-act="savemy">💾 Зберегти .txt</button></div>
    <div class="hint" style="margin-bottom:12px">Слова, які ти позначив зірочкою під час читання. Натисни на слово в тексті → «☆ У мої слова».</div>
    ${ls.length ? `<div class="vwrap"><table class="vtable"><thead><tr><th>Слово</th><th>Переклад</th><th>Речення</th><th>Книжка</th><th></th></tr></thead><tbody>
      ${ls.map(l => { const e = D[l] || { p:[], en:[] }, s = words.star[l], uk = ukOf(l, e); return `<tr><td class="lem">${esc(withArt(l, e))}</td><td class="ukc">${uk ? (uk.src === 'api' ? esc(uk.t) : `<span class="approx">≈ ${esc(uk.t)}</span>`) : ''}<div class="hint">${esc((e.en || [])[0] || '').slice(0,70)}</div></td><td class="ex">${markWord(s.s || '', s.w || l)}</td><td class="hint">${esc(s.b || '')}<br>${s.d ? short(s.d) : ''}</td><td><button class="ico" data-unstar="${esc(l)}" title="Прибрати">✕</button></td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">Поки порожньо</div>'}`;
  $('#mFmt').addEventListener('change', e => { settings.exportFmt = e.target.value; saveSettings(); });
}
const myText = () => Object.keys(words.star).map(l => exportLine(l, D[l] || { p:[], en:[] }, words.star[l].s || '')).join('\n');

/* ---------- налаштування ---------- */
async function renderSettings(){
  const k = await keys();
  const mask = v => v ? '•••••••• ' + v.slice(-4) : '';
  $('#main').innerHTML = `
    <h1 style="margin-bottom:14px">Налаштування</h1>
    <div class="sgrid">
      <div class="panel"><h3>🎯 Мета читання</h3>
        <label class="f">Рахувати мету в</label>
        <div class="seg"><button class="${settings.goalType === 'pages' ? 'on' : ''}" data-goal="pages">сторінках</button><button class="${settings.goalType === 'minutes' ? 'on' : ''}" data-goal="minutes">хвилинах</button></div>
        <div class="row" style="margin-top:10px">
          ${settings.goalType === 'pages' ? `<label class="hint">Сторінок на день <input class="inp" id="sGoal" type="number" min="1" value="${settings.goalPages}" style="width:80px"></label><span class="hint">1 стор. = 1800 знаків (Normseite)</span>`
            : `<label class="hint">Хвилин на день <input class="inp" id="sGoal" type="number" min="1" value="${settings.goalMin}" style="width:80px"></label><span class="hint">рахується лише активне читання</span>`}
        </div>
        <label class="f">Скільки книжок прочитати за рік (0 — без мети)</label><input class="inp" id="sYear" type="number" min="0" value="${settings.yearGoal}" style="width:90px">
      </div>
      <div class="panel"><h3>🌐 Переклад</h3>
        <div class="cap">Без ключів працює вбудований словник. Ключі зберігаються ${appInfo.web ? 'лише на цьому пристрої' : 'зашифрованими на цьому комп\'ютері'}.</div>
        ${appInfo.web ? '<div class="hint" style="margin-bottom:6px">DeepL не працює в браузері (він це блокує), тому на телефоні переклад іде через Gemini. Переклади, зроблені на ПК, приходять сюди із синхронізацією.</div>' : ''}
        <div ${appInfo.web ? 'class="hidden"' : ''}><label class="f">Ключ DeepL (безкоштовний: 500 000 символів на місяць)</label>
        <div class="keyrow"><input class="inp" id="kDeepl" type="password" placeholder="${k.deepl ? mask(k.deepl) : 'вставити ключ…'}"><button class="btn" data-savekey="deepl">Зберегти</button><button class="btn" data-testkey="deepl">Перевірити</button>${k.deepl ? '<button class="btn plain" data-delkey="deepl">✕</button>' : ''}</div>
        <a href="#" class="hint" data-url="https://www.deepl.com/pro-api">Отримати ключ DeepL ↗</a></div>
        <label class="f">Ключ Gemini (безкоштовний, для пояснень і перекладу в контексті)</label>
        <div class="keyrow"><input class="inp" id="kGemini" type="password" placeholder="${k.gemini ? mask(k.gemini) : 'вставити ключ…'}"><button class="btn" data-savekey="gemini">Зберегти</button><button class="btn" data-testkey="gemini">Перевірити</button>${k.gemini ? '<button class="btn plain" data-delkey="gemini">✕</button>' : ''}</div>
        <a href="#" class="hint" data-url="https://aistudio.google.com/apikey">Отримати ключ Gemini у Google AI Studio ↗</a>
        <label class="f">Модель Gemini</label>
        <select class="inp" id="sGModel">${[['gemini-flash-latest','Flash — точніша'],['gemini-flash-lite-latest','Flash-Lite — швидша, більший безкоштовний ліміт']].map(([v,l]) => `<option value="${v}" ${settings.geminiModel === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <details style="margin-top:10px"><summary class="hint">Claude API (платний, необов'язково)</summary>
        <label class="f">Ключ Claude API</label>
        <div class="keyrow"><input class="inp" id="kClaude" type="password" placeholder="${k.claude ? mask(k.claude) : 'вставити ключ…'}"><button class="btn" data-savekey="claude">Зберегти</button><button class="btn" data-testkey="claude">Перевірити</button>${k.claude ? '<button class="btn plain" data-delkey="claude">✕</button>' : ''}</div>
        <a href="#" class="hint" data-url="https://console.anthropic.com/">Отримати ключ Claude ↗</a>
        <label class="f">Модель Claude</label>
        <select class="inp" id="sModel">${[['claude-haiku-5-5','Haiku — швидка і дешева'],['claude-sonnet-5-5','Sonnet — точніша, дорожча']].map(([v,l]) => `<option value="${v}" ${settings.claudeModel === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </details>
        <label class="f">ШІ для пояснень і перекладу в контексті</label>
        <div class="seg">${[['auto','Авто'],['gemini','Gemini'],['claude','Claude API']].map(([v,l]) => `<button class="${settings.aiProvider === v ? 'on' : ''}" data-aip="${v}">${l}</button>`).join('')}</div>
        <label class="f">Паралельний переклад і речення через</label>
        <div class="seg">${appInfo.web ? '' : `<button class="${settings.trProvider === 'deepl' ? 'on' : ''}" data-trp="deepl">DeepL</button>`}<button class="${settings.trProvider === 'ai' ? 'on' : ''}" data-trp="ai">ШІ (Gemini/Claude)</button></div>
        <label class="f">Переклад слова по кліку</label>
        <div class="seg">${[['auto','Авто (найкраще з доступного)'],['dict','Лише словник'],['deepl','DeepL'],['ai','ШІ в контексті']].filter(x => !(appInfo.web && x[0] === 'deepl')).map(([v,l]) => `<button class="${settings.wordProvider === v ? 'on' : ''}" data-wp="${v}">${l}</button>`).join('')}</div>
        <div class="hint" style="margin-top:8px">Кнопка «Запитати Claude ↗» біля слова працює без ключа: вона копіює запитання і відкриває claude.ai з вашим звичайним акаунтом.</div>
      </div>
      <div class="panel"><h3>🧠 Вортшатц</h3>
        <label class="f">Скільки найуживаніших слів вважати банальними</label>
        <select class="inp" id="sBanal">${[0,500,1000,1500,2000,3000,4000,5000,7000].map(n => `<option value="${n}" ${settings.banal === n ? 'selected' : ''}>${n || 'не пропускати'}</option>`).join('')}</select>
        <div class="hint" style="margin-top:6px">Для рівня B2 добре підходить 2000. Слова, позначені «знаю», теж не потрапляють у список (зараз їх ${Object.keys(words.known).length}).</div>
        ${Object.keys(words.known).length ? '<button class="btn sm" style="margin-top:8px" data-act="clearknown">Очистити список «знаю»</button>' : ''}
      </div>
      <div class="panel" id="syncPanel"><h3>☁ Синхронізація з телефоном</h3>${syncPanelBody()}</div>
      ${appInfo.web ? `<div class="panel"><h3>💾 Дані</h3><div class="hint">Версія ${esc(appInfo.version || '')} (веб). Дані зберігаються в цьому браузері й у Dropbox, якщо підключено синхронізацію.</div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="backup">Експорт резервної копії</button><button class="btn" data-act="restore">Імпорт</button><button class="btn" data-act="webreload">↻ Оновити програму</button></div></div>` : `<div class="panel"><h3>💾 Дані та оновлення</h3>
        <div class="hint">Версія ${esc(appInfo.version || '')}. Дані: <code>${esc(appInfo.userData || '')}</code>. Щодня автоматично робиться резервна копія.</div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="opendata">Відкрити папку з даними</button><button class="btn" data-act="backup">Експорт резервної копії</button><button class="btn" data-act="restore">Імпорт</button></div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="checkupd">Перевірити оновлення</button><button class="btn" data-act="pickupd">Встановити оновлення з файлу…</button></div>
        <div class="hint" style="margin-top:6px">Файли оновлень <code>Chytalka-update-*.zip</code> програма сама шукає в «Завантаженнях», на робочому столі та в «Документах».</div>
      </div>`}
    </div>`;
  $('#sGoal').addEventListener('change', e => { const v = Math.max(1, +e.target.value || 1); if (settings.goalType === 'pages') settings.goalPages = v; else settings.goalMin = v; saveSettings(); updatePills(); });
  $('#sYear').addEventListener('change', e => { settings.yearGoal = Math.max(0, +e.target.value || 0); saveSettings(); updatePills(); });
  $('#sModel').addEventListener('change', e => { settings.claudeModel = e.target.value; saveSettings(); });
  $('#sGModel').addEventListener('change', e => { settings.geminiModel = e.target.value; saveSettings(); });
  $('#sBanal').addEventListener('change', e => { settings.banal = +e.target.value; saveSettings(); });
}

/* =========================================================
   Події
   ========================================================= */
document.addEventListener('click', async e => {
  if (Date.now() - swiped < 400) return;   // після свайпу не відкривати слово
  const w = e.target.closest('.rtext .w, .song .w');
  if (w) { const was = popCtx && popCtx.el === w; if (popCtx) closePop(); if (!was) openPop(w); return; }
  if (!e.target.closest('#pop') && popCtx) { closePop(); return; }
  if ($('#preMenu') && !e.target.closest('#preMenu,[data-pre]')) closePreMenu();
  // дотик/клік по краях сторінки гортає: ліва третина — назад, права — вперед
  if (view === 'reader' && e.target.closest('#rwrap') && !e.target.closest('button,a,select')) {
    const r = $('#rwrap').getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x < 0.3) { turnPage(-1); return; } if (x > 0.7) { turnPage(1); return; }
  }
  const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); api.openUrl(a.dataset.url); return; }
  const j = e.target.closest('a[data-jump]');
  if (j) { e.preventDefault(); const [c, p] = j.dataset.jump.split('.').map(Number); openBook(vocabBookId, c, p); return; }
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.view) { go(d.view); return; }
  if (d.open) { openBook(d.open); return; }
  if (d.vocab) { vocabBookId = d.vocab; go('vocab'); return; }
  if (d.finish) { const m = library.books.find(x => x.id === d.finish); m.finished = m.finished ? null : todayKey(); saveLib(true); toast(m.finished ? '🎉 Позначено прочитаною' : 'Позначку знято'); render(); return; }
  if (d.delbook) {
    const m = library.books.find(x => x.id === d.delbook);
    if (!confirm(`Видалити «${m.title}» з бібліотеки? Прогрес і переклади цієї книжки теж зникнуть.`)) return;
    library.books = library.books.filter(x => x.id !== m.id); api.remove('book-' + m.id); api.remove('tr-' + m.id);
    if (cur && cur.meta.id === m.id) cur = null; saveLib(true); render(); return;
  }
  if (d.chap) { savePos(); cur.meta.pos = { ch:+d.chap, p:0 }; moved(); renderReader(); return; }
  if (d.pg) { turnPage(+d.pg); return; }
  if (d.retr) { if (!cur) return; if (trAltOn.has(d.retr)) { delete cur.tr[altKey(d.retr)]; markTrDirty(); trAltOn.delete(d.retr); toggleAlt(d.retr); return; } delete cur.tr[d.retr]; markTrDirty(); setTr(d.retr, '…', true); trFail = 0; trQueue.add(d.retr); pumpTr(); return; }
  if (d.alt) { toggleAlt(d.alt); return; }
  if (d.pre) { preMenu(e.target.closest('[data-pre]')); return; }
  if (d.prego) { closePreMenu(); const [sc, only] = d.prego.split(':'); pretranslate(sc, only === 'both' ? undefined : only); return; }
  if (d.par) { settings.parallel = d.par === '2' ? 'side' : d.par === '1'; saveSettings(); savePos(); renderReader(); return; }
  if (d.font) { settings.font = Math.max(14, Math.min(30, settings.font + +d.font)); saveSettings(); document.documentElement.style.setProperty('--rf', settings.font + 'px'); relayoutKeep(); return; }
  if (d.theme) { settings.theme = d.theme; saveSettings(); document.body.className = 'th-' + settings.theme + ' reading'; document.querySelectorAll('[data-theme]').forEach(x => x.classList.toggle('on', x.dataset.theme === d.theme)); return; }
  if (d.scope) { vocabScope = d.scope; renderVocab(); return; }
  if (d.vstar) { const l = d.vstar; if (words.star[l]) delete words.star[l]; else { const an = vocabCache[vocabBookId], it = an?.items.find(x => x.l === l); words.star[l] = { s:it ? exampleOf(an, it) : '', w:it?.first.w || l, b:library.books.find(x => x.id === vocabBookId)?.title || '', d:todayKey() }; } saveWords(); b.classList.toggle('on', !!words.star[l]); b.textContent = words.star[l] ? '★' : '☆'; return; }
  if (d.vknown) { words.known[d.vknown] = 1; saveWords(); b.closest('tr').remove(); toast('Позначено «знаю» — слово більше не з\'являтиметься у вортшатці'); return; }
  if (d.unstar) { delete words.star[d.unstar]; saveWords(); renderMyWords(); return; }
  if (d.goal) { settings.goalType = d.goal; saveSettings(); renderSettings(); updatePills(); return; }
  if (d.trp) { settings.trProvider = d.trp; saveSettings(); renderSettings(); return; }
  if (d.aip) { settings.aiProvider = d.aip; saveSettings(); renderSettings(); return; }
  if (d.wp) { settings.wordProvider = d.wp; saveSettings(); renderSettings(); return; }
  if (d.savekey) { const inp = $({ deepl:'#kDeepl', claude:'#kClaude', gemini:'#kGemini' }[d.savekey]); const v = inp.value.trim(); if (!v) { toast('Встав ключ у поле'); return; } await api.setSecret(d.savekey, v); toast('Ключ збережено'); renderSettings(); return; }
  if (d.delkey) { await api.setSecret(d.delkey, ''); toast('Ключ видалено'); renderSettings(); return; }
  if (d.testkey) {
    toast('Перевіряю…', 10000);
    try { if (d.testkey === 'deepl') { const [t] = await deepl(['Guten Morgen']); toast('DeepL працює: «' + t + '»', 4000); } else if (d.testkey === 'gemini') { const t = await gemini('Відповідай одним словом.', 'Переклади українською: Morgen'); toast('Gemini працює: «' + t.trim() + '»', 4000); } else { const t = await claude('Відповідай одним словом.', 'Переклади українською: Morgen', 20); toast('Claude працює: «' + t.trim() + '»', 4000); } }
    catch (err) { toast(err.message, 5000); }
    return;
  }
  if (b.closest('#pop') && d.act) { popAction(d.act); return; }
  if (d.act && await syncAction(d.act)) return;
  switch (d.act) {
    case 'add': addBooks(); break;
    case 'trlist': { const r = await vocabList(); if (await translateList(r.list.filter(it => !words.known[it.l]))) renderVocab(); break; }
    case 'copylist': { const r = await exportText(); await api.copy(r.text); toast(`Скопійовано ${r.n} слів`); break; }
    case 'savelist': { const r = await exportText(); const f = await api.saveFile(`Wortschatz - ${r.meta.title}.txt`, r.text); if (f) toast('Збережено: ' + f, 4000); break; }
    case 'copymy': await api.copy(myText()); toast(`Скопійовано ${Object.keys(words.star).length} слів`); break;
    case 'savemy': { const f = await api.saveFile('Мої слова.txt', myText()); if (f) toast('Збережено: ' + f, 4000); break; }
    case 'clearknown': if (confirm('Очистити список «знаю»?')) { words.known = {}; saveWords(); vocabCache = {}; renderSettings(); } break;
    case 'opendata': api.openData(); break;
    case 'backup': { const f = await api.saveFile(`chytalka-backup-${todayKey()}.json`, JSON.stringify({ settings, library, stats, words })); if (f) toast('Збережено: ' + f, 4000); break; }
    case 'restore': {
      const t = await api.openJson(); if (!t) break;
      try { const o = JSON.parse(t); if (!o.library || !o.stats) throw 0; if (!confirm('Замінити налаштування, статистику і слова даними з файлу? Самі книжки залишаться.')) break;
        settings = Object.assign({}, DEFAULTS, o.settings); stats = o.stats; words = o.words || words;
        const have = new Set(library.books.map(b => b.id)); library.books = o.library.books.filter(b => have.has(b.id)).concat(library.books.filter(b => !o.library.books.some(x => x.id === b.id)));
        saveSettings(true); saveStats(true); saveWords(true); saveLib(true); toast('Дані відновлено'); render(); } catch (err) { toast('Файл не схожий на резервну копію'); }
      break;
    }
    case 'checkupd': { const u = await api.checkUpdate(); if (u.available) showUpdate(u.available); else toast(`У тебе найновіша версія (${u.current}). Файлів оновлення не знайдено.`, 3500); break; }
    case 'pickupd': { const r = await api.installUpdate(null); if (r.ok) toast(`Встановлюю версію ${r.version}, програма перезапуститься…`, 5000); else if (!r.canceled) toast(r.error, 6000); break; }
    case 'installupd': { const r = await api.installUpdate(d.path); if (r.ok) toast(`Встановлюю версію ${r.version}, програма перезапуститься…`, 5000); else toast(r.error, 6000); break; }
    case 'webreload': toast('Оновлюю…'); if (window.webHardReload) window.webHardReload(); break;
    case 'hideupd': $('#banner').classList.add('hidden'); break;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePop();
  if (view === 'reader' && !e.target.closest('input,select,textarea') && cur) {
    if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { const n = cur.meta.pos.ch + (e.key === 'ArrowRight' ? 1 : -1); if (n >= 0 && n < cur.book.chapters.length) { savePos(); cur.meta.pos = { ch:n, p:0 }; moved(); renderReader(); } e.preventDefault(); return; }
    if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (['ArrowRight','ArrowDown','PageDown'].includes(e.key) || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); turnPage(1); }
    else if (['ArrowLeft','ArrowUp','PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); turnPage(-1); }
  }
});
window.addEventListener('beforeunload', () => { savePos(); });

function showUpdate(u){
  const b = $('#banner');
  b.innerHTML = `<span>🔄 Доступна нова версія читалки <b>${esc(u.version)}</b></span><button class="btn primary sm" data-act="installupd" data-path="${esc(u.path)}">Встановити й перезапустити</button><button class="btn plain sm" data-act="hideupd">Пізніше</button>`;
  b.classList.remove('hidden');
}

/* =========================================================
   Старт
   ========================================================= */
(async function init(){
  // чекаємо, поки підвантажаться всі скрипти (songs.js, sync.js)
  if (document.readyState === 'loading') await new Promise(ok => document.addEventListener('DOMContentLoaded', ok));
  await loadAll();
  appInfo = await api.info();
  $('#sideFoot').textContent = 'версія ' + appInfo.version;
  document.body.className = 'th-' + settings.theme;
  const dd = await api.dict();
  D = JSON.parse(dd.dict); F = JSON.parse(dd.forms);
  if (!library.books.length && !library.sampleAdded) {
    const s = await api.sample();
    if (s) { try { await importRaw(s); library.sampleAdded = true; saveLib(true); } catch (e) {} }
  }
  render();
  syncStart();
  const u = await api.checkUpdate(); if (u.available) showUpdate(u.available);
})();
