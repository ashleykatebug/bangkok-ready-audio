/* Bangkok Ready Audio — hardened single-player app (v2)
   One <audio>, one state, one manifest. Lesson audio arrives as byte-segments that are
   re-joined into the original MP3 (Blob) so playback/seeking never depends on the network. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const VERSION = 'v2.0';
  const KEY = 'bkk_audio_v1';                 // same key as the previous player → progress carries over
  const AUDIO_CACHE = 'bkk-audio-v1';
  const S = { IDLE: 'IDLE', LOADING: 'LOADING', READY: 'READY', PLAYING: 'PLAYING', PAUSED: 'PAUSED', SEEKING: 'SEEKING', SWITCHING: 'SWITCHING', ENDED: 'ENDED', ERROR: 'ERROR' };

  // ---------- diagnostics (ring buffer; window.__bkk.log() to read, ?debug=1 shows a panel)
  const LOG = []; const DEBUG = /[?&]debug=1/.test(location.search);
  function log(ev, data) { const e = { t: Date.now(), ev, ...(data || {}) }; LOG.push(e); if (LOG.length > 400) LOG.shift(); if (DEBUG) { const p = $('debug'); if (p) { p.hidden = false; p.textContent = LOG.slice(-14).map(x => new Date(x.t).toLocaleTimeString() + ' ' + x.ev + ' ' + JSON.stringify(Object.assign({}, x, { t: undefined, ev: undefined })).replace(/"|\{|\}|,"t":undefined|"ev":undefined,?/g, '')).join('\n'); } } }

  // ---------- persistence
  let store = {}; try { store = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { store = {}; }
  store.pos = store.pos || {}; store.done = store.done || {}; store.last = store.last || {}; store.dur = store.dur || {};
  let saveTimer = 0, lastSaveAt = 0;
  function save(force) {
    const now = Date.now();
    if (!force && now - lastSaveAt < 4000) { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; save(true); }, 4000 - (now - lastSaveAt)); return; }
    lastSaveAt = now; try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { log('SAVE_FAIL', { msg: String(e) }); }
  }
  function validPos(p, d) { return typeof p === 'number' && isFinite(p) && p >= 0 && (!d || p < d); }
  function savePosition(reason) {
    if (!cur || attachedGen !== gen) return;
    const t = audio.currentTime, d = audio.duration;
    if (!validPos(t, isFinite(d) ? d : 0)) return;
    if (state === S.ENDED) { store.pos[cur.id] = 0; }
    else if (t > 2) store.pos[cur.id] = Math.floor(t * 10) / 10;
    if (isFinite(d) && d > 0) store.dur[cur.id] = Math.round(d);
    store.last[cur.id] = Date.now(); store.current = cur.id; save(reason === 'force');
  }

  // ---------- state
  let LESSONS = [], cur = null, state = S.IDLE, gen = 0, objectUrl = null, seekLock = 0, loadPromise = null, lastError = null;
  const audio = $('audio');
  function setState(s, extra) { if (s === state) return; log('STATE', { from: state, to: s, ...(extra || {}) }); state = s; paint(); paintMS(); }
  function fmt(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function idx(l) { return LESSONS.indexOf(l); }
  function thaiNum(n) { return String(n).replace(/\d/g, d => '๐๑๒๓๔๕๖๗๘๙'[d]); }

  // ---------- audio fetching (segments → one Blob). Cache API when available.
  async function openCache() { try { return 'caches' in window ? await caches.open(AUDIO_CACHE) : null; } catch (e) { return null; } }
  async function fetchSegment(path, cache, signal) {
    if (cache) { const hit = await cache.match(path); if (hit) return hit.arrayBuffer(); }
    const r = await fetch(path, { signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
    const buf = await r.arrayBuffer();
    if (cache) { try { await cache.put(path, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) } })); } catch (e) { log('CACHE_PUT_FAIL', { path, msg: String(e).slice(0, 80) }); } }
    return buf;
  }
  async function lessonBlob(lesson, signal, onProgress) {
    const cache = await openCache(); const parts = []; let got = 0;
    for (const p of lesson.segments) { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); const b = await fetchSegment(p, cache, signal); parts.push(b); got += b.byteLength; if (onProgress) onProgress(got / lesson.bytes); }
    if (got !== lesson.bytes) throw new Error('size mismatch ' + got + '≠' + lesson.bytes);
    return new Blob(parts, { type: 'audio/mpeg' });
  }
  async function isCached(lesson) { const c = await openCache(); if (!c) return false; for (const p of lesson.segments) { if (!(await c.match(p))) return false; } return true; }

  // ---------- loading with generation tokens (stale loads are ignored)
  let abortCtl = null, attachedGen = 0;
  async function loadLesson(lesson, opts) {
    opts = opts || {};
    const myGen = ++gen;
    log('LESSON_SWITCH', { to: lesson.id, from: cur && cur.id, gen: myGen, autoplay: !!opts.autoplay });
    if (cur && cur !== lesson) savePosition('force');
    if (abortCtl) abortCtl.abort(); abortCtl = new AbortController();
    pendingAutoplay = false; lastError = null;
    setState(S.SWITCHING);
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) { }
    attachedGen = 0;
    cur = lesson; store.current = lesson.id; save(true);
    paintLesson(); renderLessons();
    setState(S.LOADING);
    const p = (async () => {
      let blob;
      try { blob = await lessonBlob(lesson, abortCtl.signal, f => { if (myGen === gen) $('sub').textContent = 'Loading ' + Math.round(f * 100) + '%'; }); }
      catch (e) { if (myGen !== gen) { log('STALE_LOAD_IGNORED', { id: lesson.id, gen: myGen }); return; } log('SOURCE_ERROR', { id: lesson.id, msg: String(e).slice(0, 120) }); lastError = navigator.onLine === false ? 'You are offline and this lesson is not downloaded yet.' : 'Could not load the audio.'; setState(S.ERROR); paint(); return; }
      if (myGen !== gen) { log('STALE_LOAD_IGNORED', { id: lesson.id, gen: myGen }); return; }
      attachBlob(blob, lesson, myGen, opts.autoplay);
    })();
    loadPromise = p; return p;
  }
  function attachBlob(blob, lesson, myGen, autoplay) {
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) { } }
    objectUrl = URL.createObjectURL(blob);
    log('SOURCE_LOAD', { id: lesson.id, bytes: blob.size });
    const restore = store.pos[lesson.id] || 0;
    const onMeta = () => {
      if (myGen !== gen) return;
      audio.removeEventListener('loadedmetadata', onMeta);
      const d = audio.duration;
      if (validPos(restore, d) && restore > 3 && restore < d - 5) { try { audio.currentTime = restore; log('POSITION_RESTORE', { id: lesson.id, pos: restore }); } catch (e) { } }
      store.dur[lesson.id] = Math.round(d);
      audio.playbackRate = store.rate || 1;
      log('SOURCE_READY', { id: lesson.id, duration: Math.round(d) });
      setState(S.READY); $('sub').textContent = SUB_DEFAULT; paint(); mediaMeta();
      if (autoplay || pendingAutoplay) { pendingAutoplay = false; play('after-switch'); }
    };
    audio.addEventListener('loadedmetadata', onMeta);
    attachedGen = myGen; audio.src = objectUrl; audio.load();
  }

  // ---------- transport
  function play(src) {
    if (!cur) return;
    if (state === S.ERROR) { retry(); return; }
    if (state === S.LOADING || state === S.SWITCHING) { pendingAutoplay = true; log('PLAY_DEFERRED', { state }); return; }
    if (state === S.ENDED) { try { audio.currentTime = 0; } catch (e) { } }
    log('PLAY_REQUEST', { src: src || 'ui', id: cur.id, t: Math.round(audio.currentTime) });
    const myGen = gen;
    const p = audio.play();
    if (p && p.then) p.then(() => { if (myGen === gen) log('PLAY_SUCCESS', { id: cur.id }); })
      .catch(err => { if (myGen !== gen) return; log('PLAY_REJECTED', { name: err && err.name, msg: String(err).slice(0, 100) }); if (err && err.name === 'NotAllowedError') { setState(audio.readyState >= 1 ? S.PAUSED : state); toast('Tap play once — the phone needs a tap to start audio.'); } else { lastError = 'Playback failed. Tap Retry.'; setState(S.ERROR); } });
  }
  let pendingAutoplay = false;
  function pause(src) { if (!cur) return; log('PAUSE', { src: src || 'ui', t: Math.round(audio.currentTime) }); pendingAutoplay = false; audio.pause(); savePosition('force'); }
  function toggle() { (state === S.PLAYING) ? pause() : play(); }
  function clampTime(t) { const d = audio.duration; if (!isFinite(d) || d <= 0) return Math.max(0, t || 0); return Math.max(0, Math.min(d - 0.25, t)); }
  function seekBy(delta) {
    if (!cur || audio.readyState < 1) { log('SEEK_IGNORED', { reason: 'not ready' }); return; }
    seekTo(audio.currentTime + delta, 'skip' + (delta > 0 ? '+' : '') + delta);
  }
  function seekTo(t, src) {
    if (!cur || audio.readyState < 1 || !isFinite(t)) { log('SEEK_IGNORED', { reason: 'not ready', t }); return; }
    const target = clampTime(t); const my = ++seekLock;
    log('SEEK', { src, from: Math.round(audio.currentTime * 10) / 10, to: Math.round(target * 10) / 10 });
    const wasPlaying = state === S.PLAYING;
    try { audio.currentTime = target; } catch (e) { log('SEEK_FAIL', { msg: String(e) }); return; }
    if (state === S.ENDED) setState(wasPlaying ? S.PLAYING : S.PAUSED);
    paint(); savePosition();
    // seeked event resolves SEEKING; keep a watchdog so UI can't get stuck
    setTimeout(() => { if (my === seekLock && state === S.SEEKING) setState(audio.paused ? S.PAUSED : S.PLAYING); }, 1500);
  }
  function retry() {
    if (!cur) return; log('RETRY', { id: cur.id, err: lastError });
    if (attachedGen === gen) { const t = audio.currentTime; if (validPos(t, 0) && t > 2) store.pos[cur.id] = t; }
    loadLesson(cur, { autoplay: false });
  }
  function go(delta) { if (!cur) return; const i = idx(cur) + delta; if (i < 0 || i >= LESSONS.length) { toast(delta < 0 ? 'This is the first lesson.' : 'This is the last lesson.'); return; } select(LESSONS[i], state === S.PLAYING); }
  function select(lesson, autoplay) {
    if (lesson === cur) { if (state === S.PLAYING) return; play(); return; }
    return loadLesson(lesson, { autoplay: !!autoplay });
  }

  // ---------- media element events → state
  audio.addEventListener('play', () => { setState(S.PLAYING); });
  audio.addEventListener('playing', () => { setState(S.PLAYING); });
  audio.addEventListener('pause', () => { if (state === S.ENDED || state === S.ERROR || state === S.LOADING || state === S.SWITCHING || state === S.READY) return; if (audio.ended || attachedGen !== gen) return; setState(S.PAUSED); savePosition(); });
  audio.addEventListener('seeking', () => { if (state === S.PLAYING || state === S.PAUSED) setState(S.SEEKING); });
  audio.addEventListener('seeked', () => { if (state === S.SEEKING) setState(audio.paused ? S.PAUSED : S.PLAYING); paint(); });
  audio.addEventListener('waiting', () => { log('WAITING', { t: Math.round(audio.currentTime) }); });
  audio.addEventListener('stalled', () => { log('STALLED', {}); });
  audio.addEventListener('ended', () => { log('ENDED', { id: cur && cur.id }); store.done[cur.id] = Date.now(); setState(S.ENDED); store.pos[cur.id] = 0; save(true); renderLessons(); toast('Lesson complete.'); });
  audio.addEventListener('error', () => { const e = audio.error; log('MEDIA_ERROR', { code: e && e.code, msg: e && e.message }); if (state === S.SWITCHING || state === S.LOADING) return; lastError = 'The audio stopped unexpectedly (code ' + (e && e.code) + ').'; setState(S.ERROR); });
  audio.addEventListener('timeupdate', () => { paint(); if (state === S.PLAYING) savePosition(); });
  audio.addEventListener('ratechange', () => { paintSpeed(); });

  // ---------- lifecycle reconciliation
  function reconcile(why) {
    if (!cur) return;
    const realPlaying = !audio.paused && !audio.ended && audio.readyState > 2;
    log(why === 'hidden' ? 'BACKGROUND' : 'FOREGROUND', { why, state, paused: audio.paused, rs: audio.readyState, ns: audio.networkState, t: Math.round(audio.currentTime) });
    if (why === 'hidden') { savePosition('force'); return; }
    if (state === S.LOADING || state === S.SWITCHING || state === S.ERROR) return;
    if (audio.error || (audio.networkState === 3 /* NO_SOURCE */ && objectUrl)) { // iOS dropped the media element
      log('REINIT_MEDIA', { reason: 'no source after resume' }); retry(); return;
    }
    if (realPlaying && state !== S.PLAYING) setState(S.PLAYING);
    else if (!realPlaying && state === S.PLAYING) setState(S.PAUSED);
    paint();
  }
  document.addEventListener('visibilitychange', () => reconcile(document.visibilityState));
  window.addEventListener('pageshow', e => reconcile('pageshow' + (e.persisted ? '-bfcache' : '')));
  window.addEventListener('focus', () => reconcile('focus'));
  window.addEventListener('pagehide', () => savePosition('force'));
  window.addEventListener('beforeunload', () => savePosition('force'));
  window.addEventListener('online', () => { log('ONLINE', {}); paintNet(); });
  window.addEventListener('offline', () => { log('OFFLINE', {}); paintNet(); });

  // ---------- Media Session
  function mediaMeta() {
    if (!('mediaSession' in navigator) || !cur) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: 'Bangkok Ready Audio', album: 'Thai — Level 1', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] });
      const H = (n, f) => { try { navigator.mediaSession.setActionHandler(n, d => { log('MEDIA_SESSION_ACTION', { action: n }); f(d); }); } catch (e) { } };
      H('play', () => play('mediasession')); H('pause', () => pause('mediasession'));
      H('seekbackward', d => seekBy(-(d && d.seekOffset || 15))); H('seekforward', d => seekBy(d && d.seekOffset || 15));
      H('seekto', d => { if (d && d.seekTime != null) seekTo(d.seekTime, 'mediasession'); });
      H('previoustrack', () => go(-1)); H('nexttrack', () => go(1));
    } catch (e) { log('MS_FAIL', { msg: String(e) }); }
  }
  function paintMS() { try { if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = state === S.PLAYING ? 'playing' : (state === S.PAUSED || state === S.READY || state === S.ENDED ? 'paused' : 'none'); } } catch (e) { } }

  // ---------- UI
  const SUB_DEFAULT = 'Press play, put the phone down, and speak when she pauses.';
  function paintLesson() { if (!cur) return; $('title').textContent = cur.title; $('artTh').textContent = thaiNum(cur.n); }
  function paint() {
    if (!cur) return;
    const d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (store.dur[cur.id] || cur.duration || 0);
    const t = audio.currentTime || 0; const pct = d ? Math.min(100, 100 * t / d) : 0;
    $('fill').style.width = pct + '%'; $('knob').style.left = pct + '%';
    $('tcur').textContent = fmt(t); $('trem').textContent = '-' + fmt(Math.max(0, d - t));
    const playing = state === S.PLAYING;
    $('playIcon').innerHTML = playing ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('eq').classList.toggle('off', !playing);
    let sec = ''; (cur.sections || []).forEach(s => { if (t >= s.at - 0.2) sec = s.name; }); $('section').textContent = sec;
    const st = $('status'); const busy = state === S.LOADING || state === S.SWITCHING;
    st.textContent = state === S.ERROR ? (lastError || 'Playback error.') : '';
    $('retry').hidden = state !== S.ERROR; $('status').hidden = state !== S.ERROR;
    ['play', 'back', 'fwd', 'prev', 'next'].forEach(id => { $(id).disabled = busy; $(id).style.opacity = busy ? .5 : 1; });
    try { if ('mediaSession' in navigator && d && audio.readyState >= 1) navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.max(0, Math.min(t, d)) }); } catch (e) { }
  }
  function paintSpeed() { document.querySelectorAll('#speed button').forEach(b => b.classList.toggle('on', +b.dataset.r === (store.rate || 1))); }
  function paintNet() { const o = navigator.onLine === false; $('net').hidden = !o; }
  let cachedSet = {};
  async function refreshCached() { for (const l of LESSONS) cachedSet[l.id] = await isCached(l); renderLessons(); paintStorage(); }
  async function paintStorage() { try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); const n = Object.values(cachedSet).filter(Boolean).length; $('storage').textContent = n + ' of ' + LESSONS.length + ' lessons saved offline · ' + (e.usage / 1048576).toFixed(0) + ' MB used'; } } catch (e) { } }
  function renderLessons() {
    $('lessons').innerHTML = LESSONS.map((l) => {
      const done = store.done[l.id]; const pos = store.pos[l.id] || 0; const isCur = cur && l.id === cur.id;
      const meta = fmt(l.duration) + (isCur ? (state === S.PLAYING ? ' · now playing' : ' · selected') : (pos > 2 ? ' · resume at ' + fmt(pos) : ''));
      return '<div class="lesson" data-id="' + l.id + '" style="' + (isCur ? '' : 'opacity:.85') + '"><div class="num">' + l.n + '</div><div class="t"><b>' + l.short + '</b><span>' + meta + '</span></div>' + (done ? '<div class="done">Done ✓</div>' : '') + '<button class="dl' + (cachedSet[l.id] ? ' on' : '') + '" data-dl="' + l.id + '" aria-label="' + (cachedSet[l.id] ? 'Saved offline' : 'Download for offline') + '">' + (cachedSet[l.id] ? '✓' : '↓') + '</button></div>';
    }).join('');
    document.querySelectorAll('.lesson .t, .lesson .num').forEach(el => el.addEventListener('click', () => { const l = LESSONS.find(x => x.id === el.parentElement.dataset.id); select(l, true); }));
    document.querySelectorAll('.lesson .dl').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); download(LESSONS.find(x => x.id === b.dataset.dl)); }));
  }
  let dlBusy = false;
  async function download(lesson, quiet) {
    if (cachedSet[lesson.id]) { if (!quiet) toast('Already saved offline.'); return true; }
    try { const c = await openCache(); if (!c) { toast('Offline saving is not available in this browser.'); return false; } const ctl = new AbortController(); for (const p of lesson.segments) await fetchSegment(p, c, ctl.signal); cachedSet[lesson.id] = true; renderLessons(); paintStorage(); if (!quiet) toast('Saved: ' + lesson.short); return true; }
    catch (e) { log('DOWNLOAD_FAIL', { id: lesson.id, msg: String(e).slice(0, 100) }); if (!quiet) toast('Could not download ' + lesson.short + (navigator.onLine === false ? ' — you are offline.' : '.')); return false; }
  }
  async function downloadAll() {
    if (dlBusy) return; dlBusy = true; const btn = $('dlall'); let ok = 0;
    try { for (let i = 0; i < LESSONS.length; i++) { btn.textContent = 'Saving ' + (i + 1) + ' / ' + LESSONS.length + '…'; if (await download(LESSONS[i], true)) ok++; } }
    finally { dlBusy = false; btn.textContent = ok === LESSONS.length ? 'All of Level 1 is saved offline ✓' : 'Download all of Level 1 (' + Math.round(LESSONS.reduce((a, l) => a + l.bytes, 0) / 1048576) + ' MB)'; toast(ok === LESSONS.length ? 'Level 1 saved for offline use.' : ok + ' of ' + LESSONS.length + ' lessons saved.'); paintStorage(); }
  }
  let toastT; function toast(m) { const el = $('toast'); el.textContent = m; el.classList.add('in'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('in'), 2600); }

  // ---------- controls (touch-safe: pointer events, no double-fire)
  function tap(id, fn) { $(id).addEventListener('click', e => { e.preventDefault(); fn(e); }); }
  tap('play', toggle); tap('back', () => seekBy(-15)); tap('fwd', () => seekBy(15)); tap('prev', () => go(-1)); tap('next', () => go(1)); tap('retry', retry); tap('dlall', downloadAll);
  document.querySelectorAll('#speed button').forEach(b => b.addEventListener('click', () => { store.rate = +b.dataset.r; audio.playbackRate = store.rate; save(true); paintSpeed(); log('RATE', { rate: store.rate }); }));
  // scrubbing: pointer down/move/up on the bar; commits once on release; ignores stale moves
  (function () {
    const bar = $('bar'); let dragging = false, frac = 0;
    const fracOf = e => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    const preview = () => { const d = isFinite(audio.duration) ? audio.duration : (cur && cur.duration) || 0; $('fill').style.width = frac * 100 + '%'; $('knob').style.left = frac * 100 + '%'; $('tcur').textContent = fmt(frac * d); };
    bar.addEventListener('pointerdown', e => { if (!cur || audio.readyState < 1) return; dragging = true; bar.setPointerCapture(e.pointerId); frac = fracOf(e); preview(); });
    bar.addEventListener('pointermove', e => { if (!dragging) return; frac = fracOf(e); preview(); });
    const end = e => { if (!dragging) return; dragging = false; try { bar.releasePointerCapture(e.pointerId); } catch (x) { } const d = audio.duration; if (isFinite(d)) seekTo(frac * d, 'scrub'); };
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
  })();
  window.addEventListener('keydown', e => { if (e.target && /input|textarea/i.test(e.target.tagName)) return; if (e.code === 'Space') { e.preventDefault(); toggle(); } else if (e.code === 'ArrowLeft') seekBy(-15); else if (e.code === 'ArrowRight') seekBy(15); });

  // ---------- boot
  async function boot() {
    paintNet();
    if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch (e) { log('SW_FAIL', { msg: String(e) }); } }
    let manifest;
    try { const r = await fetch('lessons.json', { cache: 'no-cache' }); manifest = await r.json(); }
    catch (e) { try { const c = await caches.open('bkk-shell'); const hit = await c.match('lessons.json'); if (hit) manifest = await hit.json(); } catch (x) { } }
    if (!manifest) { $('sub').textContent = 'Could not load the lesson list. Check your connection and reopen.'; return; }
    LESSONS = manifest.lessons;
    $('dlall').textContent = 'Download all of Level 1 (' + Math.round(LESSONS.reduce((a, l) => a + l.bytes, 0) / 1048576) + ' MB)';
    paintSpeed();
    const startId = store.current && LESSONS.some(l => l.id === store.current) ? store.current : LESSONS[0].id;
    await refreshCached();
    await loadLesson(LESSONS.find(l => l.id === startId), { autoplay: false });   // never autoplay on open
    log('BOOT', { version: VERSION, lesson: startId });
  }
  window.__bkk = { get state() { return state; }, get lesson() { return cur && cur.id; }, log: () => LOG.slice(), audio, select: (n, ap) => select(LESSONS[n - 1], ap), seekBy, seekTo, play, pause, go, retry, store: () => store, loadDone: () => loadPromise, LESSONS: () => LESSONS, download, isCached, reconcile };
  boot();
})();
