'use strict';
/* Offline Feed — everything is stored on the device (IndexedDB) so it works in airplane mode. */
const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('of_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('of_' + k, JSON.stringify(v)); } catch (e) {} }
};
const GB_CAP = 1.4e9;   // never download more than this
const CONC = 5;

/* ---------------- IndexedDB ---------------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('offlinefeed', 1);
    r.onupgradeneeded = () => { const d = r.result; ['media', 'saved', 'kv'].forEach(s => d.objectStoreNames.contains(s) || d.createObjectStore(s)); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store); let out;
    const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error || new Error('storage write failed')); t.onabort = () => rej(t.error || new Error('storage write failed'));
  }));
}
const idb = {
  get: (st, k) => tx(st, 'readonly', s => s.get(k)),
  put: (st, k, v) => tx(st, 'readwrite', s => s.put(v, k)),
  del: (st, k) => tx(st, 'readwrite', s => s.delete(k)),
  keys: st => tx(st, 'readonly', s => s.getAllKeys()),
  all: st => tx(st, 'readonly', s => s.getAll()),
  clear: st => tx(st, 'readwrite', s => s.clear())
};

/* ---------------- state ---------------- */
const S = {
  feed: null, have: new Set(), saved: new Map(), seen: new Set(LS.get('seen', [])),
  tab: 'feed', filter: LS.get('filter', 'all'), shuffle: LS.get('shuffle', false), hideSeen: LS.get('hideSeen', false),
  list: [], rendered: 0, busy: false, soundOn: false
};
const blobCache = new Map();   // id -> Blob for currently rendered posts (needed for synchronous share)
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB';
const standalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function toast(t, ms = 2200) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), ms); }
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- boot ---------------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    S.feed = await idb.get('kv', 'feed');
    S.have = new Set(await idb.keys('media'));
    for (const v of await idb.all('saved')) S.saved.set(v.post.id, v);
  } catch (e) { toast('Storage error: ' + e.message, 5000); }
  bindUI(); buildChips(); rebuild();
  if (!S.feed && navigator.onLine) setTimeout(() => openSheet(), 400);
}

