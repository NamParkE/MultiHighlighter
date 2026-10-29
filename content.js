(() => {
  // Highlights are drawn with the CSS Custom Highlight API: the page's DOM is never
  // modified, so sites that re-render their own text (React, Vue, ...) keep working,
  // and editable areas can be highlighted safely.
  //
  // Privacy note: pages can read the shared highlight registry, so only matches that
  // are actually on screen are registered. Hidden "bait" text can't reveal the word list.
  const PREFIX = 'mwh-';
  const CURRENT = 'mwh-current';
  const IS_TOP = window === window.top;
  // Compared against localName, which is lowercase in both HTML and XHTML documents.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'textarea', 'input', 'select',
    'option', 'iframe', 'canvas', 'template', 'head'
  ]);
  // Text inside these flows on with its neighbours, so a word may span them ("사<b>과</b>").
  // Any other element (div, p, li, br, img, ...) ends the run of text.
  const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em',
    'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'q', 'rp', 'rt', 'ruby', 's',
    'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr'
  ]);
  // Attribute changes that can show or hide text without touching it.
  const VISIBILITY_ATTRS = ['class', 'style', 'hidden', 'open'];
  const OBSERVE = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: VISIBILITY_ATTRS
  };
  // Frames smaller than this (tracking pixels, hidden ad slots) don't count.
  const MIN_FRAME_AREA = 400;
  // The panel says it's watching at least this often; otherwise nothing is sent.
  const WATCH_MS = 30000;
  const COLOR = /^#[0-9a-f]{6}$/i;

  let settings = { words: [], enabled: true, caseSensitive: false, wholeWord: false };
  let matcher = null;      // { regex, groupIdx }
  let entries = [];        // { nodes, range, idx, root, painted } in document order
  let byIdx = new Map();   // word index -> entries in document order
  let visible = new Map(); // word index -> entries currently shown on screen
  let hiddenCounts = {};
  let visibilityDirty = true;
  let shownCache = new WeakMap(); // element -> on screen? (reset when visibility may have changed)
  const highlights = new Map();   // word index -> Highlight (visible matches only)
  let current = null;      // entry selected by prev/next
  let observer = null;
  const dirty = new Set(); // block elements (or shadow roots) whose text must be rescanned
  let needsPrune = false;  // nodes were removed: drop their matches
  let pendingTimer = null;
  let lastSignature = '';
  let watchedUntil = 0;

  // Shadow DOM: each shadow root is scanned, observed and given its own copy of the styles,
  // because page styles (and so ::highlight rules) don't reach inside shadow trees.
  const shadowRoots = new Set();  // only roots whose host is still in the page (see forgetDetachedShadows)
  const styles = new WeakMap();   // document or shadow root -> <style>
  const ownStyles = new WeakSet();
  let cssText = '';
  let sweepTimer = null;
  let lastSweep = 0;

  // Frames (top frame only): each child frame reports its own counts through the background.
  const frames = new Map();       // frameId -> { counts, hidden }
  let frameCurrent = null;        // { id, idx, k } when prev/next landed inside a frame
  // Content scripts can't ask which <iframe> a frameId belongs to, so the page gives each
  // iframe a token and the frame sends it back with its reports.
  const tokenOf = new WeakMap();  // <iframe> -> token
  const frameEls = new Map();     // frameId -> <iframe> (dropped once the iframe leaves the page)
  let parentToken = null;         // in a child frame: token its parent gave it

  const tag = n => n.localName || '';
  const watched = () => Date.now() < watchedUntil;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Changes to these need a rescan; a color change only needs new styles.
  function structureKey(s) {
    return JSON.stringify([s.enabled, s.caseSensitive, s.wholeWord, s.words.map(w => [w.text, w.on !== false])]);
  }

  // "apple pie" also matches "apple&nbsp;pie", double spaces and line breaks.
  function wordPattern(text) {
    return text.trim().split(/\s+/).map(escapeRegex).join('\\s+');
  }

  function buildMatcher() {
    const active = settings.words
      .map((w, i) => ({ ...w, i }))
      .filter(w => w.text && w.text.trim() && w.on !== false);
    if (!settings.enabled || active.length === 0) return null;

    // Longer words first so "apple pie" wins over "apple".
    active.sort((a, b) => b.text.length - a.text.length);
    const seen = new Set();
    const parts = [];
    const groupIdx = [];   // capture group n -> word index
    for (const w of active) {
      const key = settings.caseSensitive ? w.text.trim() : w.text.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(`(${wordPattern(w.text)})`);
      groupIdx.push(w.i);
    }
    let src = parts.join('|');
    if (settings.wholeWord) {
      src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    }
    const flags = 'gu' + (settings.caseSensitive ? '' : 'i');
    return { regex: new RegExp(src, flags), groupIdx };
  }

  // The capture group that matched tells which word it was, whatever its case.
  function matchedWord(m) {
    for (let g = 1; g < m.length; g++) {
      if (m[g] !== undefined) return matcher.groupIdx[g - 1];
    }
  }

  // Open and closed shadow roots (content scripts may see closed ones).
  function shadowOf(el) {
    try {
      return (chrome.dom && chrome.dom.openOrClosedShadowRoot)
        ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  }

  // The element a text node is drawn in; text placed directly in a shadow root uses its host.
  function elementFor(node) {
    return node.parentElement || node.getRootNode().host || null;
  }

  function blockOf(node) {
    let n = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (n && INLINE_TAGS.has(tag(n))) n = n.parentElement;
    // Text sitting directly in a shadow root belongs to the root itself.
    return n || node.getRootNode();
  }

  function insideSkipped(el) {
    for (let n = el; n; n = n.parentElement) {
      if (SKIP_TAGS.has(tag(n))) return true;
    }
    return false;
  }

  // `node` or one of its ancestors (through shadow boundaries) is in `set`.
  function underAny(node, set) {
    for (let n = node; n; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
      if (set.has(n)) return true;
    }
    return false;
  }

  // `node` followed by the shadow hosts that contain it, innermost first.
  function hostChain(node) {
    const chain = [node];
    for (let r = node.getRootNode(); r instanceof ShadowRoot; r = chain[chain.length - 1].getRootNode()) {
      chain.push(r.host);
    }
    return chain;
  }

  // Page order of two nodes that may live in different shadow trees: compare them
  // in the innermost tree they share (a node and its own host count the host first).
  function precedes(a, b) {
    const ca = hostChain(a);
    const cb = hostChain(b);
    for (const x of ca) {
      for (const y of cb) {
        if (x.getRootNode() !== y.getRootNode()) continue;
        if (x === y) return x === a;
        return !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
      }
    }
    return false;
  }

  function compareEntries(a, b) {
    if (a.root === b.root) return a.range.compareBoundaryPoints(Range.START_TO_START, b.range);
    return precedes(a.nodes[0], b.nodes[0]) ? -1 : 1;
  }

  // Rejecting an element skips its whole subtree; accepted elements end a run of text.
  const filter = {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (SKIP_TAGS.has(tag(n))) return NodeFilter.FILTER_REJECT;
      if (INLINE_TAGS.has(tag(n)) && !shadowOf(n)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  };

  // Index of the text node holding character `pos` of the joined run.
  function locate(starts, pos, isEnd) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (isEnd ? starts[mid] < pos : starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function matchRun(nodes, starts, text, out) {
    if (!text.trim()) return;
    const { regex } = matcher;
    const root = nodes[0].getRootNode();
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue; }
      const idx = matchedWord(m);
      if (idx === undefined) continue;
      const end = m.index + m[0].length;
      const s = locate(starts, m.index, false);
      const e = locate(starts, end, true);
      const range = new Range();
      range.setStart(nodes[s], m.index - starts[s]);
      range.setEnd(nodes[e], end - starts[e]);
      out.push({ nodes: nodes.slice(s, e + 1), range, idx, root, painted: false });
    }
  }

  function addShadowRoot(sr) {
    if (shadowRoots.has(sr)) return;
    shadowRoots.add(sr);
    if (observer) observer.observe(sr, OBSERVE);
    if (matcher) applyStyle(sr);
  }

  // Joins neighbouring text (across inline tags) and matches words in it,
  // stepping into shadow roots where they sit in the page.
  function scanRoot(root, out) {
    if (!root || insideSkipped(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter);
    let nodes = [];
    let starts = [];
    let text = '';
    const flush = () => {
      if (nodes.length) matchRun(nodes, starts, text, out);
      nodes = [];
      starts = [];
      text = '';
    };
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType !== Node.TEXT_NODE) {
        flush();
        const sr = shadowOf(n);
        if (sr) {
          addShadowRoot(sr);
          scanRoot(sr, out);
        }
        continue;
      }
      starts.push(text.length);
      nodes.push(n);
      text += n.nodeValue;
    }
    flush();
  }

  function applyStyle(root) {
    let el = styles.get(root);
    if (!el) {
      el = document.createElement('style');
      ownStyles.add(el);
      styles.set(root, el);
    }
    if (!el.isConnected) {
      const parent = root === document ? (document.head || document.documentElement) : root;
      parent.appendChild(el);
    }
    if (el.textContent !== cssText) el.textContent = cssText;
  }

  function updateStyles() {
    if (!matcher) {
      for (const root of [document, ...shadowRoots]) styles.get(root)?.remove();
      return;
    }
    // Colors only come from the panel's color picker, but never put anything else into CSS.
    const rules = settings.words.map((w, i) =>
      `::highlight(${PREFIX}${i}) { background-color: ${COLOR.test(w.color) ? w.color : '#ffe066'}; color: #111; }`);
    rules.push(`::highlight(${CURRENT}) { background-color: #f97316; color: #fff; text-decoration: underline 2px #9a3412; }`);
    cssText = rules.join('\n');
    applyStyle(document);
    for (const sr of shadowRoots) applyStyle(sr);
  }

  function clearHighlights() {
    for (const name of [...CSS.highlights.keys()]) {
      if (name.startsWith(PREFIX)) CSS.highlights.delete(name);
    }
    highlights.clear();
  }

  function setCurrentHighlight() {
    CSS.highlights.delete(CURRENT);
    if (!current) return;
    const h = new Highlight(current.range);
    h.priority = 1;
    CSS.highlights.set(CURRENT, h);
  }

  function highlightFor(idx) {
    let h = highlights.get(idx);
    if (!h) {
      h = new Highlight();
      highlights.set(idx, h);
      CSS.highlights.set(PREFIX + idx, h);
    }
    return h;
  }

  function isShown(el) {
    if (!el || !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    // Text directly inside a closed <details> is hidden even though <details> itself is visible.
    const closed = el.closest('details:not([open])');
    return !closed || !!el.closest('summary');
  }

  // Works out which matches are on screen and paints exactly those.
  // Counts and prev/next only use visible matches (not collapsed menus, hidden tabs, ...).
  function refreshVisibility() {
    if (!visibilityDirty) return;
    visibilityDirty = false;
    visible = new Map();
    hiddenCounts = {};
    for (const [idx, list] of byIdx) {
      const shown = [];
      let hidden = 0;
      for (const e of list) {
        const el = elementFor(e.nodes[0]);
        let v = el ? shownCache.get(el) : false;
        if (v === undefined) {
          v = isShown(el);
          shownCache.set(el, v);
        }
        if (v) shown.push(e);
        else hidden++;
        if (v !== e.painted) {
          if (v) highlightFor(idx).add(e.range);
          else highlights.get(idx)?.delete(e.range);
          e.painted = v;
        }
      }
      visible.set(idx, shown);
      if (hidden) hiddenCounts[idx] = hidden;
    }
    if (current && !(visible.get(current.idx) || []).includes(current)) {
      current = null;
      setCurrentHighlight();
    }
  }

  function regroup() {
    byIdx = new Map();
    for (const e of entries) {
      if (!byIdx.has(e.idx)) byIdx.set(e.idx, []);
      byIdx.get(e.idx).push(e);
    }
    visibilityDirty = true;
    refreshVisibility();
    notifyPanel();
  }

  // Merge new matches into entries in document order.
  function mergeAdded(kept, added) {
    if (!added.length) return kept;
    added.sort(compareEntries);
    if (added.length <= 64) {
      for (const e of added) {
        let lo = 0;
        let hi = kept.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (compareEntries(kept[mid], e) < 0) lo = mid + 1;
          else hi = mid;
        }
        kept.splice(lo, 0, e);
      }
      return kept;
    }
    // Many new matches (a feed loading a page of results): one linear merge.
    const out = [];
    let i = 0;
    let j = 0;
    while (i < kept.length && j < added.length) {
      out.push(compareEntries(kept[i], added[j]) <= 0 ? kept[i++] : added[j++]);
    }
    while (i < kept.length) out.push(kept[i++]);
    while (j < added.length) out.push(added[j++]);
    return out;
  }

  // Drop shadow roots whose host left the page, so long-running pages that keep
  // creating and removing components (infinite feeds) don't pile up memory.
  // A host that comes back is scanned again when it is re-inserted.
  function forgetDetachedShadows() {
    for (const sr of shadowRoots) {
      if (!sr.host.isConnected) shadowRoots.delete(sr);
    }
  }

  // Custom elements often attach their shadow root after they are inserted,
  // which no observer reports; look for new ones a little later.
  function sweepShadows() {
    sweepTimer = null;
    lastSweep = Date.now();
    if (!matcher || !document.body) return;
    forgetDetachedShadows();
    const found = [];
    const visit = root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (SKIP_TAGS.has(tag(el))) continue;
        const sr = shadowOf(el);
        if (!sr) continue;
        if (!shadowRoots.has(sr) && !insideSkipped(el)) found.push(sr);
        else visit(sr);
      }
    };
    visit(document.body);
    if (!found.length) return;
    const added = [];
    for (const sr of found) {
      addShadowRoot(sr);
      scanRoot(sr, added);
    }
    entries = mergeAdded(entries.slice(), added);
    regroup();
  }

  // Sweeps walk the whole page, so at most one every 3 seconds.
  function scheduleSweep(ms) {
    if (sweepTimer) return;
    sweepTimer = setTimeout(sweepShadows, Math.max(ms, lastSweep + 3000 - Date.now()));
  }

  function fullScan() {
    for (const e of entries) e.painted = false;
    entries = [];
    current = null;
    frameCurrent = null;
    shownCache = new WeakMap();
    dirty.clear();
    needsPrune = false;
    matcher = buildMatcher();
    updateStyles();
    clearHighlights();
    if (matcher && document.body) scanRoot(document.body, entries);
    setCurrentHighlight();
    regroup();
    if (matcher) {
      scheduleSweep(1500);
      setTimeout(() => scheduleSweep(0), 4000);
    }
  }

  // A match whose text was removed or edited collapses or loses its nodes.
  function isValid(e) {
    const last = e.nodes[e.nodes.length - 1];
    return !e.range.collapsed && e.range.startContainer === e.nodes[0] &&
      e.range.endContainer === last && e.nodes.every(n => n.isConnected);
  }

  function flushPending() {
    pendingTimer = null;
    const blocks = [...dirty].filter(b => b && b.isConnected && !insideSkipped(b));
    dirty.clear();
    const prune = needsPrune;
    needsPrune = false;
    if (!matcher) return;

    // Changes were only in skipped areas (inputs, scripts): nothing to rescan.
    if (!blocks.length && !prune) {
      notifyPanel();
      return;
    }
    if (prune) forgetDetachedShadows();

    // Only the changed parts are touched, so updates stay fast on very long pages.
    // Nested dirty blocks collapse into their outermost one.
    const all = new Set(blocks);
    const roots = blocks.filter(b => !underAny(b instanceof ShadowRoot ? b.host : b.parentNode, all));
    const rootSet = new Set(roots);
    const kept = [];
    for (const e of entries) {
      if (isValid(e) && !(roots.length && underAny(e.nodes[0], rootSet))) kept.push(e);
      else {
        if (e.painted) highlights.get(e.idx)?.delete(e.range);
        e.painted = false;
        if (e === current) current = null;
      }
    }
    const added = [];
    for (const r of roots) scanRoot(r, added);
    entries = mergeAdded(kept, added);
    setCurrentHighlight();
    regroup();
    // New custom elements may attach a shadow root shortly.
    if (roots.some(r => r.nodeType === Node.ELEMENT_NODE && tag(r).includes('-'))) scheduleSweep(800);
  }

  function schedule() {
    if (!pendingTimer) pendingTimer = setTimeout(flushPending, 300);
  }

  // Class/style changes, new stylesheets and window resizes can show or hide matches.
  // Animated pages change these constantly, so recheck at most once a second.
  let visibilityTimer = null;
  function scheduleVisibilityCheck() {
    if (visibilityTimer || !matcher) return;
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null;
      if (!matcher) return;
      shownCache = new WeakMap();
      visibilityDirty = true;
      refreshVisibility();
      notifyPanel();
    }, 1000);
  }

  // Text, or an inline element: something a word can run through.
  const isFlowing = n => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(tag(n)));
  const hasText = n => n && (n.nodeType === Node.TEXT_NODE ? !!n.nodeValue.trim() : n.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(tag(n)));

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(mutations => {
      if (!matcher) return;
      for (const mu of mutations) {
        if (ownStyles.has(mu.target)) continue;
        if (mu.type === 'attributes') {
          scheduleVisibilityCheck();
          continue;
        }
        if (mu.type === 'characterData') {
          dirty.add(blockOf(mu.target));
          continue;
        }
        // Inline changes, and block changes between pieces of text (a <br> splitting
        // "apple pie", a removed <div> joining two halves), can change the words around
        // them: rescan the surrounding block. A block element added between other blocks
        // can't affect its neighbours, so only that element is scanned.
        const touchesText = hasText(mu.previousSibling) || hasText(mu.nextSibling);
        let rescanParent = touchesText && (mu.addedNodes.length || mu.removedNodes.length);
        for (const n of mu.addedNodes) {
          if (ownStyles.has(n)) continue;
          if (tag(n) === 'style' || tag(n) === 'link') scheduleVisibilityCheck();
          if (isFlowing(n)) rescanParent = true;
          else if (n.nodeType === Node.ELEMENT_NODE) dirty.add(n);
        }
        for (const n of mu.removedNodes) {
          if (ownStyles.has(n)) continue;
          needsPrune = true;
          if (isFlowing(n)) rescanParent = true;
        }
        if (rescanParent) dirty.add(blockOf(mu.target));
      }
      if (dirty.size || needsPrune) schedule();
    });
    // The whole document, so sites that swap in a new <body> keep working.
    observer.observe(document.documentElement, OBSERVE);
    for (const sr of shadowRoots) observer.observe(sr, OBSERVE);
  }

  // ----- extension lifetime -----

  // After the extension is reloaded or updated, this copy of the script is cut off:
  // its messages throw "Extension context invalidated" and it gets no more settings.
  // Remove what it drew and stop, instead of leaving stale highlights and errors behind.
  let dead = false;
  const alive = () => {
    try { return !!chrome.runtime.id; } catch { return false; }
  };

  function shutdown() {
    if (dead) return;
    dead = true;
    matcher = null;
    if (observer) observer.disconnect();
    clearTimeout(pendingTimer);
    clearTimeout(sweepTimer);
    clearTimeout(visibilityTimer);
    clearInterval(aliveTimer);
    clearHighlights();
    CSS.highlights.delete(CURRENT);
    for (const root of [document, ...shadowRoots]) styles.get(root)?.remove();
  }

  function send(msg) {
    if (!alive()) return shutdown();
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {
      shutdown();
    }
  }

  const aliveTimer = setInterval(() => { if (!alive()) shutdown(); }, 2000);

  // The panel is watching this tab: send updates for a while. Returns true if it just started.
  function markWatched() {
    const started = !watched();
    watchedUntil = Date.now() + WATCH_MS;
    return started;
  }

  // ----- frames -----

  function toFrame(frameId, payload) {
    send({ type: 'mwh-to-frame', frameId, payload });
  }

  function allFrameElements() {
    const list = [...document.querySelectorAll('iframe, frame')];
    for (const sr of shadowRoots) list.push(...sr.querySelectorAll('iframe, frame'));
    return list;
  }

  function greetFrame(el) {
    let token = tokenOf.get(el);
    if (!token) {
      token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      tokenOf.set(el, token);
    }
    try { el.contentWindow && el.contentWindow.postMessage({ __mwh: 'hello', token }, '*'); } catch {}
  }

  function greetFrames() {
    for (const el of allFrameElements()) greetFrame(el);
  }

  // Frames whose iframe left the page are forgotten here, with their counts.
  function frameElements() {
    const map = new Map();
    for (const [id, el] of frameEls) {
      if (el.isConnected) map.set(id, el);
      else {
        frameEls.delete(id);
        frames.delete(id);
        if (frameCurrent && frameCurrent.id === id) frameCurrent = null;
      }
    }
    return map;
  }

  // Nested frames have no element here; they are trusted and placed after the page.
  function frameShown(el) {
    if (!el) return true;
    if (!isShown(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height >= MIN_FRAME_AREA;
  }

  // Every visible match of word `index`, page and frames together, in page order.
  // Returns null when no frame has any, so the common case stays cheap.
  function sequence(index, map) {
    refreshVisibility();
    const top = visible.get(index) || [];
    const parts = [];
    for (const [id, f] of frames) {
      const n = f.counts[index] || 0;
      const el = map.get(id);
      if (n && frameShown(el)) parts.push({ id, el, n });
    }
    if (!parts.length) return null;
    // Frames inside shadow roots are ordered within their component, like text there.
    parts.sort((a, b) => {
      if (!a.el || !b.el) return a.el ? -1 : b.el ? 1 : 0;
      return precedes(a.el, b.el) ? -1 : 1;
    });
    const seq = [];
    let ti = 0;
    for (const f of parts) {
      while (ti < top.length && (!f.el || precedes(top[ti].nodes[0], f.el))) {
        seq.push({ entry: top[ti++] });
      }
      for (let k = 0; k < f.n; k++) seq.push({ id: f.id, k });
    }
    while (ti < top.length) seq.push({ entry: top[ti++] });
    return seq;
  }

  function counts() {
    refreshVisibility();
    const result = {};
    for (const [idx, list] of visible) result[idx] = list.length;
    return result;
  }

  function currentInfo(map) {
    if (!current && !frameCurrent) return null;
    refreshVisibility();
    if (!current && !frameCurrent) return null;
    const idx = frameCurrent ? frameCurrent.idx : current.idx;
    const seq = frames.size ? sequence(idx, map || frameElements()) : null;
    if (!seq) {
      if (!current) return null;
      const list = visible.get(current.idx) || [];
      const pos = list.indexOf(current);
      return pos < 0 ? null : { index: current.idx, pos: pos + 1, total: list.length };
    }
    const pos = frameCurrent
      ? seq.findIndex(x => x.id === frameCurrent.id && x.k === frameCurrent.k)
      : seq.findIndex(x => x.entry === current);
    return pos < 0 ? null : { index: idx, pos: pos + 1, total: seq.length };
  }

  // Page counts plus every frame's; matches in hidden or tiny frames count as hidden.
  function info() {
    const c = counts();
    const h = { ...hiddenCounts };
    const map = frames.size ? frameElements() : null;
    for (const [id, f] of frames) {
      const shown = frameShown(map.get(id));
      for (const [i, n] of Object.entries(f.counts)) {
        if (shown) c[i] = (c[i] || 0) + n;
        else h[i] = (h[i] || 0) + n;
      }
      for (const [i, n] of Object.entries(f.hidden || {})) h[i] = (h[i] || 0) + n;
    }
    return { counts: c, hidden: h, host: location.hostname, current: currentInfo(map) };
  }

  // Updates go out only while a panel is watching, so idle tabs don't keep
  // waking the extension's background worker.
  let notifyTimer = null;
  let lastReport = '';
  function notifyPanel() {
    if (notifyTimer || !watched()) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (!IS_TOP) return reportToTop();
      const sig = JSON.stringify(info());
      if (sig === lastSignature) return;
      lastSignature = sig;
      send({ type: 'mwh-changed' });
    }, 200);
  }

  function reportToTop(force) {
    const report = { counts: counts(), hidden: hiddenCounts, token: parentToken };
    const sig = JSON.stringify(report);
    if (!force && sig === lastReport) return;
    lastReport = sig;
    send({ type: 'mwh-frame-report', ...report });
  }

  function onFrameReport(msg) {
    if (msg.token) {
      const el = allFrameElements().find(f => tokenOf.get(f) === msg.token);
      if (el) frameEls.set(msg.frameId, el);
    }
    const empty = !Object.keys(msg.counts).length && !Object.keys(msg.hidden || {}).length;
    if (empty) frames.delete(msg.frameId);
    else frames.set(msg.frameId, { counts: msg.counts, hidden: msg.hidden });
    if (empty && frameCurrent && frameCurrent.id === msg.frameId) frameCurrent = null;
    notifyPanel();
  }

  // Closest ancestor that scrolls vertically (apps like Gmail scroll an inner area, not the page).
  function scrollParent(el) {
    for (let n = el.parentElement || el.getRootNode().host; n && n !== document.body && n !== document.documentElement;
      n = n.parentElement || n.getRootNode().host) {
      const overflow = getComputedStyle(n).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }

  function scrollToRange(range) {
    const el = elementFor(range.startContainer);
    if (!el) return;
    // Bring every scroll container to the element, then center the word itself
    // in the area that actually scrolls.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = range.getBoundingClientRect();
    const box = scrollParent(el);
    if (box) {
      const b = box.getBoundingClientRect();
      box.scrollBy({ top: r.top - b.top - (box.clientHeight - r.height) / 2, behavior: 'smooth' });
    } else {
      window.scrollBy({ top: r.top + r.height / 2 - innerHeight / 2, behavior: 'smooth' });
    }
  }

  // In a frame: select the k-th visible match of a word (k < 0 clears the selection).
  function goToLocal(index, k) {
    refreshVisibility();
    current = k < 0 ? null : (visible.get(index) || [])[k] || null;
    setCurrentHighlight();
    if (current) scrollToRange(current.range);
  }

  function jump(index, dir) {
    refreshVisibility();
    const map = frames.size ? frameElements() : null;
    const seq = map ? sequence(index, map) : null;
    const prevFrame = frameCurrent;
    let result;

    if (!seq) {
      const list = visible.get(index) || [];
      if (!list.length) return { pos: 0, total: 0 };
      let pos = current && current.idx === index ? list.indexOf(current) : -1;
      pos = pos < 0 ? (dir < 0 ? list.length - 1 : 0) : (pos + dir + list.length) % list.length;
      current = list[pos];
      frameCurrent = null;
      setCurrentHighlight();
      scrollToRange(current.range);
      result = { pos: pos + 1, total: list.length };
    } else {
      let pos = -1;
      if (frameCurrent && frameCurrent.idx === index) pos = seq.findIndex(x => x.id === frameCurrent.id && x.k === frameCurrent.k);
      else if (current && current.idx === index) pos = seq.findIndex(x => x.entry === current);
      pos = pos < 0 ? (dir < 0 ? seq.length - 1 : 0) : (pos + dir + seq.length) % seq.length;
      const item = seq[pos];
      if (item.entry) {
        current = item.entry;
        frameCurrent = null;
        setCurrentHighlight();
        scrollToRange(current.range);
      } else {
        current = null;
        setCurrentHighlight();
        frameCurrent = { id: item.id, idx: index, k: item.k };
        const el = map.get(item.id);
        if (el) el.scrollIntoView({ block: 'center' });
        toFrame(item.id, { type: 'mwh-goto', index, k: item.k });
      }
      result = { pos: pos + 1, total: seq.length };
    }
    // Clear the orange mark in the frame we just left.
    if (prevFrame && (!frameCurrent || prevFrame.id !== frameCurrent.id)) {
      toFrame(prevFrame.id, { type: 'mwh-goto', index: -1, k: -1 });
    }
    lastSignature = JSON.stringify(info());
    return result;
  }

  // The panel is looking at this tab: keep the frames reporting too
  // (passed on right away when watching starts, then at most every 10 seconds).
  let lastWatchRelay = 0;
  function panelIsWatching() {
    const started = markWatched();
    if (!started && Date.now() - lastWatchRelay < 10000) return;
    lastWatchRelay = Date.now();
    send({ type: 'mwh-to-frames', payload: { type: 'mwh-watch' } });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (dead) return;
    if (IS_TOP) {
      // Only the top frame answers the panel, for the page and its frames together.
      if (msg.type === 'mwh-info') { panelIsWatching(); sendResponse(info()); }
      else if (msg.type === 'mwh-jump') { panelIsWatching(); sendResponse(jump(msg.index, msg.dir)); }
      else if (msg.type === 'mwh-watch') panelIsWatching();
      else if (msg.type === 'mwh-counts') sendResponse(counts());
      else if (msg.type === 'mwh-frame-report') onFrameReport(msg);
    } else if (msg.type === 'mwh-goto') {
      goToLocal(msg.index, msg.k);
    } else if (msg.type === 'mwh-watch') {
      if (markWatched()) reportToTop(true);
    } else if (msg.type === 'mwh-report-now') {
      reportToTop(true);
    }
  });

  if (IS_TOP) {
    // A child frame asks for its token (it may start after the iframe's load event).
    addEventListener('message', e => {
      if (!e.data || e.data.__mwh !== 'need-token' || !e.source) return;
      const el = allFrameElements().find(f => f.contentWindow === e.source);
      if (el) greetFrame(el);
    });
    // Element load events reach the document (not the window) in the capture phase.
    document.addEventListener('load', e => {
      const t = e.target;
      if (t && (tag(t) === 'iframe' || tag(t) === 'frame')) greetFrame(t);
    }, true);
    // Back/forward cache: frames emptied their counts on pagehide; ask again.
    addEventListener('pageshow', e => {
      if (!e.persisted) return;
      greetFrames();
      send({ type: 'mwh-to-frames', payload: { type: 'mwh-report-now' } });
    });
  } else {
    const askParent = () => {
      try { window.parent.postMessage({ __mwh: 'need-token' }, '*'); } catch {}
    };
    addEventListener('message', e => {
      if (e.source !== window.parent || !e.data || e.data.__mwh !== 'hello' || typeof e.data.token !== 'string') return;
      parentToken = e.data.token;
      reportToTop(true);
    });
    addEventListener('pagehide', () => {
      send({ type: 'mwh-frame-report', counts: {}, hidden: {}, token: parentToken });
    });
    addEventListener('pageshow', e => {
      if (!e.persisted) return;
      askParent();
      reportToTop(true);
    });
    askParent();
  }

  addEventListener('resize', scheduleVisibilityCheck);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || dead) return;
    const before = structureKey(settings);
    let changed = false;
    for (const key of Object.keys(settings)) {
      if (key in changes) { settings[key] = changes[key].newValue; changed = true; }
    }
    if (!changed) return;
    if (structureKey(settings) !== before) fullScan();
    else updateStyles();
  });

  chrome.storage.local.get(settings, stored => {
    settings = { ...settings, ...stored };
    fullScan();
    startObserver();
    // Frames that loaded before this page was ready report again.
    if (IS_TOP) {
      greetFrames();
      send({ type: 'mwh-to-frames', payload: { type: 'mwh-report-now' } });
    }
  });
})();
