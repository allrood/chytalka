'use strict';
/* =========================================================
   Пісні з YouTube: посилання → текст пісні з таймкодами, переклад рядків,
   пояснення граматики (Gemini дивиться/слухає відео), плеєр поруч із текстом.
   Пісні зберігаються у сховищі 'songs' і синхронізуються через Dropbox (/reader/songs.json).
   ========================================================= */
let songs = {};                 // { id: { id, yt, title, artist, lines:[{t,de,uk,note}], grammar:[{title,text}], added, upd, del? } }
let songOpen = null;            // id відкритої пісні
let songBusy = null;            // { yt, step } — поки Gemini працює
let songUi = { tr:true, notes:true };
try { songUi = { ...songUi, ...JSON.parse(localStorage.getItem('chytalka-song-ui') || '{}') }; } catch (e) {}
const saveSongUi = () => { try { localStorage.setItem('chytalka-song-ui', JSON.stringify(songUi)); } catch (e) {} };

async function loadSongs(){ songs = await api.read('songs') || {}; }
function saveSongs(){
  api.write('songs', songs);
  if (typeof sync !== 'undefined') { sync.songsDirty = 1; }
  if (typeof scheduleSync === 'function') scheduleSync();
}
const songList = () => Object.values(songs).filter(s => !s.del).sort((a, b) => (b.added || '').localeCompare(a.added || ''));

function ytId(u){
  u = (u || '').trim();
  const m = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/) || u.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}
const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/* ---------- Gemini: текст, переклад, граматика ---------- */
const SONG_SYS = 'Ти викладач німецької для україномовного учня (рівень B1–B2) і перекладач пісень. Відповідай лише JSON.';
function songPrompt(lyrics){
  return (lyrics
    ? 'Ось текст пісні (оригінал):\n"""\n' + lyrics + '\n"""\nРозбий його на рядки так, як вони співаються.'
    : 'Прослухай пісню у цьому відео і запиши її текст мовою оригіналу рядок за рядком так, як він співається (якщо у відео є субтитри з текстом — звір з ними). Повтори приспіву теж записуй.') +
    `\nДля кожного рядка дай:
- "t": секунда відео, коли рядок починає звучати (число${lyrics ? '; якщо відео немає — 0' : ''}),
- "de": рядок оригіналу,
- "uk": точний, природний переклад українською,
- "note": коротке пояснення українською (1–2 речення) граматики або лексики, якщо в рядку є щось варте уваги: відмінок, часова форма, Konjunktiv, відокремлюваний префікс, порядок слів, ідіома, розмовна чи діалектна форма. Якщо нічого особливого — порожній рядок.
Також "grammar": 3–6 головних граматичних тем цієї пісні, кожна {"title": "назва теми", "text": "пояснення українською з прикладами з пісні, 2–4 речення"}.
Поверни JSON: {"title": "назва пісні", "artist": "виконавець", "lang": "de", "lines": [{"t":0,"de":"","uk":"","note":""}], "grammar": [{"title":"","text":""}]}`;
}
async function geminiSong(yt, lyrics){
  const parts = [];
  if (yt) parts.push({ file_data:{ file_uri:'https://www.youtube.com/watch?v=' + yt, mime_type:'video/*' } });
  parts.push({ text:songPrompt(lyrics) });
  const t = await gemini(SONG_SYS, parts, { json:true, lowMedia:true });
  const j = jsonFrom(t);
  if (!j || !Array.isArray(j.lines) || !j.lines.length) throw new Error('Gemini не повернув текст пісні');
  j.lines = j.lines.map(l => ({ t:+l.t || 0, de:String(l.de || '').trim(), uk:String(l.uk || '').trim(), note:String(l.note || '').trim() })).filter(l => l.de);
  j.grammar = (j.grammar || []).filter(g => g && g.title).map(g => ({ title:String(g.title), text:String(g.text || '') }));
  return j;
}
async function addSong(url, lyrics){
  const yt = ytId(url);
  if (!yt && !lyrics) { toast('Встав посилання на YouTube (або текст пісні)', 3500); return; }
  if (!(await api.getSecret('gemini'))) { toast('Для пісень потрібен ключ Gemini у налаштуваннях', 4000); return; }
  const dup = yt && songList().find(s => s.yt === yt);
  if (dup && !lyrics) { songOpen = dup.id; render(); toast('Ця пісня вже є в колекції'); return; }
  songBusy = { yt, step:yt ? 'Gemini слухає пісню і пише текст з перекладом… (до хвилини-двох)' : 'Gemini перекладає текст…' }; render();
  try {
    let j;
    try { j = await geminiSong(yt, lyrics); }
    catch (e) { if (/перевантажений|забагато/.test(e.message)) { songBusy.step = '⚠ ' + e.message + ' Повтор через 20 с…'; render(); await new Promise(ok => setTimeout(ok, 20000)); j = await geminiSong(yt, lyrics); } else throw e; }
    const id = dup ? dup.id : 's' + Date.now().toString(36), now = new Date().toISOString();
    songs[id] = { id, yt, title:j.title || 'Пісня', artist:j.artist || '', lang:j.lang || 'de', lines:j.lines, grammar:j.grammar, added:dup ? dup.added : now, upd:now, timed:!!yt && j.lines.some(l => l.t > 0) };
    saveSongs(); songOpen = id; songBusy = null; render();
    toast('🎵 Пісню додано в колекцію', 3000);
  } catch (e) {
    songBusy = null; render();
    toast('Не вдалося: ' + e.message + (yt ? ' Можна вставити текст вручну.' : ''), 7000);
  }
}