/* ---------------- list building ---------------- */
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function interleave(posts) {
  const by = new Map();
  for (const p of posts) { const k = p.src === '9gag' ? '9gag' : 'reddit'; if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  // 9gag: 1 of every 2 posts; reddit subs mixed round-robin
  const g = by.get('9gag') || [], rAll = by.get('reddit') || [];
  const subs = new Map(); for (const p of rAll) { if (!subs.has(p.src)) subs.set(p.src, []); subs.get(p.src).push(p); }
  const rq = []; let more = true;
  while (more) { more = false; for (const a of subs.values()) if (a.length) { rq.push(a.shift()); more = true; } }
  const out = []; let gi = 0, ri = 0;
  while (gi < g.length || ri < rq.length) { if (gi < g.length) out.push(g[gi++]); if (ri < rq.length) out.push(rq[ri++]); }
  return out;
}
function currentPosts() {
  let ps;
  if (S.tab === 'saved') ps = [...S.saved.values()].sort((a, b) => b.at - a.at).map(v => v.post);
  else ps = (S.feed ? S.feed.posts : []).filter(p => S.have.has(p.id));
  const f = S.filter;
  if (f === '9gag') ps = ps.filter(p => p.src === '9gag');
  else if (f === 'reddit') ps = ps.filter(p => p.src.startsWith('r/'));
  else if (f === 'video') ps = ps.filter(p => p.kind !== 'image');
  else if (f !== 'all') ps = ps.filter(p => p.src === f);
  if (S.tab === 'feed') {
    if (S.hideSeen) ps = ps.filter(p => !S.seen.has(p.id));
    if (S.shuffle) { const r = rng(LS.get('seed', 7)); ps = ps.slice(); for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; } }
    else if (f === 'all' || f === 'video') ps = interleave(ps);
  }
  return ps;
}
function rebuild() {
  for (const el of document.querySelectorAll('.post')) unload(el);
  blobCache.clear();
  $('#list').innerHTML = ''; S.rendered = 0; S.list = currentPosts();
  $('#bShuf').classList.toggle('on', S.shuffle); $('#bSeen').classList.toggle('on', S.hideSeen);
  $('#savedN').textContent = S.saved.size ? '(' + S.saved.size + ')' : '';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === S.tab));
  if (!S.list.length) { $('#list').innerHTML = emptyHTML(); const b = $('#list .btn'); if (b) b.onclick = openSheet; return; }
  renderMore(); window.scrollTo(0, 0);
}
function emptyHTML() {
  if (S.tab === 'saved') return '<div class="empty"><div class="big">♡</div><p>Nothing saved yet.<br>Tap ♡ Save on any post to keep it here — it stays on your phone even after feed updates.</p></div>';
  if (!S.feed || !S.have.size) return `<div class="empty"><div class="big">✈️</div><p><b>No posts on this device yet.</b><br>While you still have Wi-Fi, tap Download. Everything is saved on the phone so it works in airplane mode.</p>${standalone() ? '' : '<p style="color:#ffb86b">Tip: add this page to your Home Screen first (Share → Add to Home Screen), open it from there, then download — Safari and the Home Screen app keep separate storage.</p>'}<button class="btn">⬇️ Download for offline</button></div>`;
  return '<div class="empty"><div class="big">🎉</div><p>You have seen everything in this filter.<br>Turn off 👁 Hide seen or pick another source.</p></div>';
}
function renderMore() {
  const frag = document.createDocumentFragment(), end = Math.min(S.list.length, S.rendered + 12);
  for (; S.rendered < end; S.rendered++) frag.appendChild(card(S.list[S.rendered]));
  $('#list').appendChild(frag);
}
function srcLabel(p) { return p.src === '9gag' ? '9GAG' + (p.sec ? ' · ' + p.sec : '') : p.src; }
function card(p) {
  const el = document.createElement('article'); el.className = 'post'; el.dataset.id = p.id;
  const ar = p.w && p.h ? `aspect-ratio:${p.w}/${p.h};` : '';
  const sv = S.saved.has(p.id);
  el.innerHTML = `<div class="meta"><span class="src ${p.src === '9gag' ? 'g' : 'r'}">${esc(srcLabel(p))}</span>${p.score ? '▲ ' + p.score.toLocaleString() : ''}${p.comments ? ' · 💬 ' + p.comments : ''}<span class="seenb">${S.seen.has(p.id) ? '✓ seen' : ''}</span></div>
  <div class="title">${esc(p.title)}</div>
  <div class="mw" style="${ar}">${p.kind === 'video' ? '<span class="badge">' + (p.audio ? '🔊 sound' : 'GIF') + '</span>' : p.kind === 'gif' ? '<span class="badge">GIF</span>' : ''}</div>
  ${p.top ? `<div class="top"><b>${esc(p.topBy || 'top comment')}:</b> ${esc(p.top)}</div>` : ''}
  <div class="acts"><button class="act sv ${sv ? 'saved' : ''}">${sv ? '♥ Saved' : '♡ Save'}</button><button class="act sh">⤓ Photos</button><button class="act fs">⛶ Full</button></div>`;
  el.querySelector('.sv').onclick = () => toggleSave(p, el);
  el.querySelector('.sh').onclick = () => shareToPhotos(p);
  el.querySelector('.fs').onclick = () => openViewer(p);
  nearIO.observe(el); seenIO.observe(el);
  return el;
}

