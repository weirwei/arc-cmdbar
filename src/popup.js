import { rankItems, displayUrl } from './rank.js';
import { actionItems, findAction } from './actions.js';
import { tabItem, bookmarkItems, historyItem, closedItems, openDisposition } from './sources.js';

const t0 = performance.now();
const params = new URLSearchParams(location.search);
// e2e only: when this page is opened in a normal tab, `?target=<tabId>` names the tab that commands act on,
// and the page stays open after a command instead of closing like the real popup.
const TEST_TARGET = params.has('target') ? Number(params.get('target')) : null;
const SELF = chrome.runtime.getURL('src/popup.html');
const FAVICON = chrome.runtime.getURL('/_favicon/');
const isMac = /Mac/i.test(navigator.platform);

const $q = document.getElementById('q');
const $list = document.getElementById('list');
const $status = document.getElementById('status');
document.getElementById('mod').textContent = isMac ? '⌘' : 'Ctrl';

const state = {
  target: null, home: undefined,
  tabs: [], bookmarks: [], history: new Map(), closed: [],
  results: [], sel: 0, moved: false, selectedId: null,
  firstRenderMs: null, done: null, errors: [],
};
window.__cmdbar = state;

const BADGE = { tab: '标签页', bookmark: '书签', history: '历史', closed: '最近关闭', action: '命令' };

const ctx = () => ({
  tab: state.target, home: state.home, hasClosed: state.closed.length > 0,
  clipboard: (text) => navigator.clipboard.writeText(text),
});

function pool() {
  return [...actionItems(ctx()), ...state.tabs, ...state.closed, ...state.bookmarks, ...state.history.values()];
}

// ---------- rendering ----------

function highlight(text, positions) {
  const frag = document.createDocumentFragment();
  if (!positions?.length) { frag.append(text); return frag; }
  const set = new Set(positions);
  let buf = '';
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) { const m = document.createElement('mark'); m.textContent = buf; frag.append(m); } else frag.append(buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) { flush(); inMark = m; }
    buf += text[i];
  }
  flush();
  return frag;
}

function rowFor(r, i) {
  const { item } = r;
  const li = document.createElement('li');
  li.className = 'row';
  li.id = `opt-${i}`;
  li.setAttribute('role', 'option');
  li.dataset.kind = item.kind;
  li.dataset.id = item.id;

  const icon = document.createElement('span');
  icon.className = 'icon';
  if (item.url && item.kind !== 'fallback') {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `${FAVICON}?pageUrl=${encodeURIComponent(item.url)}&size=32`;
    icon.append(img);
  } else {
    icon.textContent = item.kind === 'action' ? '›' : item.mode === 'url' ? '↗' : '⌕';
  }

  const text = document.createElement('span');
  text.className = 'text';
  const title = document.createElement('span');
  title.className = 'title';
  let badgeText = BADGE[item.kind];
  let urlText = '';
  if (item.kind === 'fallback') {
    title.textContent = item.mode === 'url' ? `打开 ${displayUrl(item.url)}` : `搜索“${item.title}”`;
    badgeText = item.mode === 'url' ? '网址' : '搜索';
  } else {
    title.append(highlight(item.title || '', r.titlePositions));
    if (item.kind === 'tab' && item.pinned) badgeText = '固定标签页';
    if (item.url) urlText = displayUrl(item.url);
  }
  text.append(title);
  if (urlText) {
    const url = document.createElement('span');
    url.className = 'url';
    // URL positions refer to displayUrl(item.url), which is what we show.
    url.append(highlight(urlText, r.urlPositions));
    text.append(url);
  }

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = badgeText;
  badge.setAttribute('aria-hidden', 'true');

  li.setAttribute('aria-label', `${badgeText}：${title.textContent}${urlText ? `，${urlText}` : ''}`);
  li.append(icon, text, badge);
  return li;
}

function render() {
  state.results = rankItems(pool(), $q.value);
  if (state.moved && state.selectedId) {
    const i = state.results.findIndex((r) => r.item.id === state.selectedId);
    state.sel = i === -1 ? 0 : i;
  } else state.sel = 0;
  const frag = document.createDocumentFragment();
  state.results.forEach((r, i) => frag.append(rowFor(r, i)));
  $list.replaceChildren(frag);
  select(state.sel, false);
  $status.textContent = `${state.results.length} 个结果`;
  if (state.firstRenderMs == null) state.firstRenderMs = Math.round(performance.now() - t0);
}

function select(i, scroll = true) {
  const n = state.results.length;
  if (!n) { $q.removeAttribute('aria-activedescendant'); return; }
  state.sel = ((i % n) + n) % n;
  state.selectedId = state.results[state.sel].item.id;
  for (const li of $list.children) li.setAttribute('aria-selected', 'false');
  const li = $list.children[state.sel];
  li.setAttribute('aria-selected', 'true');
  $q.setAttribute('aria-activedescendant', li.id);
  if (scroll) li.scrollIntoView({ block: 'nearest' });
}