/* ---------- екрани ---------- */
function renderSongs(){
  if (songOpen && songs[songOpen] && !songs[songOpen].del) return renderSong(songs[songOpen]);
  songOpen = null; ytStop();
  const list = songList();
  $('#main').innerHTML = `
  <div class="row"><h1>🎵 Пісні</h1></div>
  <div class="card songadd">
    <h3>Додати пісню з YouTube</h3>
    <div class="hint">Gemini послухає пісню, запише текст з таймкодами, перекладе кожен рядок і пояснить граматику. Працює з безкоштовним ключем Gemini.</div>
    <div class="row" style="margin-top:10px"><input class="inp" id="songUrl" placeholder="https://www.youtube.com/watch?v=…" style="flex:1;min-width:220px"><button class="btn primary" data-act="songadd" ${songBusy ? 'disabled' : ''}>Зробити переклад</button></div>
    <details class="songlyr"><summary>Є готовий текст? Встав його — так точніше</summary><textarea class="inp" id="songLyr" rows="6" placeholder="Текст пісні мовою оригіналу"></textarea></details>
    ${songBusy ? `<div class="hint" style="margin-top:8px"><span class="spin"></span> ${esc(songBusy.step)}</div>` : ''}
  </div>
  <h2>Колекція <span class="hint">${list.length}</span></h2>
  ${list.length ? `<div class="songgrid">${list.map(s => `<button class="songcard" data-song="${s.id}">
      ${s.yt ? `<img src="https://i.ytimg.com/vi/${s.yt}/mqdefault.jpg" alt="">` : '<div class="noimg">🎵</div>'}
      <b>${esc(s.title)}</b><span>${esc(s.artist)}</span></button>`).join('')}</div>` : '<div class="hint">Поки порожньо. Встав посилання на пісню вище.</div>'}`;
}
function renderSong(s){
  const main = $('#main');
  const keepPlayer = $('#ytWrap') && $('#ytWrap').dataset.yt === s.yt;
  const player = keepPlayer ? $('#ytWrap') : null;
  main.innerHTML = `
  <div class="songtop row">
    <button class="btn sm" data-act="songback">← Пісні</button>
    <div class="songttl"><b>${esc(s.title)}</b>${s.artist ? ` <span class="hint">· ${esc(s.artist)}</span>` : ''}</div>
    <div class="spacer"></div>
    <div class="seg"><button class="${songUi.tr ? 'on' : ''}" data-act="songtr">Переклад</button><button class="${songUi.notes ? 'on' : ''}" data-act="songnotes">💡 Пояснення</button></div>
    <button class="btn sm" data-act="songredo" title="Попросити Gemini зробити текст і переклад заново">↻ Заново</button>
    <button class="btn sm danger" data-act="songdel" title="Видалити з колекції">🗑</button>
  </div>
  <div class="songlay">
    <div class="songside">
      <div id="ytSlot"></div>
      ${s.yt && !s.timed ? '<div class="hint">Таймкодів немає — підсвічування рядків не працює, але клік по рядку все одно відкриє відео.</div>' : ''}
      ${s.grammar && s.grammar.length ? `<div class="card songgram"><h3>Граматика в пісні</h3>${s.grammar.map(g => `<details><summary>${esc(g.title)}</summary><div>${esc(g.text)}</div></details>`).join('')}</div>` : ''}
      ${s.yt && !appInfo.web ? `<div class="hint" style="margin-top:8px">Реклама у відео? <a href="#" data-act="ytlogin">Увійти в YouTube</a> (без реклами — лише з YouTube Premium).</div>` : ''}
    </div>
    <div class="song rtext-like${songUi.tr ? '' : ' notr'}${songUi.notes ? '' : ' nonotes'}" id="songText">
      ${s.lines.map((l, i) => `<div class="sl" data-li="${i}" data-t="${l.t}">
        <span class="st">${s.timed ? fmtT(l.t) : ''}</span>
        <div class="sb"><div class="sde" data-p="${i}" data-sg="${s.id}">${paraHTML(l.de, 0, i)}</div>
        ${l.uk ? `<div class="suk">${esc(l.uk)}</div>` : ''}${l.note ? `<div class="snote">💡 ${esc(l.note)}</div>` : ''}</div></div>`).join('')}
      ${s.grammar && s.grammar.length ? `<div class="card songgram songgram2"><h3>Граматика в пісні</h3>${s.grammar.map(g => `<details><summary>${esc(g.title)}</summary><div>${esc(g.text)}</div></details>`).join('')}</div>` : ''}
    </div>
  </div>`;
  if (s.yt) {
    if (player) $('#ytSlot').replaceWith(player);
    else $('#ytSlot').outerHTML = `<div id="ytWrap" data-yt="${s.yt}"><iframe id="ytFrame" src="https://www.youtube.com/embed/${s.yt}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1${location.protocol.startsWith('http') ? '&origin=' + encodeURIComponent(location.origin) : ''}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
    ytListen();
  } else $('#ytSlot').remove();
  songHi(-1);
}

/* ---------- плеєр YouTube (без зовнішніх скриптів: postMessage до iframe) ---------- */
let ytTime = 0, ytTimer = null, ytCurLine = -1;
function ytPost(func, args){ const f = $('#ytFrame'); if (f && f.contentWindow) f.contentWindow.postMessage(JSON.stringify({ event:'command', func, args:args || [], id:1, channel:'widget' }), '*'); }
function ytListen(){
  clearInterval(ytTimer);
  const f = $('#ytFrame'); if (!f) return;
  const hello = () => { try { f.contentWindow.postMessage(JSON.stringify({ event:'listening', id:1, channel:'widget' }), '*'); } catch (e) {} };
  f.addEventListener('load', hello); hello();
  ytTimer = setInterval(() => { if (view !== 'songs' || !$('#ytFrame')) { clearInterval(ytTimer); return; } hello(); }, 1500);
}
function ytStop(){ clearInterval(ytTimer); ytTimer = null; }
window.addEventListener('message', e => {
  if (!/youtube(-nocookie)?\.com$/.test((e.origin || '').replace(/^https?:\/\/(www\.)?/, ''))) return;
  let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (er) { return; }
  const t = d && d.info && d.info.currentTime;
  if (typeof t === 'number') { ytTime = t; songFollow(t); }
});
function songFollow(t){
  const s = songOpen && songs[songOpen]; if (!s || !s.timed) return;
  let i = -1; for (let k = 0; k < s.lines.length; k++) { if (s.lines[k].t <= t + 0.3) i = k; else break; }
  if (i !== ytCurLine) songHi(i, true);
}
function songHi(i, scroll){
  ytCurLine = i;
  document.querySelectorAll('#songText .sl.on').forEach(x => x.classList.remove('on'));
  const el = i >= 0 && document.querySelector(`#songText .sl[data-li="${i}"]`);
  if (el) { el.classList.add('on'); if (scroll && !songHover) { const r = el.getBoundingClientRect(); if (r.top < 120 || r.bottom > innerHeight - 60) el.scrollIntoView({ block:'center', behavior:'smooth' }); } }
}
let songHover = false;
document.addEventListener('mouseover', e => { songHover = !!e.target.closest('#songText'); });

/* ---------- кліки ---------- */
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-act],[data-song],.sl'); if (!a) return;
  if (a.classList.contains('sl') && !e.target.closest('.w')) {   // клік по рядку — перемотати відео
    const s = songs[songOpen]; if (!s || !s.yt) return;
    const t = +a.dataset.t || 0; ytPost('seekTo', [t, true]); ytPost('playVideo'); songHi(+a.dataset.li); return;
  }
  if (a.dataset.song && a.classList.contains('songcard')) { songOpen = a.dataset.song; render(); window.scrollTo(0, 0); return; }
  const act = a.dataset.act; if (!act || !/^song|^ytlogin$/.test(act)) return;
  e.preventDefault();
  if (act === 'songadd') return addSong($('#songUrl').value, ($('#songLyr').value || '').trim());
  if (act === 'songback') { songOpen = null; ytStop(); render(); return; }
  if (act === 'songtr') { songUi.tr = !songUi.tr; saveSongUi(); $('#songText').classList.toggle('notr', !songUi.tr); a.classList.toggle('on', songUi.tr); return; }
  if (act === 'songnotes') { songUi.notes = !songUi.notes; saveSongUi(); $('#songText').classList.toggle('nonotes', !songUi.notes); a.classList.toggle('on', songUi.notes); return; }
  if (act === 'songdel') { const s = songs[songOpen]; if (!s || !confirm(`Видалити «${s.title}» з колекції?`)) return; songs[s.id] = { id:s.id, del:true, upd:new Date().toISOString() }; saveSongs(); songOpen = null; ytStop(); render(); return; }
  if (act === 'songredo') { const s = songs[songOpen]; if (!s) return; if (!confirm('Попросити Gemini зробити текст і переклад заново? Поточний варіант заміниться.')) return; songOpen = null; const yt = s.yt; const lyr = yt ? '' : s.lines.map(l => l.de).join('\n'); delete songs[s.id].yt; songs[s.id].del = true; saveSongs(); return addSong(yt || '', lyr); }
  if (act === 'ytlogin') { if (api.ytLogin) { await api.ytLogin(); const f = $('#ytFrame'); if (f) f.src = f.src; } return; }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'songUrl') addSong(e.target.value, ($('#songLyr').value || '').trim()); });

/* ---------- злиття для синхронізації: за кожною піснею перемагає новіша (upd) ---------- */
function mergeSongs(a, b){
  const out = { ...a };
  for (const id in b) if (!out[id] || (b[id].upd || '') > (out[id].upd || '')) out[id] = b[id];
  return out;
}