/* ---------------- lazy media load/unload ---------------- */
async function getBlob(p) {
  if (blobCache.has(p.id)) return blobCache.get(p.id);
  let rec = await idb.get('media', p.id);
  if (!rec && S.saved.has(p.id)) rec = S.saved.get(p.id);
  if (!rec) return null;
  blobCache.set(p.id, rec.blob); if (rec.poster) blobCache.set(p.id + '|p', rec.poster);
  return rec.blob;
}
async function load(el) {
  if (el._loaded) return; el._loaded = true;
  const p = S.list.find(x => x.id === el.dataset.id) || (S.saved.get(el.dataset.id) || {}).post; if (!p) return;
  const blob = await getBlob(p); if (!blob || !el._loaded) return;
  const mw = el.querySelector('.mw'), url = URL.createObjectURL(blob); el._url = url;
  if (p.kind === 'video') {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.preload = 'metadata';
    const pb = blobCache.get(p.id + '|p'); if (pb) { el._purl = URL.createObjectURL(pb); v.poster = el._purl; }
    v.src = url;
    const snd = document.createElement('button'); snd.className = 'snd'; snd.textContent = '🔇'; snd.setAttribute('aria-label', 'Sound');
    const toggle = e => { e.stopPropagation(); v.muted = !v.muted; S.soundOn = !v.muted; snd.textContent = v.muted ? '🔇' : '🔊'; if (v.paused) v.play().catch(() => {}); };
    snd.onclick = toggle; v.onclick = toggle;
    mw.appendChild(v); if (p.audio) mw.appendChild(snd); else v.onclick = () => (v.paused ? v.play() : v.pause());
    playIO.observe(v);
  } else {
    const img = document.createElement('img'); img.alt = p.title || ''; img.decoding = 'async';
    img.onload = () => { if (!p.w) { mw.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight; } mw.style.minHeight = '0'; };
    img.onclick = () => openViewer(p); img.src = url; mw.appendChild(img);
  }
}
function unload(el) {
  if (!el._loaded) return; el._loaded = false;
  const mw = el.querySelector('.mw');
  const img = mw.querySelector('img'), v = mw.querySelector('video');
  if (img && !mw.style.aspectRatio && img.naturalWidth) mw.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight;
  if (v) { playIO.unobserve(v); v.pause(); v.removeAttribute('src'); v.load(); }
  mw.querySelectorAll('img,video,.snd').forEach(n => n.remove());
  if (el._url) URL.revokeObjectURL(el._url); if (el._purl) URL.revokeObjectURL(el._purl);
  el._url = el._purl = null; blobCache.delete(el.dataset.id); blobCache.delete(el.dataset.id + '|p');
}
const nearIO = new IntersectionObserver(es => es.forEach(e => e.isIntersecting ? load(e.target) : unload(e.target)), { rootMargin: '1600px 0px' });
const playIO = new IntersectionObserver(es => es.forEach(e => {
  const v = e.target;
  if (e.intersectionRatio >= 0.6) { if (S.soundOn && v.parentNode.querySelector('.snd')) v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); const s = v.parentNode.querySelector('.snd'); if (s) s.textContent = v.muted ? '🔇' : '🔊'; }
  else v.pause();
}), { threshold: [0, 0.6] });
const seenIO = new IntersectionObserver(es => es.forEach(e => {
  const el = e.target;
  if (e.isIntersecting) el._st = setTimeout(() => markSeen(el), 1200); else clearTimeout(el._st);
}), { threshold: 0.5 });
let seenSaveT;
function markSeen(el) {
  const id = el.dataset.id; if (S.seen.has(id)) return; S.seen.add(id);
  el.querySelector('.seenb').textContent = '✓ seen';
  clearTimeout(seenSaveT); seenSaveT = setTimeout(() => LS.set('seen', [...S.seen].slice(-20000)), 800);
}
new IntersectionObserver(es => { if (es[0].isIntersecting && S.rendered < S.list.length) renderMore(); }, { rootMargin: '2500px 0px' }).observe($('#sent'));