// ---------- commands ----------

async function openUrl(url, forceCurrent) {
  const t = state.target;
  if (openDisposition(t, forceCurrent) === 'current') await chrome.tabs.update(t.id, { url, active: true });
  else await chrome.tabs.create({ url, windowId: t?.windowId, index: t ? t.index + 1 : undefined });
}

async function activate(i, { current = false } = {}) {
  const r = state.results[i];
  if (!r) return;
  const { item } = r;
  try {
    switch (item.kind) {
      case 'tab':
        await chrome.tabs.update(item.tabId, { active: true });
        await chrome.windows.update(item.windowId, { focused: true });
        break;
      case 'closed':
        await chrome.sessions.restore(item.sessionId);
        break;
      case 'bookmark':
      case 'history':
        await openUrl(item.url, current);
        break;
      case 'fallback':
        if (item.mode === 'url') await openUrl(item.url, current);
        else {
          const here = openDisposition(state.target, current) === 'current';
          await chrome.search.query(here ? { text: item.title, tabId: state.target.id } : { text: item.title, disposition: 'NEW_TAB' });
        }
        break;
      case 'action':
        await findAction(item.actionId).run(ctx(), chrome);
        break;
    }
    finish(item);
  } catch (e) {
    state.errors.push(String(e?.message || e));
    $status.textContent = `操作失败：${e?.message || e}`;
    console.error('arc-cmdbar', e);
  }
}

function finish(item) {
  state.done = { kind: item.kind, id: item.id };
  if (TEST_TARGET == null) window.close();
}

async function closeSelectedTab() {
  const r = state.results[state.sel];
  if (r?.item.kind !== 'tab') return;
  await chrome.tabs.remove(r.item.tabId);
  state.tabs = state.tabs.filter((t) => t.tabId !== r.item.tabId);
  const keep = state.sel;
  state.moved = false;
  render();
  select(Math.min(keep, state.results.length - 1));
  $status.textContent = `已关闭“${r.item.title}”`;
}

// ---------- input ----------

$q.addEventListener('keydown', (e) => {
  const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === 'ArrowDown' || (ctrlOnly && e.key === 'n')) { e.preventDefault(); state.moved = true; select(state.sel + 1); }
  else if (e.key === 'ArrowUp' || (ctrlOnly && e.key === 'p')) { e.preventDefault(); state.moved = true; select(state.sel - 1); }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); activate(state.sel, { current: e.shiftKey }); }
  else if (e.key === 'Backspace' && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey)) { e.preventDefault(); closeSelectedTab(); }
});

let historyTimer;
$q.addEventListener('input', () => {
  state.moved = false;
  render();
  clearTimeout(historyTimer);
  const q = $q.value.trim();
  if (q.length >= 2) historyTimer = setTimeout(() => searchHistory(q), 80);
});

$list.addEventListener('mousemove', (e) => {
  const li = e.target.closest('.row');
  if (!li) return;
  const i = [...$list.children].indexOf(li);
  if (i !== state.sel) { state.moved = true; select(i, false); }
});
$list.addEventListener('click', (e) => {
  const li = e.target.closest('.row');
  if (li) activate([...$list.children].indexOf(li), { current: e.shiftKey });
});

// ---------- data ----------

function addHistory(items) {
  let added = 0;
  for (const h of items) {
    const it = historyItem(h);
    if (it && !state.history.has(it.id)) { state.history.set(it.id, it); added++; }
  }
  return added;
}

async function searchHistory(q) {
  const items = await chrome.history.search({ text: q, startTime: 0, maxResults: 100 });
  if (addHistory(items) && $q.value.trim() === q) render();
}

async function getTarget() {
  if (TEST_TARGET != null) return chrome.tabs.get(TEST_TARGET).catch(() => null);
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t ?? null;
}

async function load() {
  $q.focus();
  // Phase 1 (fast): tabs + current tab, so the first frame has something useful.
  const [target, tabs, homes] = await Promise.all([
    getTarget(),
    chrome.tabs.query({}),
    chrome.storage.session.get('homes').then((r) => r.homes || {}).catch(() => ({})),
  ]);
  state.target = target;
  state.home = target ? homes[target.id] : undefined;
  state.tabs = tabs.map((t) => tabItem(t, target?.id, SELF)).filter(Boolean);
  render();
  // Phase 2: bookmarks, recently closed, recent history.
  const [tree, sessions, history] = await Promise.all([
    chrome.bookmarks.getTree(),
    chrome.sessions.getRecentlyClosed({ maxResults: 25 }),
    chrome.history.search({ text: '', startTime: 0, maxResults: 1500 }),
  ]);
  state.bookmarks = bookmarkItems(tree);
  state.closed = closedItems(sessions);
  addHistory(history);
  render();
  state.loadedMs = Math.round(performance.now() - t0);
}

state.ready = load().catch((e) => { state.errors.push(String(e?.message || e)); console.error('arc-cmdbar', e); });
