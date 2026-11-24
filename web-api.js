'use strict';
/* =========================================================
   Веб-версія (телефон, браузер): замінює міст до Electron (window.api).
   У десктопі window.api уже задано в preload.js, і цей файл нічого не робить.
   ========================================================= */
(function(){
  if (window.api) return;
  const WEB_VERSION = '1.3.1';
  const DATA_VER = '1';                       // змінити, якщо оновлено словник

  /* ---------- IndexedDB як сховище ---------- */
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, bad) => {
    const r = indexedDB.open('chytalka', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  }));
  const tx = async (mode, fn) => { const d = await db(); return new Promise((ok, bad) => { const t = d.transaction('kv', mode), s = t.objectStore('kv'); const q = fn(s); t.oncomplete = () => ok(q && q.result); t.onerror = () => bad(t.error); }); };
  const idbGet = k => tx('readonly', s => s.get(k));
  const idbSet = (k, v) => tx('readwrite', s => s.put(v, k));
  const idbDel = k => tx('readwrite', s => s.delete(k));
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  /* ---------- ZIP (EPUB) без бібліотек ---------- */
  async function inflate(bytes){
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function unzip(ab, want){
    const u8 = new Uint8Array(ab), dv = new DataView(ab), out = {};
    let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Пошкоджений EPUB');
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const dec = new TextDecoder();
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (name.endsWith('/') || !want.test(name)) continue;
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const raw = u8.subarray(start, start + csize);
      const data = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
      if (data) out[name] = dec.decode(data);
    }
    return out;
  }
  async function readBook(name, ab){
    const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (ext === '.epub') return { type:'epub', name, files: await unzip(ab, /\.(x?html?|xml|opf|ncx)$/i) };
    const text = new TextDecoder().decode(ab);
    if (ext === '.fb2') return { type:'fb2', name, text };
    if (ext === '.txt') return { type:'txt', name, text };
    throw new Error('Цей формат поки не підтримується: ' + ext);
  }
  function pickFiles(accept, multiple){
    return new Promise(ok => {
      const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = !!multiple;
      i.style.display = 'none'; document.body.appendChild(i);
      i.onchange = () => { ok([...i.files]); i.remove(); };
      i.click();
    });
  }

  /* ---------- словник: завантажується один раз і зберігається на пристрої ---------- */
  async function dict(){
    const have = await idbGet('dict:' + DATA_VER);
    if (have) return have;
    const loading = document.querySelector('.loading');
    if (loading) loading.textContent = 'Перший запуск: завантажую словник (≈4 МБ), це один раз…';
    const [d, f] = await Promise.all([fetch('data/dict_de.json').then(r => r.text()), fetch('data/forms_de.json').then(r => r.text())]);
    const v = { dict:d, forms:f };
    try { await idbSet('dict:' + DATA_VER, v); for (const k of ['dict:0']) await idbDel(k); } catch (e) {}
    return v;
  }

  window.api = {
    read: async n => { try { const v = await idbGet('s:' + n); return v === undefined ? null : v; } catch (e) { return null; } },
    write: (n, o) => idbSet('s:' + n, o).then(() => true),
    remove: n => idbDel('s:' + n).then(() => true),
    dict,
    sample: async () => { try { const r = await fetch('data/sample-die-verwandlung.epub'); return r.ok ? readBook('sample-die-verwandlung.epub', await r.arrayBuffer()) : null; } catch (e) { return null; } },
    pickBooks: async () => {
      const fs = await pickFiles('.epub,.fb2,.txt,application/epub+zip,text/plain', true), out = [];
      for (const f of fs) { try { out.push(await readBook(f.name, await f.arrayBuffer())); } catch (err) { out.push({ error:String(err.message || err), name:f.name }); } }
      return out;
    },
    http: async req => {
      try {
        const r = await fetch(req.url, { method:req.method || 'GET', headers:req.headers || {}, body:req.body });
        const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
        return { ok:r.ok, status:r.status, text:await r.text(), headers };
      } catch (err) { return { ok:false, status:0, text:String(err.message || err), headers:{} }; }
    },
    setSecret: async (n, v) => { try { if (v) localStorage.setItem('chytalka-secret-' + n, v); else localStorage.removeItem('chytalka-secret-' + n); } catch (e) {} return true; },
    getSecret: async n => { try { return localStorage.getItem('chytalka-secret-' + n) || ''; } catch (e) { return ''; } },
    saveFile: async (name, text) => {
      const file = new File([text], name, { type:'text/plain' });
      try { if (navigator.canShare && navigator.canShare({ files:[file] })) { await navigator.share({ files:[file], title:name }); return name; } } catch (e) { if (e.name === 'AbortError') return null; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      return name;
    },
    openJson: async () => { const [f] = await pickFiles('.json,application/json'); return f ? f.text() : null; },
    copy: async t => { try { await navigator.clipboard.writeText(t); } catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (er) {} ta.remove(); } return true; },
    openData: async () => {},
    openUrl: async u => { if (/^https:\/\//.test(u)) window.open(u, '_blank', 'noopener'); },
    checkUpdate: async () => ({ current:WEB_VERSION, available:null }),
    installUpdate: async () => ({ ok:false, canceled:true }),
    info: async () => ({ version:WEB_VERSION, userData:'', web:true })
  };

  // програма з іконки на iPhone може показувати стару версію з кешу: якщо на сайті новіша — чистимо кеш і перезавантажуємо (один раз)
  window.webHardReload = async () => {
    try { const ks = await caches.keys(); await Promise.all(ks.filter(k => k.startsWith('chytalka-')).map(k => caches.delete(k))); } catch (e) {}
    try { const rs = await navigator.serviceWorker.getRegistrations(); for (const r of rs) await r.update().catch(() => {}); } catch (e) {}
    location.reload();
  };
  (async () => {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache:'no-store' }); if (!r.ok) return;
      const v = (await r.json()).v;
      if (v && v !== WEB_VERSION) { const k = 'chytalka-reloaded-' + v; if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, '1'); window.webHardReload(); } }
    } catch (e) {}
  })();
  // без масштабування жестами (iPhone іноді ігнорує user-scalable=no)
  ['gesturestart','gesturechange','gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive:false }));
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive:false });
  // офлайн-робота: service worker кешує сторінку
  if ('serviceWorker' in navigator && location.protocol === 'https:') addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
