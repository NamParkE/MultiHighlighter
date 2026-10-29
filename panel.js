const PALETTE = [
  '#ffe066', '#b2f2bb', '#a5d8ff', '#ffc9c9', '#e5dbff',
  '#ffd8a8', '#c3fae8', '#fcc2d7', '#d8f5a2', '#bac8ff'
];

const DEFAULTS = { words: [], enabled: true, caseSensitive: false, wholeWord: false };

const $ = id => document.getElementById(id);

// Same page serves the popup (panel.html?view=popup) and the side panel.
const isPopup = new URLSearchParams(location.search).get('view') === 'popup';
document.documentElement.classList.toggle('popup', isPopup);
let windowId = null;
const list = $('word-list');
let state = { ...DEFAULTS };
let counts = {};
let hidden = {};       // matches present on the page but not visible (collapsed, hidden)
let host = '';
let tabId = null;
let selected = null;     // text of the block clicked for navigation
let position = '';       // "3 / 12" after using prev/next on the selected word

function save(patch) {
  state = { ...state, ...patch };
  chrome.storage.local.set(patch);
  render();
  // Give the content script a moment to re-highlight before counting.
  setTimeout(loadCounts, 150);
}

function nextColor(words) {
  const used = new Set(words.map(w => w.color));
  return PALETTE.find(c => !used.has(c)) || PALETTE[words.length % PALETTE.length];
}

// Above this many matches a word is marked: it slows long pages and is rarely useful.
const MANY_MATCHES = 2000;
let hintTimer = null;

function showHint(text) {
  const el = $('hint');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Two entries are the same word if they differ only in spacing (and case, unless case matters).
function wordKey(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return state.caseSensitive ? t : t.toLowerCase();
}

function addWords(raw) {
  const existing = new Set(state.words.map(w => wordKey(w.text)));
  const words = [...state.words];
  const short = [];
  for (const part of raw.split(/[,\n]/)) {
    const text = part.trim().replace(/\s+/g, ' ');
    if (!text || existing.has(wordKey(text))) continue;
    existing.add(wordKey(text));
    words.push({ text, color: nextColor(words), on: true });
    if ([...text].length === 1) short.push(text);
  }
  if (short.length) {
    showHint(`한 글자 단어(${short.join(', ')})는 페이지 곳곳에 표시되어 긴 페이지가 느려질 수 있어요.`);
  }
  save({ words });
}

function updateWord(i, patch) {
  const words = state.words.map((w, j) => (j === i ? { ...w, ...patch } : w));
  save({ words });
}

function removeWord(i) {
  if (state.words[i].text === selected) selected = null;
  focusChip = document.activeElement && document.activeElement.classList.contains('chip') ? Math.max(0, i - 1) : -1;
  save({ words: state.words.filter((_, j) => j !== i) });
}

function selectedIndex() {
  return state.words.findIndex(w => w.text === selected);
}

function render() {
  $('enabled').checked = state.enabled;
  $('caseSensitive').checked = state.caseSensitive;
  $('wholeWord').checked = state.wholeWord;

  if (selectedIndex() < 0) selected = null;

  // Rebuild the blocks only when the words themselves change; count updates are
  // applied in place so a block isn't replaced under the pointer mid-click.
  const key = JSON.stringify([state.words, selected]);
  if (key !== builtKey) {
    builtKey = key;
    buildChips();
  }
  updateChips();

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('word-count').textContent = state.words.length;
  $('page-total').textContent = total;
  $('empty').hidden = state.words.length > 0;
  $('clear').hidden = state.words.length === 0;
  $('site').textContent = host;

  renderCard();
}

let builtKey = '';
let focusChip = -1;   // block to focus after a rebuild (keyboard use)

function toggleSelect(w, i) {
  selected = selected === w.text ? null : w.text;
  position = '';
  focusChip = document.activeElement && document.activeElement.classList.contains('chip') ? i : -1;
  render();
}

function buildChips() {
  list.textContent = '';
  state.words.forEach((w, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-pressed', String(w.text === selected));
    chip.style.background = w.color;
    if (w.on === false) chip.classList.add('off');
    if (w.text === selected) chip.classList.add('sel');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = w.text;

    const n = document.createElement('span');
    n.className = 'n';

    // Shown while hovering or focusing the block (see panel.css); Delete key works too.
    const x = document.createElement('span');
    x.className = 'x';
    x.title = '삭제';
    x.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    x.addEventListener('click', e => {
      e.stopPropagation();
      removeWord(i);
    });

    chip.append(label, n, x);
    chip.addEventListener('click', () => toggleSelect(w, i));
    chip.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSelect(w, i);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeWord(i);
      }
    });
    list.appendChild(chip);
  });
  if (focusChip >= 0 && list.children.length) list.children[Math.min(focusChip, list.children.length - 1)].focus();
  focusChip = -1;
}

