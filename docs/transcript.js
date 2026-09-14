/* Bangkok Ready Audio — synchronized transcript layer (subordinate to the player; audio.currentTime is the only clock).
   Modes: off | rom | thai. Data: transcripts/lessonN.json (phrase + word timing keyed to canonical tokens; romanization is a
   presentation field). Loaded per lesson with the same generation-token protection as the audio. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'bkk_transcript_v1';
  const MODES = ['off', 'rom', 'thai'];
  const audio = $('audio');
  const panel = $('transcript'), scroller = $('tscroll'), body = $('tbody'), follow = $('tfollow'), modeBar = $('tmode');
  const app = document.querySelector('.app');
  const log = (ev, data) => { if (window.__bkk && window.__bkk.logEvent) window.__bkk.logEvent(ev, data); };

  let mode = 'off'; try { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); if (MODES.includes(s.mode)) mode = s.mode; } catch (e) { }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify({ mode })); } catch (e) { } }

  // ---------- data
  let gen = 0;                 // transcript generation (bumped on every lesson switch)
  let lessonId = null;         // lesson the player currently has attached
  let data = null;             // transcript for lessonId (null while loading / unavailable)
  let unavailable = false;
  let els = [];                // phrase elements
  let wordEls = [];            // per phrase: word elements
  let active = -1, activeWord = -1;
  let following = true, programmaticScroll = 0, raf = 0;
  const cache = new Map();

  async function loadTranscript(id, myGen) {
    if (cache.has(id)) return cache.get(id);
    const r = await fetch('transcripts/' + id + '.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.events)) throw new Error('malformed');
    // validate: monotonic phrases, words inside phrases (cheap; full validation is in the compiler)
    let last = -1;
    for (const e of j.events) { if (!(e.s >= last - 0.01) || !(e.e >= e.s)) throw new Error('bad timing at ' + e.i); last = e.s; }
    cache.set(id, j); return j;
  }

  function onLesson(id) {
    const myGen = ++gen; lessonId = id; data = null; unavailable = false; active = -1; activeWord = -1; following = true;
    render(); // clears
    if (mode === 'off') { /* load lazily when the user turns it on */ return; }
    fetchFor(id, myGen);
  }
  function fetchFor(id, myGen) {
    loadTranscript(id, myGen).then(j => {
      if (myGen !== gen) { log('TRANSCRIPT_STALE_IGNORED', { id }); return; }
      data = j; log('TRANSCRIPT_LOADED', { id, phrases: j.events.length }); render(); sync(true);
    }).catch(err => {
      if (myGen !== gen) return;
      unavailable = true; log('TRANSCRIPT_ERROR', { id, msg: String(err).slice(0, 100) }); render();
    });
  }

  // ---------- rendering (built once per lesson/mode; sync() only toggles classes)
  function render() {
    body.innerHTML = ''; els = []; wordEls = []; active = -1; activeWord = -1;
    app.classList.toggle('reading', mode !== 'off');
    panel.hidden = mode === 'off';
    follow.hidden = true;
    for (const b of modeBar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
    if (mode === 'off') return;
    if (unavailable) { body.innerHTML = '<div class="tmsg">Transcript isn’t available for this lesson.</div>'; return; }
    if (!data) { body.innerHTML = '<div class="tmsg">Loading transcript…</div>'; return; }
    const frag = document.createDocumentFragment();
    let sectionIdx = 0; const sections = data.sections || [];
    data.events.forEach((e, i) => {
      while (sectionIdx < sections.length && sections[sectionIdx].at <= e.s + 0.01) {
        const h = document.createElement('div'); h.className = 'tsec'; h.textContent = sections[sectionIdx].name; frag.appendChild(h); sectionIdx++;
      }
      const p = document.createElement('div'); p.className = 'tp ' + e.v; p.dataset.i = i; p.dataset.s = e.s;
      const line = document.createElement('div'); line.className = 'tl';
      const ws = [];
      e.w.forEach((w, k) => {
        const span = document.createElement('span'); span.className = 'tw' + (w.s === undefined ? ' tpunct' : '');
        if (e.v === 'narrator') span.textContent = w.t;
        else if (mode === 'thai') { const th = document.createElement('b'); th.textContent = w.t; const r = document.createElement('i'); r.textContent = w.r || ''; span.appendChild(th); span.appendChild(r); span.classList.add('pair'); }
        else span.textContent = w.r || w.t;
        line.appendChild(span); if (k < e.w.length - 1) line.appendChild(document.createTextNode(' '));
        ws.push(span);
      });
      p.appendChild(line); frag.appendChild(p); els.push(p); wordEls.push(ws);
    });
    body.appendChild(frag);
  }

  // ---------- synchronization: everything derives from audio.currentTime
  function findPhrase(t) {
    const ev = data.events; let lo = 0, hi = ev.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ev[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  function findWord(e, t) {
    const w = e.w; let lo = 0, hi = w.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (w[m].s === undefined) { /* punctuation: step */ if (m > 0 && w[m - 1].s !== undefined && w[m - 1].s <= t) { ans = m - 1; lo = m + 1; } else hi = m - 1; continue; } if (w[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    if (ans < 0) return -1;
    const ww = w[ans]; if (ww.s === undefined) return -1;
    if (t <= ww.e + 0.25) return ans;      // keep the word lit across a short gap; drop it in a real pause
    return -1;
  }
  function sync(jump) {
    if (mode === 'off' || !data || !els.length) return;
    const t = audio.currentTime;
    if (!isFinite(t)) return;
    const pi = findPhrase(t);
    if (pi !== active) {
      if (active >= 0 && els[active]) { els[active].classList.remove('on'); if (activeWord >= 0 && wordEls[active][activeWord]) wordEls[active][activeWord].classList.remove('now'); }
      active = pi; activeWord = -1;
      if (pi >= 0) { els[pi].classList.add('on'); if (following) scrollToActive(jump); }
      log('TRANSCRIPT_PHRASE', { i: pi, t: Math.round(t * 100) / 100 });
    }
    if (pi >= 0) {
      const wi = findWord(data.events[pi], t);
      if (wi !== activeWord) {
        if (activeWord >= 0 && wordEls[pi][activeWord]) wordEls[pi][activeWord].classList.remove('now');
        activeWord = wi; if (wi >= 0) wordEls[pi][wi].classList.add('now');
      }
    }
  }
  function loop() { raf = 0; if (mode === 'off') return; sync(false); if (!audio.paused && !audio.ended) raf = requestAnimationFrame(loop); }
  function start() { if (!raf && mode !== 'off') raf = requestAnimationFrame(loop); }

  // ---------- auto-follow that respects the reader
  function scrollToActive(jump) {
    const el = els[active]; if (!el) return;
    const target = el.offsetTop - scroller.clientHeight * 0.38 + el.offsetHeight / 2;
    programmaticScroll = Date.now();
    try { scroller.scrollTo({ top: Math.max(0, target), behavior: jump ? 'auto' : 'smooth' }); } catch (e) { scroller.scrollTop = Math.max(0, target); }
    follow.hidden = true;
  }
  let lastProgrammaticTop = -1;
  scroller.addEventListener('scroll', () => {
    if (Date.now() - programmaticScroll < 900) return;        // our own smooth scroll is still settling
    if (!following) return;
    if (active >= 0 && els[active]) {
      const el = els[active]; const top = el.offsetTop - scroller.scrollTop;
      if (top > -40 && top < scroller.clientHeight) return;   // active line still visible: not a "browse away"
    }
    following = false; follow.hidden = false; log('TRANSCRIPT_FOLLOW', { on: false });
  }, { passive: true });
  for (const evn of ['touchstart', 'wheel', 'pointerdown']) scroller.addEventListener(evn, () => { programmaticScroll = 0; }, { passive: true });
  function resumeFollow(why) { following = true; follow.hidden = true; log('TRANSCRIPT_FOLLOW', { on: true, why }); if (active >= 0) scrollToActive(false); }
  follow.addEventListener('click', () => resumeFollow('button'));

  // tap a phrase → seek to its start (real timestamp), and follow again
  body.addEventListener('click', ev => {
    const p = ev.target.closest('.tp'); if (!p || !data) return;
    const i = +p.dataset.i; const e = data.events[i]; if (!e) return;
    log('TRANSCRIPT_TAP', { i, s: e.s });
    if (window.__bkk && window.__bkk.seekTo) window.__bkk.seekTo(e.s + 0.001, 'transcript');
    following = true; follow.hidden = true; active = -1; sync(true);
  });

  // ---------- mode control
  function setMode(m, src) {
    if (!MODES.includes(m) || m === mode) return;
    const wasOff = mode === 'off'; mode = m; persist(); log('TRANSCRIPT_MODE', { mode: m, src });
    if (mode === 'off') { if (raf) { cancelAnimationFrame(raf); raf = 0; } render(); return; }
    if (!data && lessonId && !unavailable) { render(); fetchFor(lessonId, gen); }
    else { render(); sync(true); }
    if (!audio.paused) start();
    if (wasOff) following = true;
  }
  modeBar.addEventListener('click', ev => { const b = ev.target.closest('button'); if (b) setMode(b.dataset.mode, 'tap'); });

  // ---------- media events (never a separate clock)
  audio.addEventListener('play', () => { if (!following && mode !== 'off') resumeFollow('play'); start(); });
  audio.addEventListener('playing', start);
  audio.addEventListener('pause', () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } sync(false); });
  audio.addEventListener('seeked', () => { sync(true); });
  audio.addEventListener('timeupdate', () => { if (!raf) sync(false); });
  audio.addEventListener('ratechange', () => sync(false));
  audio.addEventListener('emptied', () => { /* lesson switch: wait for bkk:lesson */ });
  document.addEventListener('bkk:switching', () => { gen++; data = null; lessonId = null; active = -1; activeWord = -1; body.innerHTML = mode === 'off' ? '' : '<div class="tmsg">Loading transcript…</div>'; els = []; wordEls = []; });
  document.addEventListener('bkk:lesson', ev => onLesson(ev.detail.id));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(true); });

  render();
  window.__bkkT = { get mode() { return mode; }, setMode, get active() { return active; }, get activeWord() { return activeWord; }, get following() { return following; }, get data() { return data; }, get lesson() { return lessonId; }, sync, phraseAt: t => data ? findPhrase(t) : -1, wordAt: (t) => { if (!data) return -1; const p = findPhrase(t); return p < 0 ? -1 : findWord(data.events[p], t); }, scroller, resumeFollow };
})();