/* ---------------- save / share ---------------- */
async function toggleSave(p, el) {
  const b = el.querySelector('.sv');
  if (S.saved.has(p.id)) {
    if (!confirm('Remove from Saved?')) return;
    await idb.del('saved', p.id); S.saved.delete(p.id); b.classList.remove('saved'); b.textContent = '♡ Save';
    if (!S.have.has(p.id)) blobCache.delete(p.id);
    toast('Removed from Saved'); $('#savedN').textContent = S.saved.size ? '(' + S.saved.size + ')' : '';
    if (S.tab === 'saved') el.remove();
    return;
  }
  const blob = await getBlob(p); if (!blob) return toast('Media not on device');
  const rec = { post: p, blob, poster: blobCache.get(p.id + '|p') || null, at: Date.now() };
  try { await idb.put('saved', p.id, rec); } catch (e) { return toast('Could not save: ' + e.message, 4000); }
  S.saved.set(p.id, rec); b.classList.add('saved'); b.textContent = '♥ Saved';
  $('#savedN').textContent = '(' + S.saved.size + ')'; toast('Saved ♥ (kept offline)');
}
function fileFor(p, blob) {
  const t = blob.type || (p.kind === 'video' ? 'video/mp4' : p.kind === 'gif' ? 'image/webp' : 'image/jpeg');
  const ext = t.includes('mp4') ? 'mp4' : t.includes('webp') ? 'webp' : t.includes('png') ? 'png' : t.includes('gif') ? 'gif' : 'jpg';
  const name = (p.title || p.id).replace(/[^\w\- ]+/g, '').trim().slice(0, 40).replace(/ +/g, '_') || p.id;
  return new File([blob], name + '.' + ext, { type: t });
}
async function shareToPhotos(p) {
  const blob = blobCache.get(p.id);            // must be synchronous to keep the tap "user activation" on iOS
  if (!blob) { getBlob(p).then(() => toast('Ready — tap ⤓ Photos again')); return; }
  const file = fileFor(p, blob);
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  openViewer(p, true);
}

/* ---------------- fullscreen viewer ---------------- */
let vUrl;
async function openViewer(p, fromShare) {
  const blob = await getBlob(p); if (!blob) return;
  const vin = $('#vin'); vin.innerHTML = ''; vUrl = URL.createObjectURL(blob);
  if (p.kind === 'video') {
    const v = document.createElement('video'); v.src = vUrl; v.controls = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.loop = true; v.autoplay = true; vin.appendChild(v);
    $('#vhint').textContent = fromShare ? 'Sharing is not available here. Use ⤓ Photos from the app on iPhone (iOS 15+).' : (p.title || '');
  } else {
    const i = document.createElement('img'); i.src = vUrl; i.alt = p.title || ''; vin.appendChild(i);
    $('#vhint').textContent = (fromShare ? 'Long-press the image → “Save to Photos”. ' : 'Pinch to zoom · long-press to save. ') + (p.title || '');
  }
  $('#viewer').classList.add('show'); document.body.style.overflow = 'hidden';
  document.querySelectorAll('main video').forEach(v => v.pause());
}
function closeViewer() {
  const vin = $('#vin'); const v = vin.querySelector('video'); if (v) v.pause(); vin.innerHTML = '';
  if (vUrl) URL.revokeObjectURL(vUrl); vUrl = null;
  $('#viewer').classList.remove('show'); document.body.style.overflow = '';
}