function updateChips() {
  [...list.children].forEach((chip, i) => {
    const w = state.words[i];
    const n = counts[i] || 0;
    chip.querySelector('.n').textContent = n;
    const many = n > MANY_MATCHES;
    chip.classList.toggle('many', many);
    const notes = [w.text];
    if (hidden[i]) notes.push(`숨겨진 위치 ${hidden[i]}개는 개수에서 제외`);
    if (many) notes.push('일치가 너무 많아 페이지가 느려질 수 있어요');
    chip.title = notes.join(' · ');
    chip.setAttribute('aria-label', `${w.text}, ${n}개${w.on === false ? ', 꺼짐' : ''}`);
  });
}

// Card under the blocks for the clicked word: prev/next, on/off, color.
function renderCard() {
  const i = selectedIndex();
  $('card').hidden = i < 0;
  if (i < 0) return;
  const w = state.words[i];
  const n = counts[i] || 0;
  const off = w.on === false;

  $('card-dot').style.background = w.color;
  $('card-name').textContent = w.text;
  const hiddenNote = hidden[i] ? ` · 숨김 ${hidden[i]}` : '';
  $('card-pos').textContent = off ? '꺼짐' : (position || `${n}개`) + hiddenNote;
  $('prev').disabled = $('next').disabled = off || n === 0;

  const toggle = $('toggle-word');
  toggle.classList.toggle('is-off', off);
  toggle.title = off ? '다시 켜기' : '이 단어 끄기';

  $('card-swatch').style.background = w.color;
  $('card-color').value = w.color;
}

function jump(dir) {
  const index = selectedIndex();
  if (index < 0 || tabId === null) return;
  chrome.tabs.sendMessage(tabId, { type: 'mwh-jump', index, dir }, { frameId: 0 }, res => {
    if (chrome.runtime.lastError || !res || !res.total) return;
    position = `${res.pos} / ${res.total}`;
    renderCard();
  });
}

let lastInfo = '';

function loadCounts() {
  if (tabId === null) return;
  chrome.tabs.sendMessage(tabId, { type: 'mwh-info' }, { frameId: 0 }, res => {
    const failed = Boolean(chrome.runtime.lastError) || !res;
    // Busy pages report often; only redraw when something visible changed.
    const info = JSON.stringify(failed ? null : res);
    if (info === lastInfo) return;
    lastInfo = info;

    $('notice').hidden = !failed;
    counts = failed ? {} : res.counts;
    hidden = failed ? {} : res.hidden || {};
    host = failed ? '' : res.host;
    // The page keeps the prev/next position, so it survives page updates.
    const cur = failed ? null : res.current;
    position = cur && cur.index === selectedIndex() && cur.pos > 0 ? `${cur.pos} / ${cur.total}` : '';
    render();
  });
}

// The panel stays open across tabs, so follow whichever tab is active in this window.
function followActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    tabId = tabs[0] ? tabs[0].id : null;
    loadCounts();
  });
}

chrome.windows.getCurrent(win => {
  windowId = win.id;
  chrome.tabs.onActivated.addListener(info => {
    if (info.windowId === win.id) followActiveTab();
  });
});

chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === tabId && change.status === 'complete') setTimeout(loadCounts, 300);
});

// Pages only send updates while a panel says it is watching (see content.js).
setInterval(() => {
  if (tabId !== null) chrome.tabs.sendMessage(tabId, { type: 'mwh-watch' }, { frameId: 0 }, () => void chrome.runtime.lastError);
}, 15000);

// Content script reports when highlights change (e.g. new content loaded).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'mwh-changed' && sender.tab && sender.tab.id === tabId) loadCounts();
});

$('add-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('word-input');
  if (input.value.trim()) addWords(input.value);
  input.value = '';
  input.focus();
});

for (const key of ['enabled', 'caseSensitive', 'wholeWord']) {
  $(key).addEventListener('change', e => save({ [key]: e.target.checked }));
}

$('prev').addEventListener('click', () => jump(-1));
$('next').addEventListener('click', () => jump(1));
$('toggle-word').addEventListener('click', () => {
  const i = selectedIndex();
  if (i >= 0) updateWord(i, { on: state.words[i].on === false });
});
$('card-color').addEventListener('change', e => {
  const i = selectedIndex();
  if (i >= 0) updateWord(i, { color: e.target.value });
});

// In-panel replacement for confirm(), styled like the rest of the panel.
function askConfirm({ title, body, ok }) {
  const box = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = ok;
  box.hidden = false;
  $('confirm-cancel').focus();

  return new Promise(resolve => {
    const done = result => {
      box.hidden = true;
      box.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onClick = e => {
      if (e.target === $('confirm-ok')) done(true);
      else if (e.target === $('confirm-cancel') || e.target === box) done(false);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
    box.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
  });
}

$('clear').addEventListener('click', async () => {
  const ok = await askConfirm({
    title: '모든 단어를 삭제할까요?',
    body: `등록한 단어 ${state.words.length}개가 모두 삭제되고, 페이지 표시도 사라집니다.`,
    ok: '모두 삭제'
  });
  if (ok) save({ words: [] });
});

$('close').addEventListener('click', () => window.close());

// Switch how the toolbar icon opens this page, and hand over to the other view right away.
$('mode').title = isPopup ? '사이드 패널로 고정' : '팝업으로 전환';
$('mode').classList.add(isPopup ? 'is-popup' : 'is-side');
$('mode').addEventListener('click', () => {
  if (!isPopup) {
    // The background opens the popup the moment this panel's port disconnects (it closes).
    // Connect only now: a port opened earlier dies when Chrome stops the idle worker.
    const port = chrome.runtime.connect({ name: `popup-on-close:${windowId}` });
    const ready = new Promise(resolve => {
      port.onMessage.addListener(m => { if (m === 'ready') resolve(); });
      setTimeout(resolve, 500);
    });
    // Save popup mode here too, so the next icon click opens the popup even if auto-open fails.
    Promise.all([
      chrome.action.setPopup({ popup: 'panel.html?view=popup' }),
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
      chrome.storage.local.set({ viewMode: 'popup' }),
      ready
    ]).catch(() => {}).finally(() => window.close());
    return;
  }
  chrome.action.setPopup({ popup: '' });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.storage.local.set({ viewMode: 'side' });
  // Opening must happen inside the click, so don't wait on the settings first.
  chrome.sidePanel.open({ windowId }).catch(() => {}).finally(() => window.close());
});

// Keep in sync with changes made elsewhere (the other view, another window).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let changed = false;
  for (const key of Object.keys(DEFAULTS)) {
    if (key in changes && JSON.stringify(changes[key].newValue) !== JSON.stringify(state[key])) {
      state[key] = changes[key].newValue;
      changed = true;
    }
  }
  if (changed) render();
});

chrome.storage.local.get(DEFAULTS, stored => {
  state = { ...DEFAULTS, ...stored };
  render();
  followActiveTab();
  $('word-input').focus();
});
