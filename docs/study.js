/* Bangkok Ready — Vocab Bank + Flashcards (study.js)
   A second view of the SAME course data (study.json, built from the lesson sources + transcripts).
   Isolated from the player: it never touches the lesson <audio>; word/phrase audio plays the exact
   span from the existing lesson MP3 through its own element. State lives in localStorage bkk_study_v1. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const B = window.__bkk; if (!B) return;
  const log = (ev, d) => { try { B.logEvent(ev, d); } catch (e) { } };
  const KEY = 'bkk_study_v1';
  let st = { learned: {}, star: {}, dir: 'en', pos: {} };
  try { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); if (s && typeof s === 'object') st = Object.assign(st, s); st.learned = st.learned || {}; st.star = st.star || {}; st.pos = st.pos || {}; if (st.dir !== 'th') st.dir = 'en'; } catch (e) { }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { } }

  // ---------- data
  let D = null, VOCAB = [], BYID = {}, DECKS = {}, LESSON_TITLES = {};
  const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  async function load() {
    if (D) return D;
    const r = await fetch('study.json'); if (!r.ok) throw new Error('HTTP ' + r.status);
    D = await r.json();
    VOCAB = D.vocab; for (const v of VOCAB) { v.q = fold(v.en) + ' ' + fold(v.rom) + ' ' + v.th; BYID[v.id] = v; }
    DECKS = D.decks; for (const l of D.lessons) LESSON_TITLES[l.n] = l.title;
    log('STUDY_LOADED', { vocab: VOCAB.length, decks: Object.keys(DECKS).length });
    return D;
  }
  const short = t => (t || '').replace(/^Lesson \d+ — /, '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function learnedCount() { let n = 0; for (const v of VOCAB) if (st.learned[v.id]) n++; return n; }

  // ---------- audio: play [s,e] of an existing lesson file through a private element
  const sa = new Audio(); sa.preload = 'auto'; let saUrl = null, saStop = 0, saGen = 0;
  let toastT; function toast(m) { const el = $('toast'); if (!el) return; el.textContent = m; el.classList.add('in'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('in'), 2000); }
  sa.addEventListener('timeupdate', () => { if (saStop && sa.currentTime >= saStop) { sa.pause(); saStop = 0; } });
  async function playSpan(a, btn) {
    if (!a) return;
    const my = ++saGen; sa.pause(); saStop = 0;
    try { sa.play().catch(() => { }); } catch (e) { }           // unlock the element inside the tap (iOS)
    if (btn) btn.classList.add('busy');
    try {
      if (B.state === 'PLAYING') B.pause('study');
      const lesson = B.LESSONS().find(l => l.n === a.l); if (!lesson) throw new Error('no lesson');
      const url = await B.lessonAudioUrl(lesson);
      if (my !== saGen) return;
      if (saUrl !== url) { sa.src = url; saUrl = url; sa.load(); }
      if (sa.readyState < 1) await new Promise((res, rej) => { const ok = () => { cleanup(); res(); }; const bad = () => { cleanup(); rej(new Error('audio')); }; const cleanup = () => { sa.removeEventListener('loadedmetadata', ok); sa.removeEventListener('error', bad); }; sa.addEventListener('loadedmetadata', ok); sa.addEventListener('error', bad); });
      if (my !== saGen) return;
      sa.currentTime = a.s; saStop = a.e; await sa.play();
      log('STUDY_AUDIO', { l: a.l, s: a.s });
    } catch (e) { if (my === saGen) { log('STUDY_AUDIO_FAIL', { msg: String(e).slice(0, 80) }); toast(navigator.onLine === false ? 'Audio for this lesson is not downloaded yet.' : 'Could not play audio.'); } }
    finally { if (btn) btn.classList.remove('busy'); }
  }

  // ---------- state toggles (shared by both views)
  function setLearned(id, on) { if (on) st.learned[id] = 1; else delete st.learned[id]; save(); log('STUDY_LEARNED', { id, on: !!on }); document.dispatchEvent(new CustomEvent('bkk:study', { detail: { id, learned: !!on } })); }
  function setStar(id, on) { if (on) st.star[id] = 1; else delete st.star[id]; save(); log('STUDY_STAR', { id, on: !!on }); document.dispatchEvent(new CustomEvent('bkk:study', { detail: { id, star: !!on } })); }

  // ---------- top-level navigation: Lessons (player) | Vocab Bank | Flashcards
  let view = 'lessons';
  function show(v, src) {
    if (v === view) return;
    view = v; log('STUDY_VIEW', { view: v, src: src || 'tab' });
    document.querySelectorAll('#tabs button').forEach(b => { const on = b.dataset.view === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    $('vocabView').hidden = v !== 'vocab'; $('cardsView').hidden = v !== 'cards';
    document.body.classList.toggle('study', v !== 'lessons');
    if (v !== 'lessons') { sa.pause(); if (v === 'vocab') renderVocab(); else renderCards(); }
    else { sa.pause(); }
  }
  $('tabs').addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.view !== 'lessons' && !(await ready())) return; show(b.dataset.view, 'tab'); });
  async function ready() { try { await load(); return true; } catch (e) { log('STUDY_LOAD_FAIL', { msg: String(e).slice(0, 80) }); toast('Study data is not available offline yet.'); return false; } }

  // ---------- per-lesson links on the player
  function paintLinks() { const id = B.lesson; const n = id ? +id.replace('lesson', '') : 0; const el = $('lessonLinks'); if (!el) return; el.hidden = !n; el.querySelector('span').textContent = 'Lesson ' + n; }
  document.addEventListener('bkk:lesson', paintLinks); setTimeout(paintLinks, 0);
  $('lnkVocab').addEventListener('click', async e => { e.preventDefault(); if (!(await ready())) return; const n = +(B.lesson || '').replace('lesson', ''); vf.lesson = n || 0; $('vLesson').value = String(vf.lesson); show('vocab', 'lesson-link'); renderVocab(); });
  $('lnkCards').addEventListener('click', async e => { e.preventDefault(); if (!(await ready())) return; const n = +(B.lesson || '').replace('lesson', ''); show('cards', 'lesson-link'); if (n) openDeck(String(n), 'lesson-link'); });

  // ================= VOCAB BANK =================
  const vf = { lesson: 0, state: 'all', q: '' };
  function vocabList() {
    const q = fold(vf.q.trim());
    return VOCAB.filter(v => (!vf.lesson || v.first === vf.lesson) && (vf.state === 'all' || (vf.state === 'learned' ? st.learned[v.id] : st.star[v.id])) && (!q || v.q.includes(q) || v.th.includes(vf.q.trim())));
  }
  function rowHTML(v) {
    const L = !!st.learned[v.id], S = !!st.star[v.id];
    return '<div class="vrow' + (L ? ' learned' : '') + (S ? ' starred' : '') + '" data-id="' + esc(v.id) + '">'
      + '<div class="vtext"><div class="ven">' + esc(v.en) + '</div><div class="vrom">' + esc(v.rom) + '</div><div class="vth" lang="th">' + esc(v.th) + '</div><div class="vmeta">Lesson ' + v.first + (v.lessons.length > 1 ? ' · also in ' + v.lessons.filter(n => n !== v.first).slice(0, 4).join(', ') + (v.lessons.length > 5 ? '…' : '') : '') + '</div></div>'
      + '<button class="vaudio" data-act="audio" aria-label="Play Thai audio"' + (v.audio ? '' : ' disabled') + '>🔊</button>'
      + '<div class="vctl"><button class="vlearn' + (L ? ' on' : '') + '" data-act="learned" aria-pressed="' + L + '"><span class="ic">' + (L ? '✓' : '○') + '</span> Learned</button>'
      + '<button class="vstar' + (S ? ' on' : '') + '" data-act="star" aria-pressed="' + S + '"><span class="ic">' + (S ? '⭐' : '☆') + '</span> Practice</button></div></div>';
  }
  function paintStat() { const n = learnedCount(); $('vStat').textContent = n + ' ' + (n === 1 ? 'word' : 'words') + ' learned'; $('vStatSub').textContent = 'of ' + VOCAB.length + ' Thai words in Level 1'; }
  function renderVocab() {
    if (!D) return; paintStat();
    const list = vocabList(); $('vCount').textContent = list.length + (list.length === 1 ? ' word' : ' words');
    $('vList').innerHTML = list.length ? list.map(rowHTML).join('') : '<div class="vempty">' + (vf.state === 'learned' ? 'No learned words here yet — tap ✓ Learned on a word you know.' : vf.state === 'star' ? 'Nothing marked for practice here. ☆ Practice marks a word you want to work on.' : 'No words match.') + '</div>';
  }
  function repaintRow(id) { const old = $('vList').querySelector('.vrow[data-id="' + CSS.escape(id) + '"]'); if (!old) return; const v = BYID[id]; if (!v) return; const tmp = document.createElement('div'); tmp.innerHTML = rowHTML(v); old.replaceWith(tmp.firstChild); }
  $('vList').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;   // text / background taps do nothing
    e.preventDefault(); e.stopPropagation();
    const row = b.closest('.vrow'); const id = row.dataset.id; const v = BYID[id]; if (!v) return;
    if (b.dataset.act === 'audio') { playSpan(v.audio, b); return; }
    if (b.dataset.act === 'learned') setLearned(id, !st.learned[id]);
    else if (b.dataset.act === 'star') setStar(id, !st.star[id]);
    if (vf.state !== 'all') renderVocab(); else { repaintRow(id); paintStat(); }
  });
  (function buildLessonSelect() { const sel = $('vLesson'); sel.innerHTML = '<option value="0">All lessons</option>' + Array.from({ length: 20 }, (_, i) => '<option value="' + (i + 1) + '">Lesson ' + (i + 1) + '</option>').join(''); })();
  $('vLesson').addEventListener('change', () => { vf.lesson = +$('vLesson').value; renderVocab(); });
  $('vState').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; vf.state = b.dataset.state; document.querySelectorAll('#vState button').forEach(x => x.classList.toggle('on', x === b)); renderVocab(); });
  let qT; $('vSearch').addEventListener('input', () => { vf.q = $('vSearch').value; clearTimeout(qT); qT = setTimeout(renderVocab, 60); });
  $('vClear').addEventListener('click', () => { $('vSearch').value = ''; vf.q = ''; renderVocab(); $('vSearch').focus(); });

  // ================= FLASHCARDS =================
  let deck = null;   // {key, title, cards:[...], order:[idx], shuffled, i, npOnly}
  function starredCards() { const out = []; for (let n = 1; n <= 20; n++) for (const c of DECKS[String(n)] || []) if (st.star[c.id]) out.push(Object.assign({ lesson: n }, c)); return out; }
  function deckCards(key, npOnly) {
    if (key === 'np') return starredCards();
    const cs = (DECKS[key] || []).map(c => Object.assign({ lesson: +key }, c));
    return npOnly ? cs.filter(c => st.star[c.id]) : cs;
  }
  function renderPicker() {
    const np = starredCards().length;
    let h = '<div class="drow np" data-deck="np" role="button" tabindex="0"><div class="num">⭐</div><div class="t"><b>Needs Practice</b><span>' + (np ? np + ' starred card' + (np === 1 ? '' : 's') + ' across all lessons' : 'Nothing starred yet') + '</span></div></div>';
    for (let n = 1; n <= 20; n++) { const cs = DECKS[String(n)] || []; const s = cs.filter(c => st.star[c.id]).length; h += '<div class="drow" data-deck="' + n + '" role="button" tabindex="0"><div class="num">' + n + '</div><div class="t"><b>' + esc(short(LESSON_TITLES[n])) + '</b><span>' + cs.length + ' cards' + (s ? ' · ⭐ ' + s : '') + '</span></div></div>'; }
    $('dPicker').innerHTML = h;
  }
  function renderCards() { if (!D) return; if (deck) renderStudy(); else { $('dPicker').hidden = false; $('dStudy').hidden = true; renderPicker(); } }
  $('dPicker').addEventListener('click', e => { const r = e.target.closest('.drow'); if (r) openDeck(r.dataset.deck, 'picker'); });
  $('dPicker').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const r = e.target.closest('.drow'); if (r) { e.preventDefault(); openDeck(r.dataset.deck, 'picker'); } } });
  function openDeck(key, src, npOnly) {
    const cards = deckCards(key, npOnly);
    deck = { key, npOnly: !!npOnly, title: key === 'np' ? '⭐ Needs Practice' : 'Lesson ' + key + ' — ' + short(LESSON_TITLES[+key]), cards, order: cards.map((_, i) => i), shuffled: false, i: 0, flipped: false };
    const pk = key + (npOnly ? ':np' : ''); const saved = st.pos[pk]; if (Number.isInteger(saved) && saved >= 0 && saved < cards.length) deck.i = saved;
    log('STUDY_DECK', { key, src, n: cards.length, npOnly: !!npOnly });
    $('dPicker').hidden = true; $('dStudy').hidden = false; renderStudy();
  }
  function closeDeck() { deck = null; $('dStudy').hidden = true; $('dPicker').hidden = false; renderPicker(); }
  function current() { return deck && deck.cards.length ? deck.cards[deck.order[deck.i]] : null; }
  function savePos() { if (deck) { st.pos[deck.key + (deck.npOnly ? ':np' : '')] = deck.i; save(); } }
  function renderStudy() {
    const c = current(); const n = deck.cards.length;
    $('dTitle').textContent = deck.title; $('dBack').hidden = false;
    document.querySelectorAll('#dDir button').forEach(b => b.classList.toggle('on', b.dataset.dir === st.dir));
    $('dShuffle').textContent = deck.shuffled ? '↺ Restore order' : '🔀 Shuffle'; $('dShuffle').classList.toggle('on', deck.shuffled);
    $('dNpOnly').hidden = deck.key === 'np'; $('dNpOnly').classList.toggle('on', deck.npOnly); $('dNpOnly').textContent = deck.npOnly ? '⭐ Starred only' : '☆ Starred only';
    if (!c) {
      $('dProg').textContent = '0 / 0'; $('dCard').innerHTML = '<div class="dempty">' + (deck.key === 'np' || deck.npOnly ? '✨ Nothing left to practice — everything here has stuck. Star a card any time to bring it back.' : 'This deck is empty.') + '</div>';
      $('dCard').classList.remove('flipped'); ['dPrev', 'dNext', 'dFlip', 'dStar', 'dAudio'].forEach(id => $(id).disabled = true); return;
    }
    ['dPrev', 'dNext', 'dFlip', 'dStar'].forEach(id => $(id).disabled = false);
    $('dProg').textContent = (deck.i + 1) + ' / ' + n;
    const thaiSide = '<div class="crom">' + esc(c.rom) + '</div><div class="cth" lang="th">' + esc(c.th) + '</div>';
    const enSide = '<div class="cen">' + esc(c.en) + '</div>';
    const front = st.dir === 'en' ? enSide : thaiSide, back = st.dir === 'en' ? thaiSide : enSide;
    const kind = c.k === 'word' ? 'Word' : c.k === 'phrase' ? 'Phrase' : 'Recombination';
    const hint = deck.flipped ? '' : (st.dir === 'en' ? 'Say it in Thai, then flip' : 'Say what it means, then flip');
    $('dCard').innerHTML = '<div class="ckind">' + kind + (deck.key === 'np' ? ' · Lesson ' + c.lesson : '') + '</div><div class="cface">' + (deck.flipped ? back : front) + '</div><div class="chint">' + hint + '</div>';
    $('dCard').classList.toggle('flipped', deck.flipped);
    const S = !!st.star[c.id]; $('dStar').classList.toggle('on', S); $('dStar').setAttribute('aria-pressed', String(S)); $('dStar').innerHTML = '<span class="ic">' + (S ? '⭐' : '☆') + '</span> Practice';
    const showAudio = !!c.a && (st.dir === 'th' || deck.flipped); $('dAudio').disabled = !showAudio; $('dAudio').classList.toggle('dim', !c.a); $('dAudio').title = c.a ? 'Play Thai audio' : 'No recording for this card';
    $('dFlip').textContent = deck.flipped ? 'Flip back' : 'Flip';
  }
  function step(d) { if (!deck || !deck.cards.length) return; deck.i = (deck.i + d + deck.cards.length) % deck.cards.length; deck.flipped = false; savePos(); renderStudy(); }
  $('dBack').addEventListener('click', closeDeck);
  $('dPrev').addEventListener('click', () => step(-1)); $('dNext').addEventListener('click', () => step(1));
  $('dFlip').addEventListener('click', () => { if (!current()) return; deck.flipped = !deck.flipped; renderStudy(); });
  $('dCard').addEventListener('click', () => { if (!current()) return; deck.flipped = !deck.flipped; renderStudy(); });
  $('dDir').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.dataset.dir === st.dir) return; st.dir = b.dataset.dir; save(); deck.flipped = false; renderStudy(); log('STUDY_DIR', { dir: st.dir }); });
  $('dShuffle').addEventListener('click', () => {
    if (!deck) return;
    const cur = deck.order[deck.i];
    if (deck.shuffled) { deck.order = deck.cards.map((_, i) => i); deck.shuffled = false; }
    else { const o = deck.cards.map((_, i) => i); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } deck.order = o; deck.shuffled = true; }
    deck.i = Math.max(0, deck.order.indexOf(cur)); deck.flipped = false; renderStudy(); log('STUDY_SHUFFLE', { on: deck.shuffled });
  });
  $('dNpOnly').addEventListener('click', () => { if (!deck || deck.key === 'np') return; openDeck(deck.key, 'np-toggle', !deck.npOnly); });
  $('dStar').addEventListener('click', e => {
    e.preventDefault(); const c = current(); if (!c) return;
    const on = !st.star[c.id]; setStar(c.id, on);
    if (!on && (deck.key === 'np' || deck.npOnly)) {     // unstar while studying a starred deck: remove gracefully, keep place
      const pos = deck.order[deck.i];
      deck.cards.splice(pos, 1); deck.order = deck.order.filter(x => x !== pos).map(x => x > pos ? x - 1 : x);
      if (deck.i >= deck.order.length) deck.i = Math.max(0, deck.order.length - 1);
      deck.flipped = false; savePos();
    }
    renderStudy();
  });
  $('dAudio').addEventListener('click', e => { e.preventDefault(); const c = current(); if (c && c.a) playSpan(c.a, $('dAudio')); });
  window.addEventListener('keydown', e => { if (view !== 'cards' || !deck || $('dStudy').hidden) return; if (e.target && /input|textarea|select/i.test(e.target.tagName)) return; if (e.code === 'ArrowLeft') step(-1); else if (e.code === 'ArrowRight') step(1); else if (e.code === 'Space') { e.preventDefault(); deck.flipped = !deck.flipped; renderStudy(); } });

  // keep the two views in sync when state changes in the other one
  document.addEventListener('bkk:study', () => { if (view === 'vocab') { if (vf.state !== 'all') renderVocab(); else paintStat(); } });

  // preload the data quietly so the first tap is instant (and so the SW has it cached)
  load().catch(() => { });
  window.__bkkS = { get audioEl() { return sa; }, get filters() { return vf; }, show, get view() { return view; }, get state() { return st; }, setLearned, setStar, learnedCount, vocabList, get vocab() { return VOCAB; }, get decks() { return DECKS; }, openDeck, closeDeck, get deck() { return deck; }, current, step, playSpan, ready, load };
})();