/* ---------------- download ---------------- */
async function storageInfo() {
  let used = 0, quota = 0, persisted = false;
  try { const e = await navigator.storage.estimate(); used = e.usage || 0; quota = e.quota || 0; } catch (e) {}
  try { persisted = await navigator.storage.persisted(); } catch (e) {}
  const mine = (S.feed ? S.feed.posts.filter(p => S.have.has(p.id)).reduce((a, p) => a + (p.size || 0) + (p.psize || 0), 0) : 0)
    + [...S.saved.values()].reduce((a, v) => a + (v.blob ? v.blob.size : 0), 0);
  if (!used || used < mine) used = mine;
  return { used, quota, persisted };
}
async function openSheet() {
  const si = await storageInfo(), f = S.feed;
  const onDev = f ? f.posts.filter(p => S.have.has(p.id)).length : 0;
  const unseen = f ? f.posts.filter(p => S.have.has(p.id) && !S.seen.has(p.id)).length : 0;
  $('#pan').innerHTML = `<h2>✈️ Offline download</h2>
   <p>${f ? `Feed from <b>${new Date(f.generated * 1000).toLocaleString()}</b> · <b>${onDev}</b> / ${f.posts.length} posts on this phone · ${unseen} unseen (~${Math.round(unseen * 9 / 60 * 10) / 10} h of scrolling)` : 'Nothing downloaded yet.'}</p>
   <p>Storage used by this app: <b>${fmtMB(si.used)}</b>${si.quota ? ' of ' + fmtMB(si.quota) + ' allowed' : ''}${si.persisted ? ' · 🔒 protected' : ''}</p>
   <p>Saved ♥: ${S.saved.size} posts (kept even when the feed is refreshed).</p>
   ${standalone() ? '' : '<p style="color:#ffb86b">You are in Safari. Add to Home Screen first (Share ⬆ → Add to Home Screen) and download inside that app — Safari and the Home Screen app keep separate storage.</p>'}
   <div class="row"><button class="btn" id="goDl">${navigator.onLine ? (f ? '⬇️ Update / download new posts' : '⬇️ Download for offline') : 'Offline — connect to Wi-Fi to update'}</button></div>
   <div class="row" style="margin-top:6px"><button class="btn sec" id="rsSeen">Reset seen (${S.seen.size})</button><button class="btn red" id="clr">Delete downloads</button><button class="btn sec" id="cls">Close</button></div>
   <p style="margin-top:14px;font-size:12px">Download is about ${f && f.bytes ? fmtMB(f.bytes) : '0.5–1 GB'} — use Wi-Fi. Keep the app open until it finishes; if it stops, tap Download again and it continues where it left off. Sources: 9GAG and Reddit (${f && f.counts ? Object.keys(f.counts).length : 10} feeds). Shortcuts: j / k or ↑ ↓ to move between posts.</p>`;
  $('#sheet').classList.add('show');
  $('#goDl').onclick = () => { if (navigator.onLine) { closeSheet(); download(); } };
  $('#cls').onclick = closeSheet;
  $('#rsSeen').onclick = () => { if (confirm('Mark everything as unseen?')) { S.seen.clear(); LS.set('seen', []); closeSheet(); rebuild(); } };
  $('#clr').onclick = async () => { if (!confirm('Delete all downloaded posts from this phone? (Saved ♥ posts are kept)')) return; await idb.clear('media'); S.have.clear(); closeSheet(); rebuild(); toast('Downloads deleted'); };
}
function closeSheet() { $('#sheet').classList.remove('show'); }
function status(txt, frac) { $('#status').classList.add('show'); $('#stTxt').textContent = txt; $('#stBar').style.width = Math.round((frac || 0) * 100) + '%'; }

