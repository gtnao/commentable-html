/* commentable-html — runtime layer.
 *
 * Injected into an arbitrary HTML document. Everything the reader sees lives in
 * a shadow root — host CSS can neither style it nor be broken by it — except
 * the <mark> highlights, which must sit in the light DOM to wrap real text.
 *
 * The #ch-data JSON island is the single source of truth. Highlights and cards
 * are rebuilt from it on every render and are never serialized, so writing the
 * file back is idempotent no matter how many times it happens.
 */
(function () {
  'use strict';

  // Carried in an inert <script type="text/css"> element rather than baked into
  // this file as a string literal, so the build step is pure concatenation and
  // needs no escaping — and therefore no language runtime.
  const cssNode = document.getElementById('ch-ui-css');
  const UI_CSS = cssNode ? cssNode.textContent : '';
  const GAP = 10;                 // vertical gap between sidebar cards
  const EDGE = 8;                 // keep an open editor this far inside the strip
  const CTX = 40;                 // chars of context kept for re-anchoring
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

  const uid = p => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const selfName = () => decodeURIComponent(location.pathname.split('/').pop()) || 'index.html';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const fmtTime = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('ja-JP',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  /* ==============================================================
     state
  ============================================================== */

  const dataEl = document.getElementById('ch-data');
  let store;
  try { store = JSON.parse(dataEl.textContent) || {}; } catch (e) { store = {}; }
  if (!Array.isArray(store.threads)) store.threads = [];
  if (!store.version) store.version = 1;

  let draft = null;               // thread being composed, not yet in the store
  let activeId = null;            // focused thread
  let confirmDel = null;          // {threadId, msgId} awaiting confirmation
  let fileHandle = null;          // where saves go; set by dropping the file
  let unsaved = false;

  // The open editor, if any. While it is mounted the textarea is the live
  // truth; this snapshot is what survives a re-render (resize, font load).
  let composer = null;            // {mode:'new'|'reply'|'edit', threadId, msgId, text, author}

  // id -> {start, end} as resolved against the current text. Kept out of the
  // store so what we serialize stays exactly what we loaded.
  const resolved = new Map();

  const DND_OK = typeof DataTransferItem !== 'undefined'
    && 'getAsFileSystemHandle' in DataTransferItem.prototype;

  const SB_W = 340;               // sidebar width, mirrored in ui.css
  const NARROW = 900;             // below this the sidebar overlays instead

  // Captured before we touch anything: the gutter widens the host's own right
  // padding rather than replacing it, and the original inline style attribute
  // is what gets written back to the file.
  const HOST_PAD_RIGHT = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
  const HOST_BODY_STYLE = document.body.getAttribute('style');

  /* The gutter is the one thing that must reach into the host's own layout.
     It is applied as an inline style rather than a stylesheet rule: inline
     declarations sit above every author rule, so this is deterministic instead
     of a specificity gamble — and being runtime-only it never reaches the
     saved file. */
  function applyGutter() {
    const on = !host.classList.contains('collapsed') && innerWidth > NARROW;
    if (on) {
      document.body.style.setProperty('padding-right', `${SB_W + HOST_PAD_RIGHT}px`, 'important');
    } else if (HOST_BODY_STYLE === null) {
      document.body.removeAttribute('style');
    } else {
      document.body.setAttribute('style', HOST_BODY_STYLE);
    }
  }

  // position:fixed resolves against the nearest transformed/filtered ancestor
  // rather than the viewport, which would strand the sidebar mid-page.
  function fixedBreaker() {
    for (const e of [document.documentElement, document.body]) {
      const cs = getComputedStyle(e);
      if (cs.transform !== 'none' || cs.filter !== 'none'
        || cs.perspective !== 'none' || (cs.willChange || '').includes('transform')) {
        return e.tagName.toLowerCase();
      }
    }
    return null;
  }

  /* ==============================================================
     palette — borrow the host document's look
  ============================================================== */

  function parseColor(str) {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const rgb = c => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  const rgba = (c, a) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
  const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  const lum = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  // Walk up until something actually paints a background.
  function effectiveBg() {
    for (let e = document.body; e; e = e.parentElement) {
      const c = parseColor(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.1) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  // Docs written by an LLM almost always expose an accent as a custom property
  // or a coloured heading rule; fall through the likely sources.
  function findAccent(base, ink) {
    const rootStyle = getComputedStyle(document.documentElement);
    for (const name of ['--accent', '--accent-color', '--primary', '--brand', '--link', '--theme']) {
      const v = rootStyle.getPropertyValue(name).trim();
      if (!v) continue;
      const probe = document.createElement('span');
      probe.style.color = v;
      document.body.appendChild(probe);
      const c = parseColor(getComputedStyle(probe).color);
      probe.remove();
      if (c && Math.abs(lum(c) - lum(base)) > 0.12) return c;
    }
    const link = document.querySelector('a[href]');
    if (link) {
      const c = parseColor(getComputedStyle(link).color);
      if (c && Math.abs(lum(c) - lum(ink)) > 0.08) return c;
    }
    for (const sel of ['h2', 'h3', 'h1']) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const cs = getComputedStyle(node);
      for (const prop of ['borderLeftColor', 'borderBottomColor', 'color']) {
        const c = parseColor(cs[prop]);
        if (c && Math.abs(lum(c) - lum(ink)) > 0.1 && Math.abs(lum(c) - lum(base)) > 0.12) return c;
      }
    }
    return lum(base) < 0.45 ? { r: 110, g: 168, b: 254 } : { r: 37, g: 99, b: 235 };
  }

  function applyPalette() {
    const bodyCS = getComputedStyle(document.body);
    const base = effectiveBg();
    const ink = parseColor(bodyCS.color) || { r: 30, g: 30, b: 30 };
    const accent = findAccent(base, ink);
    const dark = lum(base) < 0.45;

    const vars = {
      '--ch-font': bodyCS.fontFamily,
      '--ch-bg': rgb(mix(base, ink, 0.05)),
      '--ch-surface': rgb(base),
      '--ch-ink': rgb(ink),
      '--ch-muted': rgb(mix(ink, base, 0.42)),
      '--ch-line': rgb(mix(base, ink, 0.17)),
      '--ch-accent': rgb(accent),
      '--ch-accent-soft-line': rgb(mix(accent, base, 0.5)),
      '--ch-on-accent': lum(accent) > 0.6 ? '#111' : '#fff',
      '--ch-warn': dark ? '#e3a008' : '#b45309',
      '--ch-shadow': dark ? 'rgba(0,0,0,.55)' : 'rgba(20,20,20,.12)',
      '--ch-veil': rgba(base, 0.72),
      '--ch-hl-bg': rgba(accent, dark ? 0.28 : 0.17),
      '--ch-hl-active': rgba(accent, dark ? 0.5 : 0.34),
      '--ch-hl-draft': rgba(accent, dark ? 0.42 : 0.28),
      '--ch-hl-solid': rgb(accent),
    };
    let style = document.getElementById('ch-vars');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ch-vars';
      document.head.appendChild(style);
    }
    style.textContent = ':root{' + Object.entries(vars).map(([k, v]) => `${k}:${v};`).join('') + '}';
  }

  /* ==============================================================
     text index & anchoring
  ============================================================== */

  // Flattened text of the host document plus the node/offset map back into it.
  function buildIndex() {
    const nodes = [], starts = [];
    let text = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.data.length) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentNode; p && p !== document.documentElement; p = p.parentNode) {
          if (p.nodeType !== 1) continue;
          // SVG tag names are lower-case, and <mark> cannot wrap SVG text anyway.
          if (SKIP.has(p.tagName.toUpperCase()) || p.hasAttribute('data-ch-ui')) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n);
      starts.push(text.length);
      text += n.data;
    }
    return { nodes, starts, text };
  }

  const makeAnchor = (idx, start, end) => ({
    quote: idx.text.slice(start, end),
    prefix: idx.text.slice(Math.max(0, start - CTX), start),
    suffix: idx.text.slice(end, end + CTX),
    start, end,
  });

  // A selection boundary may land on an element; walk to the nearest text node
  // the index actually knows about.
  function absOffset(idx, container, offset) {
    if (container.nodeType === 3) {
      const i = idx.nodes.indexOf(container);
      return i < 0 ? -1 : idx.starts[i] + offset;
    }
    const ref = container.childNodes[offset] || null;
    for (let i = 0; i < idx.nodes.length; i++) {
      const n = idx.nodes[i];
      if (ref) {
        const pos = ref.compareDocumentPosition(n);
        if (n === ref || (pos & Node.DOCUMENT_POSITION_FOLLOWING) || ref.contains(n)) return idx.starts[i];
      } else if (container.contains(n)) {
        let last = i;                                  // last text node inside
        while (last + 1 < idx.nodes.length && container.contains(idx.nodes[last + 1])) last++;
        return idx.starts[last] + idx.nodes[last].data.length;
      }
    }
    return idx.text.length;
  }

  function allIndexOf(hay, needle) {
    const out = [];
    if (!needle) return out;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
    return out;
  }

  // Length of the shared run, anchored at the end (prefix) or start (suffix).
  function common(a, b, fromEnd) {
    const len = Math.min(a.length, b.length);
    let n = 0;
    while (n < len) {
      const ca = fromEnd ? a[a.length - 1 - n] : a[n];
      const cb = fromEnd ? b[b.length - 1 - n] : b[n];
      if (ca !== cb) break;
      n++;
    }
    return n;
  }

  // Whitespace-insensitive search that maps back to original offsets.
  function loosePosition(text, quote) {
    const map = [];
    let norm = '', prevSpace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (prevSpace || !norm.length) continue;
        norm += ' '; map.push(i); prevSpace = true;
      } else {
        norm += ch; map.push(i); prevSpace = false;
      }
    }
    const q = quote.replace(/\s+/g, ' ').trim();
    const at = q ? norm.indexOf(q) : -1;
    if (at === -1) return null;
    return { start: map[at], end: map[Math.min(at + q.length - 1, map.length - 1)] + 1 };
  }

  /* Locate an anchor in the current text:
       1. exact hit at the recorded offsets
       2. best occurrence of the quote, scored by prefix/suffix context with
          proximity to the old position as a tie-breaker
       3. whitespace-normalised search
       4. nothing — the thread becomes an orphan and is listed at the bottom */
  function resolveAnchor(idx, a) {
    if (!a || !a.quote) return null;
    const { text } = idx, q = a.quote;

    if (typeof a.start === 'number' && text.substr(a.start, q.length) === q) {
      return { start: a.start, end: a.start + q.length };
    }

    const hits = allIndexOf(text, q);
    if (hits.length) {
      let best = hits[0], bestScore = -1;
      for (const at of hits) {
        let score = 0;
        if (a.prefix) {
          score += common(text.slice(Math.max(0, at - a.prefix.length), at), a.prefix, true) / a.prefix.length;
        }
        if (a.suffix) {
          score += common(text.slice(at + q.length, at + q.length + a.suffix.length), a.suffix, false) / a.suffix.length;
        }
        if (typeof a.start === 'number') {
          score += 0.35 * (1 - Math.min(1, Math.abs(at - a.start) / Math.max(400, text.length * 0.1)));
        }
        if (score > bestScore) { bestScore = score; best = at; }
      }
      return { start: best, end: best + q.length };
    }

    return loosePosition(text, q);
  }

  /* ==============================================================
     highlights
  ============================================================== */

  function unwrapMarks(scope) {
    scope.querySelectorAll('ch-highlight').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  // Rebuilds the index per call: wrapping splits text nodes, so offsets taken
  // against a stale index would drift.
  function paint(id, start, end, state) {
    const idx = buildIndex();
    const pieces = [];
    for (let i = 0; i < idx.nodes.length; i++) {
      const s = idx.starts[i], e = s + idx.nodes[i].data.length;
      if (e <= start || s >= end) continue;
      pieces.push({ node: idx.nodes[i], from: Math.max(0, start - s), to: Math.min(e, end) - s });
    }
    // Back to front: splitting a later node cannot disturb an earlier one.
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      let n = p.node;
      if (p.to < n.data.length) n.splitText(p.to);
      if (p.from > 0) n = n.splitText(p.from);
      // A custom element name, so no host stylesheet can be targeting it.
      const m = document.createElement('ch-highlight');
      m.dataset.chId = id;
      if (state) m.dataset.chState = state;
      m.setAttribute('role', 'mark');
      n.parentNode.insertBefore(m, n);
      m.appendChild(n);
    }
    return pieces.length > 0;
  }

  const markOf = id => document.querySelector(`ch-highlight[data-ch-id="${id}"]`);

  /* ==============================================================
     shadow UI
  ============================================================== */

  // Also a custom element: `body > div` style rules cannot reach it.
  const host = document.querySelector('ch-sidebar');
  host.setAttribute('data-ch-ui', '');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${UI_CSS}</style>
    <button id="tab" title="コメントを開く"><span class="chev">‹</span> コメント <span id="tab-n"></span></button>
    <div id="sb">
      <div id="head">
        <div id="title">コメント <span id="count"></span></div>
        <button class="ghost icon" id="collapse" title="サイドバーを最小化" aria-label="サイドバーを最小化">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
            <path d="M10.2 2.7v10.6" stroke="currentColor" stroke-width="1.3"/>
            <path d="M4.3 6.1 6.2 8 4.3 9.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div id="setup">
        <div class="s-title">コメントを始める前に</div>
        <div class="s-body">このファイル <b id="setup-name"></b> を<br>この画面へドラッグ &amp; ドロップ</div>
        <div class="s-note">ブラウザの制約で、ファイルへ書き込むには最初に一度この操作が必要です。設定するまでコメントはできません。</div>
      </div>
      <div id="viewport">
        <div id="empty">本文を選択すると<br>コメントを追加できます</div>
        <div id="layer"><div id="orphans-head">位置が特定できないコメント</div></div>
      </div>
      <div id="foot"><span id="dot"></span><span id="state"></span></div>
    </div>
    <div id="drop"><div class="zone">ドロップして保存先に設定<br><b id="drop-name"></b><br><small>画面のどこで離してもかまいません</small></div></div>
  `;
  const $ = s => root.querySelector(s);
  const layer = $('#layer'), viewport = $('#viewport'), setupEl = $('#setup');
  const emptyEl = $('#empty'), orphanHead = $('#orphans-head');
  const stateEl = $('#state'), dotEl = $('#dot'), dropEl = $('#drop');

  $('#drop-name').textContent = selfName();
  $('#setup-name').textContent = selfName();

  if (!DND_OK) {
    setupEl.querySelector('.s-body').innerHTML =
      'このブラウザでは保存できません。<br><b>Chrome / Edge</b> で開いてください。';
    setupEl.querySelector('.s-note').textContent =
      '保存先を指定できないため、コメントは追加できません。';
  }

  function setState(msg, kind) {
    stateEl.textContent = msg;
    stateEl.className = kind || '';
  }

  function nudgeSetup() {
    setupEl.classList.remove('nudge');
    void setupEl.offsetWidth;                          // restart the animation
    setupEl.classList.add('nudge');
  }

  // Every mutation goes through here. Without a save target the change would
  // only live in memory and disappear on reload, so refuse it and point at the
  // setup panel instead — for edits and deletes just as much as new comments.
  function requireTarget() {
    if (fileHandle) return true;
    openSidebar();
    nudgeSetup();
    return false;
  }

  const LOCK_HINT = '保存先が未設定のため操作できません';

  /* ==============================================================
     author name
  ============================================================== */

  function authorName() {
    try {
      // Storage works: an empty value means this reader has not signed a
      // comment yet, so leave the field blank rather than guessing.
      return localStorage.getItem('ch:author') || '';
    } catch (e) {
      // Storage is blocked (some browsers do that for file://). The most
      // recent author in the file is the best remaining guess.
      for (let i = store.threads.length - 1; i >= 0; i--) {
        const msgs = store.threads[i].messages;
        if (msgs && msgs.length) return msgs[msgs.length - 1].author || '';
      }
      return '';
    }
  }

  function rememberName(n) {
    try { localStorage.setItem('ch:author', n); } catch (e) { /* ignore */ }
  }

  /* ==============================================================
     views
  ============================================================== */

  function openComposer(mode, threadId, msg) {
    composer = {
      mode, threadId,
      msgId: msg ? msg.id : null,
      text: msg ? msg.text : '',
      author: (msg && msg.author) || authorName(),
    };
    confirmDel = null;
    activeId = threadId;
  }

  function closeComposer() {
    if (composer && composer.mode === 'new') draft = null;
    composer = null;
  }

  // Seeded from `composer` and writing back to it, so a re-render triggered by
  // a resize or a late webfont cannot swallow half-typed text.
  function editorView(okLabel, placeholder, onSubmit) {
    const wrap = el('div', 'editor');
    const name = el('input');
    name.type = 'text';
    name.placeholder = '名前';
    name.value = composer.author;
    const ta = el('textarea');
    ta.placeholder = placeholder || '';
    ta.value = composer.text;

    const submit = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const author = name.value.trim() || '匿名';
      rememberName(author);
      onSubmit({ id: uid('m-'), author, text, at: new Date().toISOString() });
    };

    name.addEventListener('input', () => { composer.author = name.value; });
    ta.addEventListener('input', () => { composer.text = ta.value; });
    ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeComposer(); render(); }
    });

    const ok = el('button', 'primary', okLabel);
    const cancel = el('button', null, 'キャンセル');
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => { closeComposer(); render(); });
    const row = el('div', 'row');
    row.append(ok, cancel);

    wrap.append(name, ta, row);
    return wrap;
  }

  function confirmView(thread, msg) {
    const last = thread.messages.length === 1;
    const bar = el('div', 'confirm');
    bar.append(el('span', null, last
      ? 'このコメントを削除します（スレッドごと消えます）'
      : 'この返信を削除します'));

    const yes = el('button', 'danger', '削除');
    yes.addEventListener('click', e => {
      e.stopPropagation();
      if (!requireTarget()) return;
      thread.messages = thread.messages.filter(x => x !== msg);
      if (!thread.messages.length) {
        store.threads = store.threads.filter(x => x !== thread);
        if (activeId === thread.id) activeId = null;
      }
      confirmDel = null;
      render(); persist();
    });
    const no = el('button', null, 'キャンセル');
    no.addEventListener('click', e => { e.stopPropagation(); confirmDel = null; render(); });

    const row = el('div', 'row');
    row.append(yes, no);
    bar.append(row);
    return bar;
  }

  function messageView(thread, msg) {
    const wrap = el('div', 'msg');

    if (composer && composer.mode === 'edit' && composer.msgId === msg.id) {
      wrap.appendChild(editorView('更新', '', edited => {
        msg.text = edited.text;
        msg.author = edited.author;
        msg.editedAt = edited.at;
        composer = null;
        render(); persist();
      }));
      return wrap;
    }

    const who = el('div', 'who');
    who.append(el('b', null, msg.author || '匿名'), el('span', null, fmtTime(msg.at)));
    if (msg.editedAt) who.append(el('span', 'edited', '編集済'));

    const locked = !fileHandle;
    const acts = el('div', 'acts' + (locked ? ' locked' : ''));
    const edit = el('button', 'ghost mini', '編集');
    edit.addEventListener('click', e => {
      e.stopPropagation();
      if (!requireTarget()) return;
      openComposer('edit', thread.id, msg);
      render();
    });
    const del = el('button', 'ghost mini', '削除');
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (!requireTarget()) return;
      composer = null;
      confirmDel = { threadId: thread.id, msgId: msg.id };
      activeId = thread.id;
      render();
    });
    if (locked) [edit, del].forEach(b => { b.title = LOCK_HINT; });
    acts.append(edit, del);
    who.append(acts);

    wrap.append(who, el('div', 'body', msg.text));
    if (confirmDel && confirmDel.msgId === msg.id) wrap.appendChild(confirmView(thread, msg));
    return wrap;
  }

  function cardView(thread, { isDraft, orphan }) {
    const card = el('div', 'card' + (orphan ? ' orphan' : '') + (isDraft ? ' draft' : ''));
    card.dataset.id = thread.id;
    if (activeId === thread.id) card.classList.add('active');

    if (orphan) card.appendChild(el('div', 'orphan-note', '⚠ 本文中に該当箇所が見つかりません'));
    if (thread.anchor && thread.anchor.quote) card.appendChild(el('div', 'quote', thread.anchor.quote));

    thread.messages.forEach(m => card.appendChild(messageView(thread, m)));

    const composing = composer && composer.threadId === thread.id;
    if (isDraft) {
      card.appendChild(editorView('コメント', 'コメントを入力（⌘/Ctrl+Enter で保存）', msg => {
        thread.messages = [msg];
        store.threads.push(thread);
        activeId = thread.id;
        draft = null;
        composer = null;
        render(); persist();
      }));
    } else if (composing && composer.mode === 'reply') {
      card.appendChild(editorView('返信', '返信を入力', msg => {
        thread.messages.push(msg);
        composer = null;
        render(); persist();
      }));
    } else if (!composing) {
      const row = el('div', 'reply-row' + (fileHandle ? '' : ' locked'));
      const reply = el('button', null, '返信');
      if (!fileHandle) reply.title = LOCK_HINT;
      reply.addEventListener('click', e => {
        e.stopPropagation();
        if (!requireTarget()) return;
        openComposer('reply', thread.id);
        render();
      });
      row.appendChild(reply);
      card.appendChild(row);
    }

    card.addEventListener('click', () => {
      if (activeId === thread.id) return;
      activeId = thread.id;
      composer = null;
      confirmDel = null;
      render();
      scrollToMark(thread.id);
    });
    return card;
  }

  /* ==============================================================
     render & layout
  ============================================================== */

  function render() {
    unwrapMarks(document);                 // never let repeated renders nest marks
    layer.querySelectorAll('.card').forEach(c => c.remove());
    resolved.clear();

    const idx = buildIndex();
    const positioned = [], orphans = [];

    for (const thread of (draft ? store.threads.concat(draft) : store.threads)) {
      const isDraft = thread === draft;
      const hit = isDraft
        ? { start: thread.anchor.start, end: thread.anchor.end }
        : resolveAnchor(idx, thread.anchor);

      let anchored = false;
      if (hit && hit.end > hit.start) {
        anchored = paint(thread.id, hit.start, hit.end,
          isDraft ? 'draft' : (activeId === thread.id ? 'active' : ''));
        if (anchored && !isDraft) resolved.set(thread.id, hit);
      }

      const card = cardView(thread, { isDraft, orphan: !anchored && !isDraft });
      layer.appendChild(card);
      (anchored ? positioned : orphans).push({ thread, card });
    }

    const total = store.threads.length;
    emptyEl.style.display = (total || draft || !fileHandle) ? 'none' : '';
    orphanHead.classList.toggle('on', orphans.length > 0);
    $('#count').textContent = total ? `(${total})` : '';
    $('#tab-n').textContent = total || '';

    layoutCards(positioned, orphans);
    syncScroll();

    if (composer) {
      const ta = layer.querySelector('.editor textarea');
      if (ta && root.activeElement !== ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
  }

  let pendingRender = 0;
  function scheduleRender() {
    cancelAnimationFrame(pendingRender);
    pendingRender = requestAnimationFrame(render);
  }

  function docTopOf(id) {
    const m = markOf(id);
    if (!m) return null;
    const r = m.getBoundingClientRect();
    if (!r.height && !r.width) return null;
    return r.top + window.scrollY;
  }

  function layoutCards(positioned, orphans) {
    const items = positioned.map(p => ({
      id: p.thread.id,
      card: p.card,
      desired: docTopOf(p.thread.id) ?? 0,
      h: p.card.offsetHeight,
    })).sort((a, b) => a.desired - b.desired);

    // The card with the open editor wins, and is clamped into the visible strip
    // — otherwise a comment anchored near the end of the document opens its
    // input below the sidebar footer, where it cannot be reached.
    let pin = items.findIndex(i => i.card.querySelector('.editor'));
    const clamp = pin >= 0;
    if (pin < 0) pin = items.findIndex(i => i.id === activeId);

    const tops = new Array(items.length);
    if (pin >= 0) {
      tops[pin] = items[pin].desired;
      if (clamp) {
        const base = window.scrollY + viewport.getBoundingClientRect().top;
        const lo = base + EDGE;
        const hi = base + viewport.clientHeight - items[pin].h - EDGE;
        // Taller than the strip: pin the bottom so the buttons stay reachable.
        tops[pin] = hi < lo ? hi : Math.min(Math.max(items[pin].desired, lo), hi);
      }
      for (let i = pin + 1; i < items.length; i++) {
        tops[i] = Math.max(items[i].desired, tops[i - 1] + items[i - 1].h + GAP);
      }
      for (let i = pin - 1; i >= 0; i--) {
        tops[i] = Math.min(items[i].desired, tops[i + 1] - items[i].h - GAP);
      }
    } else {
      let y = -Infinity;
      for (let i = 0; i < items.length; i++) {
        tops[i] = Math.max(items[i].desired, y);
        y = tops[i] + items[i].h + GAP;
      }
    }
    items.forEach((it, i) => { it.card.style.top = tops[i] + 'px'; });

    if (!orphans.length) return;
    const lastBottom = items.length ? tops[items.length - 1] + items[items.length - 1].h : 0;
    let y = Math.max(lastBottom + 40, document.documentElement.scrollHeight * 0.78);
    orphanHead.style.top = y + 'px';
    y += orphanHead.offsetHeight + GAP;
    for (const o of orphans) {
      o.card.style.top = y + 'px';
      y += o.card.offsetHeight + GAP;
    }
  }

  // Cards are placed in document coordinates; the layer is shifted to match.
  function syncScroll() {
    const top = viewport.getBoundingClientRect().top;
    layer.style.transform = `translateY(${-(window.scrollY + top)}px)`;
  }

  function scrollToMark(id) {
    const m = markOf(id);
    if (!m) return;
    const r = m.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 60) {
      window.scrollTo({ top: r.top + scrollY - innerHeight / 3, behavior: 'smooth' });
    }
  }

  /* ==============================================================
     sidebar open / close
  ============================================================== */

  function openSidebar() {
    host.classList.remove('collapsed');
    applyGutter();
    scheduleRender();                      // body width changed, so did the marks
  }

  function closeSidebar() {
    host.classList.add('collapsed');
    applyGutter();
    scheduleRender();
  }

  /* ==============================================================
     selection -> draft
  ============================================================== */

  function inDoc(node) {
    if (!node) return false;
    const e = node.nodeType === 1 ? node : node.parentElement;
    return !!e && document.body.contains(e) && !e.closest('[data-ch-ui]');
  }

  // Drop a draft the reader never typed into, so idle selections don't pile up.
  // Anything already typed is kept — losing it to a stray click is worse.
  function dropEmptyDraft() {
    if (!draft) return false;
    const ta = layer.querySelector('.card.draft textarea');
    const text = ta ? ta.value : (composer ? composer.text : '');
    if (text.trim()) return false;
    draft = null;
    composer = null;
    return true;
  }

  function onSelectionSettled() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (dropEmptyDraft()) render();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!inDoc(range.startContainer) || !inDoc(range.endContainer)) return;

    const idx = buildIndex();
    let start = absOffset(idx, range.startContainer, range.startOffset);
    let end = absOffset(idx, range.endContainer, range.endOffset);
    if (start < 0 || end < 0) return;
    if (end < start) [start, end] = [end, start];
    if (!idx.text.slice(start, end).trim()) return;

    if (!requireTarget()) return;

    dropEmptyDraft();
    draft = { id: uid('t-'), anchor: makeAnchor(idx, start, end), messages: [] };
    openComposer('new', draft.id);
    sel.removeAllRanges();
    openSidebar();
    render();
  }

  /* ==============================================================
     events
  ============================================================== */

  // Events raised inside the shadow root are retargeted to the host before they
  // reach document, so target checks would read our own UI as an outside click.
  // composedPath() still sees the real origin.
  const fromUI = e => (e.composedPath ? e.composedPath() : []).includes(host);

  document.addEventListener('mouseup', e => {
    if (!fromUI(e)) setTimeout(onSelectionSettled, 0);
  });
  document.addEventListener('keyup', e => {
    if (e.shiftKey || e.key.startsWith('Arrow')) setTimeout(onSelectionSettled, 0);
  });
  document.addEventListener('click', e => {
    const m = e.target.closest && e.target.closest('ch-highlight');
    if (!m) return;
    activeId = m.dataset.chId;
    composer = null;
    confirmDel = null;
    openSidebar();
    render();
  });

  $('#collapse').addEventListener('click', closeSidebar);
  $('#tab').addEventListener('click', openSidebar);

  addEventListener('scroll', syncScroll, { passive: true });
  addEventListener('resize', () => { applyGutter(); scheduleRender(); });
  addEventListener('load', () => { applyPalette(); scheduleRender(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleRender);
  addEventListener('beforeunload', e => {
    if (unsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ==============================================================
     persistence — File System Access, linked by dropping the file
  ============================================================== */

  function serializeSelf() {
    // Write anchors back as they resolve right now, so a comment survives a
    // long chain of small edits instead of drifting away from its first take.
    const idx = buildIndex();
    for (const thread of store.threads) {
      const hit = resolved.get(thread.id);
      if (hit) thread.anchor = makeAnchor(idx, hit.start, hit.end);
    }
    const json = JSON.stringify({
      version: store.version,
      threads: store.threads.map(t => ({ id: t.id, anchor: t.anchor, messages: t.messages })),
    }, null, 2).replace(/</g, '\\u003c');       // must not close the script tag

    // Shadow content is not cloned, so the UI never reaches the file. Strip the
    // rest of the runtime state by hand.
    const clone = document.documentElement.cloneNode(true);
    unwrapMarks(clone);
    const vars = clone.querySelector('#ch-vars');
    if (vars) vars.remove();
    clone.querySelector('ch-sidebar').innerHTML = '';
    clone.querySelector('#ch-data').textContent = json;

    const body = clone.querySelector('body');
    // Undo the runtime gutter, restoring whatever inline style the host had.
    if (HOST_BODY_STYLE === null) body.removeAttribute('style');
    else body.setAttribute('style', HOST_BODY_STYLE);

    // The newline appended below lands back inside <body> when the file is
    // re-read, so normalise the tail or every save would grow by one byte.
    while (body.lastChild && body.lastChild.nodeType === 3 && !body.lastChild.data.trim()) {
      body.lastChild.remove();
    }
    body.appendChild(document.createTextNode('\n'));

    return '<!DOCTYPE html>\n' + clone.outerHTML + '\n';
  }

  async function writable(h) {
    const opts = { mode: 'readwrite' };
    if (await h.queryPermission(opts) === 'granted') return true;
    return await h.requestPermission(opts) === 'granted';
  }

  async function persist() {
    if (!fileHandle) { markUnsaved('保存先が未設定です'); return; }
    try {
      if (!await writable(fileHandle)) throw new Error('書き込みが許可されませんでした');
      const w = await fileHandle.createWritable();
      await w.write(serializeSelf());
      await w.close();
      unsaved = false;
      dotEl.className = 'linked';
      setState(`保存しました · ${new Date().toLocaleTimeString('ja-JP')}`, 'ok');
    } catch (err) {
      markUnsaved('保存に失敗: ' + err.message);
    }
  }

  function markUnsaved(msg) {
    unsaved = true;
    dotEl.className = 'dirty';
    setState(msg, 'err');
  }

  function linkFile(h) {
    fileHandle = h;
    dotEl.className = 'linked';
    setState(`${h.name} に保存します`, 'ok');
    setupEl.classList.remove('on');
    render();                              // the locked affordances open up
    if (unsaved) persist();
  }

  let dragDepth = 0;
  addEventListener('dragenter', e => {
    if (!DND_OK || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    dropEl.classList.add('on');
  });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('dragleave', () => {
    if (dragDepth && --dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('on'); }
  });
  addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    dropEl.classList.remove('on');
    if (!DND_OK) { setState('このブラウザは保存に未対応です（Chrome / Edge が必要）。', 'err'); return; }
    const item = e.dataTransfer.items[0];
    if (!item) return;
    item.getAsFileSystemHandle()          // must be called before the handler yields
      .then(h => {
        if (!h || h.kind !== 'file') { setState('ファイルをドロップしてください。', 'err'); return; }
        if (h.name !== selfName()) {
          setState(`${h.name} はこのページ (${selfName()}) ではありません。`, 'err');
          return;
        }
        linkFile(h);
      })
      .catch(err => setState('ハンドル取得に失敗: ' + err.message, 'err'));
  });

  /* ==============================================================
     boot
  ============================================================== */

  applyPalette();
  applyGutter();
  setupEl.classList.add('on');
  const breaker = fixedBreaker();
  if (breaker) {
    setState(`<${breaker}> に transform/filter があるため、サイドバーの固定表示が崩れる場合があります。`, 'err');
  } else {
    setState(DND_OK ? '保存先は未設定です' : 'このブラウザでは保存できません', DND_OK ? '' : 'err');
  }

  // Debug surface: also what the test suites drive.
  window.__commentable = {
    store, buildIndex, resolveAnchor, serializeSelf, render,
    add(start, end, author, text) {                    // what a selection resolves to
      const thread = {
        id: uid('t-'),
        anchor: makeAnchor(buildIndex(), start, end),
        messages: [{ id: uid('m-'), author, text, at: new Date().toISOString() }],
      };
      store.threads.push(thread);
      render();
      return thread;
    },
    status: () => store.threads.map(t => ({
      id: t.id,
      quote: t.anchor.quote,
      anchored: resolved.has(t.id),
      messages: t.messages.length,
    })),
  };

  render();
})();