async function fetchBlob(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(url, { mode: 'cors', cache: 'no-store', signal: ctl.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.blob(); if (b.size < 200) throw new Error('empty');
      return b;
    } catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 1200 * (i + 1))); }
  }
}
async function download() {
  if (S.busy) return; S.busy = true; $('#bDl').classList.add('on');
  try {
    try { await navigator.storage.persist(); } catch (e) {}
    status('Getting the latest post list…', 0);
    const r = await fetch('feed.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('feed.json HTTP ' + r.status);
    const feed = await r.json();
    const ids = new Set(feed.posts.map(p => p.id));
    // drop media that is no longer in the feed (Saved posts keep their own copy)
    for (const k of await idb.keys('media')) if (!ids.has(k)) { await idb.del('media', k); S.have.delete(k); }
    S.feed = feed; await idb.put('kv', 'feed', feed);
    const todo = feed.posts.filter(p => !S.have.has(p.id));
    const totalB = todo.reduce((a, p) => a + (p.size || 0) + (p.psize || 0), 0);
    let done = 0, doneB = 0, fail = 0, idx = 0, firstErr = '', stored = feed.posts.filter(p => S.have.has(p.id)).reduce((a, p) => a + (p.size || 0), 0);
    let wakeLock = null; try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    const worker = async () => {
      while (idx < todo.length) {
        const p = todo[idx++];
        if (stored > GB_CAP) { fail++; continue; }
        try {
          const blob = await fetchBlob(p.url);
          let poster = null; if (p.poster) { try { poster = await fetchBlob(p.poster, 2); } catch (e) {} }
          await idb.put('media', p.id, { blob, poster }); S.have.add(p.id); stored += blob.size; doneB += blob.size + (poster ? poster.size : 0);
        } catch (e) { fail++; if (!firstErr) firstErr = (e && (e.message || e.name)) || 'storage error'; if (e && e.name === 'QuotaExceededError') { idx = todo.length; toast('Phone storage limit reached — stopping', 5000); } }
        done++;
        status(`Downloading ${done} / ${todo.length} · ${fmtMB(doneB)} of ~${fmtMB(totalB)}${fail ? ' · ' + fail + ' skipped' : ''}`, totalB ? doneB / totalB : done / todo.length);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    if (wakeLock) try { wakeLock.release(); } catch (e) {}
    buildChips();
    const si = await storageInfo();
    if (todo.length && fail === todo.length) throw new Error((firstErr === 'null' || !firstErr ? 'could not store files (Private Browsing is not supported)' : firstErr));
    status(`✅ Ready offline: ${S.have.size} posts on this phone · ${fmtMB(si.used)} used${fail ? ' · ' + fail + ' skipped' : ''}`, 1);
    setTimeout(() => $('#status').classList.remove('show'), 8000);
    if (S.tab === 'feed') rebuild();
  } catch (e) {
    status('Download stopped: ' + e.message + ' — tap ⬇️ to retry', 0);
  } finally { S.busy = false; $('#bDl').classList.remove('on'); }
}

/* ---------------- UI wiring ---------------- */
function buildChips() {
  const posts = S.feed ? S.feed.posts.filter(p => S.have.has(p.id)) : [];
  const subs = [...new Set(posts.filter(p => p.src.startsWith('r/')).map(p => p.src))].sort((a, b) => a.localeCompare(b));
  const cnt = f => f === 'all' ? posts.length : f === '9gag' ? posts.filter(p => p.src === '9gag').length : f === 'reddit' ? posts.filter(p => p.src.startsWith('r/')).length : f === 'video' ? posts.filter(p => p.kind !== 'image').length : posts.filter(p => p.src === f).length;
  const items = [['all', 'All'], ['9gag', '9GAG'], ['reddit', 'Reddit'], ['video', '🎬 Videos & GIFs'], ...subs.map(s => [s, s])];
  $('#chips').innerHTML = items.map(([k, l]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-f="${esc(k)}">${esc(l)}${posts.length ? ' ' + cnt(k) : ''}</button>`).join('');
  $('#chips').querySelectorAll('.chip').forEach(c => c.onclick = () => { S.filter = c.dataset.f; LS.set('filter', S.filter); $('#chips').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c)); rebuild(); });
}
function bindUI() {
  $('#bDl').onclick = openSheet;
  $('#sheet .bg').onclick = closeSheet;
  $('#bShuf').onclick = () => { S.shuffle = !S.shuffle; LS.set('shuffle', S.shuffle); if (S.shuffle) LS.set('seed', (Math.random() * 1e9) >>> 0); toast(S.shuffle ? 'Shuffle on' : 'Shuffle off'); rebuild(); };
  $('#bSeen').onclick = () => { S.hideSeen = !S.hideSeen; LS.set('hideSeen', S.hideSeen); toast(S.hideSeen ? 'Hiding posts you already saw' : 'Showing all posts'); rebuild(); };
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { S.tab = t.dataset.tab; rebuild(); });
  $('#viewer .x').onclick = closeViewer;
  $('#viewer').addEventListener('click', e => { if (e.target.id === 'viewer' || e.target.id === 'vin') closeViewer(); });
  document.addEventListener('keydown', e => {
    if ($('#viewer').classList.contains('show')) { if (e.key === 'Escape') closeViewer(); return; }
    const k = e.key; const dir = (k === 'j' || k === 'ArrowDown') ? 1 : (k === 'k' || k === 'ArrowUp') ? -1 : 0;
    if (!dir) { if (k === 's') $('#bShuf').click(); return; }
    e.preventDefault();
    const posts = [...document.querySelectorAll('.post')], hy = $('header').offsetHeight + 4;
    let i = posts.findIndex(p => p.getBoundingClientRect().top > hy + 2); if (i < 0) i = posts.length;
    const target = dir > 0 ? posts[i] : posts[Math.max(0, i - 2)];
    if (target) window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - hy, behavior: 'smooth' });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) document.querySelectorAll('video').forEach(v => v.pause()); });
}
boot();
